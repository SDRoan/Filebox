import React, { useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import BoardCanvas, { CanvasEntry, CanvasLayout, ItemAction } from './BoardCanvas';
import FileItem from './FileItem';
import FolderItem from './FolderItem';
import { StickyNoteBlock, RichTextBlock } from './BoardNoteBlocks';
import { DeadlineBlock, LabelBlock } from './BoardPlanningBlocks';
import { LinkBlock } from './BoardLinkBlock';
import { FileListBlock } from './BoardFileListBlock';
import { SavedSearchBlock } from './BoardSavedSearchBlock';
import { SavedSearchRuns } from '../hooks/useSavedSearchRuns';
import { titleOf } from '../utils/savedSearch';
import { domainOf } from '../utils/boardLinks';
import { DocumentIcon, FolderIcon } from './Icons';
import { useAuth } from '../context/AuthContext';
import { filesAPI, BoardBlock, BoardContent, BoardZone } from '../services/api';
import { FileItem as FileItemType, Folder } from '../types';
import { pagePath } from '../config/workspaceNavigation';
import { BLOCK_SIZES, CONTENT_TYPES, LABEL_HEIGHT, Spot } from '../utils/boardLayout';

/**
 * One personal Boards tab on the free canvas shared with My Files > Board: the person's chosen files and
 * folders (the same cards as in My Files, with all their usual actions), sticky notes and text areas.
 * Files and folders are references: removing a card only takes it off this board.
 */

type RefBlock = Extract<BoardBlock, { type: 'file' | 'folder' }>;
type Available = Extract<RefBlock['ref'], { available: true }>;

export interface BoardActions {
  onArrange: (items: Record<string, Spot | null>, zones?: BoardZone[], options?: { debounce?: boolean }) => void;
  onEdit: (id: string, content: BoardContent, options?: { now?: boolean }) => void;
  onFlush: () => void;
  onRemove: (block: BoardBlock) => void;
  onReload: () => void;
  onEditingChange: (id: string) => void;
  onRemoveRow: (blockId: string, rowId: string) => void;
  // How many more file references this tab can hold (file cards and file-list rows).
  refRoom: number;
  // What the tab's saved searches found (page memory only), and how to run them.
  searchRuns: SavedSearchRuns;
}

/** The card a file shows in My Files, built from what the board knows about it (nothing is read from the file). */
export const fileCard = (ref: Available, userId?: string): FileItemType => ({
  _id: ref.fileId!, name: ref.name, originalName: ref.name, path: '', size: ref.size || 0, mimeType: ref.mimeType || '',
  owner: ref.source === 'owned' ? (userId || '') : 'shared', parentFolder: ref.parentFolder || null, isFolder: false,
  isStarred: Boolean(ref.isStarred), isTrashed: false, createdAt: ref.createdAt || ref.updatedAt || '', updatedAt: ref.updatedAt || '',
  ...(ref.dataClassification ? { dataClassification: ref.dataClassification } : {}),
  ...(ref.aiCaption ? { aiCaption: ref.aiCaption } : {}),
  access: ref.role || 'viewer',
} as FileItemType);

export const folderCard = (ref: Available, userId?: string): Folder => ({
  _id: ref.folderId!, name: ref.name, owner: ref.source === 'owned' ? (userId || '') : 'shared', parentFolder: null,
  createdAt: ref.createdAt || '', isStarred: Boolean(ref.isStarred),
  ...(ref.dataClassification ? { dataClassification: ref.dataClassification } : {}),
} as unknown as Folder);

export const blockName = (block: BoardBlock) => {
  if (block.type === 'note') return `Sticky note${block.note.title ? `: ${block.note.title}` : ''}`;
  if (block.type === 'text') return 'Text area';
  if (block.type === 'label') return `Label${block.label.text ? `: ${block.label.text}` : ''}`;
  if (block.type === 'deadline') return `Deadline${block.deadline.title ? `: ${block.deadline.title}` : ''}`;
  if (block.type === 'link') return `Link: ${block.link.title || domainOf(block.link.url)}`;
  if (block.type === 'filelist') return `File list${block.filelist.title ? `: ${block.filelist.title}` : ''}`;
  if (block.type === 'search') return `Saved search: ${titleOf(block.search)}`;
  return block.ref.available ? block.ref.name : block.type === 'file' ? 'Unavailable file' : 'Unavailable folder';
};

/** A file or folder this person can no longer open: nothing about it is shown, only a way to remove it. */
export const UnavailableCard: React.FC<{ type: 'file' | 'folder'; onRemove: () => void }> = ({ type, onRemove }) => (
  <div className="board-unavailable-card">
    <span className="board-unavailable-icon" aria-hidden="true">{type === 'folder' ? <FolderIcon size={28} /> : <DocumentIcon size={28} />}</span>
    <p className="board-unavailable-name">{type === 'file' ? 'File no longer available' : 'Folder no longer available'}</p>
    <p className="board-block-why">It may have been deleted, moved to Trash, or is no longer shared with you.</p>
    <button type="button" className="file-action-button" onClick={onRemove}>Remove from board</button>
  </div>
);

/** Around a text area: leaving it (focus moves outside it, not into one of its dialogs) stops editing it. */
export const TextFrame: React.FC<{ id: string; editingRef: React.MutableRefObject<string>; onEditingChange: (id: string) => void; children: React.ReactNode }> = ({ id, editingRef, onEditingChange, children }) => (
  <div className="board-text-frame" onBlur={(event) => {
    if (editingRef.current !== id) return;
    const nextFocus = event.relatedTarget as HTMLElement | null;
    if (nextFocus && (event.currentTarget.contains(nextFocus) || nextFocus.closest('.boards-dialog'))) return;
    const frame = event.currentTarget;
    setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if ((active && frame.contains(active)) || active?.closest('.boards-dialog')) return;
      if (editingRef.current === id) onEditingChange('');
    }, 0);
  }}>
    {children}
  </div>
);

const RemoveIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M8.5 12h7" /></svg>
);

/** Has its own size on the board (everything but file and folder cards). */
export const hasOwnSize = (b: BoardBlock) => (CONTENT_TYPES as readonly string[]).includes(b.type);
/** The size a block takes on the board (a label is as tall as its heading size). */
export const ownSize = (b: BoardBlock) => {
  if (b.type === 'label') return { w: b.w ?? BLOCK_SIZES.label.w, h: LABEL_HEIGHT[b.label.size] };
  const size = BLOCK_SIZES[b.type as keyof typeof BLOCK_SIZES];
  return { w: b.w ?? size.w, h: b.h ?? size.h };
};

/**
 * A label, deadline, link, file list or saved search (shared by the canvas and the phone list). Changing a label's size also
 * keeps its height on the board in step, in the same save.
 */
export type PlanningType = 'label' | 'deadline' | 'link' | 'filelist' | 'search';
export const isPlanning = (b: BoardBlock): b is Extract<BoardBlock, { type: PlanningType }> => ['label', 'deadline', 'link', 'filelist', 'search'].includes(b.type);
export const planningBlock = (block: Extract<BoardBlock, { type: PlanningType }>, actions: Pick<BoardActions, 'onEdit' | 'onFlush' | 'onRemove' | 'onArrange' | 'onRemoveRow' | 'refRoom' | 'searchRuns'>,
  common: { phone: boolean; first: boolean; last: boolean; onMove: (direction: -1 | 1) => void; onExit: () => void }) => {
  const shared = { ...common, onFlush: actions.onFlush, onRemove: () => actions.onRemove(block) };
  if (block.type === 'deadline') return <DeadlineBlock block={block} {...shared} onEdit={(deadline, now) => actions.onEdit(block.id, { deadline }, { now })} />;
  if (block.type === 'link') return <LinkBlock block={block} {...shared} onEdit={(link) => actions.onEdit(block.id, { link }, { now: true })} />;
  if (block.type === 'search') {
    return <SavedSearchBlock block={block} {...shared} run={actions.searchRuns.state(block.id)} observe={actions.searchRuns.observe}
      onRefresh={() => actions.searchRuns.refresh(block.id)} onEdit={(search) => actions.onEdit(block.id, { search }, { now: true })} />;
  }
  if (block.type === 'filelist') {
    return <FileListBlock block={block} {...shared} room={actions.refRoom} onRemoveRow={(rowId) => actions.onRemoveRow(block.id, rowId)}
      onEdit={(filelist, now) => actions.onEdit(block.id, { filelist }, { now })} />;
  }
  return (
    <LabelBlock block={block} {...shared} onEdit={(label, now) => {
      actions.onEdit(block.id, { label }, { now });
      if (label.size !== block.label.size && block.x !== null && block.y !== null) actions.onArrange({ [block.id]: { x: block.x, y: block.y, w: block.w ?? BLOCK_SIZES.label.w, h: LABEL_HEIGHT[label.size] } });
    }} />
  );
};

/** The card for a file or folder block (shared by the canvas and the phone list). */
export const useRefCard = ({ onRemove, onReload }: Pick<BoardActions, 'onRemove' | 'onReload'>) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  return (block: RefBlock, extra?: React.ReactNode) => {
    if (!block.ref.available) return <UnavailableCard type={block.type} onRemove={() => onRemove(block)} />;
    const ref = block.ref;
    const remove = (
      <>
        <button onClick={() => onRemove(block)} className="icon-button" title="Remove from board" aria-label={`Remove ${ref.name} from this board (it stays in File Box)`}>{RemoveIcon}</button>
        {extra}
      </>
    );
    // Real File Box actions, exactly as elsewhere; afterwards the board shows the item's latest state.
    const trash = async () => {
      try {
        if (block.type === 'file') await filesAPI.deleteFile(ref.fileId!);
        else await filesAPI.deleteFolder(ref.folderId!);
      } catch (error) {
        console.error('Error deleting:', error);
        alert('Failed to delete');
      }
      onReload();
    };
    if (block.type === 'folder') {
      return (
        <FolderItem folder={folderCard(ref, user?.id)} boardActions={remove} showTrash={false}
          onClick={() => (ref.source === 'team' ? navigate(pagePath('teams')) : navigate(pagePath('files'), { state: { openFolderId: ref.folderId } }))}
          onDelete={trash} onRestore={() => {}} onPermanentDelete={() => {}} onMove={onReload} />
      );
    }
    return (
      <FileItem file={fileCard(ref, user?.id)} boardActions={remove} showTrash={false}
        onDelete={trash} onRestore={() => {}} onPermanentDelete={() => {}} onMove={onReload} onRename={onReload} />
    );
  };
};

interface PersonalBoardProps extends BoardActions {
  tabId: string;
  blocks: BoardBlock[];
  zones: BoardZone[];
  saveState: string;
  editingId: string;
  toolbarStart: React.ReactNode;
  onReset: () => void;
  empty: React.ReactNode;
  // The canvas pattern (a class) and tools at the end of the toolbar (the Canvas look control).
  canvasClassName?: string;
  toolbarEnd?: React.ReactNode;
}

const ICON = {
  edit: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>,
  style: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-1-.8-1.4-.8-2.3 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="8" r="1" /></svg>,
  remove: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
};
const EDIT_NAMES: Record<string, string> = { note: 'Edit sticky note', text: 'Edit text', label: 'Edit label', deadline: 'Edit deadline', link: 'Edit link', filelist: 'Edit file list', search: 'Edit saved search' };

const sameSpot = (a: Spot | undefined, b: Spot) => Boolean(a) && a!.x === b.x && a!.y === b.y && a!.w === b.w && a!.h === b.h;

const PersonalBoard: React.FC<PersonalBoardProps> = ({ tabId, blocks, zones, saveState, editingId, toolbarStart, onReset, empty, canvasClassName, toolbarEnd, ...actions }) => {
  const { onArrange, onEdit, onFlush, onRemove, onEditingChange } = actions;
  const refCard = useRefCard(actions);
  const editingRef = useRef(editingId);
  editingRef.current = editingId;

  // The canvas layout from the saved blocks (a block without a place yet is left out: the canvas places it).
  const layout = useMemo<CanvasLayout>(() => ({
    items: Object.fromEntries(blocks.filter(b => b.x !== null && b.y !== null).map(b => [b.id, {
      x: b.x as number, y: b.y as number, ...(hasOwnSize(b) ? ownSize(b) : {}),
    }])),
    zones,
  }), [blocks, zones]);

  // Back to the block's grip when leaving it (Escape): it is where the person already is, so the board does not scroll.
  const focusHandle = (id: string) => setTimeout(() => document.querySelector<HTMLElement>(`[data-board-key="${id}"] .board-item-handle`)?.focus({ preventScroll: true }), 0);
  const stopEditing = (id: string) => {
    onFlush();
    if (editingRef.current === id) onEditingChange('');
    focusHandle(id);
  };

  const onCommit = (next: CanvasLayout) => {
    const items: Record<string, Spot | null> = {};
    blocks.forEach((b) => {
      const spot = next.items[b.id];
      if (!spot) { if (b.x !== null && !(b.id in next.items)) items[b.id] = null; return; }
      const own = hasOwnSize(b);
      const size = own ? ownSize(b) : null;
      const want: Spot = { x: Math.round(spot.x), y: Math.round(spot.y), ...(size ? { w: spot.w ?? size.w, h: b.type === 'label' ? size.h : spot.h ?? size.h } : {}) };
      if (!sameSpot(layout.items[b.id], want)) items[b.id] = want;
    });
    const zonesChanged = JSON.stringify(next.zones) !== JSON.stringify(zones);
    if (!Object.keys(items).length && !zonesChanged) return;
    // Saved after a short pause (as My Files > Board does), so a burst of arrow keys or typing is one save.
    onArrange(items, zonesChanged ? next.zones : undefined, { debounce: true });
  };

  // Quick actions of a selected block: they use the block's own controls (its first field, its menu).
  const inItem = <T extends HTMLElement = HTMLElement>(id: string, sel: string) => document.querySelector<T>(`[data-board-key="${id}"] ${sel}`);
  const openMenu = (id: string, sel: string) => {
    const menu = inItem<HTMLDetailsElement>(id, sel);
    if (!menu) return;
    menu.open = true;
    setTimeout(() => menu.querySelector<HTMLElement>('.item-actions-popover button')?.focus(), 0);
  };
  const menuItem = (id: string, label: string) => () => Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-board-key="${id}"] .item-actions-popover button`)).find(b => b.textContent === label)?.click();
  const focusIn = (id: string, sel: string) => () => inItem(id, sel)?.focus();
  const quick = (block: BoardBlock, edit: () => void, style?: () => void): ItemAction[] => [
    { id: 'edit', label: EDIT_NAMES[block.type], icon: ICON.edit, run: edit },
    ...(style ? [{ id: 'style', label: 'Style', icon: ICON.style, run: style }] : []),
    { id: 'remove', label: 'Remove from board', icon: ICON.remove, run: () => onRemove(block) },
  ];
  const quickFor = (block: BoardBlock): ItemAction[] | undefined => {
    if (block.type === 'note') return quick(block, focusIn(block.id, '.board-note-title'), () => openMenu(block.id, '.board-block-menu'));
    if (block.type === 'text') return quick(block, () => onEditingChange(block.id));
    if (block.type === 'label') return quick(block, focusIn(block.id, '.board-label-text'), () => openMenu(block.id, '.board-label-menu'));
    if (block.type === 'deadline') return quick(block, focusIn(block.id, '.board-deadline-title'));
    if (block.type === 'link') return quick(block, menuItem(block.id, 'Edit link…'));
    if (block.type === 'filelist') return quick(block, focusIn(block.id, '.board-filelist-title'));
    if (block.type === 'search') return quick(block, menuItem(block.id, 'Edit search…'));
    return undefined;
  };

  const entries: CanvasEntry[] = blocks.map((block) => {
    const name = blockName(block);
    if (block.type === 'note') {
      return {
        key: block.id, name, className: 'is-note', handleOnly: true, actions: quickFor(block),
        size: { w: block.w ?? BLOCK_SIZES.note.w, h: block.h ?? BLOCK_SIZES.note.h }, resize: BLOCK_SIZES.note,
        onHandleKey: (event) => {
          if (event.key !== 'Enter') return false;
          event.preventDefault();
          document.querySelector<HTMLElement>(`[data-board-key="${block.id}"] .board-note-body`)?.focus();
          return true;
        },
        render: () => (
          <StickyNoteBlock block={block} phone={false} first={false} last={false} onMove={() => {}}
            onEdit={(note) => onEdit(block.id, { note })} onFlush={onFlush} onExit={() => stopEditing(block.id)} onRemove={() => onRemove(block)} />
        ),
      };
    }
    if (isPlanning(block)) {
      const size = ownSize(block);
      const limits = block.type === 'label' ? { ...BLOCK_SIZES.label, minH: size.h, maxH: size.h } : BLOCK_SIZES[block.type];
      const firstField = { label: '.board-label-text', deadline: '.board-deadline-title', link: '.board-link-title', filelist: '.board-filelist-title', search: '.board-search-main, .board-search-action' }[block.type];
      return {
        key: block.id, name, className: `is-${block.type}`, handleOnly: true, size, resize: limits, actions: quickFor(block),
        onHandleKey: (event) => {
          if (event.key !== 'Enter') return false;
          event.preventDefault();
          document.querySelector<HTMLElement>(`[data-board-key="${block.id}"] ${firstField}`)?.focus();
          return true;
        },
        render: () => planningBlock(block, actions, { phone: false, first: false, last: false, onMove: () => {}, onExit: () => stopEditing(block.id) }),
      };
    }
    if (block.type === 'text') {
      return {
        key: block.id, name, className: `is-text ${editingId === block.id ? 'is-editing' : ''}`, handleOnly: true, actions: quickFor(block),
        size: { w: block.w ?? BLOCK_SIZES.text.w, h: block.h ?? BLOCK_SIZES.text.h }, resize: BLOCK_SIZES.text,
        onHandleKey: (event) => {
          if (event.key !== 'Enter') return false;
          event.preventDefault();
          onEditingChange(block.id);
          return true;
        },
        render: () => (
          <TextFrame id={block.id} editingRef={editingRef} onEditingChange={onEditingChange}>
            <RichTextBlock block={block} editing={editingId === block.id} saveState={saveState} phone={false} first={false} last={false} onMove={() => {}}
              onStartEdit={() => onEditingChange(block.id)} onEdit={(doc) => onEdit(block.id, { text: { doc } })} onFlush={onFlush}
              onExit={() => stopEditing(block.id)} onRemove={() => onRemove(block)} />
          </TextFrame>
        ),
      };
    }
    return { key: block.id, name, className: `is-${block.type}${block.ref.available ? '' : ' is-unavailable'}`, render: () => refCard(block) };
  });

  return (
    <BoardCanvas boardKey={tabId} layout={layout} entries={entries} onCommit={onCommit} toolbarStart={toolbarStart} onReset={onReset} empty={empty} toolsBelowNearTop
      toolbarEnd={toolbarEnd} canvasClassName={canvasClassName} zoneLooks
      hint="Drag anything anywhere. Moving a zone moves what’s in it."
      onAutoPlace={(items) => onArrange(Object.fromEntries(Object.entries(items).map(([id, spot]) => {
        const b = blocks.find(x => x.id === id);
        return [id, { x: Math.round(spot.x), y: Math.round(spot.y), ...(b && hasOwnSize(b) ? ownSize(b) : {}) }];
      })), undefined, { debounce: true })} />
  );
};

export default PersonalBoard;

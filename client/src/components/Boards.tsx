import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { workspaceBoardsAPI, BoardTab, BoardLimits } from '../services/api';
import ItemActions from './ItemActions';
import BoardDialog from './BoardDialog';
import BoardTabDialog, { TabLook } from './BoardTabDialog';
import { LinkDialog } from './BoardLinkBlock';
import { SavedSearchDialog } from './BoardSavedSearchBlock';
import { useSavedSearchRuns } from '../hooks/useSavedSearchRuns';
import PersonalBoard from './PersonalBoard';
import BoardList from './BoardList';
import BoardAddFileDialog from './BoardAddFileDialog';
import FolderPickerModal from './FolderPickerModal';
import { PlusIcon } from './Icons';
import { useBoardTabBlocks, BoardNotice } from '../hooks/useBoardTabBlocks';
import { readOpenTab, writeOpenTab, tabAccent } from '../utils/boardTabs';
import './FileBrowser.css';
import './FileBoard.css';
import './Boards.css';

/**
 * Boards (/boards): a person's own tabbed workspace. Each tab is its own board on the same free canvas as
 * My Files > Board (BoardCanvas): chosen files and folders, placed by reference (adding one never moves or
 * copies it, removing one never deletes it), zones, sticky notes (plain text) and text areas (rich text,
 * edited with TipTap, loaded when first needed). On a phone the board is a list.
 *
 * Tabs are saved with the account, with their order and which one is the default. Opening Boards fresh
 * shows the default tab; within one browser session a reload or coming back returns to the tab that was
 * open (kept in sessionStorage), so switching tabs never writes anything to the server.
 */

const errorMessage = (error: any, fallback: string) => error?.response?.data?.message || fallback;

const usePhone = () => {
  const query = '(max-width: 600px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setPhone(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
};

type AddKind = 'file' | 'folder' | 'filelist' | 'search' | 'note' | 'text' | 'deadline' | 'label' | 'link';
// The "+ Add" menu in groups (group names are read out, not chosen).
const ADD_GROUPS: Array<{ name: string; items: Array<[AddKind, string]> }> = [
  { name: 'Files', items: [['file', 'File'], ['folder', 'Folder'], ['filelist', 'File list'], ['search', 'Saved search']] },
  { name: 'Notes & planning', items: [['note', 'Sticky note'], ['text', 'Text area'], ['deadline', 'Deadline']] },
  { name: 'Other', items: [['label', 'Label'], ['link', 'Link']] },
];

/** "+ Add": a grouped menu, usable with the keyboard (arrows move between items, Enter, Escape). */
const AddMenu: React.FC<{ disabled: boolean; onAdd: (kind: AddKind) => void }> = ({ disabled, onAdd }) => {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
  useEffect(() => { if (open) items()[0]?.focus(); }, [open]);
  const close = (focusButton = true) => { setOpen(false); if (focusButton) button.current?.focus(); };
  // Focus goes back to "+ Add" first, so a dialog opened from the menu returns there when it closes.
  const choose = (run: () => void) => { close(); run(); };
  const onMenuKey = (event: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'Tab') close(false);
  };
  return (
    <div className="boards-add" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
      <button ref={button} type="button" className="file-action-button boards-add-button" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        title={disabled ? 'This tab is full (150 items)' : undefined}
        onClick={() => setOpen(o => !o)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
        <PlusIcon size={15} />Add
      </button>
      {open && (
        <div ref={menu} className="boards-add-menu" role="menu" aria-label="Add to this board" onKeyDown={onMenuKey}>
          {ADD_GROUPS.map((group, g) => (
            <div key={group.name} role="group" aria-labelledby={`boards-add-group-${g}`} className="boards-add-group">
              <p id={`boards-add-group-${g}`} className="boards-add-group-name" role="presentation">{group.name}</p>
              {group.items.map(([kind, label]) => (
                <button key={kind} type="button" role="menuitem" onClick={() => choose(() => onAdd(kind))}>{label}</button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const Boards: React.FC = () => {
  const { user } = useAuth();
  const [tabs, setTabs] = useState<BoardTab[]>([]);
  const [limits, setLimits] = useState<BoardLimits | null>(null);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [dialog, setDialog] = useState<null | { kind: 'create' | 'addFile' | 'addFolder' } | { kind: 'edit' | 'delete'; tab: BoardTab }>(null);
  const [notice, setNotice] = useState<BoardNotice | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const phone = usePhone();
  // The one text area being edited (only it has a live editor).
  const [editingId, setEditingId] = useState('');
  const location = useLocation();
  // "Open board" after Add to board… from a file menu asks for that tab.
  const requestedTab = (location.state as { openTabId?: string } | null)?.openTabId;
  // A notice to show once a newly opened tab is on screen (switching tabs clears notices).
  const noticeAfterSwitch = useRef<BoardNotice | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  // A tab to focus once it is on the page (a new tab, or the neighbour of a deleted one).
  const pendingFocus = useRef('');
  const focusTab = (id: string) => { pendingFocus.current = id; };
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !tabRefs.current.get(id)) return;
    pendingFocus.current = '';
    tabRefs.current.get(id)?.focus();
  });

  const choose = useCallback((list: BoardTab[], preferred?: string) => {
    const found = (id?: string) => (id && list.some(t => t.id === id) ? id : '');
    return found(preferred) || found(readOpenTab(user?.id)) || list.find(t => t.isDefault)?.id || list[0]?.id || '';
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    workspaceBoardsAPI.list()
      .then((data) => {
        if (cancelled) return;
        setTabs(data.tabs);
        setLimits(data.limits);
        setActiveId(choose(data.tabs, requestedTab));
        setLoading(false);
      })
      .catch((error) => { if (!cancelled) { setLoadError(errorMessage(error, 'Boards are not available right now.')); setLoading(false); } });
    return () => { cancelled = true; };
    // The requested tab only matters when the page first opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choose]);

  const activate = (id: string) => {
    setActiveId(id);
    writeOpenTab(user?.id, id);
  };
  // The open tab is remembered for this session even when it was chosen for us (default, deleted, …).
  useEffect(() => { if (activeId) writeOpenTab(user?.id, activeId); }, [activeId, user?.id]);

  // Tabs pattern: arrow keys move between tabs (and open them), Home/End jump to the first/last.
  // Alt + Shift + Left/Right moves the tab itself.
  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      moveTab(tabs[index], event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    const last = tabs.length - 1;
    const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    activate(tabs[target].id);
    tabRefs.current.get(tabs[target].id)?.focus();
  };

  const createTab = async ({ name, icon, color }: TabLook) => {
    try {
      const { tab } = await workspaceBoardsAPI.createTab({ name, icon, color });
      setTabs(prev => [...prev, tab]);
      activate(tab.id);
      setDialog(null);
      setAnnouncement(`Created tab ${tab.name}.`);
      focusTab(tab.id);
      return null;
    } catch (error) {
      return errorMessage(error, "Couldn't create the tab. Try again.");
    }
  };

  const editTab = async (tab: BoardTab, { name, icon, color }: TabLook) => {
    try {
      const { tab: saved } = await workspaceBoardsAPI.updateTab(tab.id, { name, icon, color, rev: tab.rev });
      setTabs(prev => prev.map(t => (t.id === saved.id ? { ...t, ...saved } : t)));
      setDialog(null);
      setAnnouncement(`Saved ${saved.name}.`);
      return null;
    } catch (error: any) {
      // Changed on another device: show what is saved now, and let them try again from there.
      if (error?.response?.status === 409 && error.response.data?.tab) {
        const latest: BoardTab = error.response.data.tab;
        setTabs(prev => prev.map(t => (t.id === latest.id ? latest : t)));
        setDialog({ kind: 'edit', tab: latest });
        setAnnouncement('This tab was changed somewhere else. Showing the latest version.');
        return 'This tab was changed somewhere else. Its latest version is shown; try again.';
      }
      if (error?.response?.status === 404) {
        setTabs(prev => prev.filter(t => t.id !== tab.id));
        setDialog(null);
        return null;
      }
      return errorMessage(error, "Couldn't save the tab. Try again.");
    }
  };

  /** Move a tab one place left or right (saved at once; never touches the tab's blocks or revision). */
  const moveTab = async (tab: BoardTab, direction: -1 | 1) => {
    const from = tabs.findIndex(t => t.id === tab.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= tabs.length) return;
    const before = tabs;
    const next = [...tabs];
    next.splice(from, 1);
    next.splice(to, 0, tab);
    setTabs(next);
    focusTab(tab.id);
    setAnnouncement(`Moved ${tab.name} to position ${to + 1} of ${next.length}.`);
    try {
      const { tabs: saved } = await workspaceBoardsAPI.reorderTabs(next.map(t => t.id));
      setTabs(saved);
    } catch (error: any) {
      const latest: BoardTab[] | undefined = error?.response?.data?.tabs;
      setTabs(latest || before);
      setAnnouncement(latest ? 'Your tabs were changed somewhere else. Showing the latest order.' : "Couldn't move the tab. Try again.");
      showNotice({ tone: 'error', text: latest ? 'Your tabs were changed somewhere else. Showing the latest order.' : "Couldn't move the tab. Try again." });
    }
  };

  /** Copy a tab after it (its latest words are saved first). Opens the copy. */
  const duplicateTab = async (tab: BoardTab) => {
    try {
      await board.flush();
      const { tab: copy, tabs: list, skipped } = await workspaceBoardsAPI.duplicateTab(tab.id);
      setTabs(list);
      noticeAfterSwitch.current = {
        text: `Duplicated ${tab.name} as ${copy.name}. Files and folders were not copied; the new tab points at the same items.${skipped ? ` ${skipped} unavailable ${skipped === 1 ? 'item was' : 'items were'} left out.` : ''}`,
      };
      activate(copy.id);
      setAnnouncement(`Duplicated as ${copy.name}.`);
      focusTab(copy.id);
    } catch (error) {
      showNotice({ tone: 'error', text: errorMessage(error, "Couldn't duplicate the tab. Try again.") });
    }
  };

  const makeDefault = async (tab: BoardTab) => {
    try {
      const { tabs: list } = await workspaceBoardsAPI.setDefaultTab(tab.id);
      setTabs(list);
      showNotice({ text: `${tab.name} is now your default tab. It opens first when you come to Boards.` });
    } catch (error) {
      showNotice({ tone: 'error', text: errorMessage(error, "Couldn't change the default tab. Try again.") });
    }
  };

  const deleteTab = async (tab: BoardTab) => {
    setDeleting(true);
    setDeleteError('');
    try {
      const index = tabs.findIndex(t => t.id === tab.id);
      const { tabs: remaining } = await workspaceBoardsAPI.deleteTab(tab.id);
      // The open tab was deleted: open its neighbour (the one after it, else the one before).
      const neighbour = tabs[index + 1]?.id || tabs[index - 1]?.id;
      const next = tab.id === activeId ? choose(remaining, neighbour) : choose(remaining, activeId);
      setTabs(remaining);
      activate(next);
      setDialog(null);
      const fresh = remaining.length === 1 && !tabs.some(t => t.id === remaining[0].id);
      setAnnouncement(fresh ? `Deleted ${tab.name}. A new empty tab, ${remaining[0].name}, was added.` : `Deleted ${tab.name}.`);
      focusTab(next);
    } catch (error) {
      setDeleteError(errorMessage(error, "Couldn't delete the tab. Try again."));
    } finally {
      setDeleting(false);
    }
  };

  // The tab strip scrolls sideways when tabs do not fit: fade the edge that has more, and keep the open tab in view.
  const stripRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const measureStrip = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const next = { left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 };
    setScrollEdges(prev => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);
  useEffect(() => {
    tabRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measureStrip();
  }, [activeId, tabs, measureStrip]);
  useEffect(() => {
    window.addEventListener('resize', measureStrip);
    return () => window.removeEventListener('resize', measureStrip);
  }, [measureStrip]);

  const active = tabs.find(t => t.id === activeId);
  const atLimit = Boolean(limits && tabs.length >= limits.tabs);

  // The open tab's blocks: loaded when the tab opens, saved as they change (see useBoardTabBlocks).
  const updateTabMeta = useCallback((tab: BoardTab) => setTabs(prev => prev.map(t => (t.id === tab.id ? { ...t, ...tab } : t))), []);
  const showNotice = useCallback((n: BoardNotice | null) => { setNotice(n); if (n) setAnnouncement(n.text); }, []);
  const board = useBoardTabBlocks({ tab: active, onTab: updateTabMeta, onNotice: showNotice });
  useEffect(() => {
    setNotice(noticeAfterSwitch.current);
    noticeAfterSwitch.current = null;
    setEditingId('');
  }, [activeId]);
  // A new note or text area opens for typing straight away.
  const focusNew = (id: string, type: 'note' | 'text') => {
    if (type === 'text') { setEditingId(id); return; }
    setTimeout(() => document.querySelector<HTMLElement>(`[data-board-key="${id}"] .board-note-title, [data-list-id="${id}"] .board-note-title`)?.focus(), 80);
  };
  const addNote = () => focusNew(board.addNote(), 'note');
  const addText = () => focusNew(board.addText(), 'text');
  // A new label, deadline or file list: focus its first field so it can be typed into straight away.
  const FIRST_FIELD = { label: '.board-label-text', deadline: '.board-deadline-title', filelist: '.board-filelist-title' };
  const addPlanning = (type: 'label' | 'deadline' | 'filelist') => {
    const id = board.addBlock(type);
    setTimeout(() => document.querySelector<HTMLElement>(`[data-board-key="${id}"] ${FIRST_FIELD[type]}, [data-list-id="${id}"] ${FIRST_FIELD[type]}`)?.focus(), 80);
  };
  const onAdd = (kind: AddKind) => {
    if (kind === 'file') setDialog({ kind: 'addFile' });
    else if (kind === 'folder') setDialog({ kind: 'addFolder' });
    else if (kind === 'note') addNote();
    else if (kind === 'text') addText();
    else if (kind === 'link') setLinkOpen(true);
    else if (kind === 'search') {
      if (board.blocks.filter(b => b.type === 'search').length >= (limits?.searchesPerTab || 10)) showNotice({ tone: 'error', text: `A tab can hold up to ${limits?.searchesPerTab || 10} saved searches.` });
      else setSearchOpen(true);
    }
    else addPlanning(kind);
  };
  const room = (limits?.blocksPerTab || 150) - board.blocks.length;
  const searchRuns = useSavedSearchRuns({ tabId: active?.id, blocks: board.blocks, storedKey: board.storedSearchKey, editing: Boolean(editingId) });
  // Stored file references on this tab: file cards and every file-list row (limit 1,000).
  const refRoom = (limits?.fileRefsPerTab || 1000) - board.blocks.reduce((n, b) => n + (b.type === 'file' ? 1 : b.type === 'filelist' ? b.filelist.items.length : 0), 0);
  const unavailable = board.blocks.filter(b => (b.type === 'file' || b.type === 'folder') && !b.ref.available).length;
  const activeIndex = tabs.findIndex(t => t.id === activeId);

  // Reset board: zones go and everything goes back into rows (as My Files > Board does). Only places change;
  // every file, folder, note and text area stays on the board, and Undo puts the old arrangement back.
  const resetBoard = () => {
    const before = Object.fromEntries(board.blocks.map(b => [b.id, b.x === null || b.y === null ? null : { x: b.x, y: b.y, ...(b.w !== undefined && b.h !== undefined ? { w: b.w, h: b.h } : {}) }]));
    const zonesBefore = board.zones;
    board.arrange(Object.fromEntries(board.blocks.map(b => [b.id, null])), []);
    setResetOpen(false);
    showNotice({ text: 'The board was reset: zones removed and everything arranged in rows. Nothing in File Box changed.', undo: () => { board.arrange(before, zonesBefore); showNotice({ text: 'The board is back as it was.' }); } });
  };
  const actions = {
    onArrange: board.arrange, onEdit: board.edit, onFlush: board.flush, onRemove: board.remove, onReload: board.reload, onEditingChange: setEditingId,
    onRemoveRow: board.removeListRow, refRoom, searchRuns,
  };
  const emptyBoard = (
    <div className="boards-empty-canvas">
      <p className="boards-empty-title">This board is empty.</p>
      <p>Add files and folders you choose (they stay where they are in File Box), notes, text (with checklists), deadlines, labels, links or file lists.</p>
      <div className="boards-empty-actions">
        <button type="button" className="file-action-button" onClick={() => setDialog({ kind: 'addFile' })}>Add file</button>
        <button type="button" className="file-action-button" onClick={() => setDialog({ kind: 'addFolder' })}>Add folder</button>
        <button type="button" className="file-action-button" onClick={addNote}>Add sticky note</button>
        <button type="button" className="file-action-button" onClick={addText}>Add text area</button>
        <button type="button" className="file-action-button" aria-haspopup="menu"
          onClick={() => document.querySelector<HTMLButtonElement>('.boards .boards-add-button')?.click()}>More…</button>
      </div>
    </div>
  );

  if (loading) return <section className="boards" aria-busy="true"><p className="boards-status">Loading your boards…</p></section>;
  if (loadError) {
    return (
      <section className="boards">
        <div className="boards-empty" role="alert"><p className="boards-empty-title">{loadError}</p></div>
      </section>
    );
  }

  return (
    <section className="boards" aria-labelledby="boards-title">
      <h1 id="boards-title" className="boards-visually-hidden">Boards</h1>
      <div className="boards-top">
        <div className="boards-tabbar">
          <div ref={stripRef} className={`boards-tabs ${scrollEdges.left ? 'can-scroll-left' : ''} ${scrollEdges.right ? 'can-scroll-right' : ''}`} role="tablist" aria-label="Board tabs" onScroll={measureStrip}>
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id); }}
                type="button"
                role="tab"
                id={`board-tab-${tab.id}`}
                aria-selected={tab.id === activeId}
                aria-controls={`board-panel-${tab.id}`}
                tabIndex={tab.id === activeId ? 0 : -1}
                className={`boards-tab ${tab.id === activeId ? 'is-active' : ''} ${tabAccent(tab.color) ? 'has-color' : ''}`}
                style={tabAccent(tab.color) ? { ['--tab-accent' as any]: tabAccent(tab.color) } : undefined}
                onClick={() => activate(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {tab.icon && <span className="boards-tab-icon" aria-hidden="true">{tab.icon}</span>}
                <span className="boards-tab-name">{tab.name}</span>
                {tab.isDefault && <span className="boards-tab-default" title="Default tab" aria-hidden="true">⌂</span>}
                {tab.isDefault && <span className="boards-visually-hidden"> (default)</span>}
              </button>
            ))}
          </div>
          <button type="button" className="boards-add-tab" onClick={() => setDialog({ kind: 'create' })} disabled={atLimit}
            aria-label="New tab" title={atLimit ? `You can have up to ${limits?.tabs} tabs` : 'New tab'}>
            <PlusIcon size={16} />
          </button>
          {active && (
            <ItemActions className="boards-tab-menu" label={`Options for tab ${active.name}`}>
              <button type="button" onClick={() => setDialog({ kind: 'edit', tab: active })}>Edit tab…</button>
              <button type="button" onClick={() => duplicateTab(active)} disabled={atLimit} title={atLimit ? `You can have up to ${limits?.tabs} tabs` : undefined}>Duplicate tab</button>
              {activeIndex > 0 && <button type="button" onClick={() => moveTab(active, -1)}>Move left</button>}
              {activeIndex < tabs.length - 1 && <button type="button" onClick={() => moveTab(active, 1)}>Move right</button>}
              {active.isDefault
                ? <span className="boards-menu-note" role="note">✓ Default tab</span>
                : <button type="button" onClick={() => makeDefault(active)}>Set as default tab</button>}
              {unavailable > 0 && <button type="button" onClick={() => board.removeUnavailable()}>Remove unavailable items ({unavailable})</button>}
              <button type="button" className="is-danger" onClick={() => { setDeleteError(''); setDialog({ kind: 'delete', tab: active }); }}>Delete tab…</button>
            </ItemActions>
          )}
        </div>
      </div>

      {notice && (
        <div className={`boards-notice ${notice.tone === 'error' ? 'is-error' : ''}`}>
          <span>{notice.text}</span>
          {notice.undo && <button type="button" className="boards-button-quiet" onClick={notice.undo}>Undo</button>}
          <button type="button" className="boards-notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {active && (
        <div className="file-browser personal-board" role="tabpanel" id={`board-panel-${active.id}`} aria-labelledby={`board-tab-${active.id}`}>
          <div className="file-canvas">
            {board.loading && <p className="boards-status">Loading this board…</p>}
            {board.error && <div className="boards-empty-canvas" role="alert"><p className="boards-empty-title">{board.error}</p></div>}
            {!board.loading && !board.error && (phone ? (
              <>
                <div className="file-board-toolbar boards-phone-toolbar">
                  <AddMenu disabled={room <= 0} onAdd={onAdd} />
                  <span className="file-board-hint">Zones and free arranging are on larger screens. Here you can edit and reorder.</span>
                </div>
                <BoardList blocks={board.blocks} zones={board.zones} saveState={board.saveState} editingId={editingId} empty={emptyBoard} {...actions} />
              </>
            ) : (
              <PersonalBoard tabId={active.id} blocks={board.blocks} zones={board.zones} saveState={board.saveState} editingId={editingId}
                toolbarStart={<AddMenu disabled={room <= 0} onAdd={onAdd} />}
                onReset={() => setResetOpen(true)} empty={emptyBoard} {...actions} />
            ))}
          </div>
        </div>
      )}

      <p className="boards-visually-hidden" role="status" aria-live="polite">{announcement}</p>

      {dialog?.kind === 'addFile' && (
        <BoardAddFileDialog
          onTab={new Set(board.blocks.flatMap(b => (b.type === 'file' && b.ref.available && b.ref.fileId ? [b.ref.fileId] : [])))}
          remaining={Math.min(room, refRoom)}
          fullText={refRoom < room ? 'This tab has as many files as it can hold (1,000 file references).' : undefined}
          onClose={() => setDialog(null)}
          onAdd={(files) => {
            const added = board.addFiles(files);
            setDialog(null);
            showNotice({ text: `Added ${added} ${added === 1 ? 'file' : 'files'} to ${active?.name}. ${added === 1 ? 'It stays' : 'They stay'} where ${added === 1 ? 'it is' : 'they are'} in File Box.` });
          }} />
      )}
      {dialog?.kind === 'addFolder' && (
        <FolderPickerModal title="Add a folder to this board" confirmLabel="Add a folder"
          onClose={() => setDialog(null)}
          onSelect={(folderId) => {
            if (!folderId) { showNotice({ tone: 'error', text: 'Choose a folder inside My Files.' }); return; }
            if (room <= 0) { showNotice({ tone: 'error', text: 'This tab is full (150 items).' }); return; }
            showNotice(board.addFolder(folderId) ? { text: `Added the folder to ${active?.name}. It stays where it is.` } : { tone: 'error', text: 'That folder is already on this tab.' });
          }} />
      )}
      {linkOpen && (
        <LinkDialog onClose={() => setLinkOpen(false)} onSave={(link) => {
          setLinkOpen(false);
          const id = board.addBlock('link', { link });
          setTimeout(() => document.querySelector<HTMLElement>(`[data-board-key="${id}"] .board-link-title, [data-list-id="${id}"] .board-link-title`)?.focus(), 120);
        }} />
      )}
      {searchOpen && (
        <SavedSearchDialog onClose={() => setSearchOpen(false)} onSave={(search) => {
          setSearchOpen(false);
          const id = board.addBlock('search', { search });
          setTimeout(() => document.querySelector<HTMLElement>(`[data-board-key="${id}"] .board-item-handle, [data-list-id="${id}"]`)?.focus(), 120);
        }} />
      )}
      {resetOpen && (
        <BoardDialog title="Reset this board?" describedBy="boards-reset-text" onClose={() => setResetOpen(false)}>
          <p id="boards-reset-text" className="boards-dialog-text">
            Zones will be removed and everything will be arranged back into rows. Files, folders, sticky notes, and text areas stay on this board. Nothing in File Box will be moved or deleted.
          </p>
          <div className="boards-dialog-actions">
            <button type="button" className="boards-button-secondary" data-autofocus onClick={() => setResetOpen(false)}>Cancel</button>
            <button type="button" className="boards-button-primary" onClick={resetBoard}>Reset board</button>
          </div>
        </BoardDialog>
      )}
      {dialog?.kind === 'create' && limits && (
        <BoardTabDialog mode="create" initial={{ name: '', icon: '', color: '' }} max={limits.tabName} onSave={createTab} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'edit' && limits && (
        <BoardTabDialog key={dialog.tab.id} mode="edit" initial={{ name: dialog.tab.name, icon: dialog.tab.icon, color: dialog.tab.color }} max={limits.tabName}
          onSave={(look) => editTab(dialog.tab, look)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <BoardDialog title={`Delete “${dialog.tab.name}”?`} describedBy="boards-delete-text" onClose={() => !deleting && setDialog(null)}>
          <p id="boards-delete-text" className="boards-dialog-text">
            This removes the tab and everything placed on it. Files and folders stay exactly where they are in File Box.
            {tabs.length === 1 && ' It is your only tab, so a new empty tab will take its place.'}
            {tabs.length > 1 && dialog.tab.isDefault && ` It is your default tab, so ${tabs.find(t => t.id !== dialog.tab.id)?.name} will become the default.`}
          </p>
          {deleteError && <p className="boards-dialog-error" role="alert">{deleteError}</p>}
          <div className="boards-dialog-actions">
            <button type="button" className="boards-button-secondary" data-autofocus onClick={() => setDialog(null)} disabled={deleting}>Cancel</button>
            <button type="button" className="boards-button-danger" onClick={() => deleteTab(dialog.tab)} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete tab'}</button>
          </div>
        </BoardDialog>
      )}
    </section>
  );
};

export default Boards;

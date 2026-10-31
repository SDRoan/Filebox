import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ItemActions from './ItemActions';
import BoardAddFileDialog from './BoardAddFileDialog';
import FilePreview from './FilePreview';
import { Common, MoveItems } from './BoardNoteBlocks';
import { fileCard } from './PersonalBoard';
import { AudioIcon, DocumentIcon, ImageIcon, VideoIcon } from './Icons';
import { useAuth } from '../context/AuthContext';
import { BoardBlock, BoardFileList, BoardFileListRow, BoardRef } from '../services/api';
import { searchRef } from '../hooks/useBoardTabBlocks';
import { formatRelativeTime } from '../utils/fileDisplay';

/**
 * A file list on a board: a title and up to 50 files chosen with the usual file picker. Rows are references
 * (resolved live, with the board's other files, in one lookup): a file this person can no longer open shows
 * only "File no longer available" in its place, and comes back if access does. Clicking a row opens the
 * normal preview. Taking a row out of the list never touches the file. Nothing is read from the files and
 * no thumbnails are loaded.
 */

const LIMIT = { title: 100, rows: 50 };
const clip = (value: string, max: number) => Array.from(value).slice(0, max).join('');
const newRowId = () => { let id = ''; while (id.length < 8) id += Math.random().toString(36).slice(2); return id.slice(0, 8); };
type Available = Extract<BoardRef, { available: true }>;

const iconFor = (ref: Available) => {
  const type = ref.mimeType || '';
  if (type.startsWith('image/')) return <ImageIcon size={18} />;
  if (type.startsWith('video/')) return <VideoIcon size={18} />;
  if (type.startsWith('audio/')) return <AudioIcon size={18} />;
  return <DocumentIcon size={18} />;
};
const whereOf = (ref: Available) => (ref.source === 'shared' ? `Shared by ${ref.ownerName || 'someone'}` : ref.source === 'team' ? `Team Space${ref.teamName ? ` · ${ref.teamName}` : ''}` : 'My Files');
const filesWord = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

export const FileListBlock: React.FC<Common & {
  block: Extract<BoardBlock, { type: 'filelist' }>;
  room: number;
  onEdit: (list: BoardFileList, now: boolean) => void;
  onRemoveRow: (rowId: string) => void;
}> = ({ block, room, onEdit, onRemoveRow, onFlush, onExit, onRemove, onMove, phone, first, last }) => {
  const { user } = useAuth();
  const card = useRef<HTMLDivElement>(null);
  const list = block.filelist;
  const rows = list.items;
  // The title follows the saved one (another device, a conflict) unless it is being typed in.
  const [title, setTitle] = useState(list.title);
  const typing = useRef(false);
  const composing = useRef(false);
  useEffect(() => { if (!typing.current) setTitle(list.title); }, [list.title]);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<{ rowId: string; ref: Available } | null>(null);
  const full = rows.length >= LIMIT.rows;
  const canAdd = Math.max(0, Math.min(LIMIT.rows - rows.length, room));
  const name = title || 'File list';

  const save = (items: BoardFileListRow[], now = true) => onEdit({ title, items }, now);
  const focusRow = (rowId: string) => setTimeout(() => card.current?.querySelector<HTMLElement>(`[data-row-id="${rowId}"] .board-filelist-main`)?.focus(), 0);
  const moveRow = (index: number, to: number) => {
    if (to < 0 || to >= rows.length || to === index) return;
    const items = [...rows];
    const [row] = items.splice(index, 1);
    items.splice(to, 0, row);
    save(items);
    focusRow(row.id);
  };
  const removeRow = (index: number) => {
    const next = rows[index + 1] || rows[index - 1];
    onRemoveRow(rows[index].id);
    if (next) focusRow(next.id);
    else setTimeout(() => card.current?.querySelector<HTMLElement>('.board-filelist-add')?.focus(), 0);
  };
  const onRowKey = (index: number) => (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onExit(); return; }
    if (event.key === 'Delete') { event.preventDefault(); removeRow(index); return; }
    if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); moveRow(index, index - 1); return; }
    if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); moveRow(index, index + 1); return; }
    if (event.altKey && event.key === 'Home') { event.preventDefault(); moveRow(index, 0); return; }
    if (event.altKey && event.key === 'End') { event.preventDefault(); moveRow(index, rows.length - 1); return; }
    if (event.key === 'ArrowUp' && rows[index - 1]) { event.preventDefault(); focusRow(rows[index - 1].id); }
    if (event.key === 'ArrowDown' && rows[index + 1]) { event.preventDefault(); focusRow(rows[index + 1].id); }
  };
  const sendTitle = (value: string) => { setTitle(value); onEdit({ title: value, items: rows }, false); };

  // Rows already in the list (by file) are shown as such in the picker.
  const inList = new Set(rows.flatMap(r => (r.ref.available && r.ref.fileId ? [r.ref.fileId] : r.fileId ? [r.fileId] : [])));

  return (
    <div ref={card} className={`board-filelist-card ${phone ? 'is-phone' : ''}`}>
      <div className="board-filelist-head">
        <div className="board-note-top">
          <span className="board-note-kind">File list</span>
          <span className="board-filelist-count">{filesWord(rows.length)}</span>
          <ItemActions className="board-block-menu" label={`Options for file list ${name}`}>
            <button type="button" disabled={full || canAdd <= 0} onClick={() => setPicking(true)}>Add files…</button>
            <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
            <button type="button" onClick={onRemove}>Remove from board</button>
          </ItemActions>
        </div>
        <div className="board-filelist-bar">
          <input className="board-filelist-title" value={title} placeholder="File list" aria-label="File list title" maxLength={LIMIT.title + 2}
            onFocus={() => { typing.current = true; }}
            onBlur={() => { typing.current = false; onFlush(); }}
            onChange={(e) => { const value = clip(e.target.value, LIMIT.title); if (composing.current) setTitle(value); else sendTitle(value); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={(e) => { composing.current = false; sendTitle(clip((e.target as HTMLInputElement).value, LIMIT.title)); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); onExit(); }
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (rows.length) focusRow(rows[0].id); else card.current?.querySelector<HTMLElement>('.board-filelist-add')?.focus(); }
            }} />
          <button type="button" className="board-filelist-add" onClick={() => setPicking(true)} disabled={full || canAdd <= 0}
            title={full ? `A file list can hold up to ${LIMIT.rows} files` : canAdd <= 0 ? 'This tab has as many files as it can hold' : undefined}>+ Add files</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="board-filelist-empty">No files yet. Add files to keep them together here; they stay where they are in File Box.</p>
      ) : (
        <ul className="board-filelist-rows" aria-label={`${name}, ${filesWord(rows.length)}`} aria-describedby={`${block.id}-keys`}>
          {rows.map((row, index) => {
            const ref = row.ref;
            const label = ref.available ? ref.name : 'File no longer available';
            const controls = phone ? 0 : -1;
            return (
              <li key={row.id} data-row-id={row.id} className={`board-filelist-row ${ref.available ? '' : 'is-unavailable'}`}>
                {ref.available ? (
                  <button type="button" className="board-filelist-main" onClick={() => setPreview({ rowId: row.id, ref })} onKeyDown={onRowKey(index)}
                    aria-label={`Open ${ref.name}`}>
                    <span className="board-filelist-icon" aria-hidden="true">{iconFor(ref)}</span>
                    <span className="board-filelist-text">
                      <span className="board-filelist-name">{ref.name}</span>
                      <span className="board-filelist-meta">{whereOf(ref)}{ref.updatedAt ? ` · Modified ${formatRelativeTime(ref.updatedAt)}` : ''}</span>
                    </span>
                  </button>
                ) : (
                  // Nothing about the file is known here (not even its id): only that it cannot be opened.
                  <span className="board-filelist-main" tabIndex={0} onKeyDown={onRowKey(index)}>
                    <span className="board-filelist-icon" aria-hidden="true"><DocumentIcon size={18} /></span>
                    <span className="board-filelist-text"><span className="board-filelist-name">File no longer available</span></span>
                  </span>
                )}
                <span className="board-filelist-controls">
                  <button type="button" tabIndex={controls} disabled={index === 0} aria-label={`Move ${label} up`} title="Move up" onClick={() => moveRow(index, index - 1)}>↑</button>
                  <button type="button" tabIndex={controls} disabled={index === rows.length - 1} aria-label={`Move ${label} down`} title="Move down" onClick={() => moveRow(index, index + 1)}>↓</button>
                  <button type="button" tabIndex={controls} aria-label={`Remove ${label} from this list (the file stays in File Box)`} title="Remove from list" onClick={() => removeRow(index)}>×</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${block.id}-keys`} className="boards-visually-hidden">Arrow keys move between files. Alt and arrow keys reorder; Alt with Home or End moves to the top or bottom. Delete removes a file from this list.</p>
      {picking && (
        <BoardAddFileDialog title={`Add files to ${name}`} where="this list" alreadyLabel="In this list"
          fullText={rows.length >= LIMIT.rows ? `This list is full (${LIMIT.rows} files).` : 'This tab has as many files as it can hold (1,000).'}
          onTab={inList} remaining={canAdd}
          onClose={() => { setPicking(false); setTimeout(() => card.current?.querySelector<HTMLElement>('.board-filelist-add')?.focus(), 0); }}
          onAdd={(files) => {
            setPicking(false);
            const added = files.filter(f => !inList.has(f._id)).slice(0, canAdd).map(f => ({ id: newRowId(), fileId: f._id, ref: searchRef(f) }));
            if (!added.length) return;
            save([...rows, ...added]);
            focusRow(added[0].id);
          }} />
      )}
      {/* Outside the board: the board's surfaces may have their own colours (dark mode), which would contain it. */}
      {preview && createPortal(
        <FilePreview file={fileCard(preview.ref, user?.id)} onClose={() => { const id = preview.rowId; setPreview(null); focusRow(id); }} />,
        document.body,
      )}
    </div>
  );
};

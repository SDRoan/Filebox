import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import ItemActions from './ItemActions';
import BoardDialog from './BoardDialog';
import FilePreview from './FilePreview';
import FolderPickerModal from './FolderPickerModal';
import { Common, MoveItems } from './BoardNoteBlocks';
import { AudioIcon, DocumentIcon, ImageIcon, VideoIcon } from './Icons';
import { advancedSearchAPI, filesAPI, teamFoldersAPI, BoardBlock, BoardSavedSearch, SavedSearchRow } from '../services/api';
import { FileItem as FileItemType } from '../types';
import { SearchRunState } from '../hooks/useSavedSearchRuns';
import { SEARCH_CATEGORIES, SEARCH_DATES, SEARCH_DEFAULTS, SEARCH_FORMATS, SEARCH_SORTS, autoTitle, summaryOf, titleOf, viewAllUrl } from '../utils/savedSearch';
import { formatRelativeTime } from '../utils/fileDisplay';

/**
 * A saved search on a board: structured Advanced Search filters, run with current access (see
 * useSavedSearchRuns). The block shows the count and the top 3, 5 or 10 files; a row opens the normal
 * preview, and View all opens Advanced Search with exactly the same filters. Nothing it finds is stored.
 */

const LIMIT = { title: 100, text: 300, topic: 60 };
const clip = (value: string, max: number) => Array.from(value).slice(0, max).join('');

const iconFor = (type = '') => {
  if (type.startsWith('image/')) return <ImageIcon size={18} />;
  if (type.startsWith('video/')) return <VideoIcon size={18} />;
  if (type.startsWith('audio/')) return <AudioIcon size={18} />;
  return <DocumentIcon size={18} />;
};
const whereOf = (r: SavedSearchRow) => (r.access.source === 'shared' ? `Shared by ${r.ownerName || 'someone'}`
  : r.access.source === 'team' ? `Team Space${r.access.teamName ? ` · ${r.access.teamName}` : ''}` : r.folderName || 'My Files');

/** Add or edit a saved search's filters (the same filters as Advanced Search). */
export const SavedSearchDialog: React.FC<{ initial?: BoardSavedSearch; scopeName?: string; onSave: (search: BoardSavedSearch) => void; onClose: () => void }> = ({ initial, scopeName, onSave, onClose }) => {
  const [s, setS] = useState<BoardSavedSearch>(initial || SEARCH_DEFAULTS);
  const [taxonomy, setTaxonomy] = useState<Array<{ name: string; documentTypes: string[] }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [folderName, setFolderName] = useState(initial?.location === 'folder' ? scopeName || '' : '');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  // Until a sort is chosen, it follows the words as on the search page: Best match with words, else Recently modified.
  const [sortChosen, setSortChosen] = useState(Boolean(initial));
  useEffect(() => {
    advancedSearchAPI.taxonomy().then(t => setTaxonomy(t.categories)).catch(() => setTaxonomy([]));
    // Only Team Spaces this person is in now (a Team Space they left is never named).
    teamFoldersAPI.getTeamFolders().then((list: any) => setTeams((Array.isArray(list) ? list : []).map((t: any) => ({ id: String(t._id), name: String(t.name || 'Team Space') })))).catch(() => setTeams([]));
  }, []);
  const set = (changes: Partial<BoardSavedSearch>) => { setError(''); setS(prev => ({ ...prev, ...changes })); };
  const types = s.category === 'all' ? [] : taxonomy.find(c => c.name === s.category)?.documentTypes || [];
  const place = s.location === 'team' && s.teamId ? `team:${s.teamId}` : s.location;
  const teamKnown = !s.teamId || teams.some(t => t.id === s.teamId);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (s.date === 'custom' && !s.from && !s.to) { setError('Choose a start or an end for the custom range.'); return; }
    if (s.date === 'custom' && s.from && s.to && s.from > s.to) { setError('The start of the range is after its end.'); return; }
    if (s.location === 'folder' && !s.folderId) { setError('Choose a folder.'); return; }
    const text = s.text.replace(/\s+/g, ' ').trim();
    const sort = !text && (s.sort === 'best' || s.sort === 'content') ? 'modified' : s.sort;
    onSave({ ...s, title: s.title.replace(/\s+/g, ' ').trim(), text, topic: s.topic.trim(), sort, from: s.date === 'custom' ? s.from : null, to: s.date === 'custom' ? s.to : null });
  };

  if (picking) {
    // Outside the board (see the preview below).
    return createPortal(
      <FolderPickerModal title="Search one folder" confirmLabel="Use this folder" onClose={() => setPicking(false)}
        onSelect={(folderId) => {
          setPicking(false);
          if (!folderId) return;
          set({ location: 'folder', folderId, teamId: null });
          setFolderName('');
          filesAPI.getFolder(folderId).then((f: any) => setFolderName(f?.name || '')).catch(() => setFolderName(''));
        }} />,
      document.body,
    );
  }
  return (
    <BoardDialog title={initial ? 'Edit saved search' : 'Add a saved search'} wide onClose={onClose}>
      <form onSubmit={submit} noValidate className="board-search-form">
        <label className="boards-field">
          <span>Title (optional)</span>
          <input value={s.title} onChange={e => set({ title: clip(e.target.value, LIMIT.title) })} placeholder={autoTitle(s)} maxLength={LIMIT.title + 2} data-autofocus />
        </label>
        <label className="boards-field">
          <span>Words to find (optional)</span>
          <input type="search" value={s.text} onChange={(e) => {
            const words = Boolean(e.target.value.trim());
            const sort = !sortChosen ? (words ? 'best' : 'modified') : !words && (s.sort === 'best' || s.sort === 'content') ? 'modified' : s.sort;
            set({ text: clip(e.target.value, LIMIT.text), sort });
          }} placeholder="A name, or words inside files" autoComplete="off" />
        </label>
        <div className="board-search-grid">
          <label className="boards-field"><span>Category</span>
            <select value={s.category} onChange={e => set({ category: e.target.value, documentType: 'all' })}>
              <option value="all">All categories</option>
              {SEARCH_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="boards-field"><span>Document type</span>
            <select value={s.documentType} disabled={s.category === 'all'} onChange={e => set({ documentType: e.target.value })}>
              <option value="all">{s.category === 'all' ? 'Choose a category first' : 'All types'}</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
              {s.documentType !== 'all' && !types.includes(s.documentType) && <option value={s.documentType}>{s.documentType}</option>}
            </select>
          </label>
          <label className="boards-field"><span>Format</span>
            <select value={s.format} onChange={e => set({ format: e.target.value as BoardSavedSearch['format'] })}>
              {SEARCH_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="boards-field"><span>Topic (optional)</span>
            <input value={s.topic} onChange={e => set({ topic: clip(e.target.value, LIMIT.topic) })} maxLength={LIMIT.topic + 2} />
          </label>
          <label className="boards-field"><span>Date</span>
            <select value={s.date} onChange={e => set({ date: e.target.value as BoardSavedSearch['date'] })}>
              {SEARCH_DATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="boards-field"><span>Date means</span>
            <select value={s.dateField} onChange={e => set({ dateField: e.target.value as BoardSavedSearch['dateField'] })}>
              <option value="modified">Modified</option>
              <option value="uploaded">Uploaded</option>
            </select>
          </label>
          {s.date === 'custom' && (
            <>
              <label className="boards-field"><span>From</span><input type="date" value={s.from || ''} min="2000-01-01" max="2100-12-31" onChange={e => set({ from: e.target.value || null })} /></label>
              <label className="boards-field"><span>To</span><input type="date" value={s.to || ''} min="2000-01-01" max="2100-12-31" onChange={e => set({ to: e.target.value || null })} /></label>
            </>
          )}
          <label className="boards-field"><span>Location</span>
            <select value={place} onChange={(e) => {
              const v = e.target.value;
              if (v === 'folder') { setPicking(true); return; }
              if (v.startsWith('team:')) set({ location: 'team', teamId: v.slice(5), folderId: null });
              else set({ location: v as BoardSavedSearch['location'], teamId: null, folderId: null });
            }}>
              <option value="everywhere">Everywhere</option>
              <option value="my-files">My Files</option>
              <option value="shared">Shared with me</option>
              {teams.length > 0 && <option value="team">All my Team Spaces</option>}
              {teams.map(t => <option key={t.id} value={`team:${t.id}`}>Team Space · {t.name}</option>)}
              {s.teamId && !teamKnown && <option value={`team:${s.teamId}`}>A Team Space you can no longer open</option>}
              <option value="folder">{s.location === 'folder' ? `Folder · ${folderName || 'chosen folder'}` : 'One folder…'}</option>
            </select>
          </label>
          {s.location === 'folder' && <button type="button" className="boards-button-secondary board-search-pick" onClick={() => setPicking(true)}>Choose another folder…</button>}
          <label className="boards-field"><span>Sort</span>
            <select value={s.sort} onChange={(e) => { setSortChosen(true); set({ sort: e.target.value as BoardSavedSearch['sort'] }); }}>
              {SEARCH_SORTS.map(([v, l]) => <option key={v} value={v} disabled={!s.text.trim() && (v === 'best' || v === 'content')}>{l}</option>)}
            </select>
          </label>
          <label className="boards-field"><span>Show</span>
            <select value={s.show} onChange={e => set({ show: Number(e.target.value) as 3 | 5 | 10 })}>
              {[3, 5, 10].map(n => <option key={n} value={n}>{n} results</option>)}
            </select>
          </label>
        </div>
        <p className="boards-field-help is-left">Saves the filters, not the results. Results are found again, with your current access, each time they are shown.</p>
        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="boards-button-primary">{initial ? 'Save' : 'Add saved search'}</button>
        </div>
      </form>
    </BoardDialog>
  );
};

export const SavedSearchBlock: React.FC<Common & {
  block: Extract<BoardBlock, { type: 'search' }>;
  run?: SearchRunState;
  observe: (id: string, element: HTMLElement | null) => void;
  onRefresh: () => void;
  onEdit: (search: BoardSavedSearch) => void;
}> = ({ block, run, observe, onRefresh, onEdit, onExit, onRemove, onMove, phone, first, last }) => {
  const s = block.search;
  const card = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<SavedSearchRow | null>(null);
  useEffect(() => { observe(block.id, card.current); return () => observe(block.id, null); }, [block.id, observe]);
  const title = titleOf(s);
  const loading = !run || run.status === 'loading';
  const ok = run?.status === 'ok' || (run?.status === 'loading' && run.results) || (run?.status === 'error' && run.results);
  const rows = run && run.status !== 'unavailable' ? run.results || [] : [];
  const total = run && run.status !== 'unavailable' ? run.total : undefined;
  const fresh = run?.fresh || new Set<string>();
  // Moving between rows may scroll the row into view; returning to a row (after its preview) never scrolls.
  const focusRow = (id: string, back = false) => setTimeout(() => card.current?.querySelector<HTMLElement>(`[data-result-id="${id}"] .board-search-main`)?.focus(back ? { preventScroll: true } : undefined), 0);
  const onRowKey = (index: number) => (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onExit(); }
    else if (event.key === 'ArrowDown' && rows[index + 1]) { event.preventDefault(); focusRow(rows[index + 1]._id); }
    else if (event.key === 'ArrowUp' && rows[index - 1]) { event.preventDefault(); focusRow(rows[index - 1]._id); }
  };
  const count = total === undefined ? '' : total === 0 ? 'No results' : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`;
  const status = run?.status === 'unavailable' ? 'This folder or Team Space is no longer available.'
    : run?.status === 'ok' ? `${title}: ${count}${fresh.size ? `, ${fresh.size} new` : ''}` : '';

  return (
    <div ref={card} className={`board-search-card ${phone ? 'is-phone' : ''}`} aria-busy={loading}>
      <div className="board-search-head">
        <div className="board-note-top">
          <span className="board-note-kind">Saved search</span>
          {count && <span className="board-search-count">{count}{fresh.size ? ` · ${fresh.size} new` : ''}</span>}
          <ItemActions className="board-block-menu" label={`Options for saved search ${title}`}>
            <button type="button" onClick={() => setEditing(true)}>Edit search…</button>
            {run?.status !== 'unavailable' && <button type="button" onClick={onRefresh}>Refresh</button>}
            <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
            <button type="button" onClick={onRemove}>Remove from board</button>
          </ItemActions>
        </div>
        <p className="board-search-title">{title}</p>
        {run?.status !== 'unavailable' && <p className="board-search-summary">{summaryOf(s, run?.scopeName)}</p>}
      </div>
      {run?.status === 'unavailable' ? (
        <p className="board-search-gone">This folder or Team Space is no longer available.</p>
      ) : !ok ? (
        <p className="board-search-note">{run?.status === 'error' ? "Couldn't refresh. Try again." : 'Searching…'}</p>
      ) : rows.length === 0 ? (
        <p className="board-search-note">No files match right now.</p>
      ) : (
        <ul className="board-search-rows" aria-label={`${title}, ${count}, showing ${rows.length}`}>
          {rows.map((r, index) => (
            <li key={r._id} data-result-id={r._id} className="board-search-row">
              <button type="button" className="board-search-main" onClick={() => setPreview(r)} onKeyDown={onRowKey(index)}
                aria-label={`Open ${r.originalName}${fresh.has(r._id) ? ', new' : ''}`}>
                <span className="board-search-icon" aria-hidden="true">{iconFor(r.mimeType)}</span>
                <span className="board-search-text">
                  <span className="board-search-line">
                    <span className="board-search-name">{r.originalName}</span>
                    {fresh.has(r._id) && <span className="board-search-new" aria-hidden="true">New</span>}
                  </span>
                  <span className="board-search-meta">{whereOf(r)} · {s.dateField === 'uploaded' ? `Uploaded ${formatRelativeTime(r.createdAt)}` : `Modified ${formatRelativeTime(r.updatedAt)}`}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {run?.status === 'error' && ok && <p className="board-search-note" role="alert">Couldn't refresh. Try again.</p>}
      <div className="board-search-foot">
        {run?.status === 'unavailable' ? (
          <button type="button" className="board-search-action" onClick={() => setEditing(true)}>Edit search…</button>
        ) : (
          <>
            <button type="button" className="board-search-action board-search-refresh" onClick={onRefresh} disabled={run?.status === 'loading'}>↻ Refresh</button>
            <Link className="board-search-action board-search-all" to={viewAllUrl(s)}>View all{total ? ` (${total.toLocaleString()})` : ''} →</Link>
          </>
        )}
      </div>
      <p className="boards-visually-hidden" role="status" aria-live="polite">{status}</p>
      {editing && (
        <SavedSearchDialog initial={s} scopeName={run?.status === 'ok' ? run.scopeName : undefined} onClose={() => setEditing(false)}
          // Saving always runs it again once saved (also when nothing changed, e.g. access came back).
          onSave={(next) => { setEditing(false); onEdit(next); onRefresh(); setTimeout(() => card.current?.querySelector<HTMLElement>('.board-search-refresh, .board-search-action')?.focus({ preventScroll: true }), 50); }} />
      )}
      {/* Outside the board: the board's surfaces may have their own colours (dark mode), which would contain it. */}
      {preview && createPortal(
        <FilePreview file={{ ...preview, name: preview.originalName, access: preview.access.role } as unknown as FileItemType}
          onClose={() => { const id = preview._id; setPreview(null); focusRow(id, true); }} />,
        document.body,
      )}
    </div>
  );
};

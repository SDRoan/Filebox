import React, { useEffect, useRef, useState } from 'react';
import BoardDialog from './BoardDialog';
import { advancedSearchAPI, AdvancedSearchResult } from '../services/api';
import { formatRelativeTime } from '../utils/fileDisplay';

/**
 * Add files to a board, found with File Box's Advanced Search (the same permission-checked search as the
 * Advanced Search page: recently modified files at first, then names and words inside files). Several can be
 * chosen at once; files already on this tab are shown as such. Nothing about the files changes.
 */

const PAGE = 30;
const TYPING_DELAY = 250;

interface Props {
  onTab: Set<string>;
  remaining: number;
  onAdd: (files: AdvancedSearchResult[]) => void;
  onClose: () => void;
}

const where = (r: AdvancedSearchResult) => (r.access.source === 'shared' ? `Shared by ${r.ownerName || 'someone'}` : r.access.source === 'team' ? `Team Space${r.access.teamName ? ` · ${r.access.teamName}` : ''}` : r.folderName || 'My Files');

const BoardAddFileDialog: React.FC<Props> = ({ onTab, remaining, onAdd, onClose }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdvancedSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<Map<string, AdvancedSearchResult>>(new Map());
  const latest = useRef(0);

  // Only the newest search may change the list; slower, older answers are ignored.
  useEffect(() => {
    const id = latest.current + 1;
    latest.current = id;
    setLoading(true);
    const timer = setTimeout(() => {
      advancedSearchAPI.search({ q: query.trim() || undefined, limit: PAGE, tz: new Date().getTimezoneOffset() })
        .then((r) => { if (latest.current === id) { setResults(r.results); setTotal(r.total); setError(''); setLoading(false); } })
        .catch(() => { if (latest.current === id) { setError("Couldn't search your files. Try again."); setLoading(false); } });
    }, query ? TYPING_DELAY : 0);
    return () => clearTimeout(timer);
  }, [query]);

  const more = async () => {
    const id = latest.current;
    try {
      const r = await advancedSearchAPI.search({ q: query.trim() || undefined, limit: PAGE, offset: results.length, tz: new Date().getTimezoneOffset() });
      if (latest.current === id) setResults(prev => [...prev, ...r.results]);
    } catch { setError("Couldn't load more files."); }
  };

  const toggle = (r: AdvancedSearchResult) => setChosen((prev) => {
    const next = new Map(prev);
    if (next.has(r._id)) next.delete(r._id);
    else if (next.size < remaining) next.set(r._id, r);
    return next;
  });

  return (
    <BoardDialog title="Add files" describedBy="board-add-file-help" wide onClose={onClose}>
      <label className="boards-field">
        <span>Find files</span>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="A name, or words inside the file…" autoComplete="off" />
      </label>
      <p id="board-add-file-help" className="boards-field-help is-left">
        {query.trim() ? `${total} ${total === 1 ? 'file' : 'files'}` : 'Recently modified'} · Adding a file only places it on this board; it stays where it is.
      </p>
      <div className="board-picker-list" aria-busy={loading} aria-label="Files">
        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        {!loading && !error && !results.length && <p className="board-picker-empty">No files matched.</p>}
        {results.map((r) => {
          const already = onTab.has(r._id);
          const checked = already || chosen.has(r._id);
          const full = !already && !checked && chosen.size >= remaining;
          return (
            <label key={r._id} className={`board-picker-row ${already ? 'is-on-tab' : ''}`}>
              <input type="checkbox" checked={checked} disabled={already || full} onChange={() => toggle(r)} />
              <span className="board-picker-text">
                <span className="board-picker-name">{r.originalName}</span>
                <span className="board-picker-meta">
                  {r.classification && !(r.classification.primaryCategory === 'Other' && r.classification.documentType === 'Unknown') && `${r.classification.primaryCategory} · ${r.classification.documentType} · `}
                  {where(r)} · Modified {formatRelativeTime(r.updatedAt)}
                </span>
              </span>
              {already && <span className="board-picker-tag">On this tab</span>}
            </label>
          );
        })}
        {!loading && results.length < total && <button type="button" className="boards-button-secondary board-picker-more" onClick={more}>Show more</button>}
      </div>
      {remaining <= 0 && <p className="boards-dialog-error">This tab is full (150 items).</p>}
      <div className="boards-dialog-actions">
        <button type="button" className="boards-button-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="boards-button-primary" disabled={!chosen.size} onClick={() => onAdd(Array.from(chosen.values()))}>
          {chosen.size ? `Add ${chosen.size} ${chosen.size === 1 ? 'file' : 'files'}` : 'Add files'}
        </button>
      </div>
    </BoardDialog>
  );
};

export default BoardAddFileDialog;

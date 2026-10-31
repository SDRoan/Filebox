import React, { useEffect, useState } from 'react';
import BoardDialog from './BoardDialog';
import { useAuth } from '../context/AuthContext';
import { workspaceBoardsAPI, BoardSavedSearch, BoardTab } from '../services/api';
import { autoTitle } from '../utils/savedSearch';
import { readOpenTab } from '../utils/boardTabs';
import './Boards.css';

/**
 * "Save to board…" on Advanced Search: the filters that produced the results on screen become a saved
 * search on a Boards tab (the same block as Add → Saved search). Only the filters are saved, never results.
 */

const SaveSearchToBoardDialog: React.FC<{ search: BoardSavedSearch; meaning: boolean; onClose: () => void; onSaved: (tab: BoardTab) => void }> = ({ search, meaning, onClose, onSaved }) => {
  const { user } = useAuth();
  const [tabs, setTabs] = useState<BoardTab[] | null>(null);
  const [limits, setLimits] = useState({ blocksPerTab: 150, searchesPerTab: 10 });
  const [tabId, setTabId] = useState('');
  const [title, setTitle] = useState(autoTitle(search));
  const [show, setShow] = useState<3 | 5 | 10>(search.show);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const full = (t: BoardTab) => (t.searchCount || 0) >= limits.searchesPerTab || t.blockCount >= limits.blocksPerTab;

  useEffect(() => {
    workspaceBoardsAPI.list().then(({ tabs: list, limits: l }) => {
      setTabs(list);
      setLimits({ blocksPerTab: l.blocksPerTab, searchesPerTab: l.searchesPerTab || 10 });
      const open = list.find(t => t.id === readOpenTab(user?.id));
      const first = [open, list.find(t => t.isDefault), ...list].find(t => t && (t.searchCount || 0) < (l.searchesPerTab || 10) && t.blockCount < l.blocksPerTab);
      setTabId(first?.id || '');
    }).catch(() => { setTabs([]); setError("Couldn't load your Boards. Try again."); });
  }, [user?.id]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const tab = tabs?.find(t => t.id === tabId);
    if (!tab || full(tab)) { setError('Choose a board tab with room.'); return; }
    setSaving(true);
    setError('');
    try {
      const name = Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 100).join('');
      // A name the same as the automatic one is left out, so it keeps following the filters.
      await workspaceBoardsAPI.addSearch(tab.id, { ...search, title: name === autoTitle(search) ? '' : name, show });
      onSaved(tab);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Couldn't save to the board. Try again.");
      setSaving(false);
    }
  };

  return (
    <BoardDialog title="Save to board" describedBy="save-search-help" wide onClose={onClose}>
      <form onSubmit={save} noValidate className="board-search-form">
        <p id="save-search-help" className="boards-field-help is-left">Saves the filters, not the results. The board finds the files again, with your current access, each time it shows them.</p>
        {meaning && <p className="boards-field-help is-left save-search-meaning">Search by meaning isn't included in saved searches.</p>}
        <label className="boards-field">
          <span>Name</span>
          <input value={title} onChange={e => setTitle(Array.from(e.target.value).slice(0, 100).join(''))} maxLength={102} placeholder={autoTitle(search)} data-autofocus />
        </label>
        <div className="board-search-grid">
          <label className="boards-field"><span>Board tab</span>
            <select value={tabId} onChange={e => setTabId(e.target.value)} disabled={!tabs?.length}>
              {!tabs && <option value="">Loading…</option>}
              {tabs?.length === 0 && <option value="">No board tabs yet</option>}
              {tabs?.map(t => (
                <option key={t.id} value={t.id} disabled={full(t)}>
                  {t.icon ? `${t.icon} ` : ''}{t.name}{(t.searchCount || 0) >= limits.searchesPerTab ? ` (has ${limits.searchesPerTab} saved searches)` : t.blockCount >= limits.blocksPerTab ? ' (full)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="boards-field"><span>Show</span>
            <select value={show} onChange={e => setShow(Number(e.target.value) as 3 | 5 | 10)}>
              {[3, 5, 10].map(n => <option key={n} value={n}>{n} results</option>)}
            </select>
          </label>
        </div>
        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="boards-button-primary" disabled={saving || !tabId}>{saving ? 'Saving…' : 'Save to board'}</button>
        </div>
      </form>
    </BoardDialog>
  );
};

export default SaveSearchToBoardDialog;

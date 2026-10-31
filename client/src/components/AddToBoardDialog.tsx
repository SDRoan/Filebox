import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import BoardDialog from './BoardDialog';
import { useAuth } from '../context/AuthContext';
import { workspaceBoardsAPI, BoardTab } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import { readOpenTab, tabAccent } from '../utils/boardTabs';
import './Boards.css';

/**
 * "Add to board…" from a file or folder menu: choose one of your Boards tabs. The server checks that you
 * can open the item now and places it at the first free spot; the item itself is never moved or copied.
 * Tabs that already hold it, or are full, cannot be chosen.
 */
const AddToBoardDialog: React.FC<{ item: { type: 'file' | 'folder'; id: string; name: string }; onClose: () => void }> = ({ item, onClose }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<BoardTab[] | null>(null);
  const [holding, setHolding] = useState<Set<string>>(new Set());
  const [max, setMax] = useState(150);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<BoardTab | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([workspaceBoardsAPI.list(), workspaceBoardsAPI.placements(item.type === 'file' ? { fileId: item.id } : { folderId: item.id })])
      .then(([list, places]) => {
        if (cancelled) return;
        const on = new Set(places.tabIds);
        const room = list.limits.blocksPerTab;
        const open = (t: BoardTab) => !on.has(t.id) && t.blockCount < room;
        const preferred = [readOpenTab(user?.id), list.tabs.find(t => t.isDefault)?.id].map(id => list.tabs.find(t => t.id === id)).find(t => t && open(t));
        setTabs(list.tabs);
        setHolding(on);
        setMax(room);
        setChosen((preferred || list.tabs.find(open))?.id || '');
      })
      .catch((err) => { if (!cancelled) { setTabs([]); setError(err?.response?.data?.message || 'Boards are not available right now.'); } });
    return () => { cancelled = true; };
  }, [item.type, item.id, user?.id]);

  // Once the tabs are listed, start on the chosen one (arrow keys then move between tabs).
  const listed = Boolean(tabs);
  useEffect(() => {
    if (listed) document.querySelector<HTMLInputElement>('.add-to-board-list input:checked')?.focus();
  }, [listed]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const tab = tabs?.find(t => t.id === chosen);
    if (!tab) return;
    setAdding(true);
    setError('');
    try {
      const result = await workspaceBoardsAPI.addRef(tab.id, item.type, item.id);
      if (!result.added) {
        // Added on another device a moment ago.
        setHolding(prev => new Set(prev).add(tab.id));
        setChosen('');
        setError(`It is already on ${tab.name}.`);
      } else {
        setAdded(result.tab);
      }
    } catch (err: any) {
      setError(err?.response?.data?.message || "Couldn't add it. Try again.");
    } finally {
      setAdding(false);
    }
  };

  // Shown over the whole page, and clicks inside never reach the file or folder card it was opened from.
  const portal = (content: React.ReactNode) => createPortal(
    <div className="add-to-board-layer" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>{content}</div>,
    document.body,
  );

  if (added) {
    return portal(
      <BoardDialog title="Added to board" describedBy="add-to-board-done" onClose={onClose}>
        <p id="add-to-board-done" className="boards-dialog-text" role="status">
          Added “{item.name}” to {added.icon ? `${added.icon} ` : ''}{added.name}. It stays where it is in File Box.
        </p>
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose}>Done</button>
          <button type="button" className="boards-button-primary" data-autofocus onClick={() => { onClose(); navigate(pagePath('boards'), { state: { openTabId: added.id } }); }}>
            Open board
          </button>
        </div>
      </BoardDialog>
    );
  }

  const choosable = (tabs || []).filter(t => !holding.has(t.id) && t.blockCount < max);
  return portal(
    <BoardDialog title={`Add “${item.name}” to a board`} wide onClose={onClose}>
      <form onSubmit={add}>
        {!tabs && <p className="boards-dialog-text" role="status">Loading your boards…</p>}
        {tabs && tabs.length > 0 && (
          <fieldset className="board-tab-fieldset">
            <legend className="boards-visually-hidden">Board tab</legend>
            <div className="board-picker-list add-to-board-list">
              {tabs.map((tab) => {
                const on = holding.has(tab.id);
                const full = !on && tab.blockCount >= max;
                const accent = tabAccent(tab.color);
                return (
                  <label key={tab.id} className={`board-picker-row add-to-board-row ${on || full ? 'is-on-tab' : ''}`} style={accent ? { ['--tab-accent' as any]: accent } : undefined}>
                    <input type="radio" name="add-to-board-tab" value={tab.id} checked={chosen === tab.id} disabled={on || full || adding}
                      onChange={() => { setChosen(tab.id); setError(''); }} aria-describedby={`add-to-board-${tab.id}`} />
                    <span className={`add-to-board-bar ${accent ? 'has-color' : ''}`} aria-hidden="true" />
                    {tab.icon && <span className="add-to-board-icon" aria-hidden="true">{tab.icon}</span>}
                    <span className="board-picker-text">
                      <span className="board-picker-name">{tab.name}{tab.isDefault && <span className="board-picker-meta"> · Default</span>}</span>
                      <span id={`add-to-board-${tab.id}`} className="board-picker-meta">
                        {tab.blockCount} {tab.blockCount === 1 ? 'item' : 'items'}{on ? ' · Already on this board' : full ? ' · This board is full' : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {tabs && tabs.length > 0 && !choosable.length && !error && (
          <p className="boards-dialog-text">It is already on every board that has room.</p>
        )}
        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose} disabled={adding}>Cancel</button>
          <button type="submit" className="boards-button-primary" disabled={!chosen || adding}>{adding ? 'Adding…' : 'Add'}</button>
        </div>
      </form>
    </BoardDialog>
  );
};

export default AddToBoardDialog;

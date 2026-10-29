import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { workspaceBoardsAPI, BoardTab, BoardLimits } from '../services/api';
import ItemActions from './ItemActions';
import { BoardsIcon, PlusIcon } from './Icons';
import './Boards.css';

/**
 * Boards (/boards): a person's own tabbed workspace. Each tab is a board where they will place File Box
 * files and folders (by reference, never moved or copied), sticky notes and text. This first version
 * manages the tabs themselves; the blocks arrive in the next steps.
 *
 * Tabs are saved with the account. Which tab is open is remembered in this browser only, so switching
 * tabs never writes anything to the server.
 */

const lastTabKey = (userId?: string) => `filebox-boards-last-tab-${userId || 'me'}`;
const readLastTab = (userId?: string) => { try { return localStorage.getItem(lastTabKey(userId)) || ''; } catch { return ''; } };
const writeLastTab = (userId: string | undefined, tabId: string) => { try { localStorage.setItem(lastTabKey(userId), tabId); } catch { /* only a convenience */ } };

const errorMessage = (error: any, fallback: string) => error?.response?.data?.message || fallback;

/** A small modal dialog: focus stays inside, Escape closes it, focus goes back where it came from. */
const BoardDialog: React.FC<{ title: string; describedBy?: string; onClose: () => void; children: React.ReactNode }> = ({ title, describedBy, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  // Where focus was before the dialog opened (taken once, before the dialog moves it).
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null) opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const node = ref.current;
    const back = opener.current;
    node?.querySelector<HTMLElement>('[data-autofocus], input, button')?.focus();
    // Back to the opener only once the dialog has really left the page (React may unmount and remount it
    // in development), and not when something else already took focus (a new tab that was just created).
    return () => {
      setTimeout(() => {
        const free = !document.activeElement || document.activeElement === document.body;
        if (!node?.isConnected && free && back?.isConnected) back.focus();
      }, 0);
    };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('input, button:not(:disabled)'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div className="boards-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className="boards-dialog" role="dialog" aria-modal="true" aria-labelledby="boards-dialog-title" aria-describedby={describedBy} onKeyDown={onKeyDown}>
        <h2 id="boards-dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
};

/** Name a new tab, or rename one. */
const TabNameDialog: React.FC<{ mode: 'create' | 'rename'; initial: string; max: number; onSave: (name: string) => Promise<string | null>; onClose: () => void }> = ({ mode, initial, max, onSave, onClose }) => {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Counted in characters as people see them (an emoji is one), the same way the server counts.
  const length = Array.from(name.trim()).length;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError('Give the tab a name.'); return; }
    setSaving(true);
    const problem = await onSave(name);
    if (problem) {
      setError(problem);
      setSaving(false);
      // The field was disabled while saving; put the cursor back so they can fix it or save again.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };
  return (
    <BoardDialog title={mode === 'create' ? 'New tab' : 'Rename tab'} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="boards-field">
          <span>Tab name</span>
          <input ref={inputRef} value={name} maxLength={max + 10} onChange={event => { setName(event.target.value); setError(''); }}
            placeholder="Work, School, Bills, Project A…" aria-invalid={Boolean(error) || length > max} aria-describedby="boards-name-help" disabled={saving} />
        </label>
        <p id="boards-name-help" className={`boards-field-help ${length > max ? 'is-over' : ''}`}>{length}/{max}</p>
        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="boards-button-primary" disabled={saving || !name.trim() || length > max || (mode === 'rename' && name.trim() === initial)}>
            {saving ? 'Saving…' : mode === 'create' ? 'Create tab' : 'Save'}
          </button>
        </div>
      </form>
    </BoardDialog>
  );
};

const Boards: React.FC = () => {
  const { user } = useAuth();
  const [tabs, setTabs] = useState<BoardTab[]>([]);
  const [limits, setLimits] = useState<BoardLimits | null>(null);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [dialog, setDialog] = useState<null | { kind: 'create' } | { kind: 'rename' | 'delete'; tab: BoardTab }>(null);
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
    return found(preferred) || found(readLastTab(user?.id)) || list.find(t => t.isDefault)?.id || list[0]?.id || '';
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    workspaceBoardsAPI.list()
      .then((data) => {
        if (cancelled) return;
        setTabs(data.tabs);
        setLimits(data.limits);
        setActiveId(choose(data.tabs));
        setLoading(false);
      })
      .catch((error) => { if (!cancelled) { setLoadError(errorMessage(error, 'Boards are not available right now.')); setLoading(false); } });
    return () => { cancelled = true; };
  }, [choose]);

  const activate = (id: string) => {
    setActiveId(id);
    writeLastTab(user?.id, id);
  };

  // Tabs pattern: arrow keys move between tabs (and open them), Home/End jump to the first/last.
  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    activate(tabs[target].id);
    tabRefs.current.get(tabs[target].id)?.focus();
  };

  const createTab = async (name: string) => {
    try {
      const { tab } = await workspaceBoardsAPI.createTab({ name });
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

  const renameTab = async (tab: BoardTab, name: string) => {
    try {
      const { tab: saved } = await workspaceBoardsAPI.updateTab(tab.id, { name, rev: tab.rev });
      setTabs(prev => prev.map(t => (t.id === saved.id ? saved : t)));
      setDialog(null);
      setAnnouncement(`Renamed to ${saved.name}.`);
      return null;
    } catch (error: any) {
      // Changed on another device: show what is saved now, and let them try again from there.
      if (error?.response?.status === 409 && error.response.data?.tab) {
        const latest: BoardTab = error.response.data.tab;
        setTabs(prev => prev.map(t => (t.id === latest.id ? latest : t)));
        setDialog({ kind: 'rename', tab: latest });
        setAnnouncement('This tab was changed somewhere else. Showing the latest version.');
        return 'This tab was changed somewhere else. Its latest name is shown; try again.';
      }
      if (error?.response?.status === 404) {
        setTabs(prev => prev.filter(t => t.id !== tab.id));
        setDialog(null);
        return null;
      }
      return errorMessage(error, "Couldn't rename the tab. Try again.");
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

  const active = tabs.find(t => t.id === activeId);
  const atLimit = Boolean(limits && tabs.length >= limits.tabs);

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
      <header className="boards-head">
        <h1 id="boards-title">Boards</h1>
        <p>Your own spaces for files, folders and notes. Placing something on a board never moves it.</p>
      </header>

      <div className="boards-tabbar">
        <div className="boards-tabs" role="tablist" aria-label="Board tabs">
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
              className={`boards-tab ${tab.id === activeId ? 'is-active' : ''}`}
              onClick={() => activate(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab.icon && <span className="boards-tab-icon" aria-hidden="true">{tab.icon}</span>}
              <span className="boards-tab-name">{tab.name}</span>
              {tab.isDefault && <span className="boards-visually-hidden"> (default)</span>}
            </button>
          ))}
        </div>
        <button type="button" className="boards-add-tab" onClick={() => setDialog({ kind: 'create' })} disabled={atLimit}
          aria-label="New tab" title={atLimit ? `You can have up to ${limits?.tabs} tabs` : 'New tab'}>
          <PlusIcon size={16} />
        </button>
      </div>

      {active && (
        <div className="boards-panel" role="tabpanel" id={`board-panel-${active.id}`} aria-labelledby={`board-tab-${active.id}`} tabIndex={0}>
          <div className="boards-panel-head">
            <h2>{active.icon && <span aria-hidden="true">{active.icon} </span>}{active.name}</h2>
            <ItemActions className="boards-tab-menu" label={`Options for tab ${active.name}`}>
              <button type="button" onClick={() => setDialog({ kind: 'rename', tab: active })}>Rename…</button>
              <button type="button" className="is-danger" onClick={() => { setDeleteError(''); setDialog({ kind: 'delete', tab: active }); }}>Delete tab…</button>
            </ItemActions>
          </div>

          {active.blockCount === 0 && (
            <div className="boards-empty">
              <span className="boards-empty-icon" aria-hidden="true"><BoardsIcon size={30} /></span>
              <p className="boards-empty-title">This tab is empty.</p>
              <p>Build this space your way.</p>
              <div className="boards-empty-actions">
                {['Add file', 'Add folder', 'Add sticky note', 'Add text area'].map(label => (
                  <button type="button" key={label} className="boards-coming" aria-disabled="true" aria-describedby="boards-coming-note"
                    onClick={() => setAnnouncement(`${label}: coming in the next update.`)}>
                    {label}
                  </button>
                ))}
              </div>
              <p id="boards-coming-note" className="boards-coming-note">Adding files, folders, notes and text comes in the next update.</p>
            </div>
          )}
        </div>
      )}

      <p className="boards-visually-hidden" role="status" aria-live="polite">{announcement}</p>

      {dialog?.kind === 'create' && limits && (
        <TabNameDialog mode="create" initial="" max={limits.tabName} onSave={createTab} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'rename' && limits && (
        <TabNameDialog key={dialog.tab.id} mode="rename" initial={dialog.tab.name} max={limits.tabName}
          onSave={(name) => renameTab(dialog.tab, name)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <BoardDialog title={`Delete “${dialog.tab.name}”?`} describedBy="boards-delete-text" onClose={() => !deleting && setDialog(null)}>
          <p id="boards-delete-text" className="boards-dialog-text">
            This removes the tab and everything placed on it. Files and folders stay exactly where they are in File Box.
            {tabs.length === 1 && ' It is your only tab, so a new empty tab will take its place.'}
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

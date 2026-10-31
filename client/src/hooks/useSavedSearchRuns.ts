import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceBoardsAPI, BoardBlock, SavedSearchRow } from '../services/api';
import { clearFingerprint, fingerprintOf, hashOf, readFingerprint, writeFingerprint } from '../utils/savedSearch';

/**
 * When a tab's saved searches run, and what they found (kept in this page's memory only, never stored).
 *
 * A saved search runs when its tab opens, when Refresh is pressed, when the page comes back after more than
 * 5 minutes away, and after its edited filters are saved. Only blocks on screen run, at most two at a time,
 * always with the filters stored on the server (an unsaved edit waits for its save). Nothing runs on a timer,
 * and nothing runs while something on the board is being dragged or resized, or while a board dialog or
 * text editor is open: a run that comes due then is held and starts as soon as that ends.
 *
 * "New" marks a shown file that was not among those shown last time in this browser (kept as hashes and a
 * total, never ids or names). The first run marks nothing new.
 */

export interface SearchRunState {
  status: 'loading' | 'ok' | 'unavailable' | 'error';
  total?: number;
  results?: SavedSearchRow[];
  scopeName?: string;
  fresh?: Set<string>;
}
export interface SavedSearchRuns {
  state: (id: string) => SearchRunState | undefined;
  observe: (id: string, element: HTMLElement | null) => void;
  refresh: (id: string) => void;
}

const MAX_RUNNING = 2;
const AWAY = 5 * 60 * 1000;
// Something on the board is being moved or sized, a board dialog or preview is open.
const BUSY = '.board-item.dragging, .board-zone.dragging, .boards-dialog, .file-preview-overlay';

export function useSavedSearchRuns({ tabId, blocks, storedKey, editing }: {
  tabId?: string;
  blocks: BoardBlock[];
  // The saved search's filters as stored on the server (null: not saved yet).
  storedKey: (id: string) => string | null;
  editing: boolean;
}): SavedSearchRuns {
  const [runs, setRuns] = useState<Map<string, SearchRunState>>(new Map());
  const due = useRef(new Set<string>());
  const ranKey = useRef(new Map<string, string>());
  const visible = useRef(new Set<string>());
  const running = useRef(0);
  const generation = useRef(0);
  const pointerDown = useRef(false);
  const held = useRef<(() => void) | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const live = useRef({ tabId, blocks, storedKey, editing });
  live.current = { tabId, blocks, storedKey, editing };

  const setRun = (id: string, state: SearchRunState) => setRuns(prev => new Map(prev).set(id, state));
  const busy = () => live.current.editing || pointerDown.current || Boolean(document.querySelector(BUSY));

  const pump = useCallback(() => {
    const { tabId: tab, blocks: list, storedKey: keyOf } = live.current;
    if (!tab) return;
    while (running.current < MAX_RUNNING) {
      // A block on screen, saved as it is shown (its edit has reached the server).
      const id = Array.from(due.current).find((d) => {
        const block = list.find(b => b.id === d);
        return block?.type === 'search' && visible.current.has(d) && keyOf(d) === JSON.stringify(block.search);
      });
      if (!id) return;
      if (busy()) {
        // Held: try again when the pointer is let go, focus moves, or the dialog or preview leaves the page.
        // Only while held; no timer.
        if (!held.current) {
          const watcher = new MutationObserver(() => { if (!busy()) again(); });
          const again = () => {
            document.removeEventListener('pointerup', again, true);
            document.removeEventListener('focusin', again, true);
            watcher.disconnect();
            held.current = null;
            setTimeout(pump, 0);
          };
          held.current = again;
          document.addEventListener('pointerup', again, true);
          document.addEventListener('focusin', again, true);
          watcher.observe(document.body, { childList: true, subtree: true });
        }
        return;
      }
      due.current.delete(id);
      // These filters count as run from now on (a run already under way is not started twice).
      ranKey.current.set(id, keyOf(id) as string);
      const gen = generation.current;
      running.current += 1;
      setRuns(prev => new Map(prev).set(id, { ...(prev.get(id) || {}), status: 'loading' }));
      workspaceBoardsAPI.runSearches(tab, [id]).then(({ searches }) => {
        if (gen !== generation.current) return;
        const r = searches[0];
        if (!r || r.state === 'error') { setRuns(prev => new Map(prev).set(id, { ...(prev.get(id) || {}), status: 'error' })); return; }
        if (r.state !== 'ok') {
          // No count, no old results, no old name, and nothing remembered about it.
          clearFingerprint(id);
          setRun(id, { status: 'unavailable' });
          return;
        }
        const before = readFingerprint(id);
        const fresh = new Set(before ? r.results.filter(x => !before.h.includes(hashOf(x._id))).map(x => x._id) : []);
        writeFingerprint(id, fingerprintOf(r.results.map(x => x._id), r.total));
        setRun(id, { status: 'ok', total: r.total, results: r.results, scopeName: r.scopeName, fresh });
      }).catch(() => {
        if (gen === generation.current) setRuns(prev => new Map(prev).set(id, { ...(prev.get(id) || {}), status: 'error' }));
      }).finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }, []);

  // A tab opens: everything it found before is forgotten and its saved searches run (as they come on screen).
  const openTab = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (openTab.current === tabId) return;
    openTab.current = tabId;
    generation.current += 1;
    // Runs still under way for the previous tab keep their slots until they answer (their answers are ignored).
    due.current = new Set();
    ranKey.current = new Map();
    setRuns(new Map());
  }, [tabId]);

  // New saved searches, and ones whose saved filters changed, are due.
  useEffect(() => {
    blocks.forEach((b) => {
      if (b.type !== 'search') return;
      const stored = storedKey(b.id);
      if (stored && ranKey.current.get(b.id) !== stored) due.current.add(b.id);
    });
    pump();
  });

  // Editing a text area holds runs; when it ends, held ones start.
  useEffect(() => { if (!editing) pump(); }, [editing, pump]);

  // Moving or sizing anything on the board holds runs until the pointer is let go.
  useEffect(() => {
    const down = (e: PointerEvent) => { if ((e.target as HTMLElement | null)?.closest?.('.file-board-canvas')) pointerDown.current = true; };
    const up = () => { if (pointerDown.current) { pointerDown.current = false; setTimeout(pump, 0); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true); };
  }, [pump]);

  // Back after more than 5 minutes away: run again.
  useEffect(() => {
    let hiddenAt = 0;
    const change = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > AWAY) {
        live.current.blocks.forEach(b => { if (b.type === 'search') due.current.add(b.id); });
        pump();
      }
      hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, [pump]);

  useEffect(() => {
    observer.current = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const id = (entry.target as HTMLElement).dataset.searchId || '';
        if (entry.isIntersecting) visible.current.add(id); else visible.current.delete(id);
      });
      pump();
    });
    elements.current.forEach(el => observer.current?.observe(el));
    return () => observer.current?.disconnect();
  }, [pump]);

  const observe = useCallback((id: string, element: HTMLElement | null) => {
    const old = elements.current.get(id);
    if (old === element) return;
    if (old) { observer.current?.unobserve(old); elements.current.delete(id); visible.current.delete(id); }
    if (element) { element.dataset.searchId = id; elements.current.set(id, element); observer.current?.observe(element); }
  }, []);

  const refresh = useCallback((id: string) => { due.current.add(id); pump(); }, [pump]);
  const state = useCallback((id: string) => runs.get(id), [runs]);
  return { state, observe, refresh };
}

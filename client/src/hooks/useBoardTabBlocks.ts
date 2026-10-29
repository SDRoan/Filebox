import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceBoardsAPI, AdvancedSearchResult, BoardBlock, BoardBlockInput, BoardNote, BoardTab, BoardText } from '../services/api';
import { SIZES, firstFit, place } from '../utils/boardGrid';

/**
 * The blocks of one Boards tab and how changes reach the account.
 *
 * Every change (add, remove, move, resize, edit) waits as an action until it is sent. Saves go out after a
 * drag or resize ends, after a short pause in keyboard moves, 1 second after typing stops (or at once when a
 * note or text area loses focus), when the tab is switched, and after the Undo window of a removal. Saves run
 * one at a time and each takes only the changes not already sent, so nothing is sent twice. A save carries
 * a note's or text area's words only if they changed; the server keeps the stored ones otherwise.
 *
 * If another device saved the tab first (409), the latest version is loaded, this person's changes are
 * replayed on top of it and the save is tried once more. A second conflict stops there, with a message.
 * When the page is hidden or closed, anything unsent goes out as a best-effort keepalive request.
 */

export type BoardChange =
  | { kind: 'add'; blocks: Array<BoardBlock & { refId?: string }> }
  | { kind: 'remove'; id: string }
  | { kind: 'move' | 'resize'; id: string; x: number; y: number; w: number; h: number }
  | { kind: 'edit'; id: string; note?: BoardNote; text?: BoardText };

export interface BoardNotice { text: string; tone?: 'info' | 'error'; undo?: () => void; removedId?: string }

const KEYS_DELAY = 600;
const TYPING_DELAY = 1000;
// Typing without a pause still saves at least this often.
const TYPING_MAX_WAIT = 4000;
const UNDO_WINDOW = 5000;
const EMPTY_DOC: BoardText = { doc: { type: 'doc', content: [{ type: 'paragraph' }] } };
const newBlockId = () => {
  let id = '';
  while (id.length < 10) id += Math.random().toString(36).slice(2);
  return id.slice(0, 10);
};
const refIdOf = (b: BoardBlock) => (b.type === 'file' || b.type === 'folder' ? (b.ref.available ? (b.type === 'file' ? b.ref.fileId : b.ref.folderId) : undefined) : undefined);

/** One action applied to a layout (used both live and when replaying onto a newer version). */
function apply(blocks: BoardBlock[], change: BoardChange): BoardBlock[] {
  if (change.kind === 'remove') return blocks.filter(b => b.id !== change.id);
  if (change.kind === 'edit') {
    return blocks.map((b) => {
      if (b.id !== change.id) return b;
      if (b.type === 'note' && change.note) return { ...b, note: change.note };
      if (b.type === 'text' && change.text) return { ...b, text: change.text };
      return b;
    });
  }
  if (change.kind === 'add') {
    let next = blocks;
    for (const added of change.blocks) {
      if (next.some(b => b.id === added.id)) continue;
      if (added.refId && next.some(b => b.type === added.type && refIdOf(b) === added.refId)) continue;
      const spot = firstFit(next, added.w, added.h);
      next = [...next, { ...added, x: spot.x, y: spot.y } as BoardBlock];
    }
    return next;
  }
  const target = blocks.find(b => b.id === change.id);
  return target ? place(blocks, { ...target, x: change.x, y: change.y, w: change.w, h: change.h }) : blocks;
}

interface Pending { actions: BoardChange[]; newRefs: Map<string, { type: 'file' | 'folder'; refId: string }>; dirty: Set<string> }
interface Snapshot extends Pending { tabId: string; blocks: BoardBlock[]; serverIds: Set<string> }
const emptyPending = (): Pending => ({ actions: [], newRefs: new Map(), dirty: new Set() });

/** What a save sends: positions for all blocks, ids for new references, words only for new or edited notes/text. */
function payloadOf(snap: Snapshot): BoardBlockInput[] {
  return snap.blocks.map((b) => {
    const base: BoardBlockInput = { id: b.id, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h };
    const added = snap.newRefs.get(b.id);
    if (added) return { ...base, ...(added.type === 'file' ? { fileId: added.refId } : { folderId: added.refId }) };
    const sendWords = !snap.serverIds.has(b.id) || snap.dirty.has(b.id);
    if (b.type === 'note' && sendWords) return { ...base, note: b.note };
    if (b.type === 'text' && sendWords) return { ...base, text: b.text };
    return base;
  });
}

export function useBoardTabBlocks({ tab, onTab, onNotice }: { tab?: BoardTab; onTab: (tab: BoardTab) => void; onNotice: (notice: BoardNotice | null) => void }) {
  const [blocks, setBlocksState] = useState<BoardBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingRefs, setPendingRefs] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<'idle' | 'waiting' | 'saving' | 'saved' | 'failed'>('idle');

  const tabRef = useRef<BoardTab | undefined>(tab);
  const revs = useRef(new Map<string, number>());
  const blocksRef = useRef<BoardBlock[]>([]);
  const serverBlocks = useRef<BoardBlock[]>([]);
  const pending = useRef<Pending>(emptyPending());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const due = useRef(0);
  // The planned save is only waiting for typing to pause (each key pushes it back), since this time.
  const dueTyping = useRef(false);
  const typingSince = useRef(0);
  const removedUnavailable = useRef(new Set<string>());
  const inFlight = useRef(0);

  const setBlocks = (next: BoardBlock[]) => { blocksRef.current = next; setBlocksState(next); };
  const syncPending = () => setPendingRefs(new Set(pending.current.newRefs.keys()));

  /** Take everything not yet sent for the open tab (so a later save cannot send it again). */
  const takeSnapshot = (): Snapshot | null => {
    const current = tabRef.current;
    if (!current || !pending.current.actions.length) return null;
    const snap: Snapshot = { tabId: current.id, blocks: blocksRef.current, serverIds: new Set(serverBlocks.current.map(b => b.id)), ...pending.current };
    pending.current = emptyPending();
    return snap;
  };

  const send = useCallback(async (snap: Snapshot, retried = false): Promise<void> => {
    const isOpen = () => tabRef.current?.id === snap.tabId;
    const rev = revs.current.get(snap.tabId) ?? 0;
    inFlight.current += 1;
    if (isOpen()) setSaveState('saving');
    try {
      const result = await workspaceBoardsAPI.saveBlocks(snap.tabId, rev, payloadOf(snap));
      revs.current.set(snap.tabId, result.tab.rev);
      onTab(result.tab);
      if (isOpen()) {
        serverBlocks.current = result.blocks;
        snap.newRefs.forEach((_, id) => pending.current.newRefs.delete(id));
        syncPending();
        // Changes made while this was saving stay on screen; the server's view fills in names and counts.
        if (!pending.current.actions.length) setBlocks(result.blocks);
        else {
          const fresh = new Map(result.blocks.map(b => [b.id, b]));
          setBlocks(blocksRef.current.map((b) => {
            const f = fresh.get(b.id);
            return f && (b.type === 'file' || b.type === 'folder') && (f.type === 'file' || f.type === 'folder') ? { ...b, ref: f.ref } : b;
          }));
        }
        setSaveState(pending.current.actions.length ? 'waiting' : 'saved');
        if (retried) {
          const edited = snap.actions.some(a => a.kind === 'edit');
          onNotice({ text: `This board was changed on another device. ${edited ? 'Your latest text was kept and' : 'Your changes were'} added to the latest version.` });
        }
        removedUnavailable.current.clear();
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      if (status === 409 && data?.tab && data?.blocks) {
        revs.current.set(snap.tabId, data.tab.rev);
        onTab(data.tab);
        if (!retried) {
          // First conflict: replay this person's changes on the latest version, then try once more.
          const replayed = snap.actions.reduce(apply, data.blocks as BoardBlock[]);
          if (isOpen()) {
            serverBlocks.current = data.blocks;
            setBlocks(pending.current.actions.reduce(apply, replayed));
          }
          await send({ ...snap, blocks: replayed, serverIds: new Set((data.blocks as BoardBlock[]).map(b => b.id)) }, true);
          return;
        }
        // Second conflict: stop. Show the latest version and say what was not kept.
        const edited = snap.actions.some(a => a.kind === 'edit');
        if (isOpen()) {
          pending.current = emptyPending();
          syncPending();
          serverBlocks.current = data.blocks;
          setBlocks(data.blocks);
          setSaveState('failed');
        }
        onNotice({ tone: 'error', text: `This board keeps changing on another device, so ${edited ? 'your latest text was not kept' : 'your last changes were not kept'}. Showing the latest version.` });
      } else if (isOpen()) {
        // Refused (not available, too large, …) or no connection: back to what is saved.
        pending.current = emptyPending();
        syncPending();
        setBlocks(serverBlocks.current);
        setSaveState('failed');
        onNotice({ tone: 'error', text: data?.message || "Couldn't save the board. Your last change was undone." });
      }
    } finally {
      inFlight.current -= 1;
    }
  }, [onTab, onNotice]);

  const cancelTimer = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    dueTyping.current = false;
    typingSince.current = 0;
  };

  /** Send what is waiting for the open tab now (one save at a time, in order). */
  const save = useCallback(() => {
    cancelTimer();
    queue.current = queue.current.then(async () => {
      const snap = takeSnapshot();
      if (snap) await send(snap);
    });
    return queue.current;
  }, [send]);

  const schedule = useCallback((delay: number, typing = false) => {
    setSaveState('waiting');
    const now = Date.now();
    if (typing && !typingSince.current) typingSince.current = now;
    const at = typing ? Math.min(now + delay, typingSince.current + TYPING_MAX_WAIT) : now + delay;
    // An earlier planned save stays, unless it was only waiting for typing to pause (then typing pushes it back).
    if (timer.current && due.current <= at && !(typing && dueTyping.current)) return;
    if (timer.current) clearTimeout(timer.current);
    due.current = at;
    dueTyping.current = typing;
    timer.current = setTimeout(() => { timer.current = null; save(); }, Math.max(0, at - now));
  }, [save]);

  useEffect(() => { tabRef.current = tab; });

  // Switching tabs: the old tab's unsent changes go out (for that tab), then the new tab loads.
  const tabId = tab?.id;
  useEffect(() => {
    if (!tabId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setBlocks([]);
    setSaveState('idle');
    workspaceBoardsAPI.getTab(tabId)
      .then((data) => {
        if (cancelled) return;
        tabRef.current = data.tab;
        revs.current.set(data.tab.id, data.tab.rev);
        onTab(data.tab);
        serverBlocks.current = data.blocks;
        setBlocks(data.blocks);
        setLoading(false);
      })
      .catch((err) => { if (!cancelled) { setError(err?.response?.data?.message || "Couldn't open this tab."); setLoading(false); } });
    return () => {
      cancelled = true;
      cancelTimer();
      const snap = takeSnapshot();
      if (snap) queue.current = queue.current.then(() => send(snap));
      pending.current = emptyPending();
    };
    // onTab is stable for the page; loading depends on the tab only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // The page is being hidden or closed: a best-effort keepalive save of anything unsent (nothing if all saved).
  useEffect(() => {
    const leave = () => {
      if (document.visibilityState !== 'hidden' && !document.hidden) return;
      if (!pending.current.actions.length) return;
      cancelTimer();
      const snap = takeSnapshot();
      if (!snap) return;
      const rev = revs.current.get(snap.tabId) ?? 0;
      // While another save is still running its revision would be stale; then the normal queue sends it.
      if (inFlight.current || !workspaceBoardsAPI.saveBlocksOnLeave(snap.tabId, rev, payloadOf(snap))) {
        queue.current = queue.current.then(() => send(snap));
        return;
      }
      // If the page stays alive (only hidden), its view is refreshed from the server once it is visible again.
      revs.current.set(snap.tabId, rev);
      queue.current = queue.current.then(async () => {
        await new Promise(r => setTimeout(r, 400));
        try {
          const latest = await workspaceBoardsAPI.getTab(snap.tabId);
          revs.current.set(snap.tabId, latest.tab.rev);
          onTab(latest.tab);
          if (tabRef.current?.id === snap.tabId && !pending.current.actions.length) { serverBlocks.current = latest.blocks; setBlocks(latest.blocks); setSaveState('saved'); }
        } catch { /* offline or closed: nothing more to do */ }
      });
    };
    document.addEventListener('visibilitychange', leave);
    window.addEventListener('pagehide', leave);
    return () => { document.removeEventListener('visibilitychange', leave); window.removeEventListener('pagehide', leave); };
  }, [send, onTab]);

  // Leaving the Boards page inside File Box: send anything still waiting.
  useEffect(() => () => { save(); }, [save]);

  const change = useCallback((next: BoardBlock[], action: BoardChange, options: { debounce?: boolean } = {}) => {
    setBlocks(next);
    pending.current.actions.push(action);
    schedule(options.debounce ? KEYS_DELAY : 0);
  }, [schedule]);

  /** A note's or text area's words changed: shown at once, saved 1 second after typing pauses (at least every 4). */
  const edit = useCallback((id: string, content: { note?: BoardNote; text?: BoardText }) => {
    const action: BoardChange = { kind: 'edit', id, ...content };
    setBlocks(apply(blocksRef.current, action));
    const list = pending.current.actions;
    const last = list[list.length - 1];
    // Consecutive edits of one block replace each other (only the latest words need saving).
    if (last && last.kind === 'edit' && last.id === id) list[list.length - 1] = action;
    else list.push(action);
    pending.current.dirty.add(id);
    schedule(TYPING_DELAY, true);
  }, [schedule]);

  /** Save now if anything is waiting (a note or text area lost focus). */
  const flush = useCallback(() => { if (pending.current.actions.length) save(); }, [save]);

  const addFiles = useCallback((files: AdvancedSearchResult[]) => {
    const onBoard = new Set(blocksRef.current.filter(b => b.type === 'file').map(refIdOf));
    const added: Array<BoardBlock & { refId?: string }> = [];
    let next = blocksRef.current;
    for (const f of files) {
      if (onBoard.has(f._id)) continue;
      onBoard.add(f._id);
      const { w, h } = SIZES.file;
      const spot = firstFit(next, w, h);
      const block: BoardBlock & { refId?: string } = {
        id: newBlockId(), type: 'file', x: spot.x, y: spot.y, w, h, refId: f._id,
        ref: { available: true, fileId: f._id, name: f.originalName, mimeType: f.mimeType, size: f.size, technicalType: f.technicalType, updatedAt: f.updatedAt,
          source: f.access.source, role: f.access.role, category: f.classification?.primaryCategory, documentType: f.classification?.documentType, ownerName: f.ownerName, teamName: f.access.teamName },
      };
      pending.current.newRefs.set(block.id, { type: 'file', refId: f._id });
      added.push(block);
      next = [...next, block];
    }
    if (!added.length) return 0;
    syncPending();
    change(next, { kind: 'add', blocks: added });
    return added.length;
  }, [change]);

  const addFolder = useCallback((folderId: string) => {
    if (blocksRef.current.some(b => b.type === 'folder' && refIdOf(b) === folderId)) return false;
    const { w, h } = SIZES.folder;
    const spot = firstFit(blocksRef.current, w, h);
    const block: BoardBlock & { refId?: string } = {
      id: newBlockId(), type: 'folder', x: spot.x, y: spot.y, w, h, refId: folderId,
      ref: { available: true, folderId, name: 'Folder', source: 'owned' },
    };
    pending.current.newRefs.set(block.id, { type: 'folder', refId: folderId });
    syncPending();
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] });
    return true;
  }, [change]);

  /** A new sticky note or text area at the first free spot. Returns its id (so it can be focused). */
  const addNote = useCallback(() => {
    const { w, h } = SIZES.note;
    const spot = firstFit(blocksRef.current, w, h);
    const block: BoardBlock = { id: newBlockId(), type: 'note', x: spot.x, y: spot.y, w, h, note: { title: '', body: '', color: 'yellow' } };
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] });
    return block.id;
  }, [change]);

  const addText = useCallback(() => {
    const { w, h } = SIZES.text;
    const spot = firstFit(blocksRef.current, w, h);
    const block: BoardBlock = { id: newBlockId(), type: 'text', x: spot.x, y: spot.y, w, h, text: EMPTY_DOC };
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] });
    return block.id;
  }, [change]);

  /** Take a block off the board (never touches a file or folder). Undo puts the block back. */
  const remove = useCallback((block: BoardBlock) => {
    const before = blocksRef.current.find(b => b.id === block.id);
    if (!before) return;
    const unavailable = (before.type === 'file' || before.type === 'folder') && !before.ref.available;
    if (unavailable) removedUnavailable.current.add(block.id);
    pending.current.newRefs.delete(block.id);
    syncPending();
    setBlocks(blocksRef.current.filter(b => b.id !== block.id));
    pending.current.actions.push({ kind: 'remove', id: block.id });
    schedule(UNDO_WINDOW);
    const name = before.type === 'note' ? 'The note' : before.type === 'text' ? 'The text area' : before.ref.available ? `“${before.ref.name}”` : 'The unavailable item';
    const where = before.type === 'note' || before.type === 'text' ? '' : ' It is still in File Box.';
    onNotice({
      text: `${name} was removed from this board.${where}`,
      removedId: block.id,
      undo: () => {
        // An unavailable item can only come back before its removal was saved.
        if (unavailable && !removedUnavailable.current.has(block.id)) {
          onNotice({ tone: 'error', text: 'That item can no longer be put back: it is not available to you.' });
          return;
        }
        if (blocksRef.current.some(b => b.id === block.id)) return;
        const refId = refIdOf(before);
        if (refId && (before.type === 'file' || before.type === 'folder') && !serverBlocks.current.some(b => b.id === block.id)) {
          pending.current.newRefs.set(block.id, { type: before.type, refId });
        }
        syncPending();
        setBlocks(place([...blocksRef.current, before], before));
        pending.current.actions.push({ kind: 'add', blocks: [{ ...before, refId }] });
        schedule(0);
        onNotice({ text: `${name} is back on this board.` });
      },
    });
  }, [schedule, onNotice]);

  return { blocks, loading, error, pending: pendingRefs, saveState, change, edit, flush, addFiles, addFolder, addNote, addText, remove };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceBoardsAPI, AdvancedSearchResult, BoardBlock, BoardBlockInput, BoardContent, BoardFileList, BoardRef, BoardTab, BoardText, BoardZone } from '../services/api';
import { BLOCK_SIZES, CONTENT_TYPES, ContentType, Spot } from '../utils/boardLayout';

/**
 * The blocks and zones of one Boards tab and how changes reach the account.
 *
 * Every change (add, remove, a new arrangement on the canvas, edit) waits as an action until it is sent.
 * Saves go out after a drag or resize ends, after a short pause in keyboard moves, 1 second after typing stops (or at once when a
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
  // Places (and sizes) on the free canvas, and the tab's zones when they changed. null = not placed yet.
  | { kind: 'layout'; items: Record<string, Spot | null>; zones?: BoardZone[] }
  // A block's content changed (a note, text area, checklist, label or deadline): its field named after its type.
  | ({ kind: 'edit'; id: string } & BoardContent);

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
/** What a file found in the picker shows until the server's own view of it arrives (after the save). */
export const searchRef = (f: AdvancedSearchResult): BoardRef => ({
  available: true, fileId: f._id, name: f.originalName, mimeType: f.mimeType, size: f.size, technicalType: f.technicalType, updatedAt: f.updatedAt, createdAt: f.updatedAt,
  source: f.access.source, role: f.access.role, category: f.classification?.primaryCategory, documentType: f.classification?.documentType, ownerName: f.ownerName, teamName: f.access.teamName,
});
/** A file list as a save sends it: saved rows by their id only, new rows with the file they point at. */
const listPayload = (list: BoardFileList) => ({ title: list.title, items: list.items.map(r => (r.fileId ? { id: r.id, fileId: r.fileId } : { id: r.id })) });
const refIdOf = (b: BoardBlock) => (b.type === 'file' || b.type === 'folder' ? (b.ref.available ? (b.type === 'file' ? b.ref.fileId : b.ref.folderId) : undefined) : undefined);

/** One action applied to a layout (used both live and when replaying onto a newer version). */
function apply(blocks: BoardBlock[], change: BoardChange): BoardBlock[] {
  if (change.kind === 'remove') return blocks.filter(b => b.id !== change.id);
  if (change.kind === 'edit') {
    return blocks.map((b) => {
      if (b.id !== change.id) return b;
      const value = (change as BoardContent)[b.type as ContentType];
      return value ? ({ ...b, [b.type]: value } as BoardBlock) : b;
    });
  }
  if (change.kind === 'add') {
    let next = blocks;
    for (const added of change.blocks) {
      if (next.some(b => b.id === added.id)) continue;
      if (added.refId && next.some(b => b.type === added.type && refIdOf(b) === added.refId)) continue;
      next = [...next, added as BoardBlock];
    }
    return next;
  }
  return blocks.map((b) => {
    if (!(b.id in change.items)) return b;
    const spot = change.items[b.id];
    if (!spot) return { ...b, x: null, y: null };
    return { ...b, x: spot.x, y: spot.y, ...(spot.w !== undefined && spot.h !== undefined ? { w: spot.w, h: spot.h } : {}) };
  });
}
const applyZones = (zones: BoardZone[], change: BoardChange) => (change.kind === 'layout' && change.zones ? change.zones : zones);

interface Pending { actions: BoardChange[]; newRefs: Map<string, { type: 'file' | 'folder'; refId: string }>; dirty: Set<string> }
interface Snapshot extends Pending { tabId: string; blocks: BoardBlock[]; zones: BoardZone[]; serverIds: Set<string> }
const emptyPending = (): Pending => ({ actions: [], newRefs: new Map(), dirty: new Set() });

/** What a save sends: positions for all blocks, ids for new references, words only for new or edited notes/text. */
function payloadOf(snap: Snapshot): BoardBlockInput[] {
  return snap.blocks.map((b) => {
    const base: BoardBlockInput = { id: b.id, type: b.type, x: b.x, y: b.y, ...(b.w !== undefined && b.h !== undefined ? { w: b.w, h: b.h } : {}) };
    const added = snap.newRefs.get(b.id);
    if (added) return { ...base, ...(added.type === 'file' ? { fileId: added.refId } : { folderId: added.refId }) };
    const sendWords = !snap.serverIds.has(b.id) || snap.dirty.has(b.id);
    if (b.type === 'filelist' && sendWords) return { ...base, filelist: listPayload(b.filelist) };
    if ((CONTENT_TYPES as readonly string[]).includes(b.type) && sendWords) return { ...base, [b.type]: (b as unknown as Record<string, unknown>)[b.type] } as BoardBlockInput;
    return base;
  });
}

export function useBoardTabBlocks({ tab, onTab, onNotice }: { tab?: BoardTab; onTab: (tab: BoardTab) => void; onNotice: (notice: BoardNotice | null) => void }) {
  const [blocks, setBlocksState] = useState<BoardBlock[]>([]);
  const [zones, setZonesState] = useState<BoardZone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingRefs, setPendingRefs] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<'idle' | 'waiting' | 'saving' | 'saved' | 'failed'>('idle');

  const tabRef = useRef<BoardTab | undefined>(tab);
  const revs = useRef(new Map<string, number>());
  const blocksRef = useRef<BoardBlock[]>([]);
  const serverBlocks = useRef<BoardBlock[]>([]);
  const zonesRef = useRef<BoardZone[]>([]);
  const serverZones = useRef<BoardZone[]>([]);
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
  const setZones = (next: BoardZone[]) => { zonesRef.current = next; setZonesState(next); };
  const syncPending = () => setPendingRefs(new Set(pending.current.newRefs.keys()));

  /** Take everything not yet sent for the open tab (so a later save cannot send it again). */
  const takeSnapshot = (): Snapshot | null => {
    const current = tabRef.current;
    if (!current || !pending.current.actions.length) return null;
    const snap: Snapshot = { tabId: current.id, blocks: blocksRef.current, zones: zonesRef.current, serverIds: new Set(serverBlocks.current.map(b => b.id)), ...pending.current };
    pending.current = emptyPending();
    return snap;
  };

  const send = useCallback(async (snap: Snapshot, retried = false): Promise<void> => {
    const isOpen = () => tabRef.current?.id === snap.tabId;
    const rev = revs.current.get(snap.tabId) ?? 0;
    inFlight.current += 1;
    if (isOpen()) setSaveState('saving');
    try {
      const result = await workspaceBoardsAPI.saveBlocks(snap.tabId, rev, payloadOf(snap), snap.zones);
      revs.current.set(snap.tabId, result.tab.rev);
      onTab(result.tab);
      if (isOpen()) {
        serverBlocks.current = result.blocks;
        serverZones.current = result.zones;
        snap.newRefs.forEach((_, id) => pending.current.newRefs.delete(id));
        syncPending();
        // Changes made while this was saving stay on screen; the server's view fills in names and counts.
        if (!pending.current.actions.length) { setBlocks(result.blocks); setZones(result.zones); }
        else {
          const fresh = new Map(result.blocks.map(b => [b.id, b]));
          setBlocks(blocksRef.current.map((b) => {
            const f = fresh.get(b.id);
            // A file list's saved rows take the server's view of their file (and are no longer new).
            if (f && b.type === 'filelist' && f.type === 'filelist') {
              const rows = new Map(f.filelist.items.map(r => [r.id, r]));
              return { ...b, filelist: { ...b.filelist, items: b.filelist.items.map(r => rows.get(r.id) || r) } };
            }
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
          const replayedZones = snap.actions.reduce(applyZones, (data.zones || []) as BoardZone[]);
          if (isOpen()) {
            serverBlocks.current = data.blocks;
            serverZones.current = data.zones || [];
            setBlocks(pending.current.actions.reduce(apply, replayed));
            setZones(pending.current.actions.reduce(applyZones, replayedZones));
          }
          await send({ ...snap, blocks: replayed, zones: replayedZones, serverIds: new Set((data.blocks as BoardBlock[]).map(b => b.id)) }, true);
          return;
        }
        // Second conflict: stop. Show the latest version and say what was not kept.
        const edited = snap.actions.some(a => a.kind === 'edit');
        if (isOpen()) {
          pending.current = emptyPending();
          syncPending();
          serverBlocks.current = data.blocks;
          serverZones.current = data.zones || [];
          setBlocks(data.blocks);
          setZones(data.zones || []);
          setSaveState('failed');
        }
        onNotice({ tone: 'error', text: `This board keeps changing on another device, so ${edited ? 'your latest text was not kept' : 'your last changes were not kept'}. Showing the latest version.` });
      } else if (isOpen()) {
        // Refused (not available, too large, …) or no connection: back to what is saved.
        pending.current = emptyPending();
        syncPending();
        setBlocks(serverBlocks.current);
        setZones(serverZones.current);
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
    setZones([]);
    setSaveState('idle');
    workspaceBoardsAPI.getTab(tabId)
      .then((data) => {
        if (cancelled) return;
        tabRef.current = data.tab;
        revs.current.set(data.tab.id, data.tab.rev);
        onTab(data.tab);
        serverBlocks.current = data.blocks;
        serverZones.current = data.zones || [];
        setBlocks(data.blocks);
        setZones(data.zones || []);
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
      if (inFlight.current || !workspaceBoardsAPI.saveBlocksOnLeave(snap.tabId, rev, payloadOf(snap), snap.zones)) {
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
          if (tabRef.current?.id === snap.tabId && !pending.current.actions.length) {
            serverBlocks.current = latest.blocks; serverZones.current = latest.zones || [];
            setBlocks(latest.blocks); setZones(latest.zones || []); setSaveState('saved');
          }
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

  /** A new arrangement on the canvas: places and sizes of some blocks, and the zones when they changed. */
  const arrange = useCallback((items: Record<string, Spot | null>, nextZones?: BoardZone[], options: { debounce?: boolean } = {}) => {
    const action: BoardChange = { kind: 'layout', items, ...(nextZones ? { zones: nextZones } : {}) };
    if (nextZones) setZones(nextZones);
    change(apply(blocksRef.current, action), action, options);
  }, [change]);

  /**
   * A block's content changed: shown at once. Typing is saved 1 second after it pauses (at least every 4);
   * `now` (a tick, Complete, a reorder, a date picked) saves straight away.
   */
  const edit = useCallback((id: string, content: BoardContent, options: { now?: boolean; later?: boolean } = {}) => {
    const action: BoardChange = { kind: 'edit', id, ...content };
    setBlocks(apply(blocksRef.current, action));
    const list = pending.current.actions;
    const last = list[list.length - 1];
    // Consecutive edits of one block replace each other (only the latest words need saving).
    if (last && last.kind === 'edit' && last.id === id) list[list.length - 1] = action;
    else list.push(action);
    pending.current.dirty.add(id);
    if (options.now) schedule(0);
    // A removal waits for its Undo window, as taking a block off the board does.
    else if (options.later) schedule(UNDO_WINDOW);
    else schedule(TYPING_DELAY, true);
  }, [schedule]);

  /** Save now if anything is waiting (a note or text area lost focus). Resolves once every save so far is done. */
  const flush = useCallback((): Promise<void> => (pending.current.actions.length ? save() : queue.current), [save]);

  const addFiles = useCallback((files: AdvancedSearchResult[]) => {
    const onBoard = new Set(blocksRef.current.filter(b => b.type === 'file').map(refIdOf));
    const added: Array<BoardBlock & { refId?: string }> = [];
    let next = blocksRef.current;
    for (const f of files) {
      if (onBoard.has(f._id)) continue;
      onBoard.add(f._id);
      // Not placed yet: the board puts it below everything (as My Files > Board does) and keeps that spot.
      const block: BoardBlock & { refId?: string } = {
        id: newBlockId(), type: 'file', x: null, y: null, refId: f._id,
        ref: searchRef(f),
      };
      pending.current.newRefs.set(block.id, { type: 'file', refId: f._id });
      added.push(block);
      next = [...next, block];
    }
    if (!added.length) return 0;
    syncPending();
    change(next, { kind: 'add', blocks: added }, { debounce: true });
    return added.length;
  }, [change]);

  const addFolder = useCallback((folderId: string) => {
    if (blocksRef.current.some(b => b.type === 'folder' && refIdOf(b) === folderId)) return false;
    const block: BoardBlock & { refId?: string } = {
      id: newBlockId(), type: 'folder', x: null, y: null, refId: folderId,
      ref: { available: true, folderId, name: 'Folder', source: 'owned' },
    };
    pending.current.newRefs.set(block.id, { type: 'folder', refId: folderId });
    syncPending();
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] }, { debounce: true });
    return true;
  }, [change]);

  // Adds wait a moment so the place the canvas gives a new item goes out in the same save.
  /** A new sticky note or text area, placed below everything. Returns its id (so it can be focused). */
  const addNote = useCallback(() => {
    const { w, h } = BLOCK_SIZES.note;
    const block: BoardBlock = { id: newBlockId(), type: 'note', x: null, y: null, w, h, note: { title: '', body: '', color: 'yellow' } };
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] }, { debounce: true });
    return block.id;
  }, [change]);

  const addText = useCallback(() => {
    const { w, h } = BLOCK_SIZES.text;
    const block: BoardBlock = { id: newBlockId(), type: 'text', x: null, y: null, w, h, text: EMPTY_DOC };
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] }, { debounce: true });
    return block.id;
  }, [change]);

  /**
   * A new checklist, label, deadline, link or file list, placed below everything. A link comes with its content (the
   * address is checked first). Returns its id (so it can be focused).
   */
  const addBlock = useCallback((type: 'checklist' | 'label' | 'deadline' | 'link' | 'filelist', given?: BoardContent) => {
    const { w, h } = BLOCK_SIZES[type];
    const content = given || (type === 'checklist' ? { checklist: { title: '', items: [] } }
      : type === 'filelist' ? { filelist: { title: '', items: [] } }
      : type === 'label' ? { label: { text: '', size: 'm' as const, align: 'left' as const, tone: 'default' as const } }
        : { deadline: { title: '', note: '', due: null, completedAt: null } });
    const block = { id: newBlockId(), type, x: null, y: null, w, h, ...content } as BoardBlock;
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] }, { debounce: true });
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
    const CONTENT_NAMES: Record<string, string> = { note: 'The note', text: 'The text area', checklist: 'The checklist', label: 'The label', deadline: 'The deadline', link: 'The link', filelist: 'The file list' };
    const isRef = before.type === 'file' || before.type === 'folder';
    const name = !isRef ? CONTENT_NAMES[before.type] : before.ref.available ? `“${before.ref.name}”` : 'The unavailable item';
    const where = isRef ? ' It is still in File Box.' : '';
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
        setBlocks([...blocksRef.current, before]);
        pending.current.actions.push({ kind: 'add', blocks: [{ ...before, refId }] });
        schedule(0);
        onNotice({ text: `${name} is back on this board.` });
      },
    });
  }, [schedule, onNotice]);

  /** Take every unavailable file and folder off the board at once; one Undo puts them all back (until saved). */
  const removeUnavailable = useCallback(() => {
    const gone = blocksRef.current.filter(b => (b.type === 'file' || b.type === 'folder') && !b.ref.available);
    if (!gone.length) return 0;
    const ids = new Set(gone.map(b => b.id));
    gone.forEach((b) => {
      removedUnavailable.current.add(b.id);
      pending.current.newRefs.delete(b.id);
      pending.current.actions.push({ kind: 'remove', id: b.id });
    });
    syncPending();
    setBlocks(blocksRef.current.filter(b => !ids.has(b.id)));
    schedule(UNDO_WINDOW);
    const count = `${gone.length} unavailable ${gone.length === 1 ? 'item' : 'items'}`;
    onNotice({
      text: `Removed ${count} from this board.`,
      undo: () => {
        // They can only come back before the removal was saved (they are not available to add again).
        if (gone.some(b => !removedUnavailable.current.has(b.id))) {
          onNotice({ tone: 'error', text: 'Those items can no longer be put back: they are not available to you.' });
          return;
        }
        const back = gone.filter(b => !blocksRef.current.some(x => x.id === b.id));
        setBlocks([...blocksRef.current, ...back]);
        pending.current.actions.push({ kind: 'add', blocks: back });
        schedule(0);
        onNotice({ text: `Put back ${count}.` });
      },
    });
    return gone.length;
  }, [schedule, onNotice]);

  /** Load the tab again from the server (after a real file action such as rename, move or trash). */
  const reload = useCallback(async () => {
    await queue.current;
    const current = tabRef.current;
    if (!current || pending.current.actions.length) return;
    try {
      const data = await workspaceBoardsAPI.getTab(current.id);
      if (tabRef.current?.id !== current.id || pending.current.actions.length) return;
      revs.current.set(current.id, data.tab.rev);
      onTab(data.tab);
      serverBlocks.current = data.blocks;
      serverZones.current = data.zones || [];
      setBlocks(data.blocks);
      setZones(data.zones || []);
    } catch { /* the next load shows it */ }
  }, [onTab]);

  /**
   * Take one row out of a file list (the file itself is never touched). Saved after the Undo window; Undo
   * puts the row back exactly where it was. A readable row is put back with its file (the server keeps the
   * stored row if the removal was not sent yet, or adds it again, checked, if it was). An unavailable row can
   * only come back while its removal is certainly unsent (nothing is saving), since its file is not known here.
   */
  const removeListRow = useCallback((blockId: string, rowId: string) => {
    const block = blocksRef.current.find(b => b.id === blockId);
    if (!block || block.type !== 'filelist') return;
    const index = block.filelist.items.findIndex(r => r.id === rowId);
    if (index < 0) return;
    const row = block.filelist.items[index];
    edit(blockId, { filelist: { ...block.filelist, items: block.filelist.items.filter(r => r.id !== rowId) } }, { later: true });
    const name = row.ref.available ? `“${row.ref.name}”` : 'The unavailable file';
    onNotice({
      text: `${name} was removed from this list.${row.ref.available ? ' It is still in File Box.' : ''}`,
      undo: () => {
        const now = blocksRef.current.find(b => b.id === blockId);
        if (!now || now.type !== 'filelist' || now.filelist.items.some(r => r.id === rowId)) return;
        const unsent = inFlight.current === 0 && serverBlocks.current.some(b => b.id === blockId && b.type === 'filelist' && b.filelist.items.some(r => r.id === rowId));
        if (!row.ref.available && !unsent) {
          onNotice({ tone: 'error', text: 'That file can no longer be put back: it is not available to you.' });
          return;
        }
        const back = row.ref.available ? { ...row, fileId: row.ref.fileId } : row;
        const items = [...now.filelist.items];
        items.splice(Math.min(index, items.length), 0, back);
        edit(blockId, { filelist: { ...now.filelist, items } }, { now: true });
        onNotice({ text: `${name} is back in this list.` });
      },
    });
  }, [edit, onNotice]);

  return { blocks, zones, loading, error, pending: pendingRefs, saveState, change, arrange, edit, flush, addFiles, addFolder, addNote, addText, addBlock, remove, removeUnavailable, removeListRow, reload };
}

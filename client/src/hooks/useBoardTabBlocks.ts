import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceBoardsAPI, AdvancedSearchResult, BoardBlock, BoardBlockInput, BoardConnector, BoardContent, BoardFileList, BoardRef, BoardTab, BoardText, BoardZone } from '../services/api';
import { BLOCK_SIZES, CONTENT_TYPES, ContentType, Spot } from '../utils/boardLayout';
import { freshId, planDuplicate } from '../utils/boardDuplicate';
import { pairKey } from '../utils/boardConnectors';

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
  // A block's content changed (a note, text area, label, deadline, link, file list or saved search): its field named after its type.
  | ({ kind: 'edit'; id: string } & BoardContent)
  // Connectors: one added, one taken away, or one changed between line and arrow.
  | { kind: 'connect'; connector: BoardConnector }
  | { kind: 'disconnect'; id: string }
  | { kind: 'restyle'; id: string; style: BoardConnector['style'] };

/** The tab limits a duplicate must stay within (from the server's limits). */
export interface DuplicateLimits { blocksPerTab: number; searchesPerTab: number; fileRefsPerTab: number; connectorsPerTab: number }

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
  if (change.kind === 'connect' || change.kind === 'disconnect' || change.kind === 'restyle') return blocks;
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
/** One action applied to the connectors (taking an item off the board takes its connectors with it). */
function applyConnectors(list: BoardConnector[], change: BoardChange): BoardConnector[] {
  if (change.kind === 'connect') return list.some(c => c.id === change.connector.id || pairKey(c) === pairKey(change.connector)) ? list : [...list, change.connector];
  if (change.kind === 'disconnect') return list.filter(c => c.id !== change.id);
  if (change.kind === 'restyle') return list.map(c => (c.id === change.id ? { ...c, style: change.style } : c));
  if (change.kind === 'remove') return list.filter(c => c.fromId !== change.id && c.toId !== change.id);
  return list;
}
/** Only connectors whose two items are both on the board (what a save sends; the server checks the same). */
const onBoard = (list: BoardConnector[], blocks: BoardBlock[]) => { const ids = new Set(blocks.map(b => b.id)); return list.filter(c => ids.has(c.fromId) && ids.has(c.toId)); };
const touching = (c: BoardConnector, ids: Set<string>) => ids.has(c.fromId) || ids.has(c.toId);

interface Pending { actions: BoardChange[]; newRefs: Map<string, { type: 'file' | 'folder'; refId: string }>; dirty: Set<string> }
interface Snapshot extends Pending { tabId: string; blocks: BoardBlock[]; zones: BoardZone[]; connectors: BoardConnector[]; serverIds: Set<string>; lostConnectors?: number }
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
  const [connectors, setConnectorsState] = useState<BoardConnector[]>([]);
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
  const connectorsRef = useRef<BoardConnector[]>([]);
  const serverConnectors = useRef<BoardConnector[]>([]);
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
  const setConnectors = (next: BoardConnector[]) => { connectorsRef.current = next; setConnectorsState(next); };
  const syncPending = () => setPendingRefs(new Set(pending.current.newRefs.keys()));

  /** Take everything not yet sent for the open tab (so a later save cannot send it again). */
  const takeSnapshot = (): Snapshot | null => {
    const current = tabRef.current;
    if (!current || !pending.current.actions.length) return null;
    const snap: Snapshot = { tabId: current.id, blocks: blocksRef.current, zones: zonesRef.current, connectors: connectorsRef.current, serverIds: new Set(serverBlocks.current.map(b => b.id)), ...pending.current };
    pending.current = emptyPending();
    return snap;
  };

  const send = useCallback(async (snap: Snapshot, retried = false): Promise<void> => {
    const isOpen = () => tabRef.current?.id === snap.tabId;
    const rev = revs.current.get(snap.tabId) ?? 0;
    inFlight.current += 1;
    if (isOpen()) setSaveState('saving');
    try {
      const result = await workspaceBoardsAPI.saveBlocks(snap.tabId, rev, payloadOf(snap), snap.zones, onBoard(snap.connectors, snap.blocks));
      revs.current.set(snap.tabId, result.tab.rev);
      onTab(result.tab);
      if (isOpen()) {
        serverBlocks.current = result.blocks;
        serverZones.current = result.zones;
        serverConnectors.current = result.connectors || [];
        snap.newRefs.forEach((_, id) => pending.current.newRefs.delete(id));
        syncPending();
        // Changes made while this was saving stay on screen; the server's view fills in names and counts.
        if (!pending.current.actions.length) { setBlocks(result.blocks); setZones(result.zones); setConnectors(result.connectors || []); }
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
        if (retried && snap.lostConnectors) {
          onNotice({ tone: 'error', text: snap.lostConnectors === 1 ? 'The connector was not kept: one of its items was removed on another device.' : `${snap.lostConnectors} connectors were not kept: their items were removed on another device.` });
        } else if (retried) {
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
          // A connector made here to an item removed on the other device is not kept (and never sent).
          const replayedConnectors = onBoard(snap.actions.reduce(applyConnectors, (data.connectors || []) as BoardConnector[]), replayed);
          const lostConnectors = snap.actions.filter(a => a.kind === 'connect' && !replayedConnectors.some(c => c.id === a.connector.id)).length;
          if (isOpen()) {
            serverBlocks.current = data.blocks;
            serverZones.current = data.zones || [];
            serverConnectors.current = data.connectors || [];
            const nowBlocks = pending.current.actions.reduce(apply, replayed);
            setBlocks(nowBlocks);
            setZones(pending.current.actions.reduce(applyZones, replayedZones));
            setConnectors(onBoard(pending.current.actions.reduce(applyConnectors, replayedConnectors), nowBlocks));
          }
          await send({ ...snap, blocks: replayed, zones: replayedZones, connectors: replayedConnectors, lostConnectors, serverIds: new Set((data.blocks as BoardBlock[]).map(b => b.id)) }, true);
          return;
        }
        // Second conflict: stop. Show the latest version and say what was not kept.
        const edited = snap.actions.some(a => a.kind === 'edit');
        if (isOpen()) {
          pending.current = emptyPending();
          syncPending();
          serverBlocks.current = data.blocks;
          serverZones.current = data.zones || [];
          serverConnectors.current = data.connectors || [];
          setBlocks(data.blocks);
          setZones(data.zones || []);
          setConnectors(data.connectors || []);
          setSaveState('failed');
        }
        onNotice({ tone: 'error', text: `This board keeps changing on another device, so ${edited ? 'your latest text was not kept' : 'your last changes were not kept'}. Showing the latest version.` });
      } else if (isOpen()) {
        // Refused (not available, too large, …) or no connection: back to what is saved.
        pending.current = emptyPending();
        syncPending();
        setBlocks(serverBlocks.current);
        setZones(serverZones.current);
        setConnectors(serverConnectors.current);
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
    setConnectors([]);
    setSaveState('idle');
    workspaceBoardsAPI.getTab(tabId)
      .then((data) => {
        if (cancelled) return;
        tabRef.current = data.tab;
        revs.current.set(data.tab.id, data.tab.rev);
        onTab(data.tab);
        serverBlocks.current = data.blocks;
        serverZones.current = data.zones || [];
        serverConnectors.current = data.connectors || [];
        setBlocks(data.blocks);
        setZones(data.zones || []);
        setConnectors(data.connectors || []);
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
      if (inFlight.current || !workspaceBoardsAPI.saveBlocksOnLeave(snap.tabId, rev, payloadOf(snap), snap.zones, onBoard(snap.connectors, snap.blocks))) {
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
            serverBlocks.current = latest.blocks; serverZones.current = latest.zones || []; serverConnectors.current = latest.connectors || [];
            setBlocks(latest.blocks); setZones(latest.zones || []); setConnectors(latest.connectors || []); setSaveState('saved');
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
   * A new label, deadline, link, file list or saved search, placed below everything. A link comes with its content (the
   * address is checked first). Returns its id (so it can be focused).
   */
  const addBlock = useCallback((type: 'label' | 'deadline' | 'link' | 'filelist' | 'search' | 'sticker' | 'shape', given?: BoardContent, size?: { w: number; h: number }) => {
    const { w, h } = size || BLOCK_SIZES[type];
    const content = given || (type === 'filelist' ? { filelist: { title: '', items: [] } }
      : type === 'label' ? { label: { text: '', size: 'm' as const, align: 'left' as const, tone: 'default' as const, style: 'plain' as const } }
        : { deadline: { title: '', note: '', due: null, completedAt: null } });
    const block = { id: newBlockId(), type, x: null, y: null, w, h, ...content } as BoardBlock;
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] }, { debounce: true });
    return block.id;
  }, [change]);

  // Taking items off the board takes their connectors too (in the same save); Undo puts back those whose other item is still there.
  const dropConnectorsOf = useCallback((ids: Set<string>) => {
    const gone = connectorsRef.current.filter(c => touching(c, ids));
    if (gone.length) setConnectors(connectorsRef.current.filter(c => !touching(c, ids)));
    return gone;
  }, []);
  const restoreConnectors = useCallback((gone: BoardConnector[]) => {
    const ids = new Set(blocksRef.current.map(b => b.id));
    const back = gone.filter(c => ids.has(c.fromId) && ids.has(c.toId) && !connectorsRef.current.some(x => x.id === c.id || pairKey(x) === pairKey(c)));
    if (!back.length) return;
    setConnectors([...connectorsRef.current, ...back]);
    back.forEach(c => pending.current.actions.push({ kind: 'connect', connector: c }));
  }, []);

  /** Take a block off the board (never touches a file or folder). Undo puts the block back. */
  const remove = useCallback((block: BoardBlock) => {
    const before = blocksRef.current.find(b => b.id === block.id);
    if (!before) return;
    const unavailable = (before.type === 'file' || before.type === 'folder') && !before.ref.available;
    if (unavailable) removedUnavailable.current.add(block.id);
    pending.current.newRefs.delete(block.id);
    syncPending();
    setBlocks(blocksRef.current.filter(b => b.id !== block.id));
    const goneConnectors = dropConnectorsOf(new Set([block.id]));
    pending.current.actions.push({ kind: 'remove', id: block.id });
    schedule(UNDO_WINDOW);
    const CONTENT_NAMES: Record<string, string> = { note: 'The note', text: 'The text area', label: 'The label', deadline: 'The deadline', link: 'The link', filelist: 'The file list', search: 'The saved search' };
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
        restoreConnectors(goneConnectors);
        schedule(0);
        onNotice({ text: `${name} is back on this board.` });
      },
    });
  }, [schedule, onNotice, dropConnectorsOf, restoreConnectors]);

  /**
   * Take several selected items off the board at once (files and folders only leave this board). One Undo puts every
   * one back where it was, with its content and its place in the board's order; an unavailable file or folder only
   * until the removal is saved, as with one item.
   */
  const removeMany = useCallback((list: BoardBlock[]) => {
    const order = blocksRef.current;
    const gone = order.map((b, index) => ({ b, index })).filter(({ b }) => list.some(x => x.id === b.id));
    if (!gone.length) return;
    const ids = new Set(gone.map(({ b }) => b.id));
    const unavailable = (b: BoardBlock) => (b.type === 'file' || b.type === 'folder') && !b.ref.available;
    gone.forEach(({ b }) => {
      if (unavailable(b)) removedUnavailable.current.add(b.id);
      pending.current.newRefs.delete(b.id);
      pending.current.actions.push({ kind: 'remove', id: b.id });
    });
    syncPending();
    setBlocks(order.filter(b => !ids.has(b.id)));
    const goneConnectors = dropConnectorsOf(ids);
    schedule(UNDO_WINDOW);
    const refs = gone.some(({ b }) => b.type === 'file' || b.type === 'folder');
    onNotice({
      text: `${gone.length} items removed.${refs ? ' Files and folders are still in File Box.' : ''}`,
      undo: () => {
        // An unavailable item can only come back before its removal was saved.
        const lost = gone.filter(({ b }) => unavailable(b) && !removedUnavailable.current.has(b.id));
        const back = gone.filter(g => !lost.includes(g) && !blocksRef.current.some(x => x.id === g.b.id));
        if (!back.length) { onNotice({ tone: 'error', text: 'Those items can no longer be put back: they are not available to you.' }); return; }
        const next = [...blocksRef.current];
        back.forEach(({ b, index }) => next.splice(Math.min(index, next.length), 0, b));
        const added = back.map(({ b }) => {
          const refId = refIdOf(b);
          if (refId && (b.type === 'file' || b.type === 'folder') && !serverBlocks.current.some(s => s.id === b.id)) pending.current.newRefs.set(b.id, { type: b.type, refId });
          return { ...b, refId };
        });
        syncPending();
        setBlocks(next);
        pending.current.actions.push({ kind: 'add', blocks: added });
        restoreConnectors(goneConnectors);
        schedule(0);
        const missing = lost.length ? ` ${lost.length} unavailable ${lost.length === 1 ? 'item' : 'items'} could not be put back.` : '';
        onNotice({ text: `${back.length} items are back on this board.${missing}` });
      },
    });
  }, [schedule, onNotice, dropConnectorsOf, restoreConnectors]);

  /**
   * Duplicate items (Boards' own only; file and folder cards are skipped). First anything still waiting is saved on its
   * own, so if the copies are then refused (a file or folder no longer available, too large, a limit) only the copies are
   * undone and what was typed just before stays saved. All or nothing: if the copies would pass a limit, none are made.
   * Returns which copy was made from which item (empty when nothing was copied); one Undo removes only the copies.
   */
  const duplicate = useCallback(async (ids: string[], rules: { limits: DuplicateLimits; searchUnavailable: (id: string) => boolean }): Promise<Array<{ from: string; id: string }>> => {
    const tabAt = tabRef.current?.id;
    await flush();
    if (!tabAt || tabRef.current?.id !== tabAt) return [];
    const current = blocksRef.current;
    const plan = planDuplicate(current.filter(b => ids.includes(b.id)), new Set(current.map(b => b.id)), rules.searchUnavailable);
    const n = plan.copies.length;
    const { refs, rows, searches } = plan.skipped;
    if (!n) {
      onNotice({ tone: 'error', text: searches && !refs
        ? `Nothing was duplicated: the saved search's folder or Team Space is no longer available.`
        : 'Only board items can be duplicated (notes, text, labels, deadlines, links, file lists and saved searches). Files and folders were not copied.' });
      return [];
    }
    const { blocksPerTab, searchesPerTab, fileRefsPerTab, connectorsPerTab } = rules.limits;
    // Connectors come along only between two items that were both copied (never to an item outside the copy).
    const copyOf = new Map(plan.from.map((src, i) => [src, plan.copies[i].id]));
    const takenConnectors = new Set(connectorsRef.current.map(c => c.id));
    const connectorCopies: BoardConnector[] = connectorsRef.current.filter(c => copyOf.has(c.fromId) && copyOf.has(c.toId))
      .map(c => ({ id: freshId(10, takenConnectors), fromId: copyOf.get(c.fromId)!, toId: copyOf.get(c.toId)!, style: c.style }));
    const refsNow = current.reduce((sum, b) => sum + (b.type === 'file' ? 1 : b.type === 'filelist' ? b.filelist.items.length : 0), 0);
    const searchesNow = current.filter(b => b.type === 'search').length;
    const tooMany = current.length + n > blocksPerTab
      ? `This tab can hold ${blocksPerTab} items. Duplicating ${n} would make ${current.length + n}. Nothing was duplicated.`
      : searchesNow + plan.searches > searchesPerTab
        ? `A tab can hold up to ${searchesPerTab} saved searches. Duplicating would make ${searchesNow + plan.searches}. Nothing was duplicated.`
        : refsNow + plan.rows > fileRefsPerTab
          ? `A tab can hold up to ${fileRefsPerTab.toLocaleString('en-US')} file references (file cards and file-list rows). Duplicating would make ${(refsNow + plan.rows).toLocaleString('en-US')}. Nothing was duplicated.`
          : connectorsRef.current.length + connectorCopies.length > connectorsPerTab
            ? `A tab can hold up to ${connectorsPerTab} connectors. Duplicating would make ${connectorsRef.current.length + connectorCopies.length}. Nothing was duplicated.`
            : '';
    if (tooMany) { onNotice({ tone: 'error', text: tooMany }); return []; }

    setBlocks([...current, ...plan.copies]);
    pending.current.actions.push({ kind: 'add', blocks: plan.copies });
    if (connectorCopies.length) {
      setConnectors([...connectorsRef.current, ...connectorCopies]);
      connectorCopies.forEach(c => pending.current.actions.push({ kind: 'connect', connector: c }));
    }
    schedule(0);
    const copyIds = new Set(plan.copies.map(c => c.id));
    const notes = [
      refs ? `${refs} ${refs === 1 ? 'file or folder was' : 'files and folders were'} skipped.` : '',
      rows ? `${rows} unavailable ${rows === 1 ? 'file' : 'files'} in a file list ${rows === 1 ? 'was' : 'were'} not copied.` : '',
      searches ? `${searches} saved ${searches === 1 ? 'search was' : 'searches were'} not copied: ${searches === 1 ? 'its' : 'their'} folder or Team Space is no longer available.` : '',
    ].filter(Boolean);
    onNotice({
      text: [`Duplicated ${n} ${n === 1 ? 'item' : 'items'}.`, ...notes].join(' '),
      undo: () => {
        const here = blocksRef.current.filter(b => copyIds.has(b.id));
        if (!here.length) return;
        here.forEach(b => pending.current.actions.push({ kind: 'remove', id: b.id }));
        setBlocks(blocksRef.current.filter(b => !copyIds.has(b.id)));
        dropConnectorsOf(copyIds);
        schedule(0);
        onNotice({ text: here.length === 1 ? 'The copy was removed.' : `The ${here.length} copies were removed.` });
      },
    });
    return plan.copies.map((c, i) => ({ from: plan.from[i], id: c.id }));
  }, [flush, schedule, onNotice, dropConnectorsOf]);

  /**
   * A new connector (an arrow unless asked otherwise) between two items. All or nothing: if either item is gone, the two are
   * already connected that way, or the tab is full, nothing is made and the notice says why. Returns the new id (or null).
   */
  const connect = useCallback((fromId: string, toId: string, style: BoardConnector['style'] = 'arrow', limit = 300): string | null => {
    const ids = new Set(blocksRef.current.map(b => b.id));
    const refuse = (text: string) => { onNotice({ tone: 'error', text }); return null; };
    if (fromId === toId || !ids.has(fromId) || !ids.has(toId)) return refuse('Those items can’t be connected: one of them is no longer on this board.');
    const connector: BoardConnector = { id: freshId(10, new Set(connectorsRef.current.map(c => c.id))), fromId, toId, style };
    if (connectorsRef.current.some(c => pairKey(c) === pairKey(connector))) return refuse(style === 'arrow' ? 'There is already an arrow between those two this way.' : 'Those two already have a line between them.');
    if (connectorsRef.current.length >= limit) return refuse(`A tab can hold up to ${limit} connectors.`);
    setConnectors([...connectorsRef.current, connector]);
    pending.current.actions.push({ kind: 'connect', connector });
    schedule(0);
    return connector.id;
  }, [schedule, onNotice]);

  /** Take a connector away (Undo puts exactly that one back, while both of its items are still there). */
  const disconnect = useCallback((id: string) => {
    const gone = connectorsRef.current.find(c => c.id === id);
    if (!gone) return;
    setConnectors(connectorsRef.current.filter(c => c.id !== id));
    pending.current.actions.push({ kind: 'disconnect', id });
    schedule(0);
    onNotice({
      text: 'Connector removed.',
      undo: () => {
        const ids = new Set(blocksRef.current.map(b => b.id));
        if (!ids.has(gone.fromId) || !ids.has(gone.toId)) { onNotice({ tone: 'error', text: 'That connector can no longer be put back: one of its items is gone.' }); return; }
        if (connectorsRef.current.some(c => c.id === gone.id || pairKey(c) === pairKey(gone))) return;
        setConnectors([...connectorsRef.current, gone]);
        pending.current.actions.push({ kind: 'connect', connector: gone });
        schedule(0);
        onNotice({ text: 'The connector is back.' });
      },
    });
  }, [schedule, onNotice]);

  /** A connector becomes a line or an arrow (not if that relationship already exists). */
  const restyle = useCallback((id: string, style: BoardConnector['style']) => {
    const c = connectorsRef.current.find(x => x.id === id);
    if (!c || c.style === style) return;
    const next = { ...c, style };
    if (connectorsRef.current.some(x => x.id !== id && pairKey(x) === pairKey(next))) {
      onNotice({ tone: 'error', text: style === 'line' ? 'Those two already have a line between them.' : 'There is already an arrow between those two this way.' });
      return;
    }
    setConnectors(connectorsRef.current.map(x => (x.id === id ? next : x)));
    pending.current.actions.push({ kind: 'restyle', id, style });
    schedule(0);
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
    const goneConnectors = dropConnectorsOf(ids);
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
        restoreConnectors(goneConnectors);
        schedule(0);
        onNotice({ text: `Put back ${count}.` });
      },
    });
    return gone.length;
  }, [schedule, onNotice, dropConnectorsOf, restoreConnectors]);

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
      serverConnectors.current = data.connectors || [];
      setBlocks(data.blocks);
      setZones(data.zones || []);
      setConnectors(data.connectors || []);
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

  /** A saved search's filters as the server has them (null until it is saved): saved searches run with those. */
  const storedSearchKey = useCallback((id: string) => {
    const b = serverBlocks.current.find(x => x.id === id);
    return b && b.type === 'search' ? JSON.stringify(b.search) : null;
  }, []);

  return { blocks, zones, connectors, connect, disconnect, restyle, loading, error, pending: pendingRefs, saveState, change, arrange, edit, flush, addFiles, addFolder, addNote, addText, addBlock, remove, removeMany, duplicate, removeUnavailable, removeListRow, storedSearchKey, reload };
}

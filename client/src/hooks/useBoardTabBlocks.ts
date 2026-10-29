import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceBoardsAPI, AdvancedSearchResult, BoardBlock, BoardBlockInput, BoardTab } from '../services/api';
import { SIZES, firstFit, place } from '../utils/boardGrid';

/**
 * The blocks of one Boards tab and how changes reach the account.
 *
 * Every change (add, remove, move, resize) is kept as an action until a save succeeds. Saves go out after a
 * drag or resize ends, after a short pause in keyboard moves, or after the Undo window of a removal.
 * If another device saved the tab first (409), the latest version is loaded, the person's unsaved actions
 * are replayed on top of it and the save is tried once more. A second conflict stops there: the latest
 * version is shown and the person is told their last changes were not kept. Retries never loop.
 */

export type BoardChange =
  | { kind: 'add'; blocks: Array<BoardBlock & { refId?: string }> }
  | { kind: 'remove'; id: string }
  | { kind: 'move' | 'resize'; id: string; x: number; y: number; w: number; h: number };

export interface BoardNotice { text: string; tone?: 'info' | 'error'; undo?: () => void; removedId?: string }

const KEYS_DELAY = 600;
const UNDO_WINDOW = 5000;
const newBlockId = () => {
  let id = '';
  while (id.length < 10) id += Math.random().toString(36).slice(2);
  return id.slice(0, 10);
};
const refIdOf = (b: BoardBlock) => (b.ref.available ? (b.type === 'file' ? b.ref.fileId : b.ref.folderId) : undefined);

/** One action applied to a layout (used both live and when replaying onto a newer version). */
function apply(blocks: BoardBlock[], change: BoardChange): BoardBlock[] {
  if (change.kind === 'remove') return blocks.filter(b => b.id !== change.id);
  if (change.kind === 'add') {
    let next = blocks;
    for (const added of change.blocks) {
      if (next.some(b => b.id === added.id)) continue;
      if (added.refId && next.some(b => b.type === added.type && refIdOf(b) === added.refId)) continue;
      const spot = firstFit(next, added.w, added.h);
      next = [...next, { ...added, x: spot.x, y: spot.y }];
    }
    return next;
  }
  const target = blocks.find(b => b.id === change.id);
  return target ? place(blocks, { ...target, x: change.x, y: change.y, w: change.w, h: change.h }) : blocks;
}

export function useBoardTabBlocks({ tab, onTab, onNotice }: { tab?: BoardTab; onTab: (tab: BoardTab) => void; onNotice: (notice: BoardNotice | null) => void }) {
  const [blocks, setBlocksState] = useState<BoardBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Set<string>>(new Set());

  const tabRef = useRef<BoardTab | undefined>(tab);
  const blocksRef = useRef<BoardBlock[]>([]);
  const serverBlocks = useRef<BoardBlock[]>([]);
  const actions = useRef<BoardChange[]>([]);
  const newRefs = useRef(new Map<string, { type: 'file' | 'folder'; refId: string }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const due = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);
  const retried = useRef(false);
  const removedUnavailable = useRef(new Set<string>());

  const setBlocks = (next: BoardBlock[]) => { blocksRef.current = next; setBlocksState(next); };
  const syncPending = () => setPending(new Set(newRefs.current.keys()));

  const save = useCallback(async () => {
    const current = tabRef.current;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!current || !actions.current.length) return;
    if (saving.current) { again.current = true; return; }
    saving.current = true;
    const sent = actions.current.length;
    const payload: BoardBlockInput[] = blocksRef.current.map((b) => {
      const added = newRefs.current.get(b.id);
      return { id: b.id, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h, ...(added ? (added.type === 'file' ? { fileId: added.refId } : { folderId: added.refId }) : {}) };
    });
    try {
      const result = await workspaceBoardsAPI.saveBlocks(current.id, current.rev, payload);
      if (tabRef.current?.id !== current.id) return;
      tabRef.current = result.tab;
      onTab(result.tab);
      serverBlocks.current = result.blocks;
      actions.current = actions.current.slice(sent);
      payload.forEach(p => newRefs.current.delete(p.id));
      syncPending();
      // Unless more changes were made meanwhile, show what the server saved (current names, counts, layout).
      if (!actions.current.length) setBlocks(result.blocks);
      else {
        const fresh = new Map(result.blocks.map(b => [b.id, b]));
        setBlocks(blocksRef.current.map(b => (fresh.has(b.id) ? { ...b, ref: fresh.get(b.id)!.ref } : b)));
      }
      if (retried.current) {
        retried.current = false;
        onNotice({ text: 'This board was changed on another device. Your changes were added to the latest version.' });
      }
      // A removed unavailable item cannot be put back once the removal is saved (its reference is gone).
      removedUnavailable.current.clear();
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      if (tabRef.current?.id !== current.id) return;
      if (status === 409 && data?.tab && data?.blocks) {
        tabRef.current = data.tab;
        onTab(data.tab);
        serverBlocks.current = data.blocks;
        if (!retried.current) {
          // First conflict: replay this person's unsaved changes on the latest version, then try once more.
          retried.current = true;
          setBlocks(actions.current.reduce(apply, data.blocks as BoardBlock[]));
          again.current = true;
        } else {
          // Second conflict: stop. Show the latest version and say so.
          retried.current = false;
          actions.current = [];
          newRefs.current.clear();
          syncPending();
          setBlocks(data.blocks);
          onNotice({ tone: 'error', text: 'This board keeps changing on another device, so your last changes were not kept. Showing the latest version.' });
        }
      } else {
        // Refused (not available, too large, …): back to what is saved.
        actions.current = [];
        newRefs.current.clear();
        syncPending();
        setBlocks(serverBlocks.current);
        onNotice({ tone: 'error', text: data?.message || "Couldn't save the board. Your last change was undone." });
      }
    } finally {
      saving.current = false;
      if (again.current) { again.current = false; save(); }
    }
  }, [onTab, onNotice]);

  const schedule = useCallback((delay: number) => {
    const at = Date.now() + delay;
    if (timer.current && due.current <= at) return; // an earlier save is already planned
    if (timer.current) clearTimeout(timer.current);
    due.current = at;
    timer.current = setTimeout(() => { timer.current = null; save(); }, delay);
  }, [save]);

  // Switching tabs (or leaving the page): send what is waiting, then load the new tab.
  useEffect(() => {
    tabRef.current = tab;
  });
  const tabId = tab?.id;
  useEffect(() => {
    if (!tabId) return undefined;
    let cancelled = false;
    const refs = newRefs.current; // the same Map for the life of the page
    setLoading(true);
    setError('');
    setBlocks([]);
    workspaceBoardsAPI.getTab(tabId)
      .then((data) => {
        if (cancelled) return;
        tabRef.current = data.tab;
        onTab(data.tab);
        serverBlocks.current = data.blocks;
        setBlocks(data.blocks);
        setLoading(false);
      })
      .catch((err) => { if (!cancelled) { setError(err?.response?.data?.message || "Couldn't open this tab."); setLoading(false); } });
    return () => {
      cancelled = true;
      if (actions.current.length) save();
      actions.current = [];
      refs.clear();
      retried.current = false;
    };
    // onTab is stable for the page; loading depends on the tab only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const change = useCallback((next: BoardBlock[], action: BoardChange, options: { debounce?: boolean } = {}) => {
    setBlocks(next);
    actions.current.push(action);
    schedule(options.debounce ? KEYS_DELAY : 0);
  }, [schedule]);

  const addFiles = useCallback((files: AdvancedSearchResult[]) => {
    const onTab = new Set(blocksRef.current.filter(b => b.type === 'file').map(refIdOf));
    const added: Array<BoardBlock & { refId?: string }> = [];
    let next = blocksRef.current;
    for (const f of files) {
      if (onTab.has(f._id)) continue;
      onTab.add(f._id);
      const { w, h } = SIZES.file;
      const spot = firstFit(next, w, h);
      const block: BoardBlock & { refId?: string } = {
        id: newBlockId(), type: 'file', x: spot.x, y: spot.y, w, h, refId: f._id,
        ref: { available: true, fileId: f._id, name: f.originalName, mimeType: f.mimeType, size: f.size, technicalType: f.technicalType, updatedAt: f.updatedAt,
          source: f.access.source, role: f.access.role, category: f.classification?.primaryCategory, documentType: f.classification?.documentType, ownerName: f.ownerName, teamName: f.access.teamName },
      };
      newRefs.current.set(block.id, { type: 'file', refId: f._id });
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
    newRefs.current.set(block.id, { type: 'folder', refId: folderId });
    syncPending();
    change([...blocksRef.current, block], { kind: 'add', blocks: [block] });
    return true;
  }, [change]);

  /** Take a block off the board (never touches the file or folder). Undo puts the block back. */
  const remove = useCallback((block: BoardBlock) => {
    const before = blocksRef.current.find(b => b.id === block.id);
    if (!before) return;
    if (!before.ref.available) removedUnavailable.current.add(block.id);
    newRefs.current.delete(block.id);
    syncPending();
    setBlocks(blocksRef.current.filter(b => b.id !== block.id));
    actions.current.push({ kind: 'remove', id: block.id });
    schedule(UNDO_WINDOW);
    const name = before.ref.available ? `“${before.ref.name}”` : 'The unavailable item';
    onNotice({
      text: `${name} was removed from this board. It is still in File Box.`,
      removedId: block.id,
      undo: () => {
        // An unavailable item can only come back before its removal was saved.
        if (!before.ref.available && !removedUnavailable.current.has(block.id)) {
          onNotice({ tone: 'error', text: 'That item can no longer be put back: it is not available to you.' });
          return;
        }
        if (blocksRef.current.some(b => b.id === block.id)) return;
        const refId = refIdOf(before);
        if (refId && !serverBlocks.current.some(b => b.id === block.id)) newRefs.current.set(block.id, { type: block.type, refId });
        syncPending();
        const restored = place([...blocksRef.current, before], before);
        setBlocks(restored);
        actions.current.push({ kind: 'add', blocks: [{ ...before, refId }] });
        schedule(0);
        onNotice({ text: `${name} is back on this board.` });
      },
    });
  }, [schedule, onNotice]);

  // Leaving the page: send anything still waiting.
  useEffect(() => () => { if (actions.current.length) save(); }, [save]);

  return { blocks, loading, error, pending, change, addFiles, addFolder, remove };
}

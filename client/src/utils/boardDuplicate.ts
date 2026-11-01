import { BoardBlock } from '../services/api';
import { BLOCK_SIZES } from './boardLayout';

/**
 * Duplicating board items: what a copy keeps, where copies go, and their new ids. Only Boards' own items are
 * copied; file and folder cards are references to real files, so they are never copied.
 */

export const COPYABLE = ['note', 'text', 'label', 'deadline', 'link', 'filelist', 'search'] as const;
export const isCopyable = (type: string) => (COPYABLE as readonly string[]).includes(type);

// The server keeps places within 0–20,000 px; copies sit one step down and to the right of what they copy.
const CANVAS = 20000;
const STEP = 24;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** A new id of `length` letters and digits that is not in `taken` (and is added to it). */
export function freshId(length: number, taken: Set<string>) {
  for (;;) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(length)), b => ALPHABET[b % 36]).join('');
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

/**
 * The one offset every copy gets, so copies keep the originals' arrangement exactly: +24 on each axis, or −24 where +24
 * would take the right-most (or lowest) copy past the canvas edge, or 0 where neither fits.
 */
export function groupOffset(boxes: Array<{ x: number; y: number; w: number; h: number }>) {
  if (!boxes.length) return { dx: STEP, dy: STEP };
  const axis = (start: number, end: number) => (end + STEP <= CANVAS ? STEP : start >= STEP ? -STEP : 0);
  return {
    dx: axis(Math.min(...boxes.map(b => b.x)), Math.max(...boxes.map(b => b.x + b.w))),
    dy: axis(Math.min(...boxes.map(b => b.y)), Math.max(...boxes.map(b => b.y + b.h))),
  };
}

export interface DuplicatePlan {
  copies: BoardBlock[];
  // The id of the item each copy was made from (same order as copies).
  from: string[];
  // Left out: file and folder cards, file-list rows whose file cannot be opened now, saved searches whose folder or Team Space is gone.
  skipped: { refs: number; rows: number; searches: number };
  // What the copies add toward the tab's limits.
  rows: number;
  searches: number;
}

/**
 * Copies of the given blocks (in board order), with new ids, the same size and content, one shared offset. A deadline's
 * copy is not completed; a file list keeps only rows whose file can be opened now (new row ids, same order); a saved
 * search is its filters only (results are never stored).
 */
export function planDuplicate(selected: BoardBlock[], taken: Set<string>, searchUnavailable: (id: string) => boolean): DuplicatePlan {
  const skipped = { refs: 0, rows: 0, searches: 0 };
  const sources = selected.filter((b) => {
    if (!isCopyable(b.type)) { skipped.refs += 1; return false; }
    if (b.type === 'search' && searchUnavailable(b.id)) { skipped.searches += 1; return false; }
    return true;
  });
  const sizeOf = (b: BoardBlock) => {
    const size = BLOCK_SIZES[b.type as keyof typeof BLOCK_SIZES];
    return { w: b.w ?? size.w, h: b.h ?? size.h };
  };
  const offset = groupOffset(sources.filter(b => b.x !== null && b.y !== null).map(b => ({ x: b.x as number, y: b.y as number, ...sizeOf(b) })));
  let rows = 0;
  const copies = sources.map((b): BoardBlock => {
    const place = { id: freshId(10, taken), x: b.x === null ? null : b.x + offset.dx, y: b.y === null ? null : b.y + offset.dy, ...sizeOf(b) };
    if (b.type === 'deadline') return { ...place, type: 'deadline', deadline: { ...structuredClone(b.deadline), completedAt: null } };
    if (b.type === 'filelist') {
      const rowIds = new Set<string>();
      const items = b.filelist.items.flatMap((r) => {
        if (!r.ref.available || !r.ref.fileId) { skipped.rows += 1; return []; }
        return [{ id: freshId(8, rowIds), fileId: r.ref.fileId, ref: structuredClone(r.ref) }];
      });
      rows += items.length;
      return { ...place, type: 'filelist', filelist: { title: b.filelist.title, items } };
    }
    if (b.type === 'search') return { ...place, type: 'search', search: structuredClone(b.search) };
    const { id, x, y, w, h, ...content } = b;
    return { ...place, ...structuredClone(content) } as BoardBlock;
  });
  return { copies, from: sources.map(b => b.id), skipped, rows, searches: copies.filter(c => c.type === 'search').length };
}

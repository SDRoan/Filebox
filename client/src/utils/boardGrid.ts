/**
 * Boards grid: 12 columns, whole cells, no overlaps. The same functions run on the server
 * (server/utils/boardGrid.js), which applies them again to every save; both copies are checked against
 * the same test cases. A block is { id, type, x, y, w, h }; reading order is top to bottom, then left to right.
 */

export const COLS = 12;
export const MAX_Y = 2000;

export type GridBlockType = 'file' | 'folder' | 'note' | 'text';
export interface GridBlock { id: string; type: GridBlockType; x: number; y: number; w: number; h: number }
export interface BlockSize { w: number; h: number; minW: number; minH: number; maxW: number; maxH: number }

export const SIZES: Record<GridBlockType, BlockSize> = {
  file: { w: 3, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  folder: { w: 3, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  note: { w: 3, h: 3, minW: 2, minH: 2, maxW: 6, maxH: 6 },
  text: { w: 6, h: 4, minW: 3, minH: 2, maxW: 12, maxH: 12 },
};

const int = (value: number, min: number, max: number, fallback: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

/** A block with its size inside its type's limits and its position inside the grid. */
export function clampBlock<T extends GridBlock>(block: T): T {
  const s = SIZES[block.type] || SIZES.file;
  const w = int(block.w, s.minW, s.maxW, s.w);
  const h = int(block.h, s.minH, s.maxH, s.h);
  return { ...block, w, h, x: int(block.x, 0, COLS - w, 0), y: int(block.y, 0, MAX_Y, 0) };
}

export const collides = (a: Pick<GridBlock, 'id' | 'x' | 'y' | 'w' | 'h'>, b: Pick<GridBlock, 'id' | 'x' | 'y' | 'w' | 'h'>) =>
  a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const readingOrder = (a: GridBlock, b: GridBlock) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Blocks that overlap are pushed down, in reading order, below whatever they hit (pushes cascade). */
function resolve<T extends GridBlock>(fixed: T[], rest: T[]): T[] {
  const placed = fixed.map(b => ({ ...b }));
  for (const original of [...rest].sort(readingOrder)) {
    const b = { ...original };
    let hit = placed.find(p => collides(p, b));
    while (hit) {
      b.y = hit.y + hit.h;
      hit = placed.find(p => collides(p, b));
    }
    placed.push(b);
  }
  return placed;
}

/** Gravity: every block moves up as far as it can without overlapping a block above it. */
export function settle<T extends GridBlock>(layout: T[]): T[] {
  const settled: T[] = [];
  for (const original of [...layout].sort(readingOrder)) {
    const b = { ...original };
    while (b.y > 0 && !settled.some(s => collides(s, { ...b, y: b.y - 1 }))) b.y -= 1;
    settled.push(b);
  }
  return settled;
}

/** Put one block where it was dropped (or resized); anything it lands on moves down, then all settles up. */
export function place<T extends GridBlock>(layout: T[], moved: T): T[] {
  const target = clampBlock(moved);
  return settle(resolve([target], layout.filter(b => b.id !== target.id)));
}

/** Any layout made valid: every block clamped, overlaps pushed down, then settled. */
export function normalize<T extends GridBlock>(layout: T[]): T[] {
  return settle(resolve([], layout.map(clampBlock)));
}

/** The first free spot for a new block of this size: rows top to bottom, columns left to right. */
export function firstFit(layout: GridBlock[], w: number, h: number) {
  for (let y = 0; y <= MAX_Y; y += 1) {
    for (let x = 0; x <= COLS - w; x += 1) {
      const candidate = { id: '\u0000new', x, y, w, h };
      if (!layout.some(b => collides(b, candidate))) return { x, y };
    }
  }
  return { x: 0, y: MAX_Y };
}

/** Phone order: swap a block with its neighbour in reading order (−1 up, +1 down), then settle. */
export function swapWithNeighbour<T extends GridBlock>(layout: T[], id: string, direction: -1 | 1): T[] {
  const ordered = [...layout].sort(readingOrder);
  const i = ordered.findIndex(b => b.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= ordered.length) return layout;
  const a = ordered[i];
  const b = ordered[j];
  const swapped = ordered.map((block) => {
    if (block.id === a.id) return { ...block, x: b.x, y: b.y };
    if (block.id === b.id) return { ...block, x: a.x, y: a.y };
    return block;
  });
  // The moved block keeps its new spot; anything it now overlaps moves down.
  return place(swapped, swapped.find(x => x.id === a.id) as T);
}

/**
 * Boards grid: 12 columns, whole cells, no overlaps. The browser has the same functions
 * (client/src/utils/boardGrid.ts) and both are checked against the same test cases; the server runs them
 * again on every save, so whatever the browser sends, the stored layout is clamped and overlap-free.
 *
 * A block is { id, type, x, y, w, h }. Reading order is top to bottom, then left to right.
 */

const COLS = 12;
const MAX_Y = 2000;
const SIZES = Object.freeze({
  file: Object.freeze({ w: 3, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 }),
  folder: Object.freeze({ w: 3, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 }),
});

const int = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

/** A block with its size inside its type's limits and its position inside the grid. */
function clampBlock(block) {
  const s = SIZES[block.type] || SIZES.file;
  const w = int(block.w, s.minW, s.maxW, s.w);
  const h = int(block.h, s.minH, s.maxH, s.h);
  return { ...block, w, h, x: int(block.x, 0, COLS - w, 0), y: int(block.y, 0, MAX_Y, 0) };
}

const collides = (a, b) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const readingOrder = (a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Blocks that overlap are pushed down, in reading order, below whatever they hit (pushes cascade). */
function resolve(fixed, rest) {
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
function settle(layout) {
  const settled = [];
  for (const original of [...layout].sort(readingOrder)) {
    const b = { ...original };
    while (b.y > 0 && !settled.some(s => collides(s, { ...b, y: b.y - 1 }))) b.y -= 1;
    settled.push(b);
  }
  return settled;
}

/** Put one block where it was dropped (or resized); anything it lands on moves down, then all settles up. */
function place(layout, moved) {
  const target = clampBlock(moved);
  return settle(resolve([target], layout.filter(b => b.id !== target.id)));
}

/** Any layout made valid: every block clamped, overlaps pushed down, then settled. */
function normalize(layout) {
  return settle(resolve([], layout.map(clampBlock)));
}

/** The first free spot for a new block of this size: rows top to bottom, columns left to right. */
function firstFit(layout, w, h) {
  for (let y = 0; y <= MAX_Y; y += 1) {
    for (let x = 0; x <= COLS - w; x += 1) {
      const candidate = { id: '\u0000new', x, y, w, h };
      if (!layout.some(b => collides(b, candidate))) return { x, y };
    }
  }
  return { x: 0, y: MAX_Y };
}

module.exports = { COLS, MAX_Y, SIZES, clampBlock, collides, readingOrder, settle, place, normalize, firstFit };

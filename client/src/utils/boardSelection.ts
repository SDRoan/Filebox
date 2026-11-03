import { Spot } from './boardLayout';

/**
 * Selecting several items on the board canvas: pure helpers (the selection itself is page state only,
 * never saved). Rectangles are board pixels.
 */

export interface Rect { x: number; y: number; w: number; h: number }

/** The selection: every selected item, and the one last chosen directly (it carries the toolbar). */
export interface Selection {
  keys: Set<string>;
  primary: string | null;
  // Chosen on purpose (Shift or Cmd/Ctrl, a drag box, Select all): focusing another item then keeps it.
  // Otherwise it follows the item last clicked or focused, as a single selection always has.
  held: boolean;
}
export const NO_SELECTION: Selection = { keys: new Set(), primary: null, held: false };

/** Touching counts: a drag box selects every item it overlaps, even a little. */
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The rectangle between two points (a drag box drawn in any direction). */
export const boxBetween = (ax: number, ay: number, bx: number, by: number): Rect => ({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });

/** How far a group may move: the same for every item, so none goes past the left or top edge. */
export function groupDelta(spots: Spot[], dx: number, dy: number) {
  const minX = Math.min(...spots.map(s => s.x));
  const minY = Math.min(...spots.map(s => s.y));
  return { dx: Math.max(-minX, dx), dy: Math.max(-minY, dy) };
}

/** Cmd on a Mac (where Ctrl+click is a right click), Ctrl elsewhere. */
export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
export const commandKey = (event: { metaKey: boolean; ctrlKey: boolean }) => (isMac() ? event.metaKey : event.ctrlKey);

export const selectedCount = (n: number) => (n ? `${n} selected` : 'Selection cleared');

// ---- What a drag box touches, by an item's real outline (pure; board pixels)

type Point = { x: number; y: number };

/**
 * Where a line or arrow starts and ends in its box: corner to corner (top-left to bottom-right unless flipped: h mirrors
 * left–right, v top–bottom), or straight across the middle when the box is thin. An arrow points at `b`.
 */
export function lineEnds(box: Rect, flip: 'none' | 'h' | 'v' | 'both', thin = 16): { a: Point; b: Point } {
  const h = flip === 'h' || flip === 'both';
  const v = flip === 'v' || flip === 'both';
  const order = (a: Point, b: Point, swap: boolean) => (swap ? { a: b, b: a } : { a, b });
  if (box.h <= thin) return order({ x: box.x, y: box.y + box.h / 2 }, { x: box.x + box.w, y: box.y + box.h / 2 }, h);
  if (box.w <= thin) return order({ x: box.x + box.w / 2, y: box.y }, { x: box.x + box.w / 2, y: box.y + box.h }, v);
  return { a: { x: h ? box.x + box.w : box.x, y: v ? box.y + box.h : box.y }, b: { x: h ? box.x : box.x + box.w, y: v ? box.y : box.y + box.h } };
}

const inside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const turn = (o: Point, p: Point, q: Point) => Math.sign((p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x));
const onSegment = (p: Point, a: Point, b: Point) => Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
/** Do segments a–b and c–d meet (touching or crossing; in line only where they overlap)? */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point) {
  const t1 = turn(a, b, c); const t2 = turn(a, b, d); const t3 = turn(c, d, a); const t4 = turn(c, d, b);
  if (t1 !== t2 && t3 !== t4) return true;
  return (t1 === 0 && onSegment(c, a, b)) || (t2 === 0 && onSegment(d, a, b)) || (t3 === 0 && onSegment(a, c, d)) || (t4 === 0 && onSegment(b, c, d));
}

/** Does the box touch the segment a–b (an end inside it, or the segment meeting one of its sides)? */
export function boxTouchesSegment(box: Rect, a: Point, b: Point) {
  if (inside(a, box) || inside(b, box)) return true;
  const c = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
  return c.some((p, i) => segmentsMeet(a, b, p, c[(i + 1) % 4]));
}

/** Does the box touch the ellipse filling `oval` (the box's nearest point to its centre is inside it)? */
export function boxTouchesEllipse(box: Rect, oval: Rect) {
  const rx = oval.w / 2; const ry = oval.h / 2;
  if (rx <= 0 || ry <= 0) return false;
  const cx = oval.x + rx; const cy = oval.y + ry;
  const nx = Math.max(box.x, Math.min(cx, box.x + box.w));
  const ny = Math.max(box.y, Math.min(cy, box.y + box.h));
  return ((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2 <= 1;
}

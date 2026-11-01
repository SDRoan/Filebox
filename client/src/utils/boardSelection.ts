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

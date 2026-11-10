import type { GraphNode } from './boardGraph';

/**
 * Drawing the Connections graph: the curve of each edge, the room it needs, how far it zooms and what a search finds.
 * Pure: numbers and names in, numbers and names out.
 */

export const WORLD_PAD = 64;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const HEAD = { length: 9, width: 9 };

export const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The next zoom stop up or down from anywhere, including a Fit between two stops. A stop that would read the same is skipped. */
export function nextScale(scale: number, direction: 1 | -1) {
  const next = direction > 0 ? STEPS.find(s => s > scale + 0.02) : [...STEPS].reverse().find(s => s < scale - 0.02);
  return next ?? scale;
}

/** The scale that shows the whole graph; a graph that already fits stays at 100%. */
export function fitScale(width: number, height: number, viewWidth: number, viewHeight: number) {
  if (!width || !height || !viewWidth || !viewHeight) return 1;
  return clampScale(Math.min(1, viewWidth / width, viewHeight / height));
}

export const worldSize = (width: number, height: number) => ({ width: width + WORLD_PAD * 2, height: height + WORLD_PAD * 2 });

type Point = { x: number; y: number };

export interface EdgeShape { d: string; head?: string; x: number; y: number }

const n = (v: number) => v.toFixed(1);

function arrowAt(tip: Point, ux: number, uy: number) {
  const base = { x: tip.x - ux * HEAD.length, y: tip.y - uy * HEAD.length };
  const w = HEAD.width / 2;
  return { base, head: `M${n(tip.x)},${n(tip.y)} L${n(base.x - uy * w)},${n(base.y + ux * w)} L${n(base.x + uy * w)},${n(base.y - ux * w)} Z` };
}

/**
 * The curve between two node boxes (top-left corners given). Between columns it runs side to side; within a column it
 * bows out to the right. Edges on the same pair are set apart by a fixed offset that does not depend on their
 * direction, so A→B and B→A stay on separate paths.
 */
export function edgeShape(from: Point, to: Point, width: number, height: number, index: number, count: number, directed: boolean): EdgeShape {
  const spread = count > 1 ? Math.min(12, 40 / (count - 1)) : 0;
  const offset = (index - (count - 1) / 2) * spread;
  const sameColumn = Math.abs(from.x - to.x) < width;
  const direction = to.x >= from.x ? 1 : -1;
  const start = sameColumn ? { x: from.x + width, y: from.y + height / 2 + offset } : { x: from.x + (direction > 0 ? width : 0), y: from.y + height / 2 + offset };
  const tip = sameColumn ? { x: to.x + width, y: to.y + height / 2 + offset } : { x: to.x + (direction > 0 ? 0 : width), y: to.y + height / 2 + offset };
  const ux = sameColumn ? -1 : direction;
  const arrow = directed ? arrowAt(tip, ux, 0) : null;
  const end = arrow ? { x: arrow.base.x + ux * 0.5, y: arrow.base.y } : tip;
  const pull = sameColumn ? 36 + index * 14 : Math.max(30, Math.abs(end.x - start.x) / 2);
  const c1 = { x: start.x + (sameColumn ? pull : direction * pull), y: start.y };
  const c2 = { x: end.x + (sameColumn ? pull : -direction * pull), y: end.y };
  return {
    d: `M${n(start.x)},${n(start.y)} C${n(c1.x)},${n(c1.y)} ${n(c2.x)},${n(c2.y)} ${n(end.x)},${n(end.y)}`,
    ...(arrow ? { head: arrow.head } : {}),
    x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
    y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
  };
}

/** Available nodes whose name holds the search, in the order given. Nothing unavailable can be found by name. */
export function matchNodes(nodes: GraphNode[], query: string): string[] {
  const words = query.trim().toLowerCase();
  if (!words) return [];
  return nodes.filter(node => node.available && node.name.toLowerCase().includes(words)).map(node => node.key);
}

/** How far to scroll so a box is in view with a margin; unchanged if it already is. */
export function scrollToShow(start: number, size: number, viewStart: number, viewSize: number, margin = 24) {
  if (start - margin < viewStart) return Math.max(0, start - margin);
  if (start + size + margin > viewStart + viewSize) return start + size + margin - viewSize;
  return viewStart;
}

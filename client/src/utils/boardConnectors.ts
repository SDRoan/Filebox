import { BoardBlock, BoardConnector } from '../services/api';
import { Rect, intersects } from './boardSelection';
import { domainOf } from './boardLinks';
import { titleOf } from './savedSearch';

/**
 * Connectors between board items: which relationship each is, where it is drawn (from the items' current places,
 * never stored), and the short names they are read out with. Pure: board pixels in, numbers out.
 */

type Point = { x: number; y: number };

/** An arrow has a direction (A→B is not B→A); a line has none (A—B is B—A). The server uses the same rule. */
export const pairKey = (c: Pick<BoardConnector, 'fromId' | 'toId' | 'style'>) => (c.style === 'arrow' ? `arrow:${c.fromId}>${c.toId}` : `line:${[c.fromId, c.toId].sort().join('|')}`);

/**
 * The part of an item a connector meets: its box (cards, notes, boxes), the ellipse filling it (circles), the emoji in
 * the middle of a sticker's box, or the visible segment of a line or arrow shape (given by its ends in that box).
 */
export type Outline = 'box' | 'ellipse' | 'inset' | ((at: Rect) => { a: Point; b: Point });

const insetBox = (r: Rect, f = 0.11): Rect => ({ x: r.x + r.w * f, y: r.y + r.h * f, w: r.w * (1 - f * 2), h: r.h * (1 - f * 2) });
const middle = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** The point a connector heads for on an item (its centre; the middle of a line shape). */
export function anchorOf(r: Rect, outline: Outline = 'box'): Point {
  if (typeof outline === 'function') { const { a, b } = outline(r); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  return middle(r);
}

/** The point of a segment nearest to p. */
export function nearestOnSegment(a: Point, b: Point, p: Point): Point {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** Where the way from an item's anchor toward `toward` leaves its outline. */
export function edgePoint(r: Rect, outline: Outline, toward: Point): Point {
  if (typeof outline === 'function') { const { a, b } = outline(r); return nearestOnSegment(a, b, toward); }
  const box = outline === 'inset' ? insetBox(r) : r;
  const c = middle(box);
  const dx = toward.x - c.x; const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  if (outline === 'ellipse') {
    const t = 1 / Math.sqrt((dx / (box.w / 2)) ** 2 + (dy / (box.h / 2)) ** 2);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  const t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// The box an outline takes (a line shape's segment, padded a little).
const boundsOf = (r: Rect, outline: Outline): Rect => {
  if (typeof outline === 'function') {
    const { a, b } = outline(r);
    return { x: Math.min(a.x, b.x) - 2, y: Math.min(a.y, b.y) - 2, w: Math.abs(b.x - a.x) + 4, h: Math.abs(b.y - a.y) + 4 };
  }
  return outline === 'inset' ? insetBox(r) : r;
};

export const ARROW_HEAD = { length: 9, width: 9 };

export interface ConnectorShape { x1: number; y1: number; x2: number; y2: number; head?: string; mx: number; my: number }

/**
 * How a connector is drawn between two items: from the edge of one to the edge of the other (an arrow's tip just
 * touching the target, its line ending at the head). Null when the items overlap so that no useful line remains: it
 * is then not drawn (it stays stored and listed), and comes back when they move apart.
 */
export function connectorShape(from: Rect, fromOutline: Outline, to: Rect, toOutline: Outline, style: BoardConnector['style']): ConnectorShape | null {
  if (intersects(boundsOf(from, fromOutline), boundsOf(to, toOutline))) return null;
  const a = edgePoint(from, fromOutline, anchorOf(to, toOutline));
  const b = edgePoint(to, toOutline, anchorOf(from, fromOutline));
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 12) return null;
  const ux = (b.x - a.x) / len; const uy = (b.y - a.y) / len;
  const mid = { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  if (style === 'line') return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...mid };
  const { length, width } = ARROW_HEAD;
  const base = { x: b.x - ux * length, y: b.y - uy * length };
  const w = width / 2;
  const head = `M${b.x.toFixed(1)},${b.y.toFixed(1)} L${(base.x - uy * w).toFixed(1)},${(base.y + ux * w).toFixed(1)} L${(base.x + uy * w).toFixed(1)},${(base.y - ux * w).toFixed(1)} Z`;
  return { x1: a.x, y1: a.y, x2: base.x + ux * 0.5, y2: base.y + uy * 0.5, head, ...mid };
}

// ---- Names: short, meaningful, never a name the person can no longer open

const cut = (s: string, max = 40) => { const chars = Array.from(s.replace(/\s+/g, ' ').trim()); return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join(''); };
type DocNode = { type?: string; text?: string; content?: DocNode[] };
const firstText = (node: DocNode | undefined): string => {
  if (!node) return '';
  if (node.text) return node.text;
  for (const child of node.content || []) { const t = firstText(child); if (t.trim()) return t; }
  return '';
};
const SHAPE_NAMES: Record<string, string> = { rect: 'Rectangle', rounded: 'Rounded rectangle', circle: 'Circle', line: 'Line', arrow: 'Arrow' };

/** An item's short name in connector labels and the Connect to… list. */
export function itemName(b: BoardBlock): string {
  if (b.type === 'file' || b.type === 'folder') return b.ref.available ? cut(b.ref.name) : b.type === 'file' ? 'Unavailable file' : 'Unavailable folder';
  if (b.type === 'note') return cut(b.note.title) || cut(b.note.body.split('\n').find(l => l.trim()) || '') || 'Sticky note';
  if (b.type === 'text') return cut(firstText(b.text.doc as DocNode)) || 'Text area';
  if (b.type === 'deadline') return b.deadline.title ? `Deadline: ${cut(b.deadline.title, 30)}` : 'Deadline';
  if (b.type === 'label') return cut(b.label.text) || 'Label';
  if (b.type === 'link') return cut(b.link.title) || domainOf(b.link.url);
  if (b.type === 'filelist') return cut(b.filelist.title) || 'File list';
  if (b.type === 'search') return cut(titleOf(b.search));
  if (b.type === 'sticker') return `${b.sticker.emoji} sticker`;
  if (b.type === 'shape') return SHAPE_NAMES[b.shape.kind] || 'Shape';
  return 'Item';
}

/** Every item's name, told apart in reading order when names repeat ("Rectangle", "Rectangle · 2"). */
export function itemNames(blocks: BoardBlock[]): Map<string, string> {
  const order = [...blocks].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || (a.id < b.id ? -1 : 1));
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const b of order) {
    const base = itemName(b);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    names.set(b.id, n === 1 ? base : `${base} · ${n}`);
  }
  return names;
}

/** "Arrow from A to B" / "Line between A and B". */
export const connectorLabel = (c: BoardConnector, names: Map<string, string>) => (c.style === 'arrow'
  ? `Arrow from ${names.get(c.fromId) || 'an item'} to ${names.get(c.toId) || 'an item'}`
  : `Line between ${names.get(c.fromId) || 'an item'} and ${names.get(c.toId) || 'an item'}`);

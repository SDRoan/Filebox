import { BoardZone } from '../services/api';

/**
 * The free board canvas (My Files > Board and personal Boards): pure layout helpers. Cards are 200 px wide
 * and laid out in 250 px rows; items with their own size (sticky notes, text areas) take the room they need.
 */

export const CARD_WIDTH = 200;
export const GAP = 22;
export const PAD = 24;
export const ROW = 250;
export const ZONE_HEADER = 44;

export interface Spot { x: number; y: number; w?: number; h?: number }

// Sticky notes and text areas on personal Boards have their own size (the server keeps the same limits).
export const BLOCK_SIZES = {
  note: { w: 220, h: 220, minW: 160, minH: 140, maxW: 560, maxH: 560 },
  text: { w: 420, h: 300, minW: 260, minH: 160, maxW: 1200, maxH: 1200 },
  checklist: { w: 260, h: 280, minW: 200, minH: 140, maxW: 600, maxH: 900 },
  label: { w: 280, h: 44, minW: 120, minH: 34, maxW: 1200, maxH: 60 },
  deadline: { w: 220, h: 150, minW: 180, minH: 120, maxW: 400, maxH: 300 },
  link: { w: 260, h: 116, minW: 200, minH: 96, maxW: 480, maxH: 260 },
} as const;
// A label is only as tall as its heading size.
export const LABEL_HEIGHT = { s: 34, m: 44, l: 60 } as const;
// The block types that are content on the board (not references to files or folders).
export const CONTENT_TYPES = ['note', 'text', 'checklist', 'label', 'deadline', 'link'] as const;
export type ContentType = typeof CONTENT_TYPES[number];
export interface Size { w: number; h: number }

/** Is a point (measured from the zone's top-left) inside its outline? Circles and pills are rounded. */
export function insideShape(zone: BoardZone, x: number, y: number) {
  if (x < 0 || y < 0 || x > zone.w || y > zone.h) return false;
  if (zone.shape === 'circle') {
    const rx = zone.w / 2;
    const ry = zone.h / 2;
    return ((x - rx) / rx) ** 2 + ((y - ry) / ry) ** 2 <= 1;
  }
  if (zone.shape === 'pill') {
    const r = Math.min(zone.w, zone.h) / 2;
    const cx = Math.min(Math.max(x, r), zone.w - r);
    const cy = Math.min(Math.max(y, r), zone.h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  }
  return true;
}

/** Is a point on the board inside a zone? */
export const inZone = (zone: BoardZone, x: number, y: number) => insideShape(zone, x - zone.x, y - zone.y);

/** Keep a zone's name tag (w × h) fully inside the zone's outline, moving it toward the middle if needed. */
export function fitLabel(zone: BoardZone, x: number, y: number, w: number, h: number) {
  const inset = zone.shape === 'rectangle' ? 4 : 8;
  let lx = Math.min(Math.max(inset, x), Math.max(inset, zone.w - w - inset));
  let ly = Math.min(Math.max(inset, y), Math.max(inset, zone.h - h - inset));
  const fits = () => [[lx, ly], [lx + w, ly], [lx, ly + h], [lx + w, ly + h]].every(([px, py]) => insideShape(zone, px, py));
  const midX = (zone.w - w) / 2;
  const midY = (zone.h - h) / 2;
  for (let i = 0; i < 200 && !fits(); i++) {
    lx += Math.sign(midX - lx) * Math.min(4, Math.abs(midX - lx));
    ly += Math.sign(midY - ly) * Math.min(4, Math.abs(midY - ly));
  }
  return { labelX: Math.round(lx), labelY: Math.round(ly) };
}

/** Where an item's middle is for zone membership: the centre of its top part (a card's icon and name). */
export const centerOf = (size: Size, pos: Spot) => ({ x: pos.x + size.w / 2, y: pos.y + Math.min(size.h, 120) / 2 });

/** The keys of items whose middle is inside the zone. */
export const zoneMembers = (zone: BoardZone, keys: string[], items: Record<string, Spot>, sizeOf: (key: string) => Size) =>
  keys.filter(key => items[key] && inZone(zone, centerOf(sizeOf(key), items[key]).x, centerOf(sizeOf(key), items[key]).y));

/**
 * Items left to right in rows from (left, top), starting a new row before `right`. A row is ROW tall, or
 * taller when an item with its own size needs it. With only cards this is exactly a grid of columns.
 */
export function flowRows(keys: string[], widthOf: (key: string) => number, ownHeight: (key: string) => number | undefined, left: number, top: number, right: number) {
  const spots: Record<string, { x: number; y: number }> = {};
  let x = left;
  let y = top;
  let rowHeight = ROW;
  let rows = 0;
  keys.forEach((key) => {
    const w = widthOf(key);
    if (rows === 0) rows = 1;
    else if (x !== left && x + w > right) { y += rowHeight; x = left; rowHeight = ROW; rows += 1; }
    spots[key] = { x, y };
    const own = ownHeight(key);
    if (own !== undefined) rowHeight = Math.max(rowHeight, own + GAP);
    x += w + GAP;
  });
  return { spots, rows, height: rows ? y - top + rowHeight : 0 };
}

/** Items without a place yet go in rows below everything already on the board. */
export function placeMissing(keys: string[], items: Record<string, Spot>, zones: BoardZone[], sizeOf: (key: string) => Size, ownHeight: (key: string) => number | undefined, canvasWidth: number) {
  const missing = keys.filter(key => !items[key]);
  if (!missing.length) return items;
  const bottoms = [
    ...Object.entries(items).filter(([key]) => keys.includes(key)).map(([key, pos]) => pos.y + sizeOf(key).h),
    ...zones.map(zone => zone.y + zone.h),
  ];
  const top = bottoms.length ? Math.max(...bottoms) + GAP : PAD;
  const { spots } = flowRows(missing, key => sizeOf(key).w, ownHeight, PAD, top, canvasWidth - PAD);
  const next = { ...items };
  missing.forEach((key) => { next[key] = { ...spots[key] }; });
  return next;
}

/** Tidy up: line items up inside each zone (growing it if needed), then everything else below the zones. */
export function tidyLayout(keys: string[], placed: Record<string, Spot>, zones: BoardZone[], sizeOf: (key: string) => Size, ownHeight: (key: string) => number | undefined, canvasWidth: number) {
  const items: Record<string, Spot> = {};
  const used = new Set<string>();
  const keep = (key: string, at: { x: number; y: number }) => {
    const { w, h } = placed[key] || {};
    items[key] = w !== undefined && h !== undefined ? { ...at, w, h } : at;
  };
  const nextZones = zones.map(zone => {
    const members = zoneMembers(zone, keys, placed, sizeOf).filter(key => !used.has(key));
    members.forEach(key => used.add(key));
    const inset = zone.shape === 'circle' ? zone.w * 0.16 : zone.shape === 'pill' ? Math.min(zone.h / 2, 60) : 16;
    const flow = flowRows(members, key => sizeOf(key).w, ownHeight, zone.x + inset, zone.y + ZONE_HEADER + (zone.shape === 'circle' ? inset : 0), zone.x + zone.w - inset);
    members.forEach(key => keep(key, flow.spots[key]));
    const needed = ZONE_HEADER + flow.height + (zone.shape === 'circle' ? inset * 2 : 16);
    return members.length && zone.shape !== 'circle' ? { ...zone, h: Math.max(zone.h, needed) } : zone;
  });
  const top = nextZones.length ? Math.max(...nextZones.map(z => z.y + z.h)) + GAP : PAD;
  const rest = keys.filter(key => !used.has(key));
  const flow = flowRows(rest, key => sizeOf(key).w, ownHeight, PAD, top, canvasWidth - PAD);
  rest.forEach(key => keep(key, flow.spots[key]));
  return { items, zones: nextZones };
}

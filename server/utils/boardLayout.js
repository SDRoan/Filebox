/**
 * The free board canvas, server side: shared by My Files > Board (routes/boards.js) and personal Boards
 * (services/workspaceBoards.js), so both accept exactly the same zones and positions.
 */

const SHAPES = ['rectangle', 'rounded', 'circle', 'pill'];
const CANVAS = 20000;
const MAX_ZONES = 100;
// Sticky notes and text areas have their own size (pixels); file and folder cards are 200 px wide.
const SIZES = Object.freeze({
  note: Object.freeze({ w: 220, h: 220, minW: 160, minH: 140, maxW: 560, maxH: 560 }),
  text: Object.freeze({ w: 420, h: 300, minW: 260, minH: 160, maxW: 1200, maxH: 1200 }),
  checklist: Object.freeze({ w: 260, h: 280, minW: 200, minH: 140, maxW: 600, maxH: 900 }),
  // A label's height follows its heading size (34, 44 or 60); only its width is chosen.
  label: Object.freeze({ w: 280, h: 44, minW: 120, minH: 34, maxW: 1200, maxH: 60 }),
  deadline: Object.freeze({ w: 220, h: 150, minW: 180, minH: 120, maxW: 400, maxH: 300 }),
});

const coordinate = (value, max = CANVAS) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(0, value))) : null);

/** One zone as the browser sent it, cleaned; null if it cannot be a zone. */
function cleanZone(zone) {
  const x = coordinate(zone?.x);
  const y = coordinate(zone?.y);
  const w = coordinate(zone?.w, 6000);
  const h = coordinate(zone?.h, 6000);
  if (typeof zone?.id !== 'string' || !/^[a-z0-9]{1,24}$/.test(zone.id) || [x, y, w, h].includes(null)) return null;
  return {
    id: zone.id,
    name: typeof zone.name === 'string' ? zone.name.slice(0, 60) : '',
    color: typeof zone.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(zone.color) ? zone.color.toLowerCase() : '#dbeafe',
    shape: SHAPES.includes(zone.shape) ? zone.shape : 'rounded',
    x, y, w: Math.max(120, w), h: Math.max(90, h),
    // Where the zone's name sits inside it; left out means the shape's usual spot.
    ...(coordinate(zone.labelX, 6000) !== null && coordinate(zone.labelY, 6000) !== null
      ? { labelX: coordinate(zone.labelX, 6000), labelY: coordinate(zone.labelY, 6000) } : {}),
  };
}

const cleanZones = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_ZONES).map(cleanZone).filter(Boolean);

/**
 * Where a block sits: pixel x/y (or null for "not placed yet": the canvas puts it below everything), and
 * for sticky notes and text areas a width and height within their limits.
 */
function cleanPlace(raw, type) {
  const x = coordinate(raw?.x);
  const y = coordinate(raw?.y);
  const place = x === null || y === null ? { x: null, y: null } : { x, y };
  const size = SIZES[type];
  if (!size) return place;
  const dim = (value, min, max, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback);
  return { ...place, w: dim(raw?.w, size.minW, size.maxW, size.w), h: dim(raw?.h, size.minH, size.maxH, size.h) };
}

// ---- From the earlier 12-column grid (Boards before the free canvas): deterministic, no content changes.
// One column step was 94 px and one row step 68 px on a 1,116 px board, 24 px from the edge.
const GRID = Object.freeze({ col: 94, row: 68, pad: 24, gap: 12, cardW: 200, cardH: 250, push: 22 });

function fromGrid(blocks) {
  const converted = blocks.map((b) => {
    const place = { x: GRID.pad + Math.max(0, b.x || 0) * GRID.col, y: GRID.pad + Math.max(0, b.y || 0) * GRID.row };
    const size = SIZES[b.type];
    const dims = size ? {
      w: Math.min(size.maxW, Math.max(size.minW, (b.w || 1) * GRID.col - GRID.gap)),
      h: Math.min(size.maxH, Math.max(size.minH, (b.h || 1) * GRID.row - GRID.gap)),
    } : {};
    const { x, y, w, h, ...rest } = b;
    return { ...rest, ...place, ...dims };
  });
  // Cards are taller than their old cells: push anything that now overlaps down, in reading order.
  const rect = (b) => ({ x: b.x, y: b.y, w: b.w ?? GRID.cardW, h: b.h ?? GRID.cardH });
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const order = [...converted].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const done = [];
  for (const block of order) {
    let r = rect(block);
    for (let guard = 0; guard < 500; guard += 1) {
      const hit = done.find(d => overlaps(r, rect(d)));
      if (!hit) break;
      block.y = hit.y + rect(hit).h + GRID.push;
      r = rect(block);
    }
    done.push(block);
  }
  return converted;
}

module.exports = { SHAPES, CANVAS, MAX_ZONES, SIZES, GRID, coordinate, cleanZone, cleanZones, cleanPlace, fromGrid };

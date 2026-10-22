import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { boardsAPI, BoardLayout, BoardZone, BoardZoneShape } from '../services/api';
import { isDark } from '../theme/appearance';
import { PlusIcon, TrashIcon } from './Icons';
import './FileBoard.css';

/**
 * My Files > Board: a free canvas where a person arranges files and folders their own way. They can
 * draw zones (boxes, circles, pills) with names and colors, drop items into them, and move a zone
 * with everything in it. Only the layout is saved (per person and folder); files stay where they are.
 */

export interface BoardEntry { key: string; name: string; render: () => React.ReactNode }

interface FileBoardProps {
  folderKey: string;
  entries: BoardEntry[];
}

const CARD_WIDTH = 200;
const GAP = 22;
const PAD = 24;
const ROW = 250;
const ZONE_HEADER = 44;
const SAVE_DELAY_MS = 500;

const ZONE_COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#ffedd5', '#e0f2f1', '#e5e7eb'];
const SHAPES: Array<{ id: BoardZoneShape; label: string }> = [
  { id: 'rounded', label: 'Rounded box' },
  { id: 'rectangle', label: 'Box' },
  { id: 'circle', label: 'Circle' },
  { id: 'pill', label: 'Pill' },
];

const cacheKey = (folderKey: string) => `filebox-board-${folderKey}`;
const readCache = (folderKey: string): BoardLayout | null => {
  try { return JSON.parse(localStorage.getItem(cacheKey(folderKey)) || 'null'); } catch { return null; }
};
const writeCache = (folderKey: string, layout: BoardLayout) => {
  try { localStorage.setItem(cacheKey(folderKey), JSON.stringify(layout)); } catch { /* saved with the account anyway */ }
};
const newId = () => Math.random().toString(36).slice(2, 12);
// File Box zooms the workspace for Settings > Customize > Text size; pointer moves are in screen pixels.
const zoom = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--fb-zoom')) || 1;

/** Is a point inside a zone (circles and pills use their rounded outline)? */
function inZone(zone: BoardZone, x: number, y: number) {
  if (x < zone.x || y < zone.y || x > zone.x + zone.w || y > zone.y + zone.h) return false;
  if (zone.shape !== 'circle') return true;
  const rx = zone.w / 2;
  const ry = zone.h / 2;
  return ((x - zone.x - rx) / rx) ** 2 + ((y - zone.y - ry) / ry) ** 2 <= 1;
}

const FileBoard: React.FC<FileBoardProps> = ({ folderKey, entries }) => {
  const [layout, setLayout] = useState<BoardLayout>(() => readCache(folderKey) || { items: {}, zones: [] });
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null);
  const sizes = useRef<Record<string, { w: number; h: number }>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(layout);
  latest.current = layout;

  // The account's layout for this folder.
  useEffect(() => {
    let cancelled = false;
    setLayout(readCache(folderKey) || { items: {}, zones: [] });
    setSelectedZone(null);
    boardsAPI.get(folderKey)
      .then(saved => { if (!cancelled) { setLayout(saved); writeCache(folderKey, saved); } })
      .catch(() => { /* keep the layout saved in this browser */ });
    return () => { cancelled = true; };
  }, [folderKey]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const commit = useCallback((next: BoardLayout) => {
    latest.current = next;
    setLayout(next);
    writeCache(folderKey, next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      boardsAPI.save(folderKey, latest.current)
        .then(() => setStatus(''))
        .catch(() => setStatus('Saved in this browser only (could not reach File Box)'));
    }, SAVE_DELAY_MS);
  }, [folderKey]);

  const sizeOf = (key: string) => sizes.current[key] || { w: CARD_WIDTH, h: 200 };
  const centerOf = (key: string, pos: { x: number; y: number }) => ({ x: pos.x + sizeOf(key).w / 2, y: pos.y + Math.min(sizeOf(key).h, 120) / 2 });

  // Items without a place yet go in rows below everything already on the board.
  const placed = (() => {
    const items = { ...layout.items };
    const missing = entries.filter(entry => !items[entry.key]);
    if (missing.length) {
      const width = canvasRef.current?.clientWidth || 1000;
      const columns = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (CARD_WIDTH + GAP)));
      const bottoms = [
        ...Object.entries(items).filter(([key]) => entries.some(e => e.key === key)).map(([key, pos]) => pos.y + sizeOf(key).h),
        ...layout.zones.map(zone => zone.y + zone.h),
      ];
      const top = bottoms.length ? Math.max(...bottoms) + GAP : PAD;
      missing.forEach((entry, i) => {
        items[entry.key] = { x: PAD + (i % columns) * (CARD_WIDTH + GAP), y: top + Math.floor(i / columns) * ROW };
      });
    }
    return items;
  })();

  // Remember card sizes (zones and tidying use them).
  useLayoutEffect(() => {
    canvasRef.current?.querySelectorAll<HTMLElement>('[data-board-key]').forEach(el => {
      sizes.current[el.dataset.boardKey!] = { w: el.offsetWidth, h: el.offsetHeight };
    });
  });

  const zoneMembers = (zone: BoardZone, items = placed) =>
    entries.filter(entry => items[entry.key] && inZone(zone, centerOf(entry.key, items[entry.key]).x, centerOf(entry.key, items[entry.key]).y)).map(e => e.key);

  // Dragging: anywhere on a card or zone except its own buttons and fields. A click that did not move still opens things.
  const startDrag = (event: React.PointerEvent, onMove: (dx: number, dy: number) => void, onEnd: () => void) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const onHandle = target.closest('.board-item-handle, .board-zone-handle');
    if (!onHandle && target.closest('button, a, input, textarea, select, summary, details, label, [role="menu"], [contenteditable="true"]')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const scale = zoom();
    let dragging = false;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / scale;
      const dy = (e.clientY - startY) / scale;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = true;
      document.body.classList.add('board-dragging');
      onMove(dx, dy);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('board-dragging');
      if (!dragging) return;
      // The click that ends a drag should not also open the file.
      window.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
      onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragItem = (key: string) => (event: React.PointerEvent) => {
    const start = placed[key];
    let pos = start;
    startDrag(event, (dx, dy) => {
      pos = { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) };
      setDraggingKey(key);
      const center = centerOf(key, pos);
      setDropZone([...layout.zones].reverse().find(zone => inZone(zone, center.x, center.y))?.id || null);
      setLayout(current => ({ ...current, items: { ...placed, ...current.items, [key]: pos } }));
    }, () => {
      setDropZone(null);
      setDraggingKey(null);
      commit({ ...latest.current, items: { ...placed, ...latest.current.items, [key]: pos } });
    });
  };

  const dragZone = (zone: BoardZone) => (event: React.PointerEvent) => {
    setSelectedZone(zone.id);
    const members = zoneMembers(zone);
    const startItems = { ...placed };
    let next = latest.current;
    startDrag(event, (dx, dy) => {
      const ddx = Math.max(-zone.x, dx);
      const ddy = Math.max(-zone.y, dy);
      const items = { ...startItems };
      members.forEach(key => { items[key] = { x: startItems[key].x + ddx, y: startItems[key].y + ddy }; });
      next = { items, zones: latest.current.zones.map(z => (z.id === zone.id ? { ...z, x: zone.x + ddx, y: zone.y + ddy } : z)) };
      setLayout(next);
    }, () => commit(next));
  };

  const resizeZone = (zone: BoardZone) => (event: React.PointerEvent) => {
    event.stopPropagation();
    let next = latest.current;
    startDrag(event, (dx, dy) => {
      next = { ...latest.current, zones: latest.current.zones.map(z => (z.id === zone.id ? { ...z, w: Math.max(160, zone.w + dx), h: Math.max(120, zone.h + dy) } : z)) };
      setLayout(next);
    }, () => commit(next));
  };

  const updateZone = (id: string, patch: Partial<BoardZone>) =>
    commit({ ...latest.current, items: placed, zones: latest.current.zones.map(z => (z.id === id ? { ...z, ...patch } : z)) });

  const addZone = (shape: BoardZoneShape = 'rounded') => {
    // In free space below everything on the board, so it never lands on top of files.
    const bottoms = [
      ...entries.map(entry => placed[entry.key].y + sizeOf(entry.key).h),
      ...latest.current.zones.map(zone => zone.y + zone.h),
    ];
    const size = shape === 'circle' ? { w: 380, h: 380 } : shape === 'pill' ? { w: 520, h: 240 } : { w: 480, h: 320 };
    const zone: BoardZone = {
      id: newId(), name: `Zone ${latest.current.zones.length + 1}`, color: ZONE_COLORS[latest.current.zones.length % ZONE_COLORS.length],
      shape, x: PAD, y: (bottoms.length ? Math.max(...bottoms) : 0) + GAP * 2, ...size,
    };
    commit({ ...latest.current, items: placed, zones: [...latest.current.zones, zone] });
    setSelectedZone(zone.id);
    // Show it and let the person name it right away.
    requestAnimationFrame(() => {
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-zone-id="${zone.id}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.querySelector<HTMLInputElement>('.board-zone-name')?.select();
    });
  };

  const removeZone = (id: string) => {
    commit({ ...latest.current, items: placed, zones: latest.current.zones.filter(z => z.id !== id) });
    setSelectedZone(null);
  };

  // Tidy up: line items up inside each zone (growing it if needed), then everything else below the zones.
  const tidy = () => {
    const items: BoardLayout['items'] = {};
    const used = new Set<string>();
    const zones = latest.current.zones.map(zone => {
      const members = zoneMembers(zone).filter(key => !used.has(key));
      members.forEach(key => used.add(key));
      const inset = zone.shape === 'circle' ? zone.w * 0.16 : zone.shape === 'pill' ? Math.min(zone.h / 2, 60) : 16;
      const columns = Math.max(1, Math.floor((zone.w - inset * 2 + GAP) / (CARD_WIDTH + GAP)));
      members.forEach((key, i) => {
        items[key] = { x: zone.x + inset + (i % columns) * (CARD_WIDTH + GAP), y: zone.y + ZONE_HEADER + (zone.shape === 'circle' ? inset : 0) + Math.floor(i / columns) * ROW };
      });
      const rows = Math.ceil(members.length / columns);
      const needed = ZONE_HEADER + rows * ROW + (zone.shape === 'circle' ? inset * 2 : 16);
      return members.length && zone.shape !== 'circle' ? { ...zone, h: Math.max(zone.h, needed) } : zone;
    });
    const width = canvasRef.current?.clientWidth || 1000;
    const columns = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (CARD_WIDTH + GAP)));
    const top = zones.length ? Math.max(...zones.map(z => z.y + z.h)) + GAP : PAD;
    entries.filter(entry => !used.has(entry.key)).forEach((entry, i) => {
      items[entry.key] = { x: PAD + (i % columns) * (CARD_WIDTH + GAP), y: top + Math.floor(i / columns) * ROW };
    });
    commit({ items, zones });
  };

  const resetBoard = () => {
    if (!window.confirm('Clear this board? Zones are removed and items go back into rows. Your files are not changed.')) return;
    commit({ items: {}, zones: [] });
    setSelectedZone(null);
  };

  // Keyboard: arrow keys on a card's or zone's move handle nudge it (Shift for bigger steps).
  const nudge = (event: React.KeyboardEvent, move: (dx: number, dy: number) => void) => {
    const step = event.shiftKey ? 50 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    move(delta[0], delta[1]);
  };

  const height = Math.max(560, ...Object.entries(placed).map(([key, pos]) => pos.y + sizeOf(key).h + PAD * 3), ...layout.zones.map(z => z.y + z.h + PAD * 3));
  const width = Math.max(...Object.entries(placed).map(([key, pos]) => pos.x + sizeOf(key).w + PAD), ...layout.zones.map(z => z.x + z.w + PAD), 0);

  return (
    <div className="file-board">
      <div className="file-board-toolbar" role="toolbar" aria-label="Board">
        <span className="file-board-add">
          <button className="file-action-button" onClick={() => addZone('rounded')}><PlusIcon size={15} />Add zone</button>
          {SHAPES.map(shape => (
            <button key={shape.id} className={`file-board-shape shape-${shape.id}`} onClick={() => addZone(shape.id)} title={`Add a ${shape.label.toLowerCase()}`} aria-label={`Add a ${shape.label.toLowerCase()} zone`}><span /></button>
          ))}
        </span>
        <span className="file-board-hint">Drag files and folders anywhere. Drop them in a zone to group them; moving a zone moves what’s in it.</span>
        <button className="file-action-button" onClick={tidy}>Tidy up</button>
        <button className="file-action-button" onClick={resetBoard}>Reset board</button>
      </div>
      {status && <p className="file-board-status" role="status">{status}</p>}

      <div className="file-board-scroll" onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('file-board-canvas')) setSelectedZone(null); }}>
        <div ref={canvasRef} className="file-list file-board-canvas" style={{ height, minWidth: width }}>
          {layout.zones.map(zone => {
            const count = zoneMembers(zone).length;
            const selected = selectedZone === zone.id;
            return (
              <section key={zone.id} data-zone-id={zone.id} className={`board-zone shape-${zone.shape} ${selected ? 'selected' : ''} ${dropZone === zone.id ? 'drop-target' : ''} ${isDark(zone.color) ? 'dark' : ''}`}
                style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h, background: `${zone.color}cc`, borderColor: zone.color }}
                aria-label={`${zone.name || 'Zone'}, ${count} ${count === 1 ? 'item' : 'items'}`}
                onPointerDown={dragZone(zone)}>
                <header className="board-zone-header">
                  <button className="board-zone-handle" aria-label={`Move zone ${zone.name || ''}. Arrow keys move it with everything inside.`} title="Drag to move; arrow keys work too"
                    onFocus={() => setSelectedZone(zone.id)}
                    onKeyDown={(event) => nudge(event, (dx, dy) => {
                      const members = zoneMembers(zone);
                      const items = { ...placed };
                      members.forEach(key => { items[key] = { x: Math.max(0, items[key].x + dx), y: Math.max(0, items[key].y + dy) }; });
                      commit({ items, zones: latest.current.zones.map(z => (z.id === zone.id ? { ...z, x: Math.max(0, z.x + dx), y: Math.max(0, z.y + dy) } : z)) });
                    })}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2" /><circle cx="9" cy="3" r="1.2" /><circle cx="3" cy="9" r="1.2" /><circle cx="9" cy="9" r="1.2" /></svg>
                  </button>
                  <input className="board-zone-name" value={zone.name} maxLength={60} placeholder="Name this zone" aria-label="Zone name"
                    onFocus={() => setSelectedZone(zone.id)} onChange={(event) => updateZone(zone.id, { name: event.target.value })} />
                  <span className="board-zone-count">{count}</span>
                </header>
                {selected && (
                  <div className="board-zone-tools" role="group" aria-label={`Change zone ${zone.name || ''}`}>
                    <span className="board-zone-colors">
                      {ZONE_COLORS.map(color => (
                        <button key={color} style={{ background: color }} aria-label={`Color ${color}`} aria-pressed={zone.color === color} onClick={() => updateZone(zone.id, { color })} />
                      ))}
                      <label className="board-zone-custom" title="Any color">
                        <input type="color" value={zone.color} aria-label="Any zone color" onChange={(event) => updateZone(zone.id, { color: event.target.value.toLowerCase() })} />
                      </label>
                    </span>
                    <span className="board-zone-shapes">
                      {SHAPES.map(shape => (
                        <button key={shape.id} className={`file-board-shape shape-${shape.id} ${zone.shape === shape.id ? 'active' : ''}`} aria-pressed={zone.shape === shape.id} aria-label={shape.label} title={shape.label}
                          onClick={() => updateZone(zone.id, shape.id === 'circle' ? { shape: shape.id, h: zone.w } : { shape: shape.id })}><span /></button>
                      ))}
                    </span>
                    <button className="board-zone-delete" onClick={() => removeZone(zone.id)} aria-label="Delete zone (files stay)" title="Delete zone (files stay)"><TrashIcon size={14} /></button>
                  </div>
                )}
                <span className="board-zone-resize" onPointerDown={resizeZone(zone)} aria-hidden="true" title="Drag to resize" />
              </section>
            );
          })}

          {entries.map(entry => {
            const pos = placed[entry.key];
            return (
              <div key={entry.key} data-board-key={entry.key} className={`board-item ${draggingKey === entry.key ? 'dragging' : ''}`} style={{ left: pos.x, top: pos.y, width: CARD_WIDTH }} onPointerDown={dragItem(entry.key)}>
                <button className="board-item-handle" aria-label={`Move ${entry.name}. Arrow keys move it.`} title="Drag to move; arrow keys work too"
                  onKeyDown={(event) => nudge(event, (dx, dy) => commit({ ...latest.current, items: { ...placed, [entry.key]: { x: Math.max(0, pos.x + dx), y: Math.max(0, pos.y + dy) } } }))}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2" /><circle cx="9" cy="3" r="1.2" /><circle cx="3" cy="9" r="1.2" /><circle cx="9" cy="9" r="1.2" /></svg>
                </button>
                {entry.render()}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default FileBoard;

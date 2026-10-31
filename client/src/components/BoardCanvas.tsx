import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BoardZone, BoardZoneShape, BoardZoneStyle } from '../services/api';
import { TAB_EMOJI } from '../utils/boardTabs';
import { isDark } from '../theme/appearance';
import { PlusIcon, TrashIcon } from './Icons';
import { CARD_WIDTH, GAP, PAD, Spot, centerOf as centerAt, fitLabel, inZone, placeMissing, tidyLayout, zoneMembers as membersOf } from '../utils/boardLayout';
import './FileBoard.css';

/**
 * The free board canvas shared by My Files > Board and personal Boards: a dotted surface where items are
 * placed anywhere, zones (boxes, circles, pills) with names and colors group them, and moving a zone moves
 * what is inside it. The parent owns the layout and saves it; this draws it and reports every change.
 */

export interface CanvasEntry {
  key: string;
  name: string;
  render: () => React.ReactNode;
  // Items with their own size (sticky notes, text areas); cards are CARD_WIDTH wide and as tall as they are.
  size?: { w: number; h: number };
  resize?: { minW: number; minH: number; maxW: number; maxH: number };
  // Only the grip moves it, so typing or selecting text inside never does.
  handleOnly?: boolean;
  className?: string;
  // A key on the item's grip (before arrow keys move it); return true when handled.
  onHandleKey?: (event: React.KeyboardEvent) => boolean;
  // A few quick actions shown in a small toolbar while the item is selected (Boards' own blocks only).
  actions?: ItemAction[];
}
export interface ItemAction { id: string; label: string; icon: React.ReactNode; run: () => void }
export interface CanvasLayout { items: Record<string, Spot>; zones: BoardZone[] }

interface BoardCanvasProps {
  layout: CanvasLayout;
  entries: CanvasEntry[];
  onCommit: (next: CanvasLayout) => void;
  // Changes when another board is shown (another folder or tab): forget the selected zone.
  boardKey: string;
  status?: string;
  hint?: string;
  toolbarStart?: React.ReactNode;
  // Replaces the default "Reset board" (a browser confirm, then everything back into rows).
  onReset?: () => void;
  // Told where items without a saved place were put, so the parent can keep those places.
  onAutoPlace?: (items: Record<string, Spot>) => void;
  empty?: React.ReactNode;
  // A zone near the top edge shows its tools under itself, where they are not cut off (personal Boards).
  toolsBelowNearTop?: boolean;
  // Extra tools at the end of the toolbar (before Tidy up), and classes for the canvas (its pattern).
  toolbarEnd?: React.ReactNode;
  canvasClassName?: string;
  // Zones can have a style and an emoji (personal Boards).
  zoneLooks?: boolean;
}

const ZONE_COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#ffedd5', '#e0f2f1', '#e5e7eb'];
const SHAPES: Array<{ id: BoardZoneShape; label: string }> = [
  { id: 'rounded', label: 'Rounded box' },
  { id: 'rectangle', label: 'Box' },
  { id: 'circle', label: 'Circle' },
  { id: 'pill', label: 'Pill' },
];
const ZONE_STYLES: Array<{ id: BoardZoneStyle; label: string }> = [
  { id: 'tint', label: 'Tint' },
  { id: 'outline', label: 'Outline' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'glass', label: 'Glass' },
];
const DEFAULT_HINT = 'Drag files and folders anywhere. Drop them in a zone to group them; moving a zone moves what’s in it.';

const newId = () => Math.random().toString(36).slice(2, 12);
// File Box zooms the workspace for Settings > Customize > Text size; pointer moves are in screen pixels.
const zoom = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--fb-zoom')) || 1;

const GRIP = <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2" /><circle cx="9" cy="3" r="1.2" /><circle cx="3" cy="9" r="1.2" /><circle cx="9" cy="9" r="1.2" /></svg>;

/**
 * The quick actions of the selected item: one tab stop (arrow keys move between its buttons), Escape goes back
 * to the item's grip. Shown above the item, or below it near the top of the board, so it never covers it.
 */
const ItemToolbar: React.FC<{ name: string; actions: ItemAction[]; below: boolean }> = ({ name, actions, below }) => {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (event: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') || []);
    if (event.key === 'Escape') {
      event.preventDefault();
      ref.current?.closest('.board-item')?.querySelector<HTMLElement>('.board-item-handle')?.focus({ preventScroll: true });
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (active + step! + buttons.length) % buttons.length;
    setActive(next);
    buttons[next]?.focus();
  };
  return (
    <div ref={ref} className={`board-item-toolbar ${below ? 'is-below' : ''}`} role="toolbar" aria-label={`Actions for ${name}`} onKeyDown={onKey}>
      {actions.map((action, i) => (
        <button key={action.id} type="button" tabIndex={i === active ? 0 : -1} aria-label={action.label} title={action.label} data-action={action.id}
          onFocus={() => setActive(i)} onClick={action.run}>{action.icon}</button>
      ))}
    </div>
  );
};

const BoardCanvas: React.FC<BoardCanvasProps> = ({ layout: given, entries, onCommit, boardKey, status = '', hint = DEFAULT_HINT, toolbarStart, onReset, onAutoPlace, empty, toolsBelowNearTop = false, toolbarEnd, canvasClassName = '', zoneLooks = false }) => {
  // What is drawn: the parent's layout, or the live one while something is being dragged (only then is
  // there a copy here, so nothing typed can be overwritten by an older layout).
  const [live, setLive] = useState<CanvasLayout | null>(null);
  const layout = live || given;
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  // The item last clicked or focused (shows a selected outline, and its quick actions if it has any).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [emojiFor, setEmojiFor] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const sizes = useRef<Record<string, { w: number; h: number }>>({});
  const latest = useRef(layout);
  latest.current = layout;

  useEffect(() => { setSelectedZone(null); setSelectedKey(null); setEmojiFor(null); setLive(null); }, [boardKey]);
  const setLayout = (next: CanvasLayout | ((current: CanvasLayout) => CanvasLayout)) =>
    setLive(current => (typeof next === 'function' ? next(current || latest.current) : next));

  const commit = (next: CanvasLayout) => {
    latest.current = next;
    setLive(null);
    onCommit(next);
  };

  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const keys = entries.map(entry => entry.key);
  const sizeOf = (key: string) => byKey.get(key)?.size || sizes.current[key] || { w: CARD_WIDTH, h: 200 };
  const ownHeight = (key: string) => byKey.get(key)?.size?.h;
  const centerOf = (key: string, pos: Spot) => centerAt(sizeOf(key), pos);
  const canvasWidth = () => canvasRef.current?.clientWidth || 1000;

  // Items without a place yet go in rows below everything already on the board.
  const placed = placeMissing(keys, layout.items, layout.zones, sizeOf, ownHeight, canvasWidth());
  const autoPlaced = keys.filter(key => !layout.items[key]);
  const autoKey = autoPlaced.join(',');
  useEffect(() => {
    if (!onAutoPlace || !autoPlaced.length) return;
    onAutoPlace(Object.fromEntries(autoPlaced.map(key => [key, placed[key]])));
    // Reported once for each set of newly placed items.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  // Remember card sizes (zones and tidying use them).
  useLayoutEffect(() => {
    canvasRef.current?.querySelectorAll<HTMLElement>('[data-board-key]').forEach(el => {
      sizes.current[el.dataset.boardKey!] = { w: el.offsetWidth, h: el.offsetHeight };
    });
  });

  const zoneMembers = (zone: BoardZone, items = placed) => membersOf(zone, keys, items, sizeOf);

  // Dragging: anywhere on a card or zone except its own buttons and fields. A click that did not move still opens things.
  const startDrag = (event: React.PointerEvent, onMove: (dx: number, dy: number) => void, onEnd: () => void) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const onHandle = target.closest('.board-item-handle, .board-zone-label-grip, .board-item-resize');
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
    const target = event.target as HTMLElement;
    if (byKey.get(key)?.handleOnly && !target.closest('.board-item-handle')) return;
    if (target.closest('.board-item-resize')) return;
    const start = placed[key];
    let pos = start;
    startDrag(event, (dx, dy) => {
      pos = { ...start, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) };
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

  // Sticky notes and text areas: drag the corner to resize, within their limits.
  const resizeItem = (entry: CanvasEntry) => (event: React.PointerEvent) => {
    event.stopPropagation();
    const limits = entry.resize!;
    const start = placed[entry.key];
    const base = sizeOf(entry.key);
    let pos = start;
    startDrag(event, (dx, dy) => {
      pos = { ...start, w: Math.round(Math.min(limits.maxW, Math.max(limits.minW, base.w + dx))), h: Math.round(Math.min(limits.maxH, Math.max(limits.minH, base.h + dy))) };
      setDraggingKey(entry.key);
      setLayout(current => ({ ...current, items: { ...placed, ...current.items, [entry.key]: pos } }));
    }, () => {
      setDraggingKey(null);
      commit({ ...latest.current, items: { ...placed, ...latest.current.items, [entry.key]: pos } });
    });
  };

  const dragZone = (zone: BoardZone) => (event: React.PointerEvent) => {
    setSelectedZone(zone.id);
    setSelectedKey(null);
    const members = zoneMembers(zone);
    const startItems = { ...placed };
    let next = latest.current;
    startDrag(event, (dx, dy) => {
      const ddx = Math.max(-zone.x, dx);
      const ddy = Math.max(-zone.y, dy);
      const items = { ...startItems };
      members.forEach(key => { items[key] = { ...startItems[key], x: startItems[key].x + ddx, y: startItems[key].y + ddy }; });
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

  // The zone's name tag: drag it anywhere inside the zone (kept within its outline).
  const dragLabel = (zone: BoardZone) => (event: React.PointerEvent) => {
    event.stopPropagation();
    setSelectedZone(zone.id);
    const label = (event.currentTarget as HTMLElement).closest<HTMLElement>('.board-zone-header');
    if (!label) return;
    const start = { x: label.offsetLeft, y: label.offsetTop };
    const size = { w: label.offsetWidth, h: label.offsetHeight };
    let next = latest.current;
    startDrag(event, (dx, dy) => {
      const spot = fitLabel(zone, start.x + dx, start.y + dy, size.w, size.h);
      next = { ...latest.current, zones: latest.current.zones.map(z => (z.id === zone.id ? { ...z, ...spot } : z)) };
      setLayout(next);
    }, () => commit({ ...next, items: placed }));
  };
  const nudgeLabel = (zone: BoardZone, label: HTMLElement | null, dx: number, dy: number) => {
    if (!label) return;
    updateZone(zone.id, fitLabel(zone, label.offsetLeft + dx, label.offsetTop + dy, label.offsetWidth, label.offsetHeight));
  };
  const moveZoneBy = (zone: BoardZone, dx: number, dy: number) => {
    const items = { ...placed };
    zoneMembers(zone).forEach(key => { items[key] = { ...items[key], x: Math.max(0, items[key].x + dx), y: Math.max(0, items[key].y + dy) }; });
    commit({ items, zones: latest.current.zones.map(z => (z.id === zone.id ? { ...z, x: Math.max(0, z.x + dx), y: Math.max(0, z.y + dy) } : z)) });
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

  const tidy = () => commit(tidyLayout(keys, placed, latest.current.zones, sizeOf, ownHeight, canvasWidth()));

  const resetBoard = () => {
    if (onReset) { onReset(); return; }
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
        <span className="file-board-group">
          {toolbarStart}
          <span className="file-board-add">
            <button className="file-action-button" onClick={() => addZone('rounded')}><PlusIcon size={15} />Add zone</button>
            {SHAPES.map(shape => (
              <button key={shape.id} className={`file-board-shape shape-${shape.id}`} onClick={() => addZone(shape.id)} title={`Add a ${shape.label.toLowerCase()}`} aria-label={`Add a ${shape.label.toLowerCase()} zone`}><span /></button>
            ))}
          </span>
        </span>
        <span className="file-board-hint">{hint}</span>
        <span className="file-board-group file-board-group-end">
          {toolbarEnd}
          <button className="file-action-button" onClick={tidy}>Tidy up</button>
          <button className="file-action-button file-board-quiet" onClick={resetBoard}>Reset board</button>
        </span>
      </div>
      {status && <p className="file-board-status" role="status">{status}</p>}

      <div className="file-board-scroll" onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('file-board-canvas')) { setSelectedZone(null); setSelectedKey(null); setEmojiFor(null); } }}>
        <div ref={canvasRef} className={`file-list file-board-canvas${canvasClassName ? ` ${canvasClassName}` : ''}`} style={{ height, minWidth: width }}>
          {layout.zones.map(zone => {
            const count = zoneMembers(zone).length;
            const selected = selectedZone === zone.id;
            return (
              <section key={zone.id} data-zone-id={zone.id} className={`board-zone shape-${zone.shape} style-${zone.style || 'tint'} ${selected ? 'selected' : ''} ${dropZone === zone.id ? 'drop-target' : ''} ${isDark(zone.color) ? 'dark' : ''}${toolsBelowNearTop && zone.y < 56 ? ' tools-below' : ''}`}
                style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h, ['--zone' as string]: zone.color } as React.CSSProperties}
                aria-label={`${zone.name || 'Zone'}, ${count} ${count === 1 ? 'item' : 'items'}`}
                onPointerDown={dragZone(zone)}>
                <header className={`board-zone-header ${zone.labelX !== undefined ? 'placed' : ''}`}
                  style={zone.labelX !== undefined ? { left: zone.labelX, top: zone.labelY } : undefined}>
                  <button className="board-zone-label-grip" aria-label={`Move the name of ${zone.name || 'this zone'} inside the zone. Arrow keys move it.`} title="Drag to move the name inside the zone"
                    onFocus={() => setSelectedZone(zone.id)} onPointerDown={dragLabel(zone)}
                    onKeyDown={(event) => nudge(event, (dx, dy) => nudgeLabel(zone, (event.currentTarget as HTMLElement).closest('.board-zone-header'), dx, dy))}>
                    {GRIP}
                  </button>
                  {zone.emoji && <span className="board-zone-emoji" aria-hidden="true">{zone.emoji}</span>}
                  <input className="board-zone-name" value={zone.name} maxLength={60} placeholder="Name this zone" aria-label="Zone name"
                    onFocus={() => { setSelectedZone(zone.id); setSelectedKey(null); }} onChange={(event) => updateZone(zone.id, { name: event.target.value })} />
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
                    {zoneLooks && (
                      <span className="board-zone-styles" role="group" aria-label="Zone style">
                        {ZONE_STYLES.map(look => (
                          <button key={look.id} type="button" className={`board-zone-style look-${look.id}`} aria-pressed={(zone.style || 'tint') === look.id} aria-label={`${look.label} style`} title={look.label}
                            onClick={() => updateZone(zone.id, { style: look.id === 'tint' ? undefined : look.id })}><span /></button>
                        ))}
                      </span>
                    )}
                    {zoneLooks && (
                      <span className="board-zone-emoji-pick"
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape' || emojiFor !== zone.id) return;
                          event.preventDefault(); event.stopPropagation();
                          setEmojiFor(null);
                          event.currentTarget.querySelector<HTMLElement>('.board-zone-emoji-button')?.focus({ preventScroll: true });
                        }}>
                        <button type="button" className="board-zone-emoji-button" aria-expanded={emojiFor === zone.id} aria-haspopup="true" aria-label={zone.emoji ? `Zone emoji: ${zone.emoji}. Change` : 'Add an emoji'} title="Emoji"
                          onClick={(event) => {
                            const opening = emojiFor !== zone.id;
                            setEmojiFor(opening ? zone.id : null);
                            // Opened: focus moves into the list, to the current choice.
                            const pickBox = event.currentTarget.parentElement;
                            if (opening) setTimeout(() => (pickBox?.querySelector<HTMLElement>('.board-zone-emoji-grid [aria-pressed="true"]') || pickBox?.querySelector<HTMLElement>('.board-zone-emoji-grid button'))?.focus(), 0);
                          }}>{zone.emoji || '☺︎'}</button>
                        {emojiFor === zone.id && (
                          <span className="board-zone-emoji-grid" role="group" aria-label="Choose an emoji for this zone">
                            <button type="button" className="board-zone-emoji-none" aria-pressed={!zone.emoji} onClick={() => { updateZone(zone.id, { emoji: undefined }); setEmojiFor(null); }}>None</button>
                            {TAB_EMOJI.map(([emoji, label]) => (
                              <button key={emoji} type="button" aria-label={label} aria-pressed={zone.emoji === emoji} onClick={() => { updateZone(zone.id, { emoji }); setEmojiFor(null); }}>{emoji}</button>
                            ))}
                          </span>
                        )}
                      </span>
                    )}
                    <button className="board-zone-move" aria-label={`Move zone ${zone.name || ''} with everything inside. Use arrow keys, or drag the zone itself.`} title="Arrow keys move the zone; or drag an empty part of it"
                      onKeyDown={(event) => nudge(event, (dx, dy) => moveZoneBy(zone, dx, dy))}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></svg>
                    </button>
                    {zone.labelX !== undefined && <button className="board-zone-label-reset" onClick={() => updateZone(zone.id, { labelX: undefined, labelY: undefined })} title="Put the name back in its usual spot">Reset name spot</button>}
                    <button className="board-zone-delete" onClick={() => removeZone(zone.id)} aria-label="Delete zone (files stay)" title="Delete zone (files stay)"><TrashIcon size={14} /></button>
                  </div>
                )}
                <span className="board-zone-resize" onPointerDown={resizeZone(zone)} aria-hidden="true" title="Drag to resize" />
              </section>
            );
          })}

          {entries.map(entry => {
            const pos = placed[entry.key];
            const sized = entry.size ? { width: pos.w ?? entry.size.w, height: pos.h ?? entry.size.h } : { width: CARD_WIDTH };
            return (
              <div key={entry.key} data-board-key={entry.key} className={`board-item ${draggingKey === entry.key ? 'dragging' : ''}${selectedKey === entry.key ? ' selected' : ''}${entry.className ? ` ${entry.className}` : ''}`} style={{ left: pos.x, top: pos.y, ...sized }}
                onPointerDown={dragItem(entry.key)} onPointerDownCapture={() => setSelectedKey(entry.key)} onFocusCapture={() => setSelectedKey(entry.key)}>
                <button className="board-item-handle" aria-label={`Move ${entry.name}. Arrow keys move it.`} title="Drag to move; arrow keys work too"
                  onKeyDown={(event) => {
                    if (entry.onHandleKey?.(event)) return;
                    nudge(event, (dx, dy) => commit({ ...latest.current, items: { ...placed, [entry.key]: { ...pos, x: Math.max(0, pos.x + dx), y: Math.max(0, pos.y + dy) } } }));
                  }}>
                  {GRIP}
                </button>
                {selectedKey === entry.key && entry.actions?.length ? <ItemToolbar name={entry.name} actions={entry.actions} below={pos.y < 48} /> : null}
                {entry.render()}
                {entry.resize && <span className="board-item-resize" onPointerDown={resizeItem(entry)} aria-hidden="true" title="Drag to resize" />}
              </div>
            );
          })}
          {!entries.length && !layout.zones.length && empty}
        </div>
      </div>
    </div>
  );
};

export default BoardCanvas;

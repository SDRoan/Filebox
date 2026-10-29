import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import BoardBlock, { blockLabel } from './BoardBlock';
import { BoardBlock as Block } from '../services/api';
import { COLS, SIZES, place, readingOrder, swapWithNeighbour } from '../utils/boardGrid';

/**
 * The Boards grid: 12 columns of whole cells. Desktop: drag a block to move it, drag its corner to resize,
 * or use the arrow keys (Shift + arrows to resize). While dragging the layout updates live, but nothing is
 * saved until the pointer is let go. Phone: one column in reading order, with Move up / Move down.
 * The server checks and normalises every layout again when it is saved.
 */

export const ROW = 56;
export const GAP = 12;
const DRAG_THRESHOLD = 4;
// File Box zooms the page for Settings > Customize > Text size; pointer movement is in screen pixels.
const zoom = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--fb-zoom')) || 1;

export type BoardAction =
  | { kind: 'move' | 'resize'; id: string; x: number; y: number; w: number; h: number }
  | { kind: 'remove'; id: string };

interface BoardGridProps {
  blocks: Block[];
  pending: Set<string>;
  onChange: (next: Block[], action: BoardAction, options?: { debounce?: boolean }) => void;
  onOpen: (block: Block) => void;
  onRemove: (block: Block) => void;
  onAnnounce: (message: string) => void;
}

interface Drag { id: string; mode: 'move' | 'resize'; startX: number; startY: number; origin: Block; moved: boolean; pointerId: number; cell: string }

const usePhone = () => {
  const query = '(max-width: 600px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setPhone(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
};

const BoardGrid: React.FC<BoardGridProps> = ({ blocks, pending, onChange, onOpen, onRemove, onAnnounce }) => {
  const phone = usePhone();
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<Block[] | null>(null);
  const drag = useRef<Drag | null>(null);
  // Set when a drag ends, so the click that follows it does not also open the block.
  const justDragged = useRef(false);
  const shown = preview || blocks;

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [phone]);

  const colWidth = width ? (width - GAP * (COLS - 1)) / COLS : 0;
  const step = colWidth + GAP;
  const rowStep = ROW + GAP;

  const onPointerDown = (block: Block) => (event: React.PointerEvent) => {
    if (phone || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const resize = Boolean(target.closest('.board-block-resize'));
    if (!resize && target.closest('button, summary, a, input, .item-actions-popover')) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { id: block.id, mode: resize ? 'resize' : 'move', startX: event.clientX, startY: event.clientY, origin: block, moved: false, pointerId: event.pointerId, cell: '' };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId || !step) return;
    const dx = (event.clientX - d.startX) / zoom();
    const dy = (event.clientY - d.startY) / zoom();
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    const o = d.origin;
    const target = d.mode === 'move'
      ? { ...o, x: o.x + Math.round(dx / step), y: o.y + Math.round(dy / rowStep) }
      : { ...o, w: o.w + Math.round(dx / step), h: o.h + Math.round(dy / rowStep) };
    // The live layout is worked out again only when the pointer reaches another cell.
    const cell = `${target.x},${target.y},${target.w},${target.h}`;
    if (cell === d.cell) return;
    d.cell = cell;
    setPreview(place(blocks, target));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId) return;
    drag.current = null;
    const final = preview;
    setPreview(null);
    if (!d.moved) return;
    justDragged.current = true;
    const now = final?.find(b => b.id === d.id);
    const o = d.origin;
    // Saved once, when the pointer is let go, and only if the block really changed.
    if (final && now && (now.x !== o.x || now.y !== o.y || now.w !== o.w || now.h !== o.h)) {
      onChange(final, { kind: d.mode, id: d.id, x: now.x, y: now.y, w: now.w, h: now.h });
    }
  };

  const onKeyDown = (block: Block) => (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if ((event.key === 'Enter' || event.key === ' ') && block.ref.available) { event.preventDefault(); onOpen(block); return; }
    if (phone) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const size = SIZES[block.type];
    const target = event.shiftKey
      ? { ...block, w: Math.min(size.maxW, Math.max(size.minW, block.w + delta[0])), h: Math.min(size.maxH, Math.max(size.minH, block.h + delta[1])) }
      : { ...block, x: block.x + delta[0], y: block.y + delta[1] };
    const next = place(blocks, target);
    const now = next.find(b => b.id === block.id);
    if (!now || (now.x === block.x && now.y === block.y && now.w === block.w && now.h === block.h)) return;
    onChange(next, { kind: event.shiftKey ? 'resize' : 'move', id: block.id, x: now.x, y: now.y, w: now.w, h: now.h }, { debounce: true });
    onAnnounce(event.shiftKey ? `${now.w} columns wide, ${now.h} rows tall.` : `Column ${now.x + 1}, row ${now.y + 1}.`);
  };

  // Keyboard focus stays on the block that moved.
  const focusId = useRef('');
  const keepFocus = useCallback((id: string) => { focusId.current = id; }, []);
  useEffect(() => {
    if (!focusId.current) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-block-id="${focusId.current}"]`)?.focus();
    focusId.current = '';
  });

  const ordered = [...shown].sort(readingOrder);

  if (phone) {
    return (
      <ol className="board-list" ref={gridRef as unknown as React.RefObject<HTMLOListElement>} aria-label="Board items">
        {ordered.map((block, index) => (
          <li key={block.id} className="board-list-item" data-block-id={block.id} tabIndex={0}
            aria-label={`${blockLabel(block)}, ${index + 1} of ${ordered.length}`} onKeyDown={onKeyDown(block)}
            onClick={(event) => { if (!(event.target as HTMLElement).closest('button, summary, .item-actions-popover') && block.ref.available) onOpen(block); }}>
            <BoardBlock block={block} pending={pending.has(block.id)} phone first={index === 0} last={index === ordered.length - 1}
              onOpen={() => onOpen(block)} onRemove={() => onRemove(block)}
              onMove={(direction) => {
                const next = swapWithNeighbour(blocks, block.id, direction);
                const now = next.find(b => b.id === block.id)!;
                keepFocus(block.id);
                onChange(next, { kind: 'move', id: block.id, x: now.x, y: now.y, w: now.w, h: now.h });
                onAnnounce(`Moved ${direction < 0 ? 'up' : 'down'}.`);
              }} />
          </li>
        ))}
      </ol>
    );
  }

  const rows = shown.reduce((max, b) => Math.max(max, b.y + b.h), 0);
  return (
    <div className={`board-grid ${preview ? 'is-dragging' : ''}`} ref={gridRef} style={{ height: Math.max(rows, 2) * rowStep - GAP }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; setPreview(null); }}>
      <p id="board-grid-help" className="boards-visually-hidden">Arrow keys move the item, Shift with arrow keys resizes it, Enter opens it.</p>
      {width > 0 && ordered.map((block) => (
        <div key={block.id} data-block-id={block.id} tabIndex={0} role="group"
          className={`board-block ${drag.current?.id === block.id ? 'is-active' : ''}`}
          aria-label={`${blockLabel(block)}, column ${block.x + 1}, row ${block.y + 1}, ${block.w} by ${block.h}`}
          aria-describedby="board-grid-help"
          style={{ left: block.x * step, top: block.y * rowStep, width: block.w * colWidth + (block.w - 1) * GAP, height: block.h * ROW + (block.h - 1) * GAP }}
          onPointerDown={onPointerDown(block)} onKeyDown={onKeyDown(block)}
          onClick={(event) => {
            // Opens on a click (mouse, touch or assistive technology), but not at the end of a drag.
            if (justDragged.current) { justDragged.current = false; return; }
            if ((event.target as HTMLElement).closest('button, summary, a, input, .item-actions-popover, .board-block-resize')) return;
            if (block.ref.available) onOpen(block);
          }}>
          <BoardBlock block={block} pending={pending.has(block.id)} phone={false} first={false} last={false}
            onOpen={() => onOpen(block)} onRemove={() => onRemove(block)} onMove={() => {}} />
          <span className="board-block-resize" aria-hidden="true" title="Drag to resize" />
        </div>
      ))}
    </div>
  );
};

export default BoardGrid;

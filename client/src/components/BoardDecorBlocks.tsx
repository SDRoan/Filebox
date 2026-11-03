import React, { useRef } from 'react';
import { BoardBlock, BoardShape, BoardShapeColor, BoardShapeFlip, BoardShapeKind, BoardSticker } from '../services/api';
import { TAB_EMOJI } from '../utils/boardTabs';
import { lineEnds } from '../utils/boardSelection';
import { MoveItems } from './BoardNoteBlocks';
import ItemActions from './ItemActions';

/**
 * Stickers and shapes: decorations drawn straight on the board (no card). A sticker is one emoji as large as its square
 * box; a shape is a box, a circle or ellipse, a line or an arrow, in colours from one small palette. Their style menu is
 * opened from the item's toolbar and stays open while choices are made; Escape goes back to the item's grip.
 */

export const SHAPE_KINDS: Array<[BoardShapeKind, string]> = [['rect', 'Rectangle'], ['rounded', 'Rounded rectangle'], ['circle', 'Circle'], ['line', 'Line'], ['arrow', 'Arrow']];
export const SHAPE_COLORS: Array<[BoardShapeColor, string]> = [['none', 'None'], ['sage', 'Sage'], ['sky', 'Sky'], ['lavender', 'Lavender'], ['rose', 'Rose'], ['amber', 'Amber'], ['slate', 'Slate'], ['ink', 'Ink']];
export const SHAPE_WIDTHS: Array<BoardShape['strokeWidth']> = [1, 2, 3, 4, 6];
export const isLineLike = (kind: BoardShapeKind) => kind === 'line' || kind === 'arrow';
export const shapeName = (kind: BoardShapeKind) => SHAPE_KINDS.find(([k]) => k === kind)?.[1] || 'Shape';

/** A new shape of a kind: its colours and its box (a line or arrow starts straight across). */
export const newShape = (kind: BoardShapeKind): { shape: BoardShape; w: number; h: number } => (isLineLike(kind)
  ? { shape: { kind, fill: 'none', stroke: 'ink', strokeWidth: 3, flip: 'none' }, w: 220, h: 16 }
  : { shape: { kind, fill: 'sky', stroke: 'slate', strokeWidth: 2, flip: 'none' }, ...(kind === 'circle' ? { w: 160, h: 160 } : { w: 200, h: 140 }) });

export const KIND_ICONS: Record<BoardShapeKind, React.ReactNode> = {
  rect: <rect x="4" y="6" width="16" height="12" />,
  rounded: <rect x="4" y="6" width="16" height="12" rx="3.5" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  line: <path d="M5 19L19 5" />,
  arrow: <><path d="M5 19L18 6" /><path d="M11 5.5h7.5V13" /></>,
};
const kindIcon = (kind: BoardShapeKind) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{KIND_ICONS[kind]}</svg>;

// Back to the item's grip (where the person already is: no scroll).
const toGrip = (from: HTMLElement) => from.closest('.board-item')?.querySelector<HTMLElement>('.board-item-handle')?.focus({ preventScroll: true });

/**
 * The style menu of a sticker or shape: a details element the toolbar's Style opens (its summary is not a tab stop:
 * the toolbar is the way in). Choices apply at once and the menu stays open; Escape or leaving it closes it.
 */
const DecorMenu: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={ref} className="board-decor-menu item-actions-menu"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        toGrip(event.currentTarget);
      }}>
      <summary tabIndex={-1} aria-label={label} title={label} />
      <div className="item-actions-popover" role="group" aria-label={label}>{children}</div>
    </details>
  );
};

/** A row of choices (one of them current), reachable by Tab and arrow keys. */
const Choices = <T extends string | number>({ label, value, options, onPick, swatch }: {
  label: string; value: T; options: Array<[T, string]>; onPick: (v: T) => void; swatch?: (v: T) => React.ReactNode;
}) => (
  <div className="board-decor-choices" role="group" aria-label={label}
    onKeyDown={(event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      event.preventDefault();
      buttons[(i + step + buttons.length) % buttons.length]?.focus();
    }}>
    <span className="board-decor-label" aria-hidden="true">{label}</span>
    {options.map(([v, name]) => (
      <button key={String(v)} type="button" aria-label={name} title={name} aria-pressed={value === v} data-value={v} onClick={() => onPick(v)}>
        {swatch ? swatch(v) : name}
      </button>
    ))}
  </div>
);

interface DecorCommon { phone: boolean; first: boolean; last: boolean; onMove: (direction: -1 | 1) => void; onRemove: () => void }

/** A sticker: one emoji, nothing around it. On a phone, a row with the emoji. */
export const StickerBlock: React.FC<DecorCommon & { block: Extract<BoardBlock, { type: 'sticker' }>; onEdit: (sticker: BoardSticker) => void }> = ({ block, onEdit, phone, first, last, onMove, onRemove }) => {
  const picker = (
    <div className="board-decor-emoji" role="group" aria-label="Choose an emoji">
      {TAB_EMOJI.map(([emoji, name]) => (
        <button key={emoji} type="button" aria-label={name} title={name} aria-pressed={block.sticker.emoji === emoji} onClick={() => onEdit({ emoji })}>{emoji}</button>
      ))}
    </div>
  );
  if (phone) {
    return (
      <div className="board-sticker-row">
        <span className="board-sticker-row-emoji" role="img" aria-label={`Sticker ${block.sticker.emoji}`}>{block.sticker.emoji}</span>
        <ItemActions className="board-block-menu" label="Options for this sticker">
          <MoveItems phone first={first} last={last} onMove={onMove} />
          <button type="button" onClick={onRemove}>Remove from board</button>
        </ItemActions>
      </div>
    );
  }
  return (
    // The emoji is sized from the box in CSS, so it grows with it even while being resized.
    <div className="board-sticker">
      <span className="board-sticker-emoji" role="img" aria-label={`Sticker ${block.sticker.emoji}`}>{block.sticker.emoji}</span>
      <DecorMenu label="Change emoji">{picker}</DecorMenu>
    </div>
  );
};

/** The drawing of a shape in its box (pixels: strokes never stretch). */
export const ShapeDrawing: React.FC<{ shape: BoardShape; w: number; h: number }> = ({ shape, w, h }) => {
  const sw = shape.strokeWidth;
  const paint = { className: `fill-${shape.fill} stroke-${shape.stroke}`, strokeWidth: shape.stroke === 'none' ? 0 : sw, vectorEffect: 'non-scaling-stroke' as const };
  let body: React.ReactNode;
  if (shape.kind === 'rect' || shape.kind === 'rounded') {
    const inset = shape.stroke === 'none' ? 0 : sw / 2;
    body = <rect {...paint} x={inset} y={inset} width={Math.max(0, w - inset * 2)} height={Math.max(0, h - inset * 2)} rx={shape.kind === 'rounded' ? Math.min(16, Math.min(w, h) / 4) : 0} />;
  } else if (shape.kind === 'circle') {
    const inset = shape.stroke === 'none' ? 0 : sw / 2;
    body = <ellipse {...paint} cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - inset)} ry={Math.max(0, h / 2 - inset)} />;
  } else {
    // Corner to corner (or straight across a thin box), kept inside the box by half the line and the arrowhead.
    const pad = sw / 2 + (shape.kind === 'arrow' ? sw * 2 + 3 : 0);
    const { a, b } = lineEnds({ x: pad, y: pad, w: Math.max(0, w - pad * 2), h: Math.max(0, h - pad * 2) }, shape.flip, 16 - pad * 2);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len; const uy = (b.y - a.y) / len;
    const head = shape.kind === 'arrow' ? Math.min(len * 0.6, sw * 3 + 8) : 0;
    const end = { x: b.x - ux * head * 0.8, y: b.y - uy * head * 0.8 };
    const wing = head * 0.55;
    body = (
      <>
        <line className={`stroke-${shape.stroke}`} x1={a.x} y1={a.y} x2={end.x} y2={end.y} strokeWidth={sw} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {shape.kind === 'arrow' && (
          <path className={`head-${shape.stroke}`} d={`M${b.x},${b.y} L${b.x - ux * head - uy * wing},${b.y - uy * head + ux * wing} L${b.x - ux * head + uy * wing},${b.y - uy * head - ux * wing} Z`} />
        )}
        {/* What takes the pointer: the line and 12 px around it, never the empty rest of the box. */}
        <line className="board-shape-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.max(12, sw + 8)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </>
    );
  }
  // Drawn in pixels of its saved size; while being resized it stretches to the box (lines keep their width), and is drawn exactly again once saved.
  return <svg className="board-shape-svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">{body}</svg>;
};

/** A shape on the board, with its style menu (kind, fill, line colour, width, and for lines the way they run). */
export const ShapeBlock: React.FC<{ block: Extract<BoardBlock, { type: 'shape' }>; w: number; h: number; onEdit: (shape: BoardShape) => void }> = ({ block, w, h, onEdit }) => {
  const s = block.shape;
  const lineLike = isLineLike(s.kind);
  const set = (patch: Partial<BoardShape>) => {
    const next = { ...s, ...patch };
    // A line or arrow has no fill and always a line; a box or circle shows at least one of the two.
    if (isLineLike(next.kind)) {
      next.fill = 'none';
      if (next.stroke === 'none') next.stroke = 'ink';
    } else {
      next.flip = 'none';
      // A line turned into a box or circle gets the usual fill.
      if (isLineLike(s.kind)) next.fill = 'sky';
      if (next.fill === 'none' && next.stroke === 'none') next.stroke = 'slate';
    }
    onEdit(next);
  };
  const flipH = s.flip === 'h' || s.flip === 'both';
  const flipV = s.flip === 'v' || s.flip === 'both';
  const flipTo = (h2: boolean, v2: boolean): BoardShapeFlip => (h2 && v2 ? 'both' : h2 ? 'h' : v2 ? 'v' : 'none');
  return (
    <div className={`board-shape kind-${s.kind}`}>
      <ShapeDrawing shape={s} w={w} h={h} />
      <DecorMenu label="Shape style">
        <Choices label="Shape" value={s.kind} options={SHAPE_KINDS} onPick={(kind) => set({ kind })} swatch={kindIcon} />
        {!lineLike && <Choices label="Fill" value={s.fill} options={SHAPE_COLORS} onPick={(fill) => set({ fill })} swatch={(c) => <span className={`board-decor-swatch fill-swatch-${c}`} />} />}
        <Choices label={lineLike ? 'Colour' : 'Line'} value={s.stroke} options={lineLike ? SHAPE_COLORS.filter(([c]) => c !== 'none') : SHAPE_COLORS}
          onPick={(stroke) => set({ stroke })} swatch={(c) => <span className={`board-decor-swatch line-swatch-${c}`} />} />
        <Choices label="Width" value={s.strokeWidth} options={SHAPE_WIDTHS.map(n => [n, `${n} px`] as [BoardShape['strokeWidth'], string])} onPick={(strokeWidth) => set({ strokeWidth })}
          swatch={(n) => <span className="board-decor-width" style={{ height: n }} />} />
        {lineLike && (
          <div className="board-decor-choices" role="group" aria-label="Direction">
            <span className="board-decor-label" aria-hidden="true">Flip</span>
            <button type="button" aria-pressed={flipH} onClick={() => set({ flip: flipTo(!flipH, flipV) })}>Flip horizontally</button>
            <button type="button" aria-pressed={flipV} onClick={() => set({ flip: flipTo(flipH, !flipV) })}>Flip vertically</button>
          </div>
        )}
      </DecorMenu>
    </div>
  );
};

import React, { useMemo, useRef, useState } from 'react';
import { BoardConnector } from '../services/api';
import { ConnectorShape } from '../utils/boardConnectors';
import BoardDialog from './BoardDialog';

/**
 * Connectors on the board: one SVG layer (under the cards, over shapes) that never takes the pointer itself; only
 * each line's 12 px hit stroke does. A selected connector has a small toolbar; all connectors are one Tab stop for the
 * keyboard (arrow keys between them). Connect to… lists the other items to connect an item to.
 */

export interface DrawnConnector { c: BoardConnector; shape: ConnectorShape | null; label: string; anchor: { x: number; y: number }; ends: [{ x: number; y: number }, { x: number; y: number }] }

/** One connector: memoized, so moving an item redraws only the connectors attached to it. */
const ConnectorPath = React.memo(({ id, style, x1, y1, x2, y2, head, selected, focused, onPick }: {
  id: string; style: BoardConnector['style']; x1: number; y1: number; x2: number; y2: number; head?: string; selected: boolean; focused: boolean; onPick: (id: string) => void;
}) => (
  <g className={`board-connector is-${style}${selected ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`} data-connector-id={id}>
    {(selected || focused) && <line className="board-connector-halo" x1={x1} y1={y1} x2={x2} y2={y2} />}
    <line className="board-connector-line" x1={x1} y1={y1} x2={x2} y2={y2} />
    {head && <path className="board-connector-head" d={head} />}
    <line className="board-connector-hit" x1={x1} y1={y1} x2={x2} y2={y2}
      onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); event.preventDefault(); onPick(id); }} />
  </g>
));

/** The layer itself: every connector, and the one being drawn by dragging a connect handle. */
export const ConnectorLayer: React.FC<{
  width: number; height: number; drawn: DrawnConnector[]; selected: string | null; focused: string | null;
  preview: { x1: number; y1: number; x2: number; y2: number } | null; onPick: (id: string) => void;
}> = ({ width, height, drawn, selected, focused, preview, onPick }) => (
  <svg className="board-connectors" width={width} height={height} aria-hidden="true" focusable="false">
    {drawn.map(({ c, shape, ends }) => (shape
      ? <ConnectorPath key={c.id} id={c.id} style={c.style} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} head={shape.head}
        selected={selected === c.id} focused={focused === c.id} onPick={onPick} />
      // Not drawn while its two items overlap; when it has keyboard focus or is selected, a dashed hint shows where it is.
      : (selected === c.id || focused === c.id) && <line key={c.id} className="board-connector-hidden" x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} />
    ))}
    {preview && <line className="board-connector-preview" x1={preview.x1} y1={preview.y1} x2={preview.x2} y2={preview.y2} />}
  </svg>
);

const LINE_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 18L20 6" /></svg>;
const ARROW_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18L18 7.5" /><path d="M12.5 6h7v6.5" /></svg>;
const REMOVE_ICON = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

/** The selected connector's toolbar (at its middle): Line, Arrow, Remove. Escape goes back to the connector. */
export const ConnectorToolbar: React.FC<{ c: BoardConnector; label: string; at: { x: number; y: number }; onStyle: (style: BoardConnector['style']) => void; onRemove: () => void; onBack: () => void }> = ({ c, label, at, onStyle, onRemove, onBack }) => {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onBack(); return; }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') || []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div ref={ref} className="board-item-toolbar board-connector-toolbar" role="toolbar" aria-label={`Connector: ${label}`} style={{ left: at.x, top: at.y }} onKeyDown={onKey}
      onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" data-action="line" aria-label="Line" title="Line" aria-pressed={c.style === 'line'} onClick={() => onStyle('line')}>{LINE_ICON}</button>
      <button type="button" data-action="arrow" aria-label="Arrow" title="Arrow" aria-pressed={c.style === 'arrow'} onClick={() => onStyle('arrow')}>{ARROW_ICON}</button>
      <button type="button" data-action="remove" aria-label="Remove connector" title="Remove connector" onClick={onRemove}>{REMOVE_ICON}</button>
    </div>
  );
};

/**
 * All connectors as one Tab stop ("Connectors (N)"): arrow keys move between them, Enter or Space selects one and goes
 * into its toolbar, Delete or Backspace removes it, Escape goes back to the board. A focused connector is highlighted.
 */
export const ConnectorKeys: React.FC<{
  drawn: DrawnConnector[]; active: string | null; onFocusChange: (id: string | null) => void; onSelect: (id: string) => void; onRemove: (id: string) => void; onLeave: () => void;
}> = ({ drawn, active, onFocusChange, onSelect, onRemove, onLeave }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const tabbable = (active && drawn.some(d => d.c.id === active) ? active : null) || (current && drawn.some(d => d.c.id === current) ? current : null) || drawn[0]?.c.id;
  const focusAt = (i: number) => {
    const id = drawn[(i + drawn.length) % drawn.length]?.c.id;
    if (!id) return;
    setCurrent(id);
    ref.current?.querySelector<HTMLElement>(`[data-connector-key="${id}"]`)?.focus({ preventScroll: true });
  };
  if (!drawn.length) return null;
  return (
    <div ref={ref} className="board-connector-keys" role="group" aria-label={`Connectors (${drawn.length})`}>
      {drawn.map(({ c, shape, label }, i) => (
        <button key={c.id} type="button" data-connector-key={c.id} tabIndex={c.id === tabbable ? 0 : -1}
          aria-label={shape ? label : `${label} (not drawn while the two items overlap)`}
          onFocus={() => { setCurrent(c.id); onFocusChange(c.id); }} onBlur={() => onFocusChange(null)}
          onKeyDown={(event) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
            if (step) { event.preventDefault(); focusAt(i + step); return; }
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(c.id); return; }
            if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault();
              const next = drawn[i + 1]?.c.id || drawn[i - 1]?.c.id || null;
              setCurrent(next);
              onRemove(c.id);
              if (next) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-connector-key="${next}"]`)?.focus({ preventScroll: true }));
              else onLeave();
              return;
            }
            if (event.key === 'Escape') { event.preventDefault(); onLeave(); }
          }}>{label}</button>
      ))}
    </div>
  );
};

/**
 * Connect to…: every other item on the board by its short name, filtered as you type. Arrows already made from this
 * item to one of them are marked and cannot be picked again. Picking one makes an arrow (it can become a line after).
 */
export const ConnectChooser: React.FC<{ sourceName: string; options: Array<{ key: string; name: string; taken: boolean }>; onPick: (key: string) => void; onClose: () => void }> = ({ sourceName, options, onPick, onClose }) => {
  const [filter, setFilter] = useState('');
  const list = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return words ? options.filter(o => o.name.toLowerCase().includes(words)) : options;
  }, [filter, options]);
  const listRef = useRef<HTMLUListElement>(null);
  const move = (from: HTMLElement | null, step: number) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    if (!items.length) return;
    const i = from ? items.indexOf(from as HTMLButtonElement) : -1;
    items[i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length]?.focus();
  };
  return (
    <BoardDialog title={`Connect “${sourceName}” to…`} describedBy="board-connect-help" onClose={onClose}>
      <p id="board-connect-help" className="board-connect-help">An arrow goes from this item to the one you choose. You can make it a line afterwards.</p>
      <input className="board-connect-filter" type="search" value={filter} placeholder="Find an item" aria-label="Find an item" data-autofocus
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); move(null, 1); } }} />
      <ul ref={listRef} className="board-connect-list" aria-label="Items on this board">
        {list.map(o => (
          <li key={o.key}>
            <button type="button" disabled={o.taken} data-connect-target={o.key} onClick={() => onPick(o.key)}
              onKeyDown={(event) => {
                const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
                if (step) { event.preventDefault(); move(event.currentTarget, step); }
              }}>
              {o.name}{o.taken && <span className="board-connect-taken"> · already connected</span>}
            </button>
          </li>
        ))}
        {!list.length && <li className="board-connect-none">No items match.</li>}
      </ul>
    </BoardDialog>
  );
};

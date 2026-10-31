import React, { useEffect, useRef, useState } from 'react';
import { BoardAppearance } from '../services/api';
import { BOARD_PATTERNS, BOARD_TONES } from '../utils/boardTabs';

/**
 * "Canvas": how this tab's board looks — a subtle pattern and a tone. Two real radio groups (arrow keys move
 * between choices, as in any radio group); a choice is applied and saved at once. Escape closes it.
 */
const BoardAppearanceMenu: React.FC<{ value: BoardAppearance; onChange: (next: BoardAppearance) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    setTimeout(() => wrap.current?.querySelector<HTMLInputElement>('input:checked')?.focus(), 0);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };
  return (
    <div ref={wrap} className="board-look" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }}
      onBlur={(event) => { if (open && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget) setOpen(false); }}>
      <button ref={button} type="button" className="file-action-button board-look-button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(o => !o)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><circle cx="9" cy="9" r="1.2" fill="currentColor" /><circle cx="15" cy="9" r="1.2" fill="currentColor" /><circle cx="9" cy="15" r="1.2" fill="currentColor" /><circle cx="15" cy="15" r="1.2" fill="currentColor" /></svg>
        Canvas
      </button>
      {open && (
        <div className="board-look-panel" role="group" aria-label="Canvas look for this tab">
          <fieldset className="board-look-set">
            <legend>Pattern</legend>
            <div className="board-look-options">
              {BOARD_PATTERNS.map(([id, label]) => (
                <label key={id} className="board-look-option">
                  <input type="radio" name="board-pattern" value={id} checked={value.pattern === id} onChange={() => onChange({ ...value, pattern: id })} />
                  <span className={`board-look-swatch pattern-${id} tone-${value.tone}`} aria-hidden="true" />
                  <span className="board-look-name">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="board-look-set">
            <legend>Tone</legend>
            <div className="board-look-options">
              {BOARD_TONES.map(([id, label]) => (
                <label key={id} className="board-look-option">
                  <input type="radio" name="board-tone" value={id} checked={value.tone === id} onChange={() => onChange({ ...value, tone: id })} />
                  <span className={`board-look-swatch pattern-blank tone-${id}`} aria-hidden="true" />
                  <span className="board-look-name">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="board-look-note">Only this tab changes. Files and notes stay where they are.</p>
        </div>
      )}
    </div>
  );
};

export default BoardAppearanceMenu;

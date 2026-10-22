import React, { useEffect, useRef, useState } from 'react';
import { useAppearance } from '../context/AppearanceContext';
import { isHexColor } from '../theme/accent';
import { isDark } from '../theme/appearance';
import { CheckIcon } from './Icons';
import './TopBarColor.css';

const SWATCHES = ['#fdfdfb', '#eef2e7', '#dbeafe', '#e0f2f1', '#ede9fe', '#fce7f3', '#fee2e2', '#fef3c7', '#1f2937', '#3f6543'];

/** The paint button in the top bar: choose the top bar's color right where it shows (also in Customize > Colors). */
const TopBarColor: React.FC = () => {
  const { appearance, update } = useAppearance();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = appearance.headerColor;

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [open]);

  const choose = (headerColor: string | null) => update({ headerColor });

  return (
    <div className="topbar-color" ref={ref}>
      <button className="topbar-color-button" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open} title="Top bar color" aria-label="Top bar color">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.7 1.8-1.7h2.1A4.3 4.3 0 0 0 21 11c0-4.4-4-8-9-8Z" />
          <circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="7.5" r="1" />
        </svg>
      </button>
      {open && (
        <div className="topbar-color-popover" role="dialog" aria-label="Top bar color">
          <strong>Top bar color</strong>
          <div className="topbar-color-swatches fb-true-color">
            {SWATCHES.map(color => (
              <button key={color} style={{ background: color, color: isDark(color) ? '#fff' : '#1f2937' }} onClick={() => choose(color)} aria-label={color} aria-pressed={current === color} title={color.toUpperCase()}>
                {current === color && <CheckIcon size={12} />}
              </button>
            ))}
          </div>
          <label className="topbar-color-custom">
            <input type="color" className="fb-true-color" value={current || '#fdfdfb'} onChange={(event) => { if (isHexColor(event.target.value)) choose(event.target.value.toLowerCase()); }} />
            <span>Any color… <small>{current ? current.toUpperCase() : 'Default'}</small></span>
          </label>
          <button className="btn-secondary topbar-color-default" onClick={() => choose(null)} disabled={!current}>Use default</button>
        </div>
      )}
    </div>
  );
};

export default TopBarColor;

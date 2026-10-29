import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small modal dialog: focus stays inside, Escape closes it, focus goes back where it came from. Drawn on
 * the page body, so nothing on the page (a background layer, the Ask File Box button) can sit above it.
 */
const BoardDialog: React.FC<{ title: string; describedBy?: string; wide?: boolean; onClose: () => void; children: React.ReactNode }> = ({ title, describedBy, wide = false, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  // Where focus was before the dialog opened (taken once, before the dialog moves it).
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null) opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const node = ref.current;
    const back = opener.current;
    (node?.querySelector<HTMLElement>('[data-autofocus]') || node?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)'))?.focus();
    // Back to the opener only once the dialog has really left the page (React may unmount and remount it
    // in development), and not when something else already took focus (a new tab that was just created).
    return () => {
      setTimeout(() => {
        const free = !document.activeElement || document.activeElement === document.body;
        if (!node?.isConnected && free && back?.isConnected) back.focus();
      }, 0);
    };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return createPortal(
    <div className="boards-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className={`boards-dialog ${wide ? 'is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="boards-dialog-title" aria-describedby={describedBy} onKeyDown={onKeyDown}>
        <h2 id="boards-dialog-title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
};

export default BoardDialog;

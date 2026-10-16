import React from 'react';

const ItemActions: React.FC<{ label: string; className: string; children: React.ReactNode }> = ({ label, className, children }) => (
  <details className={`${className} item-actions-menu`}
    onClick={event => {
      event.stopPropagation();
      if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false;
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
    }}>
    <summary aria-label={label} title={label}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
    </summary>
    <div className="item-actions-popover">{children}</div>
  </details>
);

export default ItemActions;

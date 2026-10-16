import React, { useEffect, useRef, useState } from 'react';

export interface DocumentMenuItem {
  label: string;
  onSelect: () => void;
  shortcut?: string;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}

export interface DocumentMenu {
  label: string;
  items: DocumentMenuItem[];
}

interface MenuBarProps {
  menus: DocumentMenu[];
}

const MenuBar: React.FC<MenuBarProps> = ({ menus }) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickAway = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickAway);
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  return (
    <div className="doc-menu-bar" ref={rootRef}>
      {menus.map((menu) => {
        const isOpen = openMenu === menu.label;

        return (
          <div key={menu.label} className="doc-menu">
            <button
              type="button"
              className={`doc-menu__trigger ${isOpen ? 'is-open' : ''}`}
              onClick={() => setOpenMenu(isOpen ? null : menu.label)}
            >
              {menu.label}
            </button>

            {isOpen && (
              <div className="doc-menu__dropdown">
                {menu.items.map((item) => (
                  <button
                    key={`${menu.label}-${item.label}`}
                    type="button"
                    className={`doc-menu__item ${item.tone === 'danger' ? 'is-danger' : ''}`}
                    onClick={() => {
                      setOpenMenu(null);
                      item.onSelect();
                    }}
                    disabled={item.disabled}
                  >
                    <span>{item.label}</span>
                    {item.shortcut ? <span className="doc-menu__shortcut">{item.shortcut}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default MenuBar;

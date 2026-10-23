import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAppearance } from '../context/AppearanceContext';
import { SidebarLayout } from '../theme/appearance';
import { workspacePages } from '../config/workspaceNavigation';
import Logo from './Logo';
import { formatBytes } from '../utils/fileDisplay';
import {
  HomeIcon, FilesIcon, SharedIcon, RecentIcon, StarredIcon, AIAssistantIcon, TeamFoldersIcon,
  FileRequestsIcon, SignatureIcon, CloudBackupIcon, TrashIcon, SettingsIcon, BackIcon, PlusIcon,
  UploadIcon, FolderIcon,
} from './Icons';
import './Sidebar.css';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  onNavigateUp: () => void;
  onUploadFiles: (files: File[]) => void;
  onNewFolder: () => void;
  currentFolderId?: string;
  mobileOpen: boolean;
  onClose: () => void;
}

export type NavItem = { id: string; Icon: React.FC<{ size?: number }> };
export type NavSection = { id: string; title?: string; items: NavItem[] };

export const sidebarSections: NavSection[] = [
  {
    id: 'main',
    items: [
      { id: 'home', Icon: HomeIcon }, { id: 'files', Icon: FilesIcon }, { id: 'shared', Icon: SharedIcon },
      { id: 'recent', Icon: RecentIcon }, { id: 'starred', Icon: StarredIcon },
    ],
  },
  { id: 'ai', title: 'AI', items: [{ id: 'ai-assistant', Icon: AIAssistantIcon }] },
  { id: 'collaboration', title: 'Collaboration', items: [{ id: 'teams', Icon: TeamFoldersIcon }, { id: 'requests', Icon: FileRequestsIcon }] },
  { id: 'tools', title: 'Tools', items: [{ id: 'signatures', Icon: SignatureIcon }, { id: 'cloud-backup', Icon: CloudBackupIcon }] },
  { id: 'end', items: [{ id: 'trash', Icon: TrashIcon }] },
];

export const navLabel = (id: string, layout: SidebarLayout) => layout.labels[id]?.trim() || workspacePages.find(page => page.id === id)?.label || id;
export const sectionTitle = (section: NavSection, layout: SidebarLayout) => layout.sectionTitles[section.id]?.trim() || section.title;

/** A section's items in the order chosen in Settings > Customize (new items keep their place at the end). */
export const orderedItems = (section: NavSection, layout: SidebarLayout) => {
  const rank = (item: NavItem, index: number) => {
    const chosen = layout.order.indexOf(item.id);
    return chosen === -1 ? 1000 + index : chosen;
  };
  return section.items.map((item, index) => ({ item, rank: rank(item, index) })).sort((a, b) => a.rank - b.rank).map(({ item }) => item);
};

const Sidebar: React.FC<SidebarProps> = ({
  currentView, onViewChange, onNavigateUp, onUploadFiles, onNewFolder, currentFolderId, mobileOpen, onClose,
}) => {
  const { user, logout, isLocalPreview } = useAuth();
  const { appearance } = useAppearance();
  const layout = appearance.sidebar;
  const iconsOnly = layout.style === 'icons';
  const brandName = appearance.brandName.trim() || 'File Box';
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    sidebarRef.current?.querySelector<HTMLButtonElement>('nav button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const buttons = Array.from(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button') || []).filter(button => button.offsetParent !== null);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); opener?.focus(); };
  }, [mobileOpen, onClose]);

  useEffect(() => {
    if (!newMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setNewMenuOpen(false); };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [newMenuOpen]);

  const storagePercent = user?.storageLimit ? Math.min(100, (user.storageUsed / user.storageLimit) * 100) : 0;
  const initials = (user?.name || 'Workspace').split(' ').map(part => part[0]).slice(0, 2).join('');

  const go = (id: string) => { onViewChange(id); onClose(); };
  const renderItem = ({ id, Icon }: NavItem) => (
    <button key={id} className={`nav-item ${currentView === id ? 'active' : ''}`}
      aria-current={currentView === id ? 'page' : undefined} onClick={() => go(id)}
      title={iconsOnly ? navLabel(id, layout) : undefined} aria-label={iconsOnly ? navLabel(id, layout) : undefined}>
      <Icon size={18} /><span>{navLabel(id, layout)}</span>
      {currentView === id && <span className="nav-active-dot" aria-hidden="true" />}
    </button>
  );

  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" onClick={onClose} aria-label="Close navigation" />}
      <aside ref={sidebarRef} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label={mobileOpen ? 'Workspace navigation' : undefined} id="workspace-navigation" className={`sidebar ${mobileOpen ? 'sidebar-open' : ''} ${iconsOnly ? 'sidebar-icons' : ''}`}>
        <div className="sidebar-header">
          <button className="brand-home" onClick={() => go('home')} aria-label={`${brandName} home`}><Logo size="small" text={brandName} /></button>
          <button className="sidebar-close" onClick={onClose} aria-label="Close navigation">×</button>
        </div>

        <div className="sidebar-new" ref={newMenuRef}>
          <button className="sidebar-new-button" title={iconsOnly ? 'New' : undefined} aria-haspopup="menu" aria-expanded={newMenuOpen} onClick={() => setNewMenuOpen(!newMenuOpen)}>
            <PlusIcon size={16} /><span>New</span>
          </button>
          {newMenuOpen && (
            <div className="sidebar-new-menu" role="menu">
              <button role="menuitem" onClick={() => { setNewMenuOpen(false); uploadInputRef.current?.click(); }}>
                <UploadIcon size={16} /><span>Upload files</span>
              </button>
              <button role="menuitem" onClick={() => { setNewMenuOpen(false); onNewFolder(); onClose(); }}>
                <FolderIcon size={16} /><span>New folder</span>
              </button>
            </div>
          )}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = '';
              if (files.length) { onUploadFiles(files); onClose(); }
            }}
          />
        </div>

        <nav className="sidebar-nav" aria-label="Workspace">
          {sidebarSections.map(section => {
            const items = orderedItems(section, layout).filter(item => !layout.hidden.includes(item.id));
            const title = layout.showSectionTitles ? sectionTitle(section, layout) : undefined;
            if (!items.length) return null;
            return (
              <div className="nav-section" key={section.id}>
                {title && <div className="nav-section-title">{title}</div>}
                {items.map(renderItem)}
              </div>
            );
          })}
        </nav>

        {currentView === 'files' && currentFolderId && currentFolderId !== 'root' && (
          <button className="nav-item sidebar-parent" onClick={onNavigateUp}><BackIcon size={18} /><span>Parent folder</span></button>
        )}

        <div className="sidebar-footer">
          <button className={`sidebar-storage-info ${currentView === 'storage' ? 'active' : ''}`} onClick={() => go('storage')} aria-label="Storage usage" aria-current={currentView === 'storage' ? 'page' : undefined}>
            <span className="sidebar-storage-text"><span>Storage</span>{formatBytes(user?.storageUsed || 0)} of {formatBytes(user?.storageLimit || 0)}</span>
            <span className="sidebar-storage-bar" role="progressbar" aria-valuenow={Math.round(storagePercent)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used"><span className="sidebar-storage-bar-fill" style={{ width: `${storagePercent}%` }} /></span>
          </button>
          <button className={`nav-item sidebar-settings ${currentView === 'settings' ? 'active' : ''}`} aria-current={currentView === 'settings' ? 'page' : undefined} onClick={() => go('settings')} title={iconsOnly ? 'Settings' : undefined} aria-label={iconsOnly ? 'Settings' : undefined}>
            <SettingsIcon size={18} /><span>Settings</span>
          </button>
          <div className="sidebar-user-info"><span className="sidebar-user-avatar" aria-hidden="true">{initials}</span><div className="sidebar-user-details"><div className="sidebar-user-name">{user?.name}</div><span>{isLocalPreview ? 'Personal account' : user?.email}</span></div>
            {!isLocalPreview && <button onClick={logout} className="sidebar-logout-button" title="Sign out" aria-label="Sign out">↪</button>}
          </div>
        </div>
      </aside>
    </>
  );
};
export default Sidebar;

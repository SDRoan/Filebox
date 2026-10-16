import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { workspacePages } from '../config/workspaceNavigation';
import Logo from './Logo';
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

type NavItem = { id: string; Icon: React.FC<{ size?: number }> };

const sections: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { id: 'home', Icon: HomeIcon }, { id: 'files', Icon: FilesIcon }, { id: 'shared', Icon: SharedIcon },
      { id: 'recent', Icon: RecentIcon }, { id: 'starred', Icon: StarredIcon },
    ],
  },
  { title: 'AI', items: [{ id: 'ai-assistant', Icon: AIAssistantIcon }] },
  { title: 'Collaboration', items: [{ id: 'teams', Icon: TeamFoldersIcon }, { id: 'requests', Icon: FileRequestsIcon }] },
  { title: 'Tools', items: [{ id: 'signatures', Icon: SignatureIcon }, { id: 'cloud-backup', Icon: CloudBackupIcon }] },
  { items: [{ id: 'trash', Icon: TrashIcon }] },
];

const Sidebar: React.FC<SidebarProps> = ({
  currentView, onViewChange, onNavigateUp, onUploadFiles, onNewFolder, currentFolderId, mobileOpen, onClose,
}) => {
  const { user, logout, isLocalPreview } = useAuth();
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

  const formatStorage = (bytes: number) => bytes === 0 ? '0 GB' : `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  const storagePercent = user?.storageLimit ? Math.min(100, (user.storageUsed / user.storageLimit) * 100) : 0;
  const initials = (user?.name || 'Workspace').split(' ').map(part => part[0]).slice(0, 2).join('');

  const go = (id: string) => { onViewChange(id); onClose(); };
  const renderItem = ({ id, Icon }: NavItem) => (
    <button key={id} className={`nav-item ${currentView === id ? 'active' : ''}`}
      aria-current={currentView === id ? 'page' : undefined} onClick={() => go(id)}>
      <Icon size={18} /><span>{workspacePages.find(page => page.id === id)?.label}</span>
      {currentView === id && <span className="nav-active-dot" aria-hidden="true" />}
    </button>
  );

  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" onClick={onClose} aria-label="Close navigation" />}
      <aside ref={sidebarRef} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label={mobileOpen ? 'Workspace navigation' : undefined} id="workspace-navigation" className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <button className="brand-home" onClick={() => go('home')} aria-label="File Box home"><Logo size="small" /></button>
          <button className="sidebar-close" onClick={onClose} aria-label="Close navigation">×</button>
        </div>

        <div className="sidebar-new" ref={newMenuRef}>
          <button className="sidebar-new-button" aria-haspopup="menu" aria-expanded={newMenuOpen} onClick={() => setNewMenuOpen(!newMenuOpen)}>
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
          {sections.map((section, index) => (
            <div className="nav-section" key={section.title || index}>
              {section.title && <div className="nav-section-title">{section.title}</div>}
              {section.items.map(renderItem)}
            </div>
          ))}
        </nav>

        {currentView === 'files' && currentFolderId && currentFolderId !== 'root' && (
          <button className="nav-item sidebar-parent" onClick={onNavigateUp}><BackIcon size={18} /><span>Parent folder</span></button>
        )}

        <div className="sidebar-footer">
          <div className="sidebar-storage-info" aria-label="Storage usage">
            <p><span>Storage</span>{formatStorage(user?.storageUsed || 0)} of {formatStorage(user?.storageLimit || 0)}</p>
            <div className="sidebar-storage-bar" role="progressbar" aria-valuenow={Math.round(storagePercent)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used"><div className="sidebar-storage-bar-fill" style={{ width: `${storagePercent}%` }} /></div>
          </div>
          <button className={`nav-item sidebar-settings ${currentView === 'settings' ? 'active' : ''}`} aria-current={currentView === 'settings' ? 'page' : undefined} onClick={() => go('settings')}>
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

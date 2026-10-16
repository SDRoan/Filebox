import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { workspacePages } from '../config/workspaceNavigation';
import Logo from './Logo';
import {
  FilesIcon, SharedIcon, StarredIcon, TrashIcon, TeamFoldersIcon, FileRequestsIcon,
  RelationshipsIcon, AnalyticsIcon, SecurityIcon, AIAssistantIcon,
  StudentIcon, BackIcon, TemplateIcon, ShortcutIcon, IntegrationIcon, LearningIcon, CloudBackupIcon,
} from './Icons';
import './Sidebar.css';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  onNavigateUp: () => void;
  currentFolderId?: string;
  mobileOpen: boolean;
  onClose: () => void;
}

const primaryItems = [
  { id: 'files', Icon: FilesIcon }, { id: 'shared', Icon: SharedIcon },
  { id: 'starred', Icon: StarredIcon }, { id: 'trash', Icon: TrashIcon },
];
const workspaceItems = [
  { id: 'teams', Icon: TeamFoldersIcon }, { id: 'student', Icon: StudentIcon },
  { id: 'learning', Icon: LearningIcon },
];
const toolItems = [
  { id: 'requests', Icon: FileRequestsIcon }, { id: 'relationships', Icon: RelationshipsIcon },
  { id: 'templates', Icon: TemplateIcon }, { id: 'shortcuts', Icon: ShortcutIcon },
  { id: 'secured-links', Icon: SecurityIcon }, { id: 'cloud-backup', Icon: CloudBackupIcon },
  { id: 'analytics', Icon: AnalyticsIcon }, { id: 'security', Icon: SecurityIcon },
  { id: 'integrations', Icon: IntegrationIcon }, { id: 'ai-assistant', Icon: AIAssistantIcon },
];

const Sidebar: React.FC<SidebarProps> = ({ currentView, onViewChange, onNavigateUp, currentFolderId, mobileOpen, onClose }) => {
  const { user, logout, isLocalPreview } = useAuth();
  const [toolsOpen, setToolsOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
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
    if (toolItems.some(item => item.id === currentView)) setToolsOpen(true);
  }, [currentView]);
  const formatStorage = (bytes: number) => bytes === 0 ? '0 GB' : `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  const storagePercent = user?.storageLimit ? Math.min(100, (user.storageUsed / user.storageLimit) * 100) : 0;
  const initials = (user?.name || 'Workspace').split(' ').map(part => part[0]).slice(0, 2).join('');
  const renderItem = ({ id, Icon }: typeof primaryItems[number]) => (
    <button key={id} className={`nav-item ${currentView === id ? 'active' : ''}`}
      aria-current={currentView === id ? 'page' : undefined} onClick={() => { onViewChange(id); onClose(); }}>
      <Icon size={18} /><span>{workspacePages.find(page => page.id === id)?.label}</span>
      {currentView === id && <span className="nav-active-dot" aria-hidden="true" />}
    </button>
  );
  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" onClick={onClose} aria-label="Close navigation" />}
      <aside ref={sidebarRef} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label={mobileOpen ? 'Workspace navigation' : undefined} id="workspace-navigation" className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <button className="brand-home" onClick={() => { onViewChange('files'); onClose(); }} aria-label="File Box home"><Logo size="small" /></button>
          <button className="sidebar-close" onClick={onClose} aria-label="Close navigation">×</button>
        </div>
        <div className="workspace-label"><span className="workspace-mark">W</span><div>Personal workspace<span>Just for you</span></div></div>
        <nav className="sidebar-nav" aria-label="Workspace">
          <div className="nav-section"><div className="nav-section-title">Library</div>{primaryItems.map(renderItem)}</div>
          <div className="nav-section"><div className="nav-section-title">Work & study</div>{workspaceItems.map(renderItem)}</div>
          <div className="nav-section tools-section">
            <button className="tools-toggle" aria-expanded={toolsOpen} aria-controls="workspace-tools" onClick={() => setToolsOpen(!toolsOpen)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/></svg>
              <span>More tools</span><span className={`tools-chevron ${toolsOpen ? 'open' : ''}`} aria-hidden="true">⌄</span>
            </button>
            <div id="workspace-tools" hidden={!toolsOpen}>{toolItems.map(renderItem)}</div>
          </div>
        </nav>
        {currentFolderId && currentFolderId !== 'root' && <button className="nav-item" onClick={onNavigateUp}><BackIcon size={18} /><span>Parent folder</span></button>}
        <div className="sidebar-footer">
          <div className="sidebar-storage-info"><div className="sidebar-storage-label"><span>Storage</span><span>{Math.round(storagePercent)}%</span></div>
            <div className="sidebar-storage-bar"><div className="sidebar-storage-bar-fill" style={{ width: `${storagePercent}%` }} /></div>
            <p>{formatStorage(user?.storageUsed || 0)} of {formatStorage(user?.storageLimit || 0)} used</p>
          </div>
          <div className="sidebar-user-info"><span className="sidebar-user-avatar" aria-hidden="true">{initials}</span><div className="sidebar-user-details"><div className="sidebar-user-name">{user?.name}</div><span>{isLocalPreview ? 'Personal account' : user?.email}</span></div>
            {!isLocalPreview && <button onClick={logout} className="sidebar-logout-button" title="Sign out" aria-label="Sign out">↪</button>}
          </div>
        </div>
      </aside>
    </>
  );
};
export default Sidebar;

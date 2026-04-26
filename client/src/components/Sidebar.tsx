import React from 'react';
import { useAuth } from '../context/AuthContext';
import Logo from './Logo';
import {
  HomeIcon,
  FilesIcon,
  SharedIcon,
  StarredIcon,
  TrashIcon,
  TeamFoldersIcon,
  FileRequestsIcon,
  RelationshipsIcon,
  AnalyticsIcon,
  SecurityIcon,
  AIAssistantIcon,
  StudentIcon,
  BackIcon,
  CloseIcon,
  TemplateIcon,
  ShortcutIcon,
  IntegrationIcon,
  CloudBackupIcon,
} from './Icons';
import './Sidebar.css';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  onNavigateUp: () => void;
  currentFolderId?: string;
  isOpen?: boolean;
  onClose?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onViewChange,
  onNavigateUp,
  currentFolderId,
  isOpen = false,
  onClose,
}) => {
  const { user, logout } = useAuth();

  const formatStorage = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  const storagePercent = user
    ? (user.storageUsed / user.storageLimit) * 100
    : 0;
  const storageFillWidth = Math.min(Math.max(storagePercent, 0), 100);
  const userInitials = user?.name
    ? user.name
        .split(' ')
        .map(part => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'FB';

  const handleNavigation = (view: string) => {
    onViewChange(view);
    if (window.innerWidth <= 1024) {
      onClose?.();
    }
  };

  const handleNavigateUp = () => {
    onNavigateUp();
    if (window.innerWidth <= 1024) {
      onClose?.();
    }
  };

  return (
    <aside className={`sidebar ${isOpen ? 'is-open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-kicker">Cloud storage</span>
          <Logo size="small" showText={true} text="File Box" />
        </div>
        <button
          type="button"
          className="sidebar-close-button"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <CloseIcon size={18} color="currentColor" />
        </button>
      </div>
      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-title">Drive</div>
          <button
            className={`nav-item ${currentView === 'home' ? 'active' : ''}`}
            onClick={() => handleNavigation('home')}
          >
            <HomeIcon size={18} color="currentColor" />
            <span>Home</span>
          </button>
          <button
            className={`nav-item ${currentView === 'files' ? 'active' : ''}`}
            onClick={() => handleNavigation('files')}
          >
            <FilesIcon size={18} color="currentColor" />
            <span>All Files</span>
          </button>
          <button
            className={`nav-item ${currentView === 'shared' ? 'active' : ''}`}
            onClick={() => handleNavigation('shared')}
          >
            <SharedIcon size={18} color="currentColor" />
            <span>Shared</span>
          </button>
          <button
            className={`nav-item ${currentView === 'starred' ? 'active' : ''}`}
            onClick={() => handleNavigation('starred')}
          >
            <StarredIcon size={18} color="currentColor" />
            <span>Starred</span>
          </button>
          <button
            className={`nav-item ${currentView === 'trash' ? 'active' : ''}`}
            onClick={() => handleNavigation('trash')}
          >
            <TrashIcon size={18} color="currentColor" />
            <span>Trash</span>
          </button>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">Sharing</div>
          <button
            className={`nav-item ${currentView === 'teams' ? 'active' : ''}`}
            onClick={() => handleNavigation('teams')}
          >
            <TeamFoldersIcon size={18} color="currentColor" />
            <span>Team Spaces</span>
          </button>
          <button
            className={`nav-item ${currentView === 'requests' ? 'active' : ''}`}
            onClick={() => handleNavigation('requests')}
          >
            <FileRequestsIcon size={18} color="currentColor" />
            <span>File Requests</span>
          </button>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">Protect</div>
          <button
            className={`nav-item ${currentView === 'cloud-backup' ? 'active' : ''}`}
            onClick={() => handleNavigation('cloud-backup')}
          >
            <CloudBackupIcon size={18} color="currentColor" />
            <span>Cloud Backup</span>
          </button>
          <button
            className={`nav-item ${currentView === 'secured-links' ? 'active' : ''}`}
            onClick={() => handleNavigation('secured-links')}
          >
            <SecurityIcon size={18} color="currentColor" />
            <span>Secured Links</span>
          </button>
          <button
            className={`nav-item ${currentView === 'security' ? 'active' : ''}`}
            onClick={() => handleNavigation('security')}
          >
            <SecurityIcon size={18} color="currentColor" />
            <span>Security</span>
          </button>
        </div>

        <div className="nav-section secondary">
          <div className="nav-section-title">Tools</div>
          <button
            className={`nav-item ${currentView === 'analytics' ? 'active' : ''}`}
            onClick={() => handleNavigation('analytics')}
          >
            <AnalyticsIcon size={18} color="currentColor" />
            <span>Analytics</span>
          </button>
          <button
            className={`nav-item ${currentView === 'ai-assistant' ? 'active' : ''}`}
            onClick={() => handleNavigation('ai-assistant')}
          >
            <AIAssistantIcon size={18} color="currentColor" />
            <span>AI Assistant</span>
          </button>
          <button
            className={`nav-item ${currentView === 'templates' ? 'active' : ''}`}
            onClick={() => handleNavigation('templates')}
          >
            <TemplateIcon size={18} color="currentColor" />
            <span>Templates</span>
          </button>
          <button
            className={`nav-item ${currentView === 'shortcuts' ? 'active' : ''}`}
            onClick={() => handleNavigation('shortcuts')}
          >
            <ShortcutIcon size={18} color="currentColor" />
            <span>Shortcuts</span>
          </button>
          <button
            className={`nav-item ${currentView === 'relationships' ? 'active' : ''}`}
            onClick={() => handleNavigation('relationships')}
          >
            <RelationshipsIcon size={18} color="currentColor" />
            <span>Connections</span>
          </button>
          <button
            className={`nav-item ${currentView === 'integrations' ? 'active' : ''}`}
            onClick={() => handleNavigation('integrations')}
          >
            <IntegrationIcon size={18} color="currentColor" />
            <span>Integrations</span>
          </button>
          <button
            className={`nav-item ${currentView === 'student' ? 'active' : ''}`}
            onClick={() => handleNavigation('student')}
          >
            <StudentIcon size={18} color="currentColor" />
            <span>Student</span>
          </button>
        </div>
      </nav>
      {currentFolderId && currentFolderId !== 'root' && (
        <button className="nav-item sidebar-back-button" onClick={handleNavigateUp}>
          <BackIcon size={18} color="currentColor" />
          <span>Back</span>
        </button>
      )}
      <div className="sidebar-footer">
        <div className="storage-info">
          <div className="storage-meta">
            <span>Drive usage</span>
            <strong>{Math.round(storageFillWidth)}%</strong>
          </div>
          <div className="storage-label">
            {formatStorage(user?.storageUsed || 0)} used of{' '}
            {formatStorage(user?.storageLimit || 0)}
          </div>
          <div className="storage-bar">
            <div
              className="storage-bar-fill"
              style={{ width: `${storageFillWidth}%` }}
            />
          </div>
        </div>
        <div className="user-info">
          <div className="user-meta">
            <div className="user-avatar">{userInitials}</div>
            <div className="user-copy">
              <div className="user-name">{user?.name || 'Workspace owner'}</div>
              <div className="user-role">Cloud drive workspace</div>
            </div>
          </div>
          <button onClick={logout} className="logout-button">
            Logout
          </button>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;

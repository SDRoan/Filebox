import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import FileBrowser from './FileBrowser';
import SearchBar from './SearchBar';
import StorageHome from './StorageHome';
import TeamFolders from './TeamFolders';
import FileRequests from './FileRequests';
import RelationshipGraph from './RelationshipGraph';
import AnalyticsDashboard from './AnalyticsDashboard';
import RelationshipsList from './RelationshipsList';
import SecurityDashboard from './SecurityDashboard';
import StudentDashboard from './StudentDashboard';
import AIAssistant from './AIAssistant';
import SharedFiles from './SharedFiles';
import TemplatesLibrary from './TemplatesLibrary';
import WebShortcuts from './WebShortcuts';
import SecuredLinks from './SecuredLinks';
import CloudBackup from './CloudBackup';
import Integrations from './Integrations';
import { FileItemType } from '../types';
import './Dashboard.css';

const VIEW_META: Record<string, { eyebrow: string; title: string; description: string; chip: string }> = {
  home: {
    eyebrow: 'Drive',
    title: 'Home',
    description: 'Your drive overview: recent files, storage usage, sharing, backup, and recovery in one place.',
    chip: 'Drive',
  },
  files: {
    eyebrow: 'Drive',
    title: 'All files',
    description: 'Browse the library the way a cloud drive should: upload, sort, move, and share from one explorer.',
    chip: 'Explorer',
  },
  shared: {
    eyebrow: 'Shared',
    title: 'Shared',
    description: 'See what was shared with you and keep track of the files you have handed off.',
    chip: 'Access',
  },
  starred: {
    eyebrow: 'Drive',
    title: 'Starred files',
    description: 'Keep frequently used files and folders within one click.',
    chip: 'Pinned',
  },
  trash: {
    eyebrow: 'Recovery',
    title: 'Recovery bin',
    description: 'Restore what still matters or permanently clear out what no longer belongs.',
    chip: '30-day hold',
  },
  teams: {
    eyebrow: 'Collaboration',
    title: 'Team spaces',
    description: 'Shared folders and access for teams that need a cleaner handoff flow.',
    chip: 'Collaborative',
  },
  requests: {
    eyebrow: 'Sharing',
    title: 'File requests',
    description: 'Collect incoming files through request links and keep uploads organized.',
    chip: 'External',
  },
  relationships: {
    eyebrow: 'Connections',
    title: 'File relationships',
    description: 'Surface how documents, notes, and versions connect across your workspace.',
    chip: 'Mapped',
  },
  security: {
    eyebrow: 'Protect',
    title: 'Security dashboard',
    description: 'Monitor access, classification, and controls around sensitive files.',
    chip: 'Protected',
  },
  student: {
    eyebrow: 'Student OS',
    title: 'Student workspace',
    description: 'Course folders, assignments, notes, and study tools in one focused layout.',
    chip: 'Academic',
  },
  'ai-assistant': {
    eyebrow: 'Copilot',
    title: 'AI assistant',
    description: 'Ask questions, summarize context, and move faster through the archive.',
    chip: 'AI ready',
  },
  templates: {
    eyebrow: 'Tools',
    title: 'Templates library',
    description: 'Reusable starting points for documents, workflows, and common tasks.',
    chip: 'Reusable',
  },
  shortcuts: {
    eyebrow: 'Web links',
    title: 'Shortcuts',
    description: 'Keep external resources close to the files and folders they support.',
    chip: 'Curated',
  },
  'secured-links': {
    eyebrow: 'Protect',
    title: 'Secured links',
    description: 'Manage password-protected and encrypted share links from one controlled surface.',
    chip: 'Controlled',
  },
  'cloud-backup': {
    eyebrow: 'Protect',
    title: 'Cloud backup',
    description: 'See backup status, close coverage gaps, and make the storage layer dependable.',
    chip: 'Synced',
  },
  integrations: {
    eyebrow: 'Tools',
    title: 'Integrations',
    description: 'Bring your workflow together with services that belong in the same orbit.',
    chip: 'Connected',
  },
  analytics: {
    eyebrow: 'Drive',
    title: 'Analytics',
    description: 'Inspect storage usage, activity patterns, and cleanup opportunities.',
    chip: 'Signals',
  },
};

const VIEW_PATHS: Record<string, string> = {
  home: '/',
  files: '/files',
  shared: '/shared-files',
  starred: '/starred',
  trash: '/trash',
  teams: '/team-folders',
  requests: '/file-requests',
  relationships: '/relationships',
  security: '/security',
  student: '/student',
  'ai-assistant': '/ai-assistant',
  templates: '/templates',
  shortcuts: '/web-shortcuts',
  'secured-links': '/secured-links',
  'cloud-backup': '/cloud-backup',
  integrations: '/integrations',
  analytics: '/analytics',
};

const Dashboard: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [currentView, setCurrentView] = useState('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sync currentView with URL pathname
  useEffect(() => {
    const path = location.pathname;
    if (path === '/' || path === '' || path === '/home') {
      setCurrentView('home');
    } else if (path === '/files' || path.startsWith('/files')) {
      setCurrentView('files');
    } else if (path === '/starred' || path.startsWith('/starred')) {
      setCurrentView('starred');
    } else if (path === '/trash' || path.startsWith('/trash')) {
      setCurrentView('trash');
    } else if (path === '/integrations' || path.startsWith('/integrations')) {
      setCurrentView('integrations');
    } else if (path === '/cloud-backup' || path.startsWith('/cloud-backup')) {
      setCurrentView('cloud-backup');
    } else if (path === '/secured-links' || path.startsWith('/secured-links')) {
      setCurrentView('secured-links');
    } else if (path === '/web-shortcuts' || path.startsWith('/web-shortcuts')) {
      setCurrentView('shortcuts');
    } else if (path === '/templates' || path.startsWith('/templates')) {
      setCurrentView('templates');
    } else if (path === '/shared-files' || path.startsWith('/shared-files')) {
      setCurrentView('shared');
    } else if (path === '/ai-assistant' || path.startsWith('/ai-assistant')) {
      setCurrentView('ai-assistant');
    } else if (path === '/security' || path.startsWith('/security')) {
      setCurrentView('security');
    } else if (path === '/student' || path.startsWith('/student')) {
      setCurrentView('student');
    } else if (path === '/relationships' || path.startsWith('/relationships')) {
      setCurrentView('relationships');
    } else if (path === '/analytics' || path.startsWith('/analytics')) {
      setCurrentView('analytics');
    } else if (path === '/file-requests' || path.startsWith('/file-requests')) {
      setCurrentView('requests');
    } else if (path === '/team-folders' || path.startsWith('/team-folders')) {
      setCurrentView('teams');
    } else {
      setCurrentView('home');
    }
  }, [location.pathname]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 1024) {
        setSidebarOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [folderStack, setFolderStack] = useState<string[]>(['root']);
  const [showGraph, setShowGraph] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [selectedTeamFolder, setSelectedTeamFolder] = useState<string | null>(null);
  const [relationshipsRefreshKey, setRelationshipsRefreshKey] = useState(0);

  useEffect(() => {
    setShowAnalytics(currentView === 'analytics');
  }, [currentView]);

  const currentFolderId = folderStack[folderStack.length - 1];

  const handleFolderClick = (folderId: string) => {
    setFolderStack([...folderStack, folderId]);
    setCurrentView('files');
    if (location.pathname !== VIEW_PATHS.files) {
      navigate(VIEW_PATHS.files);
    }
  };

  const handleSearchFileClick = (file: FileItemType) => {
    // Navigate to the file's folder if it's in a folder
    if (file.parentFolder) {
      // We'd need to build the path, but for now just show the file
      setCurrentView('files');
    } else {
      setFolderStack(['root']);
      setCurrentView('files');
    }
    if (location.pathname !== VIEW_PATHS.files) {
      navigate(VIEW_PATHS.files);
    }
  };

  const handleNavigateUp = () => {
    if (folderStack.length > 1) {
      setFolderStack(folderStack.slice(0, -1));
    }
  };

  const handleViewChange = (view: string) => {
    setCurrentView(view);
    const nextPath = VIEW_PATHS[view];
    if (nextPath && location.pathname !== nextPath) {
      navigate(nextPath);
    }
    if (window.innerWidth <= 1024) {
      setSidebarOpen(false);
    }
    if (view === 'files') {
      setFolderStack(['root']);
    }
    if (view === 'teams') {
      setSelectedTeamFolder(null);
      setFolderStack(['root']);
    } else {
      setSelectedTeamFolder(null);
    }
    if (view === 'relationships') {
      // Force refresh of relationships when navigating to this view
      setRelationshipsRefreshKey(prev => prev + 1);
    }
  };

  const currentMeta = VIEW_META[currentView] || VIEW_META.files;
  const currentChip = currentView === 'files' && currentFolderId && currentFolderId !== 'root'
    ? 'Nested space'
    : currentMeta.chip;

  return (
    <div className={`dashboard ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <button
        type="button"
        className={`dashboard-overlay ${sidebarOpen ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-label="Close navigation"
      />
      <Sidebar
        currentView={currentView}
        onViewChange={handleViewChange}
        onNavigateUp={handleNavigateUp}
        currentFolderId={currentFolderId}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="dashboard-content">
        <header className="dashboard-shell-header">
          <div className="dashboard-shell-content">
            <div className="dashboard-shell-left">
              <button
                type="button"
                className="dashboard-menu-button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation"
              >
                <span />
                <span />
                <span />
              </button>
              <div className="dashboard-heading">
                <span className="dashboard-eyebrow">{currentMeta.eyebrow}</span>
                <div className="dashboard-heading-row">
                  <h1>{currentMeta.title}</h1>
                  <span className="dashboard-chip">{currentChip}</span>
                </div>
                <p>{currentMeta.description}</p>
              </div>
            </div>
            <div className="dashboard-shell-right">
              <SearchBar
                onFileClick={handleSearchFileClick}
                onFolderClick={handleFolderClick}
              />
            </div>
          </div>
        </header>
        {currentView === 'home' && (
          <StorageHome onOpenView={handleViewChange} />
        )}
        {currentView === 'files' && (
          <FileBrowser
            currentFolderId={currentFolderId}
            onFolderClick={handleFolderClick}
            onNavigateUp={handleNavigateUp}
            showTrash={false}
            folderStack={folderStack}
          />
        )}
        {currentView === 'trash' && (
          <FileBrowser
            currentFolderId={undefined}
            onFolderClick={handleFolderClick}
            onNavigateUp={handleNavigateUp}
            showTrash={true}
            folderStack={['root']}
          />
        )}
        {currentView === 'shared' && (
          <SharedFiles />
        )}
        {currentView === 'starred' && (
          <FileBrowser
            currentFolderId={undefined}
            onFolderClick={handleFolderClick}
            onNavigateUp={handleNavigateUp}
            showTrash={false}
            showStarred={true}
            folderStack={['root']}
          />
        )}
        {currentView === 'teams' && !selectedTeamFolder && (
          <TeamFolders
            onClose={() => handleViewChange('files')}
            onFolderSelect={(folderId) => {
              setSelectedTeamFolder(folderId);
              setFolderStack([folderId]);
            }}
          />
        )}
        {currentView === 'teams' && selectedTeamFolder && (
          <>
            <div className="team-folder-subnav">
              <button
                type="button"
                className="team-folder-back-button"
                onClick={() => {
                  setSelectedTeamFolder(null);
                  setFolderStack(['root']);
                }}
              >
                ← Back to Team Folders
              </button>
            </div>
            <FileBrowser
              currentFolderId={selectedTeamFolder}
              onFolderClick={handleFolderClick}
              onNavigateUp={() => {
                if (folderStack.length > 1) {
                  setFolderStack(folderStack.slice(0, -1));
                } else {
                  setSelectedTeamFolder(null);
                  setFolderStack(['root']);
                }
              }}
              showTrash={false}
              isTeamFolder={true}
              teamFolderId={selectedTeamFolder}
            />
          </>
        )}
        {currentView === 'requests' && (
          <FileRequests
            onClose={() => handleViewChange('home')}
          />
        )}
        {currentView === 'relationships' && (
          <RelationshipsList key={relationshipsRefreshKey} />
        )}
        {currentView === 'security' && (
          <SecurityDashboard />
        )}
        {currentView === 'student' && (
          <StudentDashboard />
        )}
        {currentView === 'ai-assistant' && (
          <AIAssistant />
        )}
        {currentView === 'templates' && (
          <TemplatesLibrary />
        )}
        {currentView === 'shortcuts' && (
          <WebShortcuts />
        )}
        {currentView === 'secured-links' && (
          <SecuredLinks />
        )}
        {currentView === 'cloud-backup' && (
          <CloudBackup />
        )}
        {currentView === 'integrations' && (
          <Integrations />
        )}
      </div>
      {showGraph && (
        <RelationshipGraph onClose={() => setShowGraph(false)} />
      )}
      {showAnalytics && (
        <AnalyticsDashboard onClose={() => {
          handleViewChange('home');
        }} />
      )}
    </div>
  );
};

export default Dashboard;

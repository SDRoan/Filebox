import React, { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import FileBrowser from './FileBrowser';
import SearchBar from './SearchBar';
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
import Learning from './Learning';
import { FileItemType } from '../types';
import { getWorkspacePage, workspacePages } from '../config/workspaceNavigation';
import './Dashboard.css';
import './WorkspacePages.css';

const Dashboard: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const page = getWorkspacePage(location.pathname);
  const currentView = page.id;
  const setCurrentView = (view: string) => navigate(workspacePages.find(item => item.id === view)?.path || '/');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const [folderStack, setFolderStack] = useState<string[]>(['root']);
  const [showGraph, setShowGraph] = useState(false);
  const [selectedTeamFolder, setSelectedTeamFolder] = useState<string | null>(null);
  const [relationshipsRefreshKey, setRelationshipsRefreshKey] = useState(0);

  const currentFolderId = folderStack[folderStack.length - 1];

  const handleFolderClick = (folderId: string) => {
    setFolderStack([...folderStack, folderId]);
    setCurrentView('files');
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
  };

  const handleNavigateUp = () => {
    if (folderStack.length > 1) {
      setFolderStack(folderStack.slice(0, -1));
    }
  };

  const handleViewChange = (view: string) => {
    setCurrentView(view);
    if (view === 'files') {
      setFolderStack(['root']);
      setSelectedTeamFolder(null);
    }
    if (view === 'teams') {
      setSelectedTeamFolder(null);
      setFolderStack(['root']);
    }
    if (view === 'relationships') {
      // Force refresh of relationships when navigating to this view
      setRelationshipsRefreshKey(prev => prev + 1);
    }
  };

  return (
    <div className="dashboard">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Sidebar
        currentView={currentView}
        onViewChange={handleViewChange}
        onNavigateUp={handleNavigateUp}
        currentFolderId={currentFolderId}
        mobileOpen={mobileNavOpen}
        onClose={closeMobileNav}
      />
      <main className="dashboard-content" id="main-content">
        <header className="dashboard-header">
          <button className="mobile-nav-toggle" onClick={() => setMobileNavOpen(!mobileNavOpen)} aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="workspace-navigation">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="workspace-breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{page.label}</strong></div>
          <SearchBar onFileClick={handleSearchFileClick} onFolderClick={handleFolderClick} />
        </header>
        <div className={`workspace-view workspace-view-${currentView}`}>
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
            embedded
            onClose={() => setCurrentView('files')}
            onFolderSelect={(folderId) => {
              setSelectedTeamFolder(folderId);
              setFolderStack([folderId]);
            }}
          />
        )}
        {currentView === 'teams' && selectedTeamFolder && (
          <>
            <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button
                onClick={() => {
                  setSelectedTeamFolder(null);
                  setFolderStack(['root']);
                }}
                style={{ padding: '0.5rem 1rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
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
            embedded
            onClose={() => setCurrentView('files')}
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
        {currentView === 'learning' && (
          <Learning />
        )}
        </div>
      </main>
      {showGraph && (
        <RelationshipGraph onClose={() => setShowGraph(false)} />
      )}
      {currentView === 'analytics' && (
        <AnalyticsDashboard onClose={() => {
          setCurrentView('files');
        }} />
      )}
    </div>
  );
};

export default Dashboard;


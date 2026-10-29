import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import FileBrowser from './FileBrowser';
import SearchBar from './SearchBar';
import HomeView from './HomeView';
import RecentView from './RecentView';
import SettingsView from './SettingsView';
import CustomizeView from './CustomizeView';
import TopBarColor from './TopBarColor';
import CompanionPanel from './CompanionPanel';
import { noteActivity, startWatching } from '../companion/screen';
import StorageView from './StorageView';
import TeamFolders from './TeamFolders';
import FileRequests from './FileRequests';
import RelationshipGraph from './RelationshipGraph';
import AnalyticsDashboard from './AnalyticsDashboard';
import RelationshipsList from './RelationshipsList';
import SecurityDashboard from './SecurityDashboard';
import AIAssistant from './AIAssistant';
import SharedFiles from './SharedFiles';
import TemplatesLibrary from './TemplatesLibrary';
import WebShortcuts from './WebShortcuts';
import SecuredLinks from './SecuredLinks';
import CloudBackup from './CloudBackup';
import Integrations from './Integrations';
import SignatureManager from './SignatureManager';
import { FileRowItem } from './FileRowList';
import { useAuth } from '../context/AuthContext';
import { useAppearance } from '../context/AppearanceContext';
import { useCompanion } from '../context/CompanionContext';
import { FileItemType } from '../types';
import { getWorkspacePage, pagePath } from '../config/workspaceNavigation';
import AdvancedSearch from './AdvancedSearch';
import Boards from './Boards';
import { filesAPI, preferencesAPI } from '../services/api';
import { applyAccent, rememberAccent } from '../theme/accent';
import './Dashboard.css';
import './WorkspacePages.css';

const ownerId = (file: FileItemType) => (typeof file.owner === 'object' && file.owner ? (file.owner as any)._id || file.owner.id : file.owner);

const Dashboard: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { appearance } = useAppearance();
  const page = getWorkspacePage(location.pathname);
  const currentView = page.id;
  const setCurrentView = useCallback((view: string, state?: unknown) => navigate(pagePath(view), state ? { state } : undefined), [navigate]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const [folderStack, setFolderStack] = useState<string[]>(['root']);
  const [showGraph, setShowGraph] = useState(false);
  const [selectedTeamFolder, setSelectedTeamFolder] = useState<string | null>(null);
  const [relationshipsRefreshKey, setRelationshipsRefreshKey] = useState(0);
  const [newFolderRequest, setNewFolderRequest] = useState(0);
  const [pendingUploads, setPendingUploads] = useState<{ id: number; files: File[] } | null>(null);
  const [openFileRequest, setOpenFileRequest] = useState<{ id: string; at: number } | null>(null);

  const currentFolderId = folderStack[folderStack.length - 1];
  // Advanced Search opened from inside a folder can search just that folder.
  const insideFolder = (currentView === 'files' || currentView === 'teams') && currentFolderId && currentFolderId !== 'root';
  const advancedSearchLink = insideFolder ? `/search?folder=${encodeURIComponent(currentFolderId)}` : '/search';

  // Tell File Box AI where the person is, so "this folder" or "here" mean something to it.
  const { setPageContext, setPage, setFolder } = useCompanion();
  useEffect(() => { setPage(page.label); }, [page.label, setPage]);
  useEffect(() => { startWatching(); }, []);
  useEffect(() => { noteActivity(`Went to ${page.label}`); }, [page.label]);
  useEffect(() => {
    let cancelled = false;
    const base = `The person is on the "${page.label}" page of File Box.`;
    setPageContext(base);
    const inFolder = (currentView === 'files' || currentView === 'teams') && currentFolderId && currentFolderId !== 'root';
    if (inFolder) {
      filesAPI.getFolder(currentFolderId)
        .then(folder => {
          if (cancelled || !folder?.name) return;
          setPageContext(`${base} They are inside their folder "${folder.name}".`);
          setFolder({ id: currentFolderId, name: folder.name });
        })
        .catch(() => setFolder(null));
    } else {
      setFolder(null);
      if (currentView === 'files') setPageContext(`${base} They are at the top level of My Files.`);
    }
    return () => { cancelled = true; };
  }, [page.label, currentView, currentFolderId, setPageContext, setFolder]);

  // The account's accent color (Settings > Appearance), so it follows the person to other browsers.
  useEffect(() => {
    preferencesAPI.get()
      .then(({ accentColor }) => { applyAccent(accentColor); rememberAccent(accentColor); })
      .catch(() => { /* keep the color saved in this browser */ });
  }, []);

  // Other pages (Home, Recent, File Box AI) can open a folder in My Files via navigation state.
  useEffect(() => {
    const state = location.state as { openFolderId?: string | null; highlightFileId?: string } | null;
    if (currentView !== 'files' || !state || !('openFolderId' in state)) return;
    setFolderStack(state.openFolderId ? ['root', state.openFolderId] : ['root']);
    // …and open one file in it ("Continue" in Ask File Box, a file found by File Box AI).
    if (state.highlightFileId) setOpenFileRequest({ id: state.highlightFileId, at: Date.now() });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, currentView, navigate]);

  const handleFolderClick = (folderId: string) => {
    setFolderStack(currentView === 'files' || currentView === 'teams' ? [...folderStack, folderId] : ['root', folderId]);
    if (currentView !== 'files') setCurrentView('files');
  };

  const openFile = (file: FileItemType | FileRowItem) => {
    if (user && ownerId(file) && ownerId(file) !== user.id) {
      setCurrentView('shared');
      return;
    }
    setCurrentView('files', { openFolderId: file.parentFolder || null });
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

  // "+ New" goes to the open folder (or team space); from anywhere else it targets My Files.
  const targetsCurrentBrowser = currentView === 'files' || (currentView === 'teams' && Boolean(selectedTeamFolder));
  const handleUploadFiles = (files: File[]) => {
    if (!targetsCurrentBrowser) handleViewChange('files');
    setPendingUploads({ id: Date.now(), files });
  };
  const handleNewFolder = () => {
    if (!targetsCurrentBrowser) handleViewChange('files');
    setNewFolderRequest(Date.now());
  };
  const newProps = {
    newFolderRequest,
    pendingUploads,
    onPendingUploadsHandled: () => setPendingUploads(null),
    onNewFolderHandled: () => setNewFolderRequest(0),
    openFileRequest,
    onOpenFileHandled: () => setOpenFileRequest(null),
  };

  return (
    <div className={`dashboard ${appearance.sidebar.position === 'right' ? 'sidebar-right' : ''}`}>
      <div className="dashboard-backdrop" aria-hidden="true" />
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Sidebar
        currentView={currentView}
        onViewChange={handleViewChange}
        onNavigateUp={handleNavigateUp}
        onUploadFiles={handleUploadFiles}
        onNewFolder={handleNewFolder}
        currentFolderId={currentFolderId}
        mobileOpen={mobileNavOpen}
        onClose={closeMobileNav}
      />
      <main className="dashboard-content" id="main-content">
        <header className="dashboard-header">
          <button className="mobile-nav-toggle" onClick={() => setMobileNavOpen(!mobileNavOpen)} aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="workspace-navigation">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="workspace-breadcrumb"><span>{appearance.brandName.trim() || 'File Box'}</span><span aria-hidden="true">/</span><strong>{page.label}</strong></div>
          {currentView !== 'home' && <SearchBar onFileClick={openFile} onFolderClick={handleFolderClick} />}
          {currentView !== 'home' && currentView !== 'search' && (
            <Link className="adv-entry-link" to={advancedSearchLink}>Advanced search</Link>
          )}
          <TopBarColor />
        </header>
        <div className={`workspace-view workspace-view-${currentView}`}>
        {currentView === 'search' && <AdvancedSearch />}
        {currentView === 'boards' && <Boards />}
        {currentView === 'home' && (
          <HomeView onOpenFile={openFile} onOpenFolder={handleFolderClick} />
        )}
        {currentView === 'files' && (
          <FileBrowser
            currentFolderId={currentFolderId}
            onFolderClick={handleFolderClick}
            onNavigateUp={handleNavigateUp}
            showTrash={false}
            folderStack={folderStack}
            {...newProps}
          />
        )}
        {currentView === 'recent' && (
          <RecentView onOpenFile={openFile} />
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
                ← Back to Team Spaces
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
              {...newProps}
            />
          </>
        )}
        {currentView === 'requests' && (
          <FileRequests
            embedded
            onClose={() => setCurrentView('files')}
          />
        )}
        {currentView === 'ai-assistant' && (
          <AIAssistant />
        )}
        {currentView === 'signatures' && (
          <SignatureManager embedded />
        )}
        {currentView === 'cloud-backup' && (
          <CloudBackup />
        )}
        {currentView === 'storage' && (
          <StorageView
            onOpenFolder={(folderId) => setCurrentView('files', { openFolderId: folderId })}
            onOpenTrash={() => setCurrentView('trash')}
          />
        )}
        {currentView === 'settings' && (
          <SettingsView onOpenPage={handleViewChange} />
        )}
        {currentView === 'customize' && (
          <CustomizeView />
        )}
        {currentView === 'relationships' && (
          <RelationshipsList key={relationshipsRefreshKey} />
        )}
        {currentView === 'security' && (
          <SecurityDashboard />
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
        {currentView === 'integrations' && (
          <Integrations />
        )}
        </div>
      </main>
      {showGraph && (
        <RelationshipGraph onClose={() => setShowGraph(false)} />
      )}
      {currentView === 'analytics' && (
        <AnalyticsDashboard onClose={() => setCurrentView('settings')} />
      )}
      <CompanionPanel currentView={currentView} />
    </div>
  );
};

export default Dashboard;

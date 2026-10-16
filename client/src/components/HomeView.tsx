import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { aiAssistantAPI, filesAPI, searchAPI, shareAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { FileItem, Folder } from '../types';
import { pagePath } from '../config/workspaceNavigation';
import { formatRelativeTime } from '../utils/fileDisplay';
import FileRowList, { FileRowItem } from './FileRowList';
import { AIAssistantIcon, ArrowRightIcon, FolderIcon, SearchIcon } from './Icons';
import './OverviewPages.css';

interface ActivityEntry {
  _id: string;
  action: string;
  details?: string;
  createdAt: string;
  file?: { originalName: string } | null;
  folder?: { name: string } | null;
}

interface HomeViewProps {
  onOpenFile: (file: FileRowItem) => void;
  onOpenFolder: (folderId: string) => void;
}

const ACTIVITY_VERBS: Record<string, string> = {
  uploaded: 'Uploaded', created: 'Created', edited: 'Edited', downloaded: 'Downloaded', deleted: 'Moved to Trash',
  restored: 'Restored', renamed: 'Renamed', moved: 'Moved', copied: 'Copied', shared: 'Shared',
  starred: 'Starred', unstarred: 'Unstarred', commented: 'Commented on', version_created: 'Saved a new version of',
  version_restored: 'Restored a version of',
};

const AI_STARTERS = ['Find documents about my project', 'Suggest how I could organize my recent files into folders.'];

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const HomeView: React.FC<HomeViewProps> = ({ onOpenFile, onOpenFolder }) => {
  const { user, isLocalPreview } = useAuth();
  const navigate = useNavigate();
  const [recent, setRecent] = useState<FileRowItem[]>([]);
  const [starred, setStarred] = useState<FileRowItem[]>([]);
  const [shared, setShared] = useState<FileRowItem[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ files: FileItem[]; folders: Folder[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      filesAPI.getRecent(8),
      filesAPI.getFiles(undefined, false, true),
      shareAPI.getSharedWithMe(),
      filesAPI.getUserActivity(),
    ]).then(([recentResult, starredResult, sharedResult, activityResult]) => {
      if (cancelled) return;
      if (recentResult.status === 'fulfilled') setRecent(recentResult.value.files || []);
      if (starredResult.status === 'fulfilled') setStarred((starredResult.value.files || []).slice(0, 4));
      if (sharedResult.status === 'fulfilled') setShared((sharedResult.value || []).slice(0, 5));
      if (activityResult.status === 'fulfilled') setActivity((activityResult.value || []).filter((entry: ActivityEntry) => entry.file || entry.folder).slice(0, 8));
      setLoading(false);
    });
    aiAssistantAPI.getStatus()
      .then(status => !cancelled && setAiReady(Boolean(status.ready)))
      .catch(() => !cancelled && setAiReady(false));
    return () => { cancelled = true; };
  }, []);

  // Instant local search; never depends on AI being online.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults(null); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchAPI.aiSearch(q);
        setResults({ files: (data.files || []).slice(0, 6), folders: (data.folders || []).slice(0, 3) });
      } catch {
        setResults({ files: [], folders: [] });
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const askAI = (text: string) => navigate(`${pagePath('ai-assistant')}?q=${encodeURIComponent(text)}`);
  const firstName = isLocalPreview ? '' : (user?.name || '').split(' ')[0];

  return (
    <div className="overview-page home-view">
      <header className="home-hero">
        <h1>{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
        <form
          className="home-search"
          role="search"
          onSubmit={(event) => { event.preventDefault(); if (query.trim()) askAI(query.trim()); }}
        >
          <SearchIcon size={18} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your files or ask File Box AI..."
            aria-label="Search your files or ask File Box AI"
          />
          {query && <kbd>Enter to ask AI</kbd>}
        </form>

        {results && (
          <div className="home-search-results" aria-live="polite">
            {searching && <p className="overview-muted">Searching…</p>}
            {!searching && results.folders.map(folder => (
              <button key={folder._id} className="file-row" onClick={() => onOpenFolder(folder._id)}>
                <span className="file-row-icon" aria-hidden="true"><FolderIcon size={16} /></span>
                <span className="file-row-name">{folder.name}</span>
                <span className="file-row-detail">Folder</span>
              </button>
            ))}
            {!searching && results.files.length > 0 && <FileRowList files={results.files} onOpen={onOpenFile} />}
            {!searching && !results.files.length && !results.folders.length && (
              <p className="overview-muted">No files match “{query.trim()}”.</p>
            )}
            <button className="home-ask-ai" onClick={() => askAI(query.trim())} disabled={aiReady === false}>
              <AIAssistantIcon size={16} />
              <span>{aiReady === false ? 'File Box AI is offline' : `Ask File Box AI: “${query.trim()}”`}</span>
              <ArrowRightIcon size={14} />
            </button>
          </div>
        )}
      </header>

      {loading ? (
        <p className="overview-muted">Loading your files…</p>
      ) : (
        <div className="home-grid">
          <div className="home-main">
            {starred.length > 0 && (
              <section className="overview-section">
                <div className="overview-section-head"><h2>Suggested</h2><span>Starred files</span></div>
                <FileRowList files={starred} onOpen={onOpenFile} />
              </section>
            )}

            <section className="overview-section">
              <div className="overview-section-head">
                <h2>Recent</h2>
                {recent.length > 0 && <button onClick={() => navigate(pagePath('recent'))}>View all</button>}
              </div>
              {recent.length > 0 ? (
                <FileRowList files={recent} onOpen={onOpenFile} />
              ) : (
                <div className="overview-empty">
                  <p>Files you upload, open or edit will show up here.</p>
                  <button className="btn-primary" onClick={() => navigate(pagePath('files'))}>Go to My Files</button>
                </div>
              )}
            </section>

            <section className="overview-section">
              <div className="overview-section-head">
                <h2>Shared with you</h2>
                {shared.length > 0 && <button onClick={() => navigate(pagePath('shared'))}>View all</button>}
              </div>
              {shared.length > 0
                ? <FileRowList files={shared} onOpen={onOpenFile} detail="owner" />
                : <p className="overview-muted">Nothing has been shared with you yet.</p>}
            </section>
          </div>

          <aside className="home-side">
            <section className="home-ai-card">
              <div className="home-ai-card-head">
                <AIAssistantIcon size={18} />
                <h2>File Box AI</h2>
                <span className={`home-ai-dot ${aiReady ? 'online' : ''}`} aria-label={aiReady ? 'Online' : 'Offline'} />
              </div>
              {aiReady === false ? (
                <p>Local AI is offline. Start Ollama on your computer to use it — your files work normally without it.</p>
              ) : (
                <>
                  <p>Ask about your files or tell File Box what to do.</p>
                  {AI_STARTERS.map(starter => (
                    <button key={starter} className="home-ai-starter" onClick={() => askAI(starter)}>{starter}</button>
                  ))}
                </>
              )}
              <button className="home-ai-open" onClick={() => navigate(pagePath('ai-assistant'))}>Open File Box AI <ArrowRightIcon size={13} /></button>
            </section>

            <section className="overview-section">
              <div className="overview-section-head"><h2>Activity</h2></div>
              {activity.length > 0 ? (
                <ul className="activity-list">
                  {activity.map(entry => (
                    <li key={entry._id}>
                      <span>{ACTIVITY_VERBS[entry.action] || 'Updated'} <strong>{entry.file?.originalName || entry.folder?.name}</strong></span>
                      <time dateTime={entry.createdAt}>{formatRelativeTime(entry.createdAt)}</time>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="overview-muted">Your recent file activity will appear here.</p>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
};

export default HomeView;

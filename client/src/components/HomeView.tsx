import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { homeAPI, searchAPI, HomeOverview, HomeSuggestion } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { FileItem, Folder } from '../types';
import { pagePath } from '../config/workspaceNavigation';
import FileRowList, { FileRowItem } from './FileRowList';
import DuplicateReview from './DuplicateReview';
import OrganizeReview from './OrganizeReview';
import DayView from './DayView';
import { AIAssistantIcon, ArrowRightIcon, CloseIcon, FolderIcon, SearchIcon } from './Icons';
import './OverviewPages.css';
import './AIPanels.css';

interface HomeViewProps {
  onOpenFile: (file: FileRowItem) => void;
  onOpenFolder: (folderId: string) => void;
}

const DISMISSED_KEY = 'filebox-dismissed-suggestions';
const MAX_VISIBLE_SUGGESTIONS = 3;

// Dismissed suggestions stay hidden until what File Box noticed changes (different fingerprint).
const readDismissed = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}') || {}; } catch { return {}; }
};

const CHIPS: Array<{ label: string; kind: 'prefill' | 'organize' | 'duplicates' | 'ai'; value?: string }> = [
  { label: 'Find something', kind: 'prefill', value: 'Find ' },
  { label: 'Organize my files', kind: 'organize' },
  { label: 'Summarize documents', kind: 'ai', value: 'Summarize this file' },
  { label: 'Clean up duplicates', kind: 'duplicates' },
];

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const HomeView: React.FC<HomeViewProps> = ({ onOpenFile, onOpenFolder }) => {
  const { user, isLocalPreview } = useAuth();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [dismissed, setDismissed] = useState<Record<string, string>>(readDismissed);
  const [panel, setPanel] = useState<'duplicates' | 'organize' | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ files: FileItem[]; folders: Folder[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setOverview(await homeAPI.getOverview());
    } catch (err: any) {
      setLoadError(err?.code === 'ERR_NETWORK'
        ? "Can't reach the File Box server. Check that it's running, then try again."
        : err?.response?.data?.message || 'Could not load your Home overview.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Instant local search while typing; never depends on File Box AI being online.
  useEffect(() => {
    const q = query.trim();
    if (!q || q === 'Find') { setResults(null); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchAPI.aiSearch(q.replace(/^find\s+/i, ''));
        setResults({ files: (data.files || []).slice(0, 6), folders: (data.folders || []).slice(0, 3) });
      } catch {
        setResults({ files: [], folders: [] });
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const askFileBox = (text: string) => navigate(`${pagePath('ai-assistant')}?q=${encodeURIComponent(text)}`);

  const runChip = (chip: typeof CHIPS[number]) => {
    if (chip.kind === 'prefill') { setQuery(chip.value || ''); inputRef.current?.focus(); return; }
    if (chip.kind === 'organize' || chip.kind === 'duplicates') { setPanel(chip.kind); return; }
    // Summaries need a file: open File Box AI with the request ready and the file picker available.
    navigate(`${pagePath('ai-assistant')}?prefill=${encodeURIComponent(chip.value || '')}`);
  };

  const runSuggestion = (suggestion: HomeSuggestion) => {
    const { action } = suggestion;
    if (action.type === 'duplicates' || action.type === 'organize') setPanel(action.type);
    else navigate(pagePath(action.to || 'home'));
  };

  const dismiss = (suggestion: HomeSuggestion) => {
    const next = { ...dismissed, [suggestion.id]: suggestion.fingerprint };
    setDismissed(next);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* still hidden for this visit */ }
  };

  // At most three cards; dismissing one lets the next most useful suggestion take its place.
  const visibleSuggestions = (overview?.suggestions || []).filter(s => dismissed[s.id] !== s.fingerprint).slice(0, MAX_VISIBLE_SUGGESTIONS);
  const firstName = isLocalPreview ? '' : (user?.name || '').split(' ')[0];
  const isEmpty = overview && !overview.continueWorking.length && !overview.activity.length && !overview.suggestions.length;

  return (
    <div className="overview-page home-view">
      <header className="home-hero">
        <p className="home-greeting">{greeting()}{firstName ? `, ${firstName}` : ''}</p>
        <h1>Ask File Box</h1>
        <form className="home-search" role="search" onSubmit={(event) => { event.preventDefault(); if (query.trim()) askFileBox(query.trim()); }}>
          <SearchIcon size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="What do you want to do with your files?"
            aria-label="What do you want to do with your files?"
          />
          {query.trim() && <kbd>Enter to ask File Box</kbd>}
        </form>
        <div className="home-chips" aria-label="Things File Box can do">
          {CHIPS.map(chip => <button key={chip.label} onClick={() => runChip(chip)}>{chip.label}</button>)}
        </div>

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
              <p className="overview-muted">No file names or contents match “{query.trim()}”.</p>
            )}
            <button className="home-ask-ai" onClick={() => askFileBox(query.trim())}>
              <AIAssistantIcon size={16} />
              <span>Ask File Box: “{query.trim()}”</span>
              <ArrowRightIcon size={14} />
            </button>
          </div>
        )}
      </header>

      {loadError && (
        <div className="overview-error home-error" role="alert">
          <span>{loadError}</span>
          <button className="btn-secondary" onClick={load}>Try again</button>
        </div>
      )}

      {!overview && !loadError && (
        <div className="home-loading" aria-busy="true" aria-label="Loading your overview">
          {[0, 1, 2].map(i => <div key={i} className="home-skeleton" />)}
        </div>
      )}

      {isEmpty && (
        <section className="home-welcome">
          <h2>Welcome to File Box</h2>
          <p>Upload files and File Box will help you find, understand and organize them. Suggestions and recent work will appear here.</p>
          <button className="btn-primary" onClick={() => navigate(pagePath('files'))}>Go to My Files</button>
        </section>
      )}

      {overview && !isEmpty && (
        <DayView onOpenFile={onOpenFile}>
          {visibleSuggestions.length > 0 && (
            <div className="suggestion-cards" aria-label="File Box suggestions">
              {visibleSuggestions.map(suggestion => (
                <article key={suggestion.id} className="suggestion-card">
                  <button className="suggestion-dismiss" onClick={() => dismiss(suggestion)} aria-label={`Dismiss: ${suggestion.noticed}`} title="Dismiss"><CloseIcon size={14} /></button>
                  <h3>{suggestion.noticed}</h3>
                  <p className="suggestion-why">{suggestion.why}</p>
                  <p className="suggestion-recommendation">{suggestion.recommendation}</p>
                  <button className="btn-secondary suggestion-action" onClick={() => runSuggestion(suggestion)}>{suggestion.action.label}</button>
                </article>
              ))}
            </div>
          )}
        </DayView>
      )}

      {panel && (
        <div className="ai-panel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
          <div className="ai-panel-dialog wide" role="dialog" aria-modal="true" aria-labelledby="home-panel-title">
            <header className="ai-panel-header">
              <div>
                <h2 id="home-panel-title"><AIAssistantIcon size={18} /> {panel === 'duplicates' ? 'Clean up duplicates' : 'Let File Box organize this'}</h2>
                <p>Review each suggestion. Nothing changes until you confirm.</p>
              </div>
              <button className="ai-panel-close" onClick={() => { setPanel(null); load(); }} aria-label="Close"><CloseIcon size={18} /></button>
            </header>
            {panel === 'duplicates' ? <DuplicateReview onChanged={load} /> : <OrganizeReview onApplied={load} />}
          </div>
        </div>
      )}
    </div>
  );
};

export default HomeView;

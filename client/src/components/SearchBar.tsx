import React, { useState, useEffect, useRef } from 'react';
import { FileItemType, Folder } from '../types';
import { useNavigate } from 'react-router-dom';
import { searchAPI } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import './SearchBar.css';

interface SearchBarProps {
  onFileClick: (file: FileItemType) => void;
  onFolderClick: (folderId: string) => void;
}

const SearchBar: React.FC<SearchBarProps> = ({ onFileClick, onFolderClick }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ files: FileItemType[]; folders: Folder[] }>({ files: [], folders: [] });
  const [loading, setLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Keyboard shortcut: Ctrl+K or Cmd+K to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && showResults) {
        setShowResults(false);
        setQuery('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showResults]);

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults({ files: [], folders: [] });
      setShowResults(false);
      return;
    }

    const searchFiles = async () => {
      setLoading(true);
      try {
        // Use AI-powered semantic search
        const searchData = await searchAPI.aiSearch(query);
        
        setResults({
          files: searchData.files || [],
          folders: searchData.folders || [],
        });
        setShowResults(true);
      } catch (error) {
        console.error('Search error:', error);
        // Fallback to empty results on error
        setResults({ files: [], folders: [] });
        setShowResults(true);
      } finally {
        setLoading(false);
      }
    };

    const debounceTimer = setTimeout(searchFiles, 300);
    return () => clearTimeout(debounceTimer);
  }, [query]);

  const handleFileClick = (file: FileItemType) => {
    onFileClick(file);
    setQuery('');
    setShowResults(false);
  };

  const handleFolderClick = (folder: Folder) => {
    onFolderClick(folder._id);
    setQuery('');
    setShowResults(false);
  };

  return (
    <div className="workspace-search-bar-container">
      <div className="workspace-search-input-wrapper">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search or tell File Box what to do…"
          aria-label="Search or tell File Box what to do"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.trim().length > 0 && setShowResults(true)}
          onKeyDown={(e) => {
            // Enter hands the request to File Box AI, which searches, answers or prepares an action to confirm.
            if (e.key === 'Enter' && query.trim()) {
              navigate(`${pagePath('ai-assistant')}?q=${encodeURIComponent(query.trim())}`);
              setQuery('');
              setShowResults(false);
            }
          }}
          className="workspace-search-input"
        />
        <svg className="workspace-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        <div className="workspace-search-shortcut-hint">
          <kbd>⌘</kbd><kbd>K</kbd>
        </div>
      </div>

      {showResults && (
        <div className="workspace-search-results">
          {loading && (
            <div className="workspace-search-loading">Searching...</div>
          )}

          {!loading && results.folders.length > 0 && (
            <div className="workspace-search-section">
              <div className="workspace-search-section-title">Folders</div>
              {results.folders.map((folder) => (
                <div
                  key={folder._id}
                  className="workspace-search-result-item"
                  onClick={() => handleFolderClick(folder)}
                >
                  <span className="result-icon"></span>
                  <span className="workspace-result-name">{folder.name}</span>
                </div>
              ))}
            </div>
          )}

          {!loading && results.files.length > 0 && (
            <div className="workspace-search-section">
              <div className="workspace-search-section-title">
                Files
              </div>
              {results.files.map((file) => (
                <div
                  key={file._id}
                  className="workspace-search-result-item"
                  onClick={() => handleFileClick(file)}
                >
                  <span className="result-icon">
                    {file.mimeType.startsWith('image/') ? '' :
                     file.mimeType.startsWith('video/') ? 'Video' :
                     file.mimeType.includes('pdf') ? '' : ''}
                  </span>
                  <span className="workspace-result-name">{file.originalName}</span>
                  <span className="workspace-result-meta">
                    {(file.size / 1024).toFixed(1)} KB
                  </span>
                </div>
              ))}
            </div>
          )}

          {!loading && results.files.length === 0 && results.folders.length === 0 && query.trim().length > 0 && (
            <div className="workspace-search-no-results">No results found</div>
          )}

          {!loading && query.trim().length > 0 && (
            <button
              className="workspace-search-ask-ai"
              onClick={() => {
                navigate(`${pagePath('ai-assistant')}?q=${encodeURIComponent(query.trim())}`);
                setQuery('');
                setShowResults(false);
              }}
            >
              Ask File Box: “{query.trim()}” <span className="workspace-search-enter">Enter</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchBar;


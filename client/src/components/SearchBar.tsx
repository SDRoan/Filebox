import React, { useState, useEffect, useRef } from 'react';
import { FileItemType, Folder } from '../types';
import { searchAPI } from '../services/api';
import { SearchIcon, FolderIcon, DocumentIcon, ImageIcon, VideoIcon } from './Icons';
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
  const containerRef = useRef<HTMLDivElement>(null);

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
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

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

  const handleClear = () => {
    setQuery('');
    setShowResults(false);
    inputRef.current?.focus();
  };

  const renderFileIcon = (file: FileItemType) => {
    if (file.mimeType.startsWith('image/')) {
      return <ImageIcon size={16} color="currentColor" />;
    }
    if (file.mimeType.startsWith('video/')) {
      return <VideoIcon size={16} color="currentColor" />;
    }
    return <DocumentIcon size={16} color="currentColor" />;
  };

  const shouldShowDropdown = showResults && (loading || query.trim().length > 0);

  return (
    <div className="global-search" ref={containerRef}>
      <div className="global-search-meta">
        <span className="global-search-title">Search your drive</span>
        <span className="global-search-caption">Files, folders, and document text</span>
      </div>
      <div className="global-search-input-wrapper">
        <SearchIcon size={18} color="currentColor" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search files, folders, and text inside documents..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.trim().length > 0 && setShowResults(true)}
          className="global-search-input"
        />
        {query ? (
          <button
            type="button"
            className="global-search-clear"
            onClick={handleClear}
          >
            Clear
          </button>
        ) : (
          <div className="global-search-shortcut">
            <kbd>⌘</kbd><kbd>K</kbd>
          </div>
        )}
      </div>

      {shouldShowDropdown && (
        <div className="global-search-results">
          {loading && (
            <div className="global-search-state">Searching...</div>
          )}

          {!loading && results.folders.length > 0 && (
            <div className="global-search-section">
              <div className="global-search-section-title">Folders</div>
              {results.folders.map((folder) => (
                <div
                  key={folder._id}
                  className="global-search-result-item"
                  onClick={() => handleFolderClick(folder)}
                >
                  <span className="global-search-result-icon">
                    <FolderIcon size={16} color="currentColor" />
                  </span>
                  <div className="global-search-result-body">
                    <span className="global-search-result-name">{folder.name}</span>
                    <span className="global-search-result-meta">Folder</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && results.files.length > 0 && (
            <div className="global-search-section">
              <div className="global-search-section-title">
                Files
              </div>
              {results.files.map((file) => (
                <div
                  key={file._id}
                  className="global-search-result-item"
                  onClick={() => handleFileClick(file)}
                >
                  <span className="global-search-result-icon">
                    {renderFileIcon(file)}
                  </span>
                  <div className="global-search-result-body">
                    <span className="global-search-result-name">{file.originalName}</span>
                    <span className="global-search-result-meta">
                      {file.mimeType.includes('pdf') ? 'PDF' : file.mimeType.includes('word') ? 'Document' : 'File'} • {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && results.files.length === 0 && results.folders.length === 0 && query.trim().length > 0 && (
            <div className="global-search-state">No results found</div>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchBar;

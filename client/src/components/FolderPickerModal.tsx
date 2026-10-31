import React, { useState, useEffect, useRef } from 'react';
import { filesAPI } from '../services/api';
import { Folder } from '../types';
import { FolderIcon, CloseIcon } from './Icons';
import './FolderPickerModal.css';

interface FolderPickerModalProps {
  onSelect: (folderId: string | null) => void;
  onClose: () => void;
  excludeFolderId?: string; // Don't show this folder (to prevent moving into itself)
  currentFolderId?: string;
  // Optional wording for other uses (Boards: "Add a folder"); without them the picker reads as before.
  title?: string;
  confirmLabel?: string;
}

const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  onSelect,
  title,
  confirmLabel,
  onClose,
  excludeFolderId,
  currentFolderId,
}) => {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderStack, setFolderStack] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Where focus was when the picker opened (given back when it closes), and whether to put focus on the
  // list once a folder's contents have loaded (after going in or out with the keyboard).
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null) opener.current = document.activeElement as HTMLElement | null;
  const focusList = useRef(true);

  useEffect(() => {
    const back = opener.current;
    return () => { setTimeout(() => { if (back?.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus(); }, 0); };
  }, []);

  useEffect(() => {
    loadFolders();
  }, [currentFolder]);

  const loadFolders = async () => {
    try {
      setLoading(true);
      const data = await filesAPI.getFiles(
        currentFolder === 'root' || !currentFolder ? undefined : currentFolder
      );
      
      // Filter out the excluded folder and current folder
      const filteredFolders = (data.folders || []).filter(
        (f: Folder) => f._id !== excludeFolderId && f._id !== currentFolderId
      );
      
      setFolders(filteredFolders);
    } catch (error) {
      console.error('Error loading folders:', error);
    } finally {
      setLoading(false);
    }
  };

  // After the list loads, keyboard users land on its first row (or Back), not on the page behind.
  useEffect(() => {
    if (loading || !focusList.current) return;
    focusList.current = false;
    const box = dialogRef.current;
    (box?.querySelector<HTMLElement>('.folder-item:not(.root-item)') || box?.querySelector<HTMLElement>('.folder-item') || box?.querySelector<HTMLElement>('.nav-up-btn'))?.focus();
  }, [loading]);

  const handleFolderClick = (folder: Folder) => {
    setFolderStack([...folderStack, folder._id]);
    setCurrentFolder(folder._id);
  };

  const handleNavigateUp = () => {
    focusList.current = true;
    if (folderStack.length > 0) {
      const newStack = [...folderStack];
      newStack.pop();
      setFolderStack(newStack);
      setCurrentFolder(newStack.length > 0 ? newStack[newStack.length - 1] : null);
    } else {
      setCurrentFolder(null);
    }
  };

  const handleSelectRoot = () => {
    onSelect(null);
    onClose();
  };

  const handleSelectFolder = (folderId: string) => {
    onSelect(folderId);
    onClose();
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      alert('Please enter a folder name');
      return;
    }

    try {
      setCreatingFolder(true);
      const newFolder = await filesAPI.createFolder(
        newFolderName.trim(),
        currentFolder === 'root' || !currentFolder ? undefined : currentFolder
      );
      
      // Reload folders to show the new one
      await loadFolders();
      
      // Reset form
      setNewFolderName('');
      setShowCreateFolder(false);
      
      // Optionally auto-select the newly created folder
      // onSelect(newFolder._id);
      // onClose();
    } catch (error: any) {
      console.error('Error creating folder:', error);
      alert(error.response?.data?.message || 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  };

  // Keyboard on a folder row: Enter or Space chooses it (like a click), → looks inside (like a double-click),
  // ← or Backspace goes back up, ↑ / ↓ move between rows.
  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, choose: () => void, open?: () => void) => {
    const rows = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('.folder-item') || []);
    const i = rows.indexOf(event.currentTarget);
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
    else if (event.key === 'ArrowRight' && open) { event.preventDefault(); focusList.current = true; open(); }
    else if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && currentFolder) { event.preventDefault(); handleNavigateUp(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); rows[Math.max(0, i - 1)]?.focus(); }
  };

  // Escape closes the picker (or, while naming a new folder, only cancels that); Tab stays inside it.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !showCreateFolder) { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const getBreadcrumbs = () => {
    const breadcrumbs = ['Root'];
    // We'd need to load folder names for breadcrumbs, but for now just show current
    return breadcrumbs.join(' / ');
  };

  return (
    <div className="folder-picker-overlay" onClick={onClose}>
      <div className="folder-picker-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="folder-picker-title"
        onClick={(e) => e.stopPropagation()} onKeyDown={onDialogKeyDown}>
        <div className="folder-picker-header">
          <h3 id="folder-picker-title">{title || 'Select Destination Folder'}</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} color="currentColor" />
          </button>
        </div>

        <div className="folder-picker-content">
          {loading ? (
            <div className="folder-picker-loading">Loading folders...</div>
          ) : (
            <>
              <div className="folder-picker-nav">
                {currentFolder && (
                  <button className="nav-up-btn" onClick={handleNavigateUp}>
                    ← Back
                  </button>
                )}
                <span className="current-path" aria-live="polite">
                  {currentFolder ? 'Current Folder' : 'Root'}
                </span>
              </div>

              {showCreateFolder ? (
                <div className="create-folder-form">
                  <h4>Create New Folder</h4>
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Enter folder name"
                    className="folder-name-input"
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        handleCreateFolder();
                      } else if (e.key === 'Escape') {
                        setShowCreateFolder(false);
                        setNewFolderName('');
                      }
                    }}
                    autoFocus
                  />
                  <div className="create-folder-actions">
                    <button
                      className="create-btn"
                      onClick={handleCreateFolder}
                      disabled={creatingFolder || !newFolderName.trim()}
                    >
                      {creatingFolder ? 'Creating...' : 'Create'}
                    </button>
                    <button
                      className="cancel-create-btn"
                      onClick={() => {
                        setShowCreateFolder(false);
                        setNewFolderName('');
                      }}
                      disabled={creatingFolder}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="folder-picker-actions-bar">
                    <button
                      className="create-folder-btn"
                      onClick={() => setShowCreateFolder(true)}
                    >
                      + New Folder
                    </button>
                  </div>
                  {confirmLabel && <p className="folder-picker-hint">{confirmLabel}: click a folder (or press Enter). Double-click it (or press →) to look inside.</p>}
                  <p id="folder-picker-keys" className="folder-picker-sr-only">Enter chooses a folder. Right arrow looks inside it, left arrow goes back.</p>
                  <div className="folder-list" role="list" aria-label="Folders">
                <div
                  className="folder-item root-item"
                  role="button"
                  tabIndex={0}
                  aria-label="Choose Root (Home)"
                  onClick={handleSelectRoot}
                  onKeyDown={(e) => onRowKeyDown(e, handleSelectRoot)}
                >
                  <FolderIcon size={20} color="currentColor" className="folder-icon" />
                  <span className="folder-name">Root (Home)</span>
                </div>

                {folders.map((folder) => (
                  <div
                    key={folder._id}
                    className="folder-item"
                    role="button"
                    tabIndex={0}
                    aria-label={`Choose ${folder.name}`}
                    aria-describedby="folder-picker-keys"
                    onClick={() => handleSelectFolder(folder._id)}
                    onDoubleClick={() => handleFolderClick(folder)}
                    onKeyDown={(e) => onRowKeyDown(e, () => handleSelectFolder(folder._id), () => handleFolderClick(folder))}
                  >
                    <FolderIcon size={20} color="currentColor" className="folder-icon" />
                    <span className="folder-name">{folder.name}</span>
                    <span className="folder-arrow" aria-hidden="true">→</span>
                  </div>
                ))}

                    {folders.length === 0 && (
                      <div className="no-folders">
                        No folders available in this location
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="folder-picker-footer">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderPickerModal;


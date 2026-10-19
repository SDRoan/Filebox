import React, { useState, useEffect, useRef, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { FileItem, Folder } from '../types';
import { filesAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import FileItemComponent from './FileItem';
import FolderItem from './FolderItem';
import UploadButton from './UploadButton';
import CreateFolderModal from './CreateFolderModal';
import FileSortFilter, { SortOption, SortOrder, FilterOption } from './FileSortFilter';
import OrganizeReview from './OrganizeReview';
import { AIAssistantIcon, CloseIcon as DialogCloseIcon } from './Icons';
import './AIPanels.css';
import FolderPickerModal from './FolderPickerModal';
import Breadcrumb from './Breadcrumb';
import { FolderIcon, SmartOrganizeIcon, CheckIcon, TrashIcon } from './Icons';
import './FileBrowser.css';

interface FileBrowserProps {
  currentFolderId?: string;
  onFolderClick: (folderId: string) => void;
  onNavigateUp: () => void;
  showTrash?: boolean;
  showStarred?: boolean;
  isTeamFolder?: boolean;
  teamFolderId?: string;
  folderStack?: string[];
  folderPath?: Folder[];
  // Requests from the sidebar's "+ New" menu
  newFolderRequest?: number;
  pendingUploads?: { id: number; files: File[] } | null;
  onPendingUploadsHandled?: () => void;
  onNewFolderHandled?: () => void;
}

const EMPTY_FOLDER_STACK: string[] = [];
const EMPTY_FOLDER_PATH: Folder[] = [];

const FileBrowser: React.FC<FileBrowserProps> = ({
  currentFolderId,
  onFolderClick,
  onNavigateUp,
  showTrash = false,
  showStarred = false,
  isTeamFolder = false,
  teamFolderId,
  folderStack = EMPTY_FOLDER_STACK,
  folderPath = EMPTY_FOLDER_PATH,
  newFolderRequest = 0,
  pendingUploads = null,
  onPendingUploadsHandled,
  onNewFolderHandled,
}) => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [breadcrumbFolders, setBreadcrumbFolders] = useState<Folder[]>([]);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showSmartOrg, setShowSmartOrg] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [filterBy, setFilterBy] = useState<FilterOption>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const { user, refreshUser } = useAuth();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    loadFiles();
  }, [currentFolderId, showTrash, showStarred]);

  // Load breadcrumb folders
  useEffect(() => {
    const loadBreadcrumbFolders = async () => {
      if (folderPath && folderPath.length > 0) {
        setBreadcrumbFolders(folderPath);
      } else if (folderStack && folderStack.length > 1) {
        // Load folder names for breadcrumb
        try {
          const folderIds = folderStack.slice(1); // Skip 'root'
          const loadedFolders: Folder[] = [];
          for (const folderId of folderIds) {
            try {
              // Try to get folder from the folders list first (already loaded)
              const existingFolder = folders.find(f => f._id === folderId);
              if (existingFolder) {
                loadedFolders.push(existingFolder);
              } else {
                // If not found, fetch it
                const folderData = await filesAPI.getFolder(folderId);
                if (folderData) {
                  loadedFolders.push(folderData);
                }
              }
            } catch (error) {
              console.error('Error loading folder for breadcrumb:', error);
            }
          }
          setBreadcrumbFolders(loadedFolders);
        } catch (error) {
          console.error('Error loading breadcrumb folders:', error);
        }
      } else {
        setBreadcrumbFolders([]);
      }
    };
    loadBreadcrumbFolders();
  }, [folderStack, folderPath, folders]);

  // Socket.io real-time updates
  useEffect(() => {
    if (!user) return;

    const socket = io(process.env.REACT_APP_API_URL?.replace('/api', '') || 'http://localhost:5001');
    socketRef.current = socket;

    socket.emit('join-user-room', user.id);

    socket.on('file-uploaded', (file: FileItem) => {
      if (!showTrash && (file.parentFolder === currentFolderId || (!file.parentFolder && currentFolderId === 'root'))) {
        loadFiles();
      }
    });

    socket.on('folder-created', (folder: Folder) => {
      if (!showTrash && (folder.parentFolder === currentFolderId || (!folder.parentFolder && currentFolderId === 'root'))) {
        loadFiles();
      }
    });

    socket.on('file-deleted', () => {
      loadFiles();
    });

    socket.on('folder-deleted', () => {
      loadFiles();
    });

    socket.on('file-restored', () => {
      loadFiles();
    });

    socket.on('folder-restored', () => {
      loadFiles();
    });

    socket.on('file-starred', () => {
      if (showStarred) {
        loadFiles();
      }
    });

    socket.on('file-unstarred', () => {
      if (showStarred) {
        loadFiles();
      }
    });

    socket.on('file-renamed', () => {
      loadFiles();
    });

    socket.on('folder-renamed', () => {
      loadFiles();
    });

    return () => {
      socket.disconnect();
    };
  }, [user, currentFolderId, showTrash, showStarred]);

  const loadFiles = async () => {
    try {
      setLoading(true);
      let data;
      if (isTeamFolder && teamFolderId) {
        // Load files from team folder
        const { teamFoldersAPI } = await import('../services/api');
        data = await teamFoldersAPI.getTeamFolderFiles(teamFolderId);
      } else {
        data = await filesAPI.getFiles(
          currentFolderId === 'root' ? undefined : currentFolderId,
          showTrash,
          showStarred
        );
      }
      setFiles(data.files || []);
      setFolders(data.folders || []);
    } catch (error) {
      console.error('Error loading files:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    try {
      if (isTeamFolder && teamFolderId) {
        // Upload to team folder
        const { teamFoldersAPI } = await import('../services/api');
        await teamFoldersAPI.uploadFile(teamFolderId, file);
      } else {
        await filesAPI.uploadFile(file, currentFolderId === 'root' ? undefined : currentFolderId);
      }
      await Promise.all([loadFiles(), refreshUser()]);
    } catch (error: any) {
      console.error('Error uploading file:', error);
      const errorMessage = error?.response?.data?.message || (error?.code === 'ERR_NETWORK'
        ? 'Cannot reach the file server. Make sure the backend is running on localhost:5001, then try again.'
        : error?.message || 'Failed to upload file');
      alert(errorMessage);
    }
  };

  useEffect(() => {
    if (newFolderRequest > 0) {
      setShowCreateFolder(true);
      onNewFolderHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFolderRequest]);

  useEffect(() => {
    if (!pendingUploads) return;
    (async () => {
      for (const file of pendingUploads.files) {
        await handleFileUpload(file);
      }
      onPendingUploadsHandled?.();
    })();
    // Each batch is handled once, keyed by its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUploads?.id]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    for (const file of droppedFiles) {
      await handleFileUpload(file);
    }
  };

  const handleFolderCreated = () => {
    setShowCreateFolder(false);
    loadFiles();
  };

  const handleDelete = async (id: string, type: 'file' | 'folder') => {
    try {
      if (type === 'file') {
        await filesAPI.deleteFile(id);
      } else {
        await filesAPI.deleteFolder(id);
      }
      loadFiles();
    } catch (error) {
      console.error('Error deleting:', error);
      alert('Failed to delete');
    }
  };

  const handleRestore = async (id: string, type: 'file' | 'folder') => {
    try {
      if (type === 'file') {
        await filesAPI.restoreFile(id);
      } else {
        await filesAPI.restoreFolder(id);
      }
      loadFiles();
    } catch (error) {
      console.error('Error restoring:', error);
      alert('Failed to restore');
    }
  };

  const handleEmptyTrash = async () => {
    const count = files.length + folders.length;
    if (!window.confirm(`Permanently delete all ${count} item${count === 1 ? '' : 's'} in Trash, including everything inside trashed folders? This cannot be undone.`)) return;
    try {
      await filesAPI.emptyTrash();
      await Promise.all([loadFiles(), refreshUser()]);
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Could not empty Trash.');
    }
  };

  const handlePermanentDelete = async (id: string, type: 'file' | 'folder') => {
    if (!window.confirm(type === 'folder'
      ? 'Permanently delete this folder and everything in it? This cannot be undone.'
      : 'Permanently delete this file and its version history? This cannot be undone.')) {
      return;
    }
    try {
      if (type === 'file') {
        await filesAPI.permanentDeleteFile(id);
      } else {
        await filesAPI.permanentDeleteFolder(id);
      }
      await Promise.all([loadFiles(), refreshUser()]);
    } catch (error) {
      console.error('Error permanently deleting:', error);
      alert('Failed to delete');
    }
  };

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedItems);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedItems(newSelection);
    if (newSelection.size === 0) {
      setSelectionMode(false);
    }
  };

  const selectAll = () => {
    const allIds = new Set<string>();
    folders.forEach(f => allIds.add(`folder-${f._id}`));
    files.forEach(f => allIds.add(`file-${f._id}`));
    setSelectedItems(allIds);
    setSelectionMode(true);
  };

  const clearSelection = () => {
    setSelectedItems(new Set());
    setSelectionMode(false);
  };

  const handleBulkDelete = async () => {
    if (selectedItems.size === 0) return;
    
    const confirmMessage = showTrash 
      ? `Permanently delete ${selectedItems.size} item(s), including everything inside selected folders? This cannot be undone.`
      : `Move ${selectedItems.size} item(s) to Trash? You can restore them for 30 days.`;
    
    if (!window.confirm(confirmMessage)) return;

    try {
      const itemsArray = Array.from(selectedItems);
      const deletePromises = itemsArray.map(async (itemId) => {
        const [type, id] = itemId.split('-');
        if (showTrash) {
          // Permanent delete when in trash
          if (type === 'file') {
            await filesAPI.permanentDeleteFile(id);
          } else {
            await filesAPI.permanentDeleteFolder(id);
          }
        } else {
          // Regular delete (move to trash)
          if (type === 'file') {
            await filesAPI.deleteFile(id);
          } else {
            await filesAPI.deleteFolder(id);
          }
        }
      });
      
      await Promise.all(deletePromises);
      clearSelection();
      await Promise.all([loadFiles(), refreshUser()]);
    } catch (error) {
      console.error('Error deleting items:', error);
      alert('Failed to delete some items');
    }
  };

  const handleBulkMove = async (destinationFolderId: string | null) => {
    if (selectedItems.size === 0) return;

    try {
      const itemsArray = Array.from(selectedItems);
      const movePromises = itemsArray.map(async (itemId) => {
        const [type, id] = itemId.split('-');
        if (type === 'file') {
          await filesAPI.moveFile(id, destinationFolderId || undefined);
        } else {
          await filesAPI.moveFolder(id, destinationFolderId || undefined);
        }
      });

      await Promise.all(movePromises);
      clearSelection();
      loadFiles();
    } catch (error) {
      console.error('Error moving items:', error);
      alert('Failed to move some items');
    }
  };

  // Filter and sort files/folders
  const filteredAndSorted = useMemo(() => {
    let filteredFiles = [...files];
    let filteredFolders = [...folders];

    // Apply filters
    if (filterBy === 'folders') {
      filteredFiles = [];
    } else if (filterBy === 'images') {
      filteredFiles = filteredFiles.filter(f => f.mimeType.startsWith('image/'));
    } else if (filterBy === 'videos') {
      filteredFiles = filteredFiles.filter(f => f.mimeType.startsWith('video/'));
    } else if (filterBy === 'documents') {
      filteredFiles = filteredFiles.filter(f => 
        f.mimeType.includes('pdf') || 
        f.mimeType.includes('word') || 
        f.mimeType.includes('excel') ||
        f.mimeType.includes('text')
      );
    }

    // Sort function
    const sortItems = <T extends FileItem | Folder>(items: T[]): T[] => {
      return [...items].sort((a, b) => {
        let comparison = 0;
        
        if (sortBy === 'name') {
          const nameA = 'originalName' in a ? a.originalName : a.name;
          const nameB = 'originalName' in b ? b.originalName : b.name;
          comparison = nameA.localeCompare(nameB);
        } else if (sortBy === 'date') {
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        } else if (sortBy === 'size') {
          const sizeA = 'size' in a ? a.size : 0;
          const sizeB = 'size' in b ? b.size : 0;
          comparison = sizeA - sizeB;
        } else if (sortBy === 'type') {
          const typeA = 'mimeType' in a ? a.mimeType : 'folder';
          const typeB = 'mimeType' in b ? b.mimeType : 'folder';
          comparison = typeA.localeCompare(typeB);
        }
        
        return sortOrder === 'asc' ? comparison : -comparison;
      });
    };

    return {
      files: sortItems(filteredFiles),
      folders: sortItems(filteredFolders)
    };
  }, [files, folders, filterBy, sortBy, sortOrder]);


  const itemCount = filteredAndSorted.folders.length + filteredAndSorted.files.length;

  return (
    <div
      className={`file-browser ${isDragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">
            <div className="drag-icon">➜</div>
            <p>Drop files here to upload</p>
          </div>
        </div>
      )}
      <div className="file-browser-content">
        {breadcrumbFolders.length > 0 && (
          <Breadcrumb
            folders={breadcrumbFolders}
            onFolderClick={(folderId) => {
              // Navigate to the clicked folder in breadcrumb
              const index = breadcrumbFolders.findIndex(f => f._id === folderId);
              if (index !== -1 && folderStack) {
                // Calculate how many levels up we need to go
                const levelsUp = breadcrumbFolders.length - index - 1;
                for (let i = 0; i < levelsUp; i++) {
                  onNavigateUp();
                }
              }
            }}
            onRootClick={() => {
              // Navigate all the way up
              if (folderStack && folderStack.length > 1) {
                const levelsUp = folderStack.length - 1;
                for (let i = 0; i < levelsUp; i++) {
                  onNavigateUp();
                }
              }
            }}
          />
        )}
        <div className="file-page-heading">
          <div>
            <h1>{showTrash ? 'Trash' : showStarred ? 'Starred' : breadcrumbFolders.length > 0 ? breadcrumbFolders[breadcrumbFolders.length - 1].name : 'Your files'}<span className="page-heading-period">.</span></h1>
            <p>{showTrash ? 'Items here are deleted forever 30 days after you delete them. Restore anything you still need.' : showStarred ? 'The things you want to keep close.' : isTeamFolder ? 'Files shared with this Team Space.' : 'Your drive. File Box can help organize it.'}</p>
          </div>
          <div className="file-page-actions">
            {showTrash && files.length + folders.length > 0 && (
              <button className="file-action-button danger" onClick={handleEmptyTrash}><TrashIcon size={16} /><span>Empty Trash</span></button>
            )}
            {!showTrash && !showStarred && <>
              <button className="file-action-button" onClick={() => setShowCreateFolder(true)}><FolderIcon size={16} /><span>New folder</span></button>
              <UploadButton onFileSelect={handleFileUpload} />
            </>}
            <details className="file-more-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={(event) => {
              if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
            }}>
              <summary aria-label="More file actions" title="More file actions"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></summary>
              <div className="file-more-options">
                {!showTrash && !showStarred && !isTeamFolder && <button onClick={(event) => { setShowSmartOrg(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}><SmartOrganizeIcon size={16} />Let File Box organize this</button>}
                <button disabled={files.length + folders.length === 0} onClick={(event) => { setSelectionMode(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CheckIcon size={16} />Select items</button>
              </div>
            </details>
          </div>
        </div>
        <div className="file-browser-header">
          <FileSortFilter sortBy={sortBy} sortOrder={sortOrder} filterBy={filterBy} viewMode={viewMode}
            onSortChange={setSortBy} onSortOrderChange={setSortOrder} onFilterChange={setFilterBy} onViewModeChange={setViewMode} />
        </div>
        {selectionMode && <div className="file-selection-toolbar">
          <span className="selection-count">{selectedItems.size} selected</span>
          <button className="file-action-button" onClick={selectAll}>Select all</button>
          <button className="file-action-button" onClick={clearSelection}>Clear</button>
          {!showTrash && <button className="file-action-button" disabled={selectedItems.size === 0} onClick={() => setShowFolderPicker(true)}>Move to folder</button>}
          <button className="file-action-button danger" disabled={selectedItems.size === 0} onClick={handleBulkDelete}><TrashIcon size={16} />{showTrash ? 'Delete permanently' : 'Move to trash'}</button>
          <button className="file-action-button" onClick={() => { setSelectionMode(false); clearSelection(); }}>Done</button>
        </div>}
        <div className="file-canvas" aria-busy={loading}>
        {loading ? <div className="loading">Loading your files…</div> : (
        filteredAndSorted.folders.length === 0 && filteredAndSorted.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-content">
              <svg className="empty-folder-illustration" width="156" height="126" viewBox="0 0 156 126" fill="none" aria-hidden="true">
                <path d="M30 39a5 5 0 0 1 5-5h29l9 9h47a5 5 0 0 1 5 5v55H30z" strokeWidth="1.3" style={{ fill: 'var(--fb-g-d7e0cd, #d7e0cd)', stroke: 'var(--fb-g-a7b698, #a7b698)' }}/>
                <g transform="rotate(-9 76 63)"><rect x="47" y="20" width="65" height="79" rx="3" strokeWidth="1.3" style={{ fill: 'var(--fb-g-f8f9f4, #f8f9f4)', stroke: 'var(--fb-g-b5c0a9, #b5c0a9)' }}/><path d="M58 37h37M58 46h37M58 55h24" strokeWidth="2" strokeLinecap="round" style={{ stroke: 'var(--fb-g-d3d9cb, #d3d9cb)' }}/></g>
                <path d="M25 57h108l-10 49H35z" strokeWidth="1.3" strokeLinejoin="round" style={{ fill: 'var(--fb-g-e8eddf, #e8eddf)', stroke: 'var(--fb-g-a7b698, #a7b698)' }}/>
                <rect x="60" y="75" width="37" height="13" rx="2" style={{ fill: 'var(--fb-g-f8f9f4, #f8f9f4)', stroke: 'var(--fb-g-c2cdb7, #c2cdb7)' }}/>
                <path d="M70 81.5h17" strokeWidth="1.4" strokeLinecap="round" style={{ stroke: 'var(--fb-g-b1bea4, #b1bea4)' }}/>
                <path d="M23 108h112" strokeWidth="1.3" strokeLinecap="round" style={{ stroke: 'var(--fb-g-d8dfd0, #d8dfd0)' }}/>
              </svg>
              <h2 className="empty-state-title">{filterBy !== 'all' ? 'Nothing in this view yet' : showTrash ? 'All clear.' : showStarred ? 'Keep your favorites here.' : 'Good things start with a file.'}</h2>
              <p className="empty-state-description">{filterBy !== 'all' ? 'Try another file type, or head back to all files.' : showTrash ? 'Deleted items stay here for 30 days, just in case.' : showStarred ? 'Star a file or folder and it will be easy to find here.' : 'Keep your documents, images, and projects together. Add a file to get started.'}</p>
              {filterBy !== 'all' ? <button className="empty-state-link" onClick={() => setFilterBy('all')}>View all files <span aria-hidden="true">→</span></button> : !showTrash && !showStarred && <div className="empty-state-actions"><UploadButton onFileSelect={handleFileUpload} label="Upload your first file" /></div>}
              {!showTrash && !showStarred && filterBy === 'all' && <span className="empty-state-footnote">or simply drag and drop</span>}
            </div>
          </div>
        ) : (
          <div className={`file-list ${viewMode === 'list' ? 'list-view' : 'grid-view'}`}>
            {filteredAndSorted.folders.map((folder) => (
              <FolderItem
                key={folder._id}
                folder={folder}
                onClick={() => selectionMode ? toggleSelection(`folder-${folder._id}`) : onFolderClick(folder._id)}
                onDelete={() => handleDelete(folder._id, 'folder')}
                onRestore={() => handleRestore(folder._id, 'folder')}
                onPermanentDelete={() => handlePermanentDelete(folder._id, 'folder')}
                onMove={loadFiles}
                showTrash={showTrash}
                isSelected={selectionMode && selectedItems.has(`folder-${folder._id}`)}
                selectionMode={selectionMode}
              />
            ))}
            {filteredAndSorted.files.map((file) => (
              <FileItemComponent
                key={file._id}
                file={file}
                onDelete={() => handleDelete(file._id, 'file')}
                onRestore={() => handleRestore(file._id, 'file')}
                onPermanentDelete={() => handlePermanentDelete(file._id, 'file')}
                onRename={loadFiles}
                onMove={loadFiles}
                showTrash={showTrash}
                isSelected={selectionMode && selectedItems.has(`file-${file._id}`)}
                selectionMode={selectionMode}
                onSelect={() => toggleSelection(`file-${file._id}`)}
              />
            ))}
          </div>
        ))}
        <div className="file-canvas-footer"><span>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span><span>{showTrash ? 'Items are kept for 30 days' : `Sorted by ${sortBy === 'date' ? 'date added' : sortBy}`}</span></div>
        </div>
        {!showTrash && !showStarred && <div className="workspace-hint"><span><kbd>⌘ K</kbd> Find what you need, a little faster.</span><button onClick={() => setShowCreateFolder(true)}>Start with a folder <span aria-hidden="true">↗</span></button></div>}
      </div>

      {showCreateFolder && (
        <CreateFolderModal
          currentFolderId={isTeamFolder ? undefined : (currentFolderId === 'root' ? undefined : currentFolderId)}
          onClose={() => setShowCreateFolder(false)}
          onCreated={async () => {
            if (isTeamFolder && teamFolderId) {
              // For team folders, we'll handle creation differently
              // The modal will call the API directly
            }
            loadFiles();
            setShowCreateFolder(false);
          }}
          isTeamFolder={isTeamFolder}
          teamFolderId={teamFolderId}
        />
      )}
      {showSmartOrg && (
        <div className="ai-panel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSmartOrg(false); }}>
          <div className="ai-panel-dialog wide" role="dialog" aria-modal="true" aria-labelledby="organize-title">
            <header className="ai-panel-header">
              <div>
                <h2 id="organize-title"><AIAssistantIcon size={18} /> Let File Box organize this</h2>
                <p>Review each suggestion; nothing changes until you confirm.</p>
              </div>
              <button className="ai-panel-close" onClick={() => setShowSmartOrg(false)} aria-label="Close"><DialogCloseIcon size={18} /></button>
            </header>
            <OrganizeReview folderId={currentFolderId === 'root' ? null : currentFolderId} onApplied={loadFiles} />
          </div>
        </div>
      )}
      {showFolderPicker && (
        <FolderPickerModal
          onSelect={(folderId: string | null) => {
            handleBulkMove(folderId);
            setShowFolderPicker(false);
          }}
          onClose={() => setShowFolderPicker(false)}
          currentFolderId={currentFolderId === 'root' ? undefined : currentFolderId}
        />
      )}
    </div>
  );
};

export default FileBrowser;


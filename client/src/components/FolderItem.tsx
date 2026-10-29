import ItemActions from './ItemActions';
import { formatRelativeTime } from '../utils/fileDisplay';
import React, { useState } from 'react';
import { Folder } from '../types';
import { filesAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import MoveCopyModal from './MoveCopyModal';
import AddToBoardDialog from './AddToBoardDialog';
import ClassificationBadge from './ClassificationBadge';
import { FolderIcon, DownloadIcon, PackageIcon, StarredIcon, TrashIcon, RestoreIcon, BoardsIcon } from './Icons';
import './FolderItem.css';

interface FolderItemProps {
  folder: Folder;
  onClick: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
  onMove?: () => void;
  showTrash: boolean;
  isSelected?: boolean;
  selectionMode?: boolean;
}

const FolderItem: React.FC<FolderItemProps> = ({
  folder,
  onClick,
  onDelete,
  onRestore,
  onPermanentDelete,
  onMove,
  showTrash,
  isSelected = false,
  selectionMode = false,
}) => {
  const { user } = useAuth();
  // Folder actions are owner-only on the server; teammates' folders in a Team Space only open.
  const ownerId = typeof folder.owner === 'object' && folder.owner ? ((folder.owner as any)._id || (folder.owner as any).id) : folder.owner;
  const isOwner = !ownerId || !user || ownerId === user.id;
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showAddToBoard, setShowAddToBoard] = useState(false);

  const handleDownloadAsZip = async () => {
    try {
      const blob = await filesAPI.downloadFolderAsZip(folder._id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${folder.name}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error downloading folder:', error);
      alert('Failed to download folder');
    }
  };
  return (
    <div className={`folder-item ${isSelected ? 'selected' : ''}`} onClick={onClick}>
      {selectionMode && (
        <input
          type="checkbox"
            aria-label={`Select ${folder.name}`}
          checked={isSelected}
          readOnly
          className="selection-checkbox"
          onClick={(e) => { e.stopPropagation(); onClick(); }}
        />
      )}
      <div className="folder-icon">
        <FolderIcon size={32} color="currentColor" />
      </div>
      <div className="folder-info">
        <div className="folder-name" title={folder.name}>
          {folder.name}
        </div>
          <div className="folder-meta">
            {showTrash && folder.deletedAt ? (
              <span className="recovery-info">
                Deleted {formatRelativeTime(folder.deletedAt)}{((folder as any).originalLocation) ? ` · from ${(folder as any).originalLocation}` : ''}
                {(() => {
                  const daysDeleted = Math.floor((Date.now() - new Date(folder.deletedAt).getTime()) / (1000 * 60 * 60 * 24));
                  const daysRemaining = 30 - daysDeleted;
                  return daysRemaining > 0
                    ? ` · deleted forever in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`
                    : ' · will be deleted forever soon';
                })()}
              </span>
            ) : (
              <>{new Date(folder.createdAt).toLocaleDateString()}</>
            )}
          {folder.dataClassification && (
            <div style={{ marginTop: '4px' }}>
              <ClassificationBadge classification={folder.dataClassification} size="small" />
            </div>
          )}
        </div>
      </div>
      <ItemActions className="folder-actions" label={`Actions for ${folder.name}`}>
        {!showTrash ? (
          <>
            <button onClick={() => setShowAddToBoard(true)} className="icon-button" title="Add to board…">
              <BoardsIcon size={18} color="currentColor" />
            </button>
            {isOwner && (
              <button onClick={handleDownloadAsZip} className="icon-button" title="Download as ZIP">
                <DownloadIcon size={18} color="currentColor" />
              </button>
            )}
            {isOwner && (
              <button onClick={() => setShowMoveModal(true)} className="icon-button" title="Move">
                <PackageIcon size={18} color="currentColor" />
              </button>
            )}
            {isOwner && (
              <button
                onClick={() => filesAPI.starFolder(folder._id)}
                className={`icon-button ${folder.isStarred ? 'starred' : ''}`}
                title={folder.isStarred ? 'Unstar' : 'Star'}
              >
                <StarredIcon size={18} color="currentColor" />
              </button>
            )}
            {isOwner && (
              <button onClick={onDelete} className="icon-button danger" title="Move to Trash">
                <TrashIcon size={18} color="currentColor" />
              </button>
            )}
          </>
        ) : (
          <>
            <button onClick={onRestore} className="icon-button" title="Restore">
              <RestoreIcon size={18} color="currentColor" />
            </button>
            <button
              onClick={onPermanentDelete}
              className="icon-button danger"
              title="Delete permanently"
            >
              <TrashIcon size={18} color="currentColor" />
            </button>
          </>
        )}
      </ItemActions>
      {showAddToBoard && (
        <AddToBoardDialog item={{ type: 'folder', id: folder._id, name: folder.name }} onClose={() => setShowAddToBoard(false)} />
      )}
      {showMoveModal && (
        <MoveCopyModal
          itemId={folder._id}
          itemName={folder.name}
          itemType="folder"
          operation="move"
          onClose={() => setShowMoveModal(false)}
          onSuccess={() => {
            setShowMoveModal(false);
            onMove?.();
          }}
        />
      )}
    </div>
  );
};

export default FolderItem;


import React, { useEffect, useRef, useState } from 'react';
import { filesAPI } from '../services/api';
import './CreateFolderModal.css';

interface CreateFolderModalProps {
  currentFolderId?: string;
  onClose: () => void;
  onCreated: () => void;
  isTeamFolder?: boolean;
  teamFolderId?: string;
}

const CreateFolderModal: React.FC<CreateFolderModalProps> = ({
  currentFolderId,
  onClose,
  onCreated,
  isTeamFolder = false,
  teamFolderId,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      setLoading(true);
      if (isTeamFolder && teamFolderId) {
        const { teamFoldersAPI } = await import('../services/api');
        await teamFoldersAPI.createFolder(teamFolderId, name.trim());
      } else {
        await filesAPI.createFolder(name.trim(), currentFolderId);
      }
      onCreated();
    } catch (error) {
      console.error('Error creating folder:', error);
      alert('Failed to create folder');
    } finally {
      setLoading(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="folder-dialog" aria-labelledby="folder-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="folder-dialog-content" onClick={(e) => e.stopPropagation()}>
        <h2 id="folder-dialog-title">New folder</h2>
        <p>A little space for a project of its own.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="folder-name">Folder name</label>
          <input
            id="folder-name"
            type="text"
            placeholder="Untitled folder"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="folder-dialog-input"
          />
          <div className="folder-dialog-actions">
            <button type="button" onClick={onClose} className="folder-dialog-cancel">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim()} className="folder-dialog-create">
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};

export default CreateFolderModal;




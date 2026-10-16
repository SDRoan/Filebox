import React, { useState, useEffect } from 'react';
import { filesAPI } from '../services/api';
import './FileVersions.css';

interface FileVersion {
  _id: string;
  versionNumber: number;
  size: number;
  uploadedBy?: {
    name: string;
    email: string;
  } | null;
  changeDescription: string;
  createdAt: string;
}

interface FileVersionsProps {
  fileId: string;
  onClose: () => void;
  onUploadNewVersion: () => void;
  fileName?: string;
  canRestore?: boolean;
}

const FileVersions: React.FC<FileVersionsProps> = ({
  fileId,
  onClose,
  onUploadNewVersion,
  fileName = 'file',
  canRestore = true,
}) => {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadVersions();
  }, [fileId]);

  const loadVersions = async () => {
    try {
      setLoading(true);
      const data = await filesAPI.getFileVersions(fileId);
      setVersions(data);
    } catch (error) {
      console.error('Error loading versions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadVersion = async (versionId: string) => {
    try {
      const blob = await filesAPI.downloadFileVersion(versionId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `v${versions.find(v => v._id === versionId)?.versionNumber} - ${fileName}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error downloading version:', error);
      alert('Failed to download version');
    }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!window.confirm('Restore this version? The current contents are saved as a new version first, so nothing is lost.')) {
      return;
    }

    try {
      await filesAPI.restoreFileVersion(versionId);
      alert('Version restored successfully!');
      loadVersions();
      onClose();
    } catch (error) {
      console.error('Error restoring version:', error);
      alert('Failed to restore version');
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content file-versions-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Version history</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>

        <div className="versions-actions">
          <button onClick={onUploadNewVersion} className="action-button">
            Upload new version
          </button>
        </div>

        <p className="versions-note">Earlier contents of “{fileName}”. The current file is not listed; restoring a version keeps the current contents as another version.</p>
        {loading ? (
          <div className="loading">Loading versions...</div>
        ) : versions.length === 0 ? (
          <div className="empty-state">No earlier versions yet. When this file is edited or a new version is uploaded, the previous contents are kept here.</div>
        ) : (
          <div className="versions-list">
            {versions.map((version) => (
              <div key={version._id} className="version-item">
                <div className="version-info">
                  <div className="version-header">
                    <span className="version-number">Version {version.versionNumber}</span>
                  </div>
                  <div className="version-meta">
                    <span>{formatSize(version.size)}</span>
                    <span>•</span>
                    <span>{new Date(version.createdAt).toLocaleString()}</span>
                    <span>•</span>
                    <span>{version.uploadedBy?.name || 'Unknown'}</span>
                  </div>
                  {version.changeDescription && (
                    <div className="version-description">{version.changeDescription}</div>
                  )}
                </div>
                <div className="version-actions">
                  <button
                    onClick={() => handleDownloadVersion(version._id)}
                    className="version-btn"
                    aria-label={`Download version ${version.versionNumber}`}
                  >
                    Download
                  </button>
                  {canRestore && (
                    <button
                      onClick={() => handleRestoreVersion(version._id)}
                      className="version-btn restore-btn"
                      aria-label={`Restore version ${version.versionNumber}`}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default FileVersions;



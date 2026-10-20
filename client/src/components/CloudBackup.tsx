import React, { useState, useEffect } from 'react';
import { CloudBackupIcon, PlusIcon, LoadingIcon, TrashIcon, EditIcon, RefreshIcon } from './Icons';
import { cloudBackupAPI } from '../services/api';
import './CloudBackup.css';

interface CloudBackup {
  _id: string;
  sourceType: 'desktop' | 'documents' | 'custom';
  sourcePath: string;
  enabled: boolean;
  backupFrequency: 'hourly' | 'daily' | 'weekly';
  lastBackupAt: string | null;
  nextBackupAt: string | null;
  backupCount: number;
  totalFilesBackedUp: number;
  totalSizeBackedUp: number;
  status: 'idle' | 'backing_up' | 'completed' | 'failed';
  lastError: string | null;
  lastResult?: {
    copied: number;
    updated: number;
    unchanged: number;
    skippedCloudOnly: number;
    skippedQuota: number;
    skippedOther: number;
    at: string | null;
  };
  createdAt: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line about what the last sync did. */
function lastRunSummary(result: CloudBackup['lastResult']): string {
  if (!result?.at) return '';
  const parts = [];
  if (result.copied) parts.push(`${plural(result.copied, 'new file')} copied`);
  if (result.updated) parts.push(`${plural(result.updated, 'changed file')} updated`);
  if (!result.copied && !result.updated) parts.push('Everything was already up to date');
  if (result.skippedCloudOnly) parts.push(`${plural(result.skippedCloudOnly, 'file')} skipped (only in iCloud, not on this Mac)`);
  if (result.skippedQuota) parts.push(`${plural(result.skippedQuota, 'file')} skipped (storage full)`);
  if (result.skippedOther) parts.push(`${plural(result.skippedOther, 'file')} skipped (could not copy, or a file you added has that name)`);
  return parts.join(' · ');
}

const CloudBackup: React.FC = () => {
  const [backups, setBackups] = useState<CloudBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [defaultPaths, setDefaultPaths] = useState<any>({});
  const [formData, setFormData] = useState({
    sourceType: 'desktop' as 'desktop' | 'documents' | 'custom',
    sourcePath: '',
    enabled: true,
    backupFrequency: 'daily' as 'hourly' | 'daily' | 'weekly',
  });
  const [editingBackup, setEditingBackup] = useState<CloudBackup | null>(null);
  const [backingUp, setBackingUp] = useState<string | null>(null);

  useEffect(() => {
    loadBackups();
    loadDefaultPaths();
  }, []);

  // While a folder is syncing, check its progress every few seconds.
  const syncing = backups.some(backup => backup.status === 'backing_up');
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => {
      cloudBackupAPI.getBackups().then(setBackups).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [syncing]);

  const loadBackups = async () => {
    try {
      setLoading(true);
      const data = await cloudBackupAPI.getBackups();
      setBackups(data);
    } catch (error: any) {
      alert(error.response?.data?.message || 'Could not load your synced folders.');
    } finally {
      setLoading(false);
    }
  };

  const loadDefaultPaths = async () => {
    try {
      const paths = await cloudBackupAPI.getDefaultPaths();
      setDefaultPaths(paths);
      // Set default path based on available paths
      if (paths.desktop?.exists) {
        setFormData(prev => ({ ...prev, sourceType: 'desktop', sourcePath: paths.desktop.path }));
      } else if (paths.documents?.exists) {
        setFormData(prev => ({ ...prev, sourceType: 'documents', sourcePath: paths.documents.path }));
      }
    } catch (error) {
      console.error('Error loading default paths:', error);
    }
  };

  const handleOpenModal = (backup?: CloudBackup) => {
    if (backup) {
      setEditingBackup(backup);
      setFormData({
        sourceType: backup.sourceType,
        sourcePath: backup.sourcePath,
        enabled: backup.enabled,
        backupFrequency: backup.backupFrequency,
      });
    } else {
      setEditingBackup(null);
      loadDefaultPaths();
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingBackup(null);
    setFormData({
      sourceType: 'desktop',
      sourcePath: '',
      enabled: true,
      backupFrequency: 'daily',
    });
  };

  const handleSourceTypeChange = (type: 'desktop' | 'documents' | 'custom') => {
    setFormData(prev => {
      let newPath = prev.sourcePath;
      if (type === 'desktop' && defaultPaths.desktop?.exists) {
        newPath = defaultPaths.desktop.path;
      } else if (type === 'documents' && defaultPaths.documents?.exists) {
        newPath = defaultPaths.documents.path;
      } else if (type === 'custom') {
        newPath = '';
      }
      return { ...prev, sourceType: type, sourcePath: newPath };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingBackup) {
        await cloudBackupAPI.updateBackup(editingBackup._id, {
          enabled: formData.enabled,
          backupFrequency: formData.backupFrequency,
        });
      } else {
        await cloudBackupAPI.createBackup(formData);
      }
      handleCloseModal();
      loadBackups();
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Could not save this sync.';
      alert(errorMessage);
    }
  };

  const handleDelete = async (backupId: string) => {
    if (!window.confirm('Stop syncing this folder? Files already copied stay in File Box.')) {
      return;
    }
    try {
      await cloudBackupAPI.deleteBackup(backupId);
      loadBackups();
    } catch (error: any) {
      alert(error.response?.data?.message || 'Could not remove this sync.');
    }
  };

  const handleToggleEnabled = async (backup: CloudBackup) => {
    try {
      await cloudBackupAPI.updateBackup(backup._id, {
        enabled: !backup.enabled,
      });
      loadBackups();
    } catch (error: any) {
      alert(error.response?.data?.message || 'Could not update this sync.');
    }
  };

  const handlePerformBackup = async (backupId: string) => {
    try {
      setBackingUp(backupId);
      // Starts in the background; the card shows progress until it finishes.
      const started = await cloudBackupAPI.performBackup(backupId);
      setBackups(prev => prev.map(backup => backup._id === backupId ? { ...backup, ...started } : backup));
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Could not start syncing.';
      alert(errorMessage);
    } finally {
      setBackingUp(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'backing_up':
        return '#3b82f6';
      case 'completed':
        return '#1e40af';
      case 'failed':
        return '#dc2626';
      default:
        return '#6b7280';
    }
  };

  const getSourceTypeLabel = (type: string) => {
    switch (type) {
      case 'desktop':
        return 'Desktop';
      case 'documents':
        return 'Documents';
      case 'custom':
        return 'Custom Path';
      default:
        return type;
    }
  };

  return (
    <div className="cloud-backup">
      <div className="backup-header">
        <h2><CloudBackupIcon size={24} color="currentColor" /> Folder Sync</h2>
        <div className="backup-header-actions">
          <button className="btn-primary" onClick={() => handleOpenModal()} disabled={defaultPaths.enabled === false}>
            <PlusIcon size={16} color="currentColor" /> Sync a folder
          </button>
        </div>
      </div>
      <p className="backup-intro">
        Copies a folder from this computer into File Box and keeps the copy up to date, so you can search it and ask File Box AI about it.
        New and changed files are copied; deleting a file from the folder does not delete it here.
        The copy stays on this computer, so it is not an off-site backup.
      </p>
      {defaultPaths.enabled === false && (
        <div className="backup-error">Folder Sync is turned off on this File Box.</div>
      )}

      {loading ? (
        <div className="loading-state">
          <LoadingIcon size={40} color="#3b82f6" />
          <p>Loading backup configurations...</p>
        </div>
      ) : backups.length === 0 ? (
        <div className="empty-state">
          <CloudBackupIcon size={64} color="#ccc" />
          <h3>No folders synced yet</h3>
          <p>Choose a folder, such as Documents, to copy into File Box and keep up to date.</p>
          <button className="btn-primary" onClick={() => handleOpenModal()} disabled={defaultPaths.enabled === false}>
            <PlusIcon size={16} color="currentColor" /> Sync a folder
          </button>
        </div>
      ) : (
        <div className="backups-list">
          {backups.map((backup) => (
            <div key={backup._id} className="backup-card">
              <div className="backup-card-header">
                <div className="backup-info">
                  <h3>{getSourceTypeLabel(backup.sourceType)}</h3>
                  <p className="backup-path">{backup.sourcePath}</p>
                </div>
                <div className="backup-status">
                  <span
                    className="status-badge"
                    style={{ backgroundColor: getStatusColor(backup.status) }}
                  >
                    {backup.status === 'backing_up' ? 'Syncing…' :
                     backup.status === 'completed' ? 'Up to date' :
                     backup.status === 'failed' ? 'Failed' : 'Not synced yet'}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={backup.enabled}
                      onChange={() => handleToggleEnabled(backup)}
                      aria-label="Sync automatically"
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              </div>

              <div className="backup-stats">
                <div className="stat-item">
                  <span className="stat-label">Frequency:</span>
                  <span className="stat-value">{backup.backupFrequency}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Last sync:</span>
                  <span className="stat-value">{formatDate(backup.lastBackupAt)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Syncs:</span>
                  <span className="stat-value">{backup.backupCount}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Files copied:</span>
                  <span className="stat-value">{backup.totalFilesBackedUp}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Copied size:</span>
                  <span className="stat-value">{formatBytes(backup.totalSizeBackedUp)}</span>
                </div>
              </div>

              {backup.status !== 'backing_up' && lastRunSummary(backup.lastResult) && (
                <p className="backup-last-run">Last run: {lastRunSummary(backup.lastResult)}</p>
              )}
              {backup.lastError && (
                <div className="backup-error">{backup.lastError}</div>
              )}

              <div className="backup-actions">
                <button
                  className="btn-secondary"
                  onClick={() => handlePerformBackup(backup._id)}
                  disabled={backingUp === backup._id || backup.status === 'backing_up'}
                >
                  <RefreshIcon size={16} color="currentColor" />
                  {backup.status === 'backing_up' ? 'Syncing…' : 'Sync now'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => handleOpenModal(backup)}
                >
                  <EditIcon size={16} color="currentColor" />
                  Edit
                </button>
                <button
                  className="btn-danger"
                  onClick={() => handleDelete(backup._id)}
                >
                  <TrashIcon size={16} color="currentColor" />
                  Stop syncing
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={handleCloseModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingBackup ? 'Edit sync' : 'Sync a folder'}</h3>
              <button className="modal-close" onClick={handleCloseModal}>×</button>
            </div>
            <form onSubmit={handleSubmit} className="backup-form">
              <div className="form-group">
                <label>Folder</label>
                <select
                  value={formData.sourceType}
                  onChange={(e) => handleSourceTypeChange(e.target.value as any)}
                  disabled={!!editingBackup}
                >
                  {defaultPaths.desktop?.exists && (
                    <option value="desktop">Desktop</option>
                  )}
                  {defaultPaths.documents?.exists && (
                    <option value="documents">Documents</option>
                  )}
                  <option value="custom">Another folder</option>
                </select>
              </div>

              <div className="form-group">
                <label>Folder path</label>
                <input
                  type="text"
                  value={formData.sourcePath}
                  onChange={(e) => setFormData(prev => ({ ...prev, sourcePath: e.target.value }))}
                  placeholder={formData.sourceType === 'desktop' ? defaultPaths.desktop?.path : 
                              formData.sourceType === 'documents' ? defaultPaths.documents?.path : 
                              `A folder inside ${(defaultPaths.roots || ['your home folder']).join(' or ')}`}
                  disabled={!!editingBackup || formData.sourceType !== 'custom'}
                  required
                />
                <p className="form-hint">
                  Only folders inside {(defaultPaths.roots || ['your home folder']).join(' or ')} can be synced. Files that are only in iCloud are skipped, and copies count toward your storage.
                </p>
              </div>

              <div className="form-group">
                <label>How often</label>
                <select
                  value={formData.backupFrequency}
                  onChange={(e) => setFormData(prev => ({ ...prev, backupFrequency: e.target.value as any }))}
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.enabled}
                    onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                  />
                  Sync automatically
                </label>
              </div>

              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={handleCloseModal}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  {editingBackup ? 'Save' : 'Start syncing'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CloudBackup;

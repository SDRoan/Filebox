import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  cloudBackupAPI,
  fileRequestsAPI,
  filesAPI,
  securedLinksAPI,
  shareAPI,
} from '../services/api';
import {
  CloudBackupIcon,
  DocumentIcon,
  DownloadIcon,
  FileRequestsIcon,
  FilesIcon,
  FolderIcon,
  RefreshIcon,
  SecurityIcon,
  SharedIcon,
  StorageIcon,
  TrashIcon,
} from './Icons';
import './StorageHome.css';

interface StorageHomeProps {
  onOpenView: (view: string) => void;
}

interface ActivityItem {
  _id: string;
  action: string;
  details?: string;
  createdAt: string;
  file?: {
    originalName: string;
  };
  folder?: {
    name: string;
  };
}

interface SharedStat {
  fileId: string;
  viewCount: number;
  downloadCount: number;
  previewCount: number;
  totalAccess: number;
  lastAccessed?: string;
  uniqueUserCount: number;
}

interface BackupItem {
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
  createdAt: string;
}

interface FileRequestItem {
  _id: string;
  title: string;
  status: 'open' | 'fulfilled' | 'closed';
  uploadedFiles: Array<{
    file: {
      size: number;
    };
  }>;
  expiresAt?: string;
  createdAt: string;
}

interface SecuredLinkItem {
  _id: string;
  title: string;
  isPasswordProtected: boolean;
  isEncrypted: boolean;
  accessCount: number;
  expiresAt?: string;
  createdAt: string;
}

interface LibraryItem {
  _id: string;
  label: string;
  updatedAt: string;
  kind: 'file' | 'folder';
  size?: number;
}

const getSettledValue = <T,>(result: PromiseSettledResult<T>, fallback: T): T => {
  return result.status === 'fulfilled' ? result.value : fallback;
};

const StorageHome: React.FC<StorageHomeProps> = ({ onOpenView }) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [libraryFiles, setLibraryFiles] = useState<any[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<any[]>([]);
  const [trashFiles, setTrashFiles] = useState<any[]>([]);
  const [trashFolders, setTrashFolders] = useState<any[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<any[]>([]);
  const [sharedByMe, setSharedByMe] = useState<any[]>([]);
  const [sharedStats, setSharedStats] = useState<SharedStat[]>([]);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [requests, setRequests] = useState<FileRequestItem[]>([]);
  const [securedLinks, setSecuredLinks] = useState<SecuredLinkItem[]>([]);

  useEffect(() => {
    loadOverview();
  }, []);

  const loadOverview = async () => {
    setLoading(true);
    setError('');

    const results = await Promise.allSettled([
      filesAPI.getFiles(),
      filesAPI.getFiles(undefined, true),
      filesAPI.getUserActivity(),
      shareAPI.getSharedWithMe(),
      shareAPI.getSharedByMe(),
      shareAPI.getSharedFilesStats(),
      cloudBackupAPI.getBackups(),
      fileRequestsAPI.getFileRequests(),
      securedLinksAPI.getSecuredLinks(),
    ]);

    const library = getSettledValue(results[0], { files: [], folders: [] });
    const trash = getSettledValue(results[1], { files: [], folders: [] });

    setLibraryFiles(Array.isArray(library.files) ? library.files : []);
    setLibraryFolders(Array.isArray(library.folders) ? library.folders : []);
    setTrashFiles(Array.isArray(trash.files) ? trash.files : []);
    setTrashFolders(Array.isArray(trash.folders) ? trash.folders : []);
    setActivities(getSettledValue(results[2], []));
    setSharedWithMe(getSettledValue(results[3], []));
    setSharedByMe(getSettledValue(results[4], []));
    setSharedStats(getSettledValue(results[5], []));
    setBackups(getSettledValue(results[6], []));
    setRequests(getSettledValue(results[7], []));
    setSecuredLinks(getSettledValue(results[8], []));

    if (results.every((result) => result.status === 'rejected')) {
      setError('We could not load the storage overview right now.');
    }

    setLoading(false);
  };

  const storagePercent = user?.storageLimit
    ? Math.min(Math.max((user.storageUsed / user.storageLimit) * 100, 0), 100)
    : 0;
  const remainingBytes = Math.max((user?.storageLimit || 0) - (user?.storageUsed || 0), 0);
  const recoverableCount = trashFiles.length + trashFolders.length;
  const activeBackups = backups.filter((backup) => backup.enabled);
  const openRequests = requests.filter((request) => request.status === 'open');
  const protectedLinks = securedLinks.filter((link) => link.isEncrypted || link.isPasswordProtected);
  const totalSharedAccess = sharedStats.reduce((sum, stat) => sum + (stat.totalAccess || 0), 0);
  const totalSharedDownloads = sharedStats.reduce((sum, stat) => sum + (stat.downloadCount || 0), 0);

  const recentItems = useMemo<LibraryItem[]>(() => {
    const items = [
      ...libraryFolders.map((folder) => ({
        _id: folder._id,
        label: folder.name,
        updatedAt: folder.updatedAt || folder.createdAt,
        kind: 'folder' as const,
      })),
      ...libraryFiles.map((file) => ({
        _id: file._id,
        label: file.originalName,
        updatedAt: file.updatedAt || file.createdAt,
        kind: 'file' as const,
        size: file.size,
      })),
    ];

    return items
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [libraryFiles, libraryFolders]);

  const recentActivity = useMemo(() => activities.slice(0, 6), [activities]);

  const latestBackup = useMemo(() => {
    return [...activeBackups]
      .filter((backup) => backup.lastBackupAt || backup.createdAt)
      .sort((a, b) => {
        const left = new Date(b.lastBackupAt || b.createdAt).getTime();
        const right = new Date(a.lastBackupAt || a.createdAt).getTime();
        return left - right;
      })[0];
  }, [activeBackups]);

  const nextBackup = useMemo(() => {
    return [...activeBackups]
      .filter((backup) => backup.nextBackupAt)
      .sort((a, b) => {
        const left = new Date(a.nextBackupAt || a.createdAt).getTime();
        const right = new Date(b.nextBackupAt || b.createdAt).getTime();
        return left - right;
      })[0];
  }, [activeBackups]);

  const atRiskBackups = activeBackups.filter(
    (backup) => backup.status === 'failed' || backup.lastError
  );

  const expiringRequestsSoon = openRequests.filter((request) => {
    if (!request.expiresAt) return false;
    const days = Math.ceil(
      (new Date(request.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    return days >= 0 && days <= 7;
  }).length;

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, index);
    return `${Math.round(value * 100) / 100} ${sizes[index]}`;
  };

  const formatRelativeTime = (dateString?: string | null) => {
    if (!dateString) return 'Not yet';

    const date = new Date(dateString);
    const diff = date.getTime() - Date.now();
    const days = Math.floor(Math.abs(diff) / (1000 * 60 * 60 * 24));

    if (diff > 0) {
      if (days <= 0) return 'Today';
      if (days === 1) return 'In 1 day';
      if (days < 7) return `In ${days} days`;
      if (days < 30) return `In ${Math.floor(days / 7)} weeks`;
      return date.toLocaleDateString();
    }

    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return date.toLocaleDateString();
  };

  const formatActivity = (activity: ActivityItem) => {
    const actionMap: Record<string, string> = {
      uploaded: 'Uploaded',
      downloaded: 'Downloaded',
      deleted: 'Deleted',
      restored: 'Restored',
      renamed: 'Renamed',
      moved: 'Moved',
      copied: 'Copied',
      shared: 'Shared',
      starred: 'Starred',
      unstarred: 'Removed star from',
      version_created: 'Saved a new version of',
      version_restored: 'Restored a version of',
      edited: 'Edited',
    };

    const target = activity.file?.originalName || activity.folder?.name || activity.details || 'a file';
    return `${actionMap[activity.action] || 'Updated'} ${target}`;
  };

  const getBackupLabel = (backup: BackupItem) => {
    if (backup.sourceType === 'desktop') return 'Desktop';
    if (backup.sourceType === 'documents') return 'Documents';
    return 'Custom path';
  };

  if (loading) {
    return (
      <div className="storage-home">
        <div className="storage-home-loading">Preparing your storage snapshot...</div>
      </div>
    );
  }

  return (
    <div className="storage-home">
      <section className="storage-home-hero">
        <div className="storage-home-hero-copy">
          <span className="storage-home-kicker">Drive Home</span>
          <h2>Your drive at a glance.</h2>
          <p>
            The goal here is simple: make storage, recent work, sharing, backup, and recovery feel
            like one dependable cloud drive instead of a stack of unrelated tools.
          </p>
          <div className="storage-home-trust-row">
            <span>{libraryFiles.length + libraryFolders.length} items in drive</span>
            <span>{sharedByMe.length} files shared by you</span>
            <span>{recoverableCount} items recoverable</span>
            <span>{activeBackups.length} backups active</span>
          </div>
        </div>

        <div className="storage-home-hero-side">
          <div className="storage-home-storage-card">
            <div className="storage-home-storage-header">
              <div>
                <span className="storage-home-card-kicker">Capacity</span>
                <strong>{Math.round(storagePercent)}% used</strong>
              </div>
              <StorageIcon size={22} color="currentColor" />
            </div>
            <div className="storage-home-progress">
              <div
                className="storage-home-progress-fill"
                style={{ width: `${storagePercent}%` }}
              />
            </div>
            <div className="storage-home-storage-meta">
              <span>{formatBytes(user?.storageUsed || 0)} in use</span>
              <span>{formatBytes(remainingBytes)} free</span>
            </div>
          </div>

          <div className="storage-home-actions">
            <button type="button" className="storage-home-action" onClick={() => onOpenView('files')}>
              <FilesIcon size={16} color="currentColor" />
              <span>All Files</span>
            </button>
            <button type="button" className="storage-home-action" onClick={() => onOpenView('shared')}>
              <SharedIcon size={16} color="currentColor" />
              <span>Shared</span>
            </button>
            <button type="button" className="storage-home-action" onClick={() => onOpenView('requests')}>
              <FileRequestsIcon size={16} color="currentColor" />
              <span>Requests</span>
            </button>
            <button type="button" className="storage-home-action" onClick={() => onOpenView('cloud-backup')}>
              <CloudBackupIcon size={16} color="currentColor" />
              <span>Backup</span>
            </button>
            <button type="button" className="storage-home-refresh" onClick={loadOverview}>
              <RefreshIcon size={16} color="currentColor" />
              <span>Refresh Snapshot</span>
            </button>
          </div>
        </div>
      </section>

      {error && <div className="storage-home-error">{error}</div>}

      <section className="storage-home-metrics">
        <div className="storage-home-metric">
          <div className="storage-home-metric-icon">
            <FilesIcon size={18} color="currentColor" />
          </div>
          <strong>{libraryFiles.length + libraryFolders.length}</strong>
          <span>Active items</span>
        </div>
        <div className="storage-home-metric">
          <div className="storage-home-metric-icon">
            <SharedIcon size={18} color="currentColor" />
          </div>
          <strong>{sharedByMe.length}</strong>
          <span>Files shared by you</span>
        </div>
        <div className="storage-home-metric">
          <div className="storage-home-metric-icon">
            <DownloadIcon size={18} color="currentColor" />
          </div>
          <strong>{totalSharedDownloads}</strong>
          <span>Shared downloads</span>
        </div>
        <div className="storage-home-metric">
          <div className="storage-home-metric-icon">
            <TrashIcon size={18} color="currentColor" />
          </div>
          <strong>{recoverableCount}</strong>
          <span>Recoverable items</span>
        </div>
        <div className="storage-home-metric">
          <div className="storage-home-metric-icon">
            <CloudBackupIcon size={18} color="currentColor" />
          </div>
          <strong>{activeBackups.length}</strong>
          <span>Backups enabled</span>
        </div>
      </section>

      <div className="storage-home-grid">
        <section className="storage-home-panel">
          <div className="storage-home-panel-header">
            <div>
              <span className="storage-home-card-kicker">Recent</span>
              <h3>Recent files and folders</h3>
            </div>
            <button type="button" onClick={() => onOpenView('files')}>
              Open drive
            </button>
          </div>

          {recentItems.length === 0 ? (
            <div className="storage-home-empty">No files or folders yet.</div>
          ) : (
            <div className="storage-home-list">
              {recentItems.map((item) => (
                <button
                  key={item._id}
                  type="button"
                  className="storage-home-list-item"
                  onClick={() => onOpenView('files')}
                >
                  <span className="storage-home-item-icon">
                    {item.kind === 'folder' ? (
                      <FolderIcon size={16} color="currentColor" />
                    ) : (
                      <DocumentIcon size={16} color="currentColor" />
                    )}
                  </span>
                  <span className="storage-home-item-copy">
                    <strong>{item.label}</strong>
                    <span>
                      {item.kind === 'folder' ? 'Folder' : item.size ? formatBytes(item.size) : 'File'} •{' '}
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="storage-home-panel">
          <div className="storage-home-panel-header">
            <div>
              <span className="storage-home-card-kicker">Activity</span>
              <h3>Recent changes</h3>
            </div>
            <button type="button" onClick={() => onOpenView('files')}>
              Open files
            </button>
          </div>

          {recentActivity.length === 0 ? (
            <div className="storage-home-empty">No recent file activity yet.</div>
          ) : (
            <div className="storage-home-list">
              {recentActivity.map((activity) => (
                <div key={activity._id} className="storage-home-list-row">
                  <span className="storage-home-item-icon">
                    <RefreshIcon size={16} color="currentColor" />
                  </span>
                  <span className="storage-home-item-copy">
                    <strong>{formatActivity(activity)}</strong>
                    <span>{formatRelativeTime(activity.createdAt)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="storage-home-panel">
          <div className="storage-home-panel-header">
            <div>
              <span className="storage-home-card-kicker">Sharing</span>
              <h3>Sharing and intake</h3>
            </div>
            <button type="button" onClick={() => onOpenView('shared')}>
              Open sharing
            </button>
          </div>

          <div className="storage-home-health-grid">
            <div className="storage-home-health-card">
              <SharedIcon size={18} color="currentColor" />
              <strong>{sharedWithMe.length}</strong>
              <span>Shared with you</span>
            </div>
            <div className="storage-home-health-card">
              <SharedIcon size={18} color="currentColor" />
              <strong>{totalSharedAccess}</strong>
              <span>Total share access events</span>
            </div>
            <div className="storage-home-health-card">
              <FileRequestsIcon size={18} color="currentColor" />
              <strong>{openRequests.length}</strong>
              <span>Open file requests</span>
            </div>
            <div className="storage-home-health-card">
              <SecurityIcon size={18} color="currentColor" />
              <strong>{protectedLinks.length}</strong>
              <span>Protected or encrypted links</span>
            </div>
          </div>

          <div className="storage-home-health-list">
            <div className="storage-home-health-row">
              <span>Requests expiring in 7 days</span>
              <strong>{expiringRequestsSoon}</strong>
            </div>
            <div className="storage-home-health-row">
              <span>Secure links saved</span>
              <strong>{securedLinks.length}</strong>
            </div>
            <div className="storage-home-health-row">
              <span>Files shared by you</span>
              <strong>{sharedByMe.length}</strong>
            </div>
          </div>
        </section>

        <section className="storage-home-panel">
          <div className="storage-home-panel-header">
            <div>
              <span className="storage-home-card-kicker">Backup</span>
              <h3>Backup and recovery</h3>
            </div>
            <button type="button" onClick={() => onOpenView('cloud-backup')}>
              Open backup
            </button>
          </div>

          <div className="storage-home-backup-summary">
            <div>
              <span className="storage-home-card-kicker">Last successful run</span>
              <strong>{latestBackup ? formatRelativeTime(latestBackup.lastBackupAt) : 'Not configured'}</strong>
            </div>
            <div>
              <span className="storage-home-card-kicker">Next scheduled run</span>
              <strong>{nextBackup ? formatRelativeTime(nextBackup.nextBackupAt) : 'No schedule yet'}</strong>
            </div>
          </div>

          {activeBackups.length === 0 ? (
            <div className="storage-home-empty">
              No automatic backups are configured yet. Set up backup to make this feel like a
              dependable primary drive.
            </div>
          ) : (
            <div className="storage-home-list">
              {activeBackups.slice(0, 4).map((backup) => (
                <div key={backup._id} className="storage-home-list-row">
                  <span className={`storage-home-item-icon backup-${backup.status}`}>
                    <CloudBackupIcon size={16} color="currentColor" />
                  </span>
                  <span className="storage-home-item-copy">
                    <strong>{getBackupLabel(backup)}</strong>
                    <span>
                      {backup.backupFrequency} • {backup.totalFilesBackedUp} files •{' '}
                      {formatBytes(backup.totalSizeBackedUp || 0)}
                    </span>
                  </span>
                  <span className={`storage-home-status-pill ${backup.status}`}>
                    {backup.status === 'backing_up' ? 'Running' : backup.status}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="storage-home-health-list compact">
            <div className="storage-home-health-row">
              <span>Backups with warnings</span>
              <strong>{atRiskBackups.length}</strong>
            </div>
            <div className="storage-home-health-row">
              <span>Items in recovery bin</span>
              <strong>{recoverableCount}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default StorageHome;

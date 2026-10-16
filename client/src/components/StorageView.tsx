import React, { useCallback, useEffect, useState } from 'react';
import { filesAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { formatBytes, formatRelativeTime } from '../utils/fileDisplay';
import MoveCopyModal from './MoveCopyModal';
import DuplicateReview from './DuplicateReview';
import { DownloadIcon, EyeIcon, PackageIcon, TrashIcon } from './Icons';
import './OverviewPages.css';
import './StorageView.css';

interface StorageFile {
  _id: string;
  originalName: string;
  size: number;
  mimeType: string;
  parentFolder: string | null;
  updatedAt: string;
  category: string;
}

interface StorageSummary {
  usedBytes: number;
  limitBytes: number;
  percentUsed: number;
  activeBytes: number;
  fileCount: number;
  folderCount: number;
  categories: Array<{ name: string; bytes: number; files: number }>;
  largeFiles: StorageFile[];
  trash: { bytes: number; files: number; folders: number };
  duplicates: { groups: Array<{ size: number; reclaimableBytes: number; files: StorageFile[] }>; complete: boolean };
  missingFiles: StorageFile[];
  missingFileCount: number;
  recordedBytes: number;
}

interface StorageViewProps {
  onOpenFolder: (folderId: string | null) => void;
  onOpenTrash: () => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  Documents: '#4f7a46', Images: '#5f7fa3', Videos: '#a0745a', Audio: '#8a6aa5', Archives: '#b59a4a', Other: '#9aa58f',
};

const StorageView: React.FC<StorageViewProps> = ({ onOpenFolder, onOpenTrash }) => {
  const { refreshUser } = useAuth();
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState<StorageFile | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await filesAPI.getStorageSummary());
      setError('');
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not load storage details.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const afterChange = async () => { await load(); await refreshUser(); };

  const download = async (file: StorageFile) => {
    try {
      const blob = await filesAPI.downloadFile(file._id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.originalName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Download failed. The file may be missing from disk.');
    }
  };

  const trash = async (file: StorageFile) => {
    if (!window.confirm(`Move "${file.originalName}" to Trash? You can restore it for 30 days.`)) return;
    setBusy(true);
    try {
      await filesAPI.deleteFile(file._id);
      await afterChange();
    } finally {
      setBusy(false);
    }
  };

  const emptyTrash = async () => {
    if (!summary) return;
    const ok = window.confirm(
      `Permanently delete everything in Trash (${summary.trash.files} file${summary.trash.files === 1 ? '' : 's'}, ${formatBytes(summary.trash.bytes)})? This cannot be undone.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      await filesAPI.emptyTrash();
      await afterChange();
    } finally {
      setBusy(false);
    }
  };

  const recalculate = async () => {
    setBusy(true);
    try {
      await filesAPI.recalculateStorage();
      await afterChange();
    } finally {
      setBusy(false);
    }
  };

  const FileActions: React.FC<{ file: StorageFile }> = ({ file }) => (
    <span className="storage-file-actions">
      <button onClick={() => onOpenFolder(file.parentFolder)} title="Open folder" aria-label={`Open folder of ${file.originalName}`}><EyeIcon size={15} /></button>
      <button onClick={() => download(file)} title="Download" aria-label={`Download ${file.originalName}`}><DownloadIcon size={15} /></button>
      <button onClick={() => setMoving(file)} title="Move" aria-label={`Move ${file.originalName}`}><PackageIcon size={15} /></button>
      <button onClick={() => trash(file)} disabled={busy} title="Move to Trash" aria-label={`Move ${file.originalName} to Trash`} className="danger"><TrashIcon size={15} /></button>
    </span>
  );

  if (error) return <div className="overview-page"><p className="overview-error">{error}</p></div>;
  if (!summary) return <div className="overview-page"><p className="overview-muted">Measuring your storage…</p></div>;

  const drift = summary.recordedBytes - summary.usedBytes;
  const categorized = summary.categories.filter(category => category.bytes > 0);
  const reclaimable = summary.duplicates.groups.reduce((sum, group) => sum + group.reclaimableBytes, 0);

  return (
    <div className="overview-page storage-view">
      <header className="overview-header">
        <h1>Storage</h1>
        <p>What is using your space, measured from your files.</p>
      </header>

      <section className="storage-usage" aria-label="Storage usage">
        <div className="storage-usage-numbers">
          <strong>{formatBytes(summary.usedBytes)}</strong>
          <span>of {formatBytes(summary.limitBytes)} used · {summary.percentUsed < 0.1 && summary.usedBytes > 0 ? '<0.1' : summary.percentUsed.toFixed(1)}%</span>
        </div>
        <div className="storage-meter" role="img" aria-label={categorized.map(c => `${c.name} ${formatBytes(c.bytes)}`).join(', ')}>
          {categorized.map(category => (
            <span key={category.name} style={{ width: `${summary.limitBytes ? (category.bytes / summary.limitBytes) * 100 : 0}%`, background: CATEGORY_COLORS[category.name] }} />
          ))}
          {summary.trash.bytes > 0 && <span style={{ width: `${summary.limitBytes ? (summary.trash.bytes / summary.limitBytes) * 100 : 0}%`, background: '#d4c5b0' }} />}
        </div>
        <dl className="storage-stats">
          <div><dt>Files</dt><dd>{summary.fileCount}</dd></div>
          <div><dt>Folders</dt><dd>{summary.folderCount}</dd></div>
          <div><dt>Available</dt><dd>{formatBytes(Math.max(0, summary.limitBytes - summary.usedBytes))}</dd></div>
          <div><dt>In Trash</dt><dd>{formatBytes(summary.trash.bytes)}</dd></div>
        </dl>
        {drift !== 0 && (
          <p className="storage-drift">
            Your account's storage counter says {formatBytes(summary.recordedBytes)}, but your files add up to {formatBytes(summary.usedBytes)}.
            {' '}<button onClick={recalculate} disabled={busy}>Recalculate</button>
          </p>
        )}
      </section>

      <div className="storage-grid">
        <section className="overview-section">
          <div className="overview-section-head"><h2>By type</h2></div>
          <ul className="storage-categories">
            {summary.categories.map(category => (
              <li key={category.name}>
                <span className="storage-swatch" style={{ background: CATEGORY_COLORS[category.name] }} aria-hidden="true" />
                <span className="storage-category-name">{category.name}</span>
                <span className="storage-category-count">{category.files} file{category.files === 1 ? '' : 's'}</span>
                <span className="storage-category-size">{formatBytes(category.bytes)}</span>
              </li>
            ))}
            <li>
              <span className="storage-swatch" style={{ background: '#d4c5b0' }} aria-hidden="true" />
              <span className="storage-category-name">Trash</span>
              <span className="storage-category-count">{summary.trash.files} file{summary.trash.files === 1 ? '' : 's'}</span>
              <span className="storage-category-size">{formatBytes(summary.trash.bytes)}</span>
            </li>
          </ul>
          <div className="storage-trash-actions">
            <button className="btn-secondary" onClick={onOpenTrash}>Open Trash</button>
            {summary.trash.files + summary.trash.folders > 0 && (
              <button className="btn-secondary storage-danger" onClick={emptyTrash} disabled={busy}>Empty Trash…</button>
            )}
          </div>
        </section>

        <section className="overview-section">
          <div className="overview-section-head"><h2>Largest files</h2></div>
          {summary.largeFiles.length === 0 ? <p className="overview-muted">No files yet.</p> : (
            <ul className="storage-file-list">
              {summary.largeFiles.map(file => (
                <li key={file._id}>
                  <span className="storage-file-name">{file.originalName}<small>{file.category} · updated {formatRelativeTime(file.updatedAt)}</small></span>
                  <span className="storage-file-size">{formatBytes(file.size)}</span>
                  <FileActions file={file} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="overview-section">
        <div className="overview-section-head">
          <h2>Duplicate files</h2>
          {reclaimable > 0 && <span>{formatBytes(reclaimable)} could be freed</span>}
        </div>
        <DuplicateReview onChanged={load} />
        <p className="storage-footnote">Duplicates are files with exactly the same contents (compared by checksum). File Box suggests which copy to keep; nothing is removed until you confirm, and removed copies go to Trash.</p>
      </section>

      {summary.missingFileCount > 0 && (
        <section className="overview-section">
          <div className="overview-section-head"><h2>Missing from disk</h2><span>{summary.missingFileCount}</span></div>
          <p className="overview-muted">These files are listed in File Box but their contents are no longer on this computer, so they can't be opened or downloaded.</p>
          <ul className="storage-file-list">
            {summary.missingFiles.map(file => (
              <li key={file._id}>
                <span className="storage-file-name">{file.originalName}<small>{formatBytes(file.size)} · updated {formatRelativeTime(file.updatedAt)}</small></span>
                <span className="storage-file-actions">
                  <button onClick={() => trash(file)} disabled={busy} title="Move to Trash" aria-label={`Move ${file.originalName} to Trash`} className="danger"><TrashIcon size={15} /></button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {moving && (
        <MoveCopyModal
          itemId={moving._id}
          itemName={moving.originalName}
          itemType="file"
          operation="move"
          onClose={() => setMoving(null)}
          onSuccess={() => { setMoving(null); load(); }}
        />
      )}
    </div>
  );
};

export default StorageView;

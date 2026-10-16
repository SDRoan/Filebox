import React, { useEffect, useState } from 'react';
import { filesAPI } from '../services/api';
import { timeBucket } from '../utils/fileDisplay';
import FileRowList, { FileRowItem } from './FileRowList';
import './OverviewPages.css';

interface RecentViewProps {
  onOpenFile: (file: FileRowItem) => void;
}

const BUCKETS = ['Today', 'Yesterday', 'Earlier this week', 'Older'];

const RecentView: React.FC<RecentViewProps> = ({ onOpenFile }) => {
  const [files, setFiles] = useState<FileRowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    filesAPI.getRecent(60)
      .then(data => setFiles(data.files || []))
      .catch(() => setError('Could not load recent files. Check that the File Box server is running.'))
      .finally(() => setLoading(false));
  }, []);

  const grouped = BUCKETS
    .map(bucket => ({ bucket, files: files.filter(file => timeBucket(file.lastInteractionAt) === bucket) }))
    .filter(group => group.files.length > 0);

  return (
    <div className="overview-page">
      <header className="overview-header">
        <h1>Recent</h1>
        <p>Files you recently uploaded, opened, edited or downloaded.</p>
      </header>

      {loading && <p className="overview-muted">Loading…</p>}
      {error && <p className="overview-error">{error}</p>}
      {!loading && !error && files.length === 0 && (
        <div className="overview-empty">
          <h3>No recent files yet</h3>
          <p>Upload or open a file and it will show up here.</p>
        </div>
      )}
      {grouped.map(group => (
        <section className="overview-section" key={group.bucket}>
          <div className="overview-section-head"><h2>{group.bucket}</h2></div>
          <FileRowList files={group.files} onOpen={onOpenFile} />
        </section>
      ))}
    </div>
  );
};

export default RecentView;

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { shareAPI } from '../services/api';
import { fileKind, formatBytes } from '../utils/fileDisplay';
import Logo from './Logo';
import { DocumentIcon, DownloadIcon, LockIcon } from './Icons';
import './SharedLinkPage.css';

interface PublicLink {
  file: { originalName: string; size: number; mimeType: string };
  owner: { name: string };
  requiresPassword: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
}

// Public page for a File Box share link: no sign-in, view-only.
const SharedLinkPage: React.FC = () => {
  const { shareId = '' } = useParams();
  const [link, setLink] = useState<PublicLink | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    shareAPI.getPublicLink(shareId)
      .then(setLink)
      .catch((err) => setError(err?.response?.data?.message || 'This link does not exist.'));
  }, [shareId]);

  const download = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!link) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const response = await fetch(shareAPI.publicDownloadUrl(shareId, password || undefined));
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Download failed');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = link.file.originalName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setDownloadError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <main className="shared-link-page">
      <div className="shared-link-brand"><Logo size="small" /></div>
      <section className="shared-link-card">
        {!link && !error && <p className="shared-link-muted">Loading…</p>}
        {error && (
          <>
            <h1>Link unavailable</h1>
            <p className="shared-link-muted">{error}</p>
          </>
        )}
        {link && (
          <>
            <span className="shared-link-icon" aria-hidden="true"><DocumentIcon size={26} /></span>
            <h1>{link.file.originalName}</h1>
            <p className="shared-link-muted">
              {fileKind(link.file.mimeType, link.file.originalName)} · {formatBytes(link.file.size)} · shared by {link.owner.name}
              {link.expiresAt && ` · available until ${new Date(link.expiresAt).toLocaleDateString()}`}
            </p>

            {link.allowDownload ? (
              <form className="shared-link-form" onSubmit={download}>
                {link.requiresPassword && (
                  <label>
                    <span><LockIcon size={13} /> This link is password protected</span>
                    <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" autoFocus required />
                  </label>
                )}
                <button type="submit" disabled={downloading}>
                  <DownloadIcon size={16} color="#fff" /> {downloading ? 'Downloading…' : 'Download'}
                </button>
                {downloadError && <p className="shared-link-error" role="alert">{downloadError}</p>}
              </form>
            ) : (
              <p className="shared-link-note">The owner turned off downloads for this link.</p>
            )}
          </>
        )}
      </section>
      <p className="shared-link-footer">Shared with File Box</p>
    </main>
  );
};

export default SharedLinkPage;

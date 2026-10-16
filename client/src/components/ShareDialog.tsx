import React, { useCallback, useEffect, useRef, useState } from 'react';
import { shareAPI, integrationsAPI, FileAccessInfo, ShareLinkInfo } from '../services/api';
import { formatRelativeTime } from '../utils/fileDisplay';
import { CloseIcon, CopyIcon, LinkIcon, LockIcon, TrashIcon } from './Icons';
import './ShareDialog.css';

interface ShareDialogProps {
  fileId: string;
  fileName: string;
  onClose: () => void;
}

const publicUrl = (link: ShareLinkInfo) => `${window.location.origin}${link.url}`;

const initials = (name = '') => name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() || '?';

const PROVIDER_NAMES: Record<string, string> = { microsoft_teams: 'Microsoft Teams', zoom: 'Zoom', slack: 'Slack' };

const ShareDialog: React.FC<ShareDialogProps> = ({ fileId, fileName, onClose }) => {
  const [access, setAccess] = useState<FileAccessInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [showLinkOptions, setShowLinkOptions] = useState(false);
  const [linkPassword, setLinkPassword] = useState('');
  const [linkExpiry, setLinkExpiry] = useState('');
  const [linkAllowDownload, setLinkAllowDownload] = useState(true);
  const [copied, setCopied] = useState('');
  const [integrations, setIntegrations] = useState<any[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setAccess(await shareAPI.getFileAccess(fileId));
      setLoadError('');
    } catch (error: any) {
      setLoadError(error?.response?.data?.message || 'Could not load sharing settings.');
    }
  }, [fileId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    integrationsAPI.getIntegrations()
      .then((list: any[]) => setIntegrations((list || []).filter(item => item.enabled)))
      .catch(() => setIntegrations([]));
  }, []);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: success });
      await load();
      return true;
    } catch (error: any) {
      setMessage({ text: error?.response?.data?.message || 'Something went wrong. Please try again.', error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addPerson = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!value) return;
    if (await run(() => shareAPI.shareWithEmail(fileId, value, permission), `Shared with ${value}`)) setEmail('');
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setMessage({ text: 'Could not copy automatically. Select the link and copy it.', error: true });
    }
  };

  const createLink = async () => {
    const ok = await run(() => shareAPI.createLink(fileId, {
      password: linkPassword || undefined,
      expiresAt: linkExpiry ? new Date(`${linkExpiry}T23:59:59`).toISOString() : undefined,
      allowDownload: linkAllowDownload,
    }), 'Link created');
    if (ok) {
      setShowLinkOptions(false);
      setLinkPassword('');
      setLinkExpiry('');
      setLinkAllowDownload(true);
    }
  };

  const sendToIntegration = (integration: any) =>
    run(() => integrationsAPI.shareFile(integration._id, { fileId }), `Sent to ${PROVIDER_NAMES[integration.provider] || integration.provider}`);

  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const activeLinks = access?.links || [];

  return (
    <div className="share-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title" ref={dialogRef}>
        <header className="share-dialog-header">
          <h2 id="share-dialog-title">Share “{fileName}”</h2>
          <button className="share-dialog-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </header>

        <form className="share-add" onSubmit={addPerson}>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Add people by email"
            aria-label="Email address"
            autoComplete="off"
          />
          <select value={permission} onChange={(event) => setPermission(event.target.value as 'view' | 'edit')} aria-label="Permission for new person">
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </select>
          <button type="submit" className="share-primary" disabled={busy || !email.trim()}>Share</button>
        </form>
        <p className="share-hint">People need a File Box account. Editors can change the file's contents; only you can rename, move, share or delete it.</p>

        {message && <p className={`share-message ${message.error ? 'error' : ''}`} role="status">{message.text}</p>}
        {loadError && <p className="share-message error">{loadError}</p>}

        <section className="share-section">
          <h3>People with access</h3>
          {!access && !loadError && <p className="share-muted">Loading…</p>}
          {access && (
            <ul className="share-people">
              <li>
                <span className="share-avatar owner" aria-hidden="true">{initials(access.owner.name)}</span>
                <span className="share-person"><strong>{access.owner.name} (you)</strong><small>{access.owner.email}</small></span>
                <span className="share-role-static">Owner</span>
              </li>
              {access.people.map(person => (
                <li key={person.user._id} className={person.expired ? 'expired' : ''}>
                  <span className="share-avatar" aria-hidden="true">{initials(person.user.name)}</span>
                  <span className="share-person">
                    <strong>{person.user.name}</strong>
                    <small>
                      {person.user.email}
                      {person.expiresAt && (person.expired ? ' · access expired' : ` · until ${new Date(person.expiresAt).toLocaleDateString()}`)}
                    </small>
                  </span>
                  <select
                    value={person.permission}
                    disabled={busy}
                    aria-label={`Permission for ${person.user.name}`}
                    onChange={(event) => run(() => shareAPI.setPermission(fileId, person.user._id, event.target.value as 'view' | 'edit'), 'Permission updated')}
                  >
                    <option value="view">Can view</option>
                    <option value="edit">Can edit</option>
                  </select>
                  <button
                    className="share-icon-button"
                    disabled={busy}
                    aria-label={`Remove ${person.user.name}`}
                    title="Remove access"
                    onClick={() => run(() => shareAPI.removeAccess(fileId, person.user._id), `Removed ${person.user.name}`)}
                  >
                    <TrashIcon size={15} />
                  </button>
                </li>
              ))}
              {access.people.length === 0 && <li className="share-muted-row">Only you can open this file.</li>}
            </ul>
          )}
        </section>

        <section className="share-section">
          <div className="share-section-head">
            <h3>Links</h3>
            {!showLinkOptions && <button className="share-link-button" onClick={() => setShowLinkOptions(true)}><LinkIcon size={14} /> Create link</button>}
          </div>
          <p className="share-muted">Anyone with a link can view the file without signing in. Links are view-only.</p>

          {showLinkOptions && (
            <div className="share-link-options">
              <label>
                <span>Password (optional)</span>
                <input type="password" value={linkPassword} onChange={(event) => setLinkPassword(event.target.value)} autoComplete="new-password" />
              </label>
              <label>
                <span>Expires (optional)</span>
                <input type="date" min={tomorrow} value={linkExpiry} onChange={(event) => setLinkExpiry(event.target.value)} />
              </label>
              <label className="share-checkbox">
                <input type="checkbox" checked={linkAllowDownload} onChange={(event) => setLinkAllowDownload(event.target.checked)} />
                <span>Allow downloads</span>
              </label>
              <div className="share-link-actions">
                <button className="share-secondary" onClick={() => setShowLinkOptions(false)}>Cancel</button>
                <button className="share-primary" disabled={busy} onClick={createLink}>Create link</button>
              </div>
            </div>
          )}

          {activeLinks.length > 0 && (
            <ul className="share-links">
              {activeLinks.map(link => (
                <li key={link.shareId} className={link.expired ? 'expired' : ''}>
                  <div className="share-link-main">
                    <code>{publicUrl(link)}</code>
                    <small>
                      {link.hasPassword && <><LockIcon size={11} /> Password · </>}
                      {link.allowDownload ? 'Downloads allowed' : 'View only, no downloads'}
                      {link.expiresAt && (link.expired ? ' · Expired' : ` · Expires ${new Date(link.expiresAt).toLocaleDateString()}`)}
                      {` · Created ${formatRelativeTime(link.createdAt)}`}
                      {link.downloadCount > 0 && ` · ${link.downloadCount} download${link.downloadCount === 1 ? '' : 's'}`}
                    </small>
                  </div>
                  {!link.expired && (
                    <button className="share-icon-button" onClick={() => copy(publicUrl(link), link.shareId)} aria-label="Copy link" title="Copy link">
                      {copied === link.shareId ? '✓' : <CopyIcon size={15} />}
                    </button>
                  )}
                  <button className="share-icon-button" disabled={busy} onClick={() => run(() => shareAPI.removeShare(link.shareId), 'Link removed')} aria-label="Remove link" title="Remove link">
                    <TrashIcon size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {integrations.length > 0 && (
          <section className="share-section">
            <h3>Send to a connected app</h3>
            <div className="share-integrations">
              {integrations.map(integration => (
                <button key={integration._id} className="share-secondary" disabled={busy} onClick={() => sendToIntegration(integration)}>
                  {PROVIDER_NAMES[integration.provider] || integration.provider}
                </button>
              ))}
            </div>
          </section>
        )}

        <footer className="share-dialog-footer">
          <button className="share-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
};

export default ShareDialog;

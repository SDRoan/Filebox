import React, { useCallback, useEffect, useState } from 'react';
import { aiAssistantAPI, filesAPI, DuplicateSuggestions } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { formatBytes, formatRelativeTime } from '../utils/fileDisplay';
import './AIPanels.css';

interface DuplicateReviewProps {
  onChanged?: () => void;
  explain?: boolean;
}

// Review identical files. Suggested removals are pre-selected only when File Box is confident;
// nothing is removed until the user confirms, and removal moves copies to Trash (restorable for 30 days).
const DuplicateReview: React.FC<DuplicateReviewProps> = ({ onChanged, explain = false }) => {
  const { refreshUser } = useAuth();
  const [data, setData] = useState<DuplicateSuggestions | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await aiAssistantAPI.getDuplicates(explain);
      setData(result);
      setSelected(new Set(result.groups.flatMap(g => g.copies.filter(c => c.suggested === 'remove').map(c => c._id))));
      setError('');
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not check for duplicates.');
    }
  }, [explain]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const removeSelected = async () => {
    if (!data) return;
    const chosen = data.groups.flatMap(g => g.copies).filter(c => selected.has(c._id));
    // Never let every copy of a group go.
    const emptiesGroup = data.groups.some(g => g.copies.every(c => selected.has(c._id)));
    if (emptiesGroup) {
      setMessage('Keep at least one copy in each group.');
      return;
    }
    const total = chosen.reduce((sum, c) => sum + c.size, 0);
    if (!window.confirm(`Move ${chosen.length} duplicate${chosen.length === 1 ? '' : 's'} (${formatBytes(total)}) to Trash?\n\n${chosen.map(c => `• ${c.originalName} — ${c.location}`).join('\n')}\n\nYou can restore them from Trash for 30 days.`)) return;
    setBusy(true);
    setMessage('');
    let moved = 0;
    for (const copy of chosen) {
      try {
        await filesAPI.deleteFile(copy._id);
        moved += 1;
      } catch {
        // Reported below
      }
    }
    setMessage(`Moved ${moved} of ${chosen.length} to Trash.`);
    setBusy(false);
    await load();
    await refreshUser();
    onChanged?.();
  };

  if (error) return <p className="ai-panel-error">{error}</p>;
  if (!data) return <p className="ai-panel-muted">Checking your files for identical copies…</p>;
  if (data.groups.length === 0) {
    return <p className="ai-panel-muted">No identical files found{data.complete ? '.' : ' among the files checked.'}</p>;
  }

  return (
    <div className="duplicate-review">
      {data.explanation && <p className="ai-panel-note">{data.explanation}</p>}
      {data.groups.map(group => (
        <section className="duplicate-group" key={group.copies.map(c => c._id).join('-')}>
          <p className="duplicate-why">{group.why} {formatBytes(group.size)} each.</p>
          <p className={`duplicate-note ${group.confident ? '' : 'unsure'}`}>{group.note}</p>
          <ul>
            {group.copies.map(copy => (
              <li key={copy._id} className={copy.suggested === 'keep' ? 'keep' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(copy._id)}
                    onChange={() => toggle(copy._id)}
                    aria-label={`Remove ${copy.originalName} (${copy.location})`}
                  />
                  <span className="duplicate-name">
                    <strong>{copy.originalName}</strong>
                    <small>{copy.location} · modified {formatRelativeTime(copy.updatedAt)}</small>
                    {copy.reasons.length > 0 && <small className="duplicate-reasons">{copy.reasons.join('; ')}</small>}
                  </span>
                  {copy.suggested === 'keep' && <span className="duplicate-badge">Suggested to keep</span>}
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="ai-review-actions">
        <span className="ai-panel-muted">{selected.size} selected · {formatBytes(data.groups.flatMap(g => g.copies).filter(c => selected.has(c._id)).reduce((s, c) => s + c.size, 0))}</span>
        <button className="btn-primary" disabled={busy || selected.size === 0} onClick={removeSelected}>Move selected to Trash…</button>
      </div>
      {message && <p className="ai-panel-note" role="status">{message}</p>}
    </div>
  );
};

export default DuplicateReview;

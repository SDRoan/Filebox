import React, { useCallback, useEffect, useState } from 'react';
import { aiAssistantAPI, OrganizeProposal, OrganizeSuggestions } from '../services/api';
import './AIPanels.css';

interface OrganizeReviewProps {
  folderId?: string | null;
  onApplied?: () => void;
}

// Organization suggestions: File Box proposes, the user reviews and edits, then confirms. Nothing is
// pre-selected and nothing runs until "Apply" is confirmed.
const OrganizeReview: React.FC<OrganizeReviewProps> = ({ folderId = null, onApplied }) => {
  const [data, setData] = useState<OrganizeSuggestions | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ applied: number; failed: number; results: Array<{ id: string; success: boolean; message: string }> } | null>(null);

  const load = useCallback(async () => {
    setData(null);
    setError('');
    try {
      setData(await aiAssistantAPI.suggestOrganization(folderId));
      setSelected(new Set());
      setEdits({});
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not prepare suggestions.');
    }
  }, [folderId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const target = (p: OrganizeProposal) => edits[p.id] ?? (p.type === 'move' ? p.folderName : p.newName) ?? '';

  const apply = async () => {
    if (!data) return;
    const chosen = data.proposals.filter(p => selected.has(p.id)).map(p => (
      p.type === 'move'
        ? { ...p, folderName: target(p), folderId: edits[p.id] !== undefined && edits[p.id] !== p.folderName ? null : p.folderId }
        : { ...p, newName: target(p) }
    ));
    const summary = chosen.map(p => (p.type === 'move' ? `• Move "${p.fileName}" to "${p.folderName}"` : `• Rename "${p.fileName}" to "${p.newName}"`)).join('\n');
    if (!window.confirm(`Apply ${chosen.length} change${chosen.length === 1 ? '' : 's'}?\n\n${summary}`)) return;
    setBusy(true);
    try {
      setOutcome(await aiAssistantAPI.applyOrganization(chosen));
      onApplied?.();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not apply these changes.');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="ai-panel-error">{error}</p>;
  if (outcome) {
    return (
      <div className="organize-review">
        <p className="ai-panel-note" role="status">Applied {outcome.applied} change{outcome.applied === 1 ? '' : 's'}{outcome.failed ? `; ${outcome.failed} could not be applied` : ''}.</p>
        <ul className="organize-outcome">
          {outcome.results.map(r => <li key={r.id} className={r.success ? '' : 'failed'}>{r.message}</li>)}
        </ul>
        <button className="btn-secondary" onClick={() => { setOutcome(null); load(); }}>Look for more suggestions</button>
      </div>
    );
  }
  if (!data) return <p className="ai-panel-muted">Looking at your files…</p>;

  return (
    <div className="organize-review">
      <p className="ai-panel-muted">
        {data.fileCount} file{data.fileCount === 1 ? '' : 's'} in {data.scope.name}.{' '}
        {data.aiUsed ? 'Suggestions use your local AI and simple rules.' : data.aiError}
      </p>
      {data.proposals.length === 0 ? (
        <p className="ai-panel-muted">No changes to suggest. This folder already looks organized.</p>
      ) : (
        <>
          <table className="organize-table">
            <thead>
              <tr><th scope="col"><span className="visually-hidden">Apply</span></th><th scope="col">Item</th><th scope="col">Proposed</th><th scope="col">Why</th></tr>
            </thead>
            <tbody>
              {data.proposals.map(p => (
                <tr key={p.id} className={selected.has(p.id) ? 'selected' : ''}>
                  <td><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Apply change to ${p.fileName}`} /></td>
                  <td><strong>{p.fileName}</strong><small>{p.currentLocation}</small></td>
                  <td>
                    <span className="organize-kind">{p.type === 'move' ? (p.isNewFolder && edits[p.id] === undefined ? 'Move to new folder' : 'Move to folder') : 'Rename to'}</span>
                    <input
                      value={target(p)}
                      onChange={(event) => setEdits(prev => ({ ...prev, [p.id]: event.target.value }))}
                      aria-label={p.type === 'move' ? `Destination folder for ${p.fileName}` : `New name for ${p.fileName}`}
                    />
                  </td>
                  <td className="organize-reason">{p.reason}<small>{p.source === 'ai' ? 'Suggested by local AI' : 'Rule'}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ai-review-actions">
            <button className="btn-secondary" onClick={() => setSelected(new Set(data.proposals.map(p => p.id)))}>Select all</button>
            <span className="ai-panel-muted">{selected.size} selected</span>
            <button className="btn-primary" disabled={busy || selected.size === 0} onClick={apply}>{busy ? 'Applying…' : 'Apply selected…'}</button>
          </div>
        </>
      )}
    </div>
  );
};

export default OrganizeReview;

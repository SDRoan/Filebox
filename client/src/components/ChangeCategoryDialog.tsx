import React, { useEffect, useRef, useState } from 'react';
import { advancedSearchAPI, FileClassification } from '../services/api';

interface ChangeCategoryDialogProps {
  fileId: string;
  fileName: string;
  current: FileClassification;
  taxonomy: Array<{ name: string; documentTypes: string[] }>;
  onClose: () => void;
  onSaved: (classification: FileClassification) => void;
}

const SOURCE_LABEL: Record<FileClassification['source'], string> = {
  user: 'Set by you',
  rules: 'Detected automatically',
  profile: 'Detected automatically',
  default: 'Detected automatically',
};

/**
 * A person's own label for what a file is. Only the label changes; the file stays in its folder.
 * The server checks the person is the owner or an editor, whatever this dialog shows.
 */
const ChangeCategoryDialog: React.FC<ChangeCategoryDialogProps> = ({ fileId, fileName, current, taxonomy, onClose, onSaved }) => {
  const [category, setCategory] = useState(current.primaryCategory);
  const [documentType, setDocumentType] = useState(current.documentType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);
  const types = taxonomy.find(c => c.name === category)?.documentTypes || [];

  useEffect(() => { firstRef.current?.focus(); }, []);

  const changeCategory = (next: string) => {
    setCategory(next);
    const nextTypes = taxonomy.find(c => c.name === next)?.documentTypes || [];
    if (!nextTypes.includes(documentType)) setDocumentType(nextTypes[0] || '');
  };

  const save = async (body: { primaryCategory: string; documentType: string } | { reset: true }) => {
    setSaving(true);
    setError('');
    try {
      const { classification } = await advancedSearchAPI.setClassification(fileId, body);
      onSaved(classification);
    } catch (err: any) {
      const status = err?.response?.status;
      setError(status === 403 ? 'Only the owner or an editor can change this.'
        : status === 404 ? 'This file is no longer available.'
        : "Couldn't save the category. Try again.");
      setSaving(false);
    }
  };

  // Keep keyboard focus inside the dialog; Escape closes it.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('select, button:not(:disabled)'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const unchanged = category === current.primaryCategory && documentType === current.documentType;

  return (
    <div className="adv-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="adv-dialog" role="dialog" aria-modal="true" aria-labelledby="adv-dialog-title" aria-describedby="adv-dialog-note" ref={dialogRef} onKeyDown={onKeyDown}>
        <h2 id="adv-dialog-title">Change category</h2>
        <p className="adv-dialog-file">{fileName}</p>
        <p className="adv-dialog-current">
          Now: <strong>{current.primaryCategory} · {current.documentType}</strong> <span>({SOURCE_LABEL[current.source]})</span>
        </p>
        <label className="adv-field">
          <span>Category</span>
          <select ref={firstRef} value={category} onChange={event => changeCategory(event.target.value)} disabled={saving}>
            {taxonomy.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label className="adv-field">
          <span>Document type</span>
          <select value={documentType} onChange={event => setDocumentType(event.target.value)} disabled={saving}>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <p id="adv-dialog-note" className="adv-dialog-note">This only changes the label. The file stays where it is.</p>
        {error && <p className="adv-dialog-error" role="alert">{error}</p>}
        <div className="adv-dialog-actions">
          {current.source === 'user' && (
            <button type="button" className="adv-button-quiet" onClick={() => save({ reset: true })} disabled={saving}>Use automatic category</button>
          )}
          <span className="adv-dialog-spacer" />
          <button type="button" className="adv-button-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="adv-button-primary" onClick={() => save({ primaryCategory: category, documentType })} disabled={saving || unchanged || !documentType}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChangeCategoryDialog;

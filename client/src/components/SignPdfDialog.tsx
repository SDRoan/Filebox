import React, { useEffect, useRef, useState } from 'react';
import { signaturesAPI } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import { CloseIcon, SignatureIcon } from './Icons';
import './SignPdfDialog.css';

interface SavedSignature {
  _id: string;
  name: string;
  signatureData: string;
  isDefault?: boolean;
}

interface SignPdfDialogProps {
  file: { _id: string; originalName: string };
  onClose: () => void;
  onSigned?: () => void;
}

/**
 * Sign a PDF with one of your saved signatures: choose the signature, click where it goes on the page,
 * adjust its size, and save. The unsigned file is kept in Version history.
 */
const SignPdfDialog: React.FC<SignPdfDialogProps> = ({ file, onClose, onSigned }) => {
  const [signatures, setSignatures] = useState<SavedSignature[] | null>(null);
  const [signatureId, setSignatureId] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageUrl, setPageUrl] = useState('');
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);
  const [width, setWidth] = useState(0.25);
  const [aspect, setAspect] = useState(0.35);
  const [pageAspect, setPageAspect] = useState(1.294);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState('');
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    signaturesAPI.getSignatures()
      .then((list: SavedSignature[]) => {
        setSignatures(list);
        const preferred = list.find(sig => sig.isDefault) || list[0];
        if (preferred) setSignatureId(preferred._id);
      })
      .catch(() => setSignatures([]));
    signaturesAPI.getPdfPages(file._id)
      .then(info => {
        setTotal(info.total);
        if (info.pages[0]) setPageAspect(info.pages[0].height / info.pages[0].width);
      })
      .catch(err => setError(err?.response?.data?.message || 'Could not open this PDF.'));
  }, [file._id]);

  // Load the page image whenever the page changes; the placement starts over on a new page.
  useEffect(() => {
    let url = '';
    let cancelled = false;
    setPageUrl('');
    setPlace(null);
    signaturesAPI.getPdfPageImage(file._id, page)
      .then(objectUrl => { url = objectUrl; if (!cancelled) setPageUrl(objectUrl); else URL.revokeObjectURL(objectUrl); })
      .catch(err => setError(err?.response?.data?.message || 'Could not show this page.'));
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [file._id, page]);

  const signature = signatures?.find(sig => sig._id === signatureId);

  // The signature image's own proportions, so the preview matches what will be stamped.
  useEffect(() => {
    if (!signature) return;
    const img = new Image();
    img.onload = () => { if (img.width) setAspect(img.height / img.width); };
    img.src = signature.signatureData;
  }, [signature]);

  const placeAt = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = pageRef.current?.getBoundingClientRect();
    if (!box) return;
    // Center the signature on the click, keeping it inside the page.
    const heightFraction = (width * aspect) / pageAspect;
    const x = Math.min(1 - width, Math.max(0, (event.clientX - box.left) / box.width - width / 2));
    const y = Math.min(1 - heightFraction, Math.max(0, (event.clientY - box.top) / box.height - heightFraction / 2));
    setPlace({ x, y });
  };

  const sign = async () => {
    if (!place || !signatureId) return;
    setSaving(true);
    setError('');
    try {
      const result = await signaturesAPI.signPdf(file._id, { signatureId, pageNumber: page, position: { x: place.x, y: place.y, width } });
      setDone(result.message || 'Signed.');
      onSigned?.();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not sign this PDF.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-panel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-panel-dialog wide sign-pdf" role="dialog" aria-modal="true" aria-labelledby="sign-pdf-title">
        <header className="ai-panel-header">
          <div>
            <h2 id="sign-pdf-title"><SignatureIcon size={18} /> Sign “{file.originalName}”</h2>
            <p>Choose a signature, click where it goes, then save. The unsigned file is kept in Version history.</p>
          </div>
          <button className="ai-panel-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </header>

        {done ? (
          <div className="sign-pdf-done" role="status">
            <p>{done}</p>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        ) : signatures && signatures.length === 0 ? (
          <div className="sign-pdf-empty">
            <p>You don't have a saved signature yet.</p>
            <a className="btn-primary" href={pagePath('signatures')}>Create a signature</a>
          </div>
        ) : (
          <div className="sign-pdf-body">
            <aside className="sign-pdf-controls">
              <label>
                Signature
                <select value={signatureId} onChange={(event) => setSignatureId(event.target.value)}>
                  {(signatures || []).map(sig => <option key={sig._id} value={sig._id}>{sig.name}{sig.isDefault ? ' (default)' : ''}</option>)}
                </select>
              </label>
              {signature && <img className="sign-pdf-sample" src={signature.signatureData} alt={`Signature ${signature.name}`} />}
              <label>
                Size
                <input type="range" min={10} max={60} value={Math.round(width * 100)} onChange={(event) => setWidth(Number(event.target.value) / 100)} aria-label="Signature size" />
              </label>
              {total > 1 && (
                <div className="sign-pdf-pages">
                  <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                  <span>Page {page} of {total}</span>
                  <button className="btn-secondary" disabled={page >= total} onClick={() => setPage(page + 1)}>Next</button>
                </div>
              )}
              <p className="sign-pdf-hint">{place ? 'Click elsewhere on the page to move it.' : 'Click on the page where the signature should go.'}</p>
              {error && <p className="sign-pdf-error" role="alert">{error}</p>}
              <button className="btn-primary" disabled={!place || !signatureId || saving} onClick={sign}>
                {saving ? 'Signing…' : 'Sign and save'}
              </button>
            </aside>

            <div className="sign-pdf-stage">
              <div ref={pageRef} className="sign-pdf-page" onClick={placeAt} role="button" tabIndex={-1} aria-label={`Page ${page}: click to place the signature`}>
                {pageUrl ? <img src={pageUrl} alt={`Page ${page}`} draggable={false} /> : <div className="sign-pdf-loading">Loading page…</div>}
                {place && signature && (
                  <img
                    className="sign-pdf-placed"
                    src={signature.signatureData}
                    alt=""
                    style={{ left: `${place.x * 100}%`, top: `${place.y * 100}%`, width: `${width * 100}%` }}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SignPdfDialog;

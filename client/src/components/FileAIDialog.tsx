import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { aiAssistantAPI, FileAIActionsInfo } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import { AIAssistantIcon, CloseIcon } from './Icons';
import './AIPanels.css';

interface FileAIDialogProps {
  fileId: string;
  fileName: string;
  onClose: () => void;
}

// "Ask File Box AI" for one file: actions that fit its type and that the local tools can actually run.
const FileAIDialog: React.FC<FileAIDialogProps> = ({ fileId, fileName, onClose }) => {
  const navigate = useNavigate();
  const [info, setInfo] = useState<FileAIActionsInfo | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState('');
  const [result, setResult] = useState<{ label: string; text: string; truncated?: boolean } | null>(null);

  useEffect(() => {
    aiAssistantAPI.getFileActions(fileId)
      .then(setInfo)
      .catch((err) => setError(err?.response?.data?.message || 'Could not load AI actions for this file.'));
  }, [fileId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (id: string, label: string) => {
    setRunning(id);
    setError('');
    setResult(null);
    try {
      const response = await aiAssistantAPI.runFileAction(fileId, id);
      setResult({ label, text: response.result, truncated: response.truncated });
    } catch (err: any) {
      setError(err?.response?.data?.message || 'This action could not be completed.');
    } finally {
      setRunning('');
    }
  };

  const askQuestion = () => navigate(`${pagePath('ai-assistant')}?file=${fileId}`);

  return (
    <div className="ai-panel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="file-ai-title">
        <header className="ai-panel-header">
          <div>
            <h2 id="file-ai-title"><AIAssistantIcon size={18} /> Ask File Box</h2>
            <p title={fileName}>{fileName}</p>
          </div>
          <button className="ai-panel-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </header>

        {!info && !error && <p className="ai-panel-muted">Loading…</p>}
        {info && !info.aiReady && (
          <p className="ai-panel-note">File Box AI is offline. Start Ollama to use AI actions{info.actions.some(a => !a.needsAI) ? '; text extraction still works' : ''}.</p>
        )}
        {info && info.actions.length === 0 && (
          <p className="ai-panel-muted">File Box AI can't read this type of file yet.</p>
        )}

        {info && info.actions.length > 0 && (
          <div className="ai-action-grid">
            {info.actions.map(action => (
              <button
                key={action.id}
                className={`ai-action ${result?.label === action.label ? 'active' : ''}`}
                disabled={!action.available || Boolean(running)}
                title={action.available ? '' : 'Needs File Box AI (Ollama) to be running'}
                onClick={() => run(action.id, action.label)}
              >
                {running === action.id ? 'Working…' : action.label}
              </button>
            ))}
            {info.canAsk && <button className="ai-action ai-action-ask" onClick={askQuestion}>Ask a question about this file</button>}
          </div>
        )}

        {error && <p className="ai-panel-error" role="alert">{error}</p>}
        {running && <p className="ai-panel-muted">Reading the file with your local AI…</p>}
        {result && (
          <section className="ai-panel-result" aria-live="polite">
            <h3>{result.label}</h3>
            <div>{result.text}</div>
            {result.truncated && <p className="ai-panel-muted">This file is long; only the first part was read.</p>}
          </section>
        )}
        <p className="ai-panel-footnote">File Box AI runs on this computer with Ollama. Your file is not sent anywhere.</p>
      </div>
    </div>
  );
};

export default FileAIDialog;

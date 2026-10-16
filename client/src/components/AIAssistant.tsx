import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { aiAssistantAPI, filesAPI, AssistantHistoryMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { pagePath } from '../config/workspaceNavigation';
import { AIAssistantIcon, ArrowRightIcon, DocumentIcon, RefreshIcon } from './Icons';
import './AIAssistant.css';

interface FoundFile {
  id: string;
  name: string;
  folder: string;
  parentFolder: string | null;
}

interface PendingAction {
  type: string;
  question: string;
  fileId?: string | null;
  targets: string[];
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  files?: FoundFile[];
  pendingAction?: PendingAction;
  actionState?: 'pending' | 'running' | 'done' | 'cancelled';
  error?: boolean;
}

interface AssistantStatus {
  reachable: boolean;
  ready: boolean;
  assistantModel?: string;
  assistantModelAvailable?: boolean;
}

interface FileOption {
  _id: string;
  originalName: string;
}

const SUGGESTIONS = [
  { label: 'Find a document', prompt: 'Find documents about ' },
  { label: 'Search inside documents', prompt: 'Which document mentions ' },
  { label: 'Summarize a file', prompt: 'Summarize this file' },
  { label: 'Organize my files', prompt: 'Suggest how I could organize my recent files into folders.' },
  { label: 'Create a folder', prompt: 'Create a folder called ' },
  { label: 'Share a file', prompt: 'Share this file with ' },
];

const HISTORY_LIMIT = 50;
const OFFLINE_RECHECK_MS = 15000;

const readHistory = (key: string): Message[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};

const AIAssistant: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const historyKey = `filebox-ai-history-${user?.id || 'local'}`;
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [messages, setMessages] = useState<Message[]>(() => readHistory(historyKey));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [fileOptions, setFileOptions] = useState<FileOption[]>([]);
  const [selectedFileId, setSelectedFileId] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoSentRef = useRef(false);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await aiAssistantAPI.getStatus());
    } catch {
      setStatus({ reachable: false, ready: false });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  // While offline, keep checking so AI comes back without reloading File Box.
  useEffect(() => {
    if (!status || status.ready) return;
    const timer = setInterval(checkStatus, OFFLINE_RECHECK_MS);
    return () => clearInterval(timer);
  }, [status, checkStatus]);

  useEffect(() => {
    filesAPI.getRecent(50)
      .then(data => setFileOptions(data.files || []))
      .catch(() => setFileOptions([]));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(historyKey, JSON.stringify(messages.slice(-HISTORY_LIMIT)));
    } catch {
      // History is a convenience; ignore storage failures.
    }
  }, [messages, historyKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const appendMessage = (message: Omit<Message, 'id'>) =>
    setMessages(prev => [...prev, { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]);

  const updateMessage = (id: string, patch: Partial<Message>) =>
    setMessages(prev => prev.map(message => message.id === id ? { ...message, ...patch } : message));

  const send = useCallback(async (text: string, fileId?: string) => {
    const question = text.trim();
    if (!question || sending) return;

    const history: AssistantHistoryMessage[] = messages
      .slice(-10)
      .map(message => ({ role: message.role, content: message.content }));

    appendMessage({ role: 'user', content: question });
    setInput('');
    setSending(true);
    try {
      const response = await aiAssistantAPI.chat(question, fileId || undefined, undefined, history);
      appendMessage({
        role: 'assistant',
        content: response.answer || 'Done.',
        files: response.files?.length ? response.files : undefined,
        pendingAction: response.pendingAction,
        actionState: response.pendingAction ? 'pending' : undefined,
      });
    } catch (error: any) {
      const data = error?.response?.data;
      if (data?.code === 'AI_OFFLINE') {
        setStatus({ reachable: false, ready: false });
      }
      appendMessage({
        role: 'assistant',
        content: data?.answer || data?.message || 'File Box AI could not answer right now. Please try again.',
        error: true,
      });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
    // `messages` is read for history only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, messages]);

  // "Ask File Box AI" from a file menu: /ai?file=<id> preselects that file.
  useEffect(() => {
    const fileId = new URLSearchParams(location.search).get('file');
    if (!fileId) return;
    setSelectedFileId(fileId);
    filesAPI.getFileById(fileId)
      .then((data: any) => {
        const file = data?.file;
        if (file) setFileOptions(prev => (prev.some(option => option._id === file._id) ? prev : [file, ...prev]));
      })
      .catch(() => setSelectedFileId(''));
    inputRef.current?.focus();
  }, [location.search]);

  // Questions handed over from Home or search: /ai?q=...
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (!q || autoSentRef.current || !status?.ready) return;
    autoSentRef.current = true;
    navigate(location.pathname, { replace: true });
    send(q, params.get('file') || undefined);
  }, [location.search, location.pathname, status, navigate, send]);

  const confirmAction = async (message: Message) => {
    if (!message.pendingAction) return;
    updateMessage(message.id, { actionState: 'running' });
    try {
      const response = await aiAssistantAPI.confirmAction(message.pendingAction);
      updateMessage(message.id, { actionState: 'done' });
      appendMessage({ role: 'assistant', content: response.answer, error: response.action?.success === false });
    } catch (error: any) {
      updateMessage(message.id, { actionState: 'pending' });
      appendMessage({ role: 'assistant', content: error?.response?.data?.message || 'That action could not be completed.', error: true });
    }
  };

  const openFile = (file: FoundFile) =>
    navigate(pagePath('files'), { state: { openFolderId: file.parentFolder, highlightFileId: file.id } });

  const applySuggestion = (suggestion: typeof SUGGESTIONS[number]) => {
    setInput(suggestion.prompt);
    inputRef.current?.focus();
  };

  const ready = Boolean(status?.ready);
  const modelMissing = Boolean(status?.reachable && !status?.assistantModelAvailable);

  return (
    <div className="filebox-ai">
      <header className="filebox-ai-header">
        <div>
          <h1>File Box AI</h1>
          <p>Ask about your files or tell File Box what you want done.</p>
        </div>
        <span className={`filebox-ai-status ${ready ? 'online' : 'offline'}`} role="status">
          <span className="filebox-ai-status-dot" aria-hidden="true" />
          {checking && !status ? 'Checking…' : ready ? `Local · ${status?.assistantModel}` : 'Offline'}
        </span>
      </header>

      {status && !ready && (
        <section className="filebox-ai-offline" aria-live="polite">
          <AIAssistantIcon size={22} />
          <div>
            <h2>File Box AI is offline</h2>
            {modelMissing ? (
              <p>Ollama is running, but the assistant model isn't installed. Run <code>ollama pull {status.assistantModel}</code>, then check again.</p>
            ) : (
              <p>Start Ollama on your computer to use local AI features. Everything else in File Box keeps working.</p>
            )}
          </div>
          <button className="btn-secondary" onClick={checkStatus} disabled={checking}>
            <RefreshIcon size={14} /> {checking ? 'Checking…' : 'Check again'}
          </button>
        </section>
      )}

      <form
        className="filebox-ai-composer"
        onSubmit={(event) => { event.preventDefault(); send(input, selectedFileId); }}
      >
        <textarea
          ref={inputRef}
          value={input}
          rows={2}
          placeholder={ready ? 'Find my resume, summarize a PDF, create a folder…' : 'File Box AI is offline'}
          aria-label="Message File Box AI"
          disabled={!ready || sending}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(input, selectedFileId);
            }
          }}
        />
        <div className="filebox-ai-composer-bar">
          <label className="filebox-ai-file-picker">
            <DocumentIcon size={14} />
            <select value={selectedFileId} onChange={(event) => setSelectedFileId(event.target.value)} disabled={!ready} aria-label="File to ask about">
              <option value="">No file selected</option>
              {fileOptions.map(file => <option key={file._id} value={file._id}>{file.originalName}</option>)}
            </select>
          </label>
          <button type="submit" className="btn-primary" disabled={!ready || sending || !input.trim()}>
            {sending ? 'Working…' : 'Send'} <ArrowRightIcon size={14} />
          </button>
        </div>
      </form>

      {messages.length === 0 && (
        <div className="filebox-ai-suggestions" aria-label="Suggested actions">
          {SUGGESTIONS.map(suggestion => (
            <button key={suggestion.label} disabled={!ready} onClick={() => applySuggestion(suggestion)}>
              {suggestion.label}
            </button>
          ))}
        </div>
      )}

      {messages.length > 0 && (
        <section className="filebox-ai-conversation" aria-label="Conversation" aria-live="polite">
          <div className="filebox-ai-conversation-head">
            <h2>Conversation</h2>
            <button className="filebox-ai-clear" onClick={() => setMessages([])}>Clear</button>
          </div>
          {messages.map(message => (
            <article key={message.id} className={`filebox-ai-message ${message.role} ${message.error ? 'error' : ''}`}>
              <div className="filebox-ai-message-body">{message.content}</div>
              {message.files && (
                <ul className="filebox-ai-files">
                  {message.files.map(file => (
                    <li key={file.id}>
                      <button onClick={() => openFile(file)}>
                        <DocumentIcon size={14} /><span>{file.name}</span><small>{file.folder}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {message.pendingAction && (
                <div className="filebox-ai-confirm">
                  {message.actionState === 'pending' && (
                    <>
                      <button className="btn-primary" onClick={() => confirmAction(message)}>
                        {message.pendingAction.type === 'delete_file' ? 'Move to Trash' : 'Share'}
                      </button>
                      <button className="btn-secondary" onClick={() => updateMessage(message.id, { actionState: 'cancelled' })}>Cancel</button>
                    </>
                  )}
                  {message.actionState === 'running' && <span>Working…</span>}
                  {message.actionState === 'done' && <span>Confirmed</span>}
                  {message.actionState === 'cancelled' && <span>Cancelled — nothing was changed.</span>}
                </div>
              )}
            </article>
          ))}
          {sending && <div className="filebox-ai-message assistant thinking">Thinking…</div>}
          <div ref={endRef} />
        </section>
      )}
    </div>
  );
};

export default AIAssistant;

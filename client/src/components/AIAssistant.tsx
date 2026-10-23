import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanion } from '../context/CompanionContext';
import CompanionGreeting from './CompanionGreeting';
import { useLocation, useNavigate } from 'react-router-dom';
import { aiAssistantAPI, filesAPI, AssistantHistoryMessage, AssistantChoice, AssistantResolved, FileAIActionsInfo } from '../services/api';
import DuplicateReview from './DuplicateReview';
import OrganizeReview from './OrganizeReview';
import './AIPanels.css';
import { useAuth } from '../context/AuthContext';
import { pagePath } from '../config/workspaceNavigation';
import { AIAssistantIcon, ArrowRightIcon, DocumentIcon, RefreshIcon } from './Icons';
import './AIAssistant.css';

interface FoundFile {
  id: string;
  name: string;
  folder: string;
  parentFolder: string | null;
  source?: 'owned' | 'shared' | 'team';
  role?: 'owner' | 'editor' | 'viewer';
  ownerName?: string;
  teamName?: string;
  trashed?: boolean;
  kind?: string;
}

interface PendingAction {
  type: string;
  question: string;
  fileId?: string | null;
  fileIds?: string[];
  targets: string[];
}

// "Which one do you mean?": the options, and the original request to continue once one is picked.
interface ChoiceRequest {
  slot: 'file' | 'folder';
  key: string;
  options: AssistantChoice[];
}
interface AnswerSource {
  fileId: string;
  name: string;
  quote: string;
}

interface ResumeRequest {
  question: string;
  fileId?: string | null;
  resolved?: AssistantResolved;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  files?: FoundFile[];
  pendingAction?: PendingAction;
  actionState?: 'pending' | 'running' | 'done' | 'cancelled';
  panel?: 'duplicates' | 'organize';
  choices?: ChoiceRequest;
  resume?: ResumeRequest;
  chosenId?: string;
  offline?: boolean;
  error?: boolean;
  // What this answer replied to, for 👍/👎 feedback.
  question?: string;
  route?: { intent?: string; action?: string; phrase?: string };
  sources?: AnswerSource[];
  feedback?: 'up' | 'down';
  feedbackOpen?: boolean;
  // When it was said (ms), so File Box AI can tell a new visit from the same conversation.
  at?: number;
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

export type AssistantSuggestion = { label: string; prompt: string };

const SUGGESTIONS: AssistantSuggestion[] = [
  { label: 'Find a document', prompt: 'Find documents about ' },
  { label: 'Search inside documents', prompt: 'Which document mentions ' },
  { label: 'Summarize a file', prompt: 'Summarize this file' },
  { label: 'Organize my files', prompt: 'Organize my files' },
  { label: 'Find duplicate files', prompt: 'Find duplicate files' },
  { label: 'Create a folder', prompt: 'Create a folder called ' },
  { label: 'Share a file', prompt: 'Share this file with ' },
];

const HISTORY_LIMIT = 50;
const OFFLINE_RECHECK_MS = 15000;

const readHistory = (key: string): Message[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    const messages: Message[] = Array.isArray(saved) ? saved : [];
    // A question left without a reply (the page was reloaded or closed while File Box was working).
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      messages.push({
        id: `${last.id}-unanswered`,
        role: 'assistant',
        content: "This question didn't get an answer because the page was closed or reloaded while File Box was working on it. Ask it again.",
        error: true,
      });
    }
    return messages;
  } catch {
    return [];
  }
};

// A new visit: nothing said for this long (or never), so the companion checks in again.
const NEW_VISIT_MS = 3 * 60 * 60 * 1000;

interface AIAssistantProps {
  // 'panel': inside the companion side panel (no page header; knows which page the person is on).
  variant?: 'page' | 'panel';
  suggestions?: AssistantSuggestion[];
}

const AIAssistant: React.FC<AIAssistantProps> = ({ variant = 'page', suggestions = SUGGESTIONS }) => {
  const { user } = useAuth();
  const companion = useCompanion();
  const navigate = useNavigate();
  const location = useLocation();
  const historyKey = `filebox-ai-history-${user?.id || 'local'}`;
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [messages, setMessages] = useState<Message[]>(() => readHistory(historyKey));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  // Seconds since the question was sent, shown while File Box is working on it.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!sending) { setWaited(0); return undefined; }
    const started = Date.now();
    const timer = setInterval(() => setWaited(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [sending]);
  const [fileOptions, setFileOptions] = useState<FileOption[]>([]);
  const [selectedFileId, setSelectedFileId] = useState('');
  const [fileActions, setFileActions] = useState<FileAIActionsInfo | null>(null);
  const [runningAction, setRunningAction] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoSentRef = useRef(false);
  // Review panels stay live only for requests made during this visit; restored history doesn't re-run analysis.
  const livePanelIds = useRef<Set<string>>(new Set());

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

  // While this page is open, File Box keeps background file reading paused so questions come first.
  useEffect(() => {
    if (!status?.ready) return undefined;
    const ping = () => { if (document.visibilityState === 'visible') aiAssistantAPI.presence().catch(() => {}); };
    ping();
    const timer = setInterval(ping, 20000);
    return () => clearInterval(timer);
  }, [status?.ready]);

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

  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const appendMessage = (message: Omit<Message, 'id'>, id = newId()) => {
    if (message.panel) livePanelIds.current.add(id);
    setMessages(prev => [...prev, { at: Date.now(), ...message, id }]);
  };

  const updateMessage = (id: string, patch: Partial<Message>) =>
    setMessages(prev => prev.map(message => message.id === id ? { ...message, ...patch } : message));

  const send = useCallback(async (text: string, fileId?: string, resolved?: AssistantResolved, shownAs?: string) => {
    const question = text.trim();
    if (!question || sending) return;

    // Files shown in earlier answers go along, so "share it" or "move that one" can refer to them.
    const history: AssistantHistoryMessage[] = messages
      .slice(-10)
      .map(message => {
        const shown = [...(message.files || []), ...(message.choices?.options || [])].map(file => file.name);
        return { role: message.role, content: shown.length ? `${message.content}\n[Files shown: ${shown.join(', ')}]` : message.content };
      });

    appendMessage({ role: 'user', content: shownAs || question });
    if (!resolved) setInput('');
    setSending(true);
    // The answer shows up word by word while File Box AI writes it.
    const streamId = newId();
    let streamed = '';
    try {
      const response = await aiAssistantAPI.chatStream(
        { question, fileId: fileId || undefined, history, resolved, context: variant === 'panel' ? companion.pageContext : 'The person is on the File Box AI page.' },
        (piece) => {
          if (!streamed) appendMessage({ role: 'assistant', content: piece }, streamId);
          streamed += piece;
          if (streamed !== piece) updateMessage(streamId, { content: streamed });
          setStreaming(true);
        },
        // File Box looked in more files and is writing a new answer: clear the first one.
        () => {
          if (streamed) {
            streamed = ' ';
            updateMessage(streamId, { content: 'Looking in more of your files…' });
          }
        },
      );
      const reply: Omit<Message, 'id'> = {
        role: 'assistant',
        content: response.answer || 'Done.',
        files: response.files?.length ? response.files : undefined,
        pendingAction: response.pendingAction,
        panel: response.panel,
        choices: response.choices?.options?.length ? response.choices : undefined,
        resume: response.resume,
        offline: response.route?.mode === 'offline',
        error: response.error === true,
        actionState: response.pendingAction ? 'pending' : undefined,
        question,
        route: response.route ? { intent: response.route.intent, action: response.route.action, phrase: response.route.phrase } : undefined,
        sources: response.sources?.length ? response.sources : undefined,
      };
      if (response.memoryChanged) companion.refresh();
      if (streamed) {
        if (reply.panel) livePanelIds.current.add(streamId);
        updateMessage(streamId, reply);
      } else {
        appendMessage(reply);
      }
    } catch (error: any) {
      const data = error?.response?.data;
      if (data?.code === 'AI_OFFLINE') {
        setStatus({ reachable: false, ready: false });
      }
      const failed = { role: 'assistant' as const, content: data?.answer || data?.message || 'File Box AI could not answer right now. Please try again.', error: true };
      if (streamed) updateMessage(streamId, failed);
      else appendMessage(failed);
    } finally {
      setSending(false);
      setStreaming(false);
      inputRef.current?.focus();
    }
    // `messages` is read for history only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, messages]);

  // Home's "Summarize documents" chip: /ai?prefill=<text> fills the box without sending.
  useEffect(() => {
    const prefill = new URLSearchParams(location.search).get('prefill');
    if (prefill) {
      setInput(prefill);
      inputRef.current?.focus();
    }
  }, [location.search]);

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
    if (!q || autoSentRef.current || !status) return;
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

  // Continue the original request with the file or folder the user picked. The server re-checks access.
  const choose = (message: Message, option: AssistantChoice) => {
    if (!message.choices || !message.resume || message.chosenId || sending) return;
    updateMessage(message.id, { chosenId: option.id });
    const previous = message.resume.resolved || {};
    const resolved: AssistantResolved = message.choices.slot === 'folder'
      ? { ...previous, folder: option.id }
      : { ...previous, files: { ...(previous.files || {}), [message.choices.key]: option.id } };
    send(message.resume.question, message.resume.fileId || undefined, resolved, `${option.name} — ${option.location}`);
  };

  // 👍/👎 on an answer. A correction ("the right file was X") is used for similar requests later.
  const [feedbackFile, setFeedbackFile] = useState('');
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackThanks, setFeedbackThanks] = useState<Record<string, string>>({});
  const sendFeedback = async (message: Message, rating: 'up' | 'down', correctFileId?: string, note?: string) => {
    if (!message.question) return;
    updateMessage(message.id, { feedback: rating, feedbackOpen: false });
    try {
      const result = await aiAssistantAPI.feedback({
        question: message.question,
        answer: message.content,
        rating,
        intent: message.route?.intent,
        action: message.route?.action,
        phrase: message.route?.phrase,
        shownFileIds: [...(message.files || []).map(f => f.id), ...(message.sources || []).map(s => s.fileId)],
        correctFileId: correctFileId || undefined,
        note: note || undefined,
      });
      setFeedbackThanks(prev => ({ ...prev, [message.id]: result.learned ? "Thanks. File Box will use that file for questions like this." : 'Thanks for the feedback.' }));
    } catch {
      setFeedbackThanks(prev => ({ ...prev, [message.id]: 'Feedback could not be saved.' }));
    }
    setFeedbackFile('');
    setFeedbackNote('');
  };

  // While File Box is still reading files, say so: answers improve as it reads.
  const [reading, setReading] = useState<{ total: number; done: number; pending: number } | null>(null);
  useEffect(() => {
    if (!status?.ready) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => aiAssistantAPI.readingStatus()
      .then((result) => {
        setReading(result);
        if (result.pending > 0) timer = setTimeout(check, 15000);
      })
      .catch(() => setReading(null));
    check();
    return () => { if (timer) clearTimeout(timer); };
  }, [status?.ready]);

  const modifiedLabel = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : `Modified ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  };

  // Actions that fit the selected file's type (same list as the file menu's "Ask File Box AI").
  useEffect(() => {
    setFileActions(null);
    if (!selectedFileId) return;
    aiAssistantAPI.getFileActions(selectedFileId).then(setFileActions).catch(() => setFileActions(null));
  }, [selectedFileId, status?.ready]);

  const runFileAction = async (actionId: string, label: string) => {
    const file = fileOptions.find(option => option._id === selectedFileId);
    appendMessage({ role: 'user', content: `${label}: ${file?.originalName || 'selected file'}` });
    setRunningAction(actionId);
    try {
      const response = await aiAssistantAPI.runFileAction(selectedFileId, actionId);
      appendMessage({ role: 'assistant', content: response.result + (response.truncated ? '\n\n(Only the first part of this long file was read.)' : '') });
    } catch (err: any) {
      appendMessage({ role: 'assistant', content: err?.response?.data?.message || 'This action could not be completed.', error: true });
    } finally {
      setRunningAction('');
    }
  };

  // Open a result where it lives: your folder, Shared, the Team Space, or Trash.
  const openFile = (file: FoundFile) => {
    if (file.trashed) return navigate(pagePath('trash'));
    if (file.source === 'shared') return navigate(pagePath('shared'));
    if (file.source === 'team') return navigate(pagePath('teams'));
    return navigate(pagePath('files'), { state: { openFolderId: file.parentFolder, highlightFileId: file.id } });
  };

  const sourceLabel = (file: FoundFile) => {
    if (file.trashed) return 'In Trash';
    if (file.source === 'shared') return `Shared by ${file.ownerName || 'someone'} · ${file.role === 'editor' ? 'can edit' : 'can view'}`;
    if (file.source === 'team') return `${file.teamName ? `Team Space: ${file.teamName}` : 'Team Space'} · ${file.role === 'editor' ? 'can edit' : 'can view'}`;
    return `Yours · ${file.folder}`;
  };

  const applySuggestion = (suggestion: AssistantSuggestion) => {
    setInput(suggestion.prompt);
    inputRef.current?.focus();
  };

  const ready = Boolean(status?.ready);
  // Opening File Box AI after a while (or for the first time): it checks in before the conversation.
  const [visitStart] = useState(() => Date.now());
  const lastAt = [...messages].reverse().find(message => message.at)?.at || 0;
  const isNewVisit = !messages.some(message => (message.at || 0) >= visitStart) && (!messages.length || visitStart - lastAt > NEW_VISIT_MS);
  const lastTopic = messages.length ? [...messages].reverse().find(message => message.role === 'user')?.content : undefined;
  // Only the newest review panel stays live, so old results never act on stale suggestions.
  const lastPanelId = [...messages].reverse().find(message => message.panel && livePanelIds.current.has(message.id))?.id;
  const modelMissing = Boolean(status?.reachable && !status?.assistantModelAvailable);

  return (
    <div className={`filebox-ai ${variant === 'panel' ? 'filebox-ai-panel' : ''}`}>
      <header className="filebox-ai-header">
        <div>
          <h1>{companion.name}</h1>
          <p>Your companion in File Box. Ask about your files, tell me what to do, or ask me to remember something.</p>
        </div>
        <span className={`filebox-ai-status ${ready ? 'online' : 'offline'}`} role="status">
          <span className="filebox-ai-status-dot" aria-hidden="true" />
          {checking && !status ? 'Checking…' : ready ? `Local · ${status?.assistantModel}` : 'Offline'}
        </span>
      </header>

      {ready && reading && reading.pending > 0 && (
        <p className="filebox-ai-reading" role="status">
          File Box is reading your files: {reading.done} of {reading.total} done. Answers get better as it reads.
        </p>
      )}

      {status && !ready && (
        <section className="filebox-ai-offline" aria-live="polite">
          <AIAssistantIcon size={22} />
          <div>
            <h2>File Box AI is offline</h2>
            {modelMissing ? (
              <p>Ollama is running, but the assistant model isn't installed. Run <code>ollama pull {status.assistantModel}</code>, then check again.</p>
            ) : (
              <p>Start Ollama on your computer to use local AI features. Finding files, duplicate checks and text extraction still work, and so does the rest of File Box.</p>
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
          placeholder={ready ? 'Find my resume, summarize a PDF, create a folder…' : 'AI is offline — you can still find files and duplicates'}
          aria-label="Message File Box AI"
          disabled={sending}
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
            <select value={selectedFileId} onChange={(event) => setSelectedFileId(event.target.value)} aria-label="File to ask about">
              <option value="">No file selected</option>
              {fileOptions.map(file => <option key={file._id} value={file._id}>{file.originalName}</option>)}
            </select>
          </label>
          <button type="submit" className="btn-primary" disabled={sending || !input.trim()}>
            {sending ? 'Working…' : 'Send'} <ArrowRightIcon size={14} />
          </button>
        </div>
      </form>

      {fileActions && fileActions.actions.length > 0 && (
        <div className="filebox-ai-suggestions" aria-label="Actions for the selected file">
          {fileActions.actions.map(action => (
            <button
              key={action.id}
              disabled={!action.available || Boolean(runningAction) || sending}
              title={action.available ? '' : 'Needs File Box AI (Ollama) to be running'}
              onClick={() => runFileAction(action.id, action.label)}
            >
              {runningAction === action.id ? 'Working…' : action.label}
            </button>
          ))}
        </div>
      )}

      {isNewVisit && (
        <CompanionGreeting
          lastTopic={lastTopic}
          onAsk={(text) => send(text, selectedFileId)}
          onPrefill={(text) => { setInput(text); inputRef.current?.focus(); }}
          onOpenFile={(file) => openFile({ ...file, source: 'owned' } as FoundFile)}
          onNavigate={(page) => navigate(pagePath(page))}
        />
      )}

      {messages.length === 0 && (
        <div className="filebox-ai-suggestions" aria-label="Suggested actions">
          {suggestions.map(suggestion => (
            <button key={suggestion.label} onClick={() => applySuggestion(suggestion)}>
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
              {message.offline && <p className="filebox-ai-mode">Offline mode: basic matching until File Box AI is running.</p>}
              {message.sources && (
                <ul className="filebox-ai-sources" aria-label="Where this answer came from">
                  {message.sources.map(source => {
                    const file = message.files?.find(f => f.id === source.fileId);
                    return (
                      <li key={source.fileId}>
                        <button onClick={() => (file ? openFile(file) : navigate(pagePath('files')))}>
                          <q>{source.quote}</q> <span>— {source.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {message.files && (
                <ul className="filebox-ai-files">
                  {message.files.map(file => (
                    <li key={file.id}>
                      <button onClick={() => openFile(file)}>
                        <DocumentIcon size={14} /><span>{file.name}</span>
                        {file.kind && <small className="filebox-ai-kind">{file.kind.charAt(0).toUpperCase() + file.kind.slice(1)}</small>}
                        <small className={`source-${file.trashed ? 'trash' : file.source || 'owned'}`}>{sourceLabel(file)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {message.choices && (
                <ul className="filebox-ai-choices" aria-label={message.choices.slot === 'folder' ? 'Choose a folder' : 'Choose a file'}>
                  {message.choices.options.map(option => (
                    <li key={option.id}>
                      <button
                        className={message.chosenId === option.id ? 'chosen' : ''}
                        disabled={Boolean(message.chosenId) || sending}
                        aria-pressed={message.chosenId === option.id}
                        onClick={() => choose(message, option)}
                      >
                        <DocumentIcon size={14} />
                        <span className="filebox-ai-choice-name">{option.name}</span>
                        <small>
                          <span className={`source-${option.source}`}>{option.sourceLabel}</span>
                          {' · '}{option.location}
                          {modifiedLabel(option.updatedAt) && <>{' · '}{modifiedLabel(option.updatedAt)}</>}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {message.panel && message.id === lastPanelId && (
                <div className="filebox-ai-panel">
                  {message.panel === 'duplicates' ? <DuplicateReview explain={Boolean(status?.ready)} /> : <OrganizeReview />}
                </div>
              )}
              {message.panel && message.id !== lastPanelId && (
                <p className="ai-panel-muted">
                  {livePanelIds.current.has(message.id) ? 'This review was replaced by a newer one below.' : 'Ask again to start a fresh review.'}
                </p>
              )}
              {message.role === 'assistant' && message.question && !message.error && !message.pendingAction && !message.choices && (
                <div className="filebox-ai-feedback">
                  {feedbackThanks[message.id] ? (
                    <span>{feedbackThanks[message.id]}</span>
                  ) : !message.feedback && !message.feedbackOpen ? (
                    <>
                      <button aria-label="Good answer" title="Good answer" onClick={() => sendFeedback(message, 'up')}>👍</button>
                      <button aria-label="Wrong answer" title="Wrong answer" onClick={() => updateMessage(message.id, { feedbackOpen: true })}>👎</button>
                    </>
                  ) : null}
                  {message.feedbackOpen && (
                    <div className="filebox-ai-feedback-form">
                      <label>
                        Was a different file meant?
                        <select value={feedbackFile} onChange={(event) => setFeedbackFile(event.target.value)}>
                          <option value="">No, something else was wrong</option>
                          {fileOptions.map(file => <option key={file._id} value={file._id}>{file.originalName}</option>)}
                        </select>
                      </label>
                      <input
                        type="text"
                        placeholder="What was wrong? (optional)"
                        value={feedbackNote}
                        onChange={(event) => setFeedbackNote(event.target.value)}
                      />
                      <div>
                        <button className="btn-primary" onClick={() => sendFeedback(message, 'down', feedbackFile, feedbackNote)}>Send</button>
                        <button className="btn-secondary" onClick={() => updateMessage(message.id, { feedbackOpen: false })}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
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
          {sending && !streaming && (
            <div className="filebox-ai-message assistant thinking" role="status">
              {waited < 4 ? 'Thinking…' : `Reading your files… ${waited}s`}
            </div>
          )}
          <div ref={endRef} />
        </section>
      )}
    </div>
  );
};

export default AIAssistant;

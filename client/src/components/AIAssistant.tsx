import React, { useEffect, useRef, useState } from 'react';
import { aiAssistantAPI, filesAPI } from '../services/api';
import { FileItemType } from '../types';
import {
  AIAssistantIcon,
  UploadIcon,
  DocumentIcon,
  LoadingIcon,
  CheckIcon,
  CloseIcon,
  ArrowRightIcon,
} from './Icons';
import './AIAssistant.css';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  fileId?: string;
  uploadedFiles?: FileItemType[];
  action?: {
    type: string;
    success: boolean;
    data?: any;
    error?: string;
  };
}

interface UploadedFile {
  id: string;
  file: File;
  uploading: boolean;
  uploaded?: FileItemType;
  error?: string;
}

interface AssistantStatus {
  reachable: boolean;
  ready: boolean;
  version?: string;
  assistantModel?: string;
  plannerModel?: string;
  assistantMode?: string;
  assistantModelAvailable?: boolean;
  plannerModelAvailable?: boolean;
  error?: string;
}

const MAX_UPLOAD_FILES = 10;
const MAX_HISTORY_MESSAGES = 10;
const SUPPORTED_TYPES = ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'];

const starterMessage: Message = {
  id: 'welcome',
  type: 'assistant',
  content:
    "I’m your local File Box copilot running on Ollama.\n\nTell me what you want done in this website and I’ll do it for you when that action is available in File Box. For normal website tasks, I should perform the action instead of telling you what to click.",
  timestamp: new Date(),
};

const suggestedPrompts = [
  'What changed recently in my drive?',
  'Summarize the selected file for me.',
  'Create a folder called Tax Docs.',
  'Create a file request called Upload W2 Forms.',
  'Create a shortcut for https://openai.com called OpenAI.',
  'Rename the selected file to cleaned-resume.pdf.',
];

const AIAssistant: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([starterMessage]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [availableFiles, setAvailableFiles] = useState<FileItemType[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  useEffect(() => {
    loadAssistantStatus();
    loadAvailableFiles();
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadAssistantStatus = async () => {
    try {
      const data = await aiAssistantAPI.getStatus();
      setStatus(data);
    } catch (error: any) {
      setStatus({
        reachable: false,
        ready: false,
        error: error?.response?.data?.message || error?.message || 'Could not reach the local Ollama assistant.',
      });
    }
  };

  const loadAvailableFiles = async () => {
    try {
      const data = await filesAPI.getFiles();
      const files = (data.files || []).filter((file: FileItemType) =>
        !file.isFolder &&
        SUPPORTED_TYPES.some((type) => file.originalName.toLowerCase().endsWith(`.${type}`))
      );
      setAvailableFiles(files);
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  const selectedFile =
    availableFiles.find((file) => file._id === selectedFileId) ||
    uploadedFiles.find((upload) => upload.uploaded?._id === selectedFileId)?.uploaded ||
    null;

  const filteredFiles = availableFiles
    .filter((file) => file.originalName.toLowerCase().includes(fileSearchQuery.toLowerCase()))
    .slice(0, 12);

  const buildAssistantContext = () => {
    const recentUploads = uploadedFiles
      .filter((upload) => upload.uploaded)
      .map((upload) => upload.uploaded?.originalName)
      .filter(Boolean)
      .join(', ');

    return [
      'Surface: File Box AI assistant page.',
      'Role: local drive copilot with tool use for storage actions.',
      selectedFile ? `Selected file: ${selectedFile.originalName}.` : 'Selected file: none.',
      recentUploads ? `Recently uploaded files: ${recentUploads}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  };

  const toHistoryPayload = (messageList: Message[]) =>
    messageList
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({
        role: message.type,
        content: message.content,
      }));

  const appendAssistantError = (error: any) => {
    const content =
      error?.response?.data?.answer ||
      error?.response?.data?.message ||
      error?.message ||
      'The assistant hit an unexpected error.';

    const errorMessage: Message = {
      id: `assistant-error-${Date.now()}`,
      type: 'assistant',
      content,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, errorMessage]);
  };

  const sendPrompt = async (prompt: string) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || loading) {
      return;
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      type: 'user',
      content: trimmedPrompt,
      timestamp: new Date(),
      fileId: selectedFileId || undefined,
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await aiAssistantAPI.chat(
        trimmedPrompt,
        selectedFileId || undefined,
        buildAssistantContext(),
        toHistoryPayload(nextMessages)
      );

      const assistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        type: 'assistant',
        content: response.answer,
        timestamp: new Date(response.timestamp || Date.now()),
        fileId: response.fileId ? String(response.fileId) : undefined,
        action: response.action || undefined,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      if (response.fileId) {
        setSelectedFileId(String(response.fileId));
      }

      if (response.action?.success) {
        setTimeout(() => {
          loadAvailableFiles();
        }, 400);
      }
    } catch (error: any) {
      console.error('AI assistant error:', error);
      appendAssistantError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    await sendPrompt(input);
  };

  const handleQuickPrompt = async (prompt: string) => {
    setInput(prompt);
    await sendPrompt(prompt);
  };

  const handleComposerKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await handleSend();
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    const filesArray = Array.from(files);

    if (uploadedFiles.length + filesArray.length > MAX_UPLOAD_FILES) {
      alert(`You can upload up to ${MAX_UPLOAD_FILES} files here.`);
      return;
    }

    const pendingUploads: UploadedFile[] = filesArray.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      uploading: true,
    }));

    setUploadedFiles((prev) => [...prev, ...pendingUploads]);

    for (const pendingUpload of pendingUploads) {
      try {
        const uploadedFile = await filesAPI.uploadFile(pendingUpload.file);

        setUploadedFiles((prev) =>
          prev.map((upload) =>
            upload.id === pendingUpload.id
              ? { ...upload, uploading: false, uploaded: uploadedFile }
              : upload
          )
        );

        setSelectedFileId(uploadedFile._id);
        await loadAvailableFiles();

        const uploadMessage: Message = {
          id: `upload-${pendingUpload.id}`,
          type: 'assistant',
          content: `Uploaded "${pendingUpload.file.name}" and selected it for context. You can ask me to summarize it, explain it, or do something with it now.`,
          timestamp: new Date(),
          uploadedFiles: [uploadedFile],
          fileId: uploadedFile._id,
        };

        setMessages((prev) => [...prev, uploadMessage]);
      } catch (error: any) {
        console.error('Error uploading file:', error);
        setUploadedFiles((prev) =>
          prev.map((upload) =>
            upload.id === pendingUpload.id
              ? {
                  ...upload,
                  uploading: false,
                  error: error?.response?.data?.message || error.message || 'Upload failed',
                }
              : upload
          )
        );
      }
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileUpload(e.target.files);
  };

  const removeUploadedFile = (id: string) => {
    const upload = uploadedFiles.find((item) => item.id === id);
    if (upload?.uploaded?._id === selectedFileId) {
      setSelectedFileId(null);
    }

    setUploadedFiles((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <div className="ai-assistant-container">
      <div className="ai-assistant-hero">
        <div className="ai-assistant-hero-copy">
          <span className="ai-assistant-eyebrow">LOCAL COPILOT</span>
          <h2>Chat with your drive</h2>
          <p>
            This assistant uses Ollama to act like your operator inside File Box:
            give it a task and it should carry out the website action for you instead
            of walking you through manual steps.
          </p>
          <div className="ai-capability-row">
            <span>Grounded in your files</span>
            <span>Tool actions</span>
            <span>Ollama local models</span>
          </div>
        </div>

        <div className={`ai-status-card ${status?.ready ? 'is-ready' : 'is-warning'}`}>
          <div className="ai-status-head">
            <span className="ai-status-dot" />
            <strong>{status?.ready ? 'Ollama connected' : 'Ollama needs attention'}</strong>
          </div>
          <p>
            {status?.ready
              ? `${status?.assistantModel || 'model'} live with planner ${status?.plannerModel || 'model'}.`
              : status?.error || 'Start Ollama locally and make sure the configured models are installed.'}
          </p>
          <div className="ai-status-meta">
            <span>{status?.assistantMode || 'copilot'}</span>
            {status?.version ? <span>v{status.version}</span> : null}
          </div>
        </div>
      </div>

      <div className="ai-control-bar">
        <div className="ai-control-left">
          <button
            className="ai-control-btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadedFiles.length >= MAX_UPLOAD_FILES}
          >
            <UploadIcon size={16} color="currentColor" />
            <span>Upload context</span>
          </button>

          <div className="ai-file-picker">
            <button
              className="ai-control-btn"
              onClick={() => setShowFileSelector((prev) => !prev)}
            >
              <DocumentIcon size={16} color="currentColor" />
              <span>{selectedFile ? 'Change file' : 'Pick a file'}</span>
            </button>

            {showFileSelector && (
              <div className="file-selector-dropdown">
                <input
                  type="text"
                  placeholder="Search files..."
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                  className="file-search-input"
                />
                <div className="file-list">
                  {filteredFiles.length > 0 ? (
                    filteredFiles.map((file) => (
                      <button
                        key={file._id}
                        type="button"
                        className={`file-item ${selectedFileId === file._id ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedFileId(file._id);
                          setShowFileSelector(false);
                          setFileSearchQuery('');
                        }}
                      >
                        <span className="file-name">{file.originalName}</span>
                      </button>
                    ))
                  ) : (
                    <div className="no-files">No supported files found</div>
                  )}
                </div>
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
        </div>

        <div className="ai-control-right">
          {selectedFile ? (
            <div className="selected-file-chip">
              <DocumentIcon size={14} color="currentColor" />
              <span>{selectedFile.originalName}</span>
              <button type="button" onClick={() => setSelectedFileId(null)} aria-label="Clear selected file">
                <CloseIcon size={14} color="currentColor" />
              </button>
            </div>
          ) : (
            <div className="selected-file-empty">No file selected</div>
          )}
        </div>
      </div>

      {uploadedFiles.length > 0 && (
        <div className="uploaded-files-mini">
          {uploadedFiles.map((upload) => (
            <div key={upload.id} className="upload-mini-item">
              {upload.uploading ? (
                <LoadingIcon size={14} color="currentColor" />
              ) : upload.error ? (
                <CloseIcon size={14} color="#dc2626" />
              ) : (
                <CheckIcon size={14} color="#059669" />
              )}
              <span>{upload.file.name}</span>
              {!upload.uploading ? (
                <button type="button" onClick={() => removeUploadedFile(upload.id)} aria-label="Remove uploaded file">
                  <CloseIcon size={12} color="currentColor" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="ai-chat-shell">
        <div className="ai-assistant-messages">
          {messages.map((message) => (
            <div key={message.id} className={`message message-${message.type}`}>
              <div className="message-content">
                {message.type === 'assistant' ? (
                  <span className="message-avatar">
                    <AIAssistantIcon size={20} color="#0f766e" />
                  </span>
                ) : null}

                <div className="message-card">
                  <div className="message-role">{message.type === 'assistant' ? 'Copilot' : 'You'}</div>
                  <div className="message-body">{message.content}</div>

                  {message.uploadedFiles?.length ? (
                    <div className="uploaded-files-in-message">
                      {message.uploadedFiles.map((file) => (
                        <div key={file._id} className="file-chip">
                          <DocumentIcon size={14} color="currentColor" />
                          <span>{file.originalName}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {message.action ? (
                    <div className={`action-result ${message.action.success ? 'success' : 'error'}`}>
                      {message.action.success ? 'Action completed' : 'Action failed'}
                      <span>{message.action.type.replace(/_/g, ' ')}</span>
                    </div>
                  ) : null}

                  <span className="message-time">
                    {message.timestamp.toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {loading ? (
            <div className="message message-assistant">
              <div className="message-content">
                <span className="message-avatar">
                  <AIAssistantIcon size={20} color="#0f766e" />
                </span>
                <div className="message-card">
                  <div className="message-role">Copilot</div>
                  <div className="typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="message-time">Thinking through your drive...</span>
                </div>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>

        {messages.length <= 1 ? (
          <div className="suggested-questions">
            {suggestedPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="suggestion-btn"
                onClick={() => handleQuickPrompt(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ai-assistant-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Ask about your drive, a file, or an action you want done..."
            disabled={loading}
            rows={3}
          />
          <button onClick={handleSend} disabled={loading || !input.trim()} aria-label="Send message">
            {loading ? (
              <LoadingIcon size={18} color="currentColor" />
            ) : (
              <ArrowRightIcon size={18} color="currentColor" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AIAssistant;

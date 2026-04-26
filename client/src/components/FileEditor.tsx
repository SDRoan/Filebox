import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileItemType } from '../types';
import { commentsAPI, filesAPI } from '../services/api';
import {
  countWords,
  editorHtmlToPlainText,
  normalizeEditorHtml,
  textToEditorHtml,
} from '../utils/editorContent';
import FileComments from './FileComments';
import FileVersions from './FileVersions';
import {
  CloseIcon,
  CommentIcon,
  DownloadIcon,
  EditIcon,
  LinkIcon,
  LoadingIcon,
  RefreshIcon,
  SaveIcon,
  ScrollIcon,
} from './Icons';
import './FileEditor.css';

interface FileEditorProps {
  file: FileItemType;
  onClose: () => void;
  onSave?: () => void;
}

type FileType = 'pdf' | 'docx' | 'txt';

const getFileType = (file: FileItemType): FileType => {
  const mimeType = file.mimeType.toLowerCase();
  const extension = file.originalName.split('.').pop()?.toLowerCase() || '';

  if (mimeType.includes('pdf') || extension === 'pdf') return 'pdf';
  if (
    mimeType.includes('word') ||
    mimeType.includes('document') ||
    mimeType.includes('msword') ||
    mimeType.includes('vnd.openxmlformats-officedocument.wordprocessingml') ||
    extension === 'docx' ||
    extension === 'doc'
  ) {
    return 'docx';
  }

  return 'txt';
};

const getEditorModeCopy = (fileType: FileType) => {
  if (fileType === 'pdf') {
    return {
      badge: 'PDF',
      title: 'Rich PDF drafting',
      description: 'This workspace keeps structure, headings, lists, and inline emphasis closer to a document editor before regenerating the PDF.',
      note: 'PDF export is rebuilt from the editor content, so page layout may differ from the original source file.',
      placeholder: 'Start editing your PDF draft...',
    };
  }

  if (fileType === 'docx') {
    return {
      badge: 'DOCX',
      title: 'Rich document editing',
      description: 'Headings, lists, links, and inline formatting now round-trip more like a real document workspace instead of a plain text box.',
      note: 'Best for editing structure and content quickly. Very complex original layouts may still simplify when the Word file is regenerated.',
      placeholder: 'Start editing your document...',
    };
  }

  return {
    badge: 'TEXT',
    title: 'Writing surface',
    description: 'A cleaner drafting surface with shortcuts and structure while still saving back as plain text.',
    note: 'Formatting controls are available for drafting, but plain text files save without rich styling.',
    placeholder: 'Start writing...',
  };
};

const formatSavedTime = (savedAt: Date | null) => {
  if (!savedAt) {
    return 'Ready to edit';
  }

  return `Saved at ${savedAt.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
};

const EditorCommandButton: React.FC<{
  active?: boolean;
  label: string;
  title: string;
  onClick: () => void;
}> = ({ active = false, label, title, onClick }) => (
  <button
    type="button"
    className={`editor-command-btn ${active ? 'is-active' : ''}`}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    title={title}
  >
    {label}
  </button>
);

const FileEditor: React.FC<FileEditorProps> = ({ file, onClose, onSave }) => {
  const [editorHtml, setEditorHtml] = useState('<p></p>');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [originalHtml, setOriginalHtml] = useState('<p></p>');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [commentsCount, setCommentsCount] = useState<number | null>(null);
  const [versionsCount, setVersionsCount] = useState<number | null>(null);
  const [formatState, setFormatState] = useState({
    bold: false,
    italic: false,
    underline: false,
    strikeThrough: false,
    unorderedList: false,
    orderedList: false,
    alignLeft: true,
    alignCenter: false,
    alignRight: false,
  });
  const editorRef = useRef<HTMLDivElement>(null);
  const versionUploadRef = useRef<HTMLInputElement>(null);
  const fileType = getFileType(file);
  const modeCopy = getEditorModeCopy(fileType);

  const plainTextContent = useMemo(() => editorHtmlToPlainText(editorHtml), [editorHtml]);
  const wordCount = useMemo(() => countWords(plainTextContent), [plainTextContent]);
  const lineCount = useMemo(() => {
    if (!plainTextContent) {
      return 1;
    }

    return plainTextContent.split('\n').length;
  }, [plainTextContent]);
  const characterCount = plainTextContent.length;
  const statusText = saving
    ? 'Saving changes...'
    : hasChanges
      ? 'Autosaving soon'
      : formatSavedTime(lastSavedAt);

  const syncEditorState = useCallback((nextHtml: string) => {
    const normalizedNext = normalizeEditorHtml(nextHtml || '<p></p>');
    setEditorHtml(normalizedNext || '<p></p>');
    setHasChanges(normalizedNext !== normalizeEditorHtml(originalHtml));
  }, [originalHtml]);

  const updateFormatState = useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    try {
      setFormatState({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        strikeThrough: document.queryCommandState('strikeThrough'),
        unorderedList: document.queryCommandState('insertUnorderedList'),
        orderedList: document.queryCommandState('insertOrderedList'),
        alignLeft: document.queryCommandState('justifyLeft'),
        alignCenter: document.queryCommandState('justifyCenter'),
        alignRight: document.queryCommandState('justifyRight'),
      });
    } catch (selectionError) {
      console.debug('Editor format state unavailable:', selectionError);
    }
  }, []);

  const runCommand = useCallback((command: string, value?: string) => {
    if (!editorRef.current || loading) {
      return;
    }

    editorRef.current.focus();
    document.execCommand(command, false, value);
    syncEditorState(editorRef.current.innerHTML || '<p></p>');
    updateFormatState();
  }, [loading, syncEditorState, updateFormatState]);

  const loadEditorMeta = useCallback(async () => {
    try {
      const [comments, versions] = await Promise.all([
        commentsAPI.getFileComments(file._id),
        filesAPI.getFileVersions(file._id),
      ]);
      setCommentsCount(Array.isArray(comments) ? comments.length : 0);
      setVersionsCount(Array.isArray(versions) ? versions.length : 0);
    } catch (metaError) {
      console.debug('Editor meta load skipped:', metaError);
    }
  }, [file._id]);

  const loadFileContent = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setLastSavedAt(null);

      let initialHtml = '<p></p>';

      if (fileType === 'txt') {
        const blob = await filesAPI.downloadFile(file._id);
        const text = await blob.text();
        initialHtml = textToEditorHtml(text);
      } else {
        const result = await filesAPI.getPreviewText(file._id);
        initialHtml = result.editorHtml || textToEditorHtml(result.text || '');
      }

      const normalizedHtml = normalizeEditorHtml(initialHtml || '<p></p>') || '<p></p>';
      setEditorHtml(normalizedHtml);
      setOriginalHtml(normalizedHtml);
      setHasChanges(false);
      await loadEditorMeta();
    } catch (loadError: any) {
      console.error('Error loading file content:', loadError);
      setError(loadError.response?.data?.message || 'Failed to load file content');
    } finally {
      setLoading(false);
    }
  }, [file._id, fileType, loadEditorMeta]);

  const handleSave = useCallback(async () => {
    try {
      const currentHtml = normalizeEditorHtml(editorRef.current?.innerHTML || editorHtml || '<p></p>') || '<p></p>';
      const plainText = editorHtmlToPlainText(currentHtml);

      setSaving(true);
      setError(null);

      if (fileType === 'txt') {
        const blob = new Blob([plainText], { type: 'text/plain' });
        await filesAPI.updateFile(file._id, blob, file.originalName);
      } else if (fileType === 'docx') {
        await filesAPI.updateFileAsDocx(file._id, plainText, file.originalName, currentHtml);
      } else {
        await filesAPI.updateFileAsPdf(file._id, plainText, file.originalName, currentHtml);
      }

      setEditorHtml(currentHtml);
      setOriginalHtml(currentHtml);
      setHasChanges(false);
      setLastSavedAt(new Date());
      onSave?.();
      await loadEditorMeta();
    } catch (saveError: any) {
      console.error('Error saving file:', saveError);
      setError(saveError.response?.data?.message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [editorHtml, file.originalName, file._id, fileType, loadEditorMeta, onSave]);

  const handleDownload = async () => {
    try {
      const blob = await filesAPI.downloadFile(file._id);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.originalName;
      document.body.appendChild(anchor);
      anchor.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(anchor);
    } catch (downloadError) {
      alert('Failed to download file');
    }
  };

  const handleClose = () => {
    if (saving) {
      return;
    }

    if (hasChanges && !window.confirm('You have unsaved changes. Close the editor anyway?')) {
      return;
    }

    onClose();
  };

  const handleCreateLink = () => {
    const url = window.prompt('Enter a link URL');
    if (!url) {
      return;
    }

    runCommand('createLink', url);
  };

  const handleRemoveFormatting = () => {
    runCommand('removeFormat');
    runCommand('unlink');
  };

  const handleVersionUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) {
      return;
    }

    try {
      await filesAPI.uploadFileVersion(file._id, selectedFile, 'Uploaded from the editor workspace');
      await loadEditorMeta();
      setShowVersions(false);
      onSave?.();
    } catch (uploadError) {
      console.error('Error uploading new version:', uploadError);
      alert('Failed to upload the new version');
    } finally {
      event.target.value = '';
    }
  };

  useEffect(() => {
    loadFileContent();
  }, [loadFileContent]);

  useEffect(() => {
    if (loading || !editorRef.current) {
      return;
    }

    if (normalizeEditorHtml(editorRef.current.innerHTML) !== normalizeEditorHtml(editorHtml)) {
      editorRef.current.innerHTML = editorHtml;
    }

    editorRef.current.focus();
    document.execCommand('defaultParagraphSeparator', false, 'p');
    updateFormatState();
  }, [loading, editorHtml, updateFormatState]);

  useEffect(() => {
    if (!hasChanges || saving || loading) {
      return;
    }

    const timer = window.setTimeout(() => {
      handleSave();
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [editorHtml, hasChanges, loading, saving, handleSave]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;

      if (!isModifier) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 's') {
        event.preventDefault();
        handleSave();
        return;
      }

      if (key === 'b') {
        event.preventDefault();
        runCommand('bold');
        return;
      }

      if (key === 'i') {
        event.preventDefault();
        runCommand('italic');
        return;
      }

      if (key === 'u') {
        event.preventDefault();
        runCommand('underline');
      }
    };

    const handleSelectionChange = () => {
      if (!editorRef.current) {
        return;
      }

      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }

      if (editorRef.current.contains(selection.anchorNode)) {
        updateFormatState();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    document.addEventListener('selectionchange', handleSelectionChange);

    return () => {
      window.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [handleSave, runCommand, updateFormatState]);

  if (loading) {
    return (
      <div className="file-editor-overlay">
        <div className="file-editor-container">
          <div className="editor-loading">
            <LoadingIcon size={32} color="#6b7280" />
            <p>Loading document workspace...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && !editorHtml) {
    return (
      <div className="file-editor-overlay">
        <div className="file-editor-container">
          <div className="editor-error">
            <p>Error: {error}</p>
            <button onClick={handleClose} className="editor-btn secondary">
              <CloseIcon size={16} color="currentColor" /> Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="file-editor-overlay" onClick={handleClose}>
        <div className="file-editor-container" onClick={(event) => event.stopPropagation()}>
          <input
            ref={versionUploadRef}
            type="file"
            className="editor-hidden-input"
            onChange={handleVersionUpload}
          />

          <div className="file-editor-header">
            <div className="editor-title-wrap">
              <div className="editor-kicker">Document workspace</div>
              <div className="editor-title-row">
                <div className="editor-title-icon">
                  <EditIcon size={20} color="currentColor" />
                </div>
                <div className="editor-title-copy">
                  <h3>{file.originalName}</h3>
                  <div className="editor-subtitle">
                    <span className="editor-badge">{modeCopy.badge}</span>
                    <span className={`editor-status ${hasChanges ? 'is-dirty' : 'is-clean'}`}>{statusText}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="editor-actions">
              <button
                onClick={() => setShowComments(true)}
                className="editor-btn secondary"
                title="Open comments"
              >
                <CommentIcon size={16} color="currentColor" /> Comments{commentsCount !== null ? ` ${commentsCount}` : ''}
              </button>
              <button
                onClick={() => setShowVersions(true)}
                className="editor-btn secondary"
                title="Open version history"
              >
                <ScrollIcon size={16} color="currentColor" /> Versions{versionsCount !== null ? ` ${versionsCount}` : ''}
              </button>
              <button
                onClick={handleDownload}
                className="editor-btn secondary"
                title="Download current file"
              >
                <DownloadIcon size={16} color="currentColor" /> Download
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="editor-btn primary"
                title="Save changes"
              >
                {saving ? (
                  <>
                    <LoadingIcon size={16} color="currentColor" /> Saving...
                  </>
                ) : (
                  <>
                    <SaveIcon size={16} color="currentColor" /> Save
                  </>
                )}
              </button>
              <button
                onClick={handleClose}
                className="editor-btn close-btn"
                title="Close editor"
                disabled={saving}
              >
                <CloseIcon size={16} color="currentColor" />
              </button>
            </div>
          </div>

          {error && (
            <div className="editor-error-banner">
              <p>{error}</p>
            </div>
          )}

          <div className="editor-toolbar">
            <div className="editor-toolbar-card">
              <span className="editor-toolbar-label">Editing mode</span>
              <strong>{modeCopy.title}</strong>
              <p>{modeCopy.description}</p>
            </div>
            <div className="editor-toolbar-meta">
              <span className="editor-meta-pill">Words {wordCount}</span>
              <span className="editor-meta-pill">Lines {lineCount}</span>
              <span className="editor-meta-pill">Characters {characterCount}</span>
            </div>
          </div>

          <div className="editor-command-bar">
            <div className="editor-command-group">
              <EditorCommandButton label="Undo" title="Undo" onClick={() => runCommand('undo')} />
              <EditorCommandButton label="Redo" title="Redo" onClick={() => runCommand('redo')} />
            </div>
            <div className="editor-command-group">
              <EditorCommandButton label="B" title="Bold" active={formatState.bold} onClick={() => runCommand('bold')} />
              <EditorCommandButton label="I" title="Italic" active={formatState.italic} onClick={() => runCommand('italic')} />
              <EditorCommandButton label="U" title="Underline" active={formatState.underline} onClick={() => runCommand('underline')} />
              <EditorCommandButton label="S" title="Strikethrough" active={formatState.strikeThrough} onClick={() => runCommand('strikeThrough')} />
            </div>
            <div className="editor-command-group">
              <EditorCommandButton label="H1" title="Heading 1" onClick={() => runCommand('formatBlock', '<h1>')} />
              <EditorCommandButton label="H2" title="Heading 2" onClick={() => runCommand('formatBlock', '<h2>')} />
              <EditorCommandButton label="Body" title="Paragraph" onClick={() => runCommand('formatBlock', '<p>')} />
              <EditorCommandButton label="Quote" title="Block quote" onClick={() => runCommand('formatBlock', '<blockquote>')} />
            </div>
            <div className="editor-command-group">
              <EditorCommandButton label="• List" title="Bulleted list" active={formatState.unorderedList} onClick={() => runCommand('insertUnorderedList')} />
              <EditorCommandButton label="1. List" title="Numbered list" active={formatState.orderedList} onClick={() => runCommand('insertOrderedList')} />
            </div>
            <div className="editor-command-group">
              <EditorCommandButton label="Left" title="Align left" active={formatState.alignLeft} onClick={() => runCommand('justifyLeft')} />
              <EditorCommandButton label="Center" title="Align center" active={formatState.alignCenter} onClick={() => runCommand('justifyCenter')} />
              <EditorCommandButton label="Right" title="Align right" active={formatState.alignRight} onClick={() => runCommand('justifyRight')} />
            </div>
            <div className="editor-command-group">
              <EditorCommandButton label="Link" title="Insert link" onClick={handleCreateLink} />
              <button
                type="button"
                className="editor-command-btn editor-command-btn--icon"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleRemoveFormatting}
                title="Clear formatting"
              >
                <RefreshIcon size={15} color="currentColor" />
              </button>
            </div>
          </div>

          <div className="file-editor-content">
            <div className="editor-workspace">
              <div className="editor-page-shell">
                <div className="editor-page">
                  <div className="editor-page-header">
                    <div>
                      <span className="editor-page-label">Live draft</span>
                      <h4>{file.originalName}</h4>
                    </div>
                    <p>{modeCopy.note}</p>
                  </div>

                  <div className="editor-page-body">
                    <div className="editor-ruler" aria-hidden="true">
                      {Array.from({ length: 8 }).map((_, index) => (
                        <span key={index}>{index + 1}</span>
                      ))}
                    </div>

                    <div
                      ref={editorRef}
                      className={`editor-surface ${fileType === 'txt' ? 'editor-surface--plain' : 'editor-surface--document'}`}
                      contentEditable
                      suppressContentEditableWarning
                      spellCheck={true}
                      data-placeholder={modeCopy.placeholder}
                      onInput={(event) => syncEditorState((event.target as HTMLDivElement).innerHTML || '<p></p>')}
                      onKeyUp={updateFormatState}
                      onMouseUp={updateFormatState}
                    />
                  </div>
                </div>

                <aside className="editor-side-panel">
                  <div className="editor-side-card">
                    <span className="editor-side-label">Workspace</span>
                    <h5>More like Docs now</h5>
                    <p>Formatting, shortcuts, autosave, comments, and version history are all available from this editor surface.</p>
                  </div>
                  <div className="editor-side-card">
                    <span className="editor-side-label">Shortcuts</span>
                    <ul>
                      <li><strong>Cmd/Ctrl + S</strong> saves instantly.</li>
                      <li><strong>Cmd/Ctrl + B / I / U</strong> formats selected text.</li>
                      <li><strong>Autosave</strong> runs after you pause typing.</li>
                    </ul>
                  </div>
                  <div className="editor-side-card">
                    <span className="editor-side-label">Review</span>
                    <button type="button" className="editor-side-action" onClick={() => setShowComments(true)}>
                      <CommentIcon size={16} color="currentColor" /> Open comments
                    </button>
                    <button type="button" className="editor-side-action" onClick={() => setShowVersions(true)}>
                      <ScrollIcon size={16} color="currentColor" /> Open version history
                    </button>
                    <button type="button" className="editor-side-action" onClick={handleCreateLink}>
                      <LinkIcon size={16} color="currentColor" /> Insert link
                    </button>
                  </div>
                </aside>
              </div>
            </div>
          </div>

          <div className="file-editor-footer">
            <div className="editor-stats">
              <span>{modeCopy.badge} document</span>
              <span>{wordCount} words</span>
              <span>{lineCount} lines</span>
              <span>{versionsCount ?? 0} versions</span>
            </div>
            <div className={`editor-save-hint ${hasChanges ? 'is-warning' : ''}`}>
              {saving
                ? 'Saving your changes...'
                : hasChanges
                  ? 'Autosave will run after you pause typing.'
                  : statusText}
            </div>
          </div>
        </div>
      </div>

      {showComments && <FileComments fileId={file._id} onClose={() => setShowComments(false)} />}
      {showVersions && (
        <FileVersions
          fileId={file._id}
          onClose={() => setShowVersions(false)}
          onUploadNewVersion={() => versionUploadRef.current?.click()}
        />
      )}
    </>
  );
};

export default FileEditor;

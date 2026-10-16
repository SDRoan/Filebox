import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileItemType } from '../types';
import { commentsAPI, filesAPI } from '../services/api';
import {
  normalizeEditorHtml,
  textToEditorHtml,
} from '../utils/editorContent';
import FileComments from './FileComments';
import FileVersions from './FileVersions';
import DocumentEditor, {
  DocumentEditorFileType,
  DocumentSavePayload,
} from './editor/DocumentEditor';
import { CloseIcon, LoadingIcon } from './Icons';
import './FileEditor.css';

interface FileEditorProps {
  file: FileItemType;
  onClose: () => void;
  onSave?: () => void;
}

const getFileType = (file: FileItemType): DocumentEditorFileType => {
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

const FileEditor: React.FC<FileEditorProps> = ({ file, onClose, onSave }) => {
  const [initialHtml, setInitialHtml] = useState('<p></p>');
  const [title, setTitle] = useState(file.originalName);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [commentsCount, setCommentsCount] = useState<number | null>(null);
  const [versionsCount, setVersionsCount] = useState<number | null>(null);
  const versionUploadRef = useRef<HTMLInputElement>(null);
  const fileType = getFileType(file);

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
      setTitle(file.originalName);

      let nextHtml = '<p></p>';

      if (fileType === 'txt') {
        const blob = await filesAPI.downloadFile(file._id);
        nextHtml = textToEditorHtml(await blob.text());
      } else {
        const result = await filesAPI.getPreviewText(file._id);
        nextHtml = result.editorHtml || textToEditorHtml(result.text || '');
      }

      setInitialHtml(normalizeEditorHtml(nextHtml || '<p></p>') || '<p></p>');
      await loadEditorMeta();
    } catch (loadError: any) {
      console.error('Error loading file content:', loadError);
      setError(loadError.response?.data?.message || 'Failed to load file content');
    } finally {
      setLoading(false);
    }
  }, [file._id, file.originalName, fileType, loadEditorMeta]);

  const handlePersist = useCallback(async ({ html, text, title: nextTitle }: DocumentSavePayload) => {
    try {
      setSaving(true);
      setError(null);

      if (fileType === 'txt') {
        const blob = new Blob([text], { type: 'text/plain' });
        await filesAPI.updateFile(file._id, blob, nextTitle);
      } else if (fileType === 'docx') {
        await filesAPI.updateFileAsDocx(file._id, text, nextTitle, html);
      } else {
        await filesAPI.updateFileAsPdf(file._id, text, nextTitle, html);
      }

      setInitialHtml(normalizeEditorHtml(html || '<p></p>') || '<p></p>');
      setTitle(nextTitle);
      onSave?.();
      await loadEditorMeta();
    } catch (saveError: any) {
      console.error('Error saving file:', saveError);
      const nextError = saveError.response?.data?.message || 'Failed to save file';
      setError(nextError);
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, [file._id, fileType, loadEditorMeta, onSave]);

  const handleDownload = async () => {
    try {
      const blob = await filesAPI.downloadFile(file._id);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = title;
      document.body.appendChild(anchor);
      anchor.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(anchor);
    } catch (downloadError) {
      console.error('Error downloading file:', downloadError);
      window.alert('Failed to download file');
    }
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
      window.alert('Failed to upload the new version');
    } finally {
      event.target.value = '';
    }
  };

  useEffect(() => {
    void loadFileContent();
  }, [loadFileContent]);

  if (loading) {
    return (
      <div className="file-editor-overlay">
        <div className="file-editor-loading-card">
          <LoadingIcon size={28} color="#64748b" />
          <p>Loading document workspace…</p>
        </div>
      </div>
    );
  }

  if (error && !initialHtml) {
    return (
      <div className="file-editor-overlay">
        <div className="file-editor-error-card">
          <p>{error}</p>
          <button type="button" className="file-editor-error-btn" onClick={onClose}>
            <CloseIcon size={16} color="currentColor" />
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="file-editor-overlay">
        <div className="file-editor-shell" onClick={(event) => event.stopPropagation()}>
          <input
            ref={versionUploadRef}
            type="file"
            className="file-editor-hidden-input"
            onChange={handleVersionUpload}
          />

          <DocumentEditor
            fileId={file._id}
            initialTitle={title}
            initialHtml={initialHtml}
            fileType={fileType}
            saving={saving}
            commentsCount={commentsCount}
            versionsCount={versionsCount}
            error={error}
            onPersist={handlePersist}
            onClose={onClose}
            onDownloadOriginal={handleDownload}
            onOpenComments={() => setShowComments(true)}
            onOpenVersions={() => setShowVersions(true)}
          />
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

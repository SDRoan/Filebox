import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, EditorContent, Extension, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CharacterCount from '@tiptap/extension-character-count';
import FontFamily from '@tiptap/extension-font-family';
import Placeholder from '@tiptap/extension-placeholder';
import {
  CloseIcon,
  CommentIcon,
  DownloadIcon,
  EditIcon,
  LoadingIcon,
  SaveIcon,
  ScrollIcon,
} from '../Icons';
import MenuBar, { DocumentMenu } from './MenuBar';
import Ruler from './Ruler';
import Toolbar, { ParagraphStyleValue } from './Toolbar';
import WordCount from './WordCount';
import {
  downloadHtmlDocument,
  downloadPdfFromElement,
  formatTimestamp,
  getLocalDraftKey,
} from './exportUtils';
import './DocumentEditor.css';

export type DocumentEditorFileType = 'pdf' | 'docx' | 'txt';

export interface DocumentSavePayload {
  title: string;
  html: string;
  text: string;
}

interface DocumentEditorProps {
  fileId: string;
  initialTitle: string;
  initialHtml: string;
  fileType: DocumentEditorFileType;
  saving: boolean;
  commentsCount: number | null;
  versionsCount: number | null;
  error?: string | null;
  onPersist: (payload: DocumentSavePayload) => Promise<void>;
  onClose: () => void;
  onDownloadOriginal: () => void;
  onOpenComments: () => void;
  onOpenVersions: () => void;
}

const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
          },
        },
      },
    ];
  },
});

const LineHeight = Extension.create({
  name: 'lineHeight',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote'],
        attributes: {
          lineHeight: {
            default: '1.6',
            parseHTML: (element) => element.style.lineHeight || '1.6',
            renderHTML: (attributes) =>
              attributes.lineHeight ? { style: `line-height: ${attributes.lineHeight}` } : {},
          },
        },
      },
    ];
  },
});

const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => Number(element.getAttribute('data-indent') || 0),
            renderHTML: (attributes) =>
              attributes.indent
                ? {
                    'data-indent': attributes.indent,
                    style: `margin-left: ${Number(attributes.indent) * 2}rem`,
                  }
                : { 'data-indent': 0 },
          },
        },
      },
    ];
  },
});

type DraftPayload = {
  title: string;
  html: string;
  zoom: number;
  savedAt: string;
};

const getModeCopy = (fileType: DocumentEditorFileType) => {
  if (fileType === 'pdf') {
    return {
      badge: 'PDF',
      description: 'Draft and restructure PDF content with a document-style editor before saving back to the file.',
    };
  }

  if (fileType === 'docx') {
    return {
      badge: 'DOCX',
      description: 'Edit Word content with paragraph styles, media, links, comments, and export tools.',
    };
  }

  return {
    badge: 'TEXT',
    description: 'Write in a richer editor while still saving plain text back to the source file when needed.',
  };
};

const readStoredDraft = (storageKey: string, initialTitle: string, initialHtml: string) => {
  if (typeof window === 'undefined') {
    return {
      title: initialTitle,
      html: initialHtml,
      zoom: 100,
      recovered: false,
      savedAt: null as Date | null,
    };
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return {
        title: initialTitle,
        html: initialHtml,
        zoom: 100,
        recovered: false,
        savedAt: null as Date | null,
      };
    }

    const parsed = JSON.parse(rawValue) as DraftPayload;
    return {
      title: parsed.title || initialTitle,
      html: parsed.html || initialHtml,
      zoom: parsed.zoom || 100,
      recovered: true,
      savedAt: parsed.savedAt ? new Date(parsed.savedAt) : null,
    };
  } catch (draftError) {
    console.debug('Failed to read local document draft:', draftError);
    return {
      title: initialTitle,
      html: initialHtml,
      zoom: 100,
      recovered: false,
      savedAt: null as Date | null,
    };
  }
};

const getParagraphStyle = (editor: Editor | null): ParagraphStyleValue => {
  if (!editor) {
    return 'paragraph';
  }

  if (editor.isActive('heading', { level: 1 })) return 'heading1';
  if (editor.isActive('heading', { level: 2 })) return 'heading2';
  if (editor.isActive('heading', { level: 3 })) return 'heading3';
  if (editor.isActive('blockquote')) return 'blockquote';
  return 'paragraph';
};

const normalizeFileTitle = (title: string, fileType: DocumentEditorFileType) => {
  const trimmed = title.trim() || 'Untitled document';
  const suffix = fileType === 'pdf' ? '.pdf' : fileType === 'docx' ? '.docx' : '.txt';
  return trimmed.toLowerCase().endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
};

const DocumentEditor: React.FC<DocumentEditorProps> = ({
  fileId,
  initialTitle,
  initialHtml,
  fileType,
  saving,
  commentsCount,
  versionsCount,
  error,
  onPersist,
  onClose,
  onDownloadOriginal,
  onOpenComments,
  onOpenVersions,
}) => {
  const storageKey = useMemo(() => getLocalDraftKey(fileId), [fileId]);
  const initialDraft = useMemo(
    () => readStoredDraft(storageKey, initialTitle, initialHtml),
    [storageKey, initialTitle, initialHtml],
  );

  const [title, setTitle] = useState(initialDraft.title);
  const [zoom, setZoom] = useState(initialDraft.zoom);
  const [localSavedAt, setLocalSavedAt] = useState<Date | null>(initialDraft.savedAt);
  const [cloudSavedAt, setCloudSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(initialDraft.recovered);
  const [renderTick, setRenderTick] = useState(0);
  const [fontSize, setFontSize] = useState('11');
  const [fontFamily, setFontFamily] = useState('Arial');
  const [textColor, setTextColor] = useState('#1f2937');
  const [highlightColor, setHighlightColor] = useState('#fff59d');
  const [lineSpacing, setLineSpacing] = useState('1.6');
  const [recoveredDraft, setRecoveredDraft] = useState(initialDraft.recovered);
  const [lastInteractionAt, setLastInteractionAt] = useState<number>(Date.now());
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const hydratedRef = useRef(false);

  const modeCopy = getModeCopy(fileType);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true, keepAttributes: true },
        orderedList: { keepMarks: true, keepAttributes: true },
      }),
      TextStyle,
      FontSize,
      FontFamily,
      Color.configure({ types: ['textStyle'] }),
      Highlight.configure({ multicolor: true }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right', 'justify'],
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: 'doc-editor-image' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      CharacterCount,
      Placeholder.configure({
        placeholder: 'Start writing…',
      }),
      LineHeight,
      Indent,
    ],
    content: initialDraft.html,
    editorProps: {
      attributes: {
        class: 'doc-editor-prose',
        spellcheck: 'true',
      },
    },
    onCreate: ({ editor: currentEditor }) => {
      hydratedRef.current = true;
      setRenderTick((value) => value + 1);
      const attributes = currentEditor.getAttributes('textStyle');
      setFontFamily(attributes.fontFamily || 'Arial');
      setFontSize((attributes.fontSize || '11px').replace('px', '') || '11');
      setTextColor(attributes.color || '#1f2937');
      setHighlightColor(currentEditor.getAttributes('highlight').color || '#fff59d');
      const activeType = currentEditor.isActive('heading')
        ? 'heading'
        : currentEditor.isActive('blockquote')
          ? 'blockquote'
          : 'paragraph';
      setLineSpacing(currentEditor.getAttributes(activeType).lineHeight || '1.6');
    },
    onSelectionUpdate: () => {
      setRenderTick((value) => value + 1);
    },
    onUpdate: () => {
      setIsDirty(true);
      setRecoveredDraft(false);
      setSaveError(null);
      setLastInteractionAt(Date.now());
      setRenderTick((value) => value + 1);
    },
  });

  const getDocumentHtml = useCallback(() => editor?.getHTML() || initialDraft.html || '<p></p>', [editor, initialDraft.html]);
  const getDocumentText = useCallback(
    () => editor?.getText({ blockSeparator: '\n' }) || '',
    [editor],
  );

  const persistLocalDraft = useCallback(() => {
    if (!editor) {
      return;
    }

    try {
      const payload: DraftPayload = {
        title,
        html: editor.getHTML(),
        zoom,
        savedAt: new Date().toISOString(),
      };

      window.localStorage.setItem(storageKey, JSON.stringify(payload));
      setLocalSavedAt(new Date(payload.savedAt));
    } catch (draftError) {
      console.debug('Failed to persist local draft:', draftError);
    }
  }, [editor, storageKey, title, zoom]);

  const persistToServer = useCallback(async () => {
    if (!editor) {
      return;
    }

    await onPersist({
      title: normalizeFileTitle(title, fileType),
      html: editor.getHTML(),
      text: editor.getText({ blockSeparator: '\n' }),
    });

    setCloudSavedAt(new Date());
    setIsDirty(false);
    setSaveError(null);
  }, [editor, fileType, onPersist, title]);

  useEffect(() => {
    if (!editor || !hydratedRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      persistLocalDraft();
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
  }, [editor, title, zoom, renderTick, persistLocalDraft]);

  useEffect(() => {
    if (!editor || !isDirty || saving) {
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        await persistToServer();
      } catch (persistError: any) {
        console.error('Error saving rich document:', persistError);
        setSaveError(persistError?.response?.data?.message || 'Failed to save to the server. Your draft is still stored locally.');
      }
    }, 1500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [editor, isDirty, lastInteractionAt, persistToServer, saving]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  const handleManualSave = useCallback(async () => {
    if (!editor || saving) {
      return;
    }

    try {
      persistLocalDraft();
      await persistToServer();
    } catch (persistError: any) {
      console.error('Error saving rich document:', persistError);
      setSaveError(persistError?.response?.data?.message || 'Failed to save to the server. Your draft is still stored locally.');
    }
  }, [editor, persistLocalDraft, persistToServer, saving]);

  const handleParagraphStyleChange = (value: ParagraphStyleValue) => {
    if (!editor) {
      return;
    }

    const chain = editor.chain().focus();
    if (value === 'paragraph') chain.setParagraph().run();
    if (value === 'heading1') (chain as any).setHeading({ level: 1 }).run();
    if (value === 'heading2') (chain as any).setHeading({ level: 2 }).run();
    if (value === 'heading3') (chain as any).setHeading({ level: 3 }).run();
    if (value === 'blockquote') (chain as any).setBlockquote().run();
  };

  const handleFontFamilyChange = (value: string) => {
    if (!editor) {
      return;
    }

    setFontFamily(value);
    editor.chain().focus().setFontFamily(value).run();
  };

  const handleFontSizeChange = (value: string) => {
    if (!editor) {
      return;
    }

    const normalized = Math.max(8, Math.min(96, Number(value) || 11)).toString();
    setFontSize(normalized);
    (editor.chain().focus() as any).setMark('textStyle', { fontSize: `${normalized}px` }).run();
  };

  const handleTextColorChange = (value: string) => {
    if (!editor) {
      return;
    }

    setTextColor(value);
    editor.chain().focus().setColor(value).run();
  };

  const handleHighlightColorChange = (value: string) => {
    if (!editor) {
      return;
    }

    setHighlightColor(value);
    editor.chain().focus().toggleHighlight({ color: value }).run();
  };

  const handleLineSpacingChange = (value: string) => {
    if (!editor) {
      return;
    }

    setLineSpacing(value);

    if (editor.isActive('heading', { level: 1 }) || editor.isActive('heading', { level: 2 }) || editor.isActive('heading', { level: 3 })) {
      (editor.chain().focus() as any).updateAttributes('heading', { lineHeight: value }).run();
      return;
    }

    if (editor.isActive('blockquote')) {
      (editor.chain().focus() as any).updateAttributes('blockquote', { lineHeight: value }).run();
      return;
    }

    (editor.chain().focus() as any).updateAttributes('paragraph', { lineHeight: value }).run();
  };

  const handleInsertLink = () => {
    if (!editor) {
      return;
    }

    const previous = editor.getAttributes('link').href || '';
    const next = window.prompt('Enter a URL', previous);

    if (next === null) {
      return;
    }

    if (!next.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: next.trim(), target: '_blank' }).run();
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile || !editor) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result) {
        editor.chain().focus().setImage({ src: result, alt: selectedFile.name }).run();
      }
    };
    reader.readAsDataURL(selectedFile);
    event.target.value = '';
  };

  const handleIndent = () => {
    if (!editor) {
      return;
    }

    if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
      editor.chain().focus().sinkListItem('listItem').run();
      return;
    }

    if (editor.isActive('taskList')) {
      editor.chain().focus().sinkListItem('taskItem').run();
      return;
    }

    const blockType = editor.isActive('heading')
      ? 'heading'
      : editor.isActive('blockquote')
        ? 'blockquote'
        : 'paragraph';
    const currentIndent = Number(editor.getAttributes(blockType).indent || 0);
    (editor.chain().focus() as any).updateAttributes(blockType, { indent: Math.min(currentIndent + 1, 6) }).run();
  };

  const handleOutdent = () => {
    if (!editor) {
      return;
    }

    if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
      editor.chain().focus().liftListItem('listItem').run();
      return;
    }

    if (editor.isActive('taskList')) {
      editor.chain().focus().liftListItem('taskItem').run();
      return;
    }

    const blockType = editor.isActive('heading')
      ? 'heading'
      : editor.isActive('blockquote')
        ? 'blockquote'
        : 'paragraph';
    const currentIndent = Number(editor.getAttributes(blockType).indent || 0);
    (editor.chain().focus() as any).updateAttributes(blockType, { indent: Math.max(currentIndent - 1, 0) }).run();
  };

  const handleClearFormatting = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().unsetAllMarks().clearNodes().run();
    editor.chain().focus().setParagraph().unsetColor().unsetHighlight().unsetFontFamily().run();
    (editor.chain().focus() as any).setMark('textStyle', { fontSize: null }).run();
  };

  const handlePrintPlaceholder = () => {
    window.alert('Print workflow placeholder');
  };

  const handleHelp = () => {
    window.alert('Shortcuts: Cmd/Ctrl+B bold, Cmd/Ctrl+I italic, Cmd/Ctrl+U underline, Cmd/Ctrl+Z undo, Cmd/Ctrl+Y redo.');
  };

  const handleToolsWordCount = () => {
    if (!editor) {
      return;
    }

    const words = editor.storage.characterCount.words();
    const characters = editor.storage.characterCount.characters();
    window.alert(`Words: ${words}\nCharacters: ${characters}`);
  };

  const handleClearLocalDraft = () => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.removeItem(storageKey);
    setRecoveredDraft(false);
    setLocalSavedAt(null);
  };

  const handleClose = () => {
    if (saving) {
      return;
    }

    if (isDirty && !window.confirm('You have unsynced changes. Close the editor anyway?')) {
      return;
    }

    onClose();
  };

  const menus: DocumentMenu[] = [
    {
      label: 'File',
      items: [
        { label: 'Save', onSelect: () => void handleManualSave(), shortcut: 'Cmd/Ctrl+S' },
        { label: 'Export as HTML', onSelect: () => downloadHtmlDocument(title, getDocumentHtml()) },
        {
          label: 'Download as PDF',
          onSelect: () => {
            if (pageRef.current) {
              void downloadPdfFromElement(title, pageRef.current);
            }
          },
        },
        { label: 'Download current file', onSelect: onDownloadOriginal },
        { label: 'Print', onSelect: handlePrintPlaceholder },
        { label: 'Close editor', onSelect: handleClose, tone: 'danger' },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', onSelect: () => editor?.chain().focus().undo().run(), shortcut: 'Cmd/Ctrl+Z' },
        { label: 'Redo', onSelect: () => editor?.chain().focus().redo().run(), shortcut: 'Cmd/Ctrl+Y' },
        { label: 'Select all', onSelect: () => editor?.chain().focus().selectAll().run() },
        { label: 'Clear formatting', onSelect: handleClearFormatting },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom 75%', onSelect: () => setZoom(75) },
        { label: 'Zoom 100%', onSelect: () => setZoom(100) },
        { label: 'Zoom 125%', onSelect: () => setZoom(125) },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Link', onSelect: handleInsertLink },
        { label: 'Image', onSelect: () => imageInputRef.current?.click() },
        { label: 'Comment', onSelect: onOpenComments },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Bold', onSelect: () => editor?.chain().focus().toggleBold().run(), shortcut: 'Cmd/Ctrl+B' },
        { label: 'Italic', onSelect: () => editor?.chain().focus().toggleItalic().run(), shortcut: 'Cmd/Ctrl+I' },
        { label: 'Underline', onSelect: () => editor?.chain().focus().toggleUnderline().run(), shortcut: 'Cmd/Ctrl+U' },
        { label: 'Bulleted list', onSelect: () => editor?.chain().focus().toggleBulletList().run() },
        { label: 'Numbered list', onSelect: () => editor?.chain().focus().toggleOrderedList().run() },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'Word count', onSelect: handleToolsWordCount },
        { label: 'Clear local draft', onSelect: handleClearLocalDraft },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'Keyboard shortcuts', onSelect: handleHelp }],
    },
  ];

  const words = editor?.storage.characterCount.words() ?? 0;
  const characters = editor?.storage.characterCount.characters() ?? 0;
  const lines = Math.max(1, getDocumentText().split('\n').length);
  const paragraphStyle = getParagraphStyle(editor);
  const statusText = saving
    ? 'Saving to cloud…'
    : saveError || error
      ? 'Cloud save failed. Draft kept locally.'
      : isDirty
        ? 'Editing…'
        : cloudSavedAt
          ? `Saved ${formatTimestamp(cloudSavedAt)}`
          : localSavedAt
            ? `Draft saved ${formatTimestamp(localSavedAt)}`
            : 'Ready';

  return (
    <div className="doc-editor">
      <input ref={imageInputRef} type="file" accept="image/*" className="doc-editor__hidden-input" onChange={handleImageUpload} />

      <header className="doc-editor__topbar">
        <div className="doc-editor__title-group">
          <div className="doc-editor__title-icon">
            <EditIcon size={18} color="currentColor" />
          </div>
          <div className="doc-editor__title-copy">
            <input
              className="doc-editor__title-input"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setIsDirty(true);
                setLastInteractionAt(Date.now());
              }}
              aria-label="Document title"
            />
            <div className="doc-editor__status-row">
              <span className="doc-editor__badge">{modeCopy.badge}</span>
              <span className={`doc-editor__status ${isDirty ? 'is-dirty' : ''}`}>{statusText}</span>
              {recoveredDraft ? <span className="doc-editor__status-pill">Recovered local draft</span> : null}
            </div>
          </div>
        </div>

        <div className="doc-editor__actions">
          <button type="button" className="doc-editor__action" onClick={onOpenComments}>
            <CommentIcon size={16} color="currentColor" />
            Comments {commentsCount ?? 0}
          </button>
          <button type="button" className="doc-editor__action" onClick={onOpenVersions}>
            <ScrollIcon size={16} color="currentColor" />
            Versions {versionsCount ?? 0}
          </button>
          <button type="button" className="doc-editor__action" onClick={onDownloadOriginal}>
            <DownloadIcon size={16} color="currentColor" />
            Download
          </button>
          <button type="button" className="doc-editor__action doc-editor__action--primary" onClick={() => void handleManualSave()}>
            {saving ? <LoadingIcon size={16} color="currentColor" /> : <SaveIcon size={16} color="currentColor" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="doc-editor__action doc-editor__action--ghost" onClick={handleClose} title="Close editor">
            <CloseIcon size={16} color="currentColor" />
          </button>
        </div>
      </header>

      <MenuBar menus={menus} />

      <Toolbar
        editor={editor}
        zoom={zoom}
        paragraphStyle={paragraphStyle}
        fontFamily={fontFamily}
        fontSize={fontSize}
        lineSpacing={lineSpacing}
        textColor={textColor}
        highlightColor={highlightColor}
        saving={saving}
        onSave={() => void handleManualSave()}
        onPrintPlaceholder={handlePrintPlaceholder}
        onZoomChange={setZoom}
        onParagraphStyleChange={handleParagraphStyleChange}
        onFontFamilyChange={handleFontFamilyChange}
        onFontSizeChange={handleFontSizeChange}
        onTextColorChange={handleTextColorChange}
        onHighlightColorChange={handleHighlightColorChange}
        onInsertLink={handleInsertLink}
        onCommentPlaceholder={onOpenComments}
        onImageUpload={() => imageInputRef.current?.click()}
        onLineSpacingChange={handleLineSpacingChange}
        onIndent={handleIndent}
        onOutdent={handleOutdent}
        onClearFormatting={handleClearFormatting}
      />

      {error || saveError ? (
        <div className="doc-editor__error-banner">
          <p>{saveError || error}</p>
        </div>
      ) : null}

      <div className="doc-editor__workspace">
        <div className="doc-editor__workspace-inner">
          <div className="doc-editor__workspace-label">
            <div>
              <span>Document workspace</span>
              <strong>{modeCopy.description}</strong>
            </div>
            <WordCount words={words} characters={characters} lines={lines} />
          </div>

          <div className="doc-editor__zoom-wrap">
            <div className="doc-editor__page-frame" style={{ zoom: `${zoom}%` }}>
              <Ruler />
              <div className="doc-editor__page" ref={pageRef}>
                <div className="doc-editor__page-inner">
                  <EditorContent editor={editor} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer className="doc-editor__footer">
        <WordCount words={words} characters={characters} lines={lines} />
        <div className="doc-editor__footer-status">
          <span>{modeCopy.badge} document</span>
          <span>{statusText}</span>
        </div>
      </footer>
    </div>
  );
};

export default DocumentEditor;

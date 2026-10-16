import React from 'react';
import { Editor } from '@tiptap/react';
import {
  CommentIcon,
  ImageIcon,
  LinkIcon,
  RefreshIcon,
  SaveIcon,
} from '../Icons';

export type ParagraphStyleValue = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'blockquote';

interface ToolbarProps {
  editor: Editor | null;
  zoom: number;
  paragraphStyle: ParagraphStyleValue;
  fontFamily: string;
  fontSize: string;
  lineSpacing: string;
  textColor: string;
  highlightColor: string;
  saving: boolean;
  onSave: () => void;
  onPrintPlaceholder: () => void;
  onZoomChange: (value: number) => void;
  onParagraphStyleChange: (value: ParagraphStyleValue) => void;
  onFontFamilyChange: (value: string) => void;
  onFontSizeChange: (value: string) => void;
  onTextColorChange: (value: string) => void;
  onHighlightColorChange: (value: string) => void;
  onInsertLink: () => void;
  onCommentPlaceholder: () => void;
  onImageUpload: () => void;
  onLineSpacingChange: (value: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onClearFormatting: () => void;
}

const ToolbarButton: React.FC<{
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}> = ({ active = false, disabled = false, onClick, title, children }) => (
  <button
    type="button"
    className={`doc-toolbar__button ${active ? 'is-active' : ''}`}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    title={title}
    disabled={disabled}
  >
    {children}
  </button>
);

const Toolbar: React.FC<ToolbarProps> = ({
  editor,
  zoom,
  paragraphStyle,
  fontFamily,
  fontSize,
  lineSpacing,
  textColor,
  highlightColor,
  saving,
  onSave,
  onPrintPlaceholder,
  onZoomChange,
  onParagraphStyleChange,
  onFontFamilyChange,
  onFontSizeChange,
  onTextColorChange,
  onHighlightColorChange,
  onInsertLink,
  onCommentPlaceholder,
  onImageUpload,
  onLineSpacingChange,
  onIndent,
  onOutdent,
  onClearFormatting,
}) => {
  const fonts = [
    'Arial',
    'Georgia',
    'Times New Roman',
    'Verdana',
    'Courier New',
    'Trebuchet MS',
  ];

  const zoomOptions = [50, 75, 90, 100, 125, 150];
  const lineSpacingOptions = ['1', '1.15', '1.5', '2'];

  return (
    <div className="doc-toolbar" aria-label="Document toolbar">
      <div className="doc-toolbar__group">
        <ToolbarButton
          title="Undo"
          onClick={() => editor?.chain().focus().undo().run()}
          disabled={!editor?.can().chain().focus().undo().run()}
        >
          Undo
        </ToolbarButton>
        <ToolbarButton
          title="Redo"
          onClick={() => editor?.chain().focus().redo().run()}
          disabled={!editor?.can().chain().focus().redo().run()}
        >
          Redo
        </ToolbarButton>
        <ToolbarButton title="Print" onClick={onPrintPlaceholder}>
          Print
        </ToolbarButton>
        <label className="doc-toolbar__select-wrap">
          <span className="sr-only">Zoom</span>
          <select value={zoom} onChange={(event) => onZoomChange(Number(event.target.value))}>
            {zoomOptions.map((option) => (
              <option key={option} value={option}>
                {option}%
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="doc-toolbar__group">
        <label className="doc-toolbar__select-wrap doc-toolbar__select-wrap--wide">
          <span className="sr-only">Paragraph style</span>
          <select
            value={paragraphStyle}
            onChange={(event) => onParagraphStyleChange(event.target.value as ParagraphStyleValue)}
          >
            <option value="paragraph">Normal text</option>
            <option value="heading1">Heading 1</option>
            <option value="heading2">Heading 2</option>
            <option value="heading3">Heading 3</option>
            <option value="blockquote">Quote</option>
          </select>
        </label>

        <label className="doc-toolbar__select-wrap doc-toolbar__select-wrap--wide">
          <span className="sr-only">Font family</span>
          <select value={fontFamily} onChange={(event) => onFontFamilyChange(event.target.value)}>
            {fonts.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </label>

        <label className="doc-toolbar__font-size">
          <span className="sr-only">Font size</span>
          <input
            type="number"
            min={8}
            max={96}
            value={fontSize}
            onChange={(event) => onFontSizeChange(event.target.value)}
          />
        </label>
      </div>

      <div className="doc-toolbar__group">
        <ToolbarButton title="Bold" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>
          B
        </ToolbarButton>
        <ToolbarButton title="Italic" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          I
        </ToolbarButton>
        <ToolbarButton title="Underline" active={editor?.isActive('underline')} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
          U
        </ToolbarButton>
        <ToolbarButton title="Strikethrough" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}>
          S
        </ToolbarButton>
      </div>

      <div className="doc-toolbar__group">
        <label className="doc-toolbar__color">
          <span>T</span>
          <input type="color" value={textColor} onChange={(event) => onTextColorChange(event.target.value)} title="Text color" />
        </label>
        <label className="doc-toolbar__color">
          <span>H</span>
          <input
            type="color"
            value={highlightColor}
            onChange={(event) => onHighlightColorChange(event.target.value)}
            title="Highlight color"
          />
        </label>
        <ToolbarButton title="Insert link" onClick={onInsertLink}>
          <LinkIcon size={14} color="currentColor" />
        </ToolbarButton>
        <ToolbarButton title="Comments" onClick={onCommentPlaceholder}>
          <CommentIcon size={14} color="currentColor" />
        </ToolbarButton>
        <ToolbarButton title="Insert image" onClick={onImageUpload}>
          <ImageIcon size={14} color="currentColor" />
        </ToolbarButton>
      </div>

      <div className="doc-toolbar__group">
        <ToolbarButton title="Align left" active={editor?.isActive({ textAlign: 'left' })} onClick={() => editor?.chain().focus().setTextAlign('left').run()}>
          Left
        </ToolbarButton>
        <ToolbarButton title="Align center" active={editor?.isActive({ textAlign: 'center' })} onClick={() => editor?.chain().focus().setTextAlign('center').run()}>
          Center
        </ToolbarButton>
        <ToolbarButton title="Align right" active={editor?.isActive({ textAlign: 'right' })} onClick={() => editor?.chain().focus().setTextAlign('right').run()}>
          Right
        </ToolbarButton>
        <ToolbarButton title="Justify" active={editor?.isActive({ textAlign: 'justify' })} onClick={() => editor?.chain().focus().setTextAlign('justify').run()}>
          Justify
        </ToolbarButton>

        <label className="doc-toolbar__select-wrap doc-toolbar__select-wrap--compact">
          <span className="sr-only">Line spacing</span>
          <select value={lineSpacing} onChange={(event) => onLineSpacingChange(event.target.value)}>
            {lineSpacingOptions.map((option) => (
              <option key={option} value={option}>
                {option}x
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="doc-toolbar__group">
        <ToolbarButton title="Numbered list" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          1.
        </ToolbarButton>
        <ToolbarButton title="Bulleted list" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          •
        </ToolbarButton>
        <ToolbarButton title="Checklist" active={editor?.isActive('taskList')} onClick={() => editor?.chain().focus().toggleTaskList().run()}>
          ✓
        </ToolbarButton>
        <ToolbarButton title="Indent" onClick={onIndent}>
          Indent
        </ToolbarButton>
        <ToolbarButton title="Outdent" onClick={onOutdent}>
          Outdent
        </ToolbarButton>
        <ToolbarButton title="Clear formatting" onClick={onClearFormatting}>
          <RefreshIcon size={14} color="currentColor" />
        </ToolbarButton>
      </div>

      <div className="doc-toolbar__group">
        <ToolbarButton title="Save document" onClick={onSave}>
          <SaveIcon size={14} color="currentColor" />
          {saving ? 'Saving…' : 'Save'}
        </ToolbarButton>
      </div>
    </div>
  );
};

export default Toolbar;

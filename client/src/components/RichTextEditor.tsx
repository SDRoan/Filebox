import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, Editor, JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder, CharacterCount } from '@tiptap/extensions';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import BoardDialog from './BoardDialog';
import { RichTextNode } from '../services/api';
import { safeHref, toEditorDoc } from '../utils/richTextRender';

/**
 * The Boards text editor (TipTap). Loaded only the first time someone edits a text area, and only one is
 * open at a time. Changes go out as JSON; the server cleans them against its allowlist before saving.
 * While an input method is composing a word (IME), nothing is sent until the word is finished.
 */

const TEXT_COLORS = [['Default', ''], ['Red', '#b91c1c'], ['Orange', '#c2410c'], ['Amber', '#a16207'], ['Green', '#15803d'], ['Teal', '#0f766e'], ['Blue', '#1d4ed8'], ['Purple', '#7e22ce'], ['Grey', '#4b5563']];
const HIGHLIGHTS = [['None', ''], ['Yellow', '#fef08a'], ['Green', '#bbf7d0'], ['Blue', '#bfdbfe'], ['Pink', '#fbcfe8'], ['Orange', '#fed7aa'], ['Purple', '#e9d5ff']];
const NARROW = 560;

const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } } }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TextStyle, Color,
  Highlight.configure({ multicolor: true }),
  TaskList, TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: 'Write something…' }),
  CharacterCount.configure({ limit: 50000 }),
  Subscript, Superscript,
];

interface Tool { id: string; label: string; keys?: string; text: string; active?: (e: Editor) => boolean; run: (e: Editor) => void; disabled?: (e: Editor) => boolean }

const TOOLS: Tool[] = [
  { id: 'bold', label: 'Bold', keys: 'Ctrl/⌘ B', text: 'B', active: e => e.isActive('bold'), run: e => e.chain().focus().toggleBold().run() },
  { id: 'italic', label: 'Italic', keys: 'Ctrl/⌘ I', text: 'I', active: e => e.isActive('italic'), run: e => e.chain().focus().toggleItalic().run() },
  { id: 'underline', label: 'Underline', keys: 'Ctrl/⌘ U', text: 'U', active: e => e.isActive('underline'), run: e => e.chain().focus().toggleUnderline().run() },
  { id: 'strike', label: 'Strikethrough', keys: 'Ctrl/⌘ Shift S', text: 'S', active: e => e.isActive('strike'), run: e => e.chain().focus().toggleStrike().run() },
  { id: 'code', label: 'Inline code', keys: 'Ctrl/⌘ E', text: '</>', active: e => e.isActive('code'), run: e => e.chain().focus().toggleCode().run() },
  { id: 'link', label: 'Link', keys: 'Ctrl/⌘ K', text: '🔗', active: e => e.isActive('link'), run: () => {} },
  { id: 'bulletList', label: 'Bullet list', keys: 'Ctrl/⌘ Shift 8', text: '•', active: e => e.isActive('bulletList'), run: e => e.chain().focus().toggleBulletList().run() },
  { id: 'orderedList', label: 'Numbered list', keys: 'Ctrl/⌘ Shift 7', text: '1.', active: e => e.isActive('orderedList'), run: e => e.chain().focus().toggleOrderedList().run() },
  { id: 'taskList', label: 'Checklist', keys: 'Ctrl/⌘ Shift 9', text: '☑', active: e => e.isActive('taskList'), run: e => e.chain().focus().toggleTaskList().run() },
  { id: 'blockquote', label: 'Quote', keys: 'Ctrl/⌘ Shift B', text: '❝', active: e => e.isActive('blockquote'), run: e => e.chain().focus().toggleBlockquote().run() },
  { id: 'codeBlock', label: 'Code block', keys: 'Ctrl/⌘ Alt C', text: '{ }', active: e => e.isActive('codeBlock'), run: e => e.chain().focus().toggleCodeBlock().run() },
  { id: 'alignLeft', label: 'Align left', keys: 'Ctrl/⌘ Shift L', text: '⇤', active: e => e.isActive({ textAlign: 'left' }), run: e => e.chain().focus().setTextAlign('left').run() },
  { id: 'alignCenter', label: 'Align center', keys: 'Ctrl/⌘ Shift E', text: '↔', active: e => e.isActive({ textAlign: 'center' }), run: e => e.chain().focus().setTextAlign('center').run() },
  { id: 'alignRight', label: 'Align right', keys: 'Ctrl/⌘ Shift R', text: '⇥', active: e => e.isActive({ textAlign: 'right' }), run: e => e.chain().focus().setTextAlign('right').run() },
  { id: 'alignJustify', label: 'Justify', keys: 'Ctrl/⌘ Shift J', text: '☰', active: e => e.isActive({ textAlign: 'justify' }), run: e => e.chain().focus().setTextAlign('justify').run() },
  { id: 'color', label: 'Text color', text: 'A', active: e => Boolean(e.getAttributes('textStyle').color), run: () => {} },
  { id: 'highlight', label: 'Highlight color', keys: 'Ctrl/⌘ Shift H', text: '🖍', active: e => e.isActive('highlight'), run: () => {} },
  { id: 'subscript', label: 'Subscript', keys: 'Ctrl/⌘ ,', text: 'x₂', active: e => e.isActive('subscript'), run: e => e.chain().focus().toggleSubscript().run() },
  { id: 'superscript', label: 'Superscript', keys: 'Ctrl/⌘ .', text: 'x²', active: e => e.isActive('superscript'), run: e => e.chain().focus().toggleSuperscript().run() },
  { id: 'hr', label: 'Horizontal rule', text: '―', run: e => e.chain().focus().setHorizontalRule().run() },
  { id: 'undo', label: 'Undo', keys: 'Ctrl/⌘ Z', text: '↶', run: e => e.chain().focus().undo().run(), disabled: e => !e.can().undo() },
  { id: 'redo', label: 'Redo', keys: 'Ctrl/⌘ Shift Z', text: '↷', run: e => e.chain().focus().redo().run(), disabled: e => !e.can().redo() },
  { id: 'clear', label: 'Clear formatting', text: 'T̸', run: e => e.chain().focus().unsetAllMarks().clearNodes().run() },
];
// Shown when the block is narrow; the rest go under "More".
const PRIMARY = ['bold', 'italic', 'underline', 'link', 'bulletList', 'taskList'];

const styleOf = (e: Editor) => (e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p');

/** The editing toolbar: one Tab stop; arrow keys move between its controls (WAI-ARIA toolbar pattern). */
const Toolbar: React.FC<{ editor: Editor; phone: boolean; onLink: () => void }> = ({ editor, phone, onLink }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [popover, setPopover] = useState<'' | 'color' | 'highlight' | 'more'>('');
  const [, force] = useState(0);
  const [bottom, setBottom] = useState(0);

  // Redraw on every editor change so button states follow the selection.
  useEffect(() => {
    const update = () => force(n => n + 1);
    editor.on('transaction', update);
    return () => { editor.off('transaction', update); };
  }, [editor]);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el || phone) return undefined;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [phone]);
  // Phone: sit just above the on-screen keyboard, following the visible part of the screen.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!phone || !vv) return undefined;
    const place = () => setBottom(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    // The Ask File Box button would cover the end of the toolbar; it steps aside while editing.
    document.body.classList.add('rt-phone-editing');
    place();
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => { vv.removeEventListener('resize', place); vv.removeEventListener('scroll', place); document.body.classList.remove('rt-phone-editing'); };
  }, [phone]);

  const narrow = !phone && width < NARROW;
  const shown = narrow ? TOOLS.filter(t => PRIMARY.includes(t.id)) : TOOLS;
  const hidden = narrow ? TOOLS.filter(t => !PRIMARY.includes(t.id)) : [];

  const press = (tool: Tool) => {
    if (tool.id === 'link') { onLink(); return; }
    if (tool.id === 'color' || tool.id === 'highlight') { setPopover(p => (p === tool.id ? '' : tool.id as 'color' | 'highlight')); return; }
    tool.run(editor);
    setPopover('');
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && popover) { event.preventDefault(); event.stopPropagation(); setPopover(''); return; }
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(':scope > [data-tool]') || []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = items[(next + items.length) % items.length];
    items.forEach(el => { el.tabIndex = el === target ? 0 : -1; });
    target.focus();
  };
  const button = (tool: Tool, index: number) => {
    const active = tool.active?.(editor) || false;
    return (
      <button key={tool.id} type="button" data-tool={tool.id} tabIndex={index === 0 ? 0 : -1} className={`rt-tool ${active ? 'is-active' : ''} tool-${tool.id}`}
        aria-label={tool.label} title={tool.keys ? `${tool.label} (${tool.keys})` : tool.label}
        aria-pressed={tool.active ? active : undefined} disabled={tool.disabled?.(editor) || false}
        aria-haspopup={tool.id === 'color' || tool.id === 'highlight' || tool.id === 'link' ? 'dialog' : undefined}
        onMouseDown={e => e.preventDefault()} onClick={() => press(tool)}>
        {tool.text}
      </button>
    );
  };
  const swatches = (list: string[][], kind: 'color' | 'highlight') => (
    <div className="rt-popover" role="group" aria-label={kind === 'color' ? 'Text colors' : 'Highlight colors'}>
      {list.map(([name, value]) => (
        <button key={name} type="button" className="rt-swatch" aria-label={name} title={name} onMouseDown={e => e.preventDefault()}
          style={value ? { background: kind === 'color' ? '#fff' : value, color: kind === 'color' ? value : undefined } : undefined}
          onClick={() => {
            const chain = editor.chain().focus();
            if (kind === 'color') (value ? chain.setColor(value) : chain.unsetColor()).run();
            else (value ? chain.setHighlight({ color: value }) : chain.unsetHighlight()).run();
            setPopover('');
          }}>
          {kind === 'color' ? 'A' : name === 'None' ? '∅' : ''}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={ref} className={`rt-toolbar ${phone ? 'is-phone' : ''}`} role="toolbar" aria-label="Text formatting" onKeyDown={onKeyDown}
      style={phone ? ({ bottom, '--rt-kb': `${bottom}px` } as React.CSSProperties) : undefined}>
      <select data-tool="style" tabIndex={-1} className="rt-style" aria-label="Text style" value={styleOf(editor)}
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          (v === 'p' ? chain.setParagraph() : chain.setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 })).run();
        }}>
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      {shown.map((t, i) => button(t, i))}
      {hidden.length > 0 && (
        <button type="button" data-tool="more" tabIndex={-1} className={`rt-tool ${popover === 'more' ? 'is-active' : ''}`} aria-label="More formatting" aria-expanded={popover === 'more'}
          onMouseDown={e => e.preventDefault()} onClick={() => setPopover(p => (p === 'more' ? '' : 'more'))}>⋯</button>
      )}
      {popover === 'more' && (
        <div className="rt-popover rt-more" role="group" aria-label="More formatting">
          {hidden.map(t => {
            const active = t.active?.(editor) || false;
            return (
              <button key={t.id} type="button" className={`rt-tool ${active ? 'is-active' : ''} tool-${t.id}`} aria-label={t.label} title={t.keys ? `${t.label} (${t.keys})` : t.label}
                aria-pressed={t.active ? active : undefined} disabled={t.disabled?.(editor) || false} onMouseDown={e => e.preventDefault()} onClick={() => press(t)}>{t.text}</button>
            );
          })}
        </div>
      )}
      {popover === 'color' && swatches(TEXT_COLORS, 'color')}
      {popover === 'highlight' && swatches(HIGHLIGHTS, 'highlight')}
    </div>
  );
};

/** Add, change or remove a link (http, https and mailto only). */
const LinkDialog: React.FC<{ initial: string; onSave: (href: string | null) => void; onClose: () => void }> = ({ initial, onSave, onClose }) => {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = value.trim();
    if (!raw) { onSave(null); return; }
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`;
    const href = safeHref(withScheme);
    if (!href) { setError('Use a web address (https://…) or an email address.'); return; }
    onSave(href);
  };
  return (
    <BoardDialog title={initial ? 'Edit link' : 'Add link'} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="boards-field">
          <span>Link address</span>
          <input value={value} onChange={e => { setValue(e.target.value); setError(''); }} placeholder="https://example.com or name@example.com" aria-invalid={Boolean(error)} />
        </label>
        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        <div className="boards-dialog-actions">
          {initial && <button type="button" className="boards-button-secondary" onClick={() => onSave(null)}>Remove link</button>}
          <button type="button" className="boards-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="boards-button-primary">Save</button>
        </div>
      </form>
    </BoardDialog>
  );
};

export interface RichTextEditorProps {
  doc: RichTextNode;
  label: string;
  phone: boolean;
  onChange: (doc: RichTextNode) => void;
  onBlur: () => void;
  onExit: () => void;
}

const RichTextEditor: React.FC<RichTextEditorProps> = ({ doc, label, phone, onChange, onBlur, onExit }) => {
  const [linkOpen, setLinkOpenState] = useState(false);
  // Read by the editor's handlers, which are created once: opening the link dialog is not leaving the editor.
  const linkOpenRef = useRef(false);
  const setLinkOpen = (open: boolean) => { linkOpenRef.current = open; setLinkOpenState(open); };
  const latest = useRef({ onChange, onBlur, onExit });
  latest.current = { onChange, onBlur, onExit };
  const editor = useEditor({
    extensions,
    content: toEditorDoc(doc) as JSONContent,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'rt-editor', 'aria-label': label, 'aria-multiline': 'true', role: 'textbox' },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') { event.preventDefault(); latest.current.onExit(); return true; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setLinkOpen(true); return true; }
        return false;
      },
    },
    // While a word is being composed (IME), wait for it to finish; compositionend sends it.
    onUpdate: ({ editor: e }) => { if (!e.view.composing) latest.current.onChange(e.getJSON() as RichTextNode); },
    onBlur: () => { if (!linkOpenRef.current) latest.current.onBlur(); },
  });

  useEffect(() => {
    if (!editor) return undefined;
    editor.commands.focus('end');
    const dom = editor.view.dom;
    const done = () => setTimeout(() => latest.current.onChange(editor.getJSON() as RichTextNode), 0);
    dom.addEventListener('compositionend', done);
    return () => dom.removeEventListener('compositionend', done);
  }, [editor]);

  if (!editor) return null;
  return (
    <div className="rt-wrap">
      <Toolbar editor={editor} phone={phone} onLink={() => setLinkOpen(true)} />
      <EditorContent editor={editor} className="rt-content" />
      {linkOpen && (
        <LinkDialog initial={editor.getAttributes('link').href || ''} onClose={() => { setLinkOpen(false); editor.commands.focus(); }}
          onSave={(href) => {
            const chain = editor.chain().focus().extendMarkRange('link');
            (href ? chain.setLink({ href }) : chain.unsetLink()).run();
            setLinkOpen(false);
          }} />
      )}
    </div>
  );
};

export default RichTextEditor;

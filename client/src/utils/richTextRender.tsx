import React from 'react';
import { RichTextNode } from '../services/api';

/**
 * Shows a Boards text area without loading the editor: the stored JSON (already cleaned by the server) is
 * turned into React elements. Nothing is ever inserted as HTML, so file text can never become markup.
 * Links and colours are checked again here, so even a document that skipped the server stays safe.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ALIGN = ['left', 'center', 'right', 'justify'];

export const safeHref = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

const color = (value: unknown) => (typeof value === 'string' && HEX.test(value) ? value : undefined);
const alignStyle = (node: RichTextNode): React.CSSProperties | undefined => {
  const a = node.attrs?.textAlign;
  return typeof a === 'string' && ALIGN.includes(a) && a !== 'left' ? { textAlign: a as React.CSSProperties['textAlign'] } : undefined;
};

function renderText(node: RichTextNode, key: React.Key): React.ReactNode {
  let out: React.ReactNode = node.text || '';
  for (const mark of node.marks || []) {
    switch (mark.type) {
      case 'bold': out = <strong>{out}</strong>; break;
      case 'italic': out = <em>{out}</em>; break;
      case 'underline': out = <u>{out}</u>; break;
      case 'strike': out = <s>{out}</s>; break;
      case 'code': out = <code>{out}</code>; break;
      case 'subscript': out = <sub>{out}</sub>; break;
      case 'superscript': out = <sup>{out}</sup>; break;
      case 'textStyle': { const c = color(mark.attrs?.color); if (c) out = <span style={{ color: c }}>{out}</span>; break; }
      case 'highlight': { const c = color(mark.attrs?.color); out = <mark style={c ? { backgroundColor: c } : undefined}>{out}</mark>; break; }
      case 'link': { const href = safeHref(mark.attrs?.href); if (href) out = <a href={href} target="_blank" rel="noopener noreferrer nofollow">{out}</a>; break; }
      default: break; // anything unknown: just the words
    }
  }
  return <React.Fragment key={key}>{out}</React.Fragment>;
}

function renderNode(node: RichTextNode, key: React.Key, depth = 0): React.ReactNode {
  if (!node || depth > 30) return null;
  if (node.type === 'text') return renderText(node, key);
  const children = (node.content || []).map((child, i) => renderNode(child, i, depth + 1));
  switch (node.type) {
    case 'doc': return <React.Fragment key={key}>{children}</React.Fragment>;
    case 'paragraph': return <p key={key} style={alignStyle(node)}>{children.length ? children : <br />}</p>;
    case 'heading': {
      // Headings inside a board are styled as headings and announced one level below the tab's own title.
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      return <p key={key} role="heading" aria-level={level + 2} className={`rt-h${level}`} style={alignStyle(node)}>{children}</p>;
    }
    case 'bulletList': return <ul key={key}>{children}</ul>;
    case 'orderedList': return <ol key={key} start={Number(node.attrs?.start) > 1 ? Number(node.attrs?.start) : undefined}>{children}</ol>;
    case 'listItem': return <li key={key}>{children}</li>;
    case 'taskList': return <ul key={key} className="rt-tasks">{children}</ul>;
    case 'taskItem': {
      const checked = node.attrs?.checked === true;
      return (
        <li key={key} className={checked ? 'is-checked' : ''}>
          <span className="rt-check" role="checkbox" aria-checked={checked} aria-disabled="true">{checked ? '✓' : ''}</span>
          <div>{children}</div>
        </li>
      );
    }
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>;
    case 'codeBlock': return <pre key={key}><code>{(node.content || []).map(c => c.text || '').join('')}</code></pre>;
    case 'horizontalRule': return <hr key={key} />;
    case 'hardBreak': return <br key={key} />;
    default: return <React.Fragment key={key}>{children}</React.Fragment>;
  }
}

const KNOWN_BLOCKS = ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule'];
const KNOWN_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle', 'highlight', 'subscript', 'superscript'];
const plainText = (n?: RichTextNode): string => (!n ? '' : n.type === 'text' ? n.text || '' : (n.content || []).map(plainText).join(''));

function editorMarks(marks?: RichTextNode['marks']) {
  const out: NonNullable<RichTextNode['marks']> = [];
  for (const m of marks || []) {
    if (!m || !KNOWN_MARKS.includes(m.type) || out.some(o => o.type === m.type)) continue;
    if (m.type === 'link') { const href = safeHref(m.attrs?.href); if (href) out.push({ type: 'link', attrs: { href } }); continue; }
    if (m.type === 'textStyle') { const c = color(m.attrs?.color); if (c) out.push({ type: 'textStyle', attrs: { color: c } }); continue; }
    if (m.type === 'highlight') { const c = color(m.attrs?.color); out.push(c ? { type: 'highlight', attrs: { color: c } } : { type: 'highlight' }); continue; }
    out.push({ type: m.type });
  }
  return out.length ? out : undefined;
}

function editorNode(node: RichTextNode, depth: number): RichTextNode | null {
  if (!node || typeof node !== 'object' || depth > 30) return null;
  if (node.type === 'text') return node.text ? { type: 'text', text: String(node.text), ...(editorMarks(node.marks) ? { marks: editorMarks(node.marks) } : {}) } : null;
  if (node.type === 'hardBreak') return { type: 'hardBreak' };
  // Anything the editor does not know keeps its words, as a plain paragraph.
  if (!KNOWN_BLOCKS.includes(node.type)) { const text = plainText(node); return { type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }; }
  const a = node.attrs || {};
  const attrs: Record<string, unknown> = {};
  if ((node.type === 'paragraph' || node.type === 'heading') && typeof a.textAlign === 'string' && ALIGN.includes(a.textAlign)) attrs.textAlign = a.textAlign;
  if (node.type === 'heading') attrs.level = Math.min(3, Math.max(1, Math.trunc(Number(a.level)) || 1));
  if (node.type === 'taskItem') attrs.checked = a.checked === true;
  if (node.type === 'orderedList' && Number.isInteger(a.start) && (a.start as number) > 1) attrs.start = a.start;
  const content = (node.content || []).map(c => editorNode(c, depth + 1)).filter((c): c is RichTextNode => Boolean(c));
  return { type: node.type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) };
}

/**
 * The stored document reduced to what the editor knows, so it never refuses a document and opens empty
 * (which would lose the words on the next save). Unknown blocks become paragraphs of their words; unknown
 * formatting and attributes are dropped. The server cleans whatever is saved again.
 */
export const toEditorDoc = (doc?: RichTextNode): RichTextNode => {
  const content = (doc?.type === 'doc' ? doc.content || [] : doc ? [doc] : [])
    .map(n => (n?.type === 'text' || n?.type === 'hardBreak' ? { type: 'paragraph', content: [n] } : n))
    .map(n => editorNode(n as RichTextNode, 1)).filter((n): n is RichTextNode => Boolean(n));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
};

export const RichTextView: React.FC<{ doc: RichTextNode }> = ({ doc }) => <>{renderNode(doc, 'doc')}</>;

/** True when a document has no words at all (to show a "Click to write" hint). */
export const isEmptyDoc = (doc?: RichTextNode): boolean => {
  const walk = (n?: RichTextNode): boolean => !n || (n.type === 'text' ? !(n.text || '').trim() : n.type === 'horizontalRule' ? false : (n.content || []).every(walk));
  return walk(doc);
};

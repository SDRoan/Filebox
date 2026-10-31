/**
 * Boards text blocks: the only rich-text shapes File Box stores. The browser's editor (TipTap) sends
 * ProseMirror JSON; this cleans it against an allowlist before it is saved, whatever sent it. Nothing is
 * stored as HTML.
 *
 *  - Unknown blocks keep their text (as a paragraph, or as plain text inside a line); unknown formatting
 *    and unknown attributes are dropped.
 *  - Links keep only http:, https: and mailto: addresses; any other link loses its address but keeps its words.
 *  - Colours are hex only; headings are levels 1–3; alignment is left / center / right / justify.
 *  - Too large or too deep is refused (never silently cut): 51,000 characters (as people see them: an emoji is
 *    one, like every other Boards limit), 256 KB, depth 20, 5,000 blocks. The limits hold every checklist that
 *    could be saved before checklists moved into text areas (a 100-character title and 100 items of 500).
 */

const LIMITS = Object.freeze({ chars: 51000, bytes: 256 * 1024, depth: 20, nodes: 5000, linkLength: 2000 });
const charCount = (text) => Array.from(text).length;

class RichTextError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const BLOCK = ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule'];
// What each node may contain.
const CHILDREN = {
  doc: { kind: 'block', allow: BLOCK },
  paragraph: { kind: 'inline' },
  heading: { kind: 'inline' },
  codeBlock: { kind: 'plain' },
  blockquote: { kind: 'block', allow: BLOCK },
  listItem: { kind: 'block', allow: BLOCK },
  taskItem: { kind: 'block', allow: BLOCK },
  bulletList: { kind: 'list', item: 'listItem' },
  orderedList: { kind: 'list', item: 'listItem' },
  taskList: { kind: 'list', item: 'taskItem' },
  horizontalRule: { kind: 'none' },
};
const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle', 'highlight', 'subscript', 'superscript'];
const ALIGN = ['left', 'center', 'right', 'justify'];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LANGUAGE = /^[a-z0-9+#-]{1,20}$/;
const PROTOCOLS = ['http:', 'https:', 'mailto:'];
// Control characters other than tab and new line never belong in text.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

/** A link's address if it is safe to keep (http, https, mailto, well-formed, not too long); otherwise null. */
function safeHref(value) {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href || href.length > LIMITS.linkLength) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!PROTOCOLS.includes(url.protocol)) return null;
  if (url.protocol !== 'mailto:' && !url.hostname) return null;
  return url.href;
}

function cleanMarks(marks) {
  if (!Array.isArray(marks)) return undefined;
  const out = [];
  for (const m of marks) {
    if (!m || typeof m !== 'object' || !MARKS.includes(m.type) || out.some(o => o.type === m.type)) continue;
    if (m.type === 'link') {
      const href = safeHref(m.attrs?.href);
      if (href) out.push({ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow' } });
    } else if (m.type === 'textStyle') {
      const color = typeof m.attrs?.color === 'string' && HEX.test(m.attrs.color) ? m.attrs.color.toLowerCase() : null;
      if (color) out.push({ type: 'textStyle', attrs: { color } });
    } else if (m.type === 'highlight') {
      const color = typeof m.attrs?.color === 'string' && HEX.test(m.attrs.color) ? m.attrs.color.toLowerCase() : null;
      out.push(color ? { type: 'highlight', attrs: { color } } : { type: 'highlight' });
    } else {
      out.push({ type: m.type });
    }
  }
  return out.length ? out : undefined;
}

/** All the words inside any node (used when a node is not allowed where it is: its text is kept). */
function plainText(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > LIMITS.depth) return '';
  if (typeof node.text === 'string') return node.text;
  return Array.isArray(node.content) ? node.content.map(c => plainText(c, depth + 1)).join(node.type === 'hardBreak' ? '\n' : ' ').replace(/\s+/g, ' ').trim() : '';
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(CONTROL, '') : '';
}

/**
 * Clean one document. Returns { doc, chars, nodes }. Throws RichTextError when it is not a document at all,
 * or when it is too large or too deeply nested.
 */
function cleanDoc(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.type !== 'doc') throw new RichTextError('This text could not be saved.');
  let nodes = 0;
  let chars = 0;
  const count = () => { nodes += 1; if (nodes > LIMITS.nodes) throw new RichTextError('This text area is too long to save. Split it into more than one.', 413); };

  const inline = (content, depth, { marks = true } = {}) => {
    const out = [];
    for (const child of Array.isArray(content) ? content : []) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'text') {
        const text = cleanText(child.text);
        if (!text) continue;
        chars += charCount(text);
        count();
        const m = marks ? cleanMarks(child.marks) : undefined;
        out.push(m ? { type: 'text', text, marks: m } : { type: 'text', text });
      } else if (child.type === 'hardBreak' && marks) {
        count();
        out.push({ type: 'hardBreak' });
      } else {
        // Not allowed inside a line: its words are kept as plain text.
        const text = cleanText(plainText(child, depth + 1));
        if (text) { chars += charCount(text); count(); out.push({ type: 'text', text }); }
      }
    }
    return out;
  };

  const block = (node, depth) => {
    if (depth > LIMITS.depth) throw new RichTextError('This text is nested too deeply to save.');
    if (!node || typeof node !== 'object') return null;
    const rule = CHILDREN[node.type];
    if (!rule || node.type === 'doc') {
      // Unknown block: keep its words as a paragraph.
      const text = cleanText(plainText(node, depth + 1));
      if (!text) return null;
      chars += charCount(text);
      count(); count();
      return { type: 'paragraph', content: [{ type: 'text', text }] };
    }
    count();
    const out = { type: node.type };
    const align = ALIGN.includes(node.attrs?.textAlign) ? node.attrs.textAlign : null;
    if (node.type === 'paragraph') {
      if (align && align !== 'left') out.attrs = { textAlign: align };
    } else if (node.type === 'heading') {
      const level = Number.isInteger(node.attrs?.level) ? Math.min(3, Math.max(1, node.attrs.level)) : 1;
      out.attrs = { level, ...(align && align !== 'left' ? { textAlign: align } : {}) };
    } else if (node.type === 'orderedList') {
      const start = Number.isInteger(node.attrs?.start) ? Math.min(10000, Math.max(1, node.attrs.start)) : 1;
      if (start !== 1) out.attrs = { start };
    } else if (node.type === 'taskItem') {
      out.attrs = { checked: node.attrs?.checked === true };
    } else if (node.type === 'codeBlock') {
      const language = typeof node.attrs?.language === 'string' && LANGUAGE.test(node.attrs.language) ? node.attrs.language : null;
      if (language) out.attrs = { language };
    }

    if (rule.kind === 'none') return out;
    if (rule.kind === 'inline' || rule.kind === 'plain') {
      const content = inline(node.content, depth, { marks: rule.kind === 'inline' });
      if (content.length) out.content = content;
      return out;
    }
    if (rule.kind === 'list') {
      const items = [];
      for (const child of Array.isArray(node.content) ? node.content : []) {
        if (child?.type === rule.item) {
          const item = block(child, depth + 1);
          if (item) items.push(item);
        } else {
          // Anything else inside a list becomes an item holding its words.
          const text = cleanText(plainText(child, depth + 1));
          if (!text) continue;
          chars += charCount(text);
          count(); count(); count();
          items.push({ type: rule.item, ...(rule.item === 'taskItem' ? { attrs: { checked: false } } : {}), content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
        }
      }
      if (!items.length) return null;
      out.content = items;
      return out;
    }
    // A container of blocks (doc, quote, list item): loose words are wrapped in a paragraph.
    const content = [];
    for (const child of Array.isArray(node.content) ? node.content : []) {
      if (child?.type === 'text' || child?.type === 'hardBreak') {
        const line = inline([child], depth);
        if (line.length) { count(); content.push({ type: 'paragraph', content: line }); }
        continue;
      }
      const cleaned = block(child, depth + 1);
      if (cleaned) content.push(cleaned);
    }
    if (!content.length) { count(); content.push({ type: 'paragraph' }); }
    out.content = content;
    return out;
  };

  const docContent = [];
  for (const child of Array.isArray(input.content) ? input.content : []) {
    if (child?.type === 'text' || child?.type === 'hardBreak') {
      const line = inline([child], 1);
      if (line.length) { count(); docContent.push({ type: 'paragraph', content: line }); }
      continue;
    }
    const cleaned = block(child, 1);
    if (cleaned) docContent.push(cleaned);
  }
  if (!docContent.length) docContent.push({ type: 'paragraph' });
  const doc = { type: 'doc', content: docContent };
  if (chars > LIMITS.chars) throw new RichTextError(`A text area can hold up to ${LIMITS.chars.toLocaleString('en-US')} characters.`, 413);
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > LIMITS.bytes) throw new RichTextError('This text area is too large to save. Split it into more than one.', 413);
  return { doc, chars, nodes };
}

module.exports = { cleanDoc, safeHref, RichTextError, RICH_TEXT_LIMITS: LIMITS };

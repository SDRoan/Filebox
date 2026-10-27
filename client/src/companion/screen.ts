/**
 * What File Box AI "sees": a short description of what is on the person's File Box screen right now,
 * read from the page itself (headings, files and folders in view, an open preview or dialog, messages
 * shown), plus a trail of what they did recently. Only File Box is read, never other tabs or apps;
 * password fields, typed text and anything marked data-private are skipped, and the trail lives only in
 * this tab's memory. Turned off with the companion's "Screen awareness" setting.
 */

export interface ScreenGlance {
  // A file open in the preview, so "this" can mean that file.
  viewingFile?: { id?: string; name: string };
  // A problem message showing on the page.
  problem?: string;
  dialog?: string;
}

const SKIP = '.companion-panel, .companion-launcher, [data-private], script, style, noscript, svg';
const MAX_TEXT = 3200;
const clean = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim();

function isVisible(el: Element) {
  if (el.closest(SKIP)) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

const visibleAll = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll(selector)).filter(isVisible);

/** Readable text shown inside an element (only what is in view), up to `limit` characters. */
function visibleText(root: Element, limit: number) {
  const parts: string[] = [];
  let length = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || !clean(node.textContent) || parent.closest('input, textarea, select, [contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
      return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode() && length < limit) {
    const text = clean(walker.currentNode.textContent);
    if (parts[parts.length - 1] === text) continue;
    parts.push(text);
    length += text.length + 1;
  }
  return parts.join(' · ').slice(0, limit);
}

// The topmost open dialog: a file preview, a File Box dialog, or a review panel.
function openDialog() {
  const dialogs = visibleAll(document, '.file-preview-overlay, .modal-overlay, .ai-panel-backdrop, [role="dialog"]')
    .filter(el => !el.closest('.companion-panel'));
  return dialogs[dialogs.length - 1] || null;
}

export function glance(): ScreenGlance {
  const dialog = openDialog();
  const preview = dialog?.matches('.file-preview-overlay') ? dialog : null;
  const name = preview ? clean(preview.querySelector('.file-preview-title h3')?.textContent) : '';
  const problem = visibleAll(document, '[role="alert"], .overview-error, .error-message, .file-board-status')
    .map(el => clean(el.textContent)).find(Boolean);
  return {
    viewingFile: name ? { id: preview?.querySelector<HTMLElement>('[data-file-id]')?.dataset.fileId, name } : undefined,
    problem: problem?.slice(0, 200),
    dialog: dialog && !preview ? clean(dialog.querySelector('h1, h2, h3')?.textContent).slice(0, 80) || undefined : undefined,
  };
}

/** A description of the File Box screen for File Box AI (a few short lines). */
export function readScreen(): string {
  const lines: string[] = [];
  const main = document.querySelector('.dashboard-content');
  const dialog = openDialog();

  if (dialog?.matches('.file-preview-overlay')) {
    const name = clean(dialog.querySelector('.file-preview-title h3')?.textContent);
    const details = clean(dialog.querySelector('.file-preview-size')?.textContent);
    lines.push(`They have the file "${name}"${details ? ` (${details})` : ''} open in the preview.`);
    const content = dialog.querySelector('.file-preview-content');
    const shown = content ? visibleText(content, 1200) : '';
    if (shown) lines.push(`Text visible in the preview: ${shown}`);
  } else if (dialog) {
    const title = clean(dialog.querySelector('h1, h2, h3')?.textContent);
    lines.push(`A window is open${title ? ` titled "${title}"` : ''}: ${visibleText(dialog, 700)}`);
  }

  if (main) {
    const heading = clean(visibleAll(main, 'h1')[0]?.textContent);
    if (heading) lines.push(`Page heading: ${heading}.`);
    const view = clean(visibleAll(main, '.view-btn.active')[0]?.getAttribute('aria-label'));
    const filter = clean(visibleAll(main, '.file-type-filter.active')[0]?.textContent);
    if (view || filter) lines.push(`Showing ${filter || 'all files'}${view ? ` in ${view.split(':')[0]}` : ''}.`);
    const folders = visibleAll(main, '.folder-item .folder-name').map(el => clean(el.textContent)).filter(Boolean);
    const files = visibleAll(main, '.file-item .file-name, .file-row-name').map(el => clean(el.textContent)).filter(Boolean);
    // Shown as cards or rows on the page; being listed does not mean they opened it.
    if (folders.length) lines.push(`Folders listed on the page (not opened): ${folders.slice(0, 20).join(', ')}${folders.length > 20 ? ` and ${folders.length - 20} more` : ''}.`);
    if (files.length) lines.push(`Files listed on the page: ${Array.from(new Set(files)).slice(0, 30).join(', ')}${files.length > 30 ? ` and ${files.length - 30} more` : ''}.`);
    const zones = visibleAll(main, '.board-zone').map(el => el.getAttribute('aria-label')).filter(Boolean);
    if (zones.length) lines.push(`Board zones: ${zones.join('; ')}.`);
    const selected = clean(visibleAll(main, '.selection-count')[0]?.textContent);
    if (selected) lines.push(`Selection: ${selected}.`);
    const problems = visibleAll(document, '[role="alert"], .overview-error, .error-message').map(el => clean(el.textContent)).filter(Boolean);
    if (problems.length) lines.push(`Message on screen: ${problems.slice(0, 2).join(' / ')}`);
    // Anything else on the page that is readable (settings, cards, summaries…).
    if (!dialog || !dialog.matches('.file-preview-overlay')) {
      const rest = visibleText(main, 900);
      if (rest) lines.push(`Other text on the page: ${rest}`);
    }
  }
  return lines.join('\n').slice(0, MAX_TEXT);
}

// ---------- What they did recently (this tab only)

interface Moment { at: number; what: string }
const trail: Moment[] = [];
const MAX_MOMENTS = 20;
let watching = false;

export function noteActivity(what: string) {
  const text = clean(what).slice(0, 120);
  if (!text || trail[trail.length - 1]?.what === text) return;
  trail.push({ at: Date.now(), what: text });
  if (trail.length > MAX_MOMENTS) trail.shift();
}

// Clicks on buttons, links, tabs and file cards (by their visible name), and previews being opened.
export function startWatching() {
  if (watching) return;
  watching = true;
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target || target.closest(SKIP)) return;
    const card = target.closest('.file-item, .folder-item');
    const control = target.closest('button, a, [role="tab"], [role="menuitem"], summary');
    if (control && !control.closest('.file-item, .folder-item')) {
      const label = clean(control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent).slice(0, 60);
      if (label) noteActivity(`Clicked "${label}"`);
    } else if (card) {
      const name = clean(card.querySelector('.file-name, .folder-name')?.textContent);
      const action = control ? clean(control.getAttribute('title') || control.getAttribute('aria-label') || control.textContent).slice(0, 40) : '';
      if (name) noteActivity(action ? `${action} on "${name}"` : `Clicked ${card.classList.contains('folder-item') ? 'folder' : 'file'} "${name}"`);
    }
  }, true);
  // A preview or dialog appearing.
  // Checked at most twice a second, since the page changes constantly (for example while answers stream in).
  let lastDialog = '';
  let pending: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const now = glance();
      const key = now.viewingFile ? `preview:${now.viewingFile.name}` : now.dialog ? `dialog:${now.dialog}` : '';
      if (key && key !== lastDialog) noteActivity(now.viewingFile ? `Opened the preview of "${now.viewingFile.name}"` : `Opened "${now.dialog}"`);
      lastDialog = key;
    }, 500);
  }).observe(document.body, { childList: true, subtree: true });
}

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function recentActivity(): string {
  const now = Date.now();
  return trail.slice(-12).map(m => `- ${ago(now - m.at)}: ${m.what}`).join('\n');
}

/** Everything File Box AI should know about the screen, for one question. */
export function screenContext(): string {
  const screen = readScreen();
  const recent = recentActivity();
  return [
    screen && `What is on their File Box screen right now:\n${screen}`,
    recent && `What they did recently in File Box (oldest first):\n${recent}`,
  ].filter(Boolean).join('\n\n');
}

// ---------- When a question is about what is on the screen (Ask File Box screen awareness)

// "What is this?", "explain this part", "what should I do here?", "can you see this?", "look at this"…
const SCREEN_QUESTION = /\b(?:what(?:'s| is| are) (?:this|that|these|those|here|on (?:the |my )?screen|happening(?: here)?|visible(?: here)?|going on)|what am i (?:looking at|seeing|viewing)|what (?:does|do) (?:this|that|it|these) (?:say|mean|show|do)|what should i do(?: here)?|explain (?:this|that|it|the screen|this screen|this (?:part|page|section|chart|graph|diagram|table|image|picture|option|dialog|window|number)|what i'?m (?:looking at|seeing))|(?:can|do) you see (?:this|that|it|my screen)|look at (?:this|that|my screen|the screen)|what (?:is|are) the (?:important|main|key) (?:part|thing|point)s? here|why is (?:this|that) (?:number )?(?:so )?(?:high|low|big|large|small|red|empty)|which of these|this (?:part|section|chart|graph|diagram|figure|table|option|button|number|page)|what do you see|\w+ (?:do|can) you see|(?:on|of|in) (?:this|the|my) screen|this screen|what (?:text|words?) (?:is|are) (?:visible|shown|here|on (?:it|this|the screen))|why does (?:it|file box) (?:want|suggest|say)|what is (?:file box )?suggesting|what does (?:it|file box) (?:suggest|want))\b/i;

// Questions that need to see how something looks, not only read its words.
const VISUAL_QUESTION = /\b(?:chart|graph|diagram|figure|plot|table|picture|image|photo|drawing|illustration|logo|icon|color|colou?r|blue|red|green|yellow|orange|purple|black|white|grey|gray|left|right|top|bottom|corner|layout|looks?|see|visible|scan(?:ned)?|handwrit\w*)\b/i;

// A short follow-up about the same view ("what about the blue part?", "and the second one?").
const SCREEN_FOLLOW_UP = /^(?:and |so |ok(?:ay)?,? )?(?:what about|how about|and|what is|what's|why|where|which|explain) (?:the |that |this )?(?:\w+ ){0,3}(?:part|one|bar|line|box|section|bit|side|number|thing|area|row|column)s?\b|^(?:what about|and) (?:the |that )/i;

export const isScreenQuestion = (question: string) => SCREEN_QUESTION.test(question.trim());
export const isVisualQuestion = (question: string) => VISUAL_QUESTION.test(question);
export const isScreenFollowUp = (question: string) => SCREEN_FOLLOW_UP.test(question.trim());

/** The open dialog's title (for the screen fingerprint and the indicator). */
export function openDialogTitle(): string {
  const dialog = openDialog();
  if (!dialog || dialog.matches('.file-preview-overlay')) return '';
  return clean(dialog.querySelector('h1, h2, h3')?.textContent).slice(0, 80);
}

const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

/**
 * Changes whenever what is on the screen changes in a way that matters: the file, folder or selection
 * (focusKey), the PDF page, the open dialog, the page itself, or what is written on it. An image or
 * answer about the screen is only reused while this stays the same.
 */
export function screenFingerprint(focusKey: string, pdfPage?: number): string {
  const visible = readScreen();
  return [window.location.pathname, focusKey, pdfPage || '', openDialogTitle(), hash(visible)].join('|');
}

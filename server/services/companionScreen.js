const fs = require('fs-extra');
const { PDFParse } = require('pdf-parse');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { fileById } = require('./fileResolver');

/**
 * Ask File Box screen awareness: answering a question about what is visible right now. Called only from
 * the File Box AI chat, for questions the page marked as being about the screen. The structured focus
 * (the file id, already access-checked here) decides which file a question is about; what is visible
 * only helps explain it. Sources, cheapest first:
 *  - an open PDF: that page's text, and a render of that one page only when it is visual or has little text
 *  - an open picture: the original file (vision), or the stored text extraction for "what text is visible?"
 *  - anything else: the words on the File Box screen, and a screenshot only when the page sent one
 * Screenshots and page renders exist only in memory for this request; nothing is stored or logged.
 */

const VISUAL = /\b(?:chart|graph|diagram|figure|plot|table|picture|image|photo|drawing|illustration|logo|icon|colou?r|blue|red|green|yellow|orange|purple|black|white|grey|gray|left|right|top|bottom|corner|layout|looks?|see|visible|scan(?:ned)?|handwrit\w*)\b/i;
const READ_TEXT = /\b(?:read|extract|copy|transcribe|get)\b.{0,20}\btext\b|\bwhat (?:text|words?)\b|\btext (?:is )?(?:visible|written|shown)\b|\bwhat does (?:it|this) say\b/i;
const MIN_PAGE_TEXT = 200;

const SCREEN_RULES = `Explain what is there in plain words, focused on what they asked.
Never claim you clicked, opened or changed anything; you only see the screen.
Do not guess file names, ids or numbers you cannot read. If something is unclear or too small to read, say so.
For choices that delete, remove, replace or restore something, explain the options but leave the decision to them.`;

const voice = (persona) => [persona?.intro || 'You are File Box AI, a companion inside File Box, a file storage app.', persona?.tone || ''].filter(Boolean).join('\n');

async function visionStatus() {
  const health = await ollamaClient.health();
  return { reachable: health.reachable, vision: Boolean(health.reachable && health.visionModelAvailable) };
}

/** One page of a PDF: its text, and (when asked) a picture of that page. */
async function pdfPage(filePath, page, { render = false } = {}) {
  const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(filePath)) });
  try {
    const text = await parser.getText({ partial: [page] });
    const result = { total: text.total, text: (text.pages?.[0]?.text || '').trim() };
    if (render) {
      const shot = await parser.getScreenshot({ partial: [page], scale: 1.6, imageBuffer: true });
      const png = shot.pages?.[0]?.data;
      if (png) result.image = Buffer.from(png).toString('base64');
    }
    return result;
  } finally {
    await parser.destroy();
  }
}

async function textAnswer({ system, content, context, onToken }) {
  const { text } = await ollamaClient.generate({ task: 'answer', model: config.ollama.assistantModel, system, content, context, onToken });
  return text.trim();
}

/**
 * The vision model sometimes loops on a list it reads from the screen ("My Files", "My Files", …).
 * An item repeated back to back is kept once; if the answer was cut off inside such a loop, it ends there.
 */
function collapseRepeats(text) {
  const parts = text.split(/(?<=[,;\n])\s*/);
  const kept = [];
  let looped = false;
  for (const part of parts) {
    const key = part.replace(/[\s,;."'“”]+/g, ' ').trim().toLowerCase();
    const previous = kept.length ? kept[kept.length - 1].replace(/[\s,;."'“”]+/g, ' ').trim().toLowerCase() : '';
    if (key && key === previous) { looped = true; continue; }
    if (looped && kept.filter(k => k.replace(/[\s,;."'“”]+/g, ' ').trim().toLowerCase() === key).length >= 1) continue;
    kept.push(part);
  }
  // A last piece cut off inside the loop ("My Fi") is dropped when it only starts an item already listed.
  const norm = (t) => t.replace(/[\s,;."'“”…]+/g, ' ').trim().toLowerCase();
  if (looped && kept.length > 1) {
    const tail = norm(kept[kept.length - 1]);
    if (tail && kept.slice(0, -1).some(k => norm(k).startsWith(tail) && norm(k) !== tail)) kept.pop();
  }
  const out = kept.join(' ').replace(/\s+([,;.])/g, '$1').replace(/[,;]\s*$/, '').trim();
  return looped && !/[.!?]$/.test(out) ? `${out}…` : out;
}

async function visionAnswer({ system, content, image, onToken }) {
  const { text } = await ollamaClient.generate({ task: 'look', model: config.ollama.visionModel, keepAlive: '2m', system, content, images: [image], onToken });
  return collapseRepeats(text.trim());
}

// The vision model can take minutes on a busy laptop; past its time limit the answer comes from the words instead.
const tooSlow = (error) => /timeout|timed out/i.test(error?.message || '');
const SLOW_NOTE = 'Looking at the screen took too long on this computer, so this answer is based on what is written on it:\n\n';

/**
 * Returns { answer, source, page?, totalPages?, fileId? }. `screen` is the page's description of this
 * question's view: { kind: 'pdf' | 'image' | 'ui', pdfPage?, image?, captureFailed? }.
 */
async function answerScreenQuestion({ userId, question, fileId, screen, context, persona, onToken, assistant }) {
  const status = await visionStatus();
  if (!status.reachable) {
    return { answer: 'File Box AI is offline. Start Ollama on your computer to ask about the screen.', source: 'offline' };
  }
  const visionOff = 'I can still use the File Box context, but screen understanding is unavailable while the local vision model is offline.';

  // ---- An open PDF: the visible page
  if (screen.kind === 'pdf' && fileId) {
    const file = await fileById(userId, fileId, { level: 'viewer' });
    if (!file) return { answer: 'This file is no longer available.', source: 'none' };
    const filePath = await assistant.resolveFilePath(file);
    let page = Math.max(1, Math.floor(Number(screen.pdfPage) || 1));
    const probe = await pdfPage(filePath, page);
    page = Math.min(page, probe.total || page);
    const thin = probe.text.replace(/\s+/g, '').length < MIN_PAGE_TEXT;
    const needsLook = thin || VISUAL.test(question);
    const about = `They are looking at page ${page} of ${probe.total} of the PDF "${file.originalName}" in File Box.`;
    const pageText = probe.text.slice(0, 6000);
    if (needsLook && status.vision) {
      const { image } = await pdfPage(filePath, page, { render: true });
      if (image) {
        try {
          const answer = await visionAnswer({
            system: `${voice(persona)}\n${about}\nThe image is that page exactly as it appears in the PDF.\n${SCREEN_RULES}`,
            content: `${pageText ? `Text on this page (from the PDF itself):\n${pageText.slice(0, 3000)}\n\n` : ''}Question about this page: ${question}`,
            image,
            onToken,
          });
          return { answer, source: 'pdf-page-render', page, totalPages: probe.total, fileId: file._id };
        } catch (error) {
          if (!tooSlow(error) || !pageText) throw error;
          const answer = await textAnswer({ system: `${voice(persona)}\n${about}\nAnswer about THIS page only from its text.\n${SCREEN_RULES}`, content: `Question about this page: ${question}\n\nText of page ${page}:\n{{CONTEXT}}`, context: pageText });
          return { answer: SLOW_NOTE + answer, source: 'pdf-text', page, totalPages: probe.total, fileId: file._id };
        }
      }
    }
    const note = needsLook && !status.vision && thin ? `${visionOff}\n\n` : '';
    if (!pageText) return { answer: `${note}Page ${page} has no text I can read${status.vision ? '' : ', and screen understanding is unavailable right now'}.`, source: 'pdf-text', page, totalPages: probe.total, fileId: file._id };
    const answer = await textAnswer({
      system: `${voice(persona)}\n${about}\nAnswer about THIS page only (not the whole document) from the page text given.\n${SCREEN_RULES}`,
      content: `Question about this page: ${question}\n\nText of page ${page}:\n{{CONTEXT}}`,
      context: pageText,
      onToken,
    });
    return { answer: note + answer, source: 'pdf-text', page, totalPages: probe.total, fileId: file._id };
  }

  // ---- An open picture: the original file
  if (screen.kind === 'image' && fileId) {
    const file = await fileById(userId, fileId, { level: 'viewer' });
    if (!file) return { answer: 'This file is no longer available.', source: 'none' };
    if (READ_TEXT.test(question)) {
      const result = await require('./fileAIActions').runAction(file, 'extract_text');
      const text = /^No readable text was found/i.test(result.result) ? '' : result.result.trim();
      return { answer: text ? `Here's the text visible in "${file.originalName}":\n\n${text}` : `I couldn't find any text in "${file.originalName}".`, source: 'ocr', fileId: file._id };
    }
    if (!status.vision) return { answer: visionOff, source: 'none', fileId: file._id };
    const { lookAtPicture } = require('./companionVision');
    return { answer: await lookAtPicture(file, question, persona), source: 'original-image', fileId: file._id };
  }

  // ---- The File Box interface: its words, and a screenshot only when the page sent one
  const where = `File Box context (from the app itself):\n${context || 'No details.'}`;
  let slow = false;
  if (screen.image && status.vision) {
    try {
      const answer = await visionAnswer({
        system: `${voice(persona)}\nYou are looking at the person's current File Box screen. The image shows only the visible File Box application area (not the browser or other apps).\n${SCREEN_RULES}`,
        content: `${where.slice(0, 3500)}\n\nQuestion about the screen: ${question}`,
        image: screen.image,
        onToken,
      });
      return { answer, source: 'screenshot' };
    } catch (error) {
      if (!tooSlow(error)) throw error;
      slow = true;
    }
  }
  const prefix = slow ? SLOW_NOTE : screen.captureFailed ? "I'm having trouble reading the current screen. I can still use the file and page context.\n\n"
    : screen.image && !status.vision ? `${visionOff}\n\n` : '';
  const answer = await textAnswer({
    system: `${voice(persona)}\nThey are asking about what is on their File Box screen right now. You get the words on the screen and the File Box context; answer from those.\nIf a window or dialog is open ("A window is open titled …"), the question is about that window: say which window it is and explain its options first, then anything else.\n${SCREEN_RULES}`,
    content: `Question about the screen: ${question}\n\n{{CONTEXT}}`,
    context: where,
    onToken,
  });
  return { answer: prefix + answer, source: 'dom-text' };
}

module.exports = { answerScreenQuestion };

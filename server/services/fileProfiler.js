const File = require('../models/File');
const FileContent = require('../models/FileContent');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { indexFile, needsIndex, removeOrphans } = require('./fileIndex');

/**
 * File Box AI reads each file's text once per version and notes what it is: a broad category
 * (homework, transcript, bill, certificate, ...), a specific kind, a short description and key facts
 * (amount due, due date, issuer, course, grade, ...). It also cuts the text into searchable passages
 * (fileIndex) so questions can be answered from the right part of the file.
 * Runs in the background, only while Ollama is reachable and nobody is using File Box AI.
 */

const PROFILE_VERSION = 3;
const BATCH = 1;
// Ollama answers one request at a time and keeps only the latest prompt cached, so the profiler waits until
// File Box AI has been idle for 2 minutes: reading a file in between questions would make the next one slow.
const QUIET_MS = 2 * 60 * 1000;
const INTERVAL_MS = 30 * 1000;
const HEAD_CHARS = 2500;
const SAMPLE_CHARS = 700;
const CATEGORIES = [
  'homework or assignment', 'lecture or study notes', 'exam or quiz', 'transcript or grades', 'certificate or diploma',
  'resume or cv', 'cover letter', 'bill', 'invoice', 'receipt', 'bank or card statement', 'tax document', 'pay stub',
  'contract or agreement', 'letter or email', 'report', 'work document', 'meeting notes', 'presentation',
  'spreadsheet or data', 'form or application', 'id or personal document', 'ticket or booking', 'medical document',
  'insurance document', 'manual or guide', 'article or paper', 'book or ebook', 'source code', 'notes or list', 'other',
];

let lastActivity = 0;
let running = false;
let timer = null;
let ticks = 0;

/** Called when File Box AI serves a request, so background work stays out of its way. */
const noteActivity = () => { lastActivity = Date.now(); };

/** The text File Box embeds for a file: what it is first, then its name, description and facts. */
const profileDocument = ({ name, aiType, aiCategory, aiDescription, aiFacts }) => {
  const facts = (aiFacts || []).map(f => `${f.label}: ${f.value}`).join('; ');
  return `search_document: ${[aiCategory, aiType].filter(Boolean).join(', ')}. ${name}. ${aiDescription || ''} ${facts}`.trim();
};
const textDocument = ({ name, text }) => `search_document: ${name}. ${(text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`.trim();

/** The beginning of the text plus samples from the middle and end, so long files are read fairly. */
function sampleText(text) {
  if (text.length <= HEAD_CHARS + 2 * SAMPLE_CHARS) return text;
  const middle = Math.floor(text.length / 2);
  return [
    text.slice(0, HEAD_CHARS),
    `[...middle of the file...]\n${text.slice(middle, middle + SAMPLE_CHARS)}`,
    `[...end of the file...]\n${text.slice(-SAMPLE_CHARS)}`,
  ].join('\n\n');
}

async function profileFile(file, fileContent, { background = false } = {}) {
  const text = (fileContent?.extractedText || '').trim();
  if (text.length < 20) return null;

  const raw = await ollamaClient.chat({
    background,
    task: 'extract',
    model: config.ollama.assistantModel,
    system: `You read files for a personal file storage app and note what each file is.
Read the file name and its text, then return JSON with:
- "category": the one broad category that fits best, from: ${CATEGORIES.join('; ')}
- "type": what this file is, in 1-4 lowercase words (for example: calculus homework, electricity bill, official transcript, AWS certificate, offer letter)
- "description": one or two plain sentences saying what this specific file is about
- "facts": up to 6 key facts written in the file that someone might ask about later, each {"label", "value"}, copied exactly (for example: amount due, due date, issuer, account holder, course, grade, GPA, issue date, expiry date, total, institution, employer, deadline). Only facts stated in the text; an empty list if none.
A student's own submitted work (essays, writing assignments, problem sets, lab reports) is "homework or assignment".
Describe what the file is, not topics it merely mentions.`,
    content: `File name: ${file.originalName}\n\nText:`,
    context: sampleText(text),
    format: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORIES },
        type: { type: 'string' },
        description: { type: 'string' },
        facts: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } },
      },
      required: ['category', 'type', 'description', 'facts'],
    },
  });

  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const aiType = clean(parsed.type, 50).toLowerCase();
  if (!aiType) return null;
  const profile = {
    aiType,
    aiCategory: CATEGORIES.includes(parsed.category) ? parsed.category : 'other',
    aiDescription: clean(parsed.description, 300),
    aiFacts: (Array.isArray(parsed.facts) ? parsed.facts : [])
      .map(f => ({ label: clean(f?.label, 40), value: clean(f?.value, 120) }))
      .filter(f => f.label && f.value)
      .slice(0, 6),
  };

  let embedding;
  try {
    [embedding] = await ollamaClient.embed([profileDocument({ name: file.originalName, ...profile })], { background });
  } catch (error) {
    embedding = undefined; // matching falls back to name and text until the next profile
  }
  await FileContent.updateOne(
    { _id: fileContent._id },
    {
      $set: {
        ...profile,
        aiProfiledAt: new Date(),
        aiProfileModel: config.ollama.assistantModel,
        aiProfileVersion: PROFILE_VERSION,
        ...(embedding ? { aiEmbedding: embedding, aiEmbeddingSource: 'profile' } : {}),
      },
    }
  );
  return profile;
}

/** Profile and index a file whose text is new, changed, or read by an older version of File Box. */
async function runOnce() {
  const lastBusy = Math.max(lastActivity, ollamaClient.lastForegroundAt());
  if (running || Date.now() - lastBusy < QUIET_MS) return 0;
  running = true;
  try {
    const health = await ollamaClient.health();
    if (!health.reachable || !health.assistantModelAvailable) return 0;
    ticks += 1;
    if (ticks % 20 === 0) await removeOrphans();

    const pending = await FileContent.find({
      extractionStatus: 'completed',
      extractedText: { $nin: ['', null] },
      $or: [
        { aiProfiledAt: { $exists: false } },
        { aiProfiledAt: null },
        { aiProfileVersion: { $lt: PROFILE_VERSION } },
        { $expr: { $lt: ['$aiProfiledAt', '$extractedAt'] } },
      ],
    }).sort({ updatedAt: -1 }).limit(BATCH);

    let done = 0;
    for (const fileContent of pending) {
      const file = await File.findById(fileContent.file).select('originalName isTrashed').lean();
      if (!file) continue;
      try {
        if (!(await profileFile(file, fileContent, { background: true }))) {
          await FileContent.updateOne({ _id: fileContent._id }, { $set: { aiProfiledAt: new Date(), aiProfileVersion: PROFILE_VERSION } });
        }
        if (health.embeddingModelAvailable && await needsIndex(fileContent)) await indexFile(file, fileContent, { background: true });
        done += 1;
      } catch (error) {
        // Paused because the user asked something; this file is read again on a later pass.
        if (error.code !== 'YIELDED') console.error('[File profile] Could not read file:', error.message);
        return done;
      }
    }

    // Files already profiled whose passages are missing (for example, profiled before passages existed).
    if (!done && health.embeddingModelAvailable) {
      const candidates = await FileContent.find({ extractionStatus: 'completed', extractedText: { $nin: ['', null] }, aiProfileVersion: PROFILE_VERSION })
        .select('file extractedText extractedAt').sort({ updatedAt: -1 }).limit(20);
      for (const fileContent of candidates) {
        if (!(await needsIndex(fileContent))) continue;
        const file = await File.findById(fileContent.file).select('originalName').lean();
        if (file) await indexFile(file, fileContent, { background: true });
        break;
      }
    }
    return done;
  } finally {
    running = false;
  }
}

function start() {
  if (process.env.FILEBOX_AI_PROFILER === 'off' || timer) return;
  timer = setInterval(() => runOnce().catch(() => {}), INTERVAL_MS);
  setTimeout(() => runOnce().catch(() => {}), 5000);
}

module.exports = { profileFile, runOnce, start, noteActivity, profileDocument, textDocument, PROFILE_VERSION };

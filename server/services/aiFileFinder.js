const File = require('../models/File');
const FileContent = require('../models/FileContent');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { readableFileFilter } = require('./permissions');
const { cleanPhrase, phraseWords, describeFile, compareChoices } = require('./fileResolver');
const { profileDocument, textDocument } = require('./fileProfiler');

/**
 * Finds the file(s) a user means ("my resume", "the old report") by meaning.
 *
 * 1. Every file the user may access is scored against the request with the local embedding model,
 *    using File Box's note on what the file is (fileProfiler) or, until it has one, its name and
 *    opening text.
 * 2. One clear winner is the answer. When several are close, the language model judges the top few.
 * Code never picks among the matches: the caller proceeds on one, asks on several, and says so on none.
 */

const MAX_FILES = 2000;
const JUDGE_TOP = 5;
// Tuned on real requests with nomic-embed-text. A clear winner scores high and well ahead of the rest;
// files far below are not worth judging.
const CLEAR_SCORE = 0.68;
const CLEAR_MARGIN = 0.12;
const MIN_SCORE = 0.35;
const MAX_CHOICES = 8;

const nameVectors = new Map(); // vectors for files without a FileContent record (e.g. not extracted yet)

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

async function scopeFilter(userId, { level, trashed }) {
  if (trashed) return { owner: userId, isTrashed: true };
  if (level === 'owner') return { owner: userId, isTrashed: { $ne: true } };
  return readableFileFilter(userId);
}

const norm = (value = '') => value.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (name = '') => name.replace(/\.[a-z0-9]{1,6}$/i, '');
const singular = (word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

/**
 * Files whose name is what the user typed: the exact name, the name without its extension, or a name
 * containing every word they typed. Several such files are a real choice for the user, not for the model.
 */
function namedFiles(files, phrase) {
  const wanted = norm(phrase);
  const exact = files.filter(file => norm(file.originalName) === wanted);
  if (exact.length) return exact;
  const byStem = files.filter(file => norm(stem(file.originalName)) === wanted);
  if (byStem.length) return byStem;
  const words = phraseWords(phrase).map(singular);
  if (!words.length) return [];
  return files.filter((file) => {
    const name = norm(file.originalName);
    return words.every(word => name.includes(word));
  });
}

/** Which files File Box has read (profile-based vector) and which only have a name/text vector so far. */
async function profiledIds(files) {
  const rows = await FileContent.find({ file: { $in: files.map(f => f._id) }, aiEmbeddingSource: 'profile' }).select('file').lean();
  return new Set(rows.map(r => r.file.toString()));
}

/** A meaning vector for every file, computing (and saving) the ones that are missing. */
async function vectorsFor(files) {
  const contents = await FileContent.find({ file: { $in: files.map(f => f._id) } })
    .select('file aiEmbedding aiType aiCategory aiDescription aiFacts')
    .lean();
  const byFile = new Map(contents.map(c => [c.file.toString(), c]));
  const vectors = new Map();
  const missing = [];
  for (const file of files) {
    const id = file._id.toString();
    const content = byFile.get(id);
    if (content?.aiEmbedding?.length) vectors.set(id, content.aiEmbedding);
    else missing.push({ file, content });
  }
  if (!missing.length) return vectors;

  // Files not embedded yet: use the profile if there is one, else the name and opening text.
  const needText = missing.filter(m => m.content && !m.content.aiType).map(m => m.file._id);
  const texts = new Map((await FileContent.find({ file: { $in: needText } }).select('file extractedText').lean())
    .map(c => [c.file.toString(), c.extractedText || '']));
  const docs = missing.map(({ file, content }) => (content?.aiType
    ? profileDocument({ name: file.originalName, ...content })
    : textDocument({ name: file.originalName, text: texts.get(file._id.toString()) })));
  const keys = missing.map(({ file }, i) => `${file._id}:${docs[i]}`);
  const todo = missing.map((m, i) => i).filter(i => !nameVectors.has(keys[i]));
  const computed = await ollamaClient.embed(todo.map(i => docs[i]));
  const fresh = new Map(todo.map((i, k) => [i, computed[k]]));

  const saves = [];
  missing.forEach(({ file, content }, i) => {
    const vector = fresh.get(i) || nameVectors.get(keys[i]);
    vectors.set(file._id.toString(), vector);
    if (content) {
      saves.push({ updateOne: { filter: { _id: content._id }, update: { $set: { aiEmbedding: vector, aiEmbeddingSource: content.aiType ? 'profile' : 'text' } } } });
    } else {
      nameVectors.set(keys[i], vector);
    }
  });
  if (saves.length) await FileContent.bulkWrite(saves);
  return vectors;
}

/** Ask the language model which of a few close candidates are what the user is looking for. */
async function judge(request, candidates, { model = config.ollama.plannerModel } = {}) {
  const contents = await FileContent.find({ file: { $in: candidates.map(f => f._id) } }).select('file aiType aiCategory aiDescription aiFacts extractedText').lean();
  const byFile = new Map(contents.map(c => [c.file.toString(), c]));
  const list = candidates.map((file, index) => {
    const content = byFile.get(file._id.toString()) || {};
    return {
      n: index + 1,
      name: file.originalName,
      kind: [content.aiCategory, content.aiType].filter(Boolean).join(', ') || file.mimeType,
      about: content.aiDescription || '',
      facts: (content.aiFacts || []).map(f => `${f.label}: ${f.value}`).join('; ') || undefined,
      // Opening text only helps when File Box has no description of the file yet.
      starts: content.aiType ? undefined : (content.extractedText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  });

  const raw = await ollamaClient.chat({
    task: 'classify',
    model,
    system: `You help a person find files in their own drive. You get what they are looking for and a numbered list of their files (name, kind, short description).
First write "wanted": the kind of file they want in a few words. Then for EVERY file give "match".
Decide by what the file IS (its name and kind): a list of startup ideas that mentions invoices is not an invoice.
Use the description to decide only when they ask for files about a topic ("something about X", "notes on X"); then a file mainly about that topic matches.
Be strict: if you are not sure, answer false. If they gave a file name, only files with that name (or nearly that name) match.`,
    content: JSON.stringify({ lookingFor: request, files: list }),
    format: {
      type: 'object',
      properties: {
        wanted: { type: 'string' },
        verdicts: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, match: { type: 'boolean' } }, required: ['n', 'match'] } },
      },
      required: ['wanted', 'verdicts'],
    },
  });

  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { verdicts: [] }; }
  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  return [...new Set(verdicts
    .filter(v => v && v.match === true && Number.isInteger(v.n) && v.n >= 1 && v.n <= candidates.length)
    .map(v => v.n - 1))];
}

/** Files scored by how close their meaning is to the text, best first. */
async function scoreByMeaning(text, files) {
  const vectors = await vectorsFor(files);
  const [query] = await ollamaClient.embed([`search_query: ${text}`]);
  return files
    .map(file => ({ file, score: cosine(query, vectors.get(file._id.toString()) || []) }))
    .sort((a, b) => b.score - a.score || a.file.originalName.localeCompare(b.file.originalName) || a.file._id.toString().localeCompare(b.file._id.toString()));
}

/** The files a question is most likely about, among those the user may read. */
async function rankReadableFiles(userId, question, { limit = 8 } = {}) {
  const files = await File.find(await readableFileFilter(userId)).sort({ originalName: 1, _id: 1 }).limit(MAX_FILES);
  if (!files.length) return [];
  return (await scoreByMeaning(question, files)).slice(0, limit);
}

/** Rank files by meaning and decide which ones the user means. */
async function matchByMeaning(phrase, files) {
  const scored = await scoreByMeaning(phrase, files);

  // A clear winner needs no judging, but only when File Box has read that file: a vector built from raw
  // text can favour a file that merely mentions the words.
  const [top, second] = scored;
  if (top && top.score >= CLEAR_SCORE && (!second || top.score - second.score >= CLEAR_MARGIN)
    && (await profiledIds([top.file])).has(top.file._id.toString())) return [top.file];
  const close = scored.slice(0, JUDGE_TOP).filter(s => s.score >= MIN_SCORE).map(s => s.file);
  if (!close.length) return [];
  return (await judge(phrase, close)).map(i => close[i]);
}

/**
 * Returns { status: 'one' | 'many' | 'none', files, choices, more, phrase, otherAccess? }.
 * level 'owner' for changes, 'viewer' for reading; trashed for restore.
 */
async function findFiles(userId, request, { level = 'viewer', trashed = false } = {}) {
  const phrase = cleanPhrase(request);
  const files = phrase
    ? await File.find(await scopeFilter(userId, { level, trashed })).sort({ originalName: 1, _id: 1 }).limit(MAX_FILES)
    : [];

  // Files named what the user typed need no judgement (several of them become a question for the user).
  const named = namedFiles(files, phrase);
  const matched = named.length ? named : (files.length ? await matchByMeaning(phrase, files) : []);

  const cache = new Map();
  const described = [];
  for (const file of matched) {
    const choice = await describeFile(file, userId, cache);
    if (choice) described.push({ file, choice });
  }
  described.sort((a, b) => compareChoices(a.choice, b.choice));

  if (described.length === 1) return { status: 'one', phrase, files: [described[0].file], choices: [described[0].choice] };
  if (described.length > 1) {
    return {
      status: 'many',
      phrase,
      files: described.map(d => d.file),
      choices: described.slice(0, MAX_CHOICES).map(d => d.choice),
      more: Math.max(0, described.length - MAX_CHOICES),
    };
  }

  // Nothing of theirs for a change: mention a readable match they may not change.
  if (level === 'owner' && !trashed) {
    const readable = await findFiles(userId, request, { level: 'viewer' });
    if (readable.status !== 'none') return { status: 'none', phrase, files: [], choices: [], otherAccess: readable.choices[0] };
  }
  return { status: 'none', phrase, files: [], choices: [] };
}

module.exports = { findFiles, rankReadableFiles, judge };

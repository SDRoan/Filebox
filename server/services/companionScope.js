const File = require('../models/File');
const Folder = require('../models/Folder');
const FileContent = require('../models/FileContent');
const FileSummary = require('../models/FileSummary');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { readableFileFilter } = require('./permissions');
const { kindOf } = require('./fileAIActions');

/**
 * Ask File Box helpers for work on more than one file: summarizing several, comparing them, summarizing a
 * folder, and finding related files. Called only from the File Box AI chat (ollamaWorkspaceAssistant),
 * after it has resolved and access-checked every file and folder; these never look anything up by id
 * on their own except files the person may read.
 */

const MAX_SUMMARY_FILES = 8;
const COMPARE_RANGE = { min: 2, max: 5 };
const MAX_FOLDER_ITEMS = 40;
const RELATED_LIMIT = 6;

const formatBytes = (bytes = 0) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const day = (date) => (date ? new Date(date).toISOString().slice(0, 10) : '');
const clean = (text = '') => String(text).replace(/\s+/g, ' ').trim();

/**
 * What File Box already knows about each file, cheapest first: a saved summary, the profile written when
 * the file was read (type, description, key facts), a picture's caption, then the opening of its text.
 */
async function materialsFor(files, { textChars = 1500 } = {}) {
  const ids = files.map(f => f._id);
  const [summaries, contents] = await Promise.all([
    FileSummary.find({ file: { $in: ids } }).select('file summary keyPoints').lean(),
    FileContent.aggregate([
      { $match: { file: { $in: ids } } },
      { $project: { file: 1, aiType: 1, aiCategory: 1, aiDescription: 1, aiFacts: 1, text: { $substrCP: [{ $ifNull: ['$extractedText', ''] }, 0, textChars] } } },
    ]),
  ]);
  const summaryOf = new Map(summaries.map(s => [String(s.file), s]));
  const contentOf = new Map(contents.map(c => [String(c.file), c]));
  return files.map(file => {
    const summary = summaryOf.get(String(file._id));
    const content = contentOf.get(String(file._id)) || {};
    const parts = [`File: ${file.originalName}`, `Kind: ${[content.aiCategory, content.aiType].filter(Boolean).join(', ') || kindOf(file)}`];
    if (summary?.summary) parts.push(`Summary: ${clean(summary.summary)}`);
    else if (content.aiDescription) parts.push(`About: ${clean(content.aiDescription)}`);
    if (content.aiFacts?.length) parts.push(`Key facts: ${content.aiFacts.map(f => `${f.label}: ${f.value}`).join('; ')}`);
    if (file.aiCaption?.text) parts.push(`Picture caption: ${clean(file.aiCaption.text)}`);
    const text = clean(content.text);
    if (text) parts.push(`Text: ${text}`);
    return parts.join('\n');
  });
}

const voice = (persona) => [persona?.intro || 'You are File Box AI, a companion inside File Box, a file storage app.', persona?.tone || ''].filter(Boolean).join('\n');

/** One summary of several files the person selected (2–8). */
async function summarizeFiles(files, { question, persona, onToken }) {
  const materials = await materialsFor(files);
  const { text } = await ollamaClient.generate({
    task: 'answer',
    model: config.ollama.assistantModel,
    onToken,
    system: `${voice(persona)}
The person selected ${files.length} files and wants them summarized together.
Write one short bullet per file, starting with its exact name in bold (for example **report.pdf**: …), saying what it is and its main point.
Then one line starting "Together:" on how the files relate or what they add up to.
Use only the material given. If a file has little material, say so briefly instead of guessing.`,
    content: `Request: ${question}\n\nThe files:\n{{CONTEXT}}`,
    context: materials.join('\n\n---\n\n'),
  });
  return text.trim();
}

/** A comparison of 2–5 files: what they share, how they differ, and which file says what. */
async function compareFiles(files, { question, persona, onToken }) {
  const materials = await materialsFor(files, { textChars: 3000 });
  const { text } = await ollamaClient.generate({
    task: 'answer',
    model: config.ollama.assistantModel,
    onToken,
    system: `${voice(persona)}
The person wants these ${files.length} files compared.
Start with one sentence on what the files are. Then "Same:" with short bullets, and "Different:" with short bullets that name which file says what (use the exact file names).
End with one line starting "In short:". If they asked something specific about the comparison, answer that first.
Use only the material given; never invent details.`,
    content: `Request: ${question}\n\nThe files:\n{{CONTEXT}}`,
    context: materials.join('\n\n---\n\n'),
  });
  return text.trim();
}

/** The folder's direct contents only (subfolders and files directly inside it; never deeper). */
async function folderContents(folder) {
  const [folders, files] = await Promise.all([
    Folder.find({ parentFolder: folder._id, isTrashed: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
    File.find({ parentFolder: folder._id, isTrashed: { $ne: true } }).sort({ originalName: 1 }),
  ]);
  return { folders, files };
}

/** What a folder holds, written from its direct contents (up to 40 items). */
async function summarizeFolder(folder, { question, persona, onToken }) {
  const { folders, files } = await folderContents(folder);
  if (!folders.length && !files.length) return { answer: `"${folder.name}" is empty, so there's nothing to summarize yet.`, files: [] };
  const shownFiles = files.slice(0, MAX_FOLDER_ITEMS - Math.min(folders.length, 10));
  const materials = await materialsFor(shownFiles, { textChars: 400 });
  const listing = [
    ...folders.slice(0, 10).map(f => `Subfolder: ${f.name}`),
    ...shownFiles.map((file, i) => `${materials[i]}\nSize: ${formatBytes(file.size)} · Added: ${day(file.createdAt)}`),
  ];
  const more = folders.length + files.length - listing.length;
  const { text } = await ollamaClient.generate({
    task: 'answer',
    model: config.ollama.assistantModel,
    onToken,
    system: `${voice(persona)}
Summarize what the folder "${folder.name}" contains, from the list of what is directly inside it.
Say what kinds of files are there, the main topics, and anything notable (the most recent, the biggest, items that look duplicated or out of place).
Keep it to 3-6 short sentences or bullets. Mention file names where it helps. Use only the list; do not guess about anything not listed.`,
    content: `Request: ${question}\n\nDirectly inside "${folder.name}" (${folders.length} folders, ${files.length} files${more > 0 ? `; ${more} more not listed` : ''}):\n{{CONTEXT}}`,
    context: listing.join('\n\n'),
  });
  return { answer: text.trim(), files: shownFiles };
}

// ---------- Related files: deterministic signals first

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the this to was were will with your you my our we they them their ' +
  'file files final copy new draft version v1 v2 v3 pdf doc docx txt png jpg jpeg img image scan document notes').split(' '));
const words = (text = '') => clean(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const nameWords = (name = '') => new Set(words(name.replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[_-]+/g, ' ')));
const topWords = (text, n = 25) => {
  const counts = new Map();
  for (const w of words(text)) counts.set(w, (counts.get(w) || 0) + 1);
  return new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w));
};
const overlap = (a, b) => [...a].filter(x => b.has(x));
const jaccard = (a, b) => (a.size && b.size ? overlap(a, b).length / (a.size + b.size - overlap(a, b).length) : 0);
const cosine = (a = [], b = []) => {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

async function signalsFor(files) {
  const contents = await FileContent.aggregate([
    { $match: { file: { $in: files.map(f => f._id) } } },
    { $project: { file: 1, aiType: 1, aiCategory: 1, aiFacts: 1, aiEmbedding: 1, text: { $substrCP: [{ $ifNull: ['$extractedText', ''] }, 0, 4000] } } },
  ]);
  const byFile = new Map(contents.map(c => [String(c.file), c]));
  return new Map(files.map(file => {
    const c = byFile.get(String(file._id)) || {};
    return [String(file._id), {
      file,
      name: nameWords(file.originalName),
      folder: file.parentFolder ? String(file.parentFolder) : 'root',
      kind: kindOf(file),
      type: (c.aiType || '').toLowerCase(),
      category: (c.aiCategory || '').toLowerCase(),
      facts: new Set((c.aiFacts || []).flatMap(f => words(f.value)).filter(w => w.length >= 4)),
      keywords: topWords(c.text || ''),
      date: new Date(file.createdAt || file.uploadedAt || 0).getTime(),
      vector: c.aiEmbedding || [],
    }];
  }));
}

/**
 * Files related to a file (or to a folder's files), among the files the person may read. Scored on
 * name, folder, type, category, dates, shared facts, text keywords and the meaning vectors File Box has
 * already stored. Only when the best matches are too close to call does the local model break the tie.
 */
async function relatedFiles(userId, { file = null, folder = null }, { tieBreak = true } = {}) {
  const sourceFiles = file ? [file] : (await folderContents(folder)).files.slice(0, 30);
  if (!sourceFiles.length) return { related: [], basis: folder ? 'empty-folder' : 'none' };
  const excluded = new Set(sourceFiles.map(f => String(f._id)));
  const candidates = (await File.find(await readableFileFilter(userId)).limit(2000))
    .filter(f => !excluded.has(String(f._id)) && !(folder && String(f.parentFolder || '') === String(folder._id)));
  if (!candidates.length) return { related: [], basis: 'no-other-files' };

  const signals = await signalsFor([...sourceFiles, ...candidates]);
  const sources = sourceFiles.map(f => signals.get(String(f._id)));
  const union = (key) => new Set(sources.flatMap(s => [...s[key]]));
  const target = {
    name: union('name'), facts: union('facts'), keywords: union('keywords'),
    folders: new Set(sources.map(s => s.folder)), kinds: new Set(sources.map(s => s.kind)),
    types: new Set(sources.map(s => s.type).filter(Boolean)), categories: new Set(sources.map(s => s.category).filter(Boolean)),
    dates: sources.map(s => s.date).filter(Boolean), vectors: sources.map(s => s.vector).filter(v => v.length),
  };

  const scored = candidates.map(candidate => {
    const s = signals.get(String(candidate._id));
    let score = 0;
    const reasons = [];
    const sharedName = overlap(s.name, target.name);
    if (sharedName.length) { score += Math.min(6, sharedName.length * 3); reasons.push(`name shares "${sharedName.slice(0, 2).join('", "')}"`); }
    if (file && target.folders.has(s.folder)) { score += 1.5; reasons.push('same folder'); }
    if (s.category && target.categories.has(s.category)) { score += 2; reasons.push(`both ${s.category}`); }
    else if (s.type && target.types.has(s.type)) { score += 2; reasons.push(`both ${s.type}`); }
    else if (target.kinds.has(s.kind) && s.kind !== 'other') { score += 0.5; }
    const nearest = Math.min(...target.dates.map(d => Math.abs(d - s.date)));
    if (Number.isFinite(nearest) && nearest <= 7 * 864e5) { score += 1.5; reasons.push('added the same week'); }
    else if (Number.isFinite(nearest) && nearest <= 30 * 864e5) { score += 0.75; }
    const sharedFacts = overlap(s.facts, target.facts);
    if (sharedFacts.length) { score += Math.min(4, sharedFacts.length * 2); reasons.push(`both mention ${sharedFacts.slice(0, 2).join(', ')}`); }
    const text = jaccard(s.keywords, target.keywords);
    if (text >= 0.08) { score += Math.min(4, text * 12); reasons.push('similar wording'); }
    const meaning = target.vectors.length && s.vector.length ? Math.max(...target.vectors.map(v => cosine(v, s.vector))) : 0;
    if (meaning >= 0.6) { score += (meaning - 0.6) * 10; if (meaning >= 0.72) reasons.push('similar topic'); }
    // Being in the same folder or added the same week only adds to a real connection; alone it is not one.
    const connected = sharedName.length || sharedFacts.length || text >= 0.08 || meaning >= 0.72
      || (s.category && target.categories.has(s.category)) || (s.type && target.types.has(s.type));
    return { file: candidate, score: Math.round(score * 100) / 100, reasons, connected };
  }).filter(r => r.connected && r.score >= 2.5).sort((a, b) => b.score - a.score || a.file.originalName.localeCompare(b.file.originalName));

  let top = scored.slice(0, RELATED_LIMIT);
  let tieBroken = false;
  // Too close to call (several candidates within a point of each other): let the local model judge them.
  const close = scored.slice(0, RELATED_LIMIT + 2);
  if (tieBreak && close.length >= 3 && close[0].score - close[close.length - 1].score < 1) {
    try {
      const health = await ollamaClient.health();
      if (health.reachable) {
        const { judge } = require('./aiFileFinder');
        const about = file ? `files related to "${file.originalName}"` : `files related to what is in the folder "${folder.name}"`;
        const chosen = new Set((await judge(about, close.map(c => c.file))).map(i => String(close[i].file._id)));
        if (chosen.size) {
          top = [...close.filter(c => chosen.has(String(c.file._id))), ...close.filter(c => !chosen.has(String(c.file._id)))].slice(0, RELATED_LIMIT);
          tieBroken = true;
        }
      }
    } catch { /* keep the scored order */ }
  }
  return { related: top, basis: 'scored', tieBroken };
}

module.exports = { summarizeFiles, compareFiles, summarizeFolder, relatedFiles, folderContents, nameWords, MAX_SUMMARY_FILES, COMPARE_RANGE };

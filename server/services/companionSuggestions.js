const File = require('../models/File');
const FileContent = require('../models/FileContent');
const FileSummary = require('../models/FileSummary');
const Activity = require('../models/Activity');
const { fileById, folderById } = require('./fileResolver');
const { buildDuplicateSuggestions } = require('./duplicateSuggestions');
const { continueWorking } = require('./homeSummary');
const { relatedFiles, folderContents, nameWords } = require('./companionScope');
const { canCaption } = require('./imageCaption');

/**
 * What Ask File Box noticed about what the person is looking at, shown as up to 3 small suggestions in
 * the panel. Every check uses rules and data File Box already stores (key facts, extracted text, the
 * duplicate checker, activity, related-file scoring without the model); nothing here calls Ollama, and
 * nothing runs until the person clicks. Each suggestion carries a fingerprint of the data behind it, so
 * a dismissed one only comes back when that data changes.
 */

// The panel shows at most 3 (after the person's dismissals); a few more are sent so a dismissed one
// can be replaced by the next most useful.
const MAX = 8;
const RANK = { problem: 0, insight: 1, organize: 2, continue: 3 };
const DAY = 24 * 60 * 60 * 1000;

const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Dates written in text: "June 12, 2026", "12 June 2026", "2026-06-12", "06/12/2026", "12.06.2026", "May 2026".
const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_PATTERN = new RegExp([
  `\\b${MONTHS}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`,
  `\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTHS}\\.?,? \\d{4}\\b`,
  `\\b${MONTHS}\\.? \\d{4}\\b`,
  '\\b\\d{4}-\\d{2}-\\d{2}\\b',
  '\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b',
].join('|'), 'gi');
const LOOKS_LIKE_DATE = new RegExp(`${MONTHS}|\\d{4}|\\d{1,2}[/.-]\\d{1,2}`, 'i');

function datesIn(text = '') {
  return new Set((text.match(DATE_PATTERN) || []).map(d => d.toLowerCase().replace(/\s+/g, ' ')));
}

// Names that say nothing about the file: camera and screenshot names, "untitled", "document1", hashes.
const UNCLEAR_NAME = /^(?:img|dsc|dscn|dcim|pxl|mvimg|vid|photo|image|pic|scan|scanned|file|document|doc|untitled|new document|new file|download|attachment|copy of|screenshot|screen shot|screen recording|capture|clip)[\s_.()-]*(?:\d[\d\s_.()-]*)?(?:at [\d.\s]+(?:am|pm)?)?$|^[0-9a-f]{12,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\d{6,}$|^[\d\s_.-]+$/i;
const SCREENSHOT_NAME = /^(?:screenshot|screen shot|screen recording|capture|img|pxl|dsc|photo)[\s_.-]/i;
const stem = (name = '') => name.replace(/\.[a-z0-9]{1,6}$/i, '').trim();
const isUnclearName = (name) => UNCLEAR_NAME.test(stem(name));

// The duplicate checker reads files from disk, so its answer is reused for a minute.
const duplicateCache = new Map();
async function duplicateGroups(userId) {
  const key = String(userId);
  const cached = duplicateCache.get(key);
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.groups;
  const { groups } = await buildDuplicateSuggestions(userId);
  duplicateCache.set(key, { at: Date.now(), groups });
  return groups;
}

const ago = (date) => {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

// ---------- A file

async function fileSuggestions(userId, file) {
  const out = [];
  const [content, summary] = await Promise.all([
    FileContent.aggregate([
      { $match: { file: file._id } },
      { $project: { aiFacts: 1, text: { $substrCP: [{ $ifNull: ['$extractedText', ''] }, 0, 20000] } } },
    ]).then(rows => rows[0] || {}),
    FileSummary.findOne({ file: file._id }).select('extractedData.dates').lean(),
  ]);
  const text = (content.text || '').trim();

  if (canCaption(file) && text.replace(/\s+/g, '').length >= 12) {
    out.push({ type: 'picture-text', kind: 'insight', text: 'This picture has text in it', action: { label: 'Read text', text: 'What text is written in this picture?' }, fingerprint: `${text.length}` });
  } else {
    const dates = datesIn(text);
    (summary?.extractedData?.dates || []).forEach(d => dates.add(String(d).toLowerCase()));
    (content.aiFacts || []).filter(f => /date|deadline|due|when|period|start|end/i.test(f.label || '') && LOOKS_LIKE_DATE.test(f.value || ''))
      .forEach(f => dates.add(String(f.value).toLowerCase()));
    if (dates.size) {
      out.push({ type: 'dates', kind: 'insight', text: `This file mentions ${s(dates.size, 'date')}`, action: { label: 'Find dates', text: 'What dates does this file mention?' }, fingerprint: `${dates.size}` });
    }
  }

  // Related files from the stored signals only (no model tie-break), and only a strong match.
  const { related } = await relatedFiles(userId, { file }, { tieBreak: false });
  const strong = related.filter(r => r.score >= 4);
  if (strong.length) {
    out.push({ type: 'related', kind: 'insight', text: strong.length === 1 ? `Related file found: ${strong[0].file.originalName}` : `${strong.length} related files found`, action: { label: 'Show related files', text: 'Find related files' }, fingerprint: strong.map(r => String(r.file._id)).sort().join(',') });
  }

  if (isUnclearName(file.originalName)) {
    out.push({ type: 'unclear-name', kind: 'organize', text: `"${file.originalName}" doesn't say much about the file`, action: { label: 'Suggest a better name', text: 'Suggest a better name for this file' }, fingerprint: file.originalName });
  }
  return out;
}

// ---------- A folder (its direct contents only)

async function folderSuggestions(userId, folder) {
  const out = [];
  const { files } = await folderContents(folder);
  const ids = new Set(files.map(f => String(f._id)));

  const duplicates = (await duplicateGroups(userId)).filter(group => group.copies.some(copy => ids.has(String(copy._id))));
  if (duplicates.length) {
    out.push({ type: 'duplicates', kind: 'problem', text: duplicates.length === 1 ? 'This folder has a duplicate file' : `This folder has ${duplicates.length} sets of duplicates`, action: { label: 'Review duplicates', text: 'Find duplicate files' }, fingerprint: duplicates.map(g => g.copies.map(c => String(c._id)).sort().join('+')).sort().join('|') });
  }

  const shots = files.filter(f => canCaption(f) && SCREENSHOT_NAME.test(f.originalName));
  if (shots.length >= 3) {
    out.push({ type: 'screenshots', kind: 'organize', text: `${shots.length} screenshots and camera photos here`, action: { label: 'Organize these', text: 'Organize this folder' }, fingerprint: `${shots.length}` });
  }

  // Several files about the same thing: 3+ sharing a name word or a category.
  if (files.length >= 3) {
    const counts = new Map();
    // Words that come from how a file was made ("Screenshot …", "IMG_…") are not a shared topic.
    const MADE_BY = /^(?:screenshot|screen|shot|recording|capture|img|pxl|dsc|photo|image|scan)$/;
    files.forEach(f => nameWords(f.originalName).forEach(w => !MADE_BY.test(w) && counts.set(w, (counts.get(w) || 0) + 1)));
    const categories = new Map();
    (await FileContent.find({ file: { $in: files.map(f => f._id) } }).select('aiCategory').lean())
      .forEach(c => c.aiCategory && categories.set(c.aiCategory, (categories.get(c.aiCategory) || 0) + 1));
    const [word, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    const [category, m] = [...categories.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if ((n || 0) >= 3 || (m || 0) >= 3) {
      out.push({ type: 'folder-topic', kind: 'organize', text: (m || 0) >= (n || 0) ? `${m} files here are ${category}` : `${n} files here are about "${word}"`, action: { label: 'Summarize this folder', text: 'Summarize this folder' }, fingerprint: `${word || ''}:${n || 0}:${category || ''}:${m || 0}` });
    }
  }

  const changes = await recentChanges(folder, files, { since: new Date(Date.now() - DAY) });
  if (changes.length) {
    const changedFiles = new Set(changes.map(c => String(c.file)));
    out.push({ type: 'changed', kind: 'insight', text: `${s(changedFiles.size, 'file')} changed in the last day`, action: { label: 'See what changed', text: 'What changed in this folder recently?' }, fingerprint: String(changes[0]._id) });
  }
  return out;
}

/** Recent activity on files directly inside a folder, newest first (shared with "See what changed"). */
async function recentChanges(folder, files, { since, limit = 50 } = {}) {
  if (!files.length) return [];
  return Activity.find({
    file: { $in: files.map(f => f._id) },
    action: { $in: ['uploaded', 'created', 'edited', 'renamed', 'moved', 'copied', 'restored', 'version_created', 'version_restored'] },
    createdAt: { $gte: since },
  }).sort({ createdAt: -1 }).limit(limit).lean();
}

// ---------- Several selected files

async function selectionSuggestions(files) {
  const out = [];
  if (files.length >= 2 && files.length <= 5) {
    // Versions of one document: every name shares the same main words.
    const sets = files.map(f => nameWords(f.originalName));
    const common = [...sets[0]].filter(w => sets.every(set => set.has(w)));
    if (common.length >= 2 || (common.length === 1 && sets.every(set => set.size <= 2))) {
      out.push({ type: 'versions', kind: 'insight', text: 'These look like versions of the same document', action: { label: 'Compare these', text: 'Compare these' }, fingerprint: files.map(f => String(f._id)).sort().join(',') });
    }
  }
  if (files.length >= 2 && files.length <= 8) {
    const categories = (await FileContent.find({ file: { $in: files.map(f => f._id) } }).select('aiCategory').lean()).map(c => c.aiCategory).filter(Boolean);
    if (categories.length === files.length && new Set(categories).size === 1) {
      out.push({ type: 'same-topic', kind: 'organize', text: `${files.length} files, all ${categories[0]}`, action: { label: 'Summarize these', text: 'Summarize these' }, fingerprint: files.map(f => String(f._id)).sort().join(',') });
    }
  }
  return out;
}

// ---------- Continue where they left off (never the file they are already looking at)

async function continueSuggestion(userId, { exceptFileId } = {}) {
  const recent = (await continueWorking(userId, 3)).find(item => String(item._id) !== String(exceptFileId || '')
    && Date.now() - new Date(item.lastInteractionAt).getTime() < 3 * DAY);
  if (!recent) return [];
  return [{
    type: 'continue', kind: 'continue',
    text: `You were working on ${recent.originalName} ${ago(recent.lastInteractionAt)}`,
    action: { label: 'Continue', open: { fileId: String(recent._id), name: recent.originalName, parentFolder: recent.parentFolder ? String(recent.parentFolder) : null } },
    fingerprint: `${recent._id}:${new Date(recent.lastInteractionAt).getTime()}`,
  }];
}

/**
 * Suggestions for one focus: an open file, a selection, a folder, or just the page. Every id is
 * re-checked for this person; an id they can no longer use gives no suggestions (never someone
 * else's data).
 */
async function suggestionsFor(userId, { fileId, fileIds = [], folderId } = {}) {
  let found = [];
  let subject = 'page';
  if (fileId) {
    const file = await fileById(userId, fileId, { level: 'viewer' });
    if (!file) return { subject: `file:${fileId}`, suggestions: [] };
    subject = `file:${file._id}`;
    found = await fileSuggestions(userId, file);
  } else if (fileIds.length >= 2) {
    const files = await Promise.all(fileIds.map(id => fileById(userId, id, { level: 'viewer' })));
    subject = `selection:${[...fileIds].sort().join(',')}`;
    if (files.some(f => !f)) return { subject, suggestions: [] };
    found = await selectionSuggestions(files);
  } else if (folderId) {
    const folder = await folderById(userId, folderId);
    if (!folder) return { subject: `folder:${folderId}`, suggestions: [] };
    subject = `folder:${folder._id}`;
    found = [...(await folderSuggestions(userId, folder)), ...(await continueSuggestion(userId))];
  } else {
    found = await continueSuggestion(userId);
  }
  const suggestions = found
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])
    .slice(0, MAX)
    .map(item => ({ ...item, key: `${item.type}:${subject}:${item.fingerprint}` }));
  // (The browser shows the first 3 that were not dismissed.)
  return { subject, suggestions };
}

module.exports = { suggestionsFor, recentChanges, isUnclearName, datesIn };

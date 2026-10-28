const mongoose = require('mongoose');
const File = require('../models/File');
const User = require('../models/User');
const Folder = require('../models/Folder');
const TeamFolder = require('../models/TeamFolder');
const FileContent = require('../models/FileContent');
const { readableFileFilter, filterReadable, getFolderRole, getTeamRole } = require('./permissions');

/**
 * Advanced Search: find files by the words inside them, narrowed by format, date and location.
 * Works only from what File Box already stores (the text read at upload, including OCR of scans and
 * pictures), so a search never opens a file on disk, never runs OCR and never calls the AI model.
 * The whole text of every file is searched, so words near the end of a long file are found too.
 *
 * Every match is rechecked with the same role check the file routes use before anything about it
 * (name, snippet, total) is counted or returned; files the person cannot read never leave this module.
 */

const FORMATS = ['all', 'pdf', 'image', 'document', 'text', 'code', 'other'];
const DATES = ['any', 'today', 'week', 'month', 'year', 'custom'];
const DATE_FIELDS = { modified: 'updatedAt', uploaded: 'createdAt' };
const LOCATIONS = ['everywhere', 'folder', 'my-files', 'shared', 'team'];
const SORTS = ['best', 'content', 'modified', 'newest', 'oldest', 'name'];
const MAX_LIMIT = 100;
const SNIPPET_CHARS = 220;
const MAX_FOLDER_DEPTH = 32;

// How much each kind of evidence counts. An exact phrase or strong wording in the text always beats
// a name that only shares a word, and recency only separates otherwise similar matches.
const WEIGHTS = { nameExact: 3, namePartial: 1.5, phrase: 3, keyword: 2.5, frequency: 0.2, folder: 0.3, recency: 0.3 };

const CODE_EXTENSIONS = new Set(('js jsx ts tsx mjs cjs py java c h cc cpp hpp cs go rb php rs swift kt kts scala sql sh bash zsh '
  + 'ps1 html htm css scss sass less vue svelte json yaml yml xml toml ini r m lua pl dart').split(' '));
const TEXT_EXTENSIONS = new Set('txt md markdown csv tsv log rtf'.split(' '));
const DOCUMENT_EXTENSIONS = new Set('doc docx odt pages ppt pptx odp key xls xlsx ods numbers epub'.split(' '));

const extensionOf = (name = '') => (name.match(/\.([a-z0-9]{1,10})$/i)?.[1] || '').toLowerCase();

/** What kind of file it is technically: pdf, image, document, text, code or other. */
function technicalType(file) {
  const mime = (file.mimeType || '').toLowerCase();
  const ext = extensionOf(file.originalName);
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (DOCUMENT_EXTENSIONS.has(ext) || /msword|officedocument|opendocument|ms-excel|ms-powerpoint|spreadsheet|presentation/.test(mime)) return 'document';
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/')) return 'text';
  return 'other';
}

// Where a file's searchable text came from, for the label under a snippet.
function textSource(method = '', type) {
  if (/tesseract|ocr/i.test(method)) return 'Scanned text (OCR)';
  if (type === 'code') return 'Code';
  if (type === 'pdf') return 'PDF text';
  return 'Document text';
}

// ---- Words

const STOP_WORDS = new Set(('a an and are as at be been by can could did do does for from had has have how i if in into is it its '
  + 'me my mine of on or our so than that the their them then there these they this those to was we were what when where which '
  + 'who whom whose why will with would you your about any some all tell show give find please file files').split(' '));

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Search words worth matching: 3+ letters, or anything with a digit ("AF8841", "245", "2026"). */
function queryTerms(text = '') {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9'&.$-]*[a-z0-9]|[a-z0-9]/g) || [])
    .map(word => word.replace(/'s$/, '').replace(/^\$/, ''))
    .filter(word => (word.length >= 3 || /\d/.test(word)) && !STOP_WORDS.has(word)))];
}

// "semaphores" also finds "semaphore" (and the other way round), "processes" finds "process".
// Only "-es" after s/x/z/ch/sh is dropped whole, so "notes" stays "note" and never matches "not".
const stemOf = (term) => {
  if (/\d/.test(term) || term.length <= 3 || /ss$/.test(term)) return term;
  if (/(?:ss|x|z|ch|sh)es$/.test(term)) return term.slice(0, -2);
  return term.replace(/s$/, '');
};
const termPattern = (term) => `${escapeRegex(stemOf(term))}(?:s|es)?`;
const wholeWord = (pattern) => `(?<![a-z0-9])${pattern}(?![a-z0-9])`;
const termRegex = (term, flags = 'gi') => new RegExp(wholeWord(termPattern(term)), flags);
// The words in order, with any spacing or punctuation between them: "amount due" finds "Amount  due:".
const phraseRegex = (terms) => new RegExp(wholeWord(terms.map(termPattern).join('[^a-z0-9]+')), 'i');

const normalizeName = (name = '') => name.toLowerCase().replace(/\.[a-z0-9]{1,10}$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---- Filters

function dateRange({ date = 'any', from, to, tz = 0 }) {
  if (date === 'any') return null;
  // `tz` is the browser's getTimezoneOffset(), so "today" means the person's day, not the server's.
  const offset = Number.isFinite(Number(tz)) ? Number(tz) * 60000 : 0;
  const local = (ms) => new Date(ms - offset);
  const startOfLocalDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + offset;
  const now = local(Date.now());
  if (date === 'custom') {
    const parse = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T00:00:00Z`) : null);
    const start = parse(from);
    const end = parse(to);
    if (!start && !end) return null;
    return {
      ...(start ? { $gte: new Date(startOfLocalDay(start)) } : {}),
      ...(end ? { $lt: new Date(startOfLocalDay(end) + 86400000) } : {}),
    };
  }
  let start;
  if (date === 'today') start = startOfLocalDay(now);
  if (date === 'week') start = startOfLocalDay(now) - now.getUTCDay() * 86400000; // weeks start on Sunday
  if (date === 'month') start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) + offset;
  if (date === 'year') start = Date.UTC(now.getUTCFullYear(), 0, 1) + offset;
  return { $gte: new Date(start) };
}

/** A folder or Team Space and every folder inside it, if the person can open it; otherwise null. */
async function folderTree(folderId, userId) {
  if (!mongoose.isValidObjectId(folderId)) return null;
  const team = await TeamFolder.findById(folderId).select('owner members').lean();
  if (team) {
    if (!getTeamRole(team, userId)) return null;
  } else {
    const folder = await Folder.findById(folderId).select('owner parentFolder isTrashed').lean();
    if (!(await getFolderRole(folder, userId))) return null;
  }
  const ids = [new mongoose.Types.ObjectId(folderId)];
  let frontier = ids;
  for (let depth = 0; frontier.length && depth < MAX_FOLDER_DEPTH; depth += 1) {
    frontier = (await Folder.find({ parentFolder: { $in: frontier }, isTrashed: { $ne: true } }).select('_id').lean()).map(f => f._id);
    ids.push(...frontier);
  }
  return ids;
}

async function teamFolderIds(userId, teamId) {
  const teams = await TeamFolder.find({ $or: [{ owner: userId }, { 'members.user': userId }] }).select('_id').lean();
  const wanted = teamId ? teams.filter(t => t._id.toString() === String(teamId)) : teams;
  const ids = [];
  for (const team of wanted) ids.push(...(await folderTree(team._id.toString(), userId)) || []);
  return ids;
}

/** The location part of the query. Returns null when the folder cannot be opened by this person. */
async function locationFilter(userId, { location, folderId, teamId }) {
  if (location === 'my-files') return { owner: userId };
  if (location === 'shared') {
    return { owner: { $ne: userId }, sharedWith: { $elemMatch: { user: userId, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] } } };
  }
  if (location === 'team') return { parentFolder: { $in: await teamFolderIds(userId, teamId) } };
  if (location === 'folder') {
    const ids = await folderTree(folderId, userId);
    return ids ? { parentFolder: { $in: ids } } : null;
  }
  return {};
}

// ---- Scoring and snippets

/**
 * The most telling ~220 characters of a file's text: the window holding the most different search
 * words (then the most matches), cut at word boundaries. Returns { text, highlights: [[start, end]] }.
 */
function buildSnippet(fullText, terms, phrase) {
  const hits = [];
  if (phrase) {
    for (const m of fullText.matchAll(new RegExp(phrase.source, 'gi'))) hits.push({ start: m.index, end: m.index + m[0].length, term: -1 });
  }
  terms.forEach((term, t) => {
    for (const m of fullText.matchAll(termRegex(term))) {
      hits.push({ start: m.index, end: m.index + m[0].length, term: t });
      if (hits.length > 2000) break;
    }
  });
  if (!hits.length) return null;
  hits.sort((a, b) => a.start - b.start);

  let best = null;
  for (let i = 0; i < hits.length; i += 1) {
    const seen = new Set();
    let count = 0;
    let phraseHit = false;
    for (let j = i; j < hits.length && hits[j].end - hits[i].start <= SNIPPET_CHARS; j += 1) {
      if (hits[j].term === -1) phraseHit = true;
      else seen.add(hits[j].term);
      count += 1;
    }
    const score = (phraseHit ? 100 : 0) + seen.size * 10 + count;
    if (!best || score > best.score) best = { score, at: i };
  }

  // Center the window on the matches it covers, then move each edge to the nearest space.
  const first = hits[best.at];
  let last = first;
  for (let j = best.at; j < hits.length && hits[j].end - first.start <= SNIPPET_CHARS; j += 1) last = hits[j];
  const room = Math.max(0, SNIPPET_CHARS - (last.end - first.start));
  let start = Math.max(0, first.start - Math.floor(room / 2));
  let end = Math.min(fullText.length, start + SNIPPET_CHARS);
  start = Math.max(0, Math.min(start, end - SNIPPET_CHARS));
  if (start > 0) {
    const space = fullText.indexOf(' ', start);
    if (space !== -1 && space < first.start) start = space + 1;
  }
  if (end < fullText.length) {
    const space = fullText.lastIndexOf(' ', end);
    if (space > last.end) end = space;
  }

  // Collapse whitespace and keep the highlight positions in step with the shortened text.
  const raw = fullText.slice(start, end);
  let text = '';
  const map = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = /\s/.test(raw[i]) ? ' ' : raw[i];
    if (ch === ' ' && (text.endsWith(' ') || !text)) { map.push(text.length); continue; }
    map.push(text.length);
    text += ch;
  }
  map.push(text.length);
  const prefix = start > 0 ? '…' : '';
  const shift = prefix.length;
  const highlights = [];
  hits.filter(h => h.start >= start && h.end <= end && h.term !== -1)
    .forEach(h => highlights.push([map[h.start - start] + shift, map[h.end - start] + shift]));
  if (!highlights.length) {
    hits.filter(h => h.start >= start && h.end <= end).forEach(h => highlights.push([map[h.start - start] + shift, map[h.end - start] + shift]));
  }
  text = `${prefix}${text.trimEnd()}${end < fullText.length ? '…' : ''}`;
  return { text, highlights: highlights.filter(([a, b]) => b > a && b <= text.length) };
}

/**
 * Score one file against the search words. Weighted by how rare each word is among the candidates
 * (a course code or flight number counts more than "notes"). Returns null when the file does not match.
 */
function scoreFile(file, text, terms, weights, query) {
  const name = normalizeName(file.originalName);
  const nameTerms = terms.filter(term => termRegex(term, 'i').test(name));
  const textCounts = terms.map(term => (text ? (text.match(termRegex(term)) || []).length : 0));
  const matched = terms.filter((term, i) => textCounts[i] > 0 || nameTerms.includes(term));
  const phrase = terms.length > 1 ? phraseRegex(terms) : null;
  const phraseInText = Boolean(phrase && text && phrase.test(text));
  // Enough of the words must be there: one of one or two, two of three, and so on.
  if (!phraseInText && matched.length < Math.ceil(terms.length / 2)) return null;
  if (!matched.length) return null;

  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const keyword = terms.reduce((sum, term, i) => sum + (textCounts[i] ? weights[i] : 0), 0) / total;
  const nameShare = terms.reduce((sum, term, i) => sum + (nameTerms.includes(term) ? weights[i] : 0), 0) / total;
  const hits = textCounts.reduce((a, b) => a + b, 0);
  const content = (phraseInText ? WEIGHTS.phrase : 0) + WEIGHTS.keyword * keyword + WEIGHTS.frequency * Math.min(1, Math.log1p(hits) / Math.log(20));
  const nameExact = name === query.toLowerCase().replace(/\.[a-z0-9]{1,10}$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nameScore = nameExact ? WEIGHTS.nameExact : WEIGHTS.namePartial * nameShare;
  return {
    content,
    name: nameScore,
    matchedTerms: matched,
    matchedIn: [...(nameTerms.length ? ['name'] : []), ...(hits ? ['content'] : [])],
    phrase: phraseInText ? phrase : null,
  };
}

const recencyBoost = (file) => WEIGHTS.recency * Math.exp(-Math.max(0, Date.now() - new Date(file.updatedAt || file.createdAt).getTime()) / (90 * 86400000));

const SORTERS = {
  best: (a, b) => b.score - a.score,
  content: (a, b) => b.contentScore - a.contentScore || b.score - a.score,
  modified: (a, b) => new Date(b.file.updatedAt) - new Date(a.file.updatedAt),
  newest: (a, b) => new Date(b.file.createdAt) - new Date(a.file.createdAt),
  oldest: (a, b) => new Date(a.file.createdAt) - new Date(b.file.createdAt),
  name: (a, b) => a.file.originalName.localeCompare(b.file.originalName, undefined, { sensitivity: 'base', numeric: true }),
};

// ---- Search

class SearchInputError extends Error {}

function readOptions(options = {}) {
  const pick = (value, allowed, fallback) => {
    if (value === undefined || value === '' || value === null) return fallback;
    if (!allowed.includes(value)) throw new SearchInputError(`Unknown value "${value}"`);
    return value;
  };
  const text = String(options.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    text,
    format: pick(options.format, FORMATS, 'all'),
    date: pick(options.date, DATES, 'any'),
    dateField: pick(options.dateField, Object.keys(DATE_FIELDS), 'modified'),
    from: options.from,
    to: options.to,
    tz: options.tz,
    location: pick(options.location, LOCATIONS, 'everywhere'),
    folderId: options.folderId,
    teamId: options.teamId,
    currentFolderId: options.currentFolderId,
    sort: pick(options.sort, SORTS, text ? 'best' : 'modified'),
    limit: Math.min(MAX_LIMIT, Math.max(1, parseInt(options.limit, 10) || 30)),
    offset: Math.max(0, parseInt(options.offset, 10) || 0),
  };
}

const SAFE_FIELDS = 'originalName mimeType size owner parentFolder isStarred isTrashed sharedWith createdAt updatedAt';

/**
 * advancedSearch(userId, { text, format, date, dateField, from, to, tz, location, folderId, teamId, currentFolderId, sort, limit, offset })
 * → { results, total, applied }. Throws SearchInputError for unknown filter values; an unknown or
 * unreadable folder gives `{ results: [], total: 0, folderNotFound: true }`.
 */
async function advancedSearch(userId, options = {}) {
  const started = Date.now();
  const opts = readOptions(options);
  const terms = queryTerms(opts.text);

  const where = await locationFilter(userId, opts);
  if (!where) return { results: [], total: 0, folderNotFound: true, applied: applied(opts, terms) };
  const range = dateRange(opts);
  const filter = { $and: [await readableFileFilter(userId), where, ...(range ? [{ [DATE_FIELDS[opts.dateField]]: range }] : [])] };

  let files = await File.find(filter).select(SAFE_FIELDS).lean();
  if (opts.format !== 'all') files = files.filter(file => technicalType(file) === opts.format);

  // Confirm each file with the role check the file routes use, before anything about it is counted.
  const readable = await filterReadable(files, userId);

  let scored;
  if (terms.length) {
    // Only files whose text holds at least one of the words are loaded, and only their text (no vectors).
    const anyTerm = new RegExp(terms.map(t => wholeWord(termPattern(t))).join('|'), 'i');
    const contents = await FileContent.find({ file: { $in: readable.map(r => r.file._id) }, extractedText: { $regex: anyTerm } })
      .select('file extractedText extractionMethod').lean();
    const byFile = new Map(contents.map(c => [c.file.toString(), c]));
    const candidates = readable.filter(({ file }) => byFile.has(file._id.toString()) || terms.some(term => termRegex(term, 'i').test(normalizeName(file.originalName))));
    // Rarer words count more: a word in one candidate tells more than a word in all of them.
    const lowered = candidates.map(({ file }) => `${normalizeName(file.originalName)} ${byFile.get(file._id.toString())?.extractedText || ''}`);
    const weights = terms.map((term) => {
      const re = termRegex(term, 'i');
      const df = lowered.filter(text => re.test(text)).length;
      return Math.log(1 + (candidates.length + 1) / (df + 1)) + 0.1;
    });
    scored = candidates.map(({ file, access }) => {
      const content = byFile.get(file._id.toString());
      const text = content?.extractedText || '';
      const match = scoreFile(file, text, terms, weights, opts.text);
      if (!match) return null;
      const inFolder = opts.currentFolderId && file.parentFolder?.toString() === String(opts.currentFolderId) ? WEIGHTS.folder : 0;
      const snippet = match.matchedIn.includes('content') ? buildSnippet(text, terms, match.phrase) : null;
      return {
        file,
        access,
        score: match.content + match.name + inFolder + recencyBoost(file),
        contentScore: match.content,
        matchedTerms: match.matchedTerms,
        matchedIn: match.matchedIn,
        snippet: snippet && { ...snippet, source: textSource(content.extractionMethod, technicalType(file)) },
      };
    }).filter(Boolean);
  } else {
    scored = readable.map(({ file, access }) => ({ file, access, score: recencyBoost(file), contentScore: 0, matchedTerms: [], matchedIn: [], snippet: null }));
  }

  scored.sort((a, b) => SORTERS[opts.sort](a, b) || SORTERS.name(a, b));
  const page = scored.slice(opts.offset, opts.offset + opts.limit);

  const parentIds = [...new Set(page.map(r => r.file.parentFolder?.toString()).filter(Boolean))];
  const [folders, teams] = await Promise.all([
    Folder.find({ _id: { $in: parentIds } }).select('name').lean(),
    TeamFolder.find({ _id: { $in: parentIds } }).select('name').lean(),
  ]);
  const parentNames = new Map([...folders, ...teams].map(f => [f._id.toString(), f.name]));
  const ownerIds = [...new Set(page.filter(r => r.access.role !== 'owner').map(r => r.file.owner.toString()))];
  const owners = new Map((await User.find({ _id: { $in: ownerIds } }).select('name').lean()).map(u => [u._id.toString(), u.name]));

  const results = page.map(({ file, access, score, matchedTerms, matchedIn, snippet }) => ({
    _id: file._id,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    technicalType: technicalType(file),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    parentFolder: file.parentFolder || null,
    folderName: file.parentFolder ? parentNames.get(file.parentFolder.toString()) || null : null,
    // Someone else's star, share list, storage path and access log are never sent.
    isStarred: access.role === 'owner' ? Boolean(file.isStarred) : false,
    ownerName: access.role === 'owner' ? null : owners.get(file.owner.toString()) || null,
    access,
    score: Math.round(score * 1000) / 1000,
    matchedTerms,
    matchedIn,
    snippet,
  }));

  return { results, total: scored.length, applied: applied(opts, terms), tookMs: Date.now() - started };
}

function applied(opts, terms) {
  return {
    text: opts.text,
    terms,
    format: opts.format,
    date: opts.date,
    dateField: opts.dateField,
    ...(opts.date === 'custom' ? { from: opts.from || null, to: opts.to || null } : {}),
    location: opts.location,
    ...(opts.location === 'folder' ? { folderId: opts.folderId } : {}),
    ...(opts.location === 'team' && opts.teamId ? { teamId: opts.teamId } : {}),
    sort: opts.sort,
    limit: opts.limit,
    offset: opts.offset,
  };
}

module.exports = { advancedSearch, technicalType, queryTerms, buildSnippet, SearchInputError, FORMATS, DATES, LOCATIONS, SORTS };

/**
 * Boards: the board-only block types (checklist, label, deadline, link, file list, saved search). Every value the browser sends is
 * cleaned here before it is stored; anything that cannot be cleaned is refused with a clear message.
 * Lengths count characters as people see them (an emoji is one), like notes.
 */

const { TAXONOMY, CATEGORIES } = require('./fileClassifier');

class BlockError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const LIMITS = Object.freeze({
  checklistTitle: 100, checklistItems: 100, checklistItem: 500,
  label: 120,
  deadlineTitle: 120, deadlineNote: 500,
  linkUrl: 2000, linkTitle: 200, linkNote: 500,
  fileListTitle: 100, fileListRows: 50,
  searchTitle: 100, searchText: 300, searchTopic: 60,
});
const LABEL_SIZES = ['s', 'm', 'l'];
const LABEL_ALIGN = ['left', 'center', 'right'];
const LABEL_TONES = ['default', 'sage', 'sky', 'rose', 'amber', 'slate'];
const ITEM_ID = /^[a-z0-9]{8}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Control characters (keeping tab and new line where text may have lines), zero-width and direction marks.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => Array.from(s).length;
const oneLine = (value) => (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').replace(CONTROL, '').trim();
const lines = (value) => (typeof value === 'string' ? value : '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
const within = (text, max, what) => { if (chars(text) > max) throw new BlockError(`${what} can be up to ${max.toLocaleString('en-US')} characters.`); return text; };

/** A checklist: an optional title and up to 100 items, each with its own id, words and a tick. */
function cleanChecklist(raw) {
  if (raw === undefined) return { title: '', items: [] };
  if (!isObject(raw)) throw new BlockError('This checklist could not be saved.');
  const title = within(oneLine(raw.title), LIMITS.checklistTitle, 'A checklist title');
  const list = raw.items === undefined ? [] : raw.items;
  if (!Array.isArray(list)) throw new BlockError('This checklist could not be saved.');
  if (list.length > LIMITS.checklistItems) throw new BlockError(`A checklist can hold up to ${LIMITS.checklistItems} items.`);
  const seen = new Set();
  const items = list.map((item) => {
    if (!isObject(item) || typeof item.id !== 'string' || !ITEM_ID.test(item.id) || seen.has(item.id)) throw new BlockError('This checklist could not be saved. Reload and try again.');
    seen.add(item.id);
    return { id: item.id, text: within(oneLine(item.text), LIMITS.checklistItem, 'A checklist item'), checked: item.checked === true };
  });
  return { title, items };
}

/** A label: one line of heading text with a size, an alignment and a subtle tone. */
function cleanLabel(raw) {
  if (raw === undefined) return { text: '', size: 'm', align: 'left', tone: 'default' };
  if (!isObject(raw)) throw new BlockError('This label could not be saved.');
  return {
    text: within(oneLine(raw.text), LIMITS.label, 'A label'),
    size: LABEL_SIZES.includes(raw.size) ? raw.size : 'm',
    align: LABEL_ALIGN.includes(raw.align) ? raw.align : 'left',
    tone: LABEL_TONES.includes(raw.tone) ? raw.tone : 'default',
  };
}

/** A real calendar date between 2000 and 2100, as YYYY-MM-DD; null if it is not one. */
function calendarDate(value) {
  const m = typeof value === 'string' ? value.match(DATE) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? value : null;
}

/**
 * A deadline: a calendar date (a date-only deadline is due at the end of that day wherever it is viewed),
 * an optional time, and for a timed one the exact moment in UTC worked out by the browser. That moment
 * must belong to the date and time given (time zones run from UTC-12 to UTC+14), so it cannot be made up.
 */
function cleanDeadline(raw) {
  if (raw === undefined) return { title: '', note: '', due: null, completedAt: null };
  if (!isObject(raw)) throw new BlockError('This deadline could not be saved.');
  const title = within(oneLine(raw.title), LIMITS.deadlineTitle, 'A deadline title');
  const note = within(lines(raw.note), LIMITS.deadlineNote, 'A deadline note');
  let due = null;
  if (raw.due !== undefined && raw.due !== null) {
    if (!isObject(raw.due)) throw new BlockError('Choose a valid date.');
    const date = calendarDate(raw.due.date);
    if (!date) throw new BlockError('Choose a valid date.');
    const time = raw.due.time === undefined || raw.due.time === null || raw.due.time === '' ? null : raw.due.time;
    if (time !== null && (typeof time !== 'string' || !TIME.test(time))) throw new BlockError('Choose a valid time.');
    let at = null;
    if (time) {
      const instant = typeof raw.due.at === 'string' ? new Date(raw.due.at) : null;
      const wall = Date.parse(`${date}T${time}:00Z`);
      const offset = instant && !Number.isNaN(instant.getTime()) ? (wall - instant.getTime()) / 3600000 : NaN;
      if (!(offset >= -12 && offset <= 14)) throw new BlockError('Choose a valid time.');
      at = instant.toISOString();
    }
    due = { date, time, at };
  }
  let completedAt = null;
  if (raw.completedAt !== undefined && raw.completedAt !== null) {
    const when = typeof raw.completedAt === 'string' ? new Date(raw.completedAt) : null;
    if (!when || Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86400000 || when.getUTCFullYear() < 2000) throw new BlockError('This deadline could not be saved.');
    completedAt = when.toISOString();
  }
  return { title, note, due, completedAt };
}

/**
 * A link's address: only http and https, as the standard URL parser writes it (lowercase host, default port
 * removed, query and fragment kept). Nothing is ever fetched from it; it is opened only in the person's own
 * browser. Refused: other schemes, no scheme at all (the board's dialog adds https:// only to domain names),
 * spaces or control characters (they can hide "java script:"), a user name or password before the host
 * (often used to disguise where a link goes), and anything the parser cannot read.
 */
const WEB = 'Use a web address starting with https:// or http://.';
function linkUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new BlockError('Add a web address.');
  const text = value.trim();
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new BlockError('Web addresses cannot contain spaces or hidden characters.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) throw new BlockError(WEB);
  let url;
  try { url = new URL(text); } catch { throw new BlockError("That web address isn't valid."); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockError(WEB);
  if (!url.hostname) throw new BlockError("That web address isn't valid.");
  // Anything before an "@" in the address's host part, even an empty one, is refused.
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:[\\/]*[^\\/?#]*@/i.test(text)) throw new BlockError("Links can't include a user name or password.");
  if (chars(url.href) > LIMITS.linkUrl) throw new BlockError(`Web addresses can be up to ${LIMITS.linkUrl.toLocaleString('en-US')} characters.`);
  return url.href;
}

/** A link: its address (required), an optional title and an optional note. */
function cleanLink(raw) {
  if (!isObject(raw)) throw new BlockError('Add a web address.');
  return {
    url: linkUrl(raw.url),
    title: within(oneLine(raw.title), LIMITS.linkTitle, 'A link title'),
    note: within(lines(raw.note), LIMITS.linkNote, 'A link note'),
  };
}

// Which field holds each board-only type's content, and how it is cleaned.
/**
 * A file list as the browser sends it: a title and rows in order, each with its own row id. A row the
 * server already has is sent as { id } (the server keeps the file it points at); a new row also names the
 * file: { id, fileId }. Merging with the stored rows and checking access happen in workspaceBoards.js.
 */
const FILE_ID = /^[0-9a-f]{24}$/;
function cleanFileList(raw) {
  if (raw === undefined) return { title: '', items: [] };
  if (!isObject(raw)) throw new BlockError('This file list could not be saved.');
  const title = within(oneLine(raw.title), LIMITS.fileListTitle, 'A file list title');
  const list = raw.items === undefined ? [] : raw.items;
  if (!Array.isArray(list)) throw new BlockError('This file list could not be saved.');
  if (list.length > LIMITS.fileListRows) throw new BlockError(`A file list can hold up to ${LIMITS.fileListRows} files.`);
  const seen = new Set();
  const items = list.map((row) => {
    if (!isObject(row) || typeof row.id !== 'string' || !ITEM_ID.test(row.id) || seen.has(row.id)) throw new BlockError('This file list could not be saved. Reload and try again.');
    seen.add(row.id);
    if (row.fileId === undefined) return { id: row.id };
    if (typeof row.fileId !== 'string' || !FILE_ID.test(row.fileId)) throw new BlockError("Something you tried to add isn't available.");
    return { id: row.id, fileId: row.fileId };
  });
  return { title, items };
}

/**
 * A saved search: only the structured filters Advanced Search runs with (services/advancedSearch.js), and
 * how many results the block shows. Never results, counts, snippets or file ids. Relative dates (today,
 * this week, this month, this year) are kept as words, so they always mean the current one.
 */
const SEARCH = Object.freeze({
  formats: ['all', 'pdf', 'image', 'document', 'text', 'code', 'other'],
  dates: ['any', 'today', 'week', 'month', 'year', 'custom'],
  dateFields: ['modified', 'uploaded'],
  locations: ['everywhere', 'my-files', 'shared', 'team', 'folder'],
  sorts: ['best', 'content', 'modified', 'newest', 'oldest', 'name'],
  show: [3, 5, 10],
});
const SCOPE_ID = /^[0-9a-f]{24}$/;
function cleanSavedSearch(raw) {
  if (!isObject(raw)) throw new BlockError('Choose what this saved search should find.');
  const bad = (what) => { throw new BlockError(`This saved search could not be saved: ${what}.`); };
  const one = (value, allowed, fallback, what) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!allowed.includes(value)) bad(what);
    return value;
  };
  const text = within(oneLine(raw.text), LIMITS.searchText, 'Search words');
  const category = one(raw.category, ['all', ...CATEGORIES], 'all', 'unknown category');
  const allTypes = [...new Set(Object.values(TAXONOMY).flat())];
  const documentType = one(raw.documentType, ['all', ...allTypes], 'all', 'unknown document type');
  if (category !== 'all' && documentType !== 'all' && !TAXONOMY[category].includes(documentType)) bad(`${documentType} is not a ${category} document type`);
  const date = one(raw.date, SEARCH.dates, 'any', 'unknown date');
  let from = null;
  let to = null;
  if (date === 'custom') {
    const day = (value) => (value === undefined || value === null || value === '' ? null : calendarDate(value) || bad('a date is not a real day between 2000 and 2100'));
    from = day(raw.from);
    to = day(raw.to);
    if (!from && !to) bad('a custom range needs a start or an end');
    if (from && to && from > to) bad('the start is after the end');
  }
  const location = one(raw.location, SEARCH.locations, 'everywhere', 'unknown location');
  const id = (value) => (typeof value === 'string' && SCOPE_ID.test(value) ? value : null);
  const folderId = location === 'folder' ? id(raw.folderId) : null;
  if (location === 'folder' && !folderId) bad('choose a folder');
  const teamId = location === 'team' && raw.teamId !== undefined && raw.teamId !== null && raw.teamId !== '' ? id(raw.teamId) || bad('unknown Team Space') : null;
  let sort = one(raw.sort, SEARCH.sorts, text ? 'best' : 'modified', 'unknown sort');
  // Best match and most relevant content need words; without them the newest changes come first (as on the search page).
  if (!text && (sort === 'best' || sort === 'content')) sort = 'modified';
  const show = raw.show === undefined ? 5 : Number(raw.show);
  if (!SEARCH.show.includes(show)) bad('show 3, 5 or 10 results');
  return {
    title: within(oneLine(raw.title), LIMITS.searchTitle, 'A saved search title'),
    text,
    category,
    documentType,
    topic: within(oneLine(raw.topic), LIMITS.searchTopic, 'A topic'),
    format: one(raw.format, SEARCH.formats, 'all', 'unknown format'),
    date,
    from,
    to,
    dateField: one(raw.dateField, SEARCH.dateFields, 'modified', 'unknown date field'),
    location,
    folderId,
    teamId,
    sort,
    show,
  };
}

const CLEANERS = Object.freeze({ checklist: cleanChecklist, label: cleanLabel, deadline: cleanDeadline, link: cleanLink, filelist: cleanFileList, search: cleanSavedSearch });

module.exports = { BlockError, LIMITS, LABEL_SIZES, LABEL_ALIGN, LABEL_TONES, CLEANERS, cleanChecklist, cleanLabel, cleanDeadline, cleanLink, linkUrl, cleanFileList, cleanSavedSearch, SEARCH };

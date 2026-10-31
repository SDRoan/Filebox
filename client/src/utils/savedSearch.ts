import { BoardSavedSearch } from '../services/api';

/**
 * Saved searches on Boards: the filters a block keeps, the words that describe them, the Advanced Search
 * address that shows the same search, and the browser-only memory of what was shown last time (hashes
 * and a total only, never ids or names).
 */

export const SEARCH_DEFAULTS: BoardSavedSearch = {
  title: '', text: '', category: 'all', documentType: 'all', topic: '', format: 'all',
  date: 'any', from: null, to: null, dateField: 'modified', location: 'everywhere', folderId: null, teamId: null,
  sort: 'modified', show: 5,
};

export const SEARCH_FORMATS: Array<[BoardSavedSearch['format'], string]> = [['all', 'All formats'], ['pdf', 'PDF'], ['image', 'Image'], ['document', 'Document'], ['text', 'Text'], ['code', 'Code'], ['other', 'Other']];
export const SEARCH_DATES: Array<[BoardSavedSearch['date'], string]> = [['any', 'Any time'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom range']];
export const SEARCH_SORTS: Array<[BoardSavedSearch['sort'], string]> = [['best', 'Best match'], ['content', 'Most relevant content'], ['modified', 'Recently modified'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name']];
export const SEARCH_CATEGORIES = ['Work', 'School', 'Financial', 'Personal', 'Other'];

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{24}$/;

/**
 * The filters a search on the Advanced Search page actually ran with (its response's `applied`), as a saved
 * search: words the page read as filters are saved as those filters, never as words to read again.
 */
export function fromApplied(applied: Record<string, unknown>, show: 3 | 5 | 10 = 5): BoardSavedSearch {
  const text = typeof applied.text === 'string' ? applied.text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const date = pick(applied.date, SEARCH_DATES.map(d => d[0]), 'any');
  const location = pick(applied.location, ['everywhere', 'my-files', 'shared', 'team', 'folder'] as const, 'everywhere');
  const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : null);
  const id = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : null);
  let sort = pick(applied.sort, SEARCH_SORTS.map(s => s[0]), text ? 'best' : 'modified');
  if (!text && (sort === 'best' || sort === 'content')) sort = 'modified';
  return {
    ...SEARCH_DEFAULTS,
    text,
    category: typeof applied.category === 'string' ? applied.category : 'all',
    documentType: typeof applied.documentType === 'string' ? applied.documentType : 'all',
    topic: typeof applied.topic === 'string' ? applied.topic.slice(0, 60) : '',
    format: pick(applied.format, SEARCH_FORMATS.map(f => f[0]), 'all'),
    date,
    from: date === 'custom' ? day(applied.from) : null,
    to: date === 'custom' ? day(applied.to) : null,
    dateField: applied.dateField === 'uploaded' ? 'uploaded' : 'modified',
    location,
    folderId: location === 'folder' ? id(applied.folderId) : null,
    teamId: location === 'team' ? id(applied.teamId) : null,
    sort,
    show,
  };
}

/** The Advanced Search address with exactly these filters (`exact=1`: the words are not read again). */
export function viewAllUrl(s: BoardSavedSearch) {
  const p = new URLSearchParams();
  if (s.text) p.set('q', s.text);
  if (s.category !== 'all') p.set('category', s.category);
  if (s.documentType !== 'all' && s.category !== 'all') p.set('type', s.documentType);
  if (s.topic) p.set('topic', s.topic);
  if (s.format !== 'all') p.set('format', s.format);
  if (s.date !== 'any') p.set('date', s.date);
  if (s.date === 'custom' && s.from) p.set('from', s.from);
  if (s.date === 'custom' && s.to) p.set('to', s.to);
  if (s.dateField !== 'modified') p.set('dateField', s.dateField);
  if (s.location !== 'everywhere') p.set('location', s.location);
  if (s.location === 'folder' && s.folderId) p.set('folder', s.folderId);
  if (s.location === 'team' && s.teamId) p.set('team', s.teamId);
  if (s.sort !== (s.text ? 'best' : 'modified')) p.set('sort', s.sort);
  if (s.text) p.set('exact', '1');
  return `/search?${p.toString()}`;
}

const FORMAT_PLURAL: Record<string, string> = { pdf: 'PDFs', image: 'Images', document: 'Documents', text: 'Text files', code: 'Code files', other: 'Other files' };
const typePlural = (type: string) => (/[a-z]$/i.test(type) && !/\//.test(type) ? `${type}${/s$/i.test(type) ? '' : 's'}` : `${type} files`);
const cap = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const dateWords = (s: BoardSavedSearch) => {
  if (s.date === 'custom') {
    if (s.from && s.to) return `${s.from} – ${s.to}`;
    return s.from ? `Since ${s.from}` : `Until ${s.to}`;
  }
  return SEARCH_DATES.find(d => d[0] === s.date)?.[1] || '';
};

/**
 * A title from the filters alone, when none was given: "Invoices · This month", "School PDFs · Semaphores",
 * "Shared files · React". Always the same for the same filters; no folder or Team Space names; ≤100 characters.
 */
export function autoTitle(s: BoardSavedSearch) {
  let kind = s.documentType !== 'all' ? typePlural(s.documentType) : s.format !== 'all' ? FORMAT_PLURAL[s.format] : 'Files';
  if (s.documentType === 'all' && s.category !== 'all') kind = `${s.category} ${kind === 'Files' ? 'files' : kind}`;
  if (s.location === 'shared') kind = `Shared ${kind === 'Files' ? 'files' : kind}`;
  const parts = [kind];
  if (s.text) parts.push(cap(s.text));
  if (s.topic) parts.push(cap(s.topic));
  if (s.date !== 'any') parts.push(dateWords(s));
  if (s.location === 'my-files') parts.push('My Files');
  if (s.location === 'team') parts.push(s.teamId ? 'One Team Space' : 'Team Spaces');
  if (s.location === 'folder') parts.push('One folder');
  return Array.from(parts.join(' · ')).slice(0, 100).join('');
}
export const titleOf = (s: BoardSavedSearch) => s.title || autoTitle(s);

/** One line saying what the search finds (the place's name only when the last run could open it). */
export function summaryOf(s: BoardSavedSearch, scopeName?: string) {
  const parts: string[] = [];
  if (s.text) parts.push(`“${s.text}”`);
  if (s.documentType !== 'all') parts.push(typePlural(s.documentType));
  else if (s.category !== 'all') parts.push(s.category);
  if (s.topic) parts.push(`topic ${s.topic}`);
  if (s.format !== 'all') parts.push(FORMAT_PLURAL[s.format]);
  if (s.date !== 'any') parts.push(`${s.dateField === 'uploaded' ? 'uploaded' : 'modified'} ${dateWords(s).toLowerCase()}`);
  const where = s.location === 'my-files' ? 'My Files' : s.location === 'shared' ? 'Shared with me'
    : s.location === 'team' ? (s.teamId ? (scopeName ? `Team Space · ${scopeName}` : 'One Team Space') : 'All Team Spaces')
      : s.location === 'folder' ? (scopeName ? `In ${scopeName}` : 'One folder') : 'Everywhere';
  parts.push(where);
  parts.push(SEARCH_SORTS.find(x => x[0] === s.sort)?.[1] || '');
  return parts.filter(Boolean).join(' · ');
}

// ---- "New results": what the block showed last time, kept in this browser only.
// A short one-way hash of each shown file's id, and the total; never ids, names or places.
const hash = (value: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
};
const KEY = (blockId: string) => `filebox-board-search:${blockId}`;
export interface Fingerprint { h: string[]; total: number }
export const fingerprintOf = (ids: string[], total: number): Fingerprint => ({ h: ids.map(hash), total });
export const hashOf = hash;
export function readFingerprint(blockId: string): Fingerprint | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(blockId)) || 'null');
    return raw && Array.isArray(raw.h) && typeof raw.total === 'number' ? { h: raw.h.map(String), total: raw.total } : null;
  } catch { return null; }
}
export function writeFingerprint(blockId: string, fp: Fingerprint) { try { localStorage.setItem(KEY(blockId), JSON.stringify(fp)); } catch { /* not kept: no "new" markers */ } }
export function clearFingerprint(blockId: string) { try { localStorage.removeItem(KEY(blockId)); } catch { /* nothing kept */ } }

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AdvancedSearchResult from './AdvancedSearchResult';
import FilePreview from './FilePreview';
import { advancedSearchAPI, filesAPI, teamFoldersAPI, AdvancedSearchParams, AdvancedSearchResponse, AdvancedSearchResult as Result } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import { FileItemType } from '../types';
import './AdvancedSearch.css';

/**
 * Advanced Search (/search): find files by the words inside them and by what kind of document they are.
 * Every filter lives in the URL, so opening a file and coming back keeps the search. Results, snippets and
 * every count come from the server's permission-checked search (GET /api/search/advanced); this page
 * never counts or filters files itself. Grouping by category is only a view: files stay in their folders.
 */

const CATEGORIES = ['Work', 'School', 'Financial', 'Personal', 'Other'];
const FORMATS = [['all', 'All formats'], ['pdf', 'PDF'], ['image', 'Image'], ['document', 'Document'], ['text', 'Text'], ['code', 'Code'], ['other', 'Other']];
const DATES = [['any', 'Any time'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom range']];
const SORTS = [['best', 'Best match'], ['content', 'Most relevant content'], ['modified', 'Recently modified'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name']];
const LOCATIONS = ['everywhere', 'folder', 'my-files', 'shared', 'team'];
const PAGE_SIZE = 30;
const TYPING_DELAY = 300;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const valueIn = (value: string | null, list: string[][] | string[], fallback: string) => {
  const allowed = (list as Array<string | string[]>).map(item => (Array.isArray(item) ? item[0] : item));
  return value && allowed.includes(value) ? value : fallback;
};

interface Filters {
  q: string;
  category: string;
  type: string;
  format: string;
  date: string;
  from: string;
  to: string;
  dateField: 'modified' | 'uploaded';
  location: string;
  folder: string;
  sort: string;
  topic: string;
}

/** The search as the URL describes it. Unknown or unsafe values are dropped. */
function readFilters(params: URLSearchParams, typesFor: (category: string) => string[]): Filters {
  const q = (params.get('q') || '').slice(0, 300);
  const category = valueIn(params.get('category'), CATEGORIES, '');
  const type = category && typesFor(category).includes(params.get('type') || '') ? params.get('type') || '' : '';
  const folder = OBJECT_ID.test(params.get('folder') || '') ? params.get('folder') || '' : '';
  let location = valueIn(params.get('location'), LOCATIONS, 'everywhere');
  if (location === 'folder' && !folder) location = 'everywhere';
  const date = valueIn(params.get('date'), DATES, 'any');
  const sortDefault = q.trim() ? 'best' : 'modified';
  let sort = valueIn(params.get('sort'), SORTS, sortDefault);
  if (!q.trim() && (sort === 'best' || sort === 'content')) sort = 'modified';
  return {
    q,
    category,
    type,
    format: valueIn(params.get('format'), FORMATS, 'all'),
    date,
    from: date === 'custom' && ISO_DAY.test(params.get('from') || '') ? params.get('from') || '' : '',
    to: date === 'custom' && ISO_DAY.test(params.get('to') || '') ? params.get('to') || '' : '',
    dateField: params.get('dateField') === 'uploaded' ? 'uploaded' : 'modified',
    location,
    folder,
    sort,
    topic: (params.get('topic') || '').slice(0, 60),
  };
}

const monthName = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
function dateWords(f: Filters) {
  if (f.date === 'today') return 'today';
  if (f.date === 'week') return 'this week';
  if (f.date === 'month') return 'this month';
  if (f.date === 'year') return 'this year';
  if (f.date === 'custom') {
    const sameMonth = f.from && f.to && f.from.slice(0, 7) === f.to.slice(0, 7) && f.from.endsWith('-01');
    if (sameMonth) return `in ${monthName(f.from)}`;
    if (f.from && f.to) return `between ${f.from} and ${f.to}`;
    if (f.from) return `since ${f.from}`;
    if (f.to) return `before ${f.to}`;
  }
  return '';
}
const plural = (type: string) => (/[a-z]$/i.test(type) && !/\//.test(type) ? `${type.toLowerCase()}${/s$/i.test(type) ? '' : 's'}` : `${type} files`);

const AdvancedSearch: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [taxonomy, setTaxonomy] = useState<Array<{ name: string; documentTypes: string[] }>>([]);
  const typesFor = useCallback((category: string) => taxonomy.find(c => c.name === category)?.documentTypes || [], [taxonomy]);
  const filters = useMemo(() => readFilters(params, typesFor), [params, typesFor]);
  const [input, setInput] = useState(filters.q);
  const [data, setData] = useState<AdvancedSearchResponse | null>(null);
  const [extra, setExtra] = useState<Result[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<'' | 'folder' | 'failed'>('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [hasTeams, setHasTeams] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const latest = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // The phone filter sheet covers the page; the floating Ask File Box button steps aside while it is open.
  useEffect(() => {
    document.body.classList.toggle('adv-sheet-open', sheetOpen);
    return () => document.body.classList.remove('adv-sheet-open');
  }, [sheetOpen]);

  useEffect(() => {
    advancedSearchAPI.taxonomy().then(t => setTaxonomy(t.categories)).catch(() => setTaxonomy(CATEGORIES.map(name => ({ name, documentTypes: [] }))));
    teamFoldersAPI.getTeamFolders().then((teams: unknown) => setHasTeams(Array.isArray(teams) ? teams.length > 0 : Boolean((teams as any)?.teamFolders?.length))).catch(() => setHasTeams(false));
  }, []);

  useEffect(() => {
    if (!filters.folder) { setFolderName(''); return; }
    filesAPI.getFolder(filters.folder).then((folder: any) => setFolderName(folder?.name || '')).catch(() => setFolderName(''));
  }, [filters.folder]);

  /** Change the URL. Filter changes replace the current history entry; opening a file adds one. */
  const update = useCallback((changes: Record<string, string | null>, { push = false } = {}) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key); });
    // Defaults stay out of the URL.
    [['format', 'all'], ['date', 'any'], ['dateField', 'modified'], ['location', 'everywhere']].forEach(([key, value]) => { if (next.get(key) === value) next.delete(key); });
    if (next.get('date') !== 'custom') { next.delete('from'); next.delete('to'); }
    const sortDefault = (next.get('q') || '').trim() ? 'best' : 'modified';
    if (next.get('sort') === sortDefault) next.delete('sort');
    setParams(next, { replace: !push });
  }, [params, setParams]);

  // Typing searches after a short pause. The box follows the URL only when the URL changed some other
  // way (Back, a suggestion), never in the middle of typing.
  const typedQ = useRef<string | null>(null);
  useEffect(() => {
    if (typedQ.current !== null && typedQ.current === filters.q) return;
    typedQ.current = null;
    setInput(filters.q);
  }, [filters.q]);
  useEffect(() => {
    if (input === filters.q || (!input.trim() && !filters.q)) return undefined;
    const timer = setTimeout(() => {
      typedQ.current = input.trim() ? input : '';
      update({ q: input.trim() ? input : null });
    }, TYPING_DELAY);
    return () => clearTimeout(timer);
  }, [input, filters.q, update]);

  const request: AdvancedSearchParams = useMemo(() => ({
    q: filters.q.trim() || undefined,
    category: filters.category || undefined,
    documentType: filters.type || undefined,
    topic: filters.topic || undefined,
    format: filters.format === 'all' ? undefined : filters.format,
    date: filters.date === 'any' ? undefined : filters.date,
    from: filters.from || undefined,
    to: filters.to || undefined,
    dateField: filters.dateField,
    location: filters.location,
    folderId: filters.location === 'folder' ? filters.folder : undefined,
    currentFolderId: filters.folder || undefined,
    sort: filters.sort,
    tz: new Date().getTimezoneOffset(),
  }), [filters]);
  const requestKey = JSON.stringify(request);

  // Only the newest request may change what is shown; older answers are aborted or ignored.
  useEffect(() => {
    const id = latest.current + 1;
    latest.current = id;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    advancedSearchAPI.search({ ...request, limit: PAGE_SIZE, offset: 0 }, controller.signal)
      .then((response) => {
        if (latest.current !== id) return;
        setData(response);
        setExtra([]);
        setLoading(false);
      })
      .catch((err) => {
        if (latest.current !== id || controller.signal.aborted) return;
        setData(null);
        setExtra([]);
        setError(err?.response?.status === 404 ? 'folder' : 'failed');
        setLoading(false);
      });
    return () => controller.abort();
    // requestKey stands for `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, refreshKey]);

  const results = useMemo(() => [...(data?.results || []), ...extra], [data, extra]);

  const loadMore = async () => {
    const id = latest.current;
    setLoadingMore(true);
    try {
      const more = await advancedSearchAPI.search({ ...request, limit: PAGE_SIZE, offset: results.length });
      if (latest.current === id) setExtra(prev => [...prev, ...more.results]);
    } catch {
      setAnnouncement("Couldn't load more results.");
    } finally {
      setLoadingMore(false);
    }
  };

  // ---- Opening a file: ?open=<id> is its own history entry, so Back closes it and the search stays.
  const openId = params.get('open') || '';
  const opened = openId ? results.find(r => r._id === openId) : undefined;
  useEffect(() => {
    if (openId && !loading && data && !opened) update({ open: null });
  }, [openId, loading, data, opened, update]);
  const openResult = (result: Result) => update({ open: result._id }, { push: true });
  const closePreview = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else update({ open: null });
  };

  const showInFolder = (result: Result) => {
    if (result.access.source === 'shared') navigate(pagePath('shared'));
    else if (result.access.source === 'team') navigate(pagePath('teams'));
    else navigate(pagePath('files'), { state: { openFolderId: result.parentFolder || null } });
  };

  const changed = (message: string) => { setAnnouncement(message); setRefreshKey(k => k + 1); };
  const starred = (id: string, value: boolean) => {
    setData(prev => (prev ? { ...prev, results: prev.results.map(r => (r._id === id ? { ...r, isStarred: value } : r)) } : prev));
    setExtra(prev => prev.map(r => (r._id === id ? { ...r, isStarred: value } : r)));
    setAnnouncement(value ? 'Starred.' : 'Star removed.');
  };

  // ---- What the browse strip and the type filter show: counts exactly as the server sent them.
  const categoryCount = (name: string) => data?.groups.categories.find(g => g.name === name)?.count || 0;
  const typeCount = (name: string) => data?.groups.documentTypes.find(g => g.name === name)?.count;
  const typeChips = (data?.groups.documentTypes || []).filter(g => g.count > 0);

  const activeFilters = [filters.category, filters.type, filters.topic, filters.format !== 'all', filters.date !== 'any', filters.location !== 'everywhere'].filter(Boolean).length;
  const clearFilters = () => update({ category: null, type: null, topic: null, format: null, date: null, from: null, to: null, dateField: null, location: null, sort: null });

  const summary = (() => {
    if (loading && !data) return 'Searching…';
    if (error) return '';
    const total = data?.total || 0;
    const bits = [
      [filters.category, filters.type].filter(Boolean).join(' › '),
      filters.topic && `Topic: ${filters.topic}`,
      filters.format !== 'all' && FORMATS.find(f => f[0] === filters.format)?.[1],
      dateWords(filters) && `${filters.dateField === 'uploaded' ? 'Uploaded' : 'Modified'} ${dateWords(filters)}`,
      filters.location === 'folder' ? `In ${folderName || 'this folder'}` : filters.location === 'my-files' ? 'My Files' : filters.location === 'shared' ? 'Shared with me' : filters.location === 'team' ? 'Team Spaces' : '',
    ].filter(Boolean);
    return `${total} ${total === 1 ? 'file' : 'files'}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  })();

  const emptyState = () => {
    const suggestions: Array<[string, () => void]> = [];
    const words = filters.q.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) suggestions.push(['Use fewer words', () => update({ q: words.slice(0, -1).join(' ') })]);
    if (filters.type) suggestions.push([`All ${filters.category} files`, () => update({ type: null })]);
    else if (filters.category) suggestions.push(['All categories', () => update({ category: null, type: null })]);
    if (filters.topic) suggestions.push(['Any topic', () => update({ topic: null })]);
    if (filters.format !== 'all') suggestions.push(['All formats', () => update({ format: null })]);
    if (filters.date !== 'any') suggestions.push(['Any time', () => update({ date: null })]);
    if (filters.location !== 'everywhere') suggestions.push(['Search everywhere', () => update({ location: null })]);
    let title = 'No files matched those words.';
    if (!words.length) {
      const what = filters.type ? plural(filters.type) : filters.category ? `${filters.category} files` : 'files';
      title = `No ${what} found${dateWords(filters) ? ` ${dateWords(filters)}` : ''}.`;
    }
    return (
      <div className="adv-empty" role="status">
        <p className="adv-empty-title">{title}</p>
        {suggestions.length > 0 && (
          <>
            <p>{words.length ? 'Try searching for fewer words or removing a filter:' : 'Try removing a filter:'}</p>
            <div className="adv-empty-actions">{suggestions.map(([label, run]) => <button type="button" key={label} onClick={run}>{label}</button>)}</div>
          </>
        )}
      </div>
    );
  };

  const filterControls = (
    <>
      <label className="adv-field">
        <span>Category</span>
        <select value={filters.category} onChange={event => update({ category: event.target.value || null, type: typesFor(event.target.value).includes(filters.type) ? filters.type : null })}>
          <option value="">All categories</option>
          {CATEGORIES.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label className="adv-field">
        <span>Document type</span>
        <select value={filters.type} disabled={!filters.category} onChange={event => update({ type: event.target.value || null })}>
          <option value="">All document types</option>
          {typesFor(filters.category).map(type => {
            const count = typeCount(type);
            return <option key={type} value={type}>{count !== undefined ? `${type} (${count})` : type}</option>;
          })}
        </select>
      </label>
      <label className="adv-field">
        <span>Format</span>
        <select value={filters.format} onChange={event => update({ format: event.target.value })}>
          {FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="adv-field">
        <span>Date</span>
        <select value={filters.date} onChange={event => update({ date: event.target.value })}>
          {DATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {filters.date !== 'any' && (
        <label className="adv-field">
          <span>Date applies to</span>
          <select value={filters.dateField} onChange={event => update({ dateField: event.target.value })}>
            <option value="modified">Modified (contents changed)</option>
            <option value="uploaded">Uploaded</option>
          </select>
        </label>
      )}
      {filters.date === 'custom' && (
        <>
          <label className="adv-field adv-field-date">
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={event => update({ from: event.target.value || null })} />
          </label>
          <label className="adv-field adv-field-date">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={event => update({ to: event.target.value || null })} />
          </label>
        </>
      )}
      <label className="adv-field">
        <span>Location</span>
        <select value={filters.location} onChange={event => update({ location: event.target.value })}>
          <option value="everywhere">Everywhere</option>
          {filters.folder && <option value="folder">{folderName ? `This folder (${folderName})` : 'Current folder'}</option>}
          <option value="my-files">My Files</option>
          <option value="shared">Shared with me</option>
          {hasTeams && <option value="team">Team Spaces</option>}
        </select>
      </label>
      <label className="adv-field">
        <span>Sort by</span>
        <select value={filters.sort} onChange={event => update({ sort: event.target.value })}>
          {SORTS.map(([value, label]) => (
            <option key={value} value={value} disabled={!filters.q.trim() && (value === 'best' || value === 'content')}>{label}</option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <section className="adv-search" aria-labelledby="adv-search-title">
      <header className="adv-head">
        <h1 id="adv-search-title">Advanced Search</h1>
        <p>Find files by what is written inside them or by what kind of document they are.</p>
      </header>

      <form className="adv-query" role="search" onSubmit={event => { event.preventDefault(); update({ q: input.trim() ? input : null }); }}>
        <label htmlFor="adv-query-input">Words or text you remember</label>
        <div className="adv-query-row">
          <input id="adv-query-input" ref={inputRef} type="search" value={input} autoComplete="off" maxLength={300}
            placeholder="Try a sentence, topic, amount, name, or phrase…" onChange={event => setInput(event.target.value)} />
          <button type="button" className="adv-filters-toggle" aria-expanded={sheetOpen} aria-controls="adv-filters" onClick={() => setSheetOpen(true)}>
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </button>
        </div>
        <p className="adv-query-examples">For example: “May 2026”, “invoice total”, “semaphores”, “Air France”</p>
      </form>

      {sheetOpen && <button type="button" className="adv-sheet-backdrop" aria-label="Close filters" onClick={() => setSheetOpen(false)} />}
      <div id="adv-filters" className={`adv-filters ${sheetOpen ? 'is-open' : ''}`} role="group" aria-label="Filters">
        <div className="adv-sheet-head">
          <strong>Filters</strong>
          <button type="button" className="adv-button-quiet" onClick={clearFilters} disabled={!activeFilters}>Clear</button>
        </div>
        {filterControls}
        {activeFilters > 0 && <button type="button" className="adv-clear adv-button-quiet" onClick={clearFilters}>Clear filters</button>}
        <button type="button" className="adv-sheet-done adv-button-primary" onClick={() => setSheetOpen(false)}>Show {data ? `${data.total} ${data.total === 1 ? 'result' : 'results'}` : 'results'}</button>
      </div>

      {filters.topic && (
        <p className="adv-pills">
          <button type="button" className="adv-pill" onClick={() => update({ topic: null })} aria-label={`Remove topic filter ${filters.topic}`}>
            Topic: {filters.topic} <span aria-hidden="true">×</span>
          </button>
        </p>
      )}

      <nav className="adv-browse" aria-label={filters.category ? `${filters.category} document types` : 'Browse by category'}>
        {!filters.category ? (
          <ul className="adv-chip-row">
            {CATEGORIES.map(name => {
              const count = categoryCount(name);
              return (
                <li key={name}>
                  <button type="button" className={`adv-tile ${count ? '' : 'is-empty'}`} disabled={!count} onClick={() => update({ category: name, type: null })}>
                    <span>{name}</span><strong>{count}</strong>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="adv-chip-row">
            <li>
              <button type="button" className={`adv-type-chip ${filters.type ? '' : 'is-active'}`} aria-pressed={!filters.type} onClick={() => update({ type: null })}>
                All {filters.category}
              </button>
            </li>
            {typeChips.map(group => (
              <li key={group.name}>
                <button type="button" className={`adv-type-chip ${filters.type === group.name ? 'is-active' : ''}`} aria-pressed={filters.type === group.name}
                  onClick={() => update({ type: filters.type === group.name ? null : group.name })}>
                  {group.name} <strong>{group.count}</strong>
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="adv-type-chip adv-type-back" onClick={() => update({ category: null, type: null })}>All categories</button>
            </li>
          </ul>
        )}
        <p className="adv-browse-note">Grouped by what each file is. Files stay in their folders.</p>
      </nav>

      <p className="adv-summary" aria-live="polite">{summary}</p>
      <p className="adv-announcement" role="status" aria-live="polite">{announcement}</p>

      {error === 'folder' && (
        <div className="adv-empty" role="status">
          <p className="adv-empty-title">This folder isn't available.</p>
          <p>It may have been moved, deleted, or you no longer have access to it.</p>
          <div className="adv-empty-actions"><button type="button" onClick={() => update({ location: null, folder: null })}>Search everywhere</button></div>
        </div>
      )}
      {error === 'failed' && (
        <div className="adv-empty" role="alert">
          <p className="adv-empty-title">Search isn't available right now.</p>
          <div className="adv-empty-actions"><button type="button" onClick={() => setRefreshKey(k => k + 1)}>Try again</button></div>
        </div>
      )}
      {!error && data && data.total === 0 && !loading && emptyState()}

      {!error && results.length > 0 && (
        <ul className={`adv-results ${loading ? 'is-loading' : ''}`} aria-busy={loading} aria-label="Search results">
          {results.map(result => (
            <AdvancedSearchResult key={result._id} result={result} taxonomy={taxonomy} dateField={filters.dateField} activeTopic={filters.topic}
              onOpen={openResult} onShowInFolder={showInFolder} onTopic={topic => update({ topic })} onChanged={changed} onStarred={starred} />
          ))}
        </ul>
      )}
      {!error && data && results.length < data.total && (
        <div className="adv-more">
          <button type="button" className="adv-button-secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : `Show more (${data.total - results.length} more)`}
          </button>
        </div>
      )}

      {opened && (
        <FilePreview file={{ ...opened, access: opened.access.role } as unknown as FileItemType} onClose={closePreview} />
      )}
    </section>
  );
};

export default AdvancedSearch;

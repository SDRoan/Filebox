import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardBlock, BoardConnector } from '../services/api';
import { getBoardConnections } from '../services/boardConnections';
import { buildGraph, GraphConnections, GraphFilters, NO_FILTERS, RelationshipType, visibleGraph } from '../utils/boardGraph';
import { createLayoutMemo, GraphLayout, navigationOf } from '../utils/boardGraphLayout';
import { matchNodes, scrollToShow } from '../utils/boardGraphDraw';
import BoardGraph from './BoardGraph';
import BoardConnectionsPhone from './BoardConnectionsPhone';
import './BoardConnections.css';

/**
 * Boards > Connections: what is joined to what on the open Board. Board connectors come from the Board as it is on
 * screen, unsaved changes included, so they show at once; file relationships load beside them. Looking at this view
 * saves nothing and adds nothing to the Board.
 */

interface BoardConnectionsViewProps {
  tabId: string;
  blocks: BoardBlock[];
  connectors: BoardConnector[];
  saveState: string;
  loading: boolean;
  error: string;
  phone: boolean;
  onShowCanvas: () => void;
  onAnnounce: (text: string) => void;
}

const NONE: GraphConnections = { relationships: [], unavailable: [], files: [], truncated: false };
const REFRESH_AFTER = 30000;
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const BoardConnectionsView: React.FC<BoardConnectionsViewProps> = ({ tabId, blocks, connectors, saveState, loading, error, phone, onShowCanvas, onAnnounce }) => {
  const [connections, setConnections] = useState<GraphConnections | null>(null);
  const [fetching, setFetching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filters, setFilters] = useState<GraphFilters>(NO_FILTERS);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);

  // The relationships are worked out from the saved Board: ask again once a new file on it has been saved.
  const fileKey = useMemo(() => {
    const ids = new Set<string>();
    blocks.forEach((b) => {
      if (b.type === 'file' && b.ref.available && b.ref.fileId) ids.add(b.ref.fileId);
      if (b.type === 'filelist') b.filelist.items.forEach((row) => { if (row.ref.available && row.ref.fileId) ids.add(row.ref.fileId); });
    });
    return Array.from(ids).sort().join(',');
  }, [blocks]);
  const settled = saveState !== 'waiting' && saveState !== 'saving';
  // What to ask for. A save still pending (a removal waits out its Undo) never holds this up: ask now, and once more when it lands.
  const [wanted, setWanted] = useState('');
  const lastLoaded = useRef(0);
  useEffect(() => {
    if (loading || error) return;
    setWanted(current => (settled ? `${fileKey}#${retry}` : current || `${fileKey}#${retry}#before-save`));
  }, [fileKey, retry, settled, loading, error]);

  useEffect(() => {
    if (!wanted) return undefined;
    const controller = new AbortController();
    setFetching(true);
    getBoardConnections(tabId, 'board', controller.signal).then((data) => {
      lastLoaded.current = Date.now();
      setConnections(data);
      setFailed(false);
      setFetching(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setFailed(true);
      setFetching(false);
    });
    return () => controller.abort();
  }, [tabId, wanted]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && lastLoaded.current && Date.now() - lastLoaded.current > REFRESH_AFTER) setRetry(n => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const model = useMemo(() => buildGraph({ scope: 'board', blocks, connectors, connections: connections || NONE }), [blocks, connectors, connections]);
  // One layout per structure: a re-render, a rename or a filter reuses it.
  const layoutOf = useRef(createLayoutMemo());
  const layout = layoutOf.current(model);
  const visible = useMemo(() => visibleGraph(model, filters), [model, filters]);

  // Keys move only among what is showing, so the layout handed over is narrowed to that (positions unchanged).
  const shownLayout = useMemo<GraphLayout>(() => ({
    ...layout, positions: new Map(Array.from(layout.positions).filter(([key]) => visible.nodes.has(key))), order: layout.order.filter(key => visible.nodes.has(key)),
  }), [layout, visible]);
  const navigation = useMemo(() => navigationOf({ ...model, nodes: model.nodes.filter(n => visible.nodes.has(n.key)), edges: model.edges.filter(e => visible.edges.has(e.key)) }, shownLayout), [model, visible, shownLayout]);

  const searching = query.trim().length > 0;
  const matchList = useMemo(() => {
    const found = new Set(matchNodes(model.nodes.filter(n => visible.nodes.has(n.key)), query));
    return shownLayout.order.filter(key => found.has(key));
  }, [model.nodes, visible, query, shownLayout]);
  const matches = useMemo(() => (searching ? new Set(matchList) : null), [searching, matchList]);
  const safeIndex = matchList.length ? matchIndex % matchList.length : 0;
  const currentMatch = matchList[safeIndex] ?? null;
  const stepMatch = (by: number) => { if (matchList.length) setMatchIndex((safeIndex + by + matchList.length) % matchList.length); };

  // A filter reached by keyboard comes fully into view. Only its own row scrolls, never the page.
  const showFilter = (event: React.FocusEvent<HTMLDivElement>) => {
    const row = event.currentTarget;
    // Rectangles are in screen pixels; File Box zooms the workspace for its Text size setting.
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--fb-zoom')) || 1;
    const box = row.getBoundingClientRect(), chip = (event.target as HTMLElement).getBoundingClientRect();
    row.scrollLeft = scrollToShow(row.scrollLeft + (chip.left - box.left) / zoom, chip.width / zoom, row.scrollLeft, row.clientWidth, 8);
  };

  const toggleSystem = (field: 'showBoard' | 'showFile') => setFilters(f => ({ ...f, [field]: !f[field] }));
  const toggleType = (type: RelationshipType) => setFilters((f) => {
    const hiddenTypes = new Set(f.hiddenTypes);
    if (hiddenTypes.has(type)) hiddenTypes.delete(type); else hiddenTypes.add(type);
    return { ...f, hiddenTypes };
  });
  const filtered = !filters.showBoard || !filters.showFile || filters.hiddenTypes.size > 0;
  const { legend, omitted, unavailable, truncated } = { ...model };
  const loadingFirst = !connections && !failed;

  const toolbar = (
    <>
      <div className="board-connections-search">
        <input type="search" value={query} placeholder="Find an item" aria-label="Find an item in this graph"
          onChange={(event) => { setQuery(event.target.value); setMatchIndex(0); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); } }} />
        {searching && <span className="board-connections-search-count" role="status">{matchList.length ? `${safeIndex + 1} of ${matchList.length}` : 'No matches'}</span>}
      </div>
      <div className="board-connections-filters" role="group" aria-label="Show" onFocus={showFilter}>
        <button type="button" className="board-connections-chip is-board" aria-pressed={filters.showBoard} onClick={() => toggleSystem('showBoard')}><span className="board-connections-swatch" aria-hidden="true" />Board connectors ({legend.board.total})</button>
        <button type="button" className="board-connections-chip is-file" aria-pressed={filters.showFile} onClick={() => toggleSystem('showFile')}><span className="board-connections-swatch" aria-hidden="true" />File relationships ({legend.file.total})</button>
        {filters.showFile && legend.types.map(t => (
          <button key={t.type} type="button" className={`board-connections-chip is-type type-${t.type}`} aria-pressed={!filters.hiddenTypes.has(t.type)} onClick={() => toggleType(t.type)}>{t.label} ({t.count})</button>
        ))}
      </div>
    </>
  );

  if (loading) return <section className="board-connections" aria-busy="true"><p className="boards-status">Loading this board…</p></section>;
  if (error) return <section className="board-connections"><div className="board-connections-empty" role="alert"><p>{error}</p></div></section>;

  const nothingConnected = model.edges.length === 0 && model.nodes.length === 0;
  const nothingShowing = !nothingConnected && visible.nodes.size === 0;

  return (
    <section className="board-connections" aria-label="Connections">
      <div className="board-connections-notices">
        {loadingFirst && <p className="board-connections-note is-loading" role="status"><span className="board-connections-dot" aria-hidden="true" />Loading file relationships…</p>}
        {failed && (
          <p className="board-connections-note is-error" role="alert">
            File relationships couldn't be loaded. {connections ? 'Showing the last ones found.' : 'Board connectors are still shown.'}
            <button type="button" onClick={() => setRetry(n => n + 1)} disabled={fetching}>Retry</button>
          </p>
        )}
      </div>

      {phone ? (
        <>
          <div className="board-graph-toolbar is-phone"><div className="board-graph-tools">{toolbar}</div></div>
          <BoardConnectionsPhone model={model} order={navigation.order} visibleEdges={visible.edges} matches={matches} />
        </>
      ) : (
        <BoardGraph model={model} layout={layout} navigation={navigation} visibleNodes={visible.nodes} visibleEdges={visible.edges} matches={matches} currentMatch={currentMatch} toolbar={toolbar} onAnnounce={onAnnounce} />
      )}

      {nothingConnected && !loadingFirst && (
        <div className="board-connections-empty">
          <p className="board-connections-empty-title">Nothing is connected on this Board yet.</p>
          <p>Draw a connector between two items on the Canvas, or link files from a file's Connections option.</p>
          <button type="button" className="boards-button-secondary" onClick={onShowCanvas}>Go to Canvas</button>
        </div>
      )}
      {nothingShowing && (
        <div className="board-connections-empty">
          <p className="board-connections-empty-title">Nothing matches these filters.</p>
          <button type="button" className="boards-button-secondary" onClick={() => setFilters(NO_FILTERS)}>Show everything</button>
        </div>
      )}
      {phone && searching && !matchList.length && !nothingConnected && !nothingShowing && <p className="board-connections-empty">No items match your search.</p>}

      {!nothingShowing && (truncated || omitted.nodes > 0 || unavailable.total > 0) && (
        <div className="board-connections-notes">
          {truncated && <p className="board-connections-note" role="status">Showing the newest 500 file relationships. Some older ones aren't included.</p>}
          {omitted.nodes > 0 && <p className="board-connections-note" role="status">The graph shows up to 300 items, so {count(omitted.nodes, 'item')} and {count(omitted.edges, 'connection')} aren't drawn.</p>}
          {unavailable.total > 0 && <p className="board-connections-note" role="status">{count(unavailable.total, 'connection')} {unavailable.total === 1 ? 'goes' : 'go'} to files you can't open right now.</p>}
        </div>
      )}

      {!phone && !nothingConnected && (
        <ul className="board-connections-legend" aria-label="Legend">
          <li><svg width="34" height="10" aria-hidden="true"><line className="is-board" x1="1" y1="5" x2="33" y2="5" /></svg>Board connector</li>
          <li><svg width="34" height="10" aria-hidden="true"><line className="is-file" x1="1" y1="5" x2="33" y2="5" /></svg>File relationship</li>
          <li><svg width="34" height="10" aria-hidden="true"><line className="is-board" x1="1" y1="5" x2="25" y2="5" /><path className="is-head" d="M33,5 L25,1 L25,9 Z" /></svg>Has a direction</li>
          <li><span className="board-connections-legend-card is-item" aria-hidden="true" />On this Board</li>
          <li><span className="board-connections-legend-card is-list-file" aria-hidden="true" />In a File List</li>
          <li><span className="board-connections-legend-card is-off-board" aria-hidden="true" />Not on this Board</li>
        </ul>
      )}
      {filtered && !nothingShowing && <p className="boards-visually-hidden" role="status">Filters on: {count(visible.edges.size, 'connection')} showing.</p>}
    </section>
  );
};

export default BoardConnectionsView;

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GraphEdge, GraphModel, GraphNode, relationshipLabel } from '../utils/boardGraph';
import { GraphLayout, GraphNavigation, NODE_H, NODE_W } from '../utils/boardGraphLayout';
import { edgeShape, EdgeShape, fitScale, MAX_SCALE, MIN_SCALE, nextScale, scrollToShow, WORLD_PAD, worldSize } from '../utils/boardGraphDraw';
import { ITEM_ICONS } from './BoardItemIcons';

/**
 * The Connections graph: real buttons for the nodes, one SVG underneath for the edges (like the Canvas), inside its own
 * scrolling frame so the page never moves. Positions come from the layout and are only ever read here. Filters and
 * search hide or dim things; zoom scales the drawing. None of them touch the layout or anything saved.
 */

const FRAME_MIN = 320;
const FRAME_MAX = 1100;
// Room under the frame for the notes, the legend and the page's own padding.
const FRAME_BELOW = 112;

const WHERE = { item: 'On this Board', 'list-file': 'In a File List', 'off-board': 'Not on this Board' } as const;
const edgeWords = (edge: GraphEdge) => (edge.system === 'file' ? relationshipLabel(edge) : edge.style === 'arrow' ? 'Board arrow' : 'Board line');

const NodeCard = React.memo(({ node, x, y, tabbable, selected, dim, match, current, label, onPick }: {
  node: GraphNode; x: number; y: number; tabbable: boolean; selected: boolean; dim: boolean; match: boolean; current: boolean; label: string; onPick: (key: string) => void;
}) => (
  <button type="button" data-node-key={node.key} tabIndex={tabbable ? 0 : -1} aria-label={label} aria-pressed={selected}
    className={`board-graph-node is-${node.kind}${node.available ? '' : ' is-unavailable'}${selected ? ' is-selected' : ''}${dim ? ' is-dim' : ''}${match ? ' is-match' : ''}${current ? ' is-current-match' : ''}`}
    style={{ left: x, top: y, width: NODE_W, height: NODE_H }} title={node.name} onClick={() => onPick(node.key)}>
    <span className="board-graph-node-icon" aria-hidden="true">{ITEM_ICONS[node.itemType]}</span>
    <span className="board-graph-node-text">
      <span className="board-graph-node-name">{node.shortName}</span>
      <span className="board-graph-node-where">{node.available ? WHERE[node.kind] : 'Unavailable'}</span>
    </span>
  </button>
));

const EdgePath = React.memo(({ edgeKey, shape, system, type, dim, related, active, onHover, onPick }: {
  edgeKey: string; shape: EdgeShape; system: 'board' | 'file'; type: string; dim: boolean; related: boolean; active: boolean; onHover: (key: string | null) => void; onPick: (key: string) => void;
}) => (
  <g className={`board-graph-edge is-${system}${system === 'file' ? ` type-${type}` : ''}${dim ? ' is-dim' : ''}${related ? ' is-related' : ''}${active ? ' is-active' : ''}`} data-edge-key={edgeKey}>
    {active && <path className="board-graph-edge-halo" d={shape.d} />}
    <path className="board-graph-edge-line" d={shape.d} />
    {shape.head && <path className="board-graph-edge-head" d={shape.head} />}
    <path className="board-graph-edge-hit" d={shape.d} onPointerEnter={() => onHover(edgeKey)} onPointerLeave={() => onHover(null)}
      onClick={(event) => { event.stopPropagation(); onPick(edgeKey); }} />
  </g>
));

interface BoardGraphProps {
  model: GraphModel;
  layout: GraphLayout;
  navigation: GraphNavigation;
  visibleNodes: Set<string>;
  visibleEdges: Set<string>;
  matches: Set<string> | null;
  currentMatch: string | null;
  toolbar: React.ReactNode;
  onAnnounce: (text: string) => void;
}

const BoardGraph: React.FC<BoardGraphProps> = ({ model, layout, navigation, visibleNodes, visibleEdges, matches, currentMatch, toolbar, onAnnounce }) => {
  const viewRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const size = worldSize(layout.width, layout.height);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // Until the person zooms, the graph keeps fitting its frame.
  const fitting = useRef(true);
  const keepCentre = useRef<{ x: number; y: number } | null>(null);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [focusedEdge, setFocusedEdge] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const tabStop = current && navigation.nodes.has(current) ? current : navigation.order[0] ?? null;

  const edgeByKey = useMemo(() => new Map(model.edges.map(e => [e.key, e])), [model.edges]);
  const shapes = useMemo(() => {
    const out = new Map<string, EdgeShape>();
    model.edges.forEach((e) => {
      const a = layout.positions.get(e.source), b = layout.positions.get(e.target);
      if (!a || !b) return;
      out.set(e.key, edgeShape({ x: a.x + WORLD_PAD, y: a.y + WORLD_PAD }, { x: b.x + WORLD_PAD, y: b.y + WORLD_PAD }, NODE_W, NODE_H, e.parallelIndex, e.parallelCount, e.directed));
    });
    return out;
  }, [model.edges, layout]);

  // What is joined to the selected node or edge: everything else steps back.
  const related = useMemo(() => {
    if (selectedEdge) {
      const edge = edgeByKey.get(selectedEdge);
      return edge ? { nodes: new Set([edge.source, edge.target]), edges: new Set([edge.key]) } : null;
    }
    if (!selectedNode) return null;
    const nodes = new Set([selectedNode]);
    const edges = new Set<string>();
    model.edges.forEach((e) => {
      if (!visibleEdges.has(e.key) || (e.source !== selectedNode && e.target !== selectedNode)) return;
      edges.add(e.key);
      nodes.add(e.source);
      nodes.add(e.target);
    });
    return { nodes, edges };
  }, [selectedNode, selectedEdge, edgeByKey, model.edges, visibleEdges]);

  useEffect(() => {
    if (selectedNode && !visibleNodes.has(selectedNode)) setSelectedNode(null);
    if (selectedEdge && !visibleEdges.has(selectedEdge)) setSelectedEdge(null);
  }, [selectedNode, selectedEdge, visibleNodes, visibleEdges]);

  // ---- The frame takes the room left on screen, leaving the legend in view, so the page rarely needs to scroll as well.
  const [frameHeight, setFrameHeight] = useState<number | undefined>(undefined);
  const measureFrame = useCallback(() => {
    const view = viewRef.current;
    const page = view?.closest('.dashboard-content');
    if (!view || !page) return;
    // Rectangles are in screen pixels; File Box zooms the workspace for its Text size setting.
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--fb-zoom')) || 1;
    const top = (view.getBoundingClientRect().top - page.getBoundingClientRect().top) / zoom + page.scrollTop;
    const next = Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, page.clientHeight - top - FRAME_BELOW)));
    setFrameHeight(current => (current !== undefined && Math.abs(current - next) < 2 ? current : next));
  }, []);
  // Anything above it can change its place (a notice, the filters wrapping), so this looks after every draw.
  useLayoutEffect(measureFrame);
  useEffect(() => {
    window.addEventListener('resize', measureFrame);
    return () => window.removeEventListener('resize', measureFrame);
  }, [measureFrame]);

  // ---- Zoom
  const refit = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    keepCentre.current = null;
    setScale(fitScale(size.width, size.height, view.clientWidth, view.clientHeight));
  }, [size.width, size.height]);

  useLayoutEffect(() => { if (fitting.current) refit(); }, [refit]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => { if (fitting.current) refit(); });
    observer.observe(view);
    return () => observer.disconnect();
  }, [refit]);

  const zoomTo = (next: number) => {
    const view = viewRef.current;
    if (!view) return;
    fitting.current = false;
    keepCentre.current = { x: (view.scrollLeft + view.clientWidth / 2) / scaleRef.current, y: (view.scrollTop + view.clientHeight / 2) / scaleRef.current };
    setScale(next);
  };
  const fit = () => {
    fitting.current = true;
    refit();
    if (viewRef.current) { viewRef.current.scrollLeft = 0; viewRef.current.scrollTop = 0; }
  };
  useLayoutEffect(() => {
    const view = viewRef.current, centre = keepCentre.current;
    if (!view || !centre) return;
    keepCentre.current = null;
    view.scrollLeft = centre.x * scale - view.clientWidth / 2;
    view.scrollTop = centre.y * scale - view.clientHeight / 2;
  }, [scale]);

  // ---- Keeping something in the frame (only the frame scrolls, never the page)
  const reveal = useCallback((x: number, y: number, width: number, height: number) => {
    const view = viewRef.current;
    if (!view) return;
    const s = scaleRef.current;
    view.scrollLeft = scrollToShow(x * s, width * s, view.scrollLeft, view.clientWidth);
    view.scrollTop = scrollToShow(y * s, height * s, view.scrollTop, view.clientHeight);
  }, []);
  const revealNode = useCallback((key: string) => {
    const at = layout.positions.get(key);
    if (at) reveal(at.x + WORLD_PAD, at.y + WORLD_PAD, NODE_W, NODE_H);
  }, [layout, reveal]);
  useEffect(() => { if (currentMatch) revealNode(currentMatch); }, [currentMatch, revealNode]);

  // ---- Choosing
  const nodeRefName = (key: string) => model.nodes.find(n => n.key === key)?.shortName || 'Item';
  const pickNode = useCallback((key: string) => {
    setCurrent(key);
    setSelectedEdge(null);
    setSelectedNode(key);
    onAnnounce(`Selected: ${navigation.nodes.get(key)?.label || ''}`);
  }, [navigation, onAnnounce]);
  const pickEdge = useCallback((key: string) => {
    setSelectedNode(null);
    setSelectedEdge(key);
    onAnnounce(`Selected: ${navigation.edges.get(key) || ''}`);
  }, [navigation, onAnnounce]);
  const clear = () => {
    if (selectedNode || selectedEdge) onAnnounce('Selection cleared');
    setSelectedNode(null);
    setSelectedEdge(null);
  };

  const focusNode = (key: string) => {
    setCurrent(key);
    worldRef.current?.querySelector<HTMLElement>(`[data-node-key="${key}"]`)?.focus({ preventScroll: true });
    revealNode(key);
  };
  const onNodeKeys = (event: React.KeyboardEvent) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-node-key]')?.dataset.nodeKey;
    if (!key) return;
    const entry = navigation.nodes.get(key);
    if (!entry) return;
    const target = { ArrowLeft: entry.left, ArrowRight: entry.right, ArrowUp: entry.up, ArrowDown: entry.down, Home: navigation.order[0], End: navigation.order[navigation.order.length - 1] }[event.key];
    if (event.key === 'Escape') { event.preventDefault(); clear(); return; }
    if (target === undefined) return;
    event.preventDefault();
    if (target) focusNode(target);
  };

  // ---- The edges as one Tab stop, with arrow keys between them
  const edgeList = useMemo(() => model.edges.filter(e => visibleEdges.has(e.key)), [model.edges, visibleEdges]);
  const [edgeStop, setEdgeStop] = useState<string | null>(null);
  const edgeTab = edgeStop && visibleEdges.has(edgeStop) ? edgeStop : edgeList[0]?.key ?? null;
  const edgeKeysRef = useRef<HTMLDivElement>(null);
  const onEdgeKeys = (event: React.KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      const next = edgeList[(index + step + edgeList.length) % edgeList.length];
      edgeKeysRef.current?.querySelector<HTMLElement>(`[data-edge-button="${next.key}"]`)?.focus({ preventScroll: true });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pickEdge(edgeList[index].key);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clear();
    }
  };
  const focusEdge = (edge: GraphEdge) => {
    setEdgeStop(edge.key);
    setFocusedEdge(edge.key);
    const shape = shapes.get(edge.key);
    if (shape) reveal(shape.x - 40, shape.y - 20, 80, 40);
  };

  const labelled = Array.from(new Set([selectedEdge, hoveredEdge, focusedEdge].filter((k): k is string => Boolean(k) && visibleEdges.has(k as string))));
  const zoomLabel = `${Math.round(scale * 100)}%`;

  return (
    <div className="board-graph">
      <div className="board-graph-toolbar">
        <div className="board-graph-tools">{toolbar}</div>
        <div className="board-graph-zoom" role="group" aria-label="Graph zoom">
          <button type="button" onClick={() => zoomTo(nextScale(scale, -1))} disabled={scale <= MIN_SCALE} aria-label="Zoom out" title="Zoom out">−</button>
          <span className="board-graph-zoom-level" role="status">{zoomLabel}</span>
          <button type="button" onClick={() => zoomTo(nextScale(scale, 1))} disabled={scale >= MAX_SCALE} aria-label="Zoom in" title="Zoom in">+</button>
          <button type="button" onClick={fit}>Fit</button>
          <button type="button" onClick={() => zoomTo(1)}>Reset</button>
        </div>
      </div>
      <div ref={viewRef} className="board-graph-view" style={frameHeight ? { height: frameHeight } : undefined} onClick={clear}>
        <div className="board-graph-spacer" style={{ width: size.width * scale, height: size.height * scale }}>
          <div ref={worldRef} className="board-graph-world" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }} role="group"
            aria-label={`Connections graph, ${visibleNodes.size} ${visibleNodes.size === 1 ? 'item' : 'items'}`} aria-describedby="board-graph-help" onKeyDown={onNodeKeys} onClick={(event) => event.stopPropagation()}>
            <svg className="board-graph-edges" width={size.width} height={size.height} aria-hidden="true" focusable="false" onClick={clear}>
              {model.edges.map((e) => {
                const shape = shapes.get(e.key);
                if (!shape || !visibleEdges.has(e.key)) return null;
                const touchesMatch = !matches || matches.has(e.source) || matches.has(e.target);
                return <EdgePath key={e.key} edgeKey={e.key} shape={shape} system={e.system} type={e.system === 'file' ? e.type : ''}
                  dim={Boolean(related && !related.edges.has(e.key)) || !touchesMatch} related={Boolean(related?.edges.has(e.key))} active={labelled.includes(e.key)} onHover={setHoveredEdge} onPick={pickEdge} />;
              })}
            </svg>
            {model.nodes.map((node) => {
              const at = layout.positions.get(node.key);
              if (!at || !visibleNodes.has(node.key)) return null;
              return <NodeCard key={node.key} node={node} x={at.x + WORLD_PAD} y={at.y + WORLD_PAD} tabbable={node.key === tabStop} selected={node.key === selectedNode}
                dim={Boolean(related && !related.nodes.has(node.key)) || Boolean(matches && !matches.has(node.key))} match={Boolean(matches?.has(node.key))} current={node.key === currentMatch}
                label={navigation.nodes.get(node.key)?.label || node.shortName} onPick={pickNode} />;
            })}
            {labelled.map((key) => {
              const edge = edgeByKey.get(key), shape = shapes.get(key);
              if (!edge || !shape) return null;
              return <span key={key} className="board-graph-edge-label" style={{ left: shape.x, top: shape.y }} aria-hidden="true">{edgeWords(edge)}</span>;
            })}
          </div>
        </div>
      </div>
      <p id="board-graph-help" className="boards-visually-hidden">Arrow keys move between items. Home and End go to the first and last. Enter selects. Escape clears.</p>
      {edgeList.length > 0 && (
        <div ref={edgeKeysRef} className="boards-visually-hidden" role="group" aria-label={`Connections (${edgeList.length})`}>
          {edgeList.map((edge, i) => (
            <button key={edge.key} type="button" data-edge-button={edge.key} tabIndex={edge.key === edgeTab ? 0 : -1} aria-pressed={edge.key === selectedEdge}
              aria-label={navigation.edges.get(edge.key) || `${nodeRefName(edge.source)} to ${nodeRefName(edge.target)}`}
              onFocus={() => focusEdge(edge)} onBlur={() => setFocusedEdge(null)} onKeyDown={(event) => onEdgeKeys(event, i)}>
              {navigation.edges.get(edge.key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default BoardGraph;

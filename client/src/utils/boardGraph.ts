import type { BoardBlock, BoardConnector } from '../services/api';
import { itemName } from './boardConnectors';

/**
 * The Connections graph of a Board: file relationships (account-level facts between files) and Board connectors (lines
 * on one tab), drawn together and never merged. Every record stays one edge of its own system. Pure: nothing here
 * reads the network, writes anything, or changes what it is given.
 *
 * A relationship with an end the person cannot open is no node and no edge. It is only counted, apart from the graph,
 * and carries nothing but its own record id and the id of an end they can still open.
 */

export type RelationshipType = 'related' | 'depends_on' | 'references' | 'part_of' | 'version_of' | 'duplicate_of' | 'custom';
export type GraphScope = 'board' | 'all';

export const RELATIONSHIP_TYPES: Array<{ type: RelationshipType; label: string }> = [
  { type: 'related', label: 'Related to' },
  { type: 'depends_on', label: 'Depends on' },
  { type: 'references', label: 'References' },
  { type: 'part_of', label: 'Part of' },
  { type: 'version_of', label: 'Version of' },
  { type: 'duplicate_of', label: 'Duplicate of' },
  { type: 'custom', label: 'Custom' },
];

export const MAX_GRAPH_NODES = 300;
export const MAX_GRAPH_RELATIONSHIPS = 500;
export const MAX_GRAPH_CONNECTORS = 300;
export const MAX_GRAPH_EDGES = MAX_GRAPH_RELATIONSHIPS + MAX_GRAPH_CONNECTORS;

// ---- What comes in: GET /workspace-boards/tabs/:tabId/connections

export interface GraphRelationship { id: string; source: string; target: string; type: RelationshipType; label: string; description: string; createdAt: string }
export interface GraphFile { fileId: string; name: string; mimeType: string; size: number; source: 'owned' | 'shared' | 'team' }
export interface GraphConnections { relationships: GraphRelationship[]; unavailable: Array<{ id: string; fileId: string | null }>; files: GraphFile[]; truncated: boolean }
export interface GraphInput { scope: GraphScope; blocks: BoardBlock[]; connectors: BoardConnector[]; connections: GraphConnections }

// ---- What comes out

/** A place a file sits on this Board. Rows count from 0. */
export type GraphLocation = { kind: 'card'; blockId: string } | { kind: 'list'; blockId: string; rowId: string; rowIndex: number };

/** 'item': on the Board itself. 'list-file': only in a File List. 'off-board': one hop out, "Not on this Board". */
export type GraphNodeKind = 'item' | 'list-file' | 'off-board';

export interface GraphNode {
  /** file:<id> for a file they can open, wherever it is; item:<block id> for anything else on the Board. */
  key: string;
  kind: GraphNodeKind;
  name: string;
  /** Short, and told apart when names repeat ("Report.pdf · 2"). */
  shortName: string;
  itemType: BoardBlock['type'];
  fileId: string | null;
  mimeType: string | null;
  available: boolean;
  onBoard: boolean;
  /** Every place it sits, the file card first; locations[0] is where to reveal it. */
  locations: GraphLocation[];
  degree: number;
  unavailableCount: number;
}

interface EdgeBase {
  key: string;
  recordId: string;
  source: string;
  target: string;
  directed: boolean;
  /** Edges between the same two nodes, so they can be drawn side by side. */
  parallelIndex: number;
  parallelCount: number;
}
export interface BoardConnectorEdge extends EdgeBase { system: 'board'; style: BoardConnector['style'] }
export interface FileRelationshipEdge extends EdgeBase { system: 'file'; type: RelationshipType; label: string; description: string; createdAt: string }
export type GraphEdge = BoardConnectorEdge | FileRelationshipEdge;

export interface GraphUnavailable {
  total: number;
  /** recordId is for removing it; fileId is only ever an end they can open. */
  rows: Array<{ recordId: string; fileId: string | null }>;
}
export interface GraphLegend {
  board: { total: number; line: number; arrow: number };
  file: { total: number };
  types: Array<{ type: RelationshipType; label: string; count: number }>;
}
export interface GraphOmitted { nodes: number; edges: number; byKind: Record<GraphNodeKind, number> }

export interface GraphModel {
  scope: GraphScope;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unavailable: GraphUnavailable;
  legend: GraphLegend;
  omitted: GraphOmitted;
  /** The server stopped at its 500 relationships. */
  truncated: boolean;
  /** Which nodes exist and which are joined: the only thing layout depends on. */
  signature: string;
}

export interface GraphFilters { showBoard: boolean; showFile: boolean; hiddenStyles: ReadonlySet<BoardConnector['style']>; hiddenTypes: ReadonlySet<RelationshipType> }
export const NO_FILTERS: GraphFilters = { showBoard: true, showFile: true, hiddenStyles: new Set(), hiddenTypes: new Set() };

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cut = (s: string, max = 40) => { const chars = Array.from(s.replace(/\s+/g, ' ').trim()); return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join(''); };
const pairOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const KIND_RANK: Record<GraphNodeKind, number> = { item: 0, 'list-file': 1, 'off-board': 2 };

type FileFacts = { name: string; mimeType: string | null };

/** The Board side of the graph: which node each block is, and where each file they can open sits. */
function readBoard(blocks: BoardBlock[]) {
  const nodeOfBlock = new Map<string, string>();
  const places = new Map<string, GraphLocation[]>();
  const known = new Map<string, FileFacts>();
  const place = (fileId: string, location: GraphLocation, facts: FileFacts) => {
    places.set(fileId, [...(places.get(fileId) || []), location]);
    known.set(fileId, facts);
  };
  [...blocks].sort((a, b) => byString(a.id, b.id)).forEach((block) => {
    nodeOfBlock.set(block.id, `item:${block.id}`);
    if (block.type === 'file' && block.ref.available && block.ref.fileId) {
      nodeOfBlock.set(block.id, `file:${block.ref.fileId}`);
      place(block.ref.fileId, { kind: 'card', blockId: block.id }, { name: block.ref.name, mimeType: block.ref.mimeType || null });
    }
    if (block.type === 'filelist') {
      block.filelist.items.forEach((row, rowIndex) => {
        // A row they cannot open has no usable file: anything else it holds is ignored.
        if (row.ref.available && row.ref.fileId) place(row.ref.fileId, { kind: 'list', blockId: block.id, rowId: row.id, rowIndex }, { name: row.ref.name, mimeType: row.ref.mimeType || null });
      });
    }
  });
  places.forEach((list) => list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'card' ? -1 : 1)));
  return { nodeOfBlock, places, known };
}

export function buildGraph({ scope, blocks, connectors, connections }: GraphInput): GraphModel {
  const { nodeOfBlock, places, known } = readBoard(blocks);
  const openable = new Map(connections.files.map(f => [f.fileId, f]));
  const blockById = new Map(blocks.map(b => [b.id, b]));
  const nodes = new Map<string, GraphNode>();
  let omittedEdges = 0;

  const fileNode = (fileId: string) => {
    const key = `file:${fileId}`;
    if (!nodes.has(key)) {
      const locations = places.get(fileId) || [];
      const facts = known.get(fileId) || { name: openable.get(fileId)?.name || '', mimeType: openable.get(fileId)?.mimeType || null };
      nodes.set(key, {
        key, kind: !locations.length ? 'off-board' : locations[0].kind === 'card' ? 'item' : 'list-file', name: facts.name, shortName: cut(facts.name), itemType: 'file',
        fileId, mimeType: facts.mimeType, available: true, onBoard: locations.length > 0, locations, degree: 0, unavailableCount: 0,
      });
    }
    return key;
  };
  const blockNode = (block: BoardBlock) => {
    const key = nodeOfBlock.get(block.id) as string;
    if (key.startsWith('file:')) return fileNode(key.slice(5));
    if (!nodes.has(key)) {
      const name = itemName(block);
      nodes.set(key, {
        key, kind: 'item', name, shortName: cut(name), itemType: block.type, fileId: null, mimeType: null,
        available: block.type !== 'file' && block.type !== 'folder' ? true : block.ref.available, onBoard: true, locations: [], degree: 0, unavailableCount: 0,
      });
    }
    return key;
  };

  const edges: GraphEdge[] = [];
  const base = { directed: false, parallelIndex: 0, parallelCount: 1 };

  // Connectors belong to one tab, so the account-wide graph has none.
  if (scope === 'board') {
    const sorted = [...connectors].sort((a, b) => byString(a.id, b.id));
    omittedEdges += Math.max(0, sorted.length - MAX_GRAPH_CONNECTORS);
    sorted.slice(0, MAX_GRAPH_CONNECTORS).forEach((c) => {
      const from = blockById.get(c.fromId);
      const to = blockById.get(c.toId);
      if (!from || !to || nodeOfBlock.get(c.fromId) === nodeOfBlock.get(c.toId)) return;
      edges.push({ ...base, key: `board:${c.id}`, recordId: c.id, system: 'board', source: blockNode(from), target: blockNode(to), directed: c.style === 'arrow', style: c.style });
    });
  }

  const unavailable: GraphUnavailable['rows'] = connections.unavailable.map(u => ({ recordId: u.id, fileId: u.fileId && openable.has(u.fileId) ? u.fileId : null }));
  const relationships = [...connections.relationships].sort((a, b) => byString(a.id, b.id));
  omittedEdges += Math.max(0, relationships.length - MAX_GRAPH_RELATIONSHIPS);
  relationships.slice(0, MAX_GRAPH_RELATIONSHIPS).forEach((r) => {
    const readable = [r.source, r.target].filter(id => openable.has(id));
    if (readable.length < 2 || r.source === r.target) {
      unavailable.push({ recordId: r.id, fileId: readable[0] || null });
      return;
    }
    // Asked for while the Board was different: only relationships touching it now belong here (one hop, never two).
    if (scope === 'board' && !places.has(r.source) && !places.has(r.target)) return;
    edges.push({
      ...base, key: `rel:${r.id}`, recordId: r.id, system: 'file', source: fileNode(r.source), target: fileNode(r.target), directed: true,
      type: r.type, label: r.label, description: r.description, createdAt: r.createdAt,
    });
  });

  edges.forEach((e) => { (nodes.get(e.source) as GraphNode).degree += 1; (nodes.get(e.target) as GraphNode).degree += 1; });

  // Over the cap: Board items, then File List files, then off-board files; among those, the most connected.
  const ranked = Array.from(nodes.values()).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.degree - a.degree || byString(a.key, b.key));
  const kept = new Set(ranked.slice(0, MAX_GRAPH_NODES).map(n => n.key));
  const byKind: Record<GraphNodeKind, number> = { item: 0, 'list-file': 0, 'off-board': 0 };
  ranked.slice(MAX_GRAPH_NODES).forEach((n) => { byKind[n.kind] += 1; });

  const finalEdges = edges.filter(e => kept.has(e.source) && kept.has(e.target)).sort((a, b) => byString(a.key, b.key));
  omittedEdges += edges.length - finalEdges.length;

  const finalNodes = Array.from(kept).map(key => nodes.get(key) as GraphNode).sort((a, b) => byString(a.key, b.key));
  finalNodes.forEach((n) => { n.degree = 0; });
  const nodeByKey = new Map(finalNodes.map(n => [n.key, n]));
  const parallel = new Map<string, GraphEdge[]>();
  finalEdges.forEach((e) => {
    (nodeByKey.get(e.source) as GraphNode).degree += 1;
    (nodeByKey.get(e.target) as GraphNode).degree += 1;
    const pair = pairOf(e.source, e.target);
    parallel.set(pair, [...(parallel.get(pair) || []), e]);
  });
  parallel.forEach((group) => group.forEach((e, i) => { e.parallelIndex = i; e.parallelCount = group.length; }));

  unavailable.sort((a, b) => byString(a.recordId, b.recordId));
  unavailable.forEach((u) => { const node = u.fileId ? nodeByKey.get(`file:${u.fileId}`) : undefined; if (node) node.unavailableCount += 1; });

  const seen = new Map<string, number>();
  finalNodes.forEach((n) => {
    const count = (seen.get(n.shortName) || 0) + 1;
    seen.set(n.shortName, count);
    if (count > 1) n.shortName = `${n.shortName} · ${count}`;
  });

  return {
    scope, nodes: finalNodes, edges: finalEdges, unavailable: { total: unavailable.length, rows: unavailable }, legend: legendOf(finalEdges),
    omitted: { nodes: ranked.length - kept.size, edges: omittedEdges, byKind }, truncated: connections.truncated,
    signature: `${finalNodes.map(n => n.key).join(',')}#${Array.from(parallel.keys()).sort(byString).join(',')}`,
  };
}

function legendOf(edges: GraphEdge[]): GraphLegend {
  const legend: GraphLegend = { board: { total: 0, line: 0, arrow: 0 }, file: { total: 0 }, types: [] };
  const counts = new Map<RelationshipType, number>();
  edges.forEach((e) => {
    if (e.system === 'board') { legend.board.total += 1; legend.board[e.style] += 1; return; }
    legend.file.total += 1;
    counts.set(e.type, (counts.get(e.type) || 0) + 1);
  });
  legend.types = RELATIONSHIP_TYPES.filter(t => counts.has(t.type)).map(t => ({ ...t, count: counts.get(t.type) as number }));
  return legend;
}

/** Which nodes and edges to show. Only visibility: positions come from the whole graph, so nothing moves. */
export function visibleGraph(model: GraphModel, filters: GraphFilters): { nodes: Set<string>; edges: Set<string> } {
  const edges = new Set<string>();
  const nodes = new Set<string>(model.nodes.filter(n => n.degree === 0).map(n => n.key));
  model.edges.forEach((e) => {
    const shown = e.system === 'board' ? filters.showBoard && !filters.hiddenStyles.has(e.style) : filters.showFile && !filters.hiddenTypes.has(e.type);
    if (!shown) return;
    edges.add(e.key);
    nodes.add(e.source);
    nodes.add(e.target);
  });
  return { nodes, edges };
}

/** What a relationship is called: its own label, or its type's. */
export const relationshipLabel = (edge: FileRelationshipEdge) => edge.label || RELATIONSHIP_TYPES.find(t => t.type === edge.type)?.label || 'Related to';

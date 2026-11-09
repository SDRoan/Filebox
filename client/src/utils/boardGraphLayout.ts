import { GraphModel, GraphNode, relationshipLabel } from './boardGraph';

/**
 * Where each node of a Connections graph sits: connected groups laid out on their own in breadth-first columns, then
 * packed together. No randomness and no simulation, so the same graph always comes out the same. Everything depends
 * only on which nodes are joined (GraphModel.signature), never on names, filters, the theme or Canvas positions.
 * Positions live in memory for the drawing; they are never saved.
 *
 * Every node has its own grid cell, so two nodes cannot overlap whatever their names or the window size.
 */

export const NODE_W = 176;
export const NODE_H = 56;
export const CELL_W = 220;
export const CELL_H = 88;
const MAX_PER_COLUMN = 10;
const SWEEPS = 4;

export interface GraphPosition { x: number; y: number; column: number; row: number }
export interface GraphComponent { keys: string[]; x: number; y: number; width: number; height: number }
export interface GraphLayout {
  signature: string;
  positions: Map<string, GraphPosition>;
  components: GraphComponent[];
  /** Reading order: group by group, column by column, top to bottom. */
  order: string[];
  width: number;
  height: number;
}
export interface GraphNavigationNode { label: string; left: string | null; right: string | null; up: string | null; down: string | null; edges: string[] }
export interface GraphNavigation { order: string[]; nodes: Map<string, GraphNavigationNode>; edges: Map<string, string> }

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Adjacency = Map<string, string[]>;

export function adjacencyOf(model: GraphModel): Adjacency {
  const sets = new Map<string, Set<string>>(model.nodes.map(n => [n.key, new Set<string>()]));
  model.edges.forEach((e) => { (sets.get(e.source) as Set<string>).add(e.target); (sets.get(e.target) as Set<string>).add(e.source); });
  return new Map(Array.from(sets).map(([key, set]) => [key, Array.from(set).sort(byString)]));
}

function componentsOf(keys: string[], adjacency: Adjacency): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  keys.forEach((start) => {
    if (seen.has(start)) return;
    seen.add(start);
    const group = [start];
    for (let i = 0; i < group.length; i += 1) {
      (adjacency.get(group[i]) as string[]).forEach((next) => { if (!seen.has(next)) { seen.add(next); group.push(next); } });
    }
    groups.push(group.sort(byString));
  });
  return groups;
}

/** Columns outward from the most connected node. Direction plays no part, so cycles need no special handling. */
export function layersOf(group: string[], adjacency: Adjacency): string[][] {
  const degreeOf = (key: string) => (adjacency.get(key) as string[]).length;
  const root = [...group].sort((a, b) => degreeOf(b) - degreeOf(a) || byString(a, b))[0];
  const depth = new Map<string, number>([[root, 0]]);
  const queue = [root];
  for (let i = 0; i < queue.length; i += 1) {
    (adjacency.get(queue[i]) as string[]).forEach((next) => {
      if (!depth.has(next)) { depth.set(next, (depth.get(queue[i]) as number) + 1); queue.push(next); }
    });
  }
  const layers: string[][] = [];
  queue.forEach((key) => { const d = depth.get(key) as number; (layers[d] = layers[d] || []).push(key); });
  return layers;
}

const endsIn = (places: Map<string, number>, neighbours: string[]) => neighbours.map(n => places.get(n)).filter((p): p is number => p !== undefined).sort((a, b) => a - b);

/** Edges crossing between neighbouring columns (counted by inversions). */
export function crossingsOf(layers: string[][], adjacency: Adjacency): number {
  let total = 0;
  for (let i = 0; i + 1 < layers.length; i += 1) {
    const next = new Map(layers[i + 1].map((key, index) => [key, index]));
    const tree = new Array(layers[i + 1].length + 1).fill(0);
    let added = 0;
    for (const key of layers[i]) {
      const ends = endsIn(next, adjacency.get(key) as string[]);
      for (const p of ends) {
        let notAfter = 0;
        for (let k = p + 1; k > 0; k -= k & -k) notAfter += tree[k];
        total += added - notAfter;
      }
      for (const p of ends) {
        for (let k = p + 1; k < tree.length; k += k & -k) tree[k] += 1;
        added += 1;
      }
    }
  }
  return total;
}

/** Sweeps each column toward the average place of its neighbours, keeping the arrangement with the fewest crossings. */
export function reduceCrossings(start: string[][], adjacency: Adjacency): string[][] {
  const layers = start.map(l => [...l]);
  let best = layers.map(l => [...l]);
  let bestCrossings = crossingsOf(layers, adjacency);
  const reorder = (i: number, against: number) => {
    const places = new Map(layers[against].map((key, index) => [key, index]));
    const scored = layers[i].map((key, index) => {
      const near = (adjacency.get(key) as string[]).map(n => places.get(n)).filter((p): p is number => p !== undefined);
      return { key, index, score: near.length ? near.reduce((a, b) => a + b, 0) / near.length : index };
    });
    scored.sort((a, b) => a.score - b.score || a.index - b.index || byString(a.key, b.key));
    layers[i] = scored.map(s => s.key);
  };
  for (let sweep = 0; sweep < SWEEPS && bestCrossings > 0; sweep += 1) {
    for (let i = 1; i < layers.length; i += 1) reorder(i, i - 1);
    for (let i = layers.length - 2; i >= 0; i -= 1) reorder(i, i + 1);
    const crossings = crossingsOf(layers, adjacency);
    if (crossings < bestCrossings) { bestCrossings = crossings; best = layers.map(l => [...l]); }
  }
  return best;
}

interface PlacedGroup { keys: string[]; cells: Map<string, { column: number; row: number }>; columns: number; rows: number }

function placeGroup(group: string[], adjacency: Adjacency): PlacedGroup {
  const columns: string[][] = [];
  reduceCrossings(layersOf(group, adjacency), adjacency).forEach((layer) => {
    for (let i = 0; i < layer.length; i += MAX_PER_COLUMN) columns.push(layer.slice(i, i + MAX_PER_COLUMN));
  });
  const rows = Math.max(...columns.map(c => c.length));
  const cells = new Map<string, { column: number; row: number }>();
  columns.forEach((list, column) => {
    const top = Math.floor((rows - list.length) / 2);
    list.forEach((key, i) => cells.set(key, { column, row: top + i }));
  });
  return { keys: group, cells, columns: columns.length, rows };
}

export function layoutGraph(model: GraphModel): GraphLayout {
  const adjacency = adjacencyOf(model);
  const keys = model.nodes.map(n => n.key).sort(byString);
  const groups = componentsOf(keys, adjacency).map(g => placeGroup(g, adjacency))
    .sort((a, b) => b.keys.length - a.keys.length || byString(a.keys[0], b.keys[0]));

  // Groups fill rows of about the same width, one empty cell apart.
  const area = groups.reduce((sum, g) => sum + (g.columns + 1) * (g.rows + 1), 0);
  const rowLimit = Math.max(Math.ceil(Math.sqrt(area) * 1.4), ...groups.map(g => g.columns), 1);
  const positions = new Map<string, GraphPosition>();
  const components: GraphComponent[] = [];
  const order: string[] = [];
  let column = 0, row = 0, rowHeight = 0, usedColumns = 0;
  groups.forEach((g) => {
    if (column > 0 && column + g.columns > rowLimit) { column = 0; row += rowHeight + 1; rowHeight = 0; }
    g.cells.forEach((cell, key) => {
      const c = column + cell.column, r = row + cell.row;
      positions.set(key, { x: c * CELL_W, y: r * CELL_H, column: c, row: r });
    });
    components.push({ keys: g.keys, x: column * CELL_W, y: row * CELL_H, width: g.columns * CELL_W, height: g.rows * CELL_H });
    order.push(...[...g.keys].sort((a, b) => {
      const p = g.cells.get(a) as { column: number; row: number }, q = g.cells.get(b) as { column: number; row: number };
      return p.column - q.column || p.row - q.row;
    }));
    usedColumns = Math.max(usedColumns, column + g.columns);
    rowHeight = Math.max(rowHeight, g.rows);
    column += g.columns + 1;
  });
  return { signature: model.signature, positions, components, order, width: usedColumns * CELL_W, height: (row + rowHeight) * CELL_H };
}

/** Layout that is only worked out again when the graph's structure changes (keep one per view). */
export function createLayoutMemo(): (model: GraphModel) => GraphLayout {
  let last: GraphLayout | null = null;
  return (model) => {
    if (!last || last.signature !== model.signature) last = layoutGraph(model);
    return last;
  };
}

const WHERE = (node: GraphNode) => (node.kind === 'off-board' ? 'Not on this Board' : node.kind === 'list-file' ? 'In a File List on this Board' : 'On this Board');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The nearest node in a direction; going straight counts for more than going across. */
function nearest(from: GraphPosition, key: string, others: Array<[string, GraphPosition]>, dx: number, dy: number): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  others.forEach(([other, p]) => {
    if (other === key) return;
    const along = (p.column - from.column) * dx + (p.row - from.row) * dy;
    if (along <= 0) return;
    const across = Math.abs((p.column - from.column) * dy) + Math.abs((p.row - from.row) * dx);
    const score = along + across * 2;
    if (score < bestScore || (score === bestScore && best !== null && other < best)) { best = other; bestScore = score; }
  });
  return best;
}

/** What the keyboard and screen readers use: reading order, a target in each direction, and spoken names. */
export function navigationOf(model: GraphModel, layout: GraphLayout): GraphNavigation {
  const nameOf = new Map(model.nodes.map(n => [n.key, n.shortName]));
  const incident = new Map<string, string[]>(model.nodes.map(n => [n.key, []]));
  const edges = new Map<string, string>();
  model.edges.forEach((e) => {
    (incident.get(e.source) as string[]).push(e.key);
    (incident.get(e.target) as string[]).push(e.key);
    const from = nameOf.get(e.source), to = nameOf.get(e.target);
    if (e.system === 'file') edges.set(e.key, `${from}: ${relationshipLabel(e)}: ${to}. File relationship`);
    else edges.set(e.key, e.style === 'arrow' ? `Arrow from ${from} to ${to}. Board connector` : `Line between ${from} and ${to}. Board connector`);
  });
  const others = Array.from(layout.positions);
  const nodes = new Map<string, GraphNavigationNode>();
  model.nodes.forEach((node) => {
    const at = layout.positions.get(node.key) as GraphPosition;
    const parts = [node.shortName, WHERE(node), plural(node.degree, 'connection')];
    if (node.unavailableCount) parts.push(plural(node.unavailableCount, 'unavailable connection'));
    nodes.set(node.key, {
      label: parts.join(', '), edges: incident.get(node.key) as string[],
      left: nearest(at, node.key, others, -1, 0), right: nearest(at, node.key, others, 1, 0), up: nearest(at, node.key, others, 0, -1), down: nearest(at, node.key, others, 0, 1),
    });
  });
  return { order: layout.order, nodes, edges };
}

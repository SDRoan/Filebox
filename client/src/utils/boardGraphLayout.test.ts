import type { BoardBlock, BoardConnector } from '../services/api';
import { buildGraph, GraphConnections, GraphModel, GraphRelationship, GraphScope, NO_FILTERS, visibleGraph } from './boardGraph';
import { adjacencyOf, CELL_H, CELL_W, createLayoutMemo, crossingsOf, GraphLayout, layersOf, layoutGraph, navigationOf, NODE_H, NODE_W, reduceCrossings } from './boardGraphLayout';

jest.mock('../services/api', () => { throw new Error('layout loaded the API client'); });

const place = { x: 10, y: 20, w: 200, h: 100 };
const note = (id: string, title = id, x = 10): BoardBlock => ({ ...place, x, id, type: 'note', note: { title, body: '', color: 'yellow' } }) as unknown as BoardBlock;
const card = (id: string, fileId: string, name = `${fileId}.pdf`): BoardBlock => ({ ...place, id, type: 'file', ref: { available: true, fileId, name, mimeType: 'application/pdf', source: 'owned' } }) as unknown as BoardBlock;
const conn = (id: string, fromId: string, toId: string, style: BoardConnector['style'] = 'arrow'): BoardConnector => ({ id, fromId, toId, style });
const rel = (id: string, source: string, target: string, extra: Partial<GraphRelationship> = {}): GraphRelationship => ({ id, source, target, type: 'related', label: '', description: '', createdAt: '2026-11-01T00:00:00.000Z', ...extra });
const data = (relationships: GraphRelationship[], fileIds: string[], unavailable: GraphConnections['unavailable'] = []): GraphConnections => ({
  relationships, unavailable, truncated: false, files: fileIds.map(fileId => ({ fileId, name: `${fileId}.pdf`, mimeType: 'application/pdf', size: 7, source: 'owned' })),
});
const NONE = data([], []);
const graph = (blocks: BoardBlock[], connectors: BoardConnector[] = [], connections = NONE, scope: GraphScope = 'board') => buildGraph({ scope, blocks, connectors, connections });

// Connected notes from "a-b" pairs.
const chain = (pairs: string[]) => {
  const ids = Array.from(new Set(pairs.flatMap(p => p.split('-'))));
  return graph(ids.map(id => note(id)), pairs.map((p, i) => { const [a, b] = p.split('-'); return conn(`c${String(i).padStart(4, '0')}`, a, b); }));
};
const flat = (layout: GraphLayout) => JSON.stringify([Array.from(layout.positions).sort((a, b) => (a[0] < b[0] ? -1 : 1)), layout.components, layout.order, layout.width, layout.height]);
const random = (seed: number) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };
const shuffled = <T,>(list: T[], seed: number) => { const r = random(seed); const out = [...list]; for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };
const relative = (layout: GraphLayout, keys: string[]) => { const base = layout.positions.get(keys[0])!; return keys.map(k => { const p = layout.positions.get(k)!; return [p.x - base.x, p.y - base.y]; }); };
const noOverlap = (layout: GraphLayout) => {
  const cells = Array.from(layout.positions.values());
  return new Set(cells.map(p => `${p.column},${p.row}`)).size === cells.length && NODE_W < CELL_W && NODE_H < CELL_H;
};

describe('determinism', () => {
  const blocks = [note('n1'), note('n2'), note('n3'), note('n4'), card('c1', 'A'), card('c2', 'B')];
  const connectors = [conn('k1', 'n1', 'n2'), conn('k2', 'n2', 'n3'), conn('k3', 'n3', 'n1'), conn('k4', 'c1', 'n4'), conn('k5', 'c1', 'c2')];
  const connections = data([rel('r1', 'A', 'X'), rel('r2', 'B', 'X'), rel('r3', 'A', 'B')], ['A', 'B', 'X']);

  test('building twice gives the same graph and layout', () => {
    const a = graph(blocks, connectors, connections), b = graph(blocks, connectors, connections);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(flat(layoutGraph(a))).toBe(flat(layoutGraph(b)));
  });
  test('any input order gives identical nodes, edges and positions', () => {
    const base = graph(blocks, connectors, connections);
    for (let seed = 1; seed <= 25; seed += 1) {
      const other = graph(shuffled(blocks, seed), shuffled(connectors, seed + 100), { ...connections, relationships: shuffled(connections.relationships, seed + 200), files: shuffled(connections.files, seed + 300) });
      expect(JSON.stringify(other)).toBe(JSON.stringify(base));
      expect(flat(layoutGraph(other))).toBe(flat(layoutGraph(base)));
    }
  });
  test('names, labels, descriptions and types do not move anything', () => {
    const base = graph(blocks, connectors, connections);
    const renamed = graph(blocks.map((b) => (b.type === 'note' ? note(b.id, `Renamed ${b.id}`) : card(b.id, (b as any).ref.fileId, 'Different name.pdf'))), connectors,
      data(connections.relationships.map(r => ({ ...r, label: 'edited', description: 'edited', type: 'custom' as const })), ['A', 'B', 'X']));
    expect(renamed.signature).toBe(base.signature);
    expect(flat(layoutGraph(renamed))).toBe(flat(layoutGraph(base)));
  });
  test('Canvas positions do not move anything', () => {
    const moved = blocks.map((b, i) => ({ ...b, x: 5000 - i * 37, y: i * 91 }));
    expect(flat(layoutGraph(graph(moved as BoardBlock[], connectors, connections)))).toBe(flat(layoutGraph(graph(blocks, connectors, connections))));
  });
  test('a line becoming an arrow, or a second edge on the same pair, does not move anything', () => {
    const base = chain(['a-b', 'b-c']);
    const blocksABC = ['a', 'b', 'c'].map(id => note(id));
    const lines = graph(blocksABC, [conn('c0000', 'a', 'b', 'line'), conn('c0001', 'b', 'c', 'line')]);
    const extra = graph(blocksABC, [conn('c0000', 'a', 'b'), conn('c0001', 'b', 'c'), conn('c0002', 'b', 'a')]);
    expect(flat(layoutGraph(lines))).toBe(flat(layoutGraph(base)));
    expect(flat(layoutGraph(extra))).toBe(flat(layoutGraph(base)));
  });
  test('filters only change visibility: layout comes from the whole graph', () => {
    const g = graph(blocks, connectors, connections);
    const memo = createLayoutMemo();
    const before = memo(g);
    const before2 = flat(before);
    visibleGraph(g, { ...NO_FILTERS, showBoard: false });
    visibleGraph(g, { ...NO_FILTERS, showFile: false });
    expect(memo(g)).toBe(before);
    expect(flat(before)).toBe(before2);
  });
});

describe('reuse between renders', () => {
  test('the layout is only worked out again when the structure changes', () => {
    const memo = createLayoutMemo();
    const a = memo(chain(['a-b', 'b-c']));
    expect(memo(chain(['a-b', 'b-c']))).toBe(a);
    const renamed = graph(['a', 'b', 'c'].map(id => note(id, `new ${id}`)), [conn('c0000', 'a', 'b'), conn('c0001', 'b', 'c')]);
    expect(memo(renamed)).toBe(a);
    expect(memo(chain(['a-b', 'b-c', 'c-d']))).not.toBe(a);
  });
});

describe('components', () => {
  const twoGroups = chain(['a-b', 'b-c', 'x-y']);
  test('disconnected groups are laid out apart, biggest first', () => {
    const layout = layoutGraph(twoGroups);
    expect(layout.components.map(c => c.keys)).toEqual([['item:a', 'item:b', 'item:c'], ['item:x', 'item:y']]);
    const [p, q] = layout.components;
    const apart = p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
    expect(apart).toBe(true);
  });
  test('changing one group leaves the arrangement inside another untouched', () => {
    const before = layoutGraph(chain(['a-b', 'b-c', 'c-d', 'x-y', 'y-z']));
    const after = layoutGraph(chain(['a-b', 'b-c', 'c-d', 'c-e', 'a-e', 'd-e', 'x-y', 'y-z']));
    const group = ['item:x', 'item:y', 'item:z'];
    expect(relative(after, group)).toEqual(relative(before, group));
  });
  test('removing a whole group leaves the arrangement inside the others', () => {
    const before = layoutGraph(chain(['a-b', 'b-c', 'c-a', 'x-y', 'p-q']));
    const after = layoutGraph(chain(['a-b', 'b-c', 'c-a', 'p-q']));
    expect(relative(after, ['item:a', 'item:b', 'item:c'])).toEqual(relative(before, ['item:a', 'item:b', 'item:c']));
    expect(relative(after, ['item:p', 'item:q'])).toEqual(relative(before, ['item:p', 'item:q']));
  });
  test('many separate pairs are packed into rows, not one long line', () => {
    const pairs = Array.from({ length: 40 }, (_, i) => `a${i}-b${i}`);
    const layout = layoutGraph(chain(pairs));
    expect(layout.height).toBeGreaterThan(CELL_H);
    expect(layout.width / layout.height).toBeLessThan(6);
    expect(noOverlap(layout)).toBe(true);
  });
  test('an empty graph is an empty layout', () => {
    const layout = layoutGraph(graph([]));
    expect([layout.positions.size, layout.components.length, layout.width, layout.height]).toEqual([0, 0, 0, 0]);
  });
});

describe('cycles', () => {
  test.each([
    ['a two-node cycle', ['a-b', 'b-a']],
    ['a triangle', ['a-b', 'b-c', 'c-a']],
    ['a long ring', ['a-b', 'b-c', 'c-d', 'd-e', 'e-f', 'f-a']],
    ['a ring with a tail', ['a-b', 'b-c', 'c-a', 'c-d', 'd-e']],
  ])('%s is placed once each, without overlap', (_, pairs) => {
    const g = chain(pairs);
    const layout = layoutGraph(g);
    expect(layout.positions.size).toBe(g.nodes.length);
    expect(layout.order).toHaveLength(g.nodes.length);
    expect(noOverlap(layout)).toBe(true);
  });
  test('breadth-first layers keep every edge within one column of its ends', () => {
    const g = chain(['a-b', 'b-c', 'c-d', 'd-a', 'a-c']);
    const adjacency = adjacencyOf(g);
    const layers = layersOf(g.nodes.map(n => n.key), adjacency);
    const depth = new Map(layers.flatMap((l, i) => l.map(k => [k, i] as [string, number])));
    expect(g.edges.every(e => Math.abs(depth.get(e.source)! - depth.get(e.target)!) <= 1)).toBe(true);
  });
  test('the most connected node starts the first column', () => {
    const layout = layoutGraph(chain(['h-a', 'h-b', 'h-c', 'a-z']));
    expect(layout.order[0]).toBe('item:h');
    expect(layout.positions.get('item:h')?.column).toBe(0);
  });
});

describe('crossings and spacing', () => {
  test('a crossing is counted and sweeps remove it', () => {
    const adjacency = new Map([['a', ['y']], ['b', ['x']], ['x', ['b']], ['y', ['a']]]);
    const layers = [['a', 'b'], ['x', 'y']];
    expect(crossingsOf(layers, adjacency)).toBe(1);
    expect(crossingsOf(reduceCrossings(layers, adjacency), adjacency)).toBe(0);
  });
  test('three edges fanning across are counted exactly', () => {
    const adjacency = new Map([['a', ['z']], ['b', ['y']], ['c', ['x']], ['x', ['c']], ['y', ['b']], ['z', ['a']]]);
    expect(crossingsOf([['a', 'b', 'c'], ['x', 'y', 'z']], adjacency)).toBe(3);
  });
  test('sweeps never leave more crossings than they started with', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const r = random(seed);
      const ids = Array.from({ length: 24 }, (_, i) => `n${i}`);
      const pairs = ids.map((id, i) => (i ? `${ids[Math.floor(r() * i)]}-${id}` : '')).filter(Boolean);
      for (let k = 0; k < 20; k += 1) { const a = ids[Math.floor(r() * 24)], b = ids[Math.floor(r() * 24)]; if (a !== b) pairs.push(`${a}-${b}`); }
      const g = chain(pairs);
      const adjacency = adjacencyOf(g);
      const layers = layersOf(g.nodes.map(n => n.key), adjacency);
      expect(crossingsOf(reduceCrossings(layers, adjacency), adjacency)).toBeLessThanOrEqual(crossingsOf(layers, adjacency));
    }
  });
  test('a hub with many neighbours wraps into columns and nothing overlaps', () => {
    const pairs = Array.from({ length: 95 }, (_, i) => `hub-s${i}`);
    const layout = layoutGraph(chain(pairs));
    const rows = new Map<number, number>();
    layout.positions.forEach((p) => rows.set(p.column, (rows.get(p.column) || 0) + 1));
    expect(Math.max(...Array.from(rows.values()))).toBeLessThanOrEqual(10);
    expect(noOverlap(layout)).toBe(true);
  });
});

describe('keyboard and screen readers', () => {
  const g = graph([card('c1', 'A', 'Alpha.pdf'), card('c2', 'B', 'Beta.pdf'), note('n1', 'Plan')], [conn('k1', 'c1', 'n1'), conn('k2', 'c2', 'n1', 'line')],
    data([rel('r1', 'A', 'X', { type: 'depends_on' }), rel('r2', 'A', 'B', { label: 'mine' })], ['A', 'B', 'X'], [{ id: 'u1', fileId: 'A' }]));
  const layout = layoutGraph(g);
  const nav = navigationOf(g, layout);

  test('reading order follows the layout and holds each node once', () => {
    expect(nav.order).toEqual(layout.order);
    expect(new Set(nav.order).size).toBe(g.nodes.length);
    const columns = nav.order.map(k => layout.positions.get(k)!.column);
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
  });
  test('labels say what, where and how many', () => {
    expect(nav.nodes.get('file:A')?.label).toBe('Alpha.pdf, On this Board, 3 connections, 1 unavailable connection');
    expect(nav.nodes.get('file:X')?.label).toBe('X.pdf, Not on this Board, 1 connection');
  });
  test('edges are named by system', () => {
    expect(nav.edges.get('board:k1')).toBe('Arrow from Alpha.pdf to Plan. Board connector');
    expect(nav.edges.get('board:k2')).toBe('Line between Beta.pdf and Plan. Board connector');
    expect(nav.edges.get('rel:r1')).toBe('Alpha.pdf: Depends on: X.pdf. File relationship');
    expect(nav.edges.get('rel:r2')).toBe('Alpha.pdf: mine: Beta.pdf. File relationship');
  });
  test('incident edges come in a stable order', () => {
    expect(nav.nodes.get('file:A')?.edges).toEqual(['board:k1', 'rel:r1', 'rel:r2']);
  });
  test('directions lead to real nodes that really are that way', () => {
    const wrong: string[] = [];
    nav.nodes.forEach((n, key) => {
      const at = layout.positions.get(key)!;
      const way = (name: string, target: string | null, ok: (p: { column: number; row: number }) => boolean) => { if (target && !ok(layout.positions.get(target)!)) wrong.push(`${key} ${name}`); };
      way('left', n.left, p => p.column < at.column);
      way('right', n.right, p => p.column > at.column);
      way('up', n.up, p => p.row < at.row);
      way('down', n.down, p => p.row > at.row);
    });
    expect(wrong).toEqual([]);
  });
  test('the first column has nowhere left to go', () => {
    expect(nav.nodes.get(nav.order[0])?.left).toBeNull();
  });
  test('planted unavailable names and ids never reach spoken output', () => {
    const secret = graph([card('c1', 'A'), note('n1', 'N')], [conn('k1', 'c1', 'n1')],
      data([rel('r1', 'A', 'SECRETFILEID', { label: 'SECRET-LABEL', description: 'SECRET-DESC' })], ['A'], [{ id: 'u1', fileId: 'SECRETFILEID2' }]));
    const l = layoutGraph(secret);
    const n = navigationOf(secret, l);
    const text = JSON.stringify([Array.from(n.nodes), Array.from(n.edges), n.order, Array.from(l.positions), l.components, l.signature]);
    expect(text).not.toMatch(/SECRET/);
  });
  test('an unavailable card is spoken as unavailable and nothing more', () => {
    const blocks = [{ ...place, id: 'c1', type: 'file', ref: { available: false } } as unknown as BoardBlock, note('n1', 'N')];
    const s = graph(blocks, [conn('k1', 'c1', 'n1')]);
    expect(navigationOf(s, layoutGraph(s)).nodes.get('item:c1')?.label).toBe('Unavailable file, On this Board, 1 connection');
  });
});

describe('maximum load', () => {
  const pad = (n: number) => String(n).padStart(4, '0');
  const ITEMS = 150;
  const fileIds = Array.from({ length: ITEMS }, (_, i) => `F${pad(i)}`);
  const blocks = fileIds.map((f, i) => card(`b${pad(i)}`.padEnd(10, 'x'), f));
  const blockId = (i: number) => `b${pad(i % ITEMS)}`.padEnd(10, 'x');

  const scenarios: Array<[string, () => { connectors: BoardConnector[]; relationships: GraphRelationship[]; files: string[] }]> = [
    ['one dense group', () => {
      const r = random(7);
      const connectors = Array.from({ length: 300 }, (_, i) => { const a = Math.floor(r() * ITEMS); return conn(`k${pad(i)}`, blockId(a), blockId((a + 1 + Math.floor(r() * (ITEMS - 1))) % ITEMS)); });
      const off = Array.from({ length: 150 }, (_, i) => `O${pad(i)}`);
      const relationships = Array.from({ length: 500 }, (_, i) => rel(`r${pad(i)}`, fileIds[Math.floor(r() * ITEMS)], off[Math.floor(r() * 150)]));
      return { connectors, relationships, files: [...fileIds, ...off] };
    }],
    ['a single hub', () => {
      const off = Array.from({ length: 149 }, (_, i) => `O${pad(i)}`);
      const connectors = Array.from({ length: 300 }, (_, i) => conn(`k${pad(i)}`, blockId(0), blockId(1 + (i % (ITEMS - 1)))));
      const relationships = Array.from({ length: 500 }, (_, i) => rel(`r${pad(i)}`, fileIds[0], off[i % 149], { type: 'references' }));
      return { connectors, relationships, files: [...fileIds, ...off] };
    }],
    ['thirty separate groups', () => {
      const r = random(11);
      const connectors = Array.from({ length: 300 }, (_, i) => { const g = i % 30; return conn(`k${pad(i)}`, blockId(g * 5 + Math.floor(r() * 5)), blockId(g * 5 + Math.floor(r() * 5))); });
      const off = Array.from({ length: 150 }, (_, i) => `O${pad(i)}`);
      const relationships = Array.from({ length: 500 }, (_, i) => { const g = i % 30; return rel(`r${pad(i)}`, fileIds[g * 5 + Math.floor(r() * 5)], off[g * 5 + Math.floor(r() * 5)]); });
      return { connectors, relationships, files: [...fileIds, ...off] };
    }],
    ['over the node cap', () => {
      const r = random(13);
      const connectors = Array.from({ length: 300 }, (_, i) => { const a = Math.floor(r() * ITEMS); return conn(`k${pad(i)}`, blockId(a), blockId((a + 1) % ITEMS)); });
      const off = Array.from({ length: 500 }, (_, i) => `O${pad(i)}`);
      const relationships = off.map((o, i) => rel(`r${pad(i)}`, fileIds[i % ITEMS], o));
      return { connectors, relationships, files: [...fileIds, ...off] };
    }],
  ];

  const results: string[] = [];
  afterAll(() => { process.stdout.write(`\n[graph performance]\n${results.join('\n')}\n`); });

  test.each(scenarios)('%s builds, lays out and navigates within 100 ms', (name, make) => {
    const { connectors, relationships, files } = make();
    const connections = data(relationships, files);
    const times: number[] = [];
    let model = null as unknown as GraphModel;
    for (let i = 0; i < 7; i += 1) {
      const t0 = performance.now();
      model = buildGraph({ scope: 'board', blocks, connectors, connections });
      const layout = layoutGraph(model);
      navigationOf(model, layout);
      times.push(performance.now() - t0);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const layout = layoutGraph(model);
    results.push(`${name}: first ${times[0].toFixed(1)} ms, median ${sorted[3].toFixed(1)} ms, worst ${sorted[6].toFixed(1)} ms; ${model.nodes.length} nodes, ${model.edges.length} edges, omitted ${model.omitted.nodes} nodes / ${model.omitted.edges} edges`);
    expect(sorted[6]).toBeLessThan(100);
    expect(model.nodes.length).toBeLessThanOrEqual(300);
    expect(noOverlap(layout)).toBe(true);
    const keys = new Set(model.nodes.map(n => n.key));
    expect(model.edges.every(e => keys.has(e.source) && keys.has(e.target))).toBe(true);
  });

  test('a repeat with an unchanged structure costs no layout at all', () => {
    const { connectors, relationships, files } = scenarios[0][1]();
    const connections = data(relationships, files);
    const memo = createLayoutMemo();
    const first = memo(buildGraph({ scope: 'board', blocks, connectors, connections }));
    const t0 = performance.now();
    const second = memo(buildGraph({ scope: 'board', blocks, connectors, connections }));
    results.push(`rebuild with reused layout: ${(performance.now() - t0).toFixed(1)} ms`);
    expect(second).toBe(first);
  });
});

import fs from 'fs';
import path from 'path';
import type { BoardBlock, BoardConnector } from '../services/api';
import { buildGraph, visibleGraph, relationshipLabel, NO_FILTERS, MAX_GRAPH_NODES, GraphConnections, GraphRelationship, GraphScope, FileRelationshipEdge, BoardConnectorEdge, RelationshipType } from './boardGraph';

// The graph must work with nothing but what it is given: loading either of these would fail the whole file.
jest.mock('../services/api', () => { throw new Error('boardGraph loaded the API client'); });
jest.mock('axios', () => { throw new Error('boardGraph loaded axios'); });

const place = { x: 10, y: 20, w: 200, h: 100 };
const card = (id: string, fileId: string, name = `${fileId}.pdf`) => ({ ...place, id, type: 'file', ref: { available: true, fileId, name, mimeType: 'application/pdf', source: 'owned' } }) as unknown as BoardBlock;
const goneCard = (id: string, type = 'file') => ({ ...place, id, type, ref: { available: false } }) as unknown as BoardBlock;
const folder = (id: string, name: string) => ({ ...place, id, type: 'folder', ref: { available: true, folderId: `f${id}`, name, source: 'owned' } }) as unknown as BoardBlock;
const note = (id: string, title: string) => ({ ...place, id, type: 'note', note: { title, body: '', color: 'yellow' } }) as unknown as BoardBlock;
const list = (id: string, rows: Array<[string, string | null, string?]>) => ({
  ...place, id, type: 'filelist', filelist: { title: id, items: rows.map(([rowId, fileId, name]) => ({ id: rowId, ref: fileId ? { available: true, fileId, name: name || `${fileId}.pdf`, mimeType: 'application/pdf', source: 'owned' } : { available: false } })) },
}) as unknown as BoardBlock;
const conn = (id: string, fromId: string, toId: string, style: BoardConnector['style'] = 'arrow'): BoardConnector => ({ id, fromId, toId, style });
const rel = (id: string, source: string, target: string, extra: Partial<GraphRelationship> = {}): GraphRelationship => ({ id, source, target, type: 'related', label: '', description: '', createdAt: '2026-11-01T00:00:00.000Z', ...extra });
const data = (relationships: GraphRelationship[], fileIds: string[], unavailable: GraphConnections['unavailable'] = [], truncated = false): GraphConnections => ({
  relationships, unavailable, truncated, files: fileIds.map(fileId => ({ fileId, name: `${fileId}.pdf`, mimeType: 'application/pdf', size: 7, source: 'owned' })),
});
const NONE = data([], []);
const graph = (blocks: BoardBlock[], connectors: BoardConnector[] = [], connections = NONE, scope: GraphScope = 'board') => buildGraph({ scope, blocks, connectors, connections });
const nodeOf = (g: ReturnType<typeof graph>, key: string) => g.nodes.find(n => n.key === key);

describe('two systems, never merged', () => {
  const blocks = [card('card000001', 'A'), card('card000002', 'B')];
  const both = graph(blocks, [conn('c1', 'card000001', 'card000002')], data([rel('r1', 'A', 'B', { type: 'depends_on', label: 'needs', description: 'why' })], ['A', 'B']));

  test('a connector and a relationship between the same files are two edges on the same two nodes', () => {
    expect(both.nodes.map(n => n.key)).toEqual(['file:A', 'file:B']);
    expect(both.edges.map(e => e.key)).toEqual(['board:c1', 'rel:r1']);
    expect(both.edges.map(e => [e.parallelIndex, e.parallelCount])).toEqual([[0, 2], [1, 2]]);
  });
  test('each keeps only its own data and its own record id', () => {
    const b = both.edges[0] as BoardConnectorEdge, f = both.edges[1] as FileRelationshipEdge;
    expect(b).toMatchObject({ system: 'board', recordId: 'c1', style: 'arrow', directed: true });
    expect(b).not.toHaveProperty('label');
    expect(f).toMatchObject({ system: 'file', recordId: 'r1', type: 'depends_on', label: 'needs', description: 'why', directed: true, source: 'file:A', target: 'file:B' });
    expect(f).not.toHaveProperty('style');
  });
  test('a line has no direction; a relationship keeps the stored one, in both directions', () => {
    const g = graph(blocks, [conn('c1', 'card000001', 'card000002', 'line')], data([rel('r1', 'A', 'B'), rel('r2', 'B', 'A')], ['A', 'B']));
    expect(g.edges.map(e => [e.key, e.directed, e.source])).toEqual([['board:c1', false, 'file:A'], ['rel:r1', true, 'file:A'], ['rel:r2', true, 'file:B']]);
    expect(g.edges.every(e => e.parallelCount === 3)).toBe(true);
  });
  test('removing a connector leaves the relationship, and the other way round', () => {
    expect(graph(blocks, [], data([rel('r1', 'A', 'B')], ['A', 'B'])).edges.map(e => e.key)).toEqual(['rel:r1']);
    expect(graph(blocks, [conn('c1', 'card000001', 'card000002')], NONE).edges.map(e => e.key)).toEqual(['board:c1']);
  });
  test('the label falls back to the type', () => {
    expect(relationshipLabel(both.edges[1] as FileRelationshipEdge)).toBe('needs');
    expect(relationshipLabel(graph(blocks, [], data([rel('r1', 'A', 'B', { type: 'part_of' })], ['A', 'B'])).edges[0] as FileRelationshipEdge)).toBe('Part of');
  });
});

describe('This Board and All my files', () => {
  const blocks = [card('card000001', 'A'), note('note000001', 'Plan')];
  const connectors = [conn('c1', 'card000001', 'note000001')];
  const connections = data([rel('r1', 'A', 'X')], ['A', 'X']);

  test('This Board has connectors and relationships', () => {
    expect(graph(blocks, connectors, connections).edges.map(e => e.key)).toEqual(['board:c1', 'rel:r1']);
  });
  test('All my files has relationships only, and no Board-only items', () => {
    const g = graph(blocks, connectors, connections, 'all');
    expect(g.scope).toBe('all');
    expect(g.edges.map(e => e.key)).toEqual(['rel:r1']);
    expect(g.nodes.map(n => n.key)).toEqual(['file:A', 'file:X']);
    expect(g.legend.board.total).toBe(0);
  });
  test('All my files still knows which files are on this Board', () => {
    const g = graph(blocks, connectors, connections, 'all');
    expect(nodeOf(g, 'file:A')).toMatchObject({ kind: 'item', onBoard: true });
    expect(nodeOf(g, 'file:X')).toMatchObject({ kind: 'off-board', onBoard: false });
  });
  test('All my files keeps relationships with neither end on the Board', () => {
    expect(graph(blocks, [], data([rel('r1', 'X', 'Y')], ['X', 'Y']), 'all').edges).toHaveLength(1);
  });
});

describe('Board items', () => {
  test('only connected items become nodes', () => {
    const g = graph([note('note000001', 'One'), note('note000002', 'Two'), note('note000003', 'Lonely')], [conn('c1', 'note000001', 'note000002')]);
    expect(g.nodes.map(n => n.key)).toEqual(['item:note000001', 'item:note000002']);
  });
  test('non-file items keep their type, and folders join in', () => {
    const g = graph([note('note000001', 'One'), folder('fold000001', 'Docs')], [conn('c1', 'note000001', 'fold000001')]);
    expect(nodeOf(g, 'item:fold000001')).toMatchObject({ itemType: 'folder', name: 'Docs', fileId: null, available: true });
    expect(nodeOf(g, 'item:note000001')).toMatchObject({ itemType: 'note', name: 'One', onBoard: true, kind: 'item' });
  });
  test('a connector to something no longer on the Board draws nothing', () => {
    expect(graph([note('note000001', 'One')], [conn('c1', 'note000001', 'gone000001')]).edges).toHaveLength(0);
  });
});

describe('File List references', () => {
  test('a file in several lists is one node holding every location', () => {
    const g = graph([list('list00000a', [['row00001', 'Q'], ['row00002', 'X']]), list('list00000b', [['row00003', 'Q'], ['row00004', 'Y'], ['row00005', 'Z'], ['row00006', 'X']])], [], data([rel('r1', 'X', 'Y')], ['X', 'Y']));
    const x = g.nodes.filter(n => n.fileId === 'X');
    expect(x).toHaveLength(1);
    expect(x[0]).toMatchObject({ kind: 'list-file', onBoard: true });
    expect(x[0].locations).toEqual([{ kind: 'list', blockId: 'list00000a', rowId: 'row00002', rowIndex: 1 }, { kind: 'list', blockId: 'list00000b', rowId: 'row00006', rowIndex: 3 }]);
  });
  test('a file card comes first and its list places are kept', () => {
    const g = graph([list('aaaaaaaaaa', [['row00001', 'X']]), card('zzzzzzzzzz', 'X'), list('bbbbbbbbbb', [['row00002', 'X']])], [], data([rel('r1', 'X', 'Y')], ['X', 'Y']));
    const x = nodeOf(g, 'file:X');
    expect(x?.kind).toBe('item');
    expect(x?.locations).toEqual([{ kind: 'card', blockId: 'zzzzzzzzzz' }, { kind: 'list', blockId: 'aaaaaaaaaa', rowId: 'row00001', rowIndex: 0 }, { kind: 'list', blockId: 'bbbbbbbbbb', rowId: 'row00002', rowIndex: 0 }]);
  });
  test('a connector to the card and a relationship to the file meet on one node', () => {
    const g = graph([card('card000001', 'X'), note('note000001', 'N')], [conn('c1', 'card000001', 'note000001')], data([rel('r1', 'X', 'Y')], ['X', 'Y']));
    expect(g.nodes.filter(n => n.fileId === 'X')).toHaveLength(1);
    expect(nodeOf(g, 'file:X')?.degree).toBe(2);
  });
  test('no containment edges are invented, and a list is only a node if a connector touches it', () => {
    const blocks = [list('list00000a', [['row00001', 'X']]), note('note000001', 'N')];
    const plain = graph(blocks, [], data([rel('r1', 'X', 'Y')], ['X', 'Y']));
    expect(plain.edges.map(e => e.key)).toEqual(['rel:r1']);
    expect(nodeOf(plain, 'item:list00000a')).toBeUndefined();
    const linked = graph(blocks, [conn('c1', 'list00000a', 'note000001')], data([rel('r1', 'X', 'Y')], ['X', 'Y']));
    expect(nodeOf(linked, 'item:list00000a')).toMatchObject({ itemType: 'filelist' });
    expect(linked.edges.map(e => e.key)).toEqual(['board:c1', 'rel:r1']);
  });
});

describe('one hop off the Board', () => {
  const blocks = [card('card000001', 'A')];
  test('the other end appears as off-board and the Board is not asked to hold it', () => {
    const g = graph(blocks, [], data([rel('r1', 'A', 'X')], ['A', 'X']));
    expect(nodeOf(g, 'file:X')).toMatchObject({ kind: 'off-board', onBoard: false, locations: [], name: 'X.pdf' });
  });
  test('a relationship with neither end on the Board is left out of This Board', () => {
    const g = graph(blocks, [], data([rel('r1', 'A', 'X'), rel('r2', 'X', 'W')], ['A', 'X', 'W']));
    expect(g.edges.map(e => e.key)).toEqual(['rel:r1']);
    expect(nodeOf(g, 'file:W')).toBeUndefined();
  });
  test('a file moved onto the Board keeps its node key', () => {
    const before = graph(blocks, [], data([rel('r1', 'A', 'X')], ['A', 'X']));
    const after = graph([...blocks, card('card000002', 'X')], [], data([rel('r1', 'A', 'X')], ['A', 'X']));
    expect(after.nodes.map(n => n.key)).toEqual(before.nodes.map(n => n.key));
    expect(nodeOf(after, 'file:X')?.kind).toBe('item');
  });
});

describe('unavailable', () => {
  const SECRETS = ['SECRET-NAME', 'SECRETFILEID', 'SECRET-LABEL', 'SECRET-DESC', 'SECRETROWFILE', 'application/x-secret'];
  const leaks = (value: unknown) => { const text = JSON.stringify(value); return SECRETS.filter(s => text.includes(s)); };
  const blocks = [
    card('card000001', 'A'), goneCard('card000002'), note('note000001', 'N'),
    { ...list('list00000a', [['row00001', null]]), } as BoardBlock,
  ];
  (blocks[3] as unknown as { filelist: { items: Array<Record<string, unknown>> } }).filelist.items[0].fileId = 'SECRETROWFILE';
  const connections: GraphConnections = {
    ...data([rel('r1', 'A', 'SECRETFILEID', { label: 'SECRET-LABEL', description: 'SECRET-DESC' }), rel('r2', 'SECRETFILEID', 'SECRETFILEID2', { label: 'SECRET-LABEL' })], ['A'], [{ id: 'u1', fileId: 'A' }, { id: 'u2', fileId: null }, { id: 'u3', fileId: 'SECRETFILEID' }]),
  };
  const g = graph(blocks, [conn('c1', 'card000002', 'note000001')], connections);

  test('a relationship with an end not in the openable list is no node and no edge', () => {
    expect(g.edges.map(e => e.key)).toEqual(['board:c1']);
    expect(g.nodes.some(n => (n.fileId || '').includes('SECRET'))).toBe(false);
  });
  test('planted names, ids, labels and descriptions never reach the model', () => {
    expect(leaks({ ...g })).toEqual([]);
  });
  test('they are counted apart from the graph, with only record ids and readable ends', () => {
    expect(g.unavailable.total).toBe(5);
    expect(g.unavailable.rows).toEqual([
      { recordId: 'r1', fileId: 'A' }, { recordId: 'r2', fileId: null }, { recordId: 'u1', fileId: 'A' }, { recordId: 'u2', fileId: null }, { recordId: 'u3', fileId: null },
    ]);
  });
  test('an unavailable end counts on the node of the file they can open', () => {
    const on = graph([card('card000001', 'A'), card('card000002', 'B')], [conn('c1', 'card000001', 'card000002')], data([], ['A'], [{ id: 'u1', fileId: 'A' }]));
    expect(nodeOf(on, 'file:A')?.unavailableCount).toBe(1);
  });
  test('an unavailable card stays on the Board under its block id, unnamed', () => {
    expect(nodeOf(g, 'item:card000002')).toMatchObject({ name: 'Unavailable file', available: false, fileId: null, itemType: 'file', onBoard: true });
  });
  test('an unavailable folder too', () => {
    const f = graph([goneCard('fold000001', 'folder'), note('note000001', 'N')], [conn('c1', 'fold000001', 'note000001')]);
    expect(nodeOf(f, 'item:fold000001')).toMatchObject({ name: 'Unavailable folder', available: false });
  });
  test('an unavailable File List row places nothing', () => {
    const r = graph([list('list00000a', [['row00001', null]])], [], data([rel('r1', 'X', 'Y')], ['X', 'Y']));
    expect(r.nodes).toHaveLength(0);
  });
  test('the signature holds no unavailable identifier', () => {
    expect(leaks(g.signature)).toEqual([]);
  });
});

describe('duplicate names', () => {
  test('files with one name stay separate and are told apart', () => {
    const g = graph([card('card000001', 'A', 'Report.pdf'), card('card000002', 'B', 'Report.pdf')], [conn('c1', 'card000001', 'card000002')]);
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.map(n => n.name)).toEqual(['Report.pdf', 'Report.pdf']);
    expect(g.nodes.map(n => n.shortName)).toEqual(['Report.pdf', 'Report.pdf · 2']);
  });
  test('an item and an off-board file with one name are told apart', () => {
    const blocks = [card('card000001', 'A'), note('note000001', 'A.pdf')];
    const g = graph(blocks, [conn('c1', 'card000001', 'note000001')]);
    expect(new Set(g.nodes.map(n => n.shortName)).size).toBe(2);
  });
  test('a long name is shortened for labels and kept whole', () => {
    const long = 'n'.repeat(90);
    const g = graph([card('card000001', 'A', long), note('note000001', 'N')], [conn('c1', 'card000001', 'note000001')]);
    expect(nodeOf(g, 'file:A')?.name).toBe(long);
    expect(Array.from(nodeOf(g, 'file:A')?.shortName || '').length).toBe(40);
  });
});

describe('legend and filters', () => {
  const blocks = [card('card000001', 'A'), card('card000002', 'B'), card('card000003', 'C')];
  const g = graph(blocks, [conn('c1', 'card000001', 'card000002'), conn('c2', 'card000002', 'card000003', 'line')],
    data([rel('r1', 'A', 'B', { type: 'depends_on' }), rel('r2', 'A', 'C', { type: 'depends_on' }), rel('r3', 'B', 'C', { type: 'custom', label: 'mine' })], ['A', 'B', 'C']));

  test('the legend counts what is there and lists only present types, in a fixed order', () => {
    expect(g.legend.board).toEqual({ total: 2, line: 1, arrow: 1 });
    expect(g.legend.file).toEqual({ total: 3 });
    expect(g.legend.types).toEqual([{ type: 'depends_on', label: 'Depends on', count: 2 }, { type: 'custom', label: 'Custom', count: 1 }]);
  });
  test('no filters shows everything', () => {
    const v = visibleGraph(g, NO_FILTERS);
    expect(v.edges.size).toBe(5);
    expect(v.nodes.size).toBe(3);
  });
  test('hiding a system', () => {
    expect(Array.from(visibleGraph(g, { ...NO_FILTERS, showBoard: false }).edges).sort()).toEqual(['rel:r1', 'rel:r2', 'rel:r3']);
    expect(Array.from(visibleGraph(g, { ...NO_FILTERS, showFile: false }).edges).sort()).toEqual(['board:c1', 'board:c2']);
  });
  test('hiding a style or type', () => {
    expect(visibleGraph(g, { ...NO_FILTERS, hiddenStyles: new Set<BoardConnector['style']>(['line']) }).edges.has('board:c2')).toBe(false);
    expect(visibleGraph(g, { ...NO_FILTERS, hiddenTypes: new Set<RelationshipType>(['depends_on']) }).edges.has('rel:r1')).toBe(false);
  });
  test('a node with nothing left showing is hidden', () => {
    const small = graph([card('card000001', 'A'), card('card000002', 'B')], [conn('c1', 'card000001', 'card000002')]);
    expect(visibleGraph(small, { ...NO_FILTERS, showBoard: false }).nodes.size).toBe(0);
  });
});

describe('caps', () => {
  const items = Array.from({ length: 150 }, (_, i) => card(`card${String(i).padStart(6, '0')}`, `F${String(i).padStart(4, '0')}`));
  const rows: Array<[string, string]> = Array.from({ length: 100 }, (_, i) => [`row${String(i).padStart(5, '0')}`, `L${String(i).padStart(4, '0')}`]);
  const off = Array.from({ length: 300 }, (_, i) => `O${String(i).padStart(4, '0')}`);
  const fileIds = [...items.map((_, i) => `F${String(i).padStart(4, '0')}`), ...rows.map(r => r[1]), ...off];
  const relationships = [
    ...items.map((_, i) => rel(`a${i}`, `F${String(i).padStart(4, '0')}`, off[i])),
    ...rows.map((r, i) => rel(`b${i}`, r[1], off[150 + i])),
    ...off.slice(250).map((o, i) => rel(`c${i}`, 'F0000', o)),
    // Two extra connections make these off-board files the most connected, so they are the ones kept.
    rel('d1', 'F0001', off[299]), rel('d2', 'F0002', off[299]),
  ];
  const g = graph([...items, list('list00000a', rows)], [], data(relationships, fileIds));

  test('stops at 300 nodes, Board items first, then File Lists, then off-board', () => {
    expect(g.nodes).toHaveLength(MAX_GRAPH_NODES);
    expect(g.nodes.filter(n => n.kind === 'item')).toHaveLength(150);
    expect(g.nodes.filter(n => n.kind === 'list-file')).toHaveLength(100);
    expect(g.nodes.filter(n => n.kind === 'off-board')).toHaveLength(50);
  });
  test('degree decides among off-board files', () => {
    expect(nodeOf(g, `file:${off[299]}`)).toBeDefined();
  });
  test('omissions are reported exactly', () => {
    expect(g.omitted.nodes).toBe(250);
    expect(g.omitted.byKind).toEqual({ item: 0, 'list-file': 0, 'off-board': 250 });
    expect(g.omitted.edges).toBe(relationships.length - g.edges.length);
    expect(g.omitted.edges).toBeGreaterThan(0);
  });
  test('no edge points at a node that was left out', () => {
    const keys = new Set(g.nodes.map(n => n.key));
    expect(g.edges.every(e => keys.has(e.source) && keys.has(e.target))).toBe(true);
  });
  test('degree and parallel counts describe what is drawn', () => {
    const count = new Map<string, number>();
    g.edges.forEach((e) => { count.set(e.source, (count.get(e.source) || 0) + 1); count.set(e.target, (count.get(e.target) || 0) + 1); });
    expect(g.nodes.every(n => n.degree === (count.get(n.key) || 0))).toBe(true);
  });
  test('under the cap nothing is omitted', () => {
    const small = graph([card('card000001', 'A')], [], data([rel('r1', 'A', 'B')], ['A', 'B']));
    expect(small.omitted).toEqual({ nodes: 0, edges: 0, byKind: { item: 0, 'list-file': 0, 'off-board': 0 } });
  });
  test('the server having stopped early is passed on', () => {
    expect(graph([card('card000001', 'A')], [], data([rel('r1', 'A', 'B')], ['A', 'B'], [], true)).truncated).toBe(true);
  });
  test('more than 300 connectors or 500 relationships are capped and counted', () => {
    const blocks = Array.from({ length: 2 }, (_, i) => note(`note00000${i}`, `N${i}`));
    const many = Array.from({ length: 305 }, (_, i) => conn(`c${String(i).padStart(4, '0')}`, 'note000000', 'note000001'));
    const capped = graph(blocks, many);
    expect(capped.edges).toHaveLength(300);
    expect(capped.omitted.edges).toBe(5);
    const rels = Array.from({ length: 503 }, (_, i) => rel(`r${String(i).padStart(4, '0')}`, 'A', 'B'));
    const r = graph([card('card000001', 'A')], [], data(rels, ['A', 'B']));
    expect(r.edges).toHaveLength(500);
    expect(r.omitted.edges).toBe(3);
  });
});

describe('purity', () => {
  const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value as object).forEach(freeze); Object.freeze(value); } return value; };
  const input = () => ({
    scope: 'board' as GraphScope,
    blocks: [card('card000001', 'A'), list('list00000a', [['row00001', 'B']]), note('note000001', 'N')],
    connectors: [conn('c1', 'card000001', 'note000001')],
    connections: data([rel('r1', 'A', 'B'), rel('r2', 'A', 'X')], ['A', 'B', 'X'], [{ id: 'u1', fileId: 'A' }]),
  });
  test('nothing it is given is changed', () => {
    const original = JSON.stringify(input());
    const frozen = freeze(input());
    expect(() => buildGraph(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(original);
  });
  test('filtering changes nothing', () => {
    const g = buildGraph(input());
    const before = JSON.stringify(g);
    visibleGraph(freeze(g), { ...NO_FILTERS, showBoard: false });
    expect(JSON.stringify(g)).toBe(before);
  });
  test('the graph modules use no network, storage or AI', () => {
    ['boardGraph.ts', 'boardGraphLayout.ts'].forEach((file) => {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/axios|fetch\(|XMLHttpRequest|socket\.io|ollama|localStorage|sessionStorage|Math\.random/i);
      source.split('\n').filter(l => /^import /.test(l)).forEach((l) => {
        expect(l).toMatch(/^import type |from '\.\/board(Connectors|Graph)'/);
      });
    });
  });
});

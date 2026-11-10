import type { GraphNode } from './boardGraph';
import { clampScale, edgeShape, fitScale, matchNodes, MAX_SCALE, MIN_SCALE, nextScale, scrollToShow, worldSize, WORLD_PAD } from './boardGraphDraw';

const node = (key: string, name: string, available = true) => ({ key, name, shortName: name, available }) as GraphNode;
const W = 176, H = 56;
const startOf = (d: string) => d.match(/^M([\d.-]+),([\d.-]+)/)!.slice(1).map(Number);
const endOf = (d: string) => d.trim().split(' ').pop()!.split(',').map(Number);

describe('zoom', () => {
  test('stays between 25% and 200%', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(9)).toBe(MAX_SCALE);
  });
  test('steps up and down and stops at the ends', () => {
    expect(nextScale(1, 1)).toBe(1.1);
    expect(nextScale(1, -1)).toBe(0.9);
    expect(nextScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(nextScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });
  test('steps from a Fit between two stops', () => {
    expect(nextScale(0.61, 1)).toBe(0.67);
    expect(nextScale(0.61, -1)).toBe(0.5);
  });
  test('a Fit just beside a stop still moves visibly on the first press', () => {
    expect(nextScale(0.4967, 1)).toBe(0.67);
    expect(nextScale(0.5033, -1)).toBe(0.33);
  });
  test('Fit shrinks to the tighter side and never enlarges', () => {
    expect(fitScale(2000, 500, 1000, 800)).toBe(0.5);
    expect(fitScale(500, 2000, 1000, 800)).toBe(0.4);
    expect(fitScale(200, 200, 1000, 800)).toBe(1);
  });
  test('Fit stops at the minimum, and an unmeasured view is 100%', () => {
    expect(fitScale(99999, 99999, 800, 600)).toBe(MIN_SCALE);
    expect(fitScale(100, 100, 0, 0)).toBe(1);
  });
  test('the world has room around the nodes', () => {
    expect(worldSize(1000, 500)).toEqual({ width: 1000 + WORLD_PAD * 2, height: 500 + WORLD_PAD * 2 });
  });
});

describe('edges', () => {
  const a = { x: 0, y: 0 }, b = { x: 440, y: 88 };
  test('run from side to side between columns', () => {
    const s = edgeShape(a, b, W, H, 0, 1, false);
    expect(startOf(s.d)).toEqual([W, H / 2]);
    expect(endOf(s.d)).toEqual([440, 88 + H / 2]);
  });
  test('a line has no head and an arrow has one', () => {
    expect(edgeShape(a, b, W, H, 0, 1, false).head).toBeUndefined();
    expect(edgeShape(a, b, W, H, 0, 1, true).head).toMatch(/^M440\.0,116\.0 /);
  });
  test('an arrow going left points left and leaves from the left side', () => {
    const s = edgeShape(b, a, W, H, 0, 1, true);
    expect(startOf(s.d)).toEqual([440, 88 + H / 2]);
    expect(s.head).toMatch(new RegExp(`^M${W}\\.0,28\\.0 `));
  });
  test('within a column it bows out to the right', () => {
    const s = edgeShape({ x: 0, y: 0 }, { x: 0, y: 176 }, W, H, 0, 1, false);
    expect(startOf(s.d)[0]).toBe(W);
    expect(s.x).toBeGreaterThan(W);
  });
  test('parallel edges take different paths', () => {
    const shapes = [0, 1, 2].map(i => edgeShape(a, b, W, H, i, 3, false));
    expect(new Set(shapes.map(s => s.d)).size).toBe(3);
    expect(startOf(shapes[0].d)[1]).toBeLessThan(startOf(shapes[1].d)[1]);
    expect(startOf(shapes[1].d)[1]).toBeLessThan(startOf(shapes[2].d)[1]);
  });
  test('opposite directions on one pair do not share a path', () => {
    const there = edgeShape(a, b, W, H, 0, 2, true), back = edgeShape(b, a, W, H, 1, 2, true);
    expect(startOf(there.d)[1]).not.toBe(endOf(back.d)[1]);
  });
  test('many parallel edges stay on the card', () => {
    [...Array(12)].forEach((_, i) => {
      const y = startOf(edgeShape(a, b, W, H, i, 12, false).d)[1];
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(H);
    });
  });
});

describe('search', () => {
  const nodes = [node('file:1', 'Budget 2026.pdf'), node('file:2', 'notes.txt'), node('item:x', 'Unavailable file', false)];
  test('finds available names, ignoring case and outer spaces', () => {
    expect(matchNodes(nodes, '  BUDGET ')).toEqual(['file:1']);
  });
  test('an empty search finds nothing', () => {
    expect(matchNodes(nodes, '   ')).toEqual([]);
  });
  test('an unavailable node can never be found', () => {
    expect(matchNodes(nodes, 'unavailable')).toEqual([]);
  });
});

describe('scrolling a node into view', () => {
  test('leaves a visible node alone', () => {
    expect(scrollToShow(100, 50, 0, 500)).toBe(0);
  });
  test('scrolls back for one before the view, never below zero', () => {
    expect(scrollToShow(100, 50, 400, 500)).toBe(76);
    expect(scrollToShow(5, 50, 400, 500)).toBe(0);
  });
  test('scrolls on for one past the view', () => {
    expect(scrollToShow(600, 50, 0, 500)).toBe(174);
  });
});

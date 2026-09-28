import { describe, expect, it } from 'vitest';
import { FRAME, GAP, HEADER, MIN_H, MIN_W, clampRatios, computeTiles, contentArea, dragDivider, tooSmall, type Rect } from '../../src/main/tile-layout';

const area = { x: 0, y: 84, width: 1000, height: 800 };
const noOverlap = (rs: Array<{ x: number; y: number; width: number; height: number }>) => {
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i];
      const b = rs[j];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlap) return false;
    }
  return true;
};
const inside = (r: { x: number; y: number; width: number; height: number }) => r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;

describe('tile layout', () => {
  it('columns: panes side by side, gaps for dividers, views inset for the chrome frame + header', () => {
    const { panes, dividers } = computeTiles(area, { ids: [1, 2], layout: 'columns', ratios: [0.5, 0.5] });
    expect(panes.map((p) => p.tabId)).toEqual([1, 2]);
    expect(panes[0].outer.x + panes[0].outer.width + GAP).toBe(panes[1].outer.x);
    expect(panes[1].outer.x + panes[1].outer.width).toBe(1000);
    expect(panes[0].view).toEqual({ x: FRAME, y: 84 + FRAME + HEADER, width: panes[0].outer.width - 2 * FRAME, height: 800 - 2 * FRAME - HEADER });
    expect(dividers).toHaveLength(1);
    expect(dividers[0].orientation).toBe('vertical');
    expect(noOverlap(panes.map((p) => p.outer))).toBe(true);
  });

  it('rows and 2x2 grid (and 3 in a grid) stay inside the area without overlap', () => {
    for (const [layout, n] of [['rows', 3], ['grid', 4], ['grid', 3], ['columns', 4]] as const) {
      const ids = [1, 2, 3, 4].slice(0, n);
      const { panes } = computeTiles(area, { ids, layout, ratios: [] });
      expect(panes).toHaveLength(n);
      expect(panes.every((p) => inside(p.outer))).toBe(true);
      expect(noOverlap(panes.map((p) => p.outer))).toBe(true);
      expect(noOverlap(panes.map((p) => p.view))).toBe(true);
    }
  });

  it('never tiles more than 4 panes', () => {
    expect(computeTiles(area, { ids: [1, 2, 3, 4, 5], layout: 'columns', ratios: [] }).panes).toHaveLength(4);
  });

  it('dragging a divider respects the minimum pane size', () => {
    const t = { ids: [1, 2], layout: 'columns' as const, ratios: [0.5, 0.5] };
    const r = dragDivider(area, t, 'c0', 10);
    const { panes } = computeTiles(area, { ...t, ratios: r });
    expect(panes[0].outer.width).toBeGreaterThanOrEqual(MIN_W - 1);
    const r2 = dragDivider(area, t, 'c0', 700);
    expect(computeTiles(area, { ...t, ratios: r2 }).panes[0].outer.width).toBeGreaterThan(650);
    const g = { ids: [1, 2, 3, 4], layout: 'grid' as const, ratios: [0.5, 0.5] };
    const rg = dragDivider(area, g, 'row', 84 + 5);
    expect(computeTiles(area, { ...g, ratios: rg }).panes[0].outer.height).toBeGreaterThanOrEqual(MIN_H - 1);
  });

  it('clampRatios normalises garbage input', () => {
    const r = clampRatios([Number.NaN, -1, 5], 1000, 100);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Math.min(...r)).toBeGreaterThan(0);
  });
});

describe('tiny windows: panes never overlap each other or the agent panel', () => {
  const within = (r: Rect, o: Rect) => r.width >= 0 && r.height >= 0 && r.x >= o.x && r.y >= o.y && r.x + r.width <= o.x + o.width && r.y + r.height <= o.y + o.height;
  const disjoint = (rs: Rect[]) => rs.every((p, i) => rs.every((q, j) => i >= j || !(p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height)));

  for (const winW of [1440, 800, 640, 500, 300, 100, 0]) {
    for (const winH of [920, 480, 120]) {
      it(`window ${winW}x${winH}`, () => {
        const area = contentArea(winW, winH, 84, 440);
        expect(area.x + area.width).toBeLessThanOrEqual(Math.max(0, winW - 440)); // left of the agent panel
        for (const [layout, n] of [['columns', 2], ['columns', 4], ['rows', 3], ['grid', 3], ['grid', 4]] as const) {
          const t = { ids: [1, 2, 3, 4].slice(0, n), layout, ratios: [] as number[] };
          const { panes, dividers } = computeTiles(area, t);
          expect(panes).toHaveLength(n);
          for (const p of panes) {
            expect(within(p.outer, area), `${layout} ${n} outer ${JSON.stringify(p.outer)} in ${JSON.stringify(area)}`).toBe(true);
            expect(within(p.view, p.outer), `${layout} ${n} view`).toBe(true);
          }
          for (const d of dividers) expect(within(d.rect, area)).toBe(true);
          expect(disjoint(panes.map((p) => p.outer))).toBe(true);
          // dragging in a tiny window keeps everything inside too
          const r = dragDivider(area, t, layout === 'grid' ? 'col' : layout === 'rows' ? 'r0' : 'c0', area.x + area.width * 2);
          const after = computeTiles(area, { ...t, ratios: r }).panes;
          expect(after.every((p) => within(p.outer, area))).toBe(true);
          expect(disjoint(after.map((p) => p.outer))).toBe(true);
        }
      });
    }
  }

  it('flags layouts that cannot give panes their minimum size', () => {
    expect(tooSmall(contentArea(1440, 920, 84, 440), { ids: [1, 2], layout: 'columns', ratios: [] })).toBe(false);
    expect(tooSmall(contentArea(800, 600, 84, 440), { ids: [1, 2], layout: 'columns', ratios: [] })).toBe(true);
    expect(tooSmall(contentArea(1440, 400, 84, 440), { ids: [1, 2, 3], layout: 'rows', ratios: [] })).toBe(true);
    expect(tooSmall(contentArea(500, 920, 84, 440), { ids: [1, 2, 3, 4], layout: 'grid', ratios: [] })).toBe(true);
  });
});

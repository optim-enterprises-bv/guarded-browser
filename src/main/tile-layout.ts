// Pure geometry for split view (tab tiling). No Electron imports: unit-tested in test/unit.
//
// A pane's OUTER rect is drawn by the browser chrome (frame + header strip, see renderer); the web
// page's view gets the INNER rect. Pages can never draw outside their view, so the frame and header
// (focus highlight, "AGENT ACTIVE") cannot be drawn or faked by page content.

export type TileLayout = 'columns' | 'rows' | 'grid';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneGeometry {
  tabId: number;
  outer: Rect;
  view: Rect;
}

export interface DividerGeometry {
  /** which ratio this divider drives */
  key: 'col' | 'row' | `c${number}` | `r${number}`;
  orientation: 'vertical' | 'horizontal';
  rect: Rect;
}

export interface TileState {
  ids: number[];
  layout: TileLayout;
  /** columns / rows: fraction of the area per pane (sums to 1). grid: [colSplit, rowSplit]. */
  ratios: number[];
}

export const FRAME = 3;
export const HEADER = 24;
export const GAP = 8;
export const MIN_W = 240;
export const MIN_H = 160;
export const MAX_TILES = 4;

export function defaultRatios(n: number, layout: TileLayout): number[] {
  if (layout === 'grid') return [0.5, 0.5];
  return Array.from({ length: n }, () => 1 / n);
}

export function innerRect(outer: Rect, chrome: boolean): Rect {
  if (!chrome) return { ...outer };
  return {
    x: outer.x + FRAME,
    y: outer.y + FRAME + HEADER,
    width: Math.max(1, outer.width - 2 * FRAME),
    height: Math.max(1, outer.height - 2 * FRAME - HEADER),
  };
}

/** Clamp a list of fractions so every pane is at least `min` px out of `total`, then renormalise. */
export function clampRatios(ratios: number[], total: number, min: number): number[] {
  const n = ratios.length;
  const usable = total - GAP * (n - 1);
  const minF = Math.min(1 / n, min / Math.max(1, usable));
  let r = ratios.map((x) => (Number.isFinite(x) && x > 0 ? x : minF));
  const sum = r.reduce((a, b) => a + b, 0);
  r = r.map((x) => x / sum);
  // raise the small ones, take the difference proportionally from the others
  for (let pass = 0; pass < 3; pass++) {
    const deficit = r.reduce((a, x) => a + Math.max(0, minF - x), 0);
    if (deficit <= 1e-9) break;
    const spare = r.reduce((a, x) => a + Math.max(0, x - minF), 0);
    r = r.map((x) => (x < minF ? minF : x - (deficit * (x - minF)) / spare));
  }
  return r;
}

function split(start: number, total: number, fractions: number[]): Array<[number, number]> {
  const usable = total - GAP * (fractions.length - 1);
  const out: Array<[number, number]> = [];
  let pos = start;
  fractions.forEach((f, i) => {
    const size = i === fractions.length - 1 ? start + total - pos : Math.round(usable * f);
    out.push([pos, size]);
    pos += size + GAP;
  });
  return out;
}

/** Compute pane and divider rects for a tile state inside `area`. */
export function computeTiles(area: Rect, t: TileState): { panes: PaneGeometry[]; dividers: DividerGeometry[]; ratios: number[] } {
  const ids = t.ids.slice(0, MAX_TILES);
  const panes: PaneGeometry[] = [];
  const dividers: DividerGeometry[] = [];
  const pane = (tabId: number, outer: Rect) => panes.push({ tabId, outer, view: innerRect(outer, true) });
  if (t.layout === 'grid' && ids.length >= 3) {
    const [c, r] = [clampRatios([t.ratios[0] ?? 0.5, 1 - (t.ratios[0] ?? 0.5)], area.width, MIN_W), clampRatios([t.ratios[1] ?? 0.5, 1 - (t.ratios[1] ?? 0.5)], area.height, MIN_H)];
    const cols = split(area.x, area.width, c);
    const rows = split(area.y, area.height, r);
    pane(ids[0], { x: cols[0][0], y: rows[0][0], width: cols[0][1], height: rows[0][1] });
    pane(ids[1], { x: cols[1][0], y: rows[0][0], width: cols[1][1], height: rows[0][1] });
    if (ids.length === 3) pane(ids[2], { x: area.x, y: rows[1][0], width: area.width, height: rows[1][1] });
    else {
      pane(ids[2], { x: cols[0][0], y: rows[1][0], width: cols[0][1], height: rows[1][1] });
      pane(ids[3], { x: cols[1][0], y: rows[1][0], width: cols[1][1], height: rows[1][1] });
    }
    dividers.push({ key: 'col', orientation: 'vertical', rect: { x: cols[0][0] + cols[0][1], y: area.y, width: GAP, height: ids.length === 3 ? rows[0][1] : area.height } });
    dividers.push({ key: 'row', orientation: 'horizontal', rect: { x: area.x, y: rows[0][0] + rows[0][1], width: area.width, height: GAP } });
    return { panes, dividers, ratios: [c[0], r[0]] };
  }
  const layout = t.layout === 'grid' ? 'columns' : t.layout;
  const vertical = layout === 'columns';
  const ratios = clampRatios(t.ratios.length === ids.length ? t.ratios : defaultRatios(ids.length, layout), vertical ? area.width : area.height, vertical ? MIN_W : MIN_H);
  const parts = split(vertical ? area.x : area.y, vertical ? area.width : area.height, ratios);
  parts.forEach(([pos, size], i) => {
    pane(ids[i], vertical ? { x: pos, y: area.y, width: size, height: area.height } : { x: area.x, y: pos, width: area.width, height: size });
    if (i < parts.length - 1) {
      dividers.push({
        key: vertical ? `c${i}` : `r${i}`,
        orientation: vertical ? 'vertical' : 'horizontal',
        rect: vertical ? { x: pos + size, y: area.y, width: GAP, height: area.height } : { x: area.x, y: pos + size, width: area.width, height: GAP },
      });
    }
  });
  return { panes, dividers, ratios };
}

/**
 * Move a divider to pixel position `at` (x for vertical, y for horizontal dividers) and return the
 * new ratios (clamped to the minimum pane size).
 */
export function dragDivider(area: Rect, t: TileState, key: DividerGeometry['key'], at: number): number[] {
  if (t.layout === 'grid' && t.ids.length >= 3) {
    const r = [...t.ratios];
    if (key === 'col') r[0] = (at - area.x) / Math.max(1, area.width - GAP);
    if (key === 'row') r[1] = (at - area.y) / Math.max(1, area.height - GAP);
    return computeTiles(area, { ...t, ratios: r }).ratios;
  }
  const vertical = t.layout !== 'rows';
  const i = Number(String(key).slice(1));
  const cur = computeTiles(area, t).ratios;
  const total = (vertical ? area.width : area.height) - GAP * (cur.length - 1);
  const start = vertical ? area.x : area.y;
  // pixel boundaries of panes i and i+1
  const before = cur.slice(0, i).reduce((a, x) => a + x, 0) * total + GAP * i;
  const pair = (cur[i] + cur[i + 1]) * total;
  let left = at - start - before;
  left = Math.max(0, Math.min(pair, left));
  const next = [...cur];
  next[i] = left / total;
  next[i + 1] = (pair - left) / total;
  return clampRatios(next, vertical ? area.width : area.height, vertical ? MIN_W : MIN_H);
}

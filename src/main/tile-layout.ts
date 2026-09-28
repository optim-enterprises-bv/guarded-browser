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

/** The page view inside a pane. Always contained in `outer` (0-sized when the pane is too small). */
export function innerRect(outer: Rect, chrome: boolean): Rect {
  if (!chrome) return { ...outer };
  const width = Math.max(0, outer.width - 2 * FRAME);
  const height = Math.max(0, outer.height - 2 * FRAME - HEADER);
  return {
    x: outer.x + Math.min(FRAME, outer.width),
    y: outer.y + Math.min(FRAME + HEADER, outer.height),
    width,
    height,
  };
}

/** Page area of the window: right of nothing, left of the agent panel, below the top bar. Never negative. */
export function contentArea(winWidth: number, winHeight: number, topBar: number, panel: number): Rect {
  return { x: 0, y: topBar, width: Math.max(0, Math.floor(winWidth) - panel), height: Math.max(0, Math.floor(winHeight) - topBar) };
}

/** Gap between panes: shrinks (down to 0) when the area is too small for full gaps. */
export function gapFor(total: number, n: number): number {
  return n > 1 ? Math.max(0, Math.min(GAP, Math.floor(Math.max(0, total) / (4 * (n - 1))))) : 0;
}

/** Clamp a list of fractions so every pane is at least `min` px out of `total`, then renormalise. */
export function clampRatios(ratios: number[], total: number, min: number): number[] {
  const n = ratios.length;
  const usable = Math.max(0, total - gapFor(total, n) * (n - 1));
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

/**
 * Split [start, start+total) into consecutive segments separated by gaps. Every segment has a
 * non-negative size and lies inside the range, whatever the area size (panes shrink below the
 * minimum rather than overflow into the agent panel or each other).
 */
function split(start: number, total: number, fractions: number[]): Array<[number, number]> {
  const n = fractions.length;
  const t = Math.max(0, Math.floor(total));
  const gap = gapFor(t, n);
  const usable = Math.max(0, t - gap * (n - 1));
  const out: Array<[number, number]> = [];
  let used = 0;
  fractions.forEach((f, i) => {
    const size = i === n - 1 ? usable - used : Math.max(0, Math.min(usable - used, Math.floor(usable * f)));
    out.push([start + used + gap * i, size]);
    used += size;
  });
  return out;
}

/** Compute pane and divider rects for a tile state inside `area`. */
/** True when the area cannot give every pane its minimum size (the UI shows a notice). */
export function tooSmall(area: Rect, t: TileState): boolean {
  const n = Math.min(t.ids.length, MAX_TILES);
  if (t.layout === 'grid' && n >= 3) return area.width < 2 * MIN_W + GAP || area.height < 2 * MIN_H + GAP;
  if (t.layout === 'rows') return area.height < n * MIN_H + (n - 1) * GAP;
  return area.width < n * MIN_W + (n - 1) * GAP;
}

export function computeTiles(area: Rect, t: TileState): { panes: PaneGeometry[]; dividers: DividerGeometry[]; ratios: number[] } {
  area = { ...area, width: Math.max(0, Math.floor(area.width)), height: Math.max(0, Math.floor(area.height)) };
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
    dividers.push({ key: 'col', orientation: 'vertical', rect: { x: cols[0][0] + cols[0][1], y: area.y, width: cols[1][0] - cols[0][0] - cols[0][1], height: ids.length === 3 ? rows[0][1] : area.height } });
    dividers.push({ key: 'row', orientation: 'horizontal', rect: { x: area.x, y: rows[0][0] + rows[0][1], width: area.width, height: rows[1][0] - rows[0][0] - rows[0][1] } });
    return { panes, dividers, ratios: [c[0], r[0]] };
  }
  const layout = t.layout === 'grid' ? 'columns' : t.layout;
  const vertical = layout === 'columns';
  const ratios = clampRatios(t.ratios.length === ids.length ? t.ratios : defaultRatios(ids.length, layout), vertical ? area.width : area.height, vertical ? MIN_W : MIN_H);
  const parts = split(vertical ? area.x : area.y, vertical ? area.width : area.height, ratios);
  parts.forEach(([pos, size], i) => {
    pane(ids[i], vertical ? { x: pos, y: area.y, width: size, height: area.height } : { x: area.x, y: pos, width: area.width, height: size });
    if (i < parts.length - 1) {
      const g = parts[i + 1][0] - pos - size;
      dividers.push({
        key: vertical ? `c${i}` : `r${i}`,
        orientation: vertical ? 'vertical' : 'horizontal',
        rect: vertical ? { x: pos + size, y: area.y, width: g, height: area.height } : { x: area.x, y: pos + size, width: area.width, height: g },
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
    if (key === 'col') r[0] = (at - area.x) / Math.max(1, area.width - gapFor(area.width, 2));
    if (key === 'row') r[1] = (at - area.y) / Math.max(1, area.height - gapFor(area.height, 2));
    return computeTiles(area, { ...t, ratios: r }).ratios;
  }
  const vertical = t.layout !== 'rows';
  const i = Number(String(key).slice(1));
  const cur = computeTiles(area, t).ratios;
  const span = vertical ? area.width : area.height;
  const gap = gapFor(span, cur.length);
  const total = Math.max(1, span - gap * (cur.length - 1));
  const start = vertical ? area.x : area.y;
  // pixel boundaries of panes i and i+1
  const before = cur.slice(0, i).reduce((a, x) => a + x, 0) * total + gap * i;
  const pair = (cur[i] + cur[i + 1]) * total;
  let left = at - start - before;
  left = Math.max(0, Math.min(pair, left));
  const next = [...cur];
  next[i] = left / total;
  next[i + 1] = (pair - left) / total;
  return clampRatios(next, vertical ? area.width : area.height, vertical ? MIN_W : MIN_H);
}

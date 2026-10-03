// Semantic markdown snapshot (AI capabilities item 2, "Lightpanda idea 1"): the page as structured
// markdown — headings, paragraphs, lists, tables, links as [text](url), images as their alt text and
// form summaries — for the QUARANTINED roles only (the chat role, and the reader). It never reaches
// the planner: the planner's view is the sanitised snapshot in sanitize.ts, unchanged.
//
// Two halves:
//   * MARKDOWN_JS runs in the tab's ISOLATED world (never the page's world) and returns plain data:
//     blocks of text runs, each run carrying the style facts the Injection X-ray measures. It already
//     skips text the X-ray rules call hidden; the facts travel with every run anyway.
//   * normalizeMdPage + pageMarkdown are pure: they re-validate and re-cap that data (every string in
//     it is page-derived), drop every run whose facts the X-ray rules (hiddenStyleReasons) call hidden
//     — a second, unit-tested enforcement of the same rule — and render capped markdown.
//
// Never included: script / style / noscript / template text, HTML comments, attribute text other
// than a visible image's alt, form field VALUES (only labels and types), iframes, select options.

import { hiddenStyleReasons, injectedHelpersSource } from './xray';

export const MD_LIMITS = {
  /** DOM nodes visited before the extractor stops */
  maxNodes: 30_000,
  maxBlocks: 2_000,
  /** text runs per block */
  maxRuns: 200,
  maxRunChars: 1_000,
  maxRows: 60,
  maxCells: 16,
  maxUrl: 300,
  maxFields: 30,
  maxLabel: 60,
  /** images rendered smaller than this (CSS px, either side) are tracking pixels, not content */
  minImagePx: 8,
  /** default size of the rendered markdown */
  maxChars: 24_000,
} as const;

/** The X-ray's per-text facts (the input of hiddenStyleReasons). */
export interface MdFacts {
  displayNone: boolean;
  visibility: string;
  opacity: number;
  fontSizePx: number;
  clipped: boolean;
  offScreen: boolean;
  contrast: number | null;
  ariaHidden: boolean;
}

export interface MdRun {
  text: string;
  /** set when the run is inside a link (http(s) / mailto only) */
  href?: string;
  /** an image: `text` is its alt text, w / h its rendered size */
  img?: { w: number; h: number };
  facts: MdFacts;
}

export interface MdField {
  type: string;
  label: string;
}

export type MdBlock =
  | { kind: 'heading'; level: number; runs: MdRun[]; quote?: boolean }
  | { kind: 'paragraph'; runs: MdRun[]; quote?: boolean }
  | { kind: 'item'; depth: number; ordered: boolean; n: number; runs: MdRun[]; quote?: boolean }
  | { kind: 'pre'; runs: MdRun[]; quote?: boolean }
  | { kind: 'table'; rows: Array<{ header: boolean; cells: MdRun[][] }> }
  | { kind: 'form'; method: string; action: string; fields: MdField[]; buttons: string[]; facts: MdFacts }
  | { kind: 'rule' };

export interface MdPage {
  url: string;
  title: string;
  blocks: MdBlock[];
  /** the extractor stopped at a limit */
  truncated: boolean;
  /** hidden text pieces the extractor skipped */
  hiddenDropped: number;
}

// ------------------------------------------------------------------ isolated-world extractor

/**
 * The extractor. Evaluated in the isolated world with the X-ray's INJECTED helpers (the same
 * hidden-text rules, the same contrast maths). Returns plain data only; reads no field value.
 */
export const MARKDOWN_JS = `(() => {
${injectedHelpersSource()}
const LIM = ${JSON.stringify(MD_LIMITS)};
const body = document.body;
const out = { url: location.href, title: clipText(document.title || '', 300), blocks: [], truncated: false, hiddenDropped: 0 };
if (!body) return out;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'OPTION', 'SELECT', 'DATALIST', 'HEAD', 'TITLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'INPUT', 'LINK', 'META']);
const INLINE = /^(inline|inline-block|inline-flex|inline-grid|contents|ruby|ruby-text)$/;
const de = document.documentElement;
const scroll = { x: window.scrollX, y: window.scrollY };
const docBox = { width: Math.max(de.scrollWidth, window.innerWidth), height: Math.max(de.scrollHeight, window.innerHeight) };
const range = document.createRange();
let visited = 0;

const chainCache = new Map();
function chain(el) {
  if (!el || el.nodeType !== 1) return { none: false, op: 1, aria: false, clip: false };
  const hit = chainCache.get(el);
  if (hit) return hit;
  const p = chain(el.parentElement);
  const cs = getComputedStyle(el);
  const o = parseFloat(cs.opacity);
  let clipped = p.clip;
  if (!clipped) {
    const r = el.getBoundingClientRect();
    clipped = isClipped({ clip: cs.clip, clipPath: cs.clipPath, overflow: cs.overflow, width: r.width, height: r.height });
  }
  const c = { none: p.none || cs.display === 'none', op: p.op * (Number.isNaN(o) ? 1 : o), aria: p.aria || el.getAttribute('aria-hidden') === 'true', clip: clipped };
  chainCache.set(el, c);
  return c;
}
const bgCache = new Map();
function backgroundOf(el) {
  const layers = [];
  for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
    if (bgCache.has(a)) { const b = bgCache.get(a); if (b === null) return null; layers.push(b); break; }
    const cs = getComputedStyle(a);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = parseCssColor(cs.backgroundColor);
    if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
  }
  let res = [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) res = layers[i][3] >= 1 ? layers[i] : blendOver(layers[i], res);
  bgCache.set(el, res);
  return res;
}
function factsOf(el, textNode) {
  const c = chain(el);
  const cs = getComputedStyle(el);
  let offScreen = false;
  let contrast = null;
  if (!c.none) {
    let rr;
    if (textNode) { range.selectNodeContents(textNode); rr = range.getBoundingClientRect(); } else rr = el.getBoundingClientRect();
    offScreen = isOffScreen(rr, scroll, docBox);
    if (textNode) {
      const fg = parseCssColor(cs.color);
      const bg = backgroundOf(el);
      if (fg && bg) contrast = contrastRatio(fg, bg);
    }
  }
  return { displayNone: !!c.none, visibility: String(cs.visibility), opacity: c.op, fontSizePx: textNode ? (parseFloat(cs.fontSize) || 0) : 16, clipped: !!c.clip, offScreen, contrast, ariaHidden: !!c.aria };
}
const linkOf = (a) => {
  const h = String(a.href || '');
  return /^(https?:|mailto:)/i.test(h) ? h.slice(0, LIM.maxUrl) : '';
};

let cur = null;
function push(b) {
  if (out.blocks.length >= LIM.maxBlocks) { out.truncated = true; return; }
  out.blocks.push(b);
}
function flush() {
  if (cur && cur.runs.some((r) => r.text.trim())) {
    const b = { kind: cur.kind, runs: cur.runs };
    if (cur.kind === 'heading') b.level = cur.level;
    if (cur.kind === 'item') { b.depth = cur.depth; b.ordered = cur.ordered; b.n = cur.n; }
    if (cur.quote) b.quote = true;
    push(b);
  }
  cur = null;
}
function open(kind, ctx, extra) {
  flush();
  cur = Object.assign({ kind, runs: [], quote: !!ctx.quote }, extra || {});
}
function addRun(run, ctx) {
  if (ctx.cell) { if (ctx.cell.length < LIM.maxRuns) ctx.cell.push(run); return; }
  if (!cur) cur = { kind: ctx.pre ? 'pre' : 'paragraph', runs: [], quote: !!ctx.quote };
  if (cur.runs.length < LIM.maxRuns) cur.runs.push(run); else out.truncated = true;
}
function boundary(ctx) {
  // a block boundary inside a table cell or a list item's own text is a space, not a new block
  if (ctx.cell) { ctx.cell.push({ text: ' ', facts: VISIBLE }); return; }
  if (cur && cur.kind === 'paragraph') flush();
  else if (cur) cur.runs.push({ text: ' ', facts: VISIBLE });
}
const VISIBLE = { displayNone: false, visibility: 'visible', opacity: 1, fontSizePx: 16, clipped: false, offScreen: false, contrast: null, ariaHidden: false };

function text(n, ctx) {
  const el = n.parentElement || body;
  let t = String(n.data || '').replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, ' ');
  t = ctx.pre ? t : t.replace(/\\s+/g, ' ');
  if (!t.trim()) {
    if (t && (ctx.cell || cur)) { const sp = { text: ctx.pre ? t : ' ', facts: VISIBLE }; if (ctx.href) sp.href = ctx.href; addRun(sp, ctx); }
    return;
  }
  const facts = factsOf(el, n);
  if (hiddenStyleReasons(facts).length) { out.hiddenDropped++; return; }
  const run = { text: t.slice(0, LIM.maxRunChars), facts };
  if (ctx.href) run.href = ctx.href;
  addRun(run, ctx);
}

function formBlock(f) {
  const fields = [];
  const buttons = [];
  for (const x of Array.from(f.elements)) {
    if (fields.length >= LIM.maxFields) break;
    const tag = x.tagName;
    const type = String(tag === 'INPUT' ? (x.type || 'text') : tag === 'BUTTON' ? (x.type || 'submit') : tag.toLowerCase()).toLowerCase();
    if (type === 'hidden' || chain(x).none) continue;
    // labels only, never values (a field's value is the user's data)
    const lbl = x.labels && x.labels[0] ? x.labels[0].innerText : '';
    if (tag === 'BUTTON' || ['submit', 'button', 'reset', 'image'].includes(type)) {
      const b = clipText(tag === 'BUTTON' ? x.innerText : (type === 'image' ? '' : String(x.getAttribute('value') || type)), LIM.maxLabel);
      if (b) buttons.push(b);
      continue;
    }
    if (tag === 'FIELDSET' || tag === 'OUTPUT' || tag === 'OBJECT') continue;
    fields.push({ type: type.slice(0, 20), label: clipText(lbl || x.getAttribute('placeholder') || x.getAttribute('name') || '', LIM.maxLabel) });
  }
  return { kind: 'form', method: String(f.method || 'get').toLowerCase(), action: String(f.action || location.href).slice(0, LIM.maxUrl), fields, buttons: buttons.slice(0, 5), facts: factsOf(f, null) };
}

function table(t, ctx) {
  const rows = [];
  for (const tr of Array.from(t.rows || [])) {
    if (rows.length >= LIM.maxRows) { out.truncated = true; break; }
    if (chain(tr).none) { out.hiddenDropped++; continue; }
    const cells = [];
    let header = !!(tr.parentElement && tr.parentElement.tagName === 'THEAD');
    let allTh = true;
    for (const cell of Array.from(tr.cells || [])) {
      if (cells.length >= LIM.maxCells) break;
      if (cell.tagName !== 'TH') allTh = false;
      const runs = [];
      walkChildren(cell, Object.assign({}, ctx, { cell: runs }));
      cells.push(runs);
    }
    if (allTh && cells.length) header = true;
    if (cells.length) rows.push({ header, cells });
  }
  if (rows.length) push({ kind: 'table', rows });
}

function walkChildren(el, ctx) {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (++visited > LIM.maxNodes) { out.truncated = true; return; }
    if (c.nodeType === 3) text(c, ctx);
    else if (c.nodeType === 1) walk(c, ctx);
  }
}

function walk(el, ctx) {
  const tag = el.tagName;
  if (SKIP.has(tag)) return;
  const ch = chain(el);
  if (ch.none) { if ((el.textContent || '').trim()) out.hiddenDropped++; return; }
  if (tag === 'IMG') {
    const alt = clipText(el.getAttribute('alt') || '', 200);
    if (!alt) return;
    const r = el.getBoundingClientRect();
    const facts = factsOf(el, null);
    if (hiddenStyleReasons(facts).length || r.width < LIM.minImagePx || r.height < LIM.minImagePx) { out.hiddenDropped++; return; }
    const run = { text: alt, img: { w: Math.round(r.width), h: Math.round(r.height) }, facts };
    if (ctx.href) run.href = ctx.href;
    addRun(run, ctx);
    return;
  }
  if (tag === 'BR') { addRun({ text: ctx.pre ? '\\n' : ' ', facts: VISIBLE }, ctx); return; }
  if (ctx.cell) {
    if (tag === 'A' && el.href) { walkChildren(el, Object.assign({}, ctx, { href: linkOf(el) })); return; }
    const block = !INLINE.test(getComputedStyle(el).display);
    if (block) boundary(ctx);
    walkChildren(el, ctx);
    if (block) boundary(ctx);
    return;
  }
  const h = /^H([1-6])$/.exec(tag);
  if (h) { open('heading', ctx, { level: Number(h[1]) }); walkChildren(el, ctx); flush(); return; }
  if (tag === 'A') { walkChildren(el, Object.assign({}, ctx, { href: el.href ? linkOf(el) : '' })); return; }
  if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
    flush();
    walkChildren(el, Object.assign({}, ctx, { depth: (ctx.depth === undefined ? -1 : ctx.depth) + 1, ordered: tag === 'OL', counter: { n: 0 } }));
    flush();
    return;
  }
  if (tag === 'LI') {
    const counter = ctx.counter || { n: 0 };
    counter.n++;
    open('item', ctx, { depth: Math.max(0, ctx.depth || 0), ordered: !!ctx.ordered, n: counter.n });
    walkChildren(el, ctx);
    flush();
    return;
  }
  if (tag === 'PRE') { open('pre', ctx); walkChildren(el, Object.assign({}, ctx, { pre: true })); flush(); return; }
  if (tag === 'BLOCKQUOTE') { flush(); walkChildren(el, Object.assign({}, ctx, { quote: true })); flush(); return; }
  if (tag === 'TABLE') { flush(); table(el, ctx); return; }
  if (tag === 'HR') { flush(); push({ kind: 'rule' }); return; }
  if (tag === 'FORM') {
    flush();
    if (out.blocks.length < LIM.maxBlocks) push(formBlock(el));
    walkChildren(el, ctx);
    flush();
    return;
  }
  if (tag === 'BUTTON') { boundary(ctx); walkChildren(el, ctx); boundary(ctx); return; }
  const block = !INLINE.test(getComputedStyle(el).display);
  if (block) {
    if (cur && cur.kind !== 'paragraph' && cur.kind !== 'pre') boundary(ctx); else flush();
  }
  walkChildren(el, ctx);
  if (block && cur && cur.kind === 'paragraph') flush();
}

walkChildren(body, {});
flush();
return out;
})()`;

// ------------------------------------------------------------------ re-validation (main)

const HIDDEN_FACTS: MdFacts = { displayNone: true, visibility: 'hidden', opacity: 0, fontSizePx: 0, clipped: true, offScreen: false, contrast: null, ariaHidden: true };

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const str = (v: unknown, max: number) => String(v ?? '').replace(CTRL, ' ').slice(0, max);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Facts that do not parse are treated as HIDDEN: unknown shape never counts as visible. */
function normFacts(raw: unknown): MdFacts {
  if (!raw || typeof raw !== 'object') return { ...HIDDEN_FACTS };
  const f = raw as Record<string, unknown>;
  return {
    displayNone: f.displayNone === true,
    visibility: str(f.visibility, 20),
    opacity: num(f.opacity, 0),
    fontSizePx: num(f.fontSizePx, 0),
    clipped: f.clipped === true,
    offScreen: f.offScreen === true,
    contrast: f.contrast === null ? null : num(f.contrast, 1),
    ariaHidden: f.ariaHidden === true,
  };
}

function safeHref(v: unknown): string | undefined {
  const s = str(v, MD_LIMITS.maxUrl).trim();
  return /^(https?:|mailto:)/i.test(s) ? s : undefined;
}

function normRuns(raw: unknown): MdRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MD_LIMITS.maxRuns).flatMap((r): MdRun[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const run: MdRun = { text: str(o.text, MD_LIMITS.maxRunChars), facts: normFacts(o.facts) };
    const href = safeHref(o.href);
    if (href) run.href = href;
    if (o.img && typeof o.img === 'object') {
      const i = o.img as Record<string, unknown>;
      run.img = { w: num(i.w), h: num(i.h) };
    }
    return [run];
  });
}

/** Re-validate and re-cap the isolated world's result: every string in it is page-derived. */
export function normalizeMdPage(raw: unknown): MdPage {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const blocks: MdBlock[] = [];
  for (const b of Array.isArray(r.blocks) ? r.blocks.slice(0, MD_LIMITS.maxBlocks) : []) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const quote = o.quote === true ? { quote: true } : {};
    switch (o.kind) {
      case 'heading':
        blocks.push({ kind: 'heading', level: Math.min(6, Math.max(1, Math.round(num(o.level, 2)))), runs: normRuns(o.runs), ...quote });
        break;
      case 'paragraph':
      case 'pre':
        blocks.push({ kind: o.kind, runs: normRuns(o.runs), ...quote });
        break;
      case 'item':
        blocks.push({ kind: 'item', depth: Math.min(6, Math.max(0, Math.round(num(o.depth)))), ordered: o.ordered === true, n: Math.min(9999, Math.max(1, Math.round(num(o.n, 1)))), runs: normRuns(o.runs), ...quote });
        break;
      case 'table': {
        const rows = (Array.isArray(o.rows) ? o.rows.slice(0, MD_LIMITS.maxRows) : []).flatMap((row) => {
          if (!row || typeof row !== 'object') return [];
          const rr = row as Record<string, unknown>;
          const cells = Array.isArray(rr.cells) ? rr.cells.slice(0, MD_LIMITS.maxCells).map(normRuns) : [];
          return cells.length ? [{ header: rr.header === true, cells }] : [];
        });
        if (rows.length) blocks.push({ kind: 'table', rows });
        break;
      }
      case 'form':
        blocks.push({
          kind: 'form',
          method: str(o.method, 10).toLowerCase() === 'post' ? 'post' : 'get',
          action: str(o.action, MD_LIMITS.maxUrl),
          fields: (Array.isArray(o.fields) ? o.fields.slice(0, MD_LIMITS.maxFields) : []).map((f) => ({
            type: str((f as Record<string, unknown>)?.type, 20).replace(/[^a-z-]/gi, '') || 'text',
            label: str((f as Record<string, unknown>)?.label, MD_LIMITS.maxLabel),
          })),
          buttons: (Array.isArray(o.buttons) ? o.buttons.slice(0, 5) : []).map((x) => str(x, MD_LIMITS.maxLabel)),
          facts: normFacts(o.facts),
        });
        break;
      case 'rule':
        blocks.push({ kind: 'rule' });
        break;
    }
  }
  return {
    url: str(r.url, 2048),
    title: str(r.title, 300).replace(/\s+/g, ' ').trim(),
    blocks,
    truncated: r.truncated === true,
    hiddenDropped: Math.max(0, Math.round(num(r.hiddenDropped))),
  };
}

// ------------------------------------------------------------------ rendering (pure)

/** Is this run hidden by the X-ray rules (or an image too small to be content)? */
export function runHidden(r: MdRun): boolean {
  if (hiddenStyleReasons(r.facts).length) return true;
  return !!r.img && (r.img.w < MD_LIMITS.minImagePx || r.img.h < MD_LIMITS.minImagePx);
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const linkText = (s: string) => s.replace(/[[\]]/g, (c) => `\\${c}`);
const linkUrl = (s: string) => s.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** Render inline runs: links as [text](url), images as [image: alt]. Hidden runs are counted and dropped. */
function inline(runs: MdRun[], dropped: { n: number }, pre = false): string {
  let out = '';
  let i = 0;
  const visible = runs.filter((r) => {
    if (!runHidden(r)) return true;
    if (r.text.trim()) dropped.n++;
    return false;
  });
  const piece = (r: MdRun, inLink: boolean) => (r.img ? (inLink ? `image: ${r.text}` : `[image: ${r.text}]`) : r.text);
  while (i < visible.length) {
    const href = visible[i].href;
    if (!href) {
      out += piece(visible[i], false);
      i++;
      continue;
    }
    let t = '';
    while (i < visible.length && visible[i].href === href) t += piece(visible[i++], true);
    const label = squash(t);
    // keep the spaces around a link ("visit [our shop](url) today")
    out += label ? `${/^\s/.test(t) ? ' ' : ''}[${linkText(label)}](${linkUrl(href)})${/\s$/.test(t) ? ' ' : ''}` : t;
  }
  return pre ? out.replace(/^\n+|\s+$/g, '') : squash(out);
}

function fieldLine(b: Extract<MdBlock, { kind: 'form' }>): string {
  const fields = b.fields.map((f) => (f.label ? `${squash(f.label)} (${f.type})` : f.type)).join(', ');
  const buttons = b.buttons.map(squash).filter(Boolean);
  return `[form: ${b.method.toUpperCase()} ${b.action}${fields ? ` — fields: ${fields}` : ''}${buttons.length ? `; buttons: ${buttons.join(', ')}` : ''}]`;
}

/** One block as markdown ('' when nothing visible is left). */
function renderBlock(b: MdBlock, dropped: { n: number }): string {
  const q = (s: string) => ('quote' in b && b.quote ? s.split('\n').map((l) => `> ${l}`).join('\n') : s);
  switch (b.kind) {
    case 'heading': {
      const t = inline(b.runs, dropped);
      return t ? q(`${'#'.repeat(b.level)} ${t}`) : '';
    }
    case 'paragraph': {
      const t = inline(b.runs, dropped);
      return t ? q(t) : '';
    }
    case 'item': {
      const t = inline(b.runs, dropped);
      return t ? q(`${'  '.repeat(b.depth)}${b.ordered ? `${b.n}.` : '-'} ${t}`) : '';
    }
    case 'pre': {
      const t = inline(b.runs, dropped, true).replace(/```/g, "'''");
      return t.trim() ? q(`\`\`\`\n${t}\n\`\`\``) : '';
    }
    case 'table': {
      const rows = b.rows.map((r) => ({ header: r.header, cells: r.cells.map((c) => inline(c, dropped).replace(/\|/g, '\\|')) })).filter((r) => r.cells.some(Boolean));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.cells.length));
      const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
      const out = [line(rows[0].cells), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map((r) => line(r.cells))];
      return out.join('\n');
    }
    case 'form':
      if (hiddenStyleReasons(b.facts).length) {
        dropped.n++;
        return '';
      }
      return fieldLine(b);
    case 'rule':
      return '---';
  }
}

export interface PageMarkdown {
  markdown: string;
  /** the extractor or the size cap cut the page short */
  truncated: boolean;
  /** hidden text pieces left out (by the extractor, and by this transform) */
  hiddenDropped: number;
}

export const TRUNCATED_NOTE = '[… page truncated]';

/** Render a page as capped markdown. Hidden runs (X-ray rules) are dropped, never rendered. */
export function pageMarkdown(page: MdPage, maxChars: number = MD_LIMITS.maxChars): PageMarkdown {
  const dropped = { n: 0 };
  let md = '';
  let truncated = page.truncated;
  let prevItem = false;
  for (const b of page.blocks) {
    const s = renderBlock(b, dropped);
    if (!s) continue;
    const isItem = b.kind === 'item';
    const sep = md ? (isItem && prevItem ? '\n' : '\n\n') : '';
    if (md.length + sep.length + s.length > maxChars) {
      truncated = true;
      // a first block that alone exceeds the cap is cut rather than dropped
      if (!md) md = s.slice(0, Math.max(0, maxChars - TRUNCATED_NOTE.length - 2));
      break;
    }
    md += sep + s;
    prevItem = isItem;
  }
  if (truncated) md = `${md}${md ? '\n\n' : ''}${TRUNCATED_NOTE}`;
  return { markdown: md, truncated, hiddenDropped: page.hiddenDropped + dropped.n };
}

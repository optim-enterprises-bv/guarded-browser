// Injection X-ray (AI capabilities program, item 1): what the page hides from you and what the guard
// thinks of its text, drawn over the page and listed in the chrome.
//
// Shape of the feature, and the rules it keeps:
//   * The SCAN runs in the isolated world (ISOLATED_WORLD), never the page's main world. It returns
//     plain data: capped text fragments with a fixed-vocabulary reason, form summaries, and indexes of
//     anchor elements that stay in the isolated world (`window.__gbx`, invisible to the page).
//   * MAIN re-validates and re-caps that data (normalizeScan), scores it with the guard when the guard
//     is loaded (scoreFragments; "guard not loaded" otherwise, never invented scores), and adds the
//     tab's third-party hosts from the webRequest log (TabHostLog) with their reputation verdicts.
//   * The OVERLAY is drawn by the isolated world inside a CLOSED shadow root. Its labels are built in
//     main from the fixed vocabulary below plus numbers: no page text is ever drawn into the overlay.
//   * Read-only: no request is made, nothing is sent anywhere, nothing reaches the planner / reader /
//     judge, and the page's DOM gets no attribute or content of ours (one empty host element).
//
// The helpers marked "INJECTED" are serialised with Function.prototype.toString into the isolated-
// world script, so the unit tests exercise the exact code that runs in the page. They must stay
// self-contained: no imports, no module constants, no other helpers except other INJECTED ones.

import { getDomain } from 'tldts';
import { chunkText } from './guard';
import type { Guard } from './types';

import { HIDDEN_REASONS, REASON_LABELS, type HiddenReason } from './xray-labels';

export { HIDDEN_REASONS, REASON_LABELS, type HiddenReason };

export const XRAY_LIMITS = {
  /** hidden fragments returned by one scan */
  maxHidden: 120,
  /** visible text blocks returned for guard scoring (never listed unless flagged) */
  maxVisible: 120,
  /** characters per fragment / block */
  maxChars: 400,
  /** shorter text is ignored (icons, separators) */
  minChars: 3,
  /** text nodes / attribute elements visited before the scan stops */
  maxNodes: 20_000,
  maxForms: 40,
  /** third-party hosts kept per tab in the request log */
  maxHosts: 300,
} as const;

/** Text whose contrast ratio against its background is below this is "text colour ≈ background". */
export const MIN_CONTRAST = 1.5;
/** Font sizes below this (CSS px) are "tiny". */
export const MIN_FONT_PX = 4;
/** Effective opacity at or below this is "invisible". */
export const MAX_INVISIBLE_OPACITY = 0.05;

export type Rgba = [number, number, number, number];

// ------------------------------------------------------------------ INJECTED helpers

/** INJECTED. Parse a computed CSS colour (rgb()/rgba(), #hex, `transparent`). Unknown syntax → null. */
export function parseCssColor(input: string): Rgba | null {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const ch = (v: string) => Math.max(0, Math.min(255, parseFloat(v)));
    return [ch(m[1]), ch(m[2]), ch(m[3]), Math.max(0, Math.min(1, a))];
  }
  const h = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (h) {
    let x = h[1];
    if (x.length <= 4) x = x.split('').map((c) => c + c).join('');
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), x.length === 8 ? n(6) / 255 : 1];
  }
  return null;
}

/** INJECTED. Source-over compositing of `top` onto an opaque-ish `bottom`. */
export function blendOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

/** INJECTED. WCAG 2 relative luminance of an sRGB colour. */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** INJECTED. WCAG contrast ratio (1..21) of text colour `fg` over background `bg` (fg's alpha applied). */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const base: Rgba = bg[3] < 1 ? blendOver(bg, [255, 255, 255, 1]) : bg;
  const top = fg[3] < 1 ? blendOver(fg, base) : fg;
  const l1 = relativeLuminance(top);
  const l2 = relativeLuminance(base);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** INJECTED. Is an element clipped to (nearly) nothing — the classic "visually hidden" patterns? */
export function isClipped(f: { clip: string; clipPath: string; overflow: string; width: number; height: number }): boolean {
  const clip = String(f.clip || '').toLowerCase();
  if (clip.startsWith('rect(')) {
    const n = clip.slice(5, -1).split(/[\s,]+/).filter(Boolean).map((v) => (v === 'auto' ? NaN : parseFloat(v)));
    if (n.length === 4 && n.every((v) => !Number.isNaN(v)) && (n[1] - n[3] <= 1 || n[2] - n[0] <= 1)) return true;
  }
  const cp = String(f.clipPath || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^inset\((50%|100%)/.test(cp) || /^circle\(0(px|%)?[ )]/.test(cp) || /^polygon\(\s*0(px)? 0(px)?\s*\)$/.test(cp)) return true;
  const ov = String(f.overflow || '').toLowerCase();
  if (/hidden|clip/.test(ov) && (f.width <= 1 || f.height <= 1)) return true;
  return false;
}

/** INJECTED. Is a box (viewport coordinates) entirely outside the scrollable document? */
export function isOffScreen(r: { left: number; top: number; right: number; bottom: number; width: number; height: number }, scroll: { x: number; y: number }, doc: { width: number; height: number }): boolean {
  if (r.width <= 0 && r.height <= 0) return false; // not rendered at all: another reason applies
  return r.right + scroll.x <= 0 || r.bottom + scroll.y <= 0 || r.left + scroll.x >= doc.width || r.top + scroll.y >= doc.height;
}

/**
 * INJECTED. The hidden-text reasons for one piece of text, from facts the isolated world measured.
 * Order is significance: the first reason is the one the panel and the overlay lead with.
 */
export function hiddenStyleReasons(f: {
  displayNone: boolean;
  visibility: string;
  opacity: number;
  fontSizePx: number;
  clipped: boolean;
  offScreen: boolean;
  contrast: number | null;
  ariaHidden: boolean;
}): HiddenReason[] {
  const out: HiddenReason[] = [];
  if (f.displayNone) out.push('display-none');
  if (f.visibility === 'hidden' || f.visibility === 'collapse') out.push('visibility-hidden');
  if (f.opacity <= 0.05) out.push('opacity');
  if (f.fontSizePx < 4) out.push('tiny-font');
  if (f.clipped) out.push('clipped');
  if (f.offScreen) out.push('off-screen');
  if (f.contrast !== null && f.contrast < 1.5) out.push('low-contrast');
  if (f.ariaHidden) out.push('aria-hidden');
  return out;
}

/** INJECTED. Collapse whitespace, drop control characters, cap. */
export function clipText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** INJECTED. Does a form field look like a payment-card field (name / id / autocomplete / placeholder)? */
export function looksLikeCardField(f: { autocomplete: string; name: string; id: string; placeholder: string; label: string }): boolean {
  if (/^cc-|\scc-/.test(String(f.autocomplete || '').toLowerCase())) return true;
  const s = `${f.name} ${f.id} ${f.placeholder} ${f.label}`.toLowerCase();
  return /card.?(num|no\b|number)|credit.?card|\bcc.?(num|number)\b|\bcvv\b|\bcvc\b|\bcsc\b|security code|expir/.test(s);
}

// name -> function. The name is spelled out because a bundler may rename a function to avoid a
// collision; the alias line below keeps the script's calls (and the helpers' calls to each other,
// which the bundler renames consistently) pointing at the right code either way.
const INJECTED: Array<[string, (...a: never[]) => unknown]> = [
  ['parseCssColor', parseCssColor], ['blendOver', blendOver], ['relativeLuminance', relativeLuminance], ['contrastRatio', contrastRatio],
  ['isClipped', isClipped], ['isOffScreen', isOffScreen], ['hiddenStyleReasons', hiddenStyleReasons], ['clipText', clipText], ['looksLikeCardField', looksLikeCardField],
];

/** The INJECTED helpers as script source (also used by the unit tests to prove they survive serialisation). */
export function injectedHelpersSource(): string {
  return INJECTED.map(([name, f]) => `${f.toString()}${f.name !== name ? `\nvar ${name} = ${f.name};` : ''}`).join('\n');
}

// ------------------------------------------------------------------ isolated-world scripts

/**
 * The scan. Evaluated in the isolated world; returns plain data only. Element references (the
 * anchors the overlay draws around) stay in `window.__gbx`, which the page's world cannot see.
 */
export const XRAY_SCAN_JS = `(() => {
${injectedHelpersSource()}
const LIM = ${JSON.stringify(XRAY_LIMITS)};
const gbx = window.__gbx || (window.__gbx = { anchors: [], host: null, root: null, onResize: null, marks: [] });
gbx.anchors = [];
const anchorIdx = new Map();
const body = document.body || document.documentElement;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'OPTION', 'HEAD', 'TITLE']);
const INLINE = /^(inline|inline-block|inline-flex|inline-grid|contents|ruby|ruby-text)$/;
let truncated = false;
let visited = 0;
const chainCache = new Map();
const scroll = { x: window.scrollX, y: window.scrollY };
const de = document.documentElement;
const docBox = { width: Math.max(de.scrollWidth, window.innerWidth), height: Math.max(de.scrollHeight, window.innerHeight) };

// inherited facts per element, memoised: which ancestor (if any) hides it, and its effective opacity
function chain(el) {
  if (!el || el.nodeType !== 1) return { none: null, op: 1, opCause: null, aria: null, clip: null };
  const hit = chainCache.get(el);
  if (hit) return hit;
  const p = chain(el.parentElement);
  const cs = getComputedStyle(el);
  const o = parseFloat(cs.opacity);
  const op = p.op * (Number.isNaN(o) ? 1 : o);
  let clipped = false;
  if (!p.clip) {
    const r = el.getBoundingClientRect();
    clipped = isClipped({ clip: cs.clip, clipPath: cs.clipPath, overflow: cs.overflow, width: r.width, height: r.height });
  }
  const c = {
    none: p.none || (cs.display === 'none' ? el : null),
    op,
    opCause: p.opCause || (op <= 0.05 ? el : null),
    aria: p.aria || (el.getAttribute('aria-hidden') === 'true' ? el : null),
    clip: p.clip || (clipped ? el : null),
  };
  chainCache.set(el, c);
  return c;
}

// the background the text is drawn on: composited ancestor background colours; null when an image
// (or anything we cannot see through) is in the way
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
  let out = [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) out = layers[i][3] >= 1 ? layers[i] : blendOver(layers[i], out);
  bgCache.set(el, out);
  return out;
}

function anchorOf(el) {
  let a = el && el.nodeType === 1 ? el : body;
  while (a && a !== de) {
    const c = chain(a);
    const r = a.getBoundingClientRect();
    if (!c.none && c.op > 0.05 && r.width > 0 && r.height > 0 && !c.clip) break;
    a = a.parentElement;
  }
  if (!a) a = body;
  let i = anchorIdx.get(a);
  if (i === undefined) { i = gbx.anchors.length; gbx.anchors.push(a); anchorIdx.set(a, i); }
  return i;
}

const hidden = [];
const hiddenKey = new Map();
function addHidden(cause, reasons, text) {
  const key = cause;
  const primary = reasons[0];
  let byReason = hiddenKey.get(key);
  if (!byReason) { byReason = new Map(); hiddenKey.set(key, byReason); }
  const at = byReason.get(primary);
  if (at !== undefined) {
    const f = hidden[at];
    if (f.text.length < LIM.maxChars) f.text = clipText(f.text + ' ' + text, LIM.maxChars);
    for (const r of reasons) if (!f.reasons.includes(r)) f.reasons.push(r);
    return;
  }
  if (hidden.length >= LIM.maxHidden) { truncated = true; return; }
  byReason.set(primary, hidden.length);
  hidden.push({ reasons: reasons.slice(), text: clipText(text, LIM.maxChars), tag: String(cause && cause.tagName ? cause.tagName : '#document').toLowerCase().slice(0, 20), anchor: anchorOf(cause && cause.nodeType === 1 ? cause : (cause && cause.parentElement) || body) });
}

const visible = [];
const visibleKey = new Map();
function addVisible(el, text) {
  let block = el;
  while (block && block !== body && INLINE.test(getComputedStyle(block).display)) block = block.parentElement;
  block = block || body;
  const at = visibleKey.get(block);
  if (at !== undefined) {
    const v = visible[at];
    if (v.text.length < LIM.maxChars) v.text = clipText(v.text + ' ' + text, LIM.maxChars);
    return;
  }
  if (visible.length >= LIM.maxVisible) { truncated = true; return; }
  visibleKey.set(block, visible.length);
  visible.push({ text: clipText(text, LIM.maxChars), tag: String(block.tagName || '').toLowerCase().slice(0, 20), anchor: anchorOf(block) });
}

// 1. text nodes: hidden by style, or visible (kept for guard scoring)
const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
  acceptNode(n) {
    for (let p = n.parentElement; p && p !== body; p = p.parentElement) if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  },
});
const range = document.createRange();
for (let n = tw.nextNode(); n; n = tw.nextNode()) {
  if (++visited > LIM.maxNodes) { truncated = true; break; }
  const text = clipText(n.data, LIM.maxChars);
  if (!text) continue;
  const el = n.parentElement || body;
  const c = chain(el);
  const cs = getComputedStyle(el);
  let offScreen = false;
  let contrast = null;
  if (!c.none) {
    range.selectNodeContents(n);
    const rr = range.getBoundingClientRect();
    offScreen = isOffScreen(rr, scroll, docBox);
    const fg = parseCssColor(cs.color);
    const bg = backgroundOf(el);
    if (fg && bg) contrast = contrastRatio(fg, bg);
  }
  const reasons = hiddenStyleReasons({ displayNone: !!c.none, visibility: cs.visibility, opacity: c.op, fontSizePx: parseFloat(cs.fontSize) || 0, clipped: !!c.clip, offScreen, contrast, ariaHidden: !!c.aria });
  // visible text joins its block whatever its length ("Jo" + ": Ignore all ..."); short blocks are
  // dropped in main. A short HIDDEN text (an icon, a separator) is not worth a fragment.
  if (!reasons.length) { addVisible(el, text); continue; }
  if (text.length < LIM.minChars) continue;
  const p = reasons[0];
  const cause = p === 'display-none' ? c.none : p === 'opacity' ? c.opCause : p === 'clipped' ? c.clip : p === 'aria-hidden' ? c.aria : el;
  addHidden(cause || el, reasons, text);
}

// 2. text that lives in attributes: alt, title, aria-label (skipped when it only repeats visible text)
const attrs = [['alt', 'alt-text'], ['title', 'title-attr'], ['aria-label', 'aria-label']];
let attrSeen = 0;
for (const el of document.querySelectorAll('[alt],[title],[aria-label]')) {
  if (++attrSeen > LIM.maxNodes) { truncated = true; break; }
  if (SKIP.has(el.tagName) || el === de) continue;
  const own = clipText(el.textContent || '', LIM.maxChars).toLowerCase();
  for (const [name, reason] of attrs) {
    const v = clipText(el.getAttribute(name) || '', LIM.maxChars);
    if (v.length < LIM.minChars || v.toLowerCase() === own) continue;
    addHidden(el, [reason], v);
  }
}

// 3. HTML comments anywhere in the document
const cw = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
for (let n = cw.nextNode(); n; n = cw.nextNode()) {
  if (++visited > LIM.maxNodes) { truncated = true; break; }
  const text = clipText(n.data, LIM.maxChars);
  if (text.length < LIM.minChars) continue;
  addHidden(n.parentElement || body, ['comment'], text);
}

// 4. <noscript> (raw markup while scripting is on: parsed INERT to get its text) and <template>
for (const ns of document.querySelectorAll('noscript')) {
  let text = '';
  try { text = new DOMParser().parseFromString(String(ns.textContent || ''), 'text/html').body.textContent || ''; } catch (e) { text = ''; }
  text = clipText(text, LIM.maxChars);
  if (text.length >= LIM.minChars) addHidden(ns, ['noscript'], text);
}
for (const t of document.querySelectorAll('template')) {
  const text = clipText((t.content && t.content.textContent) || '', LIM.maxChars);
  if (text.length >= LIM.minChars) addHidden(t, ['template'], text);
}

// 5. forms: where they send, and whether they hold a password or a payment-card field
const forms = [];
for (const f of Array.from(document.forms).slice(0, LIM.maxForms)) {
  let password = false, card = false;
  for (const x of Array.from(f.elements)) {
    const type = String(x.type || '').toLowerCase();
    if (type === 'password') password = true;
    const lbl = x.labels && x.labels[0] ? x.labels[0].textContent : '';
    if (looksLikeCardField({ autocomplete: String(x.autocomplete || x.getAttribute('autocomplete') || ''), name: String(x.name || ''), id: String(x.id || ''), placeholder: String(x.getAttribute('placeholder') || ''), label: String(x.getAttribute('aria-label') || lbl || '') })) card = true;
  }
  const extra = [];
  for (const b of f.querySelectorAll('[formaction]')) if (b.formAction && !extra.includes(b.formAction)) extra.push(String(b.formAction).slice(0, 500));
  forms.push({ action: String(f.action || location.href).slice(0, 500), method: String(f.method || 'get').toLowerCase(), password, card, fields: f.elements.length, formActions: extra.slice(0, 5), anchor: anchorOf(f) });
}
if (Array.from(document.forms).length > LIM.maxForms) truncated = true;

return { url: location.href, hidden, visible, forms, truncated };
})()`;

/** One overlay mark: a box around an anchor element with a label made of fixed words and numbers. */
export interface XrayMark {
  anchor: number;
  label: string;
  injection: boolean;
}

const OVERLAY_CSS = `
:host { all: initial !important; display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important; contain: none !important; opacity: 1 !important; visibility: visible !important; transform: none !important; filter: none !important; }
.box { position: absolute; box-sizing: border-box; border: 2px dashed #d97706; border-radius: 3px; background: rgba(217,119,6,.06); pointer-events: none; }
.box.inj { border: 2px solid #dc2626; background: rgba(220,38,38,.10); }
.badge { position: absolute; pointer-events: auto; font: 600 11px/1.35 system-ui, sans-serif; color: #fff; background: #b45309; padding: 1px 7px; border-radius: 9px; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35); cursor: default; letter-spacing: 0; text-transform: none; }
.badge.inj { background: #b91c1c; }
.flash { position: absolute; box-sizing: border-box; border: 3px solid #2563eb; border-radius: 4px; box-shadow: 0 0 0 4px rgba(37,99,235,.35); pointer-events: none; }
`;

/**
 * Draw (or redraw) the overlay. `marks` come from main and hold only fixed words and numbers. The
 * host is ONE empty element on <html>; everything visible lives in its CLOSED shadow root, styled by
 * a constructed stylesheet (CSSOM, so a page CSP cannot block it and no <style> node is created).
 */
export function xrayOverlayJs(marks: XrayMark[]): string {
  return `(() => {
const marks = ${JSON.stringify(marks.slice(0, 400))};
const gbx = window.__gbx;
if (!gbx) return { ok: false, boxes: 0 };
gbx.marks = marks;
if (!gbx.host || !gbx.host.isConnected) {
  if (gbx.host) gbx.host.remove();
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(OVERLAY_CSS)});
  root.adoptedStyleSheets = [sheet];
  document.documentElement.appendChild(host);
  gbx.host = host;
  gbx.root = root;
}
gbx.draw = () => {
  const root = gbx.root;
  if (!root) return 0;
  root.replaceChildren();
  const origin = gbx.host.getBoundingClientRect();
  const de = document.documentElement;
  let boxes = 0;
  const byAnchor = new Map();
  for (const m of gbx.marks) {
    const el = gbx.anchors[m.anchor];
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    const whole = el === document.body || el === de;
    const d = de.getBoundingClientRect();
    const left = whole ? d.left + 8 - origin.left : r.left - origin.left;
    const top = whole ? d.top + 26 - origin.top : r.top - origin.top;
    if (!whole) {
      const box = document.createElement('div');
      box.className = 'box' + (m.injection ? ' inj' : '');
      box.style.left = left + 'px'; box.style.top = top + 'px'; box.style.width = Math.max(4, r.width) + 'px'; box.style.height = Math.max(4, r.height) + 'px';
      root.appendChild(box);
    }
    const stack = byAnchor.get(el) || 0;
    byAnchor.set(el, stack + 1);
    const badge = document.createElement('span');
    badge.className = 'badge' + (m.injection ? ' inj' : '');
    badge.textContent = m.label;
    badge.title = m.label;
    badge.style.left = left + 'px';
    // above the box; inside it when that would leave the top of the document
    const above = top - 18 - stack * 19;
    badge.style.top = (above < d.top - origin.top ? top + 2 + stack * 19 : above) + 'px';
    root.appendChild(badge);
    boxes++;
  }
  return boxes;
};
if (!gbx.onResize) { gbx.onResize = () => { if (gbx.draw) gbx.draw(); }; window.addEventListener('resize', gbx.onResize); }
return { ok: true, boxes: gbx.draw() };
})()`;
}

/** Remove the overlay and forget the anchors. Leaves nothing behind in the page. */
export const XRAY_CLEAR_JS = `(() => {
const gbx = window.__gbx;
if (!gbx) return { ok: true };
if (gbx.host) gbx.host.remove();
if (gbx.onResize) window.removeEventListener('resize', gbx.onResize);
window.__gbx = undefined;
return { ok: true };
})()`;

/** Scroll an anchor into view and flash an outline around it (drawn in the shadow root, never on the page's node). */
export function xrayRevealJs(anchor: number): string {
  return `(() => {
const gbx = window.__gbx;
const el = gbx && gbx.anchors[${Math.max(0, Math.floor(Number(anchor) || 0))}];
if (!el || !el.isConnected) return { ok: false };
el.scrollIntoView({ block: 'center', inline: 'nearest' });
if (gbx.draw) gbx.draw();
if (gbx.root && gbx.host) {
  const origin = gbx.host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'flash';
  f.style.left = (r.left - origin.left - 4) + 'px'; f.style.top = (r.top - origin.top - 4) + 'px';
  f.style.width = (Math.max(4, r.width) + 8) + 'px'; f.style.height = (Math.max(4, r.height) + 8) + 'px';
  gbx.root.appendChild(f);
  setTimeout(() => f.remove(), 2500);
}
return { ok: true };
})()`;
}

// ------------------------------------------------------------------ main-side validation

export interface ScanFragment {
  kind: 'hidden' | 'visible';
  reasons: HiddenReason[];
  text: string;
  tag: string;
  anchor: number;
}

export interface ScanForm {
  action: string;
  method: string;
  password: boolean;
  card: boolean;
  fields: number;
  formActions: string[];
  anchor: number;
}

export interface XrayScan {
  url: string;
  hidden: ScanFragment[];
  visible: ScanFragment[];
  forms: ScanForm[];
  truncated: boolean;
}

const REASON_SET = new Set<string>(HIDDEN_REASONS);

/**
 * Re-validate and re-cap the isolated world's result. The script is ours, but every string in it is
 * page-derived, so main trusts nothing about its size or shape.
 */
export function normalizeScan(raw: unknown): XrayScan {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const frag = (kind: 'hidden' | 'visible') => (x: unknown): ScanFragment | null => {
    const f = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const text = clipText(String(f.text ?? ''), XRAY_LIMITS.maxChars);
    if (text.length < XRAY_LIMITS.minChars) return null;
    const reasons = kind === 'hidden' ? arr(f.reasons).map(String).filter((r): r is HiddenReason => REASON_SET.has(r)).slice(0, HIDDEN_REASONS.length) : [];
    if (kind === 'hidden' && !reasons.length) return null;
    return { kind, reasons: [...new Set(reasons)], text, tag: String(f.tag ?? '').replace(/[^a-z0-9#-]/gi, '').slice(0, 20).toLowerCase(), anchor: num(f.anchor) };
  };
  const hidden = arr(o.hidden).slice(0, XRAY_LIMITS.maxHidden).map(frag('hidden')).filter((f): f is ScanFragment => !!f);
  const visible = arr(o.visible).slice(0, XRAY_LIMITS.maxVisible).map(frag('visible')).filter((f): f is ScanFragment => !!f);
  const forms = arr(o.forms).slice(0, XRAY_LIMITS.maxForms).map((x): ScanForm => {
    const f = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return {
      action: String(f.action ?? '').slice(0, 500),
      method: String(f.method ?? '').toLowerCase() === 'post' ? 'post' : String(f.method ?? '').toLowerCase() === 'dialog' ? 'dialog' : 'get',
      password: f.password === true,
      card: f.card === true,
      fields: Math.min(10_000, num(f.fields)),
      formActions: arr(f.formActions).slice(0, 5).map((s) => String(s).slice(0, 500)),
      anchor: num(f.anchor),
    };
  });
  return {
    url: String(o.url ?? '').slice(0, 2000),
    hidden,
    visible,
    forms,
    truncated: o.truncated === true || arr(o.hidden).length > XRAY_LIMITS.maxHidden || arr(o.visible).length > XRAY_LIMITS.maxVisible || arr(o.forms).length > XRAY_LIMITS.maxForms,
  };
}

// ------------------------------------------------------------------ guard scoring

export type XrayGuardState = { state: 'scored'; detail: string } | { state: 'not-loaded'; detail: string };

/**
 * Score fragments with the guard, batched (all chunks of all fragments in one classify call, which
 * batches internally). A fragment's score is its worst chunk. When the guard is not READY nothing is
 * scored and the result says "guard not loaded" — never a pretend score.
 */
export async function scoreFragments(guard: Guard, texts: string[]): Promise<{ guard: XrayGuardState; scores: Array<{ score: number; flagged: boolean } | null> }> {
  if (guard.status() !== 'ready') return { guard: { state: 'not-loaded', detail: guard.statusDetail() }, scores: texts.map(() => null) };
  const chunks = texts.map((t) => chunkText(t));
  const flat = chunks.flat();
  const verdicts = flat.length ? await guard.classify(flat) : [];
  let i = 0;
  const scores = chunks.map((cs) => {
    let score = 0;
    let flagged = false;
    for (let k = 0; k < cs.length; k++, i++) {
      const v = verdicts[i];
      if (!v) continue;
      score = Math.max(score, v.score);
      flagged ||= v.flagged;
    }
    return { score, flagged };
  });
  return { guard: { state: 'scored', detail: guard.statusDetail() }, scores };
}

// ------------------------------------------------------------------ hosts and forms

/** The site of a host (registrable domain; IPs / localhost / single labels stay as they are). */
export function siteOf(hostOrUrl: string): string {
  let h = hostOrUrl;
  try {
    h = new URL(/^[a-z]+:\/\//i.test(hostOrUrl) ? hostOrUrl : `http://${hostOrUrl}`).hostname;
  } catch {
    /* keep as is */
  }
  h = h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

/**
 * Hosts each tab has requested, from the webRequest layer (one entry per host:port). A main-frame
 * request starts a new page, so it resets that tab's list. Bounded per tab; forgotten on close.
 */
export class TabHostLog {
  private byTab = new Map<number, Map<string, { count: number; blockedBy?: string }>>();

  record(key: number | undefined, host: string | null, opts: { mainFrame: boolean; blockedBy?: string }) {
    if (key === undefined || !host) return;
    let m = this.byTab.get(key);
    if (opts.mainFrame || !m) {
      m = new Map();
      this.byTab.set(key, m);
    }
    const e = m.get(host);
    if (e) {
      e.count++;
      if (opts.blockedBy) e.blockedBy = opts.blockedBy;
      return;
    }
    if (m.size >= XRAY_LIMITS.maxHosts) return;
    m.set(host, { count: 1, ...(opts.blockedBy ? { blockedBy: opts.blockedBy } : {}) });
  }

  hosts(key: number): Array<{ host: string; count: number; blockedBy?: string }> {
    return [...(this.byTab.get(key)?.entries() ?? [])].map(([host, v]) => ({ host, ...v }));
  }

  forget(key: number) {
    this.byTab.delete(key);
  }
}

export interface XrayHost {
  host: string;
  count: number;
  /** the feed listing it (reputation verdict), or null */
  listedBy: string | null;
  /** the request was dropped by the reputation layer */
  blocked: boolean;
  /** a form on the page would send data to this host */
  formTarget: boolean;
}

/** Third-party hosts: a different SITE from the page's. Listed hosts first. */
export function thirdPartyHosts(
  pageUrl: string,
  entries: Array<{ host: string; count: number; blockedBy?: string }>,
  listedBy: (host: string) => string | null,
  formHosts: Set<string>,
): XrayHost[] {
  const site = siteOf(pageUrl);
  return entries
    .filter((e) => siteOf(e.host) !== site)
    .map((e) => ({ host: e.host, count: e.count, listedBy: e.blockedBy ?? listedBy(e.host), blocked: !!e.blockedBy, formTarget: formHosts.has(e.host) }))
    .sort((a, b) => Number(!!b.listedBy) - Number(!!a.listedBy) || Number(b.formTarget) - Number(a.formTarget) || b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, XRAY_LIMITS.maxHosts);
}

export interface XrayForm {
  action: string;
  method: string;
  actionOrigin: string | null;
  /** the form (or one of its formaction buttons) sends to another origin */
  offSite: boolean;
  password: boolean;
  card: boolean;
  /** a password / card field that would be sent to another origin */
  sensitiveOffSite: boolean;
  listedBy: string | null;
  fields: number;
  anchor: number;
}

function originOfUrl(u: string): string | null {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : null;
  } catch {
    return null;
  }
}

/** Forms with their action origin; cross-origin actions and sensitive fields posting elsewhere are flagged. */
export function assessForms(forms: ScanForm[], pageUrl: string, listedBy: (host: string) => string | null): XrayForm[] {
  const page = originOfUrl(pageUrl);
  return forms.map((f) => {
    const targets = [f.action, ...f.formActions];
    const origins = targets.map(originOfUrl);
    const offSite = origins.some((o) => !!o && !!page && o !== page);
    const actionOrigin = origins[0];
    const listed = targets.map((t) => (originOfUrl(t) ? listedBy(t) : null)).find((x) => !!x) ?? null;
    return {
      action: f.action,
      method: f.method,
      actionOrigin,
      offSite,
      password: f.password,
      card: f.card,
      sensitiveOffSite: offSite && (f.password || f.card),
      listedBy: listed,
      fields: f.fields,
      anchor: f.anchor,
    };
  });
}

// ------------------------------------------------------------------ report

export interface XrayFragment {
  id: number;
  kind: 'hidden' | 'visible';
  reasons: HiddenReason[];
  text: string;
  tag: string;
  anchor: number;
  /** guard score 0..1, or null when the guard did not score it (not loaded / still scoring) */
  score: number | null;
  flagged: boolean;
}

export interface XraySummary {
  hidden: number;
  flagged: number;
  hosts: number;
  hostsFlagged: number;
  forms: number;
  formsOffSite: number;
}

export function summarize(r: { fragments: XrayFragment[]; hosts: XrayHost[]; forms: XrayForm[] }): XraySummary {
  return {
    hidden: r.fragments.filter((f) => f.kind === 'hidden').length,
    flagged: r.fragments.filter((f) => f.flagged).length,
    hosts: r.hosts.length,
    hostsFlagged: r.hosts.filter((h) => !!h.listedBy).length,
    forms: r.forms.length,
    formsOffSite: r.forms.filter((f) => f.offSite).length,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summaryLine(s: XraySummary): string {
  return `${plural(s.hidden, 'hidden fragment', 'hidden fragments')}, ${s.flagged} flagged as injection, ${plural(s.hosts, 'third-party host', 'third-party hosts')} (${s.hostsFlagged} flagged by reputation), ${plural(s.forms, 'form', 'forms')} (${s.formsOffSite} sending off-site)`;
}

/**
 * Overlay marks, one per anchor, built ONLY from the fixed reason labels and numbers. Hidden
 * fragments and flagged visible text get a mark; so does a form that sends off-site.
 */
export function overlayMarks(fragments: XrayFragment[], forms: XrayForm[]): XrayMark[] {
  const by = new Map<number, { hidden: number; reasons: Set<HiddenReason>; best: number | null; injection: boolean }>();
  for (const f of fragments) {
    if (f.kind === 'visible' && !f.flagged) continue;
    const m = by.get(f.anchor) ?? { hidden: 0, reasons: new Set<HiddenReason>(), best: null, injection: false };
    if (f.kind === 'hidden') {
      m.hidden++;
      m.reasons.add(f.reasons[0]);
    }
    if (f.flagged) {
      m.injection = true;
      m.best = Math.max(m.best ?? 0, f.score ?? 0);
    }
    by.set(f.anchor, m);
  }
  const marks: XrayMark[] = [];
  for (const [anchor, m] of by) {
    const parts: string[] = [];
    if (m.injection) parts.push(`injection ${(m.best ?? 0).toFixed(2)}`);
    if (m.hidden) parts.push(`${m.hidden} hidden: ${[...m.reasons].map((r) => REASON_LABELS[r]).slice(0, 3).join(', ')}`);
    marks.push({ anchor, label: parts.join(' · '), injection: m.injection });
  }
  for (const f of forms) {
    if (!f.offSite) continue;
    marks.push({ anchor: f.anchor, label: f.sensitiveOffSite ? 'form sends password/card off-site' : 'form sends off-site', injection: f.sensitiveOffSite });
  }
  return marks;
}

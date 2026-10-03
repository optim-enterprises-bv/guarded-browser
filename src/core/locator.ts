// Stable element locators for recipes and watchers (AI capabilities item 5).
//
// A locator says WHICH element a recorded step acted on, in terms that survive a reload and do not
// depend on a page-chosen ref: role + accessible name + tag (+ input type / field name), the nearest
// landmark, the nearest label (a <label>, else the heading the element sits under), the element's id
// and classes when they look hand-written, and a structural path of tag.class segments from that
// landmark down (no nth-child: a path only breaks a tie, it never identifies on its own).
//
// Two halves, the same split as markdown.ts / xray.ts:
//   * page scripts (ELEMENT_HELPERS_JS, candidatesJs, extractJs, locateTextJs, pickerJs) run in an
//     ISOLATED world (or, for the external CDP runner, in a separately installed headless browser)
//     and return plain data;
//   * matchLocator / typedValue / landmarksMatch are pure and decide. matchLocator is also injected
//     into extractJs by its source (like the X-ray helpers), so a watcher run matches IN the page and
//     only the matched element's capped text crosses back — then typedValue reduces it to a number,
//     a hash or a capped text.
//
// Nothing in here reaches a model: replay and watchers run with no planner, reader or judge.

import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Caps for every page-derived string a locator carries. */
export const LOC_LIMITS = { name: 160, label: 160, landmark: 120, path: 400, cls: 80, id: 60, href: 300, fieldName: 80, text: 300 } as const;

export const LocatorSchema = z
  .object({
    /** 'text' for a non-interactive element (a price, a heading); else an ARIA role */
    role: z.string().regex(/^[a-z]{1,24}$/),
    /** accessible name (interactive elements only; '' for text elements, whose text is the VALUE) */
    name: z.string().max(LOC_LIMITS.name),
    tag: z.string().regex(/^[a-z][a-z0-9-]{0,20}$/),
    inputType: z.string().regex(/^[a-z-]{1,20}$/).optional(),
    fieldName: z.string().max(LOC_LIMITS.fieldName).optional(),
    label: z.string().max(LOC_LIMITS.label).optional(),
    landmark: z.string().max(LOC_LIMITS.landmark).optional(),
    path: z.string().max(LOC_LIMITS.path),
    cls: z.string().max(LOC_LIMITS.cls).optional(),
    id: z.string().max(LOC_LIMITS.id).optional(),
    /** a link's origin + path (no query) */
    href: z.string().max(LOC_LIMITS.href).optional(),
  })
  .strict();
export type ElementLocator = z.infer<typeof LocatorSchema>;

/** One element as the candidate script reports it: locator fields + the facts policy needs. */
export interface Candidate extends ElementLocator {
  ref: string;
  text?: string;
  formAction?: string;
  formMethod?: string;
  formEnctype?: string;
  formHasPassword?: boolean;
  inForm?: boolean;
  isSubmit?: boolean;
  /** full href (policy); `href` above is the locator's origin + path */
  fullHref?: string;
  formShape?: Array<{ name: string; type: string }>;
}

/** What a page looked like when a step ran: checked again before the step replays. */
export const PageExpectSchema = z.object({ title: z.string().max(160), heading: z.string().max(160) }).strict();
export type PageExpect = z.infer<typeof PageExpectSchema>;

export interface PageInfo extends PageExpect {
  url: string;
}

const LOCATOR_KEYS = Object.keys(LocatorSchema.shape) as Array<keyof ElementLocator>;

/** Keep only locator fields, capped (page data comes in through here). Throws on a malformed one. */
export function toLocator(raw: unknown): ElementLocator {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of LOCATOR_KEYS) {
    const v = r[k];
    if (typeof v !== 'string') continue;
    const cap = (LOC_LIMITS as Record<string, number>)[k];
    const s = v.replace(/\s+/g, ' ').trim();
    if (s === '' && k !== 'name' && k !== 'path') continue;
    out[k] = cap ? s.slice(0, cap) : s;
  }
  if (typeof out.name !== 'string') out.name = '';
  if (typeof out.path !== 'string') out.path = '';
  return LocatorSchema.parse(out);
}

/**
 * Which candidates are the recorded element. Self-contained (it is injected into extractJs by its
 * source): an element matches when its tag and role are the same and EVERY identity field is the
 * same (absent counts as a value: a label that appeared or vanished is a difference). Identity for
 * an interactive element is name, field name, label, landmark, id, href and input type; for a text
 * element (whose text is the value being read) it is id, label, landmark and classes. When more than
 * one element matches, the structural path breaks the tie; it never identifies on its own.
 * Returns the indexes of the matching candidates: 0 or >1 of them is a divergence.
 */
export function matchLocator(loc: ElementLocator, cands: ReadonlyArray<Partial<ElementLocator>>): number[] {
  const norm = (s: unknown) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
  const keys = loc.role === 'text' ? ['id', 'label', 'landmark', 'cls'] : ['name', 'fieldName', 'label', 'landmark', 'id', 'href', 'inputType'];
  const L = loc as unknown as Record<string, unknown>;
  const strict: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i] as unknown as Record<string, unknown>;
    if (norm(c.tag) !== norm(L.tag) || norm(c.role) !== norm(L.role)) continue;
    let same = true;
    for (const k of keys) {
      if (norm(L[k]) !== norm(c[k])) {
        same = false;
        break;
      }
    }
    if (same) strict.push(i);
  }
  if (strict.length <= 1) return strict;
  const byPath = strict.filter((i) => norm((cands[i] as unknown as Record<string, unknown>).path) === norm(L.path));
  return byPath.length >= 1 ? byPath : strict;
}

/** Titles and headings are compared with whitespace collapsed and every digit run as one token. */
const shape = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\d+([.,]\d+)*/g, '#');

/** Does the page still look like the one the step was recorded on? Returns what is missing, or null. */
export function landmarksMatch(expect: PageExpect, now: PageExpect): string | null {
  if (shape(expect.title) !== shape(now.title)) return `page title is “${now.title.slice(0, 80)}”, the recipe expects “${expect.title.slice(0, 80)}”`;
  if (expect.heading && shape(expect.heading) !== shape(now.heading)) {
    return now.heading ? `main heading is “${now.heading.slice(0, 80)}”, the recipe expects “${expect.heading.slice(0, 80)}”` : `the heading “${expect.heading.slice(0, 80)}” is missing`;
  }
  return null;
}

// ------------------------------------------------------------------ typed extraction

export type ExtractType = 'number' | 'text' | 'date';
export type WatchKind = 'number' | 'text-hash' | 'element-text';

/**
 * The first number in a text. "1,234.56", "1.234,56", "19.99", "€ 5", "-3" — the last of '.' / ','
 * is the decimal separator when both appear; a lone ',' is decimal unless exactly three digits follow.
 */
export function parseNumber(text: string): number | null {
  const m = /[-+−]?\d[\d.,   ]*\d|[-+−]?\d/.exec(text);
  if (!m) return null;
  let s = m[0].replace(/[   ]/g, '').replace('−', '-');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const after = s.length - lastComma - 1;
    s = s.split(',').length === 2 && after !== 3 ? s.replace(',', '.') : s.split(',').join('');
  } else if (lastDot >= 0 && s.split('.').length > 2) {
    s = s.split('.').join('');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** An ISO calendar date (YYYY-MM-DD) found in or parsed from a text, else null. */
export function parseDate(text: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const fmt = (d: Date) => (Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10));
  if (iso) return fmt(new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`));
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!/[a-z]{3}/i.test(t) || !/\d/.test(t)) return null;
  const ms = Date.parse(`${t} UTC`);
  return Number.isNaN(ms) ? null : fmt(new Date(ms));
}

export const cleanText = (s: string, max: number = LOC_LIMITS.text) => s.replace(/\s+/g, ' ').trim().slice(0, max);

export const textHash = (s: string) => createHash('sha256').update(cleanText(s, 100_000)).digest('hex').slice(0, 16);

/** Recipe extraction: the matched element's text as a typed value (null = not of that type). */
export function extractTyped(type: ExtractType, text: string): number | string | null {
  if (type === 'number') return parseNumber(text);
  if (type === 'date') return parseDate(text);
  const t = cleanText(text, 200);
  return t ? t : null;
}

/** Watcher extraction: a number, a hash of the text, or the text capped at 200 characters. */
export function watchTyped(kind: WatchKind, text: string): number | string | null {
  if (kind === 'number') return parseNumber(text);
  if (kind === 'text-hash') return textHash(text);
  const t = cleanText(text, 200);
  return t ? t : null;
}

// ------------------------------------------------------------------ page scripts

/**
 * Helpers shared by the agent's snapshot (page-scripts.ts) and every locator script. Plain JS, no
 * page-world access; `layout` checks are skipped by the external runner (a headless browser without
 * a layout engine reports zero-size boxes).
 */
export const ELEMENT_HELPERS_JS = `
const gbClean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n || 160);
const gbVisible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
};
const gbLabelOf = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = lb.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' '); if (t.trim()) return t; }
  if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText || l.textContent || ''; }
  const wrap = el.closest('label'); if (wrap) return wrap.innerText || wrap.textContent || '';
  if (el.tagName === 'INPUT' && ['submit','button','reset'].includes(el.type)) return el.value;
  if (el.tagName === 'INPUT' && el.type === 'image') return el.alt || el.name || '';
  const txt = el.innerText !== undefined ? el.innerText : el.textContent; if (txt && txt.trim()) return txt;
  const img = el.querySelector && el.querySelector('img[alt]'); if (img) return img.alt;
  return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
};
const GB_ROLES = new Set(${JSON.stringify(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'treeitem'])});
const gbRoleOf = (el) => {
  // the role attribute is page text: only real ARIA roles pass (core re-validates too)
  const r = (el.getAttribute('role') || '').trim().toLowerCase(); if (r) return GB_ROLES.has(r) ? r : 'generic';
  const t = el.tagName.toLowerCase();
  if (t === 'a') return 'link';
  if (t === 'button' || t === 'summary') return 'button';
  if (t === 'select') return 'combobox';
  if (t === 'textarea') return 'textbox';
  if (t === 'input') {
    const ty = (el.type || 'text').toLowerCase();
    if (['submit','button','reset','image'].includes(ty)) return 'button';
    if (ty === 'checkbox' || ty === 'radio') return ty;
    return 'textbox';
  }
  return 'generic';
};
const GB_SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[contenteditable=true]';
/** names and types of a form's controls, never their values (a recipe's form shape) */
const gbFormShape = (form) => {
  const seen = new Set();
  const out = [];
  for (const f of form.elements) {
    if (!f.name || f.disabled) continue;
    const ty = String(f.type || f.tagName.toLowerCase()).toLowerCase().slice(0, 20);
    if (['submit','button','reset','image'].includes(ty)) continue;
    const name = gbClean(f.name, 80);
    if (seen.has(name + ':' + ty)) continue;
    seen.add(name + ':' + ty);
    out.push({ name, type: ty });
    if (out.length >= 60) break;
  }
  return out.sort((a, b) => (a.name + ':' + a.type < b.name + ':' + b.type ? -1 : 1));
};
/** the facts the policy engine needs (formAction etc.), computed by our code, not by the page */
const gbFacts = (el) => {
  const tag = el.tagName.toLowerCase();
  const form = el.form || el.closest('form');
  const inputType = tag === 'input' ? (el.type || 'text').toLowerCase() : undefined;
  // use the IDL .type: <button type="go"> (invalid) is a submit button in the DOM
  const isSubmit = !!form && ((tag === 'button' && el.type === 'submit') || (tag === 'input' && ['submit','image'].includes(inputType)));
  const e = { role: gbRoleOf(el), name: gbClean(gbLabelOf(el)), tag };
  if (inputType) e.inputType = inputType;
  if (tag === 'a' && el.href) e.href = el.href;
  if (form) {
    e.inForm = true;
    // el.formAction falls back to the document URL when the attribute is absent, so check the attribute
    e.formAction = (isSubmit && el.hasAttribute('formaction') ? el.formAction : form.action) || location.href;
    e.formMethod = (isSubmit && el.hasAttribute('formmethod') ? el.formMethod : form.method || 'get').toLowerCase();
    e.formEnctype = (isSubmit && el.hasAttribute('formenctype') ? el.formEnctype : form.enctype || 'application/x-www-form-urlencoded').toLowerCase();
    e.formHasPassword = !!form.querySelector('input[type=password]');
    e.formShape = gbFormShape(form);
  }
  if (isSubmit) e.isSubmit = true;
  return e;
};
const gbSafeWord = (c) => /^[A-Za-z][\\w-]{0,31}$/.test(c) && !/\\d{3}/.test(c);
const gbClasses = (el) => [...(el.classList || [])].filter(gbSafeWord).sort().slice(0, 2);
const gbSeg = (el) => el.tagName.toLowerCase() + gbClasses(el).map((c) => '.' + c).join('');
const GB_LM_TAG = { main: 'main', nav: 'navigation', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', section: 'region', dialog: 'dialog' };
const GB_LM_ROLE = new Set(['main','navigation','banner','contentinfo','complementary','form','region','search','dialog']);
const gbLandmark = (el) => {
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const r = (p.getAttribute('role') || '').trim().toLowerCase();
    const t = p.tagName.toLowerCase();
    const role = GB_LM_ROLE.has(r) ? r : GB_LM_TAG[t];
    if (!role) continue;
    let name = gbClean(p.getAttribute('aria-label'), 60);
    if (!name && p.id && gbSafeWord(p.id)) name = '#' + p.id;
    if (!name && t === 'form') { try { name = new URL(p.getAttribute('action') || location.href, location.href).pathname; } catch (e) {} }
    if (role === 'region' && !name) continue;
    return { node: p, name: gbClean(role + (name ? ' ' + name : ''), 120) };
  }
  return { node: null, name: '' };
};
/** the heading an element sits under: the last h1-h6 before it inside one of its 6 nearest ancestors */
const gbHeadingBefore = (el) => {
  let a = el.parentElement;
  for (let depth = 0; a && depth < 6; a = a.parentElement, depth++) {
    const hs = a.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i];
      if (h === el || h.contains(el) || el.contains(h)) continue;
      if (h.compareDocumentPosition(el) & 4) return h.innerText !== undefined ? h.innerText : h.textContent;
    }
  }
  return '';
};
const gbDescribe = (el) => {
  const lm = gbLandmark(el);
  const segs = [];
  for (let p = el; p && p !== lm.node && p !== document.body && p !== document.documentElement && segs.length < 12; p = p.parentElement) segs.unshift(gbSeg(p));
  const tag = el.tagName.toLowerCase();
  const d = { landmark: lm.name, path: segs.join('>').slice(0, ${LOC_LIMITS.path}), cls: gbClasses(el).join(' ') };
  const id = el.getAttribute('id');
  if (id && gbSafeWord(id)) d.id = id;
  if (['input','select','textarea','button'].includes(tag) && el.getAttribute('name')) d.fieldName = gbClean(el.getAttribute('name'), ${LOC_LIMITS.fieldName});
  let label = el.labels && el.labels.length ? (el.labels[0].innerText || el.labels[0].textContent || '') : '';
  if (!label) label = gbHeadingBefore(el);
  if (label) d.label = gbClean(label, ${LOC_LIMITS.label});
  return d;
};
const gbHeading = () => { const h = document.querySelector('h1') || document.querySelector('h2'); return h ? gbClean(h.innerText !== undefined ? h.innerText : h.textContent, 160) : ''; };
const gbHrefKey = (href) => { try { const u = new URL(href); return /^https?:$/.test(u.protocol) ? (u.origin + u.pathname).slice(0, ${LOC_LIMITS.href}) : ''; } catch (e) { return ''; } };
/** one candidate: locator fields + policy facts; text elements carry their (capped) text */
const gbCandidate = (el, interactive) => {
  const f = gbFacts(el);
  const c = Object.assign({}, f, gbDescribe(el));
  if (f.href) { c.fullHref = f.href; c.href = gbHrefKey(f.href); }
  if (!interactive) { c.role = 'text'; c.name = ''; c.text = gbClean(el.innerText !== undefined ? el.innerText : el.textContent, ${LOC_LIMITS.text}); delete c.inputType; delete c.href; delete c.fullHref; }
  return c;
};
/** every candidate for a locator's tag; interactive ones from the snapshot's selector */
const gbCollect = (tag, interactive, layout, max) => {
  const out = [];
  const els = [];
  const list = interactive ? document.querySelectorAll(GB_SEL) : document.getElementsByTagName(tag);
  for (const el of list) {
    if (el.tagName.toLowerCase() !== tag) continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (interactive && el.disabled) continue;
    if (layout && !gbVisible(el)) continue;
    out.push(gbCandidate(el, interactive));
    els.push(el);
    if (out.length >= (max || 500)) break;
  }
  return { out, els };
};
`;

const PRELUDE = `if (!window.__gb) window.__gb = { refs: new Map() };`;

/**
 * Candidates for one locator's tag, each registered under a fresh ref in the isolated world's ref
 * map (the same map the action scripts use), plus the page's title and main heading.
 */
export function candidatesJs(q: { tag: string; interactive: boolean; layout?: boolean }): string {
  return `(() => {
${PRELUDE}
${ELEMENT_HELPERS_JS}
const q = ${JSON.stringify({ tag: q.tag, interactive: q.interactive, layout: q.layout !== false })};
const r = gbCollect(q.tag, q.interactive, q.layout, 500);
const gb = window.__gb;
gb.xn = gb.xn || 0;
r.out.forEach((c, i) => { const ref = 'x' + (++gb.xn); gb.refs.set(ref, r.els[i]); c.ref = ref; });
return { url: location.href, title: document.title || '', heading: gbHeading(), candidates: r.out };
})()`;
}

/** Title, URL and main heading only. */
export const PAGE_INFO_JS = `(() => {
${ELEMENT_HELPERS_JS}
return { url: location.href, title: document.title || '', heading: gbHeading() };
})()`;

/**
 * A watcher's extraction, matched IN the page (matchLocator's own source is injected): only the
 * match count, the page's title / heading / URL and the ONE matched element's capped text return.
 */
export function extractJs(loc: ElementLocator, layout: boolean): string {
  const fn = matchLocator.toString();
  return `(() => {
${ELEMENT_HELPERS_JS}
const gbMatch = (${fn});
const loc = ${JSON.stringify(loc)};
const interactive = loc.role !== 'text';
const r = gbCollect(loc.tag, interactive, ${layout ? 'true' : 'false'}, 2000);
const idx = gbMatch(loc, r.out);
const one = idx.length === 1 ? r.out[idx[0]] : null;
return { url: location.href, title: gbClean(document.title, 160), heading: gbHeading(), count: idx.length, text: one ? (interactive ? one.name : one.text) || '' : '' };
})()`;
}

/**
 * Recording an extract: the smallest visible element whose text contains a value the reader
 * returned. Returns its candidate (locator fields) or null.
 */
export function locateTextJs(value: string): string {
  return `(() => {
${ELEMENT_HELPERS_JS}
const want = ${JSON.stringify(value.replace(/\s+/g, ' ').trim().slice(0, 200))};
if (!want) return null;
let best = null, bestLen = Infinity, n = 0;
for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
  if (++n > 20000) break;
  if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','TITLE'].includes(el.tagName)) continue;
  const t = gbClean(el.innerText, 100000);
  if (!t.includes(want) || t.length >= bestLen || !gbVisible(el)) continue;
  best = el; bestLen = t.length;
}
return best ? gbCandidate(best, false) : null;
})()`;
}

/**
 * The watcher element picker: a closed-shadow-DOM outline that follows the pointer; a click returns
 * the element's candidate (a text locator, or an interactive one for a control), Escape or 60 s
 * returns null. Runs in the isolated world, so the page can neither see nor restyle it.
 */
export const PICKER_JS = `new Promise((resolve) => {
${ELEMENT_HELPERS_JS}
const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
const root = host.attachShadow({ mode: 'closed' });
const box = document.createElement('div');
box.style.cssText = 'position:fixed;border:2px solid #f59e0b;background:rgba(245,158,11,.15);pointer-events:none;display:none';
const tip = document.createElement('div');
tip.style.cssText = 'position:fixed;left:8px;top:8px;background:#111;color:#fff;font:13px system-ui;padding:6px 10px;border-radius:6px';
tip.textContent = 'Guarded Browser: click the value to watch (Esc cancels)';
root.append(box, tip);
(document.body || document.documentElement).append(host);
let done = false;
const finish = (v) => {
  if (done) return; done = true;
  window.removeEventListener('mousemove', move, true);
  window.removeEventListener('click', click, true);
  window.removeEventListener('mousedown', block, true);
  window.removeEventListener('mouseup', block, true);
  window.removeEventListener('keydown', key, true);
  host.remove();
  resolve(v);
};
const move = (e) => {
  const el = e.target;
  if (!el || !el.getBoundingClientRect) return;
  const r = el.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
};
const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
const click = (e) => {
  block(e);
  const el = e.target;
  if (!el || !el.tagName) return finish(null);
  const interactive = el.matches(GB_SEL);
  const c = gbCandidate(el, interactive);
  finish({ url: location.href, title: gbClean(document.title, 160), heading: gbHeading(), candidate: c, text: interactive ? c.name : c.text });
};
const key = (e) => { if (e.key === 'Escape') { block(e); finish(null); } };
window.addEventListener('mousemove', move, true);
window.addEventListener('mousedown', block, true);
window.addEventListener('mouseup', block, true);
window.addEventListener('click', click, true);
window.addEventListener('keydown', key, true);
setTimeout(() => finish(null), 60000);
})`;

/** Re-validate one candidate from a page script (every field is page-produced data). */
export function toCandidate(raw: unknown): Candidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  let loc: ElementLocator;
  try {
    loc = toLocator(r);
  } catch {
    return null;
  }
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const c: Candidate = { ...loc, ref: s(r.ref, 16) ?? '' };
  if (typeof r.text === 'string') c.text = cleanText(r.text);
  for (const k of ['formAction', 'fullHref'] as const) if (typeof r[k] === 'string') c[k] = s(r[k], 2048);
  if (typeof r.formMethod === 'string') c.formMethod = r.formMethod.toLowerCase() === 'post' ? 'post' : 'get';
  if (typeof r.formEnctype === 'string') c.formEnctype = r.formEnctype.slice(0, 80).toLowerCase();
  for (const k of ['formHasPassword', 'inForm', 'isSubmit'] as const) if (r[k] === true) c[k] = true;
  if (Array.isArray(r.formShape)) {
    c.formShape = r.formShape
      .slice(0, 60)
      .filter((f): f is { name: string; type: string } => !!f && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { type?: unknown }).type === 'string')
      .map((f) => ({ name: f.name.slice(0, 80), type: f.type.slice(0, 20) }));
  }
  return c;
}

/** Re-validate a page-info result. */
export function toPageInfo(raw: unknown, fallbackUrl = ''): PageInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  return { url: typeof r.url === 'string' ? r.url.slice(0, 2048) : fallbackUrl, title: s(r.title), heading: s(r.heading) };
}

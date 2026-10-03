// Scripts executed inside pages in an ISOLATED world (not the page's main world), so page JS
// cannot read or tamper with our ref map or override the functions we call.

import { ELEMENT_HELPERS_JS } from '../core/locator';

export const ISOLATED_WORLD = 1717;

const PRELUDE = `
if (!window.__gb) window.__gb = { refs: new Map() };
`;

/** Accessibility-style snapshot of visible interactive elements. Names are raw page data. Each
 *  element also carries its locator fields (`loc`, src/core/locator.ts) so a finished task can be
 *  saved as a recipe; the planner never sees them (agent.ts renders only the sanitised view). */
export const SNAPSHOT_JS = `(() => {
${PRELUDE}
${ELEMENT_HELPERS_JS}
const gb = window.__gb;
gb.refs = new Map();
const out = [];
let n = 0;
for (const el of document.querySelectorAll(GB_SEL)) {
  if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
  if (!gbVisible(el) || el.disabled) continue;
  const ref = 'e' + (++n);
  gb.refs.set(ref, el);
  const e = Object.assign({ ref }, gbFacts(el));
  const d = gbDescribe(el);
  if (e.href) d.href = gbHrefKey(e.href);
  e.loc = d;
  out.push(e);
  if (n >= 300) break;
}
return { url: location.href, title: document.title || '', heading: gbHeading(), elements: out };
})()`;

export const PAGE_TEXT_JS = `(() => (document.body ? document.body.innerText : '').slice(0, 60000))()`;

/** Build an action script. Arguments are JSON-encoded, never concatenated as code. */
export function actionJs(kind: 'click' | 'type' | 'select' | 'submit' | 'formFields' | 'scroll', ref: string, value = ''): string {
  return `(() => {
${PRELUDE}
const kind = ${JSON.stringify(kind)}, ref = ${JSON.stringify(ref)}, value = ${JSON.stringify(value)};
if (kind === 'scroll') { window.scrollBy(0, (value === 'up' ? -1 : 1) * window.innerHeight * 0.8); return { ok: true }; }
const el = window.__gb.refs.get(ref);
if (!el || !el.isConnected) return { ok: false, detail: 'element ' + ref + ' not found (take a new snapshot)' };
const form = el.form || el.closest('form');
if (kind === 'formFields') {
  if (!form) return { ok: true, fields: [] };
  const fields = [];
  for (const f of form.elements) {
    if (!f.name || f.disabled) continue;
    // submit buttons: only the one actually being clicked (el) is sent, and only it is reported
    if (f.type === 'image') { if (f === el) fields.push({ name: f.name, value: '', submitter: true, image: true }); continue; }
    if (f.type === 'submit' || (f.tagName === 'BUTTON' && f.type === 'submit')) { if (f === el) fields.push({ name: f.name, value: String(f.value), submitter: true }); continue; }
    if (['button','reset','file'].includes(f.type)) continue;
    if (['checkbox','radio'].includes(f.type) && !f.checked) continue;
    if (f.tagName === 'SELECT' && f.multiple) { for (const o of f.selectedOptions) fields.push({ name: f.name, value: o.value }); continue; }
    fields.push({ name: f.name, value: String(f.value), hidden: f.type === 'hidden' || undefined, password: f.type === 'password' || undefined });
  }
  // form.elements never lists <input type=image>, so the clicked image button is added here
  if (el.tagName === 'INPUT' && el.type === 'image' && el.form === form) fields.push({ name: el.name, value: '', submitter: true, image: true });
  return { ok: true, fields };
}
el.scrollIntoView({ block: 'center' });
if (kind === 'click') { el.focus(); el.click(); return { ok: true }; }
if (kind === 'type' || kind === 'select') {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  el.focus();
  if (el.isContentEditable) el.textContent = value;
  else if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}
if (kind === 'submit') {
  if (!form) return { ok: false, detail: 'element is not inside a form' };
  if (form.requestSubmit) form.requestSubmit(); else form.submit();
  return { ok: true };
}
return { ok: false, detail: 'unknown action' };
})()`;
}

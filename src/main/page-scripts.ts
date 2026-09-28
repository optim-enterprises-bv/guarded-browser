// Scripts executed inside pages in an ISOLATED world (not the page's main world), so page JS
// cannot read or tamper with our ref map or override the functions we call.

export const ISOLATED_WORLD = 1717;

const PRELUDE = `
if (!window.__gb) window.__gb = { refs: new Map() };
`;

/** Accessibility-style snapshot of visible interactive elements. Names are raw page data. */
export const SNAPSHOT_JS = `(() => {
${PRELUDE}
const gb = window.__gb;
gb.refs = new Map();
const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[contenteditable=true]';
const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
};
const labelOf = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = lb.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '); if (t.trim()) return t; }
  if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
  const wrap = el.closest('label'); if (wrap) return wrap.innerText;
  if (el.tagName === 'INPUT' && ['submit','button','reset'].includes(el.type)) return el.value;
  const txt = el.innerText; if (txt && txt.trim()) return txt;
  const img = el.querySelector && el.querySelector('img[alt]'); if (img) return img.alt;
  return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
};
const ROLES = new Set(${JSON.stringify(['link','button','textbox','searchbox','checkbox','radio','combobox','listbox','option','tab','menuitem','menuitemcheckbox','menuitemradio','switch','slider','spinbutton','treeitem'])});
const roleOf = (el) => {
  // the role attribute is page text: only real ARIA roles pass (core re-validates too)
  const r = (el.getAttribute('role') || '').trim().toLowerCase(); if (r) return ROLES.has(r) ? r : 'generic';
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
const out = [];
let n = 0;
for (const el of document.querySelectorAll(SEL)) {
  if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
  if (!visible(el) || el.disabled) continue;
  const ref = 'e' + (++n);
  gb.refs.set(ref, el);
  const tag = el.tagName.toLowerCase();
  const form = el.form || el.closest('form');
  const inputType = tag === 'input' ? (el.type || 'text').toLowerCase() : undefined;
  // use the IDL .type: <button type="go"> (invalid) is a submit button in the DOM
  const isSubmit = !!form && ((tag === 'button' && el.type === 'submit') || (tag === 'input' && ['submit','image'].includes(inputType)));
  const e = { ref, role: roleOf(el), name: clean(labelOf(el)), tag };
  if (inputType) e.inputType = inputType;
  if (tag === 'a' && el.href) e.href = el.href;
  if (form) {
    e.inForm = true;
    // el.formAction falls back to the document URL when the attribute is absent, so check the attribute
    e.formAction = (isSubmit && el.hasAttribute('formaction') ? el.formAction : form.action) || location.href;
    e.formMethod = (form.method || 'get').toLowerCase();
    e.formHasPassword = !!form.querySelector('input[type=password]');
  }
  if (isSubmit) e.isSubmit = true;
  out.push(e);
  if (n >= 300) break;
}
return { url: location.href, title: document.title || '', elements: out };
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
  return { ok: true, fields: [...form.elements].filter((f) => f.name && !['submit','button','reset','image','file'].includes(f.type) && (!['checkbox','radio'].includes(f.type) || f.checked))
    .map((f) => ({ name: (f.type === 'hidden' ? '(hidden) ' : '') + f.name, value: f.type === 'password' ? '•'.repeat(String(f.value).length) + ' (password)' : String(f.value) })) };
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

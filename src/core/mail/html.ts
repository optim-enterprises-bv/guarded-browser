// HTML mail, made inert (the HTML reading view) — pure, no Electron, unit-tested.
//
// A message's text/html part is displayed in a dedicated main-process WebContentsView with
// JavaScript off, its own in-memory session, and a network filter that cancels everything. This
// module is the part of that view that can be tested without a window:
//
//   * `pickHtml` / `looksLikeHtml`: which part of a message is "the HTML body" (a text/plain part
//     that is plainly an HTML document counts, because some senders put their HTML source there);
//   * `sanitizeMailHtml`: a single-pass, allowlist tag/attribute rewriter. JavaScript is already off
//     in the view and the CSP forbids scripts; this is defence in depth, so a mistake in one layer
//     does not become script execution, a form post or a navigation;
//   * `mailDocument`: the document actually loaded, with the CSP meta FIRST in <head>;
//   * `mailRequestDecision` / `isPrivateHost`: what the view's session may fetch — nothing, unless
//     the user pressed "Load External Content" for THIS message, and then only GET images from public
//     http(s) hosts on default ports.
//
// Linear time by construction: the sanitizer walks the input once with indexOf / charCode scans and
// never uses a backtracking regex on unbounded input; the input is capped before it starts.

import { MAX_BODY_HTML, decodeEntities } from './store';

// ---------------------------------------------------------------- choosing the html body

/** Tags whose presence at the start of a text/plain part means "this is HTML source". */
const HTML_START = /^\s*<(?:!doctype\s+html|html|head|body|table|div)\b/i;
const HTML_ANCHOR = /<(?:html|body|table|div)\b/i;
const MIN_TAGS = 20;
const SNIFF = 50_000;

/**
 * Is this text/plain body really an HTML document? True when it starts with a document-ish tag, or
 * contains one AND carries many tags. Prose that mentions `<div>` once is not HTML.
 */
export function looksLikeHtml(text: string): boolean {
  const head = String(text ?? '').slice(0, SNIFF);
  if (!HTML_ANCHOR.test(head)) return false;
  if (HTML_START.test(head)) return true;
  // bounded tag body ({0,200}) on a bounded window: worst case is SNIFF * 200 steps, not quadratic
  const re = /<\/?[a-z][a-z0-9]{0,15}\b[^<>]{0,200}>/gi;
  let n = 0;
  while (re.exec(head)) if (++n >= MIN_TAGS) return true;
  return false;
}

/**
 * The HTML body to keep for a message: the text/html part(s) when there are any, else the text/plain
 * body when it is plainly HTML source, else ''.
 */
export function pickHtml(htmlParts: string, plain: string): string {
  if (htmlParts && htmlParts.trim()) return htmlParts.slice(0, MAX_BODY_HTML);
  if (plain && looksLikeHtml(plain)) return plain.slice(0, MAX_BODY_HTML);
  return '';
}

// ---------------------------------------------------------------- sanitizer

/** Elements kept (tag only; their attributes are filtered separately). Anything else: tag dropped, text kept. */
const KEEP = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
  'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u',
  'ul', 'var', 'wbr',
]);

/**
 * Elements dropped WITH their content. Every raw-text / RCDATA element is here (script, xmp, textarea,
 * title, noscript, ...) so the sanitizer and the browser can never disagree about where such an element
 * ends; svg and math are here because foreign content parses <style> differently from HTML.
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'applet', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'textarea',
  'title', 'template', 'svg', 'math', 'select',
]);

/** Void elements: no closing tag, so they are never pushed as "open". */
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr', 'input', 'meta', 'link', 'base', 'embed', 'area', 'source', 'param', 'track', 'keygen']);

/** Attributes kept on any kept element. Everything else (on*, srcset, formaction, xmlns:*, ...) is dropped. */
const GLOBAL_ATTRS = new Set([
  'align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'width', 'height', 'color', 'face', 'size', 'style', 'class', 'dir',
  'lang', 'title', 'alt', 'colspan', 'rowspan', 'span', 'nowrap', 'start', 'type', 'scope', 'headers', 'role', 'hspace', 'vspace', 'clear',
  'id', 'open', 'datetime', 'cite',
]);

const MAX_ATTRS = 64;
const MAX_ATTR_VALUE = 8192;

export interface SanitizeReport {
  html: string;
  /** distinct http(s) hosts referenced by kept image URLs (img src, background) */
  remoteImageHosts: string[];
}

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13 || c === 47; // '/' separates attributes too

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The scheme of a URL attribute as the browser sees it: entities decoded, control chars and whitespace removed. */
function urlOf(raw: string): { url: string; scheme: string } {
  const url = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]+/g, '');
  const m = /^([a-z][a-z0-9+.-]{0,30}):/i.exec(url);
  return { url, scheme: m ? m[1].toLowerCase() : '' };
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|bmp);/i;

/** href: http(s) and mailto only, or an in-document fragment. */
function safeHref(raw: string): string | null {
  const { url, scheme } = urlOf(raw);
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return url;
  if (!scheme && url.startsWith('#')) return url;
  return null;
}

/** img src / background: data:image (raster), http(s) (blocked by the network layer unless opted in), cid:. */
function safeImage(raw: string): string | null {
  const { url, scheme } = urlOf(raw);
  if (scheme === 'http' || scheme === 'https' || scheme === 'cid') return url;
  if (scheme === 'data' && SAFE_DATA_IMAGE.test(url)) return url;
  return null;
}

/** inline style: kept, minus the constructs that have ever meant code or a fetch outside img-src. */
function safeStyle(raw: string): string | null {
  const v = decodeEntities(raw);
  if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i.test(v)) return null;
  return v;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite hostile HTML into a fixed, conservative subset. Never throws; output is always well-quoted.
 * `max` caps the INPUT (an over-long message is truncated, not rejected).
 */
export function sanitizeMailHtml(input: string, max = MAX_BODY_HTML): SanitizeReport {
  const src = String(input ?? '').slice(0, max);
  const lower = src.toLowerCase();
  const out: string[] = [];
  const hosts = new Set<string>();
  const n = src.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) out.push(src.slice(textStart, end).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  };
  /** skip past the first `</name` ... `>` at or after `from`; the end of input when there is none */
  const skipPastClose = (name: string, from: number): number => {
    const at = lower.indexOf(`</${name}`, from);
    if (at < 0) return n;
    const gt = src.indexOf('>', at);
    return gt < 0 ? n : gt + 1;
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const c1 = src.charCodeAt(lt + 1);
    // comments (conditional comments included) and <!doctype>, <?xml ...?>: dropped entirely
    if (src.startsWith('<!--', lt)) {
      flushText(lt);
      const end = src.indexOf('-->', lt + 4);
      i = textStart = end < 0 ? n : end + 3;
      continue;
    }
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      flushText(lt);
      const gt = src.indexOf('>', lt);
      i = textStart = gt < 0 ? n : gt + 1;
      continue;
    }
    const closing = c1 === 47; /* / */
    const nameAt = closing ? lt + 2 : lt + 1;
    if (!isNameStart(src.charCodeAt(nameAt))) {
      // a lone '<' is text; flushText escapes it
      i = lt + 1;
      continue;
    }
    flushText(lt);
    let j = nameAt;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const name = lower.slice(nameAt, j);

    // ---- attributes: one linear pass to the tag's closing '>' (quotes respected) ----
    const attrs: Array<[string, string | null]> = [];
    let k = j;
    let ended = false;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 62 /* > */) {
        ended = true;
        k++;
        break;
      }
      if (isSpace(c)) {
        k++;
        continue;
      }
      // attribute name: anything up to space, '/', '>', or '='
      const an = k;
      while (k < n) {
        const d = src.charCodeAt(k);
        if (isSpace(d) || d === 62 || d === 61) break;
        k++;
      }
      if (k === an) k++; // a stray '=' with no name: step over it
      const aname = lower.slice(an, k);
      while (k < n && src.charCodeAt(k) !== 47 && isSpace(src.charCodeAt(k))) k++;
      let value: string | null = null;
      if (src.charCodeAt(k) === 61 /* = */) {
        k++;
        while (k < n && src.charCodeAt(k) !== 47 && isSpace(src.charCodeAt(k))) k++;
        const q = src.charCodeAt(k);
        if (q === 34 || q === 39) {
          const close = src.indexOf(q === 34 ? '"' : "'", k + 1);
          const end = close < 0 ? n : close;
          value = src.slice(k + 1, end);
          k = close < 0 ? n : close + 1;
        } else {
          const vs = k;
          while (k < n) {
            const d = src.charCodeAt(k);
            if (d === 62 || (d !== 47 && isSpace(d))) break;
            k++;
          }
          value = src.slice(vs, k);
        }
      }
      if (aname && attrs.length < MAX_ATTRS) attrs.push([aname, value]);
    }
    i = textStart = k;
    if (!ended) break; // an unterminated tag eats the rest of the input, as in a browser

    if (closing) {
      if (KEEP.has(name) && !VOID.has(name)) out.push(`</${name}>`);
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      i = textStart = skipPastClose(name, i);
      continue;
    }
    if (name === 'style') {
      // raw text in HTML: copied to the first </style, never parsed as markup. Its url()s are images
      // (img-src), blocked by the CSP and the network filter like any other remote image.
      const at = lower.indexOf('</style', i);
      const body = src.slice(i, at < 0 ? n : at);
      out.push(/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|@import/i.test(body) ? '<style>' : `<style>${body}`, '</style>');
      i = textStart = skipPastClose('style', i);
      continue;
    }
    if (!KEEP.has(name)) continue; // form, input, button, base, link, meta, embed, body, html, ...: tag dropped, content kept

    const kept: string[] = [];
    for (const [an, av] of attrs) {
      if (an.startsWith('on')) continue;
      const v = (av ?? '').slice(0, MAX_ATTR_VALUE);
      let safe: string | null = null;
      if (an === 'href' && name === 'a') safe = safeHref(v);
      else if (an === 'src' && name === 'img') safe = safeImage(v);
      else if (an === 'background' && (name === 'table' || name === 'td' || name === 'th' || name === 'tr')) safe = safeImage(v);
      else if (an === 'style') safe = safeStyle(v);
      else if (GLOBAL_ATTRS.has(an)) safe = decodeEntities(v);
      if (safe === null) continue;
      if (an === 'src' || an === 'background') {
        const h = hostOf(safe);
        if (h) hosts.add(h);
      }
      kept.push(` ${an}="${escapeAttr(safe)}"`);
    }
    // a link opens in a NEW tab through the browser's own path; the view itself never navigates
    if (name === 'a') kept.push(' rel="noreferrer noopener"');
    out.push(`<${name}${kept.join('')}>`);
  }
  flushText(n);
  // inline style blocks can reference images too (background:url(...)): count their hosts for the banner
  for (const m of src.matchAll(/url\(\s*['"]?(https?:\/\/[^'")\s]{1,2048})/gi)) {
    const h = hostOf(m[1]);
    if (h) hosts.add(h);
  }
  return { html: out.join(''), remoteImageHosts: [...hosts].slice(0, 500) };
}

// ---------------------------------------------------------------- the document

export const CSP_BLOCKED = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
export const CSP_REMOTE_IMAGES = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:";

/**
 * The document the view loads. The CSP meta is the FIRST thing in <head>, before any sanitized
 * content, so nothing in the message can precede (or override) it.
 */
export function mailDocument(sanitized: string, opts: { remoteImages: boolean }): string {
  const csp = opts.remoteImages ? CSP_REMOTE_IMAGES : CSP_BLOCKED;
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    '<style>html{background:#fff;color:#111}body{margin:0;padding:8px 10px;font:13px/1.45 system-ui,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}</style>' +
    `</head><body>${sanitized}</body></html>`
  );
}

/** Chromium refuses URLs longer than 2 MiB; a message whose document would not fit falls back to text. */
export const MAX_DATA_URL = 2 * 1024 * 1024 - 1024;

export function dataUrlFor(doc: string): string | null {
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(doc, 'utf8').toString('base64')}`;
  return url.length <= MAX_DATA_URL ? url : null;
}

// ---------------------------------------------------------------- the network policy

/**
 * Hosts a mail image may never come from: loopback, private, link-local, CGNAT, multicast, unspecified,
 * and names that only mean something on the local network. Mail is not allowed to probe the LAN.
 * Takes a URL hostname (already canonicalised by the URL parser: `2130706433` is `127.0.0.1` by then).
 */
export function isPrivateHost(hostIn: string): boolean {
  const h = String(hostIn ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateV4(v4.slice(1).map(Number));
  if (h.includes(':')) return isPrivateV6(h);
  // a single-label name (no dot) resolves through the local search domain: never public
  return !h.includes('.');
}

function isPrivateV4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

function isPrivateV6(h: string): boolean {
  if (h === '::' || h === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return isPrivateHost(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const x = parseInt(hex[1], 16);
    const y = parseInt(hex[2], 16);
    return isPrivateV4([x >> 8, x & 255, y >> 8, y & 255]);
  }
  const first = parseInt(h.split(':')[0] || '0', 16);
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast, 64:ff9b::/96 NAT64 is left public
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

export interface MailRequest {
  url: string;
  method: string;
  resourceType: string;
}

export interface MailRequestState {
  /** the data: URL currently displayed (the only document the view may load) */
  documentUrl: string;
  /** the user pressed "Load External Content" for the message on display, during this display */
  remoteImages: boolean;
  /** TEST ONLY (GUARDED_TEST=1 in an unpackaged build): the e2e fixture server lives on 127.0.0.1 */
  allowLoopbackForTest?: boolean;
}

export type MailDecision = { allow: true; host?: string } | { allow: false; reason: string };

/**
 * What the mail view's session may fetch. Default: the displayed document and inline data: images,
 * nothing else. After the per-message opt-in: GET images from public http(s) hosts on the default
 * port. Never: scripts, xhr/fetch, frames, objects, media, websockets, POST, a second document.
 */
export function mailRequestDecision(req: MailRequest, st: MailRequestState): MailDecision {
  const url = String(req.url ?? '');
  const type = String(req.resourceType ?? 'other');
  if (url.startsWith('data:')) {
    if (type === 'mainFrame' && url === st.documentUrl) return { allow: true };
    if (type === 'image' && SAFE_DATA_IMAGE.test(url)) return { allow: true };
    return { allow: false, reason: 'data: URL that is not the displayed message or an inline image' };
  }
  if (!st.remoteImages) return { allow: false, reason: 'remote content is blocked for this message' };
  if (type !== 'image') return { allow: false, reason: `${type} requests are never allowed in the mail view` };
  if (String(req.method ?? '').toUpperCase() !== 'GET') return { allow: false, reason: 'only GET is allowed for a remote image' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: 'unparseable URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allow: false, reason: `${u.protocol} is not allowed` };
  if (u.username || u.password) return { allow: false, reason: 'credentials in an image URL' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (st.allowLoopbackForTest && (host === '127.0.0.1' || host === 'localhost')) return { allow: true, host };
  if (u.port !== '') return { allow: false, reason: 'non-standard port' };
  if (isPrivateHost(host)) return { allow: false, reason: 'loopback, private or local-network host' };
  return { allow: true, host };
}

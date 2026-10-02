// MIME and header parsing (ticket 36) — pure, no sockets, no Electron, no parser dependency.
//
// Mail arrives as a hostile byte soup: header names with control characters, 40 000-part
// multiparts, literals that claim 4 GB, base64 that is not base64, encoded-words with an unknown
// charset, addresses designed to break a naive splitter. Every function here is capped and returns
// text, never markup, and nothing in it fetches or renders anything.
//
// Kept separate from the IMAP client on purpose: the protocol layer's job is to DELIVER bytes, this
// module's job is to make them inert, and the store's job is to keep only the text. That is also why
// these tests are the cheapest ones in the mail program.

import { clean, cleanBody, htmlToText, MAX_BODY_HTML, MAX_BODY_TEXT, MAX_STR } from './store';
import { looksLikeHtml, pickHtml } from './html';

export const MAX_HEADER_BYTES = 256 * 1024;
export const MAX_HEADERS = 500;
export const MAX_PARTS = 200;
export const MAX_DEPTH = 12;
export const MAX_ADDRESSES = 100;
export const MAX_FILENAME = 200;
/** a literal larger than this is refused by the protocol layer; this is the last line of defence */
export const MAX_BODY_INPUT = 8 * MAX_BODY_TEXT;

export interface Header {
  name: string;
  value: string;
}

export interface MimePart {
  headers: Header[];
  contentType: string;
  params: Record<string, string>;
  /** Content-Transfer-Encoding, lower-cased; '7bit' when absent */
  encoding: string;
  /** the DECODED payload for a leaf, '' for a container */
  body: string;
  parts: MimePart[];
  filename: string;
  contentId: string;
  /** true when parsing stopped early because a cap was hit (the caller can say so) */
  truncated: boolean;
}

// ---------------------------------------------------------------- headers

/**
 * Parse a raw header block into ordered headers, unfolding continuation lines.
 *
 * A line without a colon ends the header block (that is where the body starts), which is also how a
 * message with no blank line is handled: the first non-header line becomes body text.
 */
export function parseHeaders(raw: string, maxBytes = MAX_HEADER_BYTES): Header[] {
  const text = String(raw ?? '').slice(0, maxBytes);
  const out: Header[] = [];
  let current: Header | null = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (out.length >= MAX_HEADERS) break;
    if (!line) continue;
    if (/^[ \t]/.test(line) && current) {
      // folding: append to the previous value, collapsing the break to a single space
      if (current.value.length < MAX_STR) current.value = `${current.value} ${line.trim()}`.trim();
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) {
      current = null;
      continue;
    }
    const name = line.slice(0, i).trim();
    // a header name is a token: anything else means we are not looking at headers any more
    if (!/^[!-9;-~]+$/.test(name)) {
      current = null;
      continue;
    }
    current = { name: clean(name, 128), value: clean(line.slice(i + 1), MAX_STR * 4) };
    out.push(current);
  }
  return out;
}

export function headerGet(headers: Header[], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === want) return h.value;
  return undefined;
}

export function headerAll(headers: Header[], name: string): string[] {
  const want = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === want).map((h) => h.value);
}

/** Split a header's value into its main value and its `;`-separated parameters. */
export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const raw = String(value ?? '');
  const params: Record<string, string> = {};
  let main = raw;
  const firstSemi = raw.indexOf(';');
  if (firstSemi >= 0) {
    main = raw.slice(0, firstSemi);
    const rest = raw.slice(firstSemi + 1);
    // parameters can contain quoted strings with semicolons inside them
    const re = /;\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(`;${rest}`)) && guard++ < 50) {
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      params[m[1].toLowerCase()] = clean(v, 512);
    }
  }
  return { value: clean(main, 256).toLowerCase(), params };
}

/**
 * RFC 2231 parameter values: `name*=charset'lang'%XX..` (one encoded value) and continuations
 * `name*0*=utf-8''%E2%82%AC` `name*1*=%20rates` / `name*0="plain" name*1="text"`. Segments are
 * joined in index order (as BYTES: a UTF-8 sequence may be split across two segments), percent-decoded
 * where marked, and decoded in the first segment's charset. The assembled value REPLACES a plain
 * `name=` of the same base name (RFC 2231 section 4: the extended form wins). Keys are lower-case on
 * input and output; other parameters pass through unchanged. Bounded: 64 segments per name.
 */
export function assembleParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const segs = new Map<string, Array<{ idx: number; enc: boolean; v: string }>>();
  for (const [k0, v] of Object.entries(params ?? {})) {
    const k = k0.toLowerCase();
    const m = /^([^*]+)\*(?:(\d{1,3})(\*)?)?$/.exec(k);
    if (!m) {
      if (!(k in out)) out[k] = v;
      continue;
    }
    const list = segs.get(m[1]) ?? [];
    if (list.length < 64) list.push({ idx: m[2] === undefined ? 0 : Number(m[2]), enc: m[2] === undefined || m[3] === '*', v: String(v ?? '') });
    segs.set(m[1], list);
  }
  for (const [name, list] of segs) {
    list.sort((a, b) => a.idx - b.idx);
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    list.forEach((seg, i) => {
      let v = seg.v;
      if (seg.enc && i === 0) {
        // charset'language'value — only the first segment carries the prefix
        const a = v.indexOf("'");
        const b = a >= 0 ? v.indexOf("'", a + 1) : -1;
        if (a >= 0 && b > a) {
          charset = v.slice(0, a) || 'utf-8';
          v = v.slice(b + 1);
        }
      }
      bytes.push(seg.enc ? percentBytes(v) : Buffer.from(v, 'utf8'));
    });
    out[name] = clean(bytesToString(Buffer.concat(bytes), charset), 1024);
  }
  return out;
}

function percentBytes(v: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < v.length && out.length < 4096; i++) {
    if (v[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(v.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(...Buffer.from(v[i], 'utf8'));
    }
  }
  return Buffer.from(out);
}

/** The file name a part declares: Content-Disposition `filename` (RFC 2231-assembled), else Content-Type `name`, RFC 2047-decoded. */
export function partFilename(dispositionParams: Record<string, string>, typeParams: Record<string, string>): string {
  const raw = assembleParams(dispositionParams).filename || assembleParams(typeParams).name || '';
  // RFC 2047 inside a quoted parameter is not standard, and it is what Outlook and Gmail send
  return raw.includes('=?') ? decodeWords(raw, MAX_FILENAME) : clean(raw, MAX_FILENAME);
}

// ---------------------------------------------------------------- encoded words and transfer encodings

const B64_RE = /^[A-Za-z0-9+/\s]*={0,2}$/;

/**
 * RFC 2047 encoded words: `=?charset?B|Q?text?=`.
 *
 * Two details that matter and are easy to get wrong: whitespace BETWEEN two encoded words is not
 * part of the value (it is a folding artifact), and a `?` inside the encoded text must be ignored —
 * hence the lazy, anchored match rather than a split on '?'.
 */
export function decodeWords(input: string, max = MAX_STR): string {
  const s = String(input ?? '');
  const re = /=\?([^?\s]{1,40})\?([BbQq])\?([^?]{0,4096})\?=/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  let prevWasWord = false;
  while ((m = re.exec(s))) {
    const between = s.slice(last, m.index);
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    out += decodeWordBody(m[1], m[2].toUpperCase(), m[3]);
    last = m.index + m[0].length;
    prevWasWord = true;
    if (out.length > max * 2) break;
  }
  out += s.slice(last);
  return clean(out, max);
}

function decodeWordBody(charset: string, enc: string, text: string): string {
  try {
    if (enc === 'B') {
      const bin = Buffer.from(text.replace(/\s+/g, ''), 'base64');
      return bytesToString(bin, charset);
    }
    // Q: like quoted-printable but '_' is a space
    return decodeQuotedPrintable(text.replace(/_/g, ' '), MAX_STR, charset);
  } catch {
    return text;
  }
}

/** Bytes to text for the charsets that actually occur, with a documented fallback. */
export function bytesToString(buf: Buffer, charset = 'utf-8'): string {
  const cs = String(charset || 'utf-8').toLowerCase();
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252' || cs === 'us-ascii' || cs === 'ascii') {
    return buf.toString('latin1');
  }
  // utf-8 (and everything else) is decoded as utf-8 and checked: iconv would be a native dependency,
  // and a wrong-but-legible string beats refusing to show the message. The replacement character is
  // the signal, and the caller can surface it.
  return buf.toString('utf8');
}

/** Quoted-printable: `=XX` hex, soft line breaks (`=` at end of line), everything else literal. */
export function decodeQuotedPrintable(input: string, max = MAX_BODY_TEXT, charset = 'utf-8'): string {
  const s = String(input ?? '').slice(0, max * 4);
  const bytes: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '=') {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
      // soft break: '=' followed by CRLF (or LF) is removed entirely
      if (/^\r?\n/.test(s.slice(i + 1, i + 3))) {
        i += s[i + 1] === '\r' ? 3 : 2;
        continue;
      }
      bytes.push(0x3d); // a lone '=' is a lone '='
      i += 1;
      continue;
    }
    const cp = s.codePointAt(i)!;
    if (cp < 128) bytes.push(cp);
    else bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'));
    i += cp > 0xffff ? 2 : 1;
    if (bytes.length > max * 4) break;
  }
  return cleanBody(bytesToString(Buffer.from(bytes), charset), max);
}

/** Base64 body text. Non-base64 input yields the input unchanged rather than a decode error. */
export function decodeBase64Text(input: string, max = MAX_BODY_TEXT, charset = 'utf-8'): string {
  const s = String(input ?? '').replace(/[\r\n]/g, '');
  if (!B64_RE.test(s)) return cleanBody(input, max);
  try {
    const buf = Buffer.from(s, 'base64');
    return cleanBody(bytesToString(buf, charset), max);
  } catch {
    return '';
  }
}

export function decodeBody(encoding: string, raw: string, charset = 'utf-8', max = MAX_BODY_TEXT): string {
  switch (String(encoding || '7bit').toLowerCase()) {
    case 'base64':
      return decodeBase64Text(raw, max, charset);
    case 'quoted-printable':
      return decodeQuotedPrintable(raw, max, charset);
    default:
      // 7bit / 8bit / binary / anything unknown: the bytes are handed back as text
      return cleanBody(raw, max);
  }
}

// ---------------------------------------------------------------- addresses

export interface MailAddress {
  name: string;
  address: string;
}

/**
 * Parse an address list. Handles `Display <a@b>`, bare addresses, quoted display names containing
 * commas, RFC 2047 encoded display names, and group syntax (`Team: a@b, c@d;` — the group name is
 * dropped, the members are kept). Never throws and never returns more than `max` addresses.
 */
export function parseAddresses(value: string, max = MAX_ADDRESSES): MailAddress[] {
  const out: MailAddress[] = [];
  for (const chunk of splitTopLevel(String(value ?? ''), ',')) {
    if (out.length >= max) break;
    let s = chunk.trim();
    if (!s) continue;
    // group syntax: "Name: a@b, c@d;" — take everything after the colon
    const colon = topLevelIndexOf(s, ':');
    if (colon > 0 && !s.includes('@', 0) === false && colon < s.indexOf('@')) {
      // a colon before the first '@' is a group marker
      s = s.slice(colon + 1).replace(/;\s*$/, '').trim();
      if (!s) continue;
      for (const inner of splitTopLevel(s, ',')) {
        if (out.length >= max) break;
        const a = parseOneAddress(inner);
        if (a) out.push(a);
      }
      continue;
    }
    s = s.replace(/;\s*$/, '').trim();
    const a = parseOneAddress(s);
    if (a) out.push(a);
  }
  return out;
}

function parseOneAddress(s: string): MailAddress | null {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  // strip comments, which can contain anything at all
  const noComment = raw.replace(/\([^()]*\)/g, ' ').trim();
  const lt = noComment.lastIndexOf('<');
  const gt = noComment.indexOf('>', lt);
  if (lt >= 0 && gt > lt) {
    const addr = cleanAddress(noComment.slice(lt + 1, gt));
    // trim FIRST: a display name of `"Lovelace, Ada" ` ends with a space, and `/^"|"$/` would then
    // leave the closing quote in place (this exact bug shipped for one test run)
    const display = noComment.slice(0, lt).trim();
    const name = decodeWords(/^"[\s\S]*"$/.test(display) ? display.slice(1, -1) : display, 200);
    if (!addr) return name ? { name, address: '' } : null;
    return { name, address: addr };
  }
  const addr = cleanAddress(noComment);
  if (!addr) return null;
  return { name: '', address: addr };
}

function cleanAddress(s: string): string {
  const v = String(s ?? '')
    .replace(/[\s]+/g, '')
    .replace(/^<|>$/g, '');
  if (!v) return '';
  // an address is a token soup: refuse anything with characters that could confuse a header writer
  if (!/^[^<>,;:"()\[\]\\\s@]+@[^<>,;:"()\[\]\\\s@]+$/.test(v)) return '';
  return v.slice(0, 320).toLowerCase();
}

/** `a@b, "x,y" <c@d>` -> ['a@b', '"x,y" <c@d>'] — commas inside quotes/brackets do not split. */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && inQuote) {
      cur += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && (c === '<' || c === '(' || c === '[')) depth++;
    else if (!inQuote && (c === '>' || c === ')' || c === ']')) depth = Math.max(0, depth - 1);
    if (!inQuote && depth === 0 && c === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function topLevelIndexOf(s: string, ch: string): number {
  const parts = splitTopLevel(s, ch);
  return parts.length > 1 ? parts[0].length : -1;
}

// ---------------------------------------------------------------- MIME tree

/**
 * Parse a MIME message into a capped tree. A container (multipart/*) has `parts`; a leaf has `body`.
 *
 * Caps: depth, part count, header size and body size. When a cap is hit the part is marked
 * `truncated` instead of throwing, so a hostile message renders as a partial message rather than an
 * error dialog — and the caller can tell the user it was clipped.
 */
export function parseMime(raw: string | Buffer, depth = 0): MimePart {
  // BYTES (what the IMAP layer delivers): the structure (boundaries, header names, blank lines) is
  // ASCII, so it is parsed on a byte-preserving latin1 view, and only the leaves are decoded — headers
  // as UTF-8 (RFC 6532), bodies per their declared charset
  if (Buffer.isBuffer(raw)) return parseMimeText(raw.subarray(0, MAX_BODY_INPUT).toString('latin1'), depth, true);
  return parseMimeText(raw, depth, false);
}

/** latin1-view bytes -> header text: UTF-8 when it is valid UTF-8, else the bytes as latin1 */
function headerText(bin: string): string {
  const utf8 = Buffer.from(bin, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? bin : utf8;
}

function parseMimeText(raw: string, depth: number, binary: boolean): MimePart {
  const empty: MimePart = { headers: [], contentType: 'text/plain', params: {}, encoding: '7bit', body: '', parts: [], filename: '', contentId: '', truncated: false };
  if (depth > MAX_DEPTH) return { ...empty, truncated: true };
  const text = String(raw ?? '').slice(0, MAX_BODY_INPUT);

  // headers end at the first empty line
  const sepMatch = /\r\n\r\n|\n\n|\r\r/.exec(text);
  const headRaw = sepMatch ? text.slice(0, sepMatch.index) : text;
  const bodyRaw = sepMatch ? text.slice(sepMatch.index + sepMatch[0].length) : '';
  const headers = parseHeaders(binary ? headerText(headRaw) : headRaw);

  const ct = parseParams(headerGet(headers, 'content-type') ?? 'text/plain');
  const contentType = ct.value || 'text/plain';
  const params = ct.params;
  const encRaw = (headerGet(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase().trim();
  const encoding = /^(7bit|8bit|binary|quoted-printable|base64)$/.test(encRaw) ? encRaw : '7bit';
  const disp = parseParams(headerGet(headers, 'content-disposition') ?? '');
  const filename = partFilename(disp.params, params);

  const part: MimePart = {
    headers,
    contentType,
    params,
    encoding,
    body: '',
    parts: [],
    filename,
    contentId: clean((headerGet(headers, 'content-id') ?? '').replace(/^<|>$/g, ''), 256),
    truncated: text.length >= MAX_BODY_INPUT,
  };

  if (contentType.startsWith('multipart/') && params.boundary && depth < MAX_DEPTH) {
    const chunks = splitMultipart(bodyRaw, params.boundary);
    for (const c of chunks) {
      if (part.parts.length >= MAX_PARTS) {
        part.truncated = true;
        break;
      }
      part.parts.push(parseMimeText(c, depth + 1, binary));
    }
    return part;
  }

  if (contentType === 'message/rfc822') {
    // a nested message is parsed as ONE child, so its headers are not mistaken for ours
    part.parts.push(parseMimeText(bodyRaw, depth + 1, binary));
    return part;
  }

  const charset = params.charset ?? 'utf-8';
  // an HTML part is kept for the HTML reading view, so it gets the larger HTML ceiling
  const max = contentType === 'text/html' ? MAX_BODY_HTML : MAX_BODY_TEXT;
  if (!binary) part.body = decodeBody(encoding, bodyRaw, charset, max);
  else if (encoding === 'base64') part.body = decodeBody(encoding, bodyRaw, charset, max);
  // quoted-printable should be ASCII; stray 8-bit bytes in it are read as UTF-8 before the =XX pass
  else if (encoding === 'quoted-printable') part.body = decodeBody(encoding, Buffer.from(bodyRaw, 'latin1').toString('utf8'), charset, max);
  // 7bit / 8bit / binary: the bytes ARE the text, in the part's charset
  else part.body = cleanBody(bytesToString(Buffer.from(bodyRaw, 'latin1'), charset), max);
  return part;
}

/** Split a multipart body on its boundary, dropping the preamble and the epilogue. */
export function splitMultipart(body: string, boundary: string): string[] {
  const b = String(boundary ?? '').slice(0, 200);
  if (!b) return [];
  const parts: string[] = [];
  // boundaries are lines; the closing one has two trailing dashes
  const lines = body.split(/\r\n|\n|\r/);
  let cur: string[] | null = null;
  let count = 0;
  for (const line of lines) {
    if (line === `--${b}` || line === `--${b}--`) {
      if (cur) parts.push(cur.join('\r\n'));
      cur = line.endsWith('--') ? null : [];
      count++;
      // a message claiming 10 000 parts stops here rather than allocating them
      if (count > MAX_PARTS * 4) break;
      continue;
    }
    if (cur) cur.push(line);
  }
  return parts;
}

export interface ExtractedContent {
  text: string;
  html: string;
  attachments: Array<{ partId: string; filename: string; mime: string; size: number }>;
  /** the message referenced remote resources; nothing was fetched to find out */
  remoteContent: boolean;
  truncated: boolean;
  /** true when a text part was decoded into replacement characters (an unknown charset) */
  charsetLossy: boolean;
}

/**
 * Reduce a MIME tree to what the store keeps: the best plain text, the chosen HTML body (the
 * text/html part(s); else a text/plain part that is plainly HTML source — see `pickHtml`), and
 * attachment METADATA. The bytes of an attachment are never part of the result. A text/plain part
 * that is HTML source is converted to text here, so the stored text, preview and index carry no tags.
 */
export function extractContent(root: MimePart): ExtractedContent {
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: ExtractedContent['attachments'] = [];
  let truncated = false;
  let charsetLossy = false;
  let n = 0;

  const walk = (p: MimePart, partId: string) => {
    if (n++ > MAX_PARTS * 2) {
      truncated = true;
      return;
    }
    if (p.truncated) truncated = true;
    const ct = p.contentType.toLowerCase();
    // IMAP section numbers: a multipart's children are 1, 2, ... under its own number (the root has
    // none); a single-part root is "1". An attached message is ONE attachment (its text is not shown
    // as this message's text), exactly as the BODYSTRUCTURE path lists it.
    if (ct === 'message/rfc822' || ct === 'message/global') {
      attachments.push({ partId: partId || '1', filename: p.filename || 'message.eml', mime: clean(ct, 128), size: 0 });
      return;
    }
    if (p.parts.length) {
      p.parts.forEach((child, i) => walk(child, `${partId}${partId ? '.' : ''}${i + 1}`));
      return;
    }
    const isAttachment =
      /^attachment$/i.test(String(p.headers.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? '').split(';')[0]) ||
      (!!p.filename && !ct.startsWith('text/'));
    if (isAttachment || ct.startsWith('image/') || ct.startsWith('application/') || ct.startsWith('audio/') || ct.startsWith('video/')) {
      attachments.push({ partId: partId || '1', filename: p.filename || 'attachment', mime: clean(ct, 128), size: Buffer.byteLength(p.body, 'utf8') });
      return;
    }
    if (ct === 'text/plain') {
      texts.push(p.body);
      if (p.body.includes('\uFFFD')) charsetLossy = true;
      return;
    }
    if (ct === 'text/html') {
      htmls.push(p.body);
      if (p.body.includes('\uFFFD')) charsetLossy = true;
      return;
    }
    // anything else with a filename is still an attachment; anything else without one is dropped
    if (p.filename) attachments.push({ partId: partId || '1', filename: p.filename, mime: clean(ct, 128), size: Buffer.byteLength(p.body, 'utf8') });
  };
  walk(root, '');

  let text = cleanBody(texts.join('\n\n'), MAX_BODY_TEXT);
  const html = pickHtml(htmls.join('\n'), text);
  if (looksLikeHtml(text)) text = htmlToText(text).text;
  return {
    text,
    html,
    attachments: attachments.slice(0, 200),
    remoteContent: /<\s*(img|picture|source|video|audio|iframe|object|embed|link|script|style|form)\b/i.test(html),
    truncated,
    charsetLossy,
  };
}

/** Best-effort subject / from / to for the list view, from a raw header block. */
export function summaryFromHeaders(headers: Header[]): {
  subject: string;
  fromName: string;
  fromAddr: string;
  toAddrs: string;
  ccAddrs: string;
  messageId: string;
  replyTo: string;
  date: number | null;
} {
  const subject = decodeWords(headerGet(headers, 'subject') ?? '', 400);
  const from = parseAddresses(headerGet(headers, 'from') ?? '', 4);
  const to = parseAddresses(headerGet(headers, 'to') ?? '', MAX_ADDRESSES);
  const cc = parseAddresses(headerGet(headers, 'cc') ?? '', MAX_ADDRESSES);
  const replyTo = parseAddresses(headerGet(headers, 'reply-to') ?? '', 4);
  return {
    subject,
    fromName: from[0]?.name ?? '',
    fromAddr: from[0]?.address ?? '',
    toAddrs: to.map((a) => a.address || a.name).join(', ').slice(0, 2000),
    ccAddrs: cc.map((a) => a.address || a.name).join(', ').slice(0, 2000),
    messageId: clean((headerGet(headers, 'message-id') ?? '').replace(/^<|>$/g, ''), 998),
    replyTo: replyTo[0]?.address ?? '',
    date: parseDate(headerGet(headers, 'date') ?? ''),
  };
}

/** RFC 5322 date to epoch ms; null when it is not a date we can trust. */
export function parseDate(v: string): number | null {
  const s = String(v ?? '').trim().replace(/\([^()]*\)/g, ' ').trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  // a date before the epoch or absurdly far in the future is not usable as a sort key
  if (t < 0 || t > Date.now() + 366 * 86_400_000) return null;
  return t;
}

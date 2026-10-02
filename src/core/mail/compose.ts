// Message building (ticket 38) — pure, so every header rule is unit-tested without a socket.
//
// What this module is careful about, because a composed message is a byte stream a server parses:
//  * HEADER INJECTION. A CR or LF in an address, a display name or the subject would let a field
//    start a new header (a hidden Bcc, a forged From). Such input is REFUSED with a message naming
//    the field — never stripped silently, because "the subject you typed is not the subject sent"
//    is its own bug.
//  * ADDRESSES are parsed by a strict, linear, hand-written scanner (no backtracking regex over the
//    whole list). An address that is not a plain ASCII `local@domain.tld` is refused with a reason;
//    SMTPUTF8 is not offered in v1.
//  * BCC is ENVELOPE ONLY: it decides who the server delivers to and never appears in a header.
//  * The output is 7-bit ASCII: non-ASCII subjects and names are RFC 2047 encoded-words, the body is
//    quoted-printable UTF-8. Every size is a BYTE count (Buffer.byteLength), never a JS length.
//
// Why quoted-printable and not format=flowed: QP guarantees short lines and a 7-bit body whatever the
// user types (a 2 000-character line, a pasted emoji), so the message survives any relay without
// 8BITMIME. format=flowed only reflows line breaks; it would still need a transfer encoding for
// non-ASCII text, and it changes how trailing spaces are read. QP is the boring, universally decoded
// choice for plain text.

import { randomBytes } from 'node:crypto';
import { MAX_COMPOSE_ATTACHMENT_BYTES, MAX_COMPOSE_ATTACHMENTS, mimeForFilename, sanitizeFilename } from './attachments';

/**
 * a whole message may not exceed this many bytes. The files a user attaches are capped at 25 MB
 * (MAX_COMPOSE_ATTACHMENT_BYTES, the common provider limit); base64 makes them a third larger on the
 * wire, so the encoded message gets that headroom. The server's own SIZE is checked by smtp.ts.
 */
export const MAX_MESSAGE_BYTES = 36 * 1024 * 1024;
/** distinct envelope recipients per message */
export const MAX_RECIPIENTS = 100;
/** the raw text of one address field */
export const MAX_ADDRESS_FIELD = 8_000;
export const MAX_SUBJECT_CHARS = 900;
/** the body text the user typed (a 25 MB message is reached long before this in QP) */
export const MAX_BODY_CHARS = 10 * 1024 * 1024;
/** References: the first id plus the most recent ones (RFC 5322 3.6.4 allows trimming) */
export const MAX_REFERENCES = 20;

export interface Address {
  name: string;
  address: string;
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------- field hygiene

const CRLF_RE = /[\r\n]/;
// C0 controls other than tab, and DEL: never legal in a header value
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Refuse (never strip) a line break or a control character in a single-line field. */
export function checkHeaderField(value: string, field: string): string | null {
  if (CRLF_RE.test(value)) return `${field}: line breaks are not allowed (refusing rather than removing them)`;
  if (CONTROL_RE.test(value)) return `${field}: control characters are not allowed`;
  return null;
}

// ---------------------------------------------------------------- addresses

const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * `local@domain.tld`, ASCII only. Linear: every check walks the string once (the label regex is
 * applied to one dot-separated label at a time and has no nested quantifier).
 */
export function validateAddress(addr: string): string | null {
  const a = String(addr ?? '');
  if (!a) return 'an empty address';
  if (a.length > 254) return `"${a.slice(0, 40)}…" is longer than an address may be`;
  if (/[^\x21-\x7e]/.test(a)) {
    return /[^\x00-\x7f]/.test(a) ? `"${a}" contains non-ASCII characters (international addresses are not supported yet)` : `"${a}" contains spaces or control characters`;
  }
  const at = a.indexOf('@');
  if (at <= 0 || at !== a.lastIndexOf('@')) return `"${a}" is not an address (it needs exactly one @ with a name before it)`;
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (local.length > 64) return `"${a}": the part before @ is too long`;
  // dot-atom: atext runs separated by single dots, no leading/trailing dot
  let prevDot = true;
  for (const ch of local) {
    if (ch === '.') {
      if (prevDot) return `"${a}": misplaced dot before @`;
      prevDot = true;
    } else if (ATEXT.test(ch)) prevDot = false;
    else return `"${a}": the character "${ch}" is not allowed before @`;
  }
  if (prevDot) return `"${a}": misplaced dot before @`;
  const labels = domain.split('.');
  if (labels.length < 2) return `"${a}": the domain needs a dot (e.g. example.com)`;
  for (const l of labels) if (!LABEL.test(l)) return `"${a}": "${domain}" is not a valid domain`;
  if (/^\d+$/.test(labels[labels.length - 1])) return `"${a}": "${domain}" is not a valid domain`;
  return null;
}

/**
 * Parse `Name <a@b.example>, "Last, First" <c@d.example>, e@f.example`.
 *
 * A strict, linear scanner: one pass over the characters, tracking only "inside a quoted string" and
 * "inside angle brackets". Items are separated by `,` or `;` at top level. Each item is a bare
 * address, or a display name (plain words or ONE quoted string) followed by `<address>` and nothing
 * else. Anything outside that shape is refused with a message that quotes the item.
 */
export function parseAddressList(input: string, field: string, max = MAX_RECIPIENTS): Result<{ list: Address[] }> {
  const s = String(input ?? '');
  const bad = checkHeaderField(s, field);
  if (bad) return { ok: false, error: bad };
  if (s.length > MAX_ADDRESS_FIELD) return { ok: false, error: `${field}: too long` };
  const items: string[] = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === '<') {
      if (inAngle) return { ok: false, error: `${field}: a "<" inside an address` };
      inAngle = true;
    } else if (ch === '>') {
      if (!inAngle) return { ok: false, error: `${field}: a ">" with no matching "<"` };
      inAngle = false;
    } else if ((ch === ',' || ch === ';') && !inAngle) {
      items.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (inQuote) return { ok: false, error: `${field}: an unterminated quoted name` };
  if (inAngle) return { ok: false, error: `${field}: an unterminated "<"` };
  items.push(cur);

  const list: Address[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const parsed = parseOne(item);
    if ('error' in parsed) return { ok: false, error: `${field}: ${parsed.error}` };
    if (list.length >= max) return { ok: false, error: `${field}: more than ${max} recipients` };
    list.push(parsed);
  }
  return { ok: true, list };
}

function parseOne(item: string): Address | { error: string } {
  // the first "<" OUTSIDE a quoted name: a name like "a <b> c" is quoted, and its brackets are text
  let lt = -1;
  let q = false;
  for (let i = 0; i < item.length; i++) {
    const ch = item[i];
    if (q && ch === '\\') i++;
    else if (ch === '"') q = !q;
    else if (ch === '<' && !q) {
      lt = i;
      break;
    }
  }
  if (lt < 0) {
    if (/["\s<>]/.test(item)) return { error: `"${item.slice(0, 60)}" is not an address (put a name before <address>)` };
    const err = validateAddress(item);
    return err ? { error: err } : { name: '', address: item };
  }
  const gt = item.indexOf('>', lt);
  if (gt < 0 || item.slice(gt + 1).trim()) return { error: `"${item.slice(0, 60)}": nothing may follow the >` };
  const address = item.slice(lt + 1, gt).trim();
  const err = validateAddress(address);
  if (err) return { error: err };
  let name = item.slice(0, lt).trim();
  if (name.startsWith('"')) {
    // exactly one quoted string, closed at the end of the name part
    if (name.length < 2 || !name.endsWith('"')) return { error: `"${item.slice(0, 60)}": a quoted name must be the whole name` };
    const inner = name.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) out += inner[++i];
      else if (ch === '"') return { error: `"${item.slice(0, 60)}": a quoted name must be the whole name` };
      else out += ch;
    }
    name = out;
  } else if (name.includes('"')) {
    return { error: `"${item.slice(0, 60)}": a quoted name must be the whole name` };
  }
  return { name: name.replace(/\s+/g, ' '), address };
}

/** Format for an input field (`Name <a@b>`), the inverse of `parseAddressList`. */
export function formatAddressForInput(a: Address): string {
  if (!a.name) return a.address;
  return /^[\p{L}\p{N} .'-]+$/u.test(a.name) ? `${a.name} <${a.address}>` : `"${a.name.replace(/[\\"]/g, (c) => `\\${c}`)}" <${a.address}>`;
}

// ---------------------------------------------------------------- RFC 2047 / headers

const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);
/** bytes of UTF-8 per encoded-word: 39 bytes -> 52 base64 chars -> a 64-char word, so even
 *  `Subject: ` + the first word stays inside the 78-char line recommendation */
const WORD_BYTES = 39;

/** Split text into RFC 2047 B-encoded words, never cutting a UTF-8 sequence in half. */
export function encodedWords(text: string): string[] {
  const out: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const cp of text) {
    const n = Buffer.byteLength(cp, 'utf8');
    if (bytes + n > WORD_BYTES && chunk.length) {
      out.push(chunk.join(''));
      chunk = [];
      bytes = 0;
    }
    chunk.push(cp);
    bytes += n;
  }
  if (chunk.length) out.push(chunk.join(''));
  return out.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`);
}

/** Fold `Name: v1 v2 …` at whitespace so no line exceeds 78 characters where that is possible. */
function foldTokens(name: string, tokens: string[], sep = ' '): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] + (i < tokens.length - 1 ? sep.trimEnd() : '');
    if (line.length + 1 + t.length > 78 && line !== `${name}:`) {
      lines.push(line);
      line = ` ${t}`;
    } else {
      line += ` ${t}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

/** The Subject header: ASCII folded at spaces; anything else as encoded-words, one per line. */
export function subjectHeader(subject: string): string {
  const s = subject.trim();
  if (!s) return 'Subject: ';
  if (isPrintableAscii(s) && !/=\?/.test(s)) return foldTokens('Subject', s.split(/ +/));
  return foldTokens('Subject', encodedWords(s));
}

/** One address as it appears in a header: atext names bare, other ASCII quoted, else encoded. */
export function headerAddress(a: Address): string {
  if (!a.name) return a.address;
  if (isPrintableAscii(a.name)) {
    if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(a.name)) return `${a.name} <${a.address}>`;
    return `"${a.name.replace(/[\\"]/g, (c) => `\\${c}`)}" <${a.address}>`;
  }
  return `${encodedWords(a.name).join(' ')} <${a.address}>`;
}

function addressHeader(name: string, list: Address[]): string {
  return foldTokens(name, list.map(headerAddress), ', ');
}

/** RFC 5322 date-time in the local zone: `Thu, 02 Oct 2026 14:03:05 +0200`. */
export function formatDate(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${days[d.getDay()]}, ${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/** `<id@host>` when the value is a usable msg-id, else null (never a value that could break a header). */
export function normalizeMessageId(v: string): string | null {
  const s = String(v ?? '').trim().replace(/^<|>$/g, '');
  if (!s || s.length > 900) return null;
  if (!/^[\x21-\x7e]+$/.test(s) || /[<>]/.test(s) || !s.includes('@')) return null;
  return `<${s}>`;
}

/** A fresh random Message-ID at the sender's domain. */
export function makeMessageId(fromAddress: string, random: () => string = () => randomBytes(18).toString('base64url')): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1).toLowerCase();
  return `<${Date.now().toString(36)}.${random().replace(/[^A-Za-z0-9_-]/g, '')}@${domain}>`;
}

// ---------------------------------------------------------------- body

/** Quoted-printable over the UTF-8 BYTES, CRLF line ends, lines of at most 76 characters. */
export function encodeQuotedPrintable(text: string): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let tok: string;
      // trailing whitespace is encoded, or a relay may strip it
      if ((b === 0x20 || b === 0x09) && last) tok = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      else if (b === 0x3d || b > 0x7e || (b < 0x20 && b !== 0x09)) tok = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      else tok = String.fromCharCode(b);
      if (cur.length + tok.length > 75) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n');
}

// ---------------------------------------------------------------- replies and forwards

/** `Re: ` once: an existing Re:/RE:/Aw:/Sv: prefix is kept, never stacked. */
export function replySubject(subject: string): string {
  const s = String(subject ?? '').trim();
  return /^(re|aw|sv)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** `Fwd: ` once: an existing Fwd:/Fw: prefix is kept. */
export function forwardSubject(subject: string): string {
  const s = String(subject ?? '').trim();
  return /^(fwd?|fw)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

/** `On <date>, <from> wrote:` then every line of the original prefixed with `> `. */
export function quoteOriginal(text: string, meta: { date: string; from: string }): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return `On ${meta.date}, ${meta.from} wrote:\n${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}`;
}

export function forwardBlock(text: string, meta: { date: string; from: string; to: string; subject: string }): string {
  return ['---------- Forwarded message ----------', `From: ${meta.from}`, `Date: ${meta.date}`, `Subject: ${meta.subject}`, `To: ${meta.to}`, '', String(text ?? '').replace(/\r\n?/g, '\n')].join('\n');
}

/** The new message's References: the parent's chain plus the parent, deduplicated and trimmed. */
export function buildReferences(parentReferences: string, parentId: string): string[] {
  const ids: string[] = [];
  for (const tok of String(parentReferences ?? '').split(/[\s,]+/)) {
    const id = normalizeMessageId(tok);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const p = normalizeMessageId(parentId);
  if (p && !ids.includes(p)) ids.push(p);
  if (ids.length <= MAX_REFERENCES) return ids;
  return [ids[0], ...ids.slice(ids.length - (MAX_REFERENCES - 1))];
}

/**
 * Who a reply goes to. Reply: Reply-To, else From. Reply all: that, plus the original To and Cc,
 * minus the user's own address and duplicates.
 */
export function replyRecipients(
  orig: { fromName: string; fromAddr: string; replyTo: string; toAddrs: string; ccAddrs: string },
  own: string,
  all: boolean,
): { to: Address[]; cc: Address[] } {
  const me = own.toLowerCase();
  const primary: Address = orig.replyTo ? { name: '', address: orig.replyTo } : { name: orig.fromName, address: orig.fromAddr };
  const to = primary.address && validateAddress(primary.address) === null ? [primary] : [];
  if (!all) return { to, cc: [] };
  const seen = new Set([me, ...to.map((a) => a.address.toLowerCase())]);
  const cc: Address[] = [];
  for (const raw of `${orig.toAddrs},${orig.ccAddrs}`.split(',')) {
    const a = raw.trim();
    if (!a || validateAddress(a) !== null || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    cc.push({ name: '', address: a });
  }
  return { to, cc };
}

// ---------------------------------------------------------------- the message

export interface ComposeInput {
  from: Address;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  /** files to attach: BYTES, with the name they are sent under (sanitized again here) */
  attachments?: OutgoingAttachment[];
  /** test seam for the Message-ID's random part (and the multipart boundary) */
  random?: () => string;
}

export interface OutgoingAttachment {
  filename: string;
  /** the type to declare; from the extension when absent */
  mime?: string;
  data: Buffer;
}

// ---------------------------------------------------------------- attachments (ticket 41)

/** Base64 of the BYTES in 76-character lines (RFC 2045 6.8), CRLF-separated. */
export function base64Lines(data: Buffer): string {
  const b64 = data.toString('base64');
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

/** An ASCII stand-in for a non-ASCII name, for clients that ignore RFC 2231. Never empty, never a quote. */
export function asciiFallbackName(name: string): string {
  const d = name.lastIndexOf('.');
  const ext = d > 0 ? name.slice(d).replace(/[^\x21-\x7e]/g, '') : '';
  const stem = (d > 0 ? name.slice(0, d) : name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();
  return `${stem || 'attachment'}${ext.replace(/["\\]/g, '_')}`.slice(0, 120);
}

/** RFC 2231 percent-encoding of the UTF-8 bytes (attribute-char only; everything else is %XX). */
function pct2231(name: string): string {
  let out = '';
  for (const b of Buffer.from(name, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9!#$&+.^_`|~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The parameter lines for a file name: `name="..."` / `filename="..."` with an ASCII fallback, plus,
 * for a non-ASCII name, RFC 2231 `filename*` — split into numbered continuations (`filename*0*=`,
 * `filename*1*=`) so no header line approaches the 998-character limit. Each returned string is one
 * folded line's content (the caller joins them with `;\r\n `).
 */
export function filenameParams(name: string, param: 'filename' | 'name'): string[] {
  const plain = /^[\x20-\x7e]+$/.test(name) && !/["\\]/.test(name);
  if (plain) return [`${param}="${name}"`];
  const out = [`${param}="${asciiFallbackName(name)}"`];
  if (param === 'name') return out; // the extended form goes on Content-Disposition only
  const enc = `utf-8''${pct2231(name)}`;
  if (enc.length <= 60) return [...out, `${param}*=${enc}`];
  // continuations: never split a %XX triplet
  const segs: string[] = [];
  let cur = '';
  for (let i = 0; i < enc.length; ) {
    const tok = enc[i] === '%' ? enc.slice(i, i + 3) : enc[i];
    if (cur.length + tok.length > 60) {
      segs.push(cur);
      cur = '';
    }
    cur += tok;
    i += tok.length;
  }
  if (cur) segs.push(cur);
  return [...out, ...segs.map((seg, i) => `${param}*${i}*=${seg}`)];
}

/** One attachment as a MIME body part (headers + base64 body), CRLF line ends. */
export function attachmentPart(a: OutgoingAttachment): string {
  const name = sanitizeFilename(a.filename);
  const mime = a.mime && /^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,80}$/i.test(a.mime) ? a.mime.toLowerCase() : mimeForFilename(name);
  const ct = [mime, ...filenameParams(name, 'name')].join(';\r\n ');
  const cd = ['attachment', ...filenameParams(name, 'filename')].join(';\r\n ');
  return `Content-Type: ${ct}\r\nContent-Disposition: ${cd}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(a.data)}`;
}

export interface BuiltMessage {
  raw: string;
  /** the message size in BYTES (it is ASCII, but the count is taken from the bytes anyway) */
  bytes: number;
  messageId: string;
  envelope: { from: string; to: string[] };
  recipients: { to: Address[]; cc: Address[]; bcc: Address[] };
}

export function buildMessage(input: ComposeInput): Result<BuiltMessage> {
  const fromErr = checkHeaderField(input.from.name ?? '', 'From name') ?? validateAddress(input.from.address);
  if (fromErr) return { ok: false, error: `the sending account's address cannot be used: ${fromErr}` };
  const to = parseAddressList(input.to ?? '', 'To');
  if (!to.ok) return to;
  const cc = parseAddressList(input.cc ?? '', 'Cc');
  if (!cc.ok) return cc;
  const bcc = parseAddressList(input.bcc ?? '', 'Bcc');
  if (!bcc.ok) return bcc;
  const subject = String(input.subject ?? '');
  const subjErr = checkHeaderField(subject, 'Subject');
  if (subjErr) return { ok: false, error: subjErr };
  if (subject.length > MAX_SUBJECT_CHARS) return { ok: false, error: 'Subject: too long' };
  const body = String(input.body ?? '');
  if (body.length > MAX_BODY_CHARS) return { ok: false, error: 'the message text is too long' };

  const rcpt: string[] = [];
  const seen = new Set<string>();
  for (const a of [...to.list, ...cc.list, ...bcc.list]) {
    const k = a.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    rcpt.push(a.address);
  }
  if (!rcpt.length) return { ok: false, error: 'add at least one recipient (To, Cc or Bcc)' };
  if (rcpt.length > MAX_RECIPIENTS) return { ok: false, error: `at most ${MAX_RECIPIENTS} recipients per message` };

  const messageId = makeMessageId(input.from.address, input.random);
  const headers: string[] = [
    `Date: ${formatDate(input.date ?? new Date())}`,
    addressHeader('From', [input.from]),
    // a Bcc-only message still has a To header, the standard empty group (RFC 5322 3.6.3)
    to.list.length ? addressHeader('To', to.list) : 'To: undisclosed-recipients:;',
  ];
  if (cc.list.length) headers.push(addressHeader('Cc', cc.list));
  headers.push(subjectHeader(subject), `Message-ID: ${messageId}`);
  const parent = input.inReplyTo ? normalizeMessageId(input.inReplyTo) : null;
  if (parent) headers.push(`In-Reply-To: ${parent}`);
  const refs = (input.references ?? []).map(normalizeMessageId).filter((x): x is string => !!x);
  if (refs.length) headers.push(foldTokens('References', refs));

  const files = input.attachments ?? [];
  if (files.length > MAX_COMPOSE_ATTACHMENTS) return { ok: false, error: `at most ${MAX_COMPOSE_ATTACHMENTS} attachments per message` };
  const fileBytes = files.reduce((n, f) => n + f.data.length, 0);
  if (fileBytes > MAX_COMPOSE_ATTACHMENT_BYTES) {
    return { ok: false, error: `the attachments are ${(fileBytes / 1048576).toFixed(1)} MB together; the limit is ${MAX_COMPOSE_ATTACHMENT_BYTES / 1048576} MB` };
  }
  let raw: string;
  if (!files.length) {
    headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
    raw = `${headers.join('\r\n')}\r\n\r\n${encodeQuotedPrintable(body)}\r\n`;
  } else {
    // multipart/mixed: the text first, then each file. The boundary is random and cannot occur in
    // base64 or quoted-printable output (both lack '=_' followed by this run of characters).
    const boundary = `=_gb_${(input.random ?? (() => randomBytes(18).toString('base64url')))().replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'boundary'}`;
    headers.push('MIME-Version: 1.0', `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`);
    const parts = [
      `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(body)}`,
      ...files.map(attachmentPart),
    ];
    raw = `${headers.join('\r\n')}\r\n\r\nThis is a multi-part message in MIME format.\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_MESSAGE_BYTES) return { ok: false, error: `the message is ${Math.ceil(bytes / 1048576)} MB; the limit is ${MAX_MESSAGE_BYTES / 1048576} MB` };
  return {
    ok: true,
    raw,
    bytes,
    messageId,
    envelope: { from: input.from.address, to: rcpt },
    recipients: { to: to.list, cc: cc.list, bcc: bcc.list },
  };
}

/** The distinct recipient DOMAINS of an envelope (what the audit log records instead of addresses). */
export function recipientDomains(rcpt: string[]): string[] {
  return [...new Set(rcpt.map((r) => r.slice(r.lastIndexOf('@') + 1).toLowerCase()))].sort();
}

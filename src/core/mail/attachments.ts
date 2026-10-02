// Attachments (ticket 41) — pure: BODYSTRUCTURE parsing, transfer decoding as BYTES, file-name
// hygiene, the extension -> type map compose uses, and the image sniffing behind inline cid: images.
// No sockets, no files, no Electron: the network half is `MailSyncer.fetchPart` (gated), the disk half
// is the runtime's download sink.
//
// Where the rules live:
//  * WHAT a part is (section number, type, encoding, declared size, name) comes from the server's
//    BODYSTRUCTURE, parsed here against the RFC 3501 grammar — not from downloading the message. That
//    is what lets a message open without its attachments' bytes ever crossing the network (rule 2:
//    nothing is fetched until the user clicks).
//  * A file name is ATTACKER-CHOSEN. `sanitizeFilename` is applied before a name is shown or used for
//    a path; `fileRisk` (core/downloads.ts, shared with page downloads) says whether it can run code.
//  * Bytes are bytes: `decodeTransfer` never round-trips through a JS string, so a binary file with
//    every byte value survives base64 and quoted-printable unchanged.

import type { ImapValue } from './imap';
import { assembleParams, decodeWords, MAX_FILENAME } from './mime';
import { clean } from './store';

/** an attachment larger than this (decoded) is refused, before anything is fetched when its declared size says so */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** one inline (cid:) image; the HTML view's whole document must fit a 2 MB data: URL */
export const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
/** all inline images of one message together */
export const MAX_INLINE_TOTAL_BYTES = 1024 * 1024;
/** sent attachments, all together (the common provider limit is on the message; this is on the files) */
export const MAX_COMPOSE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_COMPOSE_ATTACHMENTS = 50;
/** a displayed / saved file name, in characters */
export const MAX_SAFE_NAME = 120;
/** parts in one BODYSTRUCTURE and its nesting depth: a hostile server cannot make us walk forever */
export const MAX_STRUCTURE_PARTS = 300;
export const MAX_STRUCTURE_DEPTH = 16;

// ---------------------------------------------------------------- BODYSTRUCTURE

export interface BodyPart {
  /** IMAP section: '1', '2.1', ...; '' for a root multipart (it has no number of its own) */
  section: string;
  /** lower-case, e.g. 'application' / 'pdf'; 'multipart' / 'mixed' for a container */
  type: string;
  subtype: string;
  /** Content-Type parameters, keys lower-case, RFC 2231 assembled */
  params: Record<string, string>;
  /** Content-ID without the angle brackets */
  id: string;
  description: string;
  /** Content-Transfer-Encoding, lower-case ('7bit' when the server said NIL) */
  encoding: string;
  /** body-fld-octets: the ENCODED size in bytes */
  size: number;
  /** 'attachment' / 'inline' / '' */
  disposition: string;
  dispositionParams: Record<string, string>;
  /** the declared file name, decoded (RFC 2231 / RFC 2047) but NOT sanitized */
  filename: string;
  children: BodyPart[];
  /** the body of an attached message/rfc822 (its sections are numbered under this part's) */
  message: BodyPart | null;
}

const nstr = (v: ImapValue | undefined): string => (typeof v === 'string' && v.toUpperCase() !== 'NIL' ? v : '');
const num = (v: ImapValue | undefined): number => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
};

/** body-fld-param: `("name" "value" ...)` or NIL. Keys lower-cased, first value wins, RFC 2231 assembled. */
function paramList(v: ImapValue | undefined): Record<string, string> {
  const raw: Record<string, string> = {};
  if (!Array.isArray(v)) return raw;
  for (let i = 0; i + 1 < v.length && i < 400; i += 2) {
    const k = nstr(v[i]).toLowerCase();
    if (!k || k in raw || k === '__proto__') continue;
    raw[k] = clean(nstr(v[i + 1]), 1024);
  }
  return assembleParams(raw);
}

function parseNode(v: ImapValue | undefined, depth: number, budget: { n: number }): BodyPart | null {
  if (!Array.isArray(v) || !v.length || depth > MAX_STRUCTURE_DEPTH || ++budget.n > MAX_STRUCTURE_PARTS) return null;
  const base: BodyPart = { section: '', type: '', subtype: '', params: {}, id: '', description: '', encoding: '7bit', size: 0, disposition: '', dispositionParams: {}, filename: '', children: [], message: null };
  const dsp = (d: ImapValue | undefined) => {
    // body-fld-dsp = "(" string SP body-fld-param ")" / nil
    if (!Array.isArray(d)) return;
    base.disposition = nstr(d[0]).toLowerCase().slice(0, 40);
    base.dispositionParams = paramList(d[1]);
  };
  if (Array.isArray(v[0])) {
    // body-type-mpart = 1*body SP media-subtype [SP body-ext-mpart]
    let i = 0;
    while (i < v.length && Array.isArray(v[i])) {
      const child = parseNode(v[i], depth + 1, budget);
      if (child) base.children.push(child);
      i++;
    }
    base.type = 'multipart';
    base.subtype = nstr(v[i]).toLowerCase().slice(0, 60) || 'mixed';
    // body-ext-mpart = body-fld-param [SP body-fld-dsp [SP body-fld-lang [SP body-fld-loc ...]]]
    base.params = paramList(v[i + 1]);
    dsp(v[i + 2]);
    return base;
  }
  // body-type-1part: media-type SP body-fields [type-specific] [SP body-ext-1part]
  // body-fields = body-fld-param SP body-fld-id SP body-fld-desc SP body-fld-enc SP body-fld-octets
  base.type = nstr(v[0]).toLowerCase().slice(0, 60);
  base.subtype = nstr(v[1]).toLowerCase().slice(0, 60);
  if (!base.type || !base.subtype) return null;
  base.params = paramList(v[2]);
  base.id = clean(nstr(v[3]).replace(/^\s*<|>\s*$/g, ''), 256);
  base.description = clean(nstr(v[4]), 200);
  base.encoding = nstr(v[5]).toLowerCase().slice(0, 40) || '7bit';
  base.size = num(v[6]);
  let ext = 7;
  if (base.type === 'text') {
    ext = 8; // body-fld-lines
  } else if (base.type === 'message' && (base.subtype === 'rfc822' || base.subtype === 'global')) {
    // body-type-msg = media-message SP body-fields SP envelope SP body SP body-fld-lines
    base.message = parseNode(v[8], depth + 1, budget);
    ext = 10;
  }
  // body-ext-1part = body-fld-md5 [SP body-fld-dsp [SP body-fld-lang [SP body-fld-loc ...]]]
  dsp(v[ext + 1]);
  base.filename = declaredName(base.dispositionParams, base.params);
  return base;
}

function declaredName(dsp: Record<string, string>, ct: Record<string, string>): string {
  const raw = dsp.filename || ct.name || '';
  return raw.includes('=?') ? decodeWords(raw, MAX_FILENAME) : clean(raw, MAX_FILENAME);
}

/** Number the tree the way RFC 3501 section 6.4.5 does (see the RFC's own 4.2.2.1 example). */
function assignSections(node: BodyPart, own: string) {
  if (node.type === 'multipart') {
    node.section = own;
    node.children.forEach((c, i) => assignSections(c, own ? `${own}.${i + 1}` : String(i + 1)));
    return;
  }
  node.section = own || '1';
  if (node.message) assignSections(node.message, node.message.type === 'multipart' ? node.section : `${node.section}.1`);
}

/**
 * Parse a FETCH BODYSTRUCTURE value (a token tree with literals already resolved). Null when it is
 * not a body structure — the caller then falls back to fetching the whole message. Never throws.
 */
export function parseBodyStructure(v: ImapValue | undefined): BodyPart | null {
  try {
    const root = parseNode(v, 0, { n: 0 });
    if (!root) return null;
    assignSections(root, '');
    return root;
  } catch {
    return null;
  }
}

/** Every node, depth first (attached messages' inner parts included). */
export function allParts(root: BodyPart): BodyPart[] {
  const out: BodyPart[] = [];
  const walk = (p: BodyPart) => {
    out.push(p);
    p.children.forEach(walk);
    if (p.message) walk(p.message);
  };
  walk(root);
  return out;
}

export interface PartPlan {
  /** text/plain and text/html leaves that make up the readable body (fetched when the message opens) */
  text: BodyPart[];
  /** everything else that is a leaf (an attached message counts as ONE leaf) — never fetched on open */
  attachments: BodyPart[];
}

/**
 * Split a structure into "the body you read" and "attachments". An attached message (message/rfc822)
 * is one attachment; it is not opened up and its text is not this message's text.
 */
export function planParts(root: BodyPart): PartPlan {
  const text: BodyPart[] = [];
  const attachments: BodyPart[] = [];
  const walk = (p: BodyPart) => {
    if (p.type === 'multipart') {
      p.children.forEach(walk);
      return;
    }
    const readable = p.type === 'text' && (p.subtype === 'plain' || p.subtype === 'html') && p.disposition !== 'attachment';
    (readable ? text : attachments).push(p);
  };
  walk(root);
  return { text, attachments };
}

/** The decoded size, estimated from the encoded octets (base64 lines are 76 characters + CRLF). */
export function decodedSizeEstimate(encoding: string, octets: number): number {
  const n = Math.max(0, Math.floor(octets || 0));
  if (String(encoding).toLowerCase() === 'base64') return Math.floor((n * 57) / 78);
  return n;
}

/** The LARGEST decoded size a part with these octets can have (base64 with no line breaks). */
export function decodedSizeMax(encoding: string, octets: number): number {
  const n = Math.max(0, Math.floor(octets || 0));
  return String(encoding).toLowerCase() === 'base64' ? Math.ceil((n * 3) / 4) : n;
}

// ---------------------------------------------------------------- transfer decoding (bytes in, bytes out)

const isHex = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
const hexVal = (b: number) => (b <= 0x39 ? b - 0x30 : (b | 0x20) - 0x61 + 10);

/** Quoted-printable over BYTES: `=XX`, soft line breaks, and trailing transport whitespace removed (RFC 2045 6.7). */
export function decodeQuotedPrintableBytes(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let o = 0;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const b = input[i];
    if (b === 0x20 || b === 0x09) {
      // whitespace at the end of a line was added in transport: drop it
      let j = i;
      while (j < n && (input[j] === 0x20 || input[j] === 0x09)) j++;
      if (j >= n || input[j] === 0x0d || input[j] === 0x0a) {
        i = j;
        continue;
      }
      while (i < j) out[o++] = input[i++];
      continue;
    }
    if (b === 0x3d /* = */) {
      if (i + 2 < n && isHex(input[i + 1]) && isHex(input[i + 2])) {
        out[o++] = (hexVal(input[i + 1]) << 4) | hexVal(input[i + 2]);
        i += 3;
        continue;
      }
      // soft line break: '=' then optional whitespace then CRLF / LF (or the end of the data)
      let j = i + 1;
      while (j < n && (input[j] === 0x20 || input[j] === 0x09)) j++;
      if (j >= n) {
        i = j;
        continue;
      }
      if (input[j] === 0x0d && input[j + 1] === 0x0a) {
        i = j + 2;
        continue;
      }
      if (input[j] === 0x0a) {
        i = j + 1;
        continue;
      }
      out[o++] = b; // a lone '=' is a lone '='
      i++;
      continue;
    }
    out[o++] = b;
    i++;
  }
  return Buffer.from(out.subarray(0, o));
}

/** Base64 over BYTES: everything outside the alphabet (line breaks, spaces) is ignored. */
export function decodeBase64Bytes(input: Buffer): Buffer {
  let s = '';
  // filter to the alphabet in chunks, so a 70 MB part is not one giant regex input
  const CH = 1 << 20;
  for (let i = 0; i < input.length; i += CH) s += input.subarray(i, i + CH).toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
  const eq = s.indexOf('=');
  if (eq >= 0) s = s.slice(0, eq);
  return Buffer.from(s, 'base64');
}

/** Decode a part's body per its Content-Transfer-Encoding. 7bit / 8bit / binary / unknown: unchanged. */
export function decodeTransfer(encoding: string, raw: Buffer): Buffer {
  switch (String(encoding || '7bit').toLowerCase()) {
    case 'base64':
      return decodeBase64Bytes(raw);
    case 'quoted-printable':
      return decodeQuotedPrintableBytes(raw);
    default:
      return Buffer.from(raw);
  }
}

// ---------------------------------------------------------------- file names

/** device names Windows refuses (with any extension): `con.txt` is the console, not a file */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
// C0 + DEL + C1 controls; bidi embeddings / overrides / isolates and marks; zero-width characters;
// the line / paragraph separators; and the BOM
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/**
 * Make an attacker-chosen name safe to show and to use as a file name: no path (separators of any
 * platform become `_`), no control / bidi / zero-width characters (U+202E is how `exe.pdf` is shown
 * for `fdp.exe`), no characters Windows forbids, no leading dots (hidden files, `..`), no trailing
 * dots or spaces, no reserved device names, at most MAX_SAFE_NAME characters with the extension kept.
 */
export function sanitizeFilename(name: string, fallback = 'attachment'): string {
  // line breaks and tabs separate words; every other invisible character is dropped
  let s = String(name ?? '').normalize('NFC').replace(/[\t\r\n]+/g, ' ').replace(INVISIBLE, '');
  s = s.replace(/[/\\:*?"<>|]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = fallback;
  if (WINDOWS_RESERVED.test(s.split('.')[0].trim())) s = `_${s}`;
  const chars = [...s];
  if (chars.length > MAX_SAFE_NAME) {
    const d = s.lastIndexOf('.');
    const ext = d > 0 && s.length - d <= 17 ? s.slice(d) : '';
    const keep = [...s.slice(0, ext ? d : s.length)].slice(0, MAX_SAFE_NAME - [...ext].length).join('').replace(/[.\s]+$/, '');
    s = `${keep}${ext}`;
  }
  return s;
}

// ---------------------------------------------------------------- types

/** the extension -> type map compose uses; anything else is application/octet-stream */
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  json: 'application/json',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  eml: 'message/rfc822',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export function mimeForFilename(name: string): string {
  const d = String(name ?? '').lastIndexOf('.');
  const ext = d >= 0 ? name.slice(d + 1).toLowerCase() : '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The name an attachment is shown and saved under: sanitized, and given an extension from its type
 * when it declared none (an unnamed image becomes `attachment.png`, an attached message `message.eml`).
 */
export function attachmentName(filename: string, mime: string): string {
  const m = String(mime ?? '').toLowerCase();
  const name = sanitizeFilename(filename, m === 'message/rfc822' || m === 'message/global' ? 'message' : 'attachment');
  if (name.includes('.')) return name;
  const ext = m === 'message/rfc822' || m === 'message/global' ? 'eml' : Object.keys(TYPES).find((k) => TYPES[k] === m && k.length <= 4);
  return ext ? sanitizeFilename(`${name}.${ext}`) : name;
}

/** The type an attachment is described as: the declared one, lower-case, or octet-stream. */
export function partMime(p: Pick<BodyPart, 'type' | 'subtype'>): string {
  return /^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,80}$/.test(`${p.type}/${p.subtype}`) ? `${p.type}/${p.subtype}` : 'application/octet-stream';
}

/** The image types an inline cid: image may have (SVG is a document with scripts and links, never an image here). */
export type InlineImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** What the bytes ARE, from their magic numbers — the declared type is not trusted. */
export function sniffImage(b: Buffer): InlineImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** The cid: references an HTML body makes, normalised (lower-case, no brackets, %-decoded). */
export function referencedCids(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(html ?? '').matchAll(/cid:([^"'\s>)]{1,500})/gi)) {
    out.add(normalizeCid(m[1]));
    if (out.size >= 200) break;
  }
  return out;
}

export function normalizeCid(v: string): string {
  let s = String(v ?? '').trim().replace(/^<|>$/g, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* not %-encoded */
  }
  return s.toLowerCase();
}

/** True for a part that renders in the HTML view as an inline image (and is therefore not listed). */
export function isInlineImage(p: BodyPart, cids: Set<string>): boolean {
  return p.type === 'image' && /^(png|jpeg|jpg|gif|webp)$/.test(p.subtype) && !!p.id && cids.has(normalizeCid(p.id));
}

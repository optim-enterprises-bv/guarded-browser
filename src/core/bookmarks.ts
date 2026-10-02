// Per-profile bookmarks (profiles/<id>/bookmarks.json) with nested folders, the bookmarks bar,
// nicknames, search, and Netscape bookmark HTML import / export (the format Vivaldi, Chrome and
// Firefox export). Private data: nothing in the agent ever reads this module.
//
// Imports are untrusted: only http(s) URLs are accepted (javascript:, data:, file:, ... are dropped:
// no bookmarklets in v1), titles are decoded to plain text and capped, and the size, node count and
// nesting depth are capped.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWriteFile, loadJson } from './persist';

export const MAX_NODES = 10_000;
export const MAX_DEPTH = 20;
export const MAX_TITLE = 200;
export const MAX_URL = 2048;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const BAR_ID = 'bar';
export const OTHER_ID = 'other';

export interface BookmarkNode {
  type: 'bookmark';
  id: string;
  title: string;
  url: string;
  nickname?: string;
  /** free text the user writes about the page (ticket 33). Never page-derived, always a text node. */
  description?: string;
  /** shown on the speed-dial start page (ticket 33) */
  speedDial?: boolean;
  added: number;
}
export interface FolderNode {
  type: 'folder';
  id: string;
  title: string;
  children: Node[];
  added: number;
}
export type Node = BookmarkNode | FolderNode;

const ID = z.string().regex(/^(bar|other|[0-9a-f-]{36})$/);
const Title = z.string().max(MAX_TITLE);
export const NICK = /^[a-z0-9_-]{1,32}$/;
/** Words a nickname may never take over: local host names and common intranet / scheme words. */
export const RESERVED_NICKNAMES = new Set([
  'localhost', 'local', 'localdomain', 'broadcasthost', 'ip6-localhost', 'ip6-loopback', 'wpad', 'router', 'gateway', 'modem',
  'intranet', 'internal', 'corp', 'home', 'lan', 'nas', 'printer', 'proxy', 'dns', 'mail', 'www', 'about', 'chrome', 'file',
  'data', 'blob', 'javascript', 'http', 'https', 'ftp', 'settings', 'history', 'bookmarks',
]);

/** http / https only, parsed and re-serialised. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > MAX_URL) return null;
  try {
    const x = new URL(u.trim());
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}

export const MAX_DESCRIPTION = 2000;

export const BookmarkSchema = z
  .object({
    type: z.literal('bookmark'),
    id: ID,
    title: Title,
    url: z.string().max(MAX_URL).refine((u) => safeUrl(u) === u, 'only http(s) URLs'),
    nickname: z.string().regex(NICK).optional(),
    // control characters stripped on the way in (same discipline as cleanTitle): a description is
    // user text that gets rendered, so it must not carry newlines/escapes into the panel
    description: z
      .string()
      .max(MAX_DESCRIPTION)
      .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' '))
      .optional(),
    speedDial: z.boolean().optional(),
    added: z.number().int().nonnegative(),
  })
  .strict();

export const FolderSchema: z.ZodType<FolderNode> = z.lazy(() =>
  z
    .object({
      type: z.literal('folder'),
      id: ID,
      title: Title,
      children: z.array(z.union([BookmarkSchema, FolderSchema])).max(MAX_NODES),
      added: z.number().int().nonnegative(),
    })
    .strict(),
) as z.ZodType<FolderNode>;

const FileSchema = z
  .object({
    version: z.literal(1),
    showBar: z.boolean(),
    roots: z.tuple([FolderSchema, FolderSchema]), // [bookmarks bar, other bookmarks]
  })
  .strict();
type BookmarksFile = z.infer<typeof FileSchema>;

export const cleanTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

function emptyFile(): BookmarksFile {
  const now = Date.now();
  return {
    version: 1,
    showBar: false,
    roots: [
      { type: 'folder', id: BAR_ID, title: 'Bookmarks bar', children: [], added: now },
      { type: 'folder', id: OTHER_ID, title: 'Other bookmarks', children: [], added: now },
    ],
  };
}

function depthAndCount(f: FolderNode, depth = 0): { depth: number; count: number } {
  let d = depth;
  let c = 0;
  for (const n of f.children) {
    c++;
    if (n.type === 'folder') {
      const r = depthAndCount(n, depth + 1);
      d = Math.max(d, r.depth);
      c += r.count;
    }
  }
  return { depth: d, count: c };
}

export class BookmarkStore {
  private data: BookmarksFile = emptyFile();
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    const r = loadJson(file, FileSchema, {
      fallback: this.data,
      check: (d) => (d.roots.every((f) => depthAndCount(f).depth <= MAX_DEPTH) && this.countOf(d) <= MAX_NODES ? null : 'too deep or too large'),
    });
    this.data = r.value;
    this.loadError = r.loadError;
  }

  private countOf(d: BookmarksFile) {
    return d.roots.reduce((a, f) => a + depthAndCount(f).count, 0);
  }

  get showBar() {
    return this.data.showBar;
  }

  setShowBar(on: boolean) {
    this.data.showBar = !!on;
    this.save();
  }

  tree(): FolderNode[] {
    return structuredClone(this.data.roots);
  }

  private find(id: string): { node: Node; parent: FolderNode | null; depth: number } | null {
    const walk = (f: FolderNode, depth: number): { node: Node; parent: FolderNode | null; depth: number } | null => {
      for (const n of f.children) {
        if (n.id === id) return { node: n, parent: f, depth: depth + 1 };
        if (n.type === 'folder') {
          const r = walk(n, depth + 1);
          if (r) return r;
        }
      }
      return null;
    };
    for (const r of this.data.roots) {
      if (r.id === id) return { node: r, parent: null, depth: 0 };
      const x = walk(r, 0);
      if (x) return x;
    }
    return null;
  }

  private folder(id: string): FolderNode {
    const f = this.find(id);
    if (!f || f.node.type !== 'folder') throw new Error('no such folder');
    return f.node;
  }

  private checkNickname(nick: string | undefined, selfId?: string) {
    if (nick === undefined || nick === '') return undefined;
    if (!NICK.test(nick)) throw new Error('nickname: 1-32 of a-z 0-9 _ -');
    if (RESERVED_NICKNAMES.has(nick)) throw new Error(`"${nick}" is reserved (it is, or could be, a host name)`);
    if (this.all().some((b) => b.nickname === nick && b.id !== selfId)) throw new Error('nickname already used');
    return nick;
  }

  private ensureRoom(extra = 1) {
    if (this.countOf(this.data) + extra > MAX_NODES) throw new Error(`too many bookmarks (max ${MAX_NODES})`);
  }

  addBookmark(parentId: string, title: string, url: string, nickname?: string): BookmarkNode {
    const u = safeUrl(url);
    if (!u) throw new Error('only http(s) URLs can be bookmarked');
    this.ensureRoom();
    const b: BookmarkNode = { type: 'bookmark', id: randomUUID(), title: cleanTitle(title) || u, url: u, added: Date.now() };
    const nick = this.checkNickname(nickname);
    if (nick) b.nickname = nick;
    this.folder(parentId).children.push(b);
    this.save();
    return { ...b };
  }

  addFolder(parentId: string, title: string): FolderNode {
    const p = this.find(parentId);
    if (!p || p.node.type !== 'folder') throw new Error('no such folder');
    if (p.depth + 1 > MAX_DEPTH) throw new Error('folders nested too deep');
    this.ensureRoom();
    const f: FolderNode = { type: 'folder', id: randomUUID(), title: cleanTitle(title) || 'New folder', children: [], added: Date.now() };
    p.node.children.push(f);
    this.save();
    return structuredClone(f);
  }

  update(id: string, patch: { title?: string; url?: string; nickname?: string | null; description?: string; speedDial?: boolean }) {
    const f = this.find(id);
    if (!f || id === BAR_ID || id === OTHER_ID) throw new Error('no such bookmark');
    if (patch.title !== undefined) f.node.title = cleanTitle(patch.title) || f.node.title;
    if (f.node.type === 'bookmark') {
      if (patch.url !== undefined) {
        const u = safeUrl(patch.url);
        if (!u) throw new Error('only http(s) URLs can be bookmarked');
        f.node.url = u;
      }
      if (patch.nickname !== undefined) {
        const nick = this.checkNickname(patch.nickname ?? undefined, id);
        if (nick) f.node.nickname = nick;
        else delete f.node.nickname;
      }
      // a description is user text rendered in the panel: control characters stripped, length capped,
      // and an empty value removes the field rather than storing ''
      if (patch.description !== undefined) {
        const d = cleanTitle(patch.description).slice(0, MAX_DESCRIPTION);
        if (d) f.node.description = d;
        else delete f.node.description;
      }
      if (patch.speedDial !== undefined) {
        if (patch.speedDial) f.node.speedDial = true;
        else delete f.node.speedDial;
      }
    }
    this.save();
  }

  remove(id: string) {
    const f = this.find(id);
    if (!f || !f.parent) throw new Error('no such bookmark');
    f.parent.children = f.parent.children.filter((n) => n.id !== id);
    this.save();
  }

  /** Move a node into folder `parentId` at `index` (drag-and-drop). A folder cannot move into itself. */
  move(id: string, parentId: string, index: number) {
    const f = this.find(id);
    if (!f || !f.parent) throw new Error('no such bookmark');
    const target = this.find(parentId);
    if (!target || target.node.type !== 'folder') throw new Error('no such folder');
    if (f.node.type === 'folder') {
      // not into itself or a descendant
      let cur: Node | undefined = f.node;
      const inside = (n: Node): boolean => n.id === parentId || (n.type === 'folder' && n.children.some(inside));
      if (inside(cur)) throw new Error('a folder cannot move into itself');
      cur = undefined;
      if (target.depth + 1 + depthAndCount(f.node).depth > MAX_DEPTH) throw new Error('folders nested too deep');
    }
    const from = f.parent.children;
    const to = target.node.children;
    const oldIndex = from.findIndex((n) => n.id === id);
    // index is a position in the target folder as the user sees it (before the move)
    let i = Math.max(0, Math.min(to.length, Math.floor(Number(index) || 0)));
    if (from === to && oldIndex < i) i--; // same folder: account for the removed slot
    from.splice(oldIndex, 1);
    to.splice(i, 0, f.node);
    this.save();
  }

  /** All bookmarks (flattened) with their folder path. */
  all(): Array<BookmarkNode & { path: string }> {
    const out: Array<BookmarkNode & { path: string }> = [];
    const walk = (f: FolderNode, path: string) => {
      for (const n of f.children) {
        if (n.type === 'bookmark') out.push({ ...n, path });
        else walk(n, `${path}/${n.title}`);
      }
    };
    for (const r of this.data.roots) walk(r, r.title);
    return out;
  }

  search(query: string, max = 50): Array<BookmarkNode & { path: string }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.all()
      .filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || (b.nickname ?? '').includes(q))
      .slice(0, max);
  }

  byNickname(nick: string): BookmarkNode | undefined {
    const n = nick.trim().toLowerCase();
    return this.all().find((b) => b.nickname === n);
  }

  isBookmarked(url: string): string | null {
    return this.all().find((b) => b.url === url)?.id ?? null;
  }

  /** Import a Netscape bookmark file into a new folder under "Other bookmarks". */
  importNetscape(html: string, folderTitle = 'Imported') {
    return this.importParsed(parseNetscape(html), folderTitle);
  }

  /** Store an already-parsed import (the app parses in a worker thread). Re-validated here. */
  importParsed(parsed: ParsedImport, folderTitle = 'Imported'): { imported: number; skipped: number; folders: number; nicknamesDropped: number } {
    const holder: FolderNode = { type: 'folder', id: randomUUID(), title: cleanTitle(folderTitle) || 'Imported', children: parsed.children, added: Date.now() };
    const strip = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.type === 'folder') strip(n.children);
        else delete n.nickname; // never from a file
      }
    };
    strip(holder.children);
    const check = FolderSchema.safeParse(holder);
    if (!check.success) throw new Error(`import rejected: ${check.error.issues[0]?.message}`);
    const d = depthAndCount(check.data);
    if (d.depth > MAX_DEPTH) throw new Error('import nested too deep');
    // keep what fits under the overall cap (the holder folder counts too); the rest is skipped
    let budget = MAX_NODES - this.countOf(this.data) - 1;
    if (budget <= 0) throw new Error(`too many bookmarks (max ${MAX_NODES})`);
    let kept = 0;
    let dropped = 0;
    const trim = (f: FolderNode) => {
      f.children = f.children.filter((n) => {
        if (budget <= 0) {
          dropped += n.type === 'folder' ? 1 + depthAndCount(n).count : 1;
          return false;
        }
        budget--;
        if (n.type === 'bookmark') kept++;
        else trim(n);
        return true;
      });
    };
    trim(check.data);
    this.folder(OTHER_ID).children.push(check.data);
    this.save();
    return { imported: kept, skipped: parsed.skipped + dropped, folders: parsed.folders, nicknamesDropped: parsed.nicknamesDropped };
  }

  exportNetscape(): string {
    return exportNetscape(this.data.roots);
  }

  private save() {
    const r = FileSchema.safeParse(this.data);
    if (!r.success) throw new Error(`bookmarks invalid: ${r.error.issues[0]?.message}`);
    atomicWriteFile(this.file, JSON.stringify(this.data));
  }
}

// ---------------- Netscape bookmark HTML ----------------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Decode entities and drop every tag: titles are plain text. */
export function htmlText(s: string): string {
  return cleanTitle(decodeEntities(s.replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ').replace(/<[^>]*>?/g, '')));
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

export interface ParsedImport {
  children: Node[];
  bookmarks: number;
  folders: number;
  skipped: number;
  count: number;
  /** SHORTCUTURL nicknames present in the file and not imported */
  nicknamesDropped: number;
}

/**
 * Tokenise the file into DL / DT / H3 / A tags; everything else (scripts, styles, comments, other
 * markup) is ignored. Structure follows the DL nesting. Deeper than MAX_DEPTH: flattened into the
 * deepest allowed folder. Over MAX_NODES: the rest is skipped.
 */
export function parseNetscape(html: string): ParsedImport {
  if (html.length > MAX_IMPORT_BYTES) throw new Error(`bookmark file larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  if (!/<!DOCTYPE\s+NETSCAPE-Bookmark-file-1>/i.test(html.slice(0, 2048)) && !/<DL\b/i.test(html)) throw new Error('not a Netscape bookmark file');
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  // one lower-cased copy for the closing-tag searches: every search moves forward, so the whole
  // parse is linear in the file size (the old per-tag toLowerCase() was quadratic)
  const lower = src.toLowerCase();
  const root: FolderNode = { type: 'folder', id: randomUUID(), title: 'root', children: [], added: Date.now() };
  const stack: FolderNode[] = [root];
  let pendingFolder: FolderNode | null = null;
  const out = { bookmarks: 0, folders: 0, skipped: 0, count: 0, nicknamesDropped: 0 };
  const tagRe = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    const [full, close, nameRaw] = m;
    const name = nameRaw.toLowerCase();
    if (name === 'dl') {
      if (close) {
        if (stack.length > 1) stack.pop();
      } else if (pendingFolder) {
        if (stack.length <= MAX_DEPTH) stack.push(pendingFolder);
        else stack.push(stack[stack.length - 1]); // too deep: keep adding to the deepest folder
        pendingFolder = null;
      } else stack.push(stack[stack.length - 1]); // stray DL: no new level
      continue;
    }
    if (close) continue;
    if (out.count >= MAX_NODES) {
      // node cap reached: stop scanning, just count what is left
      out.skipped += 1 + (lower.slice(tagRe.lastIndex).match(/<(a|h3)\b/g) ?? []).length;
      break;
    }
    // the closing tag is looked for in a bounded window only (titles are capped anyway), so a file
    // with missing or far-away closing tags cannot make every search run to the end of the file
    const start = tagRe.lastIndex;
    const rel = lower.slice(start, start + 4000).indexOf(`</${name}`);
    const end = rel < 0 ? -1 : start + rel;
    const inner = src.slice(start, end < 0 ? Math.min(src.length, start + 1000) : end);
    const parent = stack[stack.length - 1];
    if (name === 'h3') {
      const f: FolderNode = { type: 'folder', id: randomUUID(), title: htmlText(inner) || 'Folder', children: [], added: Date.now() };
      parent.children.push(f);
      pendingFolder = f;
      out.folders++;
      out.count++;
    } else {
      const url = safeUrl(attr(full, 'href'));
      if (!url) {
        out.skipped++; // javascript:, data:, file:, place:, ... and malformed URLs
        continue;
      }
      const b: BookmarkNode = { type: 'bookmark', id: randomUUID(), title: htmlText(inner) || url, url, added: Date.now() };
      // SHORTCUTURL nicknames are never imported: a shared file could bind a typed word such as
      // "bank" to an attacker's page. The user sets nicknames by hand.
      if (attr(full, 'shortcuturl')) out.nicknamesDropped++;
      parent.children.push(b);
      out.bookmarks++;
      out.count++;
    }
    if (end > 0) tagRe.lastIndex = end;
  }
  return { children: root.children, ...out };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function exportNetscape(roots: FolderNode[]): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const walk = (f: FolderNode, indent: string) => {
    for (const n of f.children) {
      if (n.type === 'folder') {
        lines.push(`${indent}<DT><H3 ADD_DATE="${Math.floor(n.added / 1000)}">${esc(n.title)}</H3>`, `${indent}<DL><p>`);
        walk(n, `${indent}    `);
        lines.push(`${indent}</DL><p>`);
      } else {
        const nick = n.nickname ? ` SHORTCUTURL="${esc(n.nickname)}"` : '';
        lines.push(`${indent}<DT><A HREF="${esc(n.url)}" ADD_DATE="${Math.floor(n.added / 1000)}"${nick}>${esc(n.title)}</A>`);
      }
    }
  };
  for (const r of roots) {
    const bar = r.id === BAR_ID ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
    lines.push(`    <DT><H3${bar}>${esc(r.title)}</H3>`, '    <DL><p>');
    walk(r, '        ');
    lines.push('    </DL><p>');
  }
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

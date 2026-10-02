// Mail store (ticket 34) — the on-disk corpus for ONE profile.
//
// NOTHING IN THE AGENT (planner / reader / judge) MAY EVER READ THIS MODULE. Mail is private data
// plus untrusted content plus an outgoing channel: the lethal trifecta in one object. The store is
// reachable only from the mail window's own IPC handlers, and a test asserts that a marker hidden in
// a message body appears in no model request.
//
// Decisions recorded rather than hidden:
//  * node:sqlite (Electron 44 ships Node 24 / SQLite 3.53 with FTS5 — probed on this box, not
//    assumed) instead of better-sqlite3: no native module in an RPM-packaged browser, and the store
//    is unit-testable outside Electron.
//  * NO HTML IS EVER STORED. `htmlToText` strips tags with no parser and no fetch, so a hostile tag
//    soup cannot survive into the UI and a tracking pixel cannot even be counted. The original HTML
//    is dropped, not kept "for rendering later"; whether the message HAD remote content is a flag,
//    so the UI can say "remote content was not loaded" instead of pretending the message was flat.
//  * Attachments are METADATA only (name / mime / size / part id). Bytes are never stored here and
//    are never fetched implicitly — a fetch is an explicit click (ticket 41).
//  * No gate, taint or agent-task state can be REPRESENTED: there is no column for it, and a test
//    reads the schema back and asserts that.
//  * `seen` and `readFlag` are distinct, because "never displayed" and "displayed but not dealt
//    with" are different things (Vivaldi's Unseen vs Unread), not a UI convention.
//
// Counters: `unseen` = seen=0; `unread` = seen=1 AND readFlag=0.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;
export const DB_FILE = 'mail.sqlite';

/** hard ceiling on stored messages; a store beyond this refuses writes instead of growing forever */
export const MAX_MESSAGES = 500_000;
/** per-message stored text ceiling (a 300 MB text body is a hostile input, not mail) */
export const MAX_BODY_TEXT = 200_000;
/** stored raw header ceiling */
export const MAX_RAW_HEADER = 128_000;
export const MAX_STR = 400;
export const MAX_ADDRS = 2_000;
export const MAX_SUBJECT = 400;
export const MAX_ACCOUNTS = 24;
export const MAX_LABELS = 500;

export type FolderKind = 'folder' | 'inbox' | 'sent' | 'drafts' | 'outbox' | 'trash' | 'junk' | 'archive';
export type AccountKind = 'imap' | 'pop3' | 'local';
export type TlsMode = 'implicit' | 'starttls' | 'none';
export type MessageSource = 'mail' | 'feed';

export interface MailAccount {
  id: string;
  name: string;
  address: string;
  kind: AccountKind;
  host: string;
  port: number;
  tls: TlsMode;
  /** the login name is NOT a secret; the password/OAuth token lives in the secret store (35) */
  username: string;
  sentFolder: string;
  trashFolder: string;
  junkFolder: string;
  archiveFolder: string;
  sortOrder: number;
}

export interface MailFolder {
  accountId: string;
  path: string;
  name: string;
  kind: FolderKind;
  uidValidity: number;
  uidNext: number;
  subscribed: boolean;
  hidden: boolean;
}

/** A message without its body: what the list view needs. */
export interface MessageHeader {
  accountId: string;
  folder: string;
  uid: number;
  messageId?: string;
  subject?: string;
  fromName?: string;
  fromAddr?: string;
  toAddrs?: string;
  ccAddrs?: string;
  replyTo?: string;
  sentAt?: number;
  receivedAt?: number;
  size?: number;
  seen?: boolean;
  readFlag?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  junk?: boolean;
  /** whether the original HTML referenced remote resources (so the UI can say so) */
  remoteContent?: boolean;
  source?: MessageSource;
}

export interface MessageRow extends Required<Omit<MessageHeader, 'messageId'>> {
  id: number;
  messageId: string;
  /** the grouping the sync layer stored; the UI groups by THIS and never by a subject guess */
  threadId: string;
  hasAttachments: boolean;
  bodyFetched: boolean;
  labels: string[];
}

export interface MessageBody {
  id: number;
  bodyText: string;
  rawHeader: string;
  bodyFetched: boolean;
  remoteContent: boolean;
  attachments: Attachment[];
}

export interface Attachment {
  partId: string;
  filename: string;
  mime: string;
  size: number;
}

export interface MessageCounts {
  total: number;
  unseen: number;
  unread: number;
  flagged: number;
  drafts: number;
  junk: number;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  accountId: string;
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------- text hygiene

/**
 * Strip control characters and collapse whitespace. Page- and server-controlled strings are stored
 * this way and rendered as text nodes only — the same discipline as `cleanTitle` in history.ts
 * (kept local so mail does not depend on the browsing store; the caps differ).
 */
export function clean(s: unknown, max = MAX_STR): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Strip control characters but keep line structure (for stored body text). */
export function cleanBody(s: unknown, max = MAX_BODY_TEXT): string {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .slice(0, max);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  eacute: '\u00e9',
  egrave: '\u00e8',
  uuml: '\u00fc',
  ouml: '\u00f6',
  auml: '\u00e4',
  szlig: '\u00df',
  ntilde: '\u00f1',
  pound: '\u00a3',
  euro: '\u20ac',
  deg: '\u00b0',
  times: '\u00d7',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
};

/** Decode the entity set above plus numeric references, without a parser and without throwing. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return m;
      // surrogate halves would throw in fromCodePoint
      if (n >= 0xd800 && n <= 0xdfff) return m;
      try {
        return String.fromCodePoint(n);
      } catch {
        return m;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

const SCRIPTISH = /<(script|style|head|title|iframe|object|embed|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_END = /<\s*\/?\s*(p|div|br|tr|li|ul|ol|h[1-6]|table|blockquote|section|article|header|footer|pre)\b[^>]*>/gi;
/**
 * HTML to plain text: no parser, no network, no preserved markup.
 *
 * Order matters: scripts/styles/comments/tags are removed FIRST, then entities are decoded. A
 * message that writes `&lt;script&gt;` therefore ends up as the literal text `<script>` — safe,
 * because every consumer of this value sets it as a text node and never as HTML.
 *
 * `remoteContent` reports whether the original referenced anything the client did not load
 * (images, stylesheets, media, scripts), so the UI can be honest about it.
 */
export function htmlToText(html: string): { text: string; remoteContent: boolean } {
  const remoteContent = /<\s*(img|picture|source|video|audio|iframe|object|embed|link|script|style|form)\b/i.test(html);
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(SCRIPTISH, ' ')
    .replace(/<\s*(img|input|hr)\b[^>]*>/gi, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  // entities can decode into control characters; cleanBody removes them
  return { text: cleanBody(s).replace(/[ \t]+\n/g, '\n').trim(), remoteContent };
}

// ---------------------------------------------------------------- search

/**
 * Turn free text into an FTS5 MATCH expression, quoting every token.
 *
 * This is a security boundary as much as a convenience: raw user (or message) text must never reach
 * MATCH, where `"`, `*`, `NEAR(`, `AND`, `^` and column filters are operators and a malformed
 * expression throws. Tokens are reduced to letters/digits/underscore and emitted as a prefix match,
 * so `"` and `OR` are just characters that get dropped or matched literally.
 */
export function ftsQuery(q: string, maxTokens = 12): string | null {
  const toks = String(q ?? '')
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    // FTS5 reserves these as operators; a bare `AND*` is a syntax error, and the safe direction is to
    // drop them rather than to try to escape them into the query language.
    .filter((t) => t.length > 0 && !FTS_RESERVED.has(t.toUpperCase()))
    .slice(0, maxTokens);
  if (!toks.length) return null;
  return toks.map((t) => `${t}*`).join(' AND ');
}

const FTS_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);

// ---------------------------------------------------------------- store

const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;

CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'imap',
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER NOT NULL DEFAULT 0,
  tls           TEXT NOT NULL DEFAULT 'implicit',
  username      TEXT NOT NULL DEFAULT '',
  sentFolder    TEXT NOT NULL DEFAULT '',
  trashFolder   TEXT NOT NULL DEFAULT '',
  junkFolder    TEXT NOT NULL DEFAULT '',
  archiveFolder TEXT NOT NULL DEFAULT '',
  sortOrder     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folder (
  accountId   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'folder',
  uidValidity INTEGER NOT NULL DEFAULT 0,
  uidNext     INTEGER NOT NULL DEFAULT 0,
  subscribed  INTEGER NOT NULL DEFAULT 1,
  hidden      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (accountId, path)
);

CREATE TABLE message (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId       TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  folder          TEXT NOT NULL,
  uid             INTEGER NOT NULL,
  messageId       TEXT NOT NULL DEFAULT '',
  threadId        TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL DEFAULT '',
  fromName        TEXT NOT NULL DEFAULT '',
  fromAddr        TEXT NOT NULL DEFAULT '',
  toAddrs         TEXT NOT NULL DEFAULT '',
  ccAddrs         TEXT NOT NULL DEFAULT '',
  replyTo         TEXT NOT NULL DEFAULT '',
  sentAt          INTEGER NOT NULL DEFAULT 0,
  receivedAt      INTEGER NOT NULL DEFAULT 0,
  size            INTEGER NOT NULL DEFAULT 0,
  seen            INTEGER NOT NULL DEFAULT 0,
  readFlag        INTEGER NOT NULL DEFAULT 0,
  flagged         INTEGER NOT NULL DEFAULT 0,
  answered        INTEGER NOT NULL DEFAULT 0,
  draft           INTEGER NOT NULL DEFAULT 0,
  junk            INTEGER NOT NULL DEFAULT 0,
  remoteContent   INTEGER NOT NULL DEFAULT 0,
  hasAttachments  INTEGER NOT NULL DEFAULT 0,
  bodyFetched     INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'mail',
  bodyText        TEXT NOT NULL DEFAULT '',
  rawHeader       TEXT NOT NULL DEFAULT '',
  UNIQUE (accountId, folder, uid)
);
CREATE INDEX message_folder_time ON message (accountId, folder, receivedAt DESC);
CREATE INDEX message_thread      ON message (threadId);
CREATE INDEX message_flags       ON message (accountId, seen, readFlag, junk);

CREATE TABLE attachment (
  messageId INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  partId    TEXT NOT NULL,
  filename  TEXT NOT NULL DEFAULT '',
  mime      TEXT NOT NULL DEFAULT '',
  size      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (messageId, partId)
);

CREATE TABLE label (
  id        TEXT PRIMARY KEY,
  accountId TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL DEFAULT '',
  color     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE message_label (
  messageId INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  labelId   TEXT NOT NULL REFERENCES label(id) ON DELETE CASCADE,
  PRIMARY KEY (messageId, labelId)
);

-- ticket 39 evaluates these; the foundation only stores them (a saved search IS a filter)
CREATE TABLE filter (
  id        TEXT PRIMARY KEY,
  accountId TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL DEFAULT '',
  expr      TEXT NOT NULL DEFAULT '',
  actions   TEXT NOT NULL DEFAULT '',
  enabled   INTEGER NOT NULL DEFAULT 1,
  sortOrder INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE message_fts USING fts5(subject, fromName, fromAddr, toAddrs, bodyText);
`;

const nowMs = () => Date.now();

export class MailStore {
  private db: DatabaseSync;
  readonly path: string;
  /** true when opened read-only-ish because the write path failed: the caller reports it */
  readonly loadError: string | null = null;

  constructor(file: string) {
    this.path = file;
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
      // Permissions BEFORE there is any content: SQLite creates the file with the process umask
      // (0644 on this box), so opening into an existing empty 0600 file is the only ordering that
      // does not leave a window where mail is world-readable. An existing file is re-tightened.
      try {
        closeSync(openSync(file, 'a', 0o600));
        chmodSync(file, 0o600);
      } catch {
        /* the DatabaseSync constructor below will report the real failure */
      }
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 4000;');
    if (file !== ':memory:') {
      // the -wal / -shm sidecars carry message text too, and SQLite creates them with the umask
      for (const side of [`${file}-wal`, `${file}-shm`]) {
        try {
          chmodSync(side, 0o600);
        } catch {
          /* not created yet */
        }
      }
    }
    this.migrate();
  }

  private get userVersion(): number {
    const r = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(r?.user_version ?? 0);
  }

  private migrate() {
    const v = this.userVersion;
    if (v > SCHEMA_VERSION) throw new Error(`mail store is from a newer version (${v} > ${SCHEMA_VERSION})`);
    if (v === SCHEMA_VERSION) return;
    this.db.exec('BEGIN');
    try {
      if (v < 1) {
        this.db.exec(SCHEMA);
        this.db.exec(`INSERT INTO meta (k, v) VALUES ('createdAt', '${nowMs()}')`);
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  schemaVersion(): number {
    return this.userVersion;
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* nothing to checkpoint */
    }
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** on-disk size in bytes (main file + WAL + shm); 0 for :memory: */
  dbBytes(): number {
    if (this.path === ':memory:') return 0;
    let n = 0;
    for (const f of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        if (existsSync(f)) n += statSync(f).size;
      } catch {
        /* ignore */
      }
    }
    return n;
  }

  messageCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n);
  }

  /**
   * Capacity check for a caller about to store `addingBytes` (ticket 36 calls this before fetching a
   * body). Storage is bounded so a hostile server cannot fill the user's disk with one account.
   */
  canStore(addingBytes = 0, ceilingBytes = 4 * 1024 * 1024 * 1024): { ok: boolean; reason?: string } {
    if (this.messageCount() >= MAX_MESSAGES) return { ok: false, reason: `message ceiling reached (${MAX_MESSAGES})` };
    if (this.dbBytes() + addingBytes > ceilingBytes) return { ok: false, reason: 'mail store size ceiling reached' };
    return { ok: true };
  }

  // ------------------------------------------------------------ accounts

  addAccount(a: Omit<MailAccount, 'sortOrder'> & { sortOrder?: number }): Result<{ id: string }> {
    const id = clean(a.id, 64);
    if (!id) return { ok: false, error: 'account needs an id' };
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n);
    if (count >= MAX_ACCOUNTS) return { ok: false, error: `at most ${MAX_ACCOUNTS} accounts` };
    const kinds = new Set<AccountKind>(['imap', 'pop3', 'local']);
    const tlsModes = new Set<TlsMode>(['implicit', 'starttls', 'none']);
    const kind: AccountKind = kinds.has(a.kind) ? a.kind : 'imap';
    const tls: TlsMode = tlsModes.has(a.tls) ? a.tls : 'implicit';
    this.db
      .prepare(
        `INSERT INTO account (id, name, address, kind, host, port, tls, username, sentFolder, trashFolder, junkFolder, archiveFolder, sortOrder)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, kind=excluded.kind, host=excluded.host,
           port=excluded.port, tls=excluded.tls, username=excluded.username, sentFolder=excluded.sentFolder,
           trashFolder=excluded.trashFolder, junkFolder=excluded.junkFolder, archiveFolder=excluded.archiveFolder,
           sortOrder=excluded.sortOrder`,
      )
      .run(
        id,
        clean(a.name),
        clean(a.address, 320),
        kind,
        clean(a.host, 255),
        Math.max(0, Math.min(65535, Number(a.port) || 0)),
        tls,
        clean(a.username, 320),
        clean(a.sentFolder, 255),
        clean(a.trashFolder, 255),
        clean(a.junkFolder, 255),
        clean(a.archiveFolder, 255),
        Number(a.sortOrder ?? count),
      );
    return { ok: true, id };
  }

  listAccounts(): MailAccount[] {
    const rows = this.db.prepare('SELECT * FROM account ORDER BY sortOrder, name').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      address: String(r.address),
      kind: String(r.kind) as AccountKind,
      host: String(r.host),
      port: Number(r.port),
      tls: String(r.tls) as TlsMode,
      username: String(r.username),
      sentFolder: String(r.sentFolder),
      trashFolder: String(r.trashFolder),
      junkFolder: String(r.junkFolder),
      archiveFolder: String(r.archiveFolder),
      sortOrder: Number(r.sortOrder),
    }));
  }

  /** Removes the account and everything under it (folders, messages, labels, filters, FTS rows). */
  removeAccount(id: string): { removed: number } {
    const ids = (this.db.prepare('SELECT id FROM message WHERE accountId = ?').all(clean(id, 64)) as { id: number }[]).map((r) => r.id);
    this.forgetFts(ids);
    const n = this.db.prepare('DELETE FROM account WHERE id = ?').run(clean(id, 64)).changes;
    this.db.prepare('DELETE FROM label WHERE accountId = ?').run(clean(id, 64));
    this.db.prepare('DELETE FROM filter WHERE accountId = ?').run(clean(id, 64));
    return { removed: Number(n) };
  }

  // ------------------------------------------------------------ folders

  upsertFolder(f: Omit<MailFolder, 'subscribed' | 'hidden'> & { subscribed?: boolean; hidden?: boolean }): void {
    const kinds = new Set<FolderKind>(['folder', 'inbox', 'sent', 'drafts', 'outbox', 'trash', 'junk', 'archive']);
    this.db
      .prepare(
        `INSERT INTO folder (accountId, path, name, kind, uidValidity, uidNext, subscribed, hidden)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(accountId, path) DO UPDATE SET name=excluded.name, kind=excluded.kind,
           uidNext=excluded.uidNext, subscribed=excluded.subscribed, hidden=excluded.hidden`,
      )
      .run(
        clean(f.accountId, 64),
        clean(f.path, 255),
        clean(f.name),
        kinds.has(f.kind) ? f.kind : 'folder',
        Number(f.uidValidity) || 0,
        Number(f.uidNext) || 0,
        f.subscribed === false ? 0 : 1,
        f.hidden ? 1 : 0,
      );
  }

  listFolders(accountId: string): MailFolder[] {
    const rows = this.db.prepare('SELECT * FROM folder WHERE accountId = ? ORDER BY name').all(clean(accountId, 64)) as Record<string, unknown>[];
    return rows.map((r) => ({
      accountId: String(r.accountId),
      path: String(r.path),
      name: String(r.name),
      kind: String(r.kind) as FolderKind,
      uidValidity: Number(r.uidValidity),
      uidNext: Number(r.uidNext),
      subscribed: Number(r.subscribed) === 1,
      hidden: Number(r.hidden) === 1,
    }));
  }

  /**
   * Record a folder's UIDVALIDITY. When it CHANGES, every uid the client holds for that folder is
   * meaningless, so the folder's messages are dropped and the caller is told to resync — silently
   * keeping them is how a mail client shows mail that no longer exists and skips mail that does.
   */
  setUidValidity(accountId: string, path: string, uidValidity: number): { reset: boolean; dropped: number } {
    const a = clean(accountId, 64);
    const p = clean(path, 255);
    const prev = this.db.prepare('SELECT uidValidity FROM folder WHERE accountId = ? AND path = ?').get(a, p) as { uidValidity?: number } | undefined;
    const changed = !!prev && Number(prev.uidValidity) !== Number(uidValidity);
    let dropped = 0;
    if (changed) {
      const ids = (this.db.prepare('SELECT id FROM message WHERE accountId = ? AND folder = ?').all(a, p) as { id: number }[]).map((r) => r.id);
      this.forgetFts(ids);
      dropped = Number(this.db.prepare('DELETE FROM message WHERE accountId = ? AND folder = ?').run(a, p).changes);
    }
    this.db.prepare('UPDATE folder SET uidValidity = ? WHERE accountId = ? AND path = ?').run(Number(uidValidity) || 0, a, p);
    return { reset: changed, dropped };
  }

  // ------------------------------------------------------------ messages

  /** Insert or update one message by (account, folder, uid). Returns the row id. */
  upsertMessage(h: MessageHeader): Result<{ id: number; inserted: boolean }> {
    const accountId = clean(h.accountId, 64);
    const folder = clean(h.folder, 255);
    const uid = Number(h.uid);
    if (!accountId) return { ok: false, error: 'accountId required' };
    if (!folder) return { ok: false, error: 'folder required' };
    if (!Number.isInteger(uid) || uid <= 0) return { ok: false, error: 'uid must be a positive integer' };
    if (!this.canStore().ok && !this.byUid(accountId, folder, uid)) return { ok: false, error: this.canStore().reason ?? 'store full' };

    const existing = this.byUid(accountId, folder, uid);
    const v = [
      clean(h.messageId, 998),
      clean(h.subject, MAX_SUBJECT),
      clean(h.fromName, MAX_STR),
      clean(h.fromAddr, 320),
      clean(h.toAddrs, MAX_ADDRS),
      clean(h.ccAddrs, MAX_ADDRS),
      clean(h.replyTo, 320),
      Number(h.sentAt) || 0,
      Number(h.receivedAt) || nowMs(),
      Math.max(0, Number(h.size) || 0),
      h.seen ? 1 : 0,
      h.readFlag ? 1 : 0,
      h.flagged ? 1 : 0,
      h.answered ? 1 : 0,
      h.draft ? 1 : 0,
      h.junk ? 1 : 0,
      h.remoteContent ? 1 : 0,
      h.source === 'feed' ? 'feed' : 'mail',
    ];
    let id: number;
    if (existing) {
      this.db
        .prepare(
          `UPDATE message SET messageId=?, subject=?, fromName=?, fromAddr=?, toAddrs=?, ccAddrs=?, replyTo=?, sentAt=?,
             receivedAt=?, size=?, seen=?, readFlag=?, flagged=?, answered=?, draft=?, junk=?, remoteContent=?, source=?
           WHERE id = ?`,
        )
        .run(...v, existing.id);
      id = existing.id;
    } else {
      this.db
        .prepare(
          `INSERT INTO message (accountId, folder, uid, messageId, subject, fromName, fromAddr, toAddrs, ccAddrs, replyTo,
             sentAt, receivedAt, size, seen, readFlag, flagged, answered, draft, junk, remoteContent, source)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(accountId, folder, uid, ...v);
      id = Number((this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    }
    // thread id: the client supplies one; otherwise the message-id groups the conversation
    const thread = clean(h.messageId, 998) || `${accountId}:${folder}:${uid}`;
    this.db.prepare('UPDATE message SET threadId = ? WHERE id = ? AND threadId = \'\'').run(thread, id);
    this.indexMessage(id);
    return { ok: true, id, inserted: !existing };
  }

  /**
   * Store a fetched body. Only TEXT is stored: HTML is converted here, once, and the original is
   * discarded. `rawHeader` is stored capped for the "view source" view (ticket 37).
   */
  setBody(accountId: string, folder: string, uid: number, body: { text?: string; html?: string; rawHeader?: string; attachments?: Attachment[] }): Result<{ id: number }> {
    const row = this.byUid(accountId, folder, uid);
    if (!row) return { ok: false, error: 'unknown message' };
    let text = cleanBody(body.text ?? '', MAX_BODY_TEXT);
    let remote = false;
    if (!text && typeof body.html === 'string' && body.html) {
      const r = htmlToText(body.html.slice(0, 4 * MAX_BODY_TEXT));
      text = r.text;
      remote = r.remoteContent;
    }
    this.db
      .prepare('UPDATE message SET bodyText = ?, rawHeader = ?, bodyFetched = 1, remoteContent = remoteContent OR ? WHERE id = ?')
      .run(text, cleanBody(body.rawHeader ?? '', MAX_RAW_HEADER), remote ? 1 : 0, row.id);
    if (body.attachments) this.setAttachments(row.id, body.attachments);
    this.indexMessage(row.id);
    return { ok: true, id: row.id };
  }

  setAttachments(messageId: number, items: Attachment[]): void {
    this.db.prepare('DELETE FROM attachment WHERE messageId = ?').run(messageId);
    const ins = this.db.prepare('INSERT OR REPLACE INTO attachment (messageId, partId, filename, mime, size) VALUES (?,?,?,?,?)');
    let n = 0;
    for (const a of items) {
      if (n++ >= 200) break; // a message claiming 10 000 parts is hostile
      ins.run(messageId, clean(a.partId, 64), clean(a.filename, 255), clean(a.mime, 128), Math.max(0, Number(a.size) || 0));
    }
    this.db.prepare('UPDATE message SET hasAttachments = ? WHERE id = ?').run(items.length ? 1 : 0, messageId);
  }

  private indexMessage(id: number) {
    const r = this.db.prepare('SELECT subject, fromName, fromAddr, toAddrs, bodyText FROM message WHERE id = ?').get(id) as
      | { subject: string; fromName: string; fromAddr: string; toAddrs: string; bodyText: string }
      | undefined;
    if (!r) return;
    this.forgetFts([id]);
    this.db.prepare('INSERT INTO message_fts (rowid, subject, fromName, fromAddr, toAddrs, bodyText) VALUES (?,?,?,?,?,?)').run(id, r.subject, r.fromName, r.fromAddr, r.toAddrs, r.bodyText);
  }

  private forgetFts(ids: number[]) {
    if (!ids.length) return;
    const del = this.db.prepare('DELETE FROM message_fts WHERE rowid = ?');
    for (const id of ids) del.run(id);
  }

  byUid(accountId: string, folder: string, uid: number): MessageRow | null {
    const r = this.db.prepare('SELECT * FROM message WHERE accountId = ? AND folder = ? AND uid = ?').get(clean(accountId, 64), clean(folder, 255), Number(uid)) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : null;
  }

  byId(id: number): MessageRow | null {
    const r = this.db.prepare('SELECT * FROM message WHERE id = ?').get(Number(id)) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : null;
  }

  body(id: number): MessageBody | null {
    const r = this.db.prepare('SELECT id, bodyText, rawHeader, bodyFetched, remoteContent FROM message WHERE id = ?').get(Number(id)) as Record<string, unknown> | undefined;
    if (!r) return null;
    const att = this.db.prepare('SELECT partId, filename, mime, size FROM attachment WHERE messageId = ? ORDER BY partId').all(Number(id)) as Record<string, unknown>[];
    return {
      id: Number(r.id),
      bodyText: String(r.bodyText),
      rawHeader: String(r.rawHeader),
      bodyFetched: Number(r.bodyFetched) === 1,
      remoteContent: Number(r.remoteContent) === 1,
      attachments: att.map((a) => ({ partId: String(a.partId), filename: String(a.filename), mime: String(a.mime), size: Number(a.size) })),
    };
  }

  private labelsOf(ids: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!ids.length) return out;
    const q = this.db.prepare(`SELECT ml.messageId AS m, l.name AS name FROM message_label ml JOIN label l ON l.id = ml.labelId WHERE ml.messageId = ?`);
    for (const id of ids) {
      const names = (q.all(id) as { name: string }[]).map((r) => r.name);
      if (names.length) out.set(id, names);
    }
    return out;
  }

  private toRow(r: Record<string, unknown>): MessageRow {
    return {
      id: Number(r.id),
      accountId: String(r.accountId),
      folder: String(r.folder),
      uid: Number(r.uid),
      messageId: String(r.messageId),
      threadId: String(r.threadId),
      subject: String(r.subject),
      fromName: String(r.fromName),
      fromAddr: String(r.fromAddr),
      toAddrs: String(r.toAddrs),
      ccAddrs: String(r.ccAddrs),
      replyTo: String(r.replyTo),
      sentAt: Number(r.sentAt),
      receivedAt: Number(r.receivedAt),
      size: Number(r.size),
      seen: Number(r.seen) === 1,
      readFlag: Number(r.readFlag) === 1,
      flagged: Number(r.flagged) === 1,
      answered: Number(r.answered) === 1,
      draft: Number(r.draft) === 1,
      junk: Number(r.junk) === 1,
      remoteContent: Number(r.remoteContent) === 1,
      hasAttachments: Number(r.hasAttachments) === 1,
      bodyFetched: Number(r.bodyFetched) === 1,
      source: String(r.source) as MessageSource,
      labels: [],
    };
  }

  /**
   * List headers. `sinceUid` drives incremental IMAP sync (the client asks for uids above its high
   * water mark). Flag filters are applied only when explicitly set, so "all mail" means all mail.
   */
  listMessages(
    opts: {
      accountId?: string;
      folder?: string;
      unseen?: boolean;
      unread?: boolean;
      flagged?: boolean;
      junk?: boolean;
      drafts?: boolean;
      hasAttachments?: boolean;
      sinceUid?: number;
      sort?: 'date' | 'sender' | 'subject';
      limit?: number;
      offset?: number;
    } = {},
  ): { messages: MessageRow[]; total: number } {
    const w: string[] = [];
    const a: Array<string | number> = [];
    const add = (sql: string, v: string | number) => {
      w.push(sql);
      a.push(v);
    };
    if (opts.accountId) add('accountId = ?', clean(opts.accountId, 64));
    if (opts.folder) add('folder = ?', clean(opts.folder, 255));
    if (opts.unseen) w.push('seen = 0');
    if (opts.unread) w.push('seen = 1 AND readFlag = 0');
    if (opts.flagged) w.push('flagged = 1');
    if (opts.drafts) w.push('draft = 1');
    if (opts.hasAttachments) w.push('hasAttachments = 1');
    if (opts.junk === true) w.push('junk = 1');
    if (opts.junk === false) w.push('junk = 0');
    if (opts.sinceUid !== undefined) add('uid > ?', Number(opts.sinceUid) || 0);
    const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
    const order =
      opts.sort === 'sender' ? 'fromAddr, receivedAt DESC' : opts.sort === 'subject' ? 'subject, receivedAt DESC' : 'receivedAt DESC';
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 200));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM message ${where}`).get(...a) as { n: number }).n);
    const rows = this.db.prepare(`SELECT * FROM message ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...a, limit, offset) as Record<string, unknown>[];
    const out = rows.map((r) => this.toRow(r));
    const labels = this.labelsOf(out.map((m) => m.id));
    for (const m of out) m.labels = labels.get(m.id) ?? [];
    return { messages: out, total };
  }

  /**
   * The highest uid stored for a folder — the high-water mark an incremental sync asks above.
   * Deliberately NOT "the uid of the newest message by date": a server may deliver an older Date
   * header after a newer one, and using that as the water mark re-fetches or skips messages.
   */
  maxUid(accountId: string, folder: string): number {
    const r = this.db.prepare('SELECT MAX(uid) AS m FROM message WHERE accountId = ? AND folder = ?').get(clean(accountId, 64), clean(folder, 255)) as { m: number | null } | undefined;
    return Number(r?.m ?? 0) || 0;
  }

  /**
   * Search with an expression the caller has ALREADY reduced (see `core/mail/ui.ts`'s parser).
   *
   * Deliberately separate from `search()`: `search()` runs its input through `ftsQuery`, which strips
   * it down to plain prefix terms — correct for a raw search box, but it DESTROYS a column filter
   * (`fromAddr:boss*`), which is how a `from:` search silently returned nothing.
   *
   * The caller must not pass raw user text here. The mail UI only ever passes `parseMailSearch`'s
   * output, whose values are already reduced to letters/digits/underscore.
   */
  searchExpr(expr: string | null, opts: { accountId?: string; folder?: string; source?: MessageSource; limit?: number } = {}): { hits: Array<MessageRow & { snippet: string }> } {
    if (!expr) return { hits: [] };
    const w = ['message_fts MATCH ?'];
    const a: Array<string | number> = [expr];
    if (opts.accountId) {
      w.push('m.accountId = ?');
      a.push(clean(opts.accountId, 64));
    }
    if (opts.folder) {
      w.push('m.folder = ?');
      a.push(clean(opts.folder, 255));
    }
    if (opts.source) {
      w.push('m.source = ?');
      a.push(opts.source);
    }
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    let rows: Record<string, unknown>[] = [];
    try {
      rows = this.db
        .prepare(
          `SELECT m.*, snippet(message_fts, -1, '[', ']', '\u2026', 12) AS snip
           FROM message_fts JOIN message m ON m.id = message_fts.rowid
           WHERE ${w.join(' AND ')} ORDER BY m.receivedAt DESC LIMIT ?`,
        )
        .all(...a, limit) as Record<string, unknown>[];
    } catch {
      // an expression FTS5 rejects yields nothing rather than throwing into a renderer
      return { hits: [] };
    }
    const out = rows.map((r) => ({ ...this.toRow(r), snippet: String(r.snip ?? '') }));
    const labels = this.labelsOf(out.map((m) => m.id));
    for (const m of out) m.labels = labels.get(m.id) ?? [];
    return { hits: out };
  }

  /** FTS5 search over subject / names / addresses / body, with a bounded snippet. */
  search(q: string, opts: { accountId?: string; folder?: string; source?: MessageSource; limit?: number } = {}): { hits: Array<MessageRow & { snippet: string }>; query: string | null } {
    const expr = ftsQuery(q);
    if (!expr) return { hits: [], query: null };
    const w = ['message_fts MATCH ?'];
    const a: Array<string | number> = [expr];
    if (opts.accountId) {
      w.push('m.accountId = ?');
      a.push(clean(opts.accountId, 64));
    }
    if (opts.folder) {
      w.push('m.folder = ?');
      a.push(clean(opts.folder, 255));
    }
    if (opts.source) {
      w.push('m.source = ?');
      a.push(opts.source);
    }
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    const rows = this.db
      .prepare(
        `SELECT m.*, snippet(message_fts, -1, '[', ']', '\u2026', 12) AS snip
         FROM message_fts JOIN message m ON m.id = message_fts.rowid
         WHERE ${w.join(' AND ')} ORDER BY m.receivedAt DESC LIMIT ?`,
      )
      .all(...a, limit) as Record<string, unknown>[];
    const out = rows.map((r) => ({ ...this.toRow(r), snippet: String(r.snip ?? '') }));
    const labels = this.labelsOf(out.map((m) => m.id));
    for (const m of out) m.labels = labels.get(m.id) ?? [];
    return { hits: out, query: expr };
  }

  counts(accountId?: string): MessageCounts {
    const w = accountId ? 'WHERE accountId = ?' : '';
    const a = accountId ? [clean(accountId, 64)] : [];
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen,
                SUM(CASE WHEN seen = 1 AND readFlag = 0 THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged,
                SUM(CASE WHEN draft = 1 THEN 1 ELSE 0 END) AS drafts,
                SUM(CASE WHEN junk = 1 THEN 1 ELSE 0 END) AS junk
         FROM message ${w}`,
      )
      .get(...a) as Record<string, unknown>;
    return {
      total: Number(r.total ?? 0),
      unseen: Number(r.unseen ?? 0),
      unread: Number(r.unread ?? 0),
      flagged: Number(r.flagged ?? 0),
      drafts: Number(r.drafts ?? 0),
      junk: Number(r.junk ?? 0),
    };
  }

  /** Per-folder counters for the panel (Vivaldi shows unseen AND unread per folder). */
  folderCounts(accountId: string): Array<{ folder: string; kind: FolderKind; counts: MessageCounts }> {
    const a = clean(accountId, 64);
    const rows = this.db
      .prepare(
        `SELECT folder,
                COUNT(*) AS total,
                SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen,
                SUM(CASE WHEN seen = 1 AND readFlag = 0 THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged,
                SUM(CASE WHEN draft = 1 THEN 1 ELSE 0 END) AS drafts,
                SUM(CASE WHEN junk = 1 THEN 1 ELSE 0 END) AS junk
         FROM message WHERE accountId = ? GROUP BY folder`,
      )
      .all(a) as Record<string, unknown>[];
    const kinds = new Map(this.listFolders(a).map((f) => [f.path, f.kind]));
    return rows.map((r) => ({
      folder: String(r.folder),
      kind: (kinds.get(String(r.folder)) ?? 'folder') as FolderKind,
      counts: {
        total: Number(r.total ?? 0),
        unseen: Number(r.unseen ?? 0),
        unread: Number(r.unread ?? 0),
        flagged: Number(r.flagged ?? 0),
        drafts: Number(r.drafts ?? 0),
        junk: Number(r.junk ?? 0),
      },
    }));
  }

  // ------------------------------------------------------------ flags and moves

  /** An ID list is the only way to address messages from the UI: no SQL and no wildcards cross IPC. */
  private ids(list: number[], max = 10_000): number[] {
    const out: number[] = [];
    for (const x of list) {
      const n = Number(x);
      if (Number.isInteger(n) && n > 0) out.push(n);
      if (out.length >= max) break;
    }
    return out;
  }

  setFlags(list: number[], patch: Partial<Pick<MessageHeader, 'seen' | 'readFlag' | 'flagged' | 'answered' | 'draft' | 'junk'>>): number {
    const cols = (['seen', 'readFlag', 'flagged', 'answered', 'draft', 'junk'] as const).filter((c) => patch[c] !== undefined);
    if (!cols.length) return 0;
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    const vals = cols.map((c) => (patch[c] ? 1 : 0));
    const st = this.db.prepare(`UPDATE message SET ${sets} WHERE id = ?`);
    let n = 0;
    for (const id of this.ids(list)) n += Number(st.run(...vals, id).changes);
    return n;
  }

  /**
   * Mark a folder seen up to a uid (IMAP \Seen semantics), used by "mark all read in folder".
   */
  markFolderSeen(accountId: string, folder: string, upToUid = Number.MAX_SAFE_INTEGER): number {
    return Number(
      this.db
        .prepare('UPDATE message SET seen = 1, readFlag = 1 WHERE accountId = ? AND folder = ? AND uid <= ? AND seen = 0')
        .run(clean(accountId, 64), clean(folder, 255), Number(upToUid) || 0).changes,
    );
  }

  /**
   * Move messages to another folder.
   *
   * HONEST LIMIT: on IMAP a move gives the message a NEW uid in the target folder. The store moves
   * the row optimistically and keeps its uid; the sync layer (ticket 36) reconciles and calls
   * `rekey` with the server's new uid. Without that call the message would appear under a uid the
   * server does not have, which is why `rekey` exists rather than a silent rewrite.
   */
  move(list: number[], toFolder: string): { moved: number; toFolder: string } {
    const f = clean(toFolder, 255);
    if (!f) return { moved: 0, toFolder: f };
    const st = this.db.prepare('UPDATE message SET folder = ? WHERE id = ?');
    let n = 0;
    for (const id of this.ids(list)) n += Number(st.run(f, id).changes);
    return { moved: n, toFolder: f };
  }

  /** Re-key one stored message after the server reported its new uid (a MOVE or a COPY). */
  rekey(id: number, folder: string, uid: number): Result<{ id: number }> {
    const row = this.byId(id);
    if (!row) return { ok: false, error: 'unknown message' };
    if (!Number.isInteger(Number(uid)) || Number(uid) <= 0) return { ok: false, error: 'uid must be a positive integer' };
    try {
      this.db.prepare('UPDATE message SET folder = ?, uid = ? WHERE id = ?').run(clean(folder, 255), Number(uid), id);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, id };
  }

  /**
   * Delete messages. This is the only hard delete in the store and it is deliberate: "delete" in the
   * UI is a MOVE to the trash folder; emptying the trash is what lands here, and it needs an explicit
   * confirmation because it is irreversible (the same discipline as the bookmark Trash).
   */
  deleteMessages(list: number[], confirm: boolean): { ok: boolean; deleted: number; wouldDelete: number } {
    const ids = this.ids(list);
    if (!confirm) return { ok: false, deleted: 0, wouldDelete: ids.length };
    this.forgetFts(ids);
    const st = this.db.prepare('DELETE FROM message WHERE id = ?');
    let n = 0;
    for (const id of ids) n += Number(st.run(id).changes);
    return { ok: true, deleted: n, wouldDelete: ids.length };
  }

  /** Empty one account's trash folder (still needs the confirmation argument). */
  emptyTrash(accountId: string, confirm: boolean): { ok: boolean; deleted: number; wouldDelete: number } {
    const a = clean(accountId, 64);
    const acc = this.listAccounts().find((x) => x.id === a);
    const folder = acc?.trashFolder || 'Trash';
    const ids = (this.db.prepare('SELECT id FROM message WHERE accountId = ? AND (folder = ? OR junk = 1)').all(a, folder) as { id: number }[]).map((r) => r.id);
    return this.deleteMessages(ids, confirm);
  }

  // ------------------------------------------------------------ threads

  /** A thread is a real grouping (subject + participants) computed by the sync layer, not a guess. */
  setThread(ids: number[], threadId: string): number {
    const t = clean(threadId, 255);
    if (!t) return 0;
    const st = this.db.prepare('UPDATE message SET threadId = ? WHERE id = ?');
    let n = 0;
    for (const id of this.ids(ids)) n += Number(st.run(t, id).changes);
    return n;
  }

  thread(threadId: string): MessageRow[] {
    const rows = this.db.prepare('SELECT * FROM message WHERE threadId = ? ORDER BY receivedAt').all(clean(threadId, 255)) as Record<string, unknown>[];
    return rows.map((r) => this.toRow(r));
  }

  /** Threads touching a folder, ordered by their newest message. */
  threadsIn(opts: { accountId: string; folder?: string; limit?: number }): Array<{ threadId: string; count: number; last: number; ids: number[] }> {
    const w = ['accountId = ?'];
    const a: Array<string | number> = [clean(opts.accountId, 64)];
    if (opts.folder) {
      w.push('folder = ?');
      a.push(clean(opts.folder, 255));
    }
    const rows = this.db
      .prepare(`SELECT threadId, COUNT(*) AS n, MAX(receivedAt) AS last, GROUP_CONCAT(id) AS ids FROM message WHERE ${w.join(' AND ')} GROUP BY threadId ORDER BY last DESC LIMIT ?`)
      .all(...a, Math.max(1, Math.min(1000, Number(opts.limit) || 200))) as Record<string, unknown>[];
    return rows.map((r) => ({
      threadId: String(r.threadId),
      count: Number(r.n ?? 0),
      last: Number(r.last ?? 0),
      ids: String(r.ids ?? '')
        .split(',')
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x > 0),
    }));
  }

  // ------------------------------------------------------------ labels / filters

  addLabel(id: string, name: string, color = '', accountId = ''): Result<{ id: string }> {
    const lid = clean(id, 64);
    if (!lid) return { ok: false, error: 'label needs an id' };
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM label').get() as { n: number }).n);
    if (n >= MAX_LABELS) return { ok: false, error: `at most ${MAX_LABELS} labels` };
    const c = /^#[0-9a-f]{3,8}$/i.test(color) ? color : '';
    this.db
      .prepare('INSERT INTO label (id, accountId, name, color) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color')
      .run(lid, clean(accountId, 64), clean(name), c);
    return { ok: true, id: lid };
  }

  listLabels(accountId?: string): Label[] {
    const rows = (accountId
      ? this.db.prepare('SELECT * FROM label WHERE accountId = ? OR accountId = \'\' ORDER BY name').all(clean(accountId, 64))
      : this.db.prepare('SELECT * FROM label ORDER BY name').all()) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), accountId: String(r.accountId), name: String(r.name), color: String(r.color) }));
  }

  removeLabel(id: string): number {
    return Number(this.db.prepare('DELETE FROM label WHERE id = ?').run(clean(id, 64)).changes);
  }

  addLabelToMessages(list: number[], labelId: string): number {
    const lid = clean(labelId, 64);
    if (!lid) return 0;
    const st = this.db.prepare('INSERT OR IGNORE INTO message_label (messageId, labelId) VALUES (?,?)');
    let n = 0;
    for (const id of this.ids(list)) n += Number(st.run(id, lid).changes);
    return n;
  }

  removeLabelFromMessages(list: number[], labelId: string): number {
    const lid = clean(labelId, 64);
    if (!lid) return 0;
    const st = this.db.prepare('DELETE FROM message_label WHERE messageId = ? AND labelId = ?');
    let n = 0;
    for (const id of this.ids(list)) n += Number(st.run(id, lid).changes);
    return n;
  }

  /** A filter's `expr` is a saved SEARCH ("from:boss subject:report"), not SQL; it is stored as text. */
  addFilter(f: { id: string; accountId?: string; name: string; expr: string; actions?: string; enabled?: boolean }): Result<{ id: string }> {
    const id = clean(f.id, 64);
    if (!id) return { ok: false, error: 'filter needs an id' };
    if (!clean(f.expr, 1000)) return { ok: false, error: 'filter needs a search expression' };
    this.db
      .prepare(
        `INSERT INTO filter (id, accountId, name, expr, actions, enabled, sortOrder) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, expr=excluded.expr, actions=excluded.actions, enabled=excluded.enabled`,
      )
      .run(id, clean(f.accountId ?? '', 64), clean(f.name), clean(f.expr, 1000), clean(f.actions ?? '', 1000), f.enabled === false ? 0 : 1, 0);
    return { ok: true, id };
  }

  listFilters(accountId?: string): Array<{ id: string; accountId: string; name: string; expr: string; actions: string; enabled: boolean }> {
    const rows = (accountId
      ? this.db.prepare('SELECT * FROM filter WHERE accountId = ? OR accountId = \'\' ORDER BY sortOrder, name').all(clean(accountId, 64))
      : this.db.prepare('SELECT * FROM filter ORDER BY sortOrder, name').all()) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      accountId: String(r.accountId),
      name: String(r.name),
      expr: String(r.expr),
      actions: String(r.actions),
      enabled: Number(r.enabled) === 1,
    }));
  }

  removeFilter(id: string): number {
    return Number(this.db.prepare('DELETE FROM filter WHERE id = ?').run(clean(id, 64)).changes);
  }

  // ------------------------------------------------------------ inspection (tests / diagnosis)

  /** Every column name in the store, so a test can assert what CANNOT be represented. */
  columnNames(): string[] {
    const out: string[] = [];
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of tables) {
      // single quotes: a double-quoted argument is an IDENTIFIER to SQLite, not a string
      const safe = t.replace(/'/g, "''");
      const st = this.db.prepare(`SELECT name FROM pragma_table_info('${safe}')`) as StatementSync;
      for (const r of st.all() as { name: string }[]) out.push(r.name);
    }
    return [...new Set(out)].sort();
  }

  /** The full DDL, for the same test. */
  schemaSql(): string {
    return (this.db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { sql: string }[]).map((r) => r.sql).join('\n');
  }
}

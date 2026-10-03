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
//  * `bodyText` NEVER HOLDS HTML. `htmlToText` strips tags with no parser and no fetch, so a hostile
//    tag soup cannot survive into the chrome UI, the preview or the FTS index. Whether the message
//    HAD remote content is a flag, so the UI can say "remote content was not loaded".
//  * The HTML body is kept APART, in `message_html` (schema v2, capped at MAX_BODY_HTML), for the
//    locked-down HTML reading view only (src/main/mail/html-view.ts: JavaScript off, own in-memory
//    session, every request cancelled). It is never indexed, never previewed, and never returned to
//    the chrome renderer: main reads it and loads it into that view, nothing else.
//  * Attachments are METADATA only (name / mime / size / IMAP section / transfer encoding / Content-ID,
//    schema v5). Bytes are never stored here and are never fetched implicitly — a fetch is an explicit
//    click (ticket 41). A draft's attached FILES live in the profile's private `mail-outbox/<draft>/`
//    directory (0700 / 0600, managed by the controller); this store keeps only their names and sizes.
//  * No gate, taint or agent-task state can be REPRESENTED: there is no column for it, and a test
//    reads the schema back and asserts that.
//  * `seen` and `readFlag` are distinct, because "never displayed" and "displayed but not dealt
//    with" are different things (Vivaldi's Unseen vs Unread), not a UI convention.
//
// Counters: `unseen` = seen=0; `unread` = seen=1 AND readFlag=0.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 6;
export const DB_FILE = 'mail.sqlite';

/** hard ceiling on stored messages; a store beyond this refuses writes instead of growing forever */
export const MAX_MESSAGES = 500_000;
/** per-message stored text ceiling (a 300 MB text body is a hostile input, not mail) */
export const MAX_BODY_TEXT = 200_000;
/** per-message stored HTML ceiling (the HTML reading view's document; larger bodies are truncated) */
export const MAX_BODY_HTML = 2 * 1024 * 1024;
/** stored raw header ceiling */
export const MAX_RAW_HEADER = 128_000;
export const MAX_STR = 400;
export const MAX_ADDRS = 2_000;
export const MAX_SUBJECT = 400;
export const MAX_ACCOUNTS = 24;
export const MAX_LABELS = 500;
/** local drafts per profile (ticket 38) */
export const MAX_DRAFTS = 500;
/** queued / failed outgoing messages per profile */
export const MAX_OUTBOX = 200;
/** a draft's text (the composed message is capped again, in bytes, by compose.ts) */
export const MAX_DRAFT_BODY = 10 * 1024 * 1024;
export const MAX_DRAFT_FIELD = 8_000;

export type FolderKind = 'folder' | 'inbox' | 'sent' | 'drafts' | 'outbox' | 'trash' | 'junk' | 'archive';
export type AccountKind = 'imap' | 'pop3' | 'local';
export type TlsMode = 'implicit' | 'starttls' | 'none';
/** SMTP has no plaintext mode: 465 implicit TLS or 587 STARTTLS */
export type SmtpTlsMode = 'implicit' | 'starttls';
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
  /** schema v4 (ticket 38): the submission server; an account from before v4 has host / 465 / implicit */
  smtpHost: string;
  smtpPort: number;
  smtpTls: SmtpTlsMode;
}

export type DraftMode = 'new' | 'reply' | 'replyAll' | 'forward';

/** A locally saved draft (ticket 38). Fields are what the user typed; nothing here is validated mail. */
export interface DraftRow {
  id: string;
  accountId: string;
  mode: DraftMode;
  /** the store id of the message replied to / forwarded (0 = a new message) */
  refMessage: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  includeQuoted: boolean;
  /** a forward carries the original's attachments (fetched from the server at send time) unless unchecked */
  forwardAttachments: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A file attached to a draft (ticket 41): metadata only, the bytes are the controller's private copy. */
export interface DraftAttachment {
  id: string;
  draftId: string;
  /** sanitized file name, as it will be sent */
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

export type OutboxStatus = 'queued' | 'sending' | 'failed';

/** An outgoing message that has not been accepted by the server yet. */
export interface OutboxRow {
  id: string;
  accountId: string;
  messageId: string;
  subject: string;
  /** recipient COUNT and their DOMAINS: the list view and the audit log never need the addresses */
  recipients: number;
  domains: string;
  status: OutboxStatus;
  error: string;
  attempts: number;
  /** 1 when a timer may retry it; 0 = only the user's Retry sends it (refusals, permanent errors) */
  autoRetry: boolean;
  nextAttemptAt: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxItem extends OutboxRow {
  envelopeFrom: string;
  envelopeTo: string[];
  /** the complete RFC 5322 message (7-bit ASCII), built once so a retry sends the same Message-ID */
  raw: string;
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
  /** an HTML body is stored for this message (the HTML itself is read with `html(id)`, in main only) */
  hasHtml: boolean;
  rawHeader: string;
  bodyFetched: boolean;
  remoteContent: boolean;
  attachments: Attachment[];
}

export interface Attachment {
  /** the IMAP section number (`2`, `1.3`) the bytes are fetched by */
  partId: string;
  filename: string;
  mime: string;
  /** decoded size in bytes (an estimate from the encoded size for base64) */
  size: number;
  /** Content-Transfer-Encoding, so the download decodes the right way */
  encoding?: string;
  disposition?: string;
  /** Content-ID without brackets ('' when none) */
  contentId?: string;
  /** an image the HTML body shows through cid: — rendered inline, not listed as an attachment */
  inline?: boolean;
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

/**
 * v4 (ticket 38): the account's submission server, local drafts and the outbox. An existing account
 * keeps working: its SMTP host is its IMAP host on 465 with implicit TLS until the user changes it.
 */
const SCHEMA_V4 = `
ALTER TABLE account ADD COLUMN smtpHost TEXT NOT NULL DEFAULT '';
ALTER TABLE account ADD COLUMN smtpPort INTEGER NOT NULL DEFAULT 465;
ALTER TABLE account ADD COLUMN smtpTls TEXT NOT NULL DEFAULT 'implicit';
UPDATE account SET smtpHost = host WHERE smtpHost = '';

CREATE TABLE draft (
  id            TEXT PRIMARY KEY,
  accountId     TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL DEFAULT 'new',
  refMessage    INTEGER NOT NULL DEFAULT 0,
  toAddrs       TEXT NOT NULL DEFAULT '',
  ccAddrs       TEXT NOT NULL DEFAULT '',
  bccAddrs      TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  includeQuoted INTEGER NOT NULL DEFAULT 0,
  createdAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  accountId     TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  messageId     TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  recipients    INTEGER NOT NULL DEFAULT 0,
  domains       TEXT NOT NULL DEFAULT '',
  envelopeFrom  TEXT NOT NULL DEFAULT '',
  envelopeTo    TEXT NOT NULL DEFAULT '[]',
  raw           TEXT NOT NULL DEFAULT '',
  bytes         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'queued',
  error         TEXT NOT NULL DEFAULT '',
  attempts      INTEGER NOT NULL DEFAULT 0,
  autoRetry     INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt INTEGER NOT NULL DEFAULT 0,
  createdAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * v5 (ticket 41): attachment rows learn their transfer encoding, disposition and Content-ID (the
 * download and the inline cid: images need them), drafts learn the forward-attachments choice, and a
 * draft's attached files are listed in `draft_attachment`. Rows written before v5 were numbered by
 * the MIME walk, not by IMAP section: they are dropped and their messages marked for a re-fetch on the
 * next OPEN (the text stays), exactly as v3 did for HTML; nothing is fetched in bulk.
 */
const SCHEMA_V5_ATTACHMENT_COLUMNS: Array<[string, string]> = [
  ['encoding', "TEXT NOT NULL DEFAULT ''"],
  ['disposition', "TEXT NOT NULL DEFAULT ''"],
  ['contentId', "TEXT NOT NULL DEFAULT ''"],
  ['inline', 'INTEGER NOT NULL DEFAULT 0'],
];
const SCHEMA_V5 = `
UPDATE message SET bodyFetched = 0 WHERE id IN (SELECT DISTINCT messageId FROM attachment);
DELETE FROM attachment;

CREATE TABLE IF NOT EXISTS draft_attachment (
  draftId   TEXT NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  mime      TEXT NOT NULL DEFAULT '',
  size      INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (draftId, id)
);
`;

/**
 * v6 (AI capabilities item 4): the triage cache. One row per message and model: the hash of exactly
 * what the model was given, and the VALIDATED facts it returned (JSON, re-validated on every read). A
 * body change deletes the message's rows (`setBody`), and a different input hash is a miss, so a cached
 * answer never outlives the text it describes. Deleted with its message.
 */
const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS triage (
  messageId INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  inputHash TEXT NOT NULL DEFAULT '',
  facts     TEXT NOT NULL DEFAULT '{}',
  valid     INTEGER NOT NULL DEFAULT 0,
  dropped   INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (messageId, model)
);
`;

/** v2: the HTML body, apart from the text, for the HTML reading view only (never indexed). */
const SCHEMA_V2 = `
CREATE TABLE message_html (
  messageId INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  html      TEXT NOT NULL DEFAULT ''
);
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
      // existing messages simply have no row here and keep showing their text
      if (v < 2) this.db.exec(SCHEMA_V2);
      // v3: bodies fetched before HTML was kept have text only. Mark them unfetched (the text stays) so
      // the next OPEN fetches the body again and stores its HTML; nothing is fetched in bulk.
      if (v < 3) this.db.exec('UPDATE message SET bodyFetched = 0 WHERE bodyFetched = 1 AND id NOT IN (SELECT messageId FROM message_html)');
      if (v < 4) this.db.exec(SCHEMA_V4);
      if (v < 5) {
        // column by column, so a store that already has some of them (a partial earlier upgrade) migrates
        const has = (table: string, col: string) => !!this.db.prepare(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
        for (const [col, def] of SCHEMA_V5_ATTACHMENT_COLUMNS) if (!has('attachment', col)) this.db.exec(`ALTER TABLE attachment ADD COLUMN ${col} ${def}`);
        if (!has('draft', 'forwardAttachments')) this.db.exec('ALTER TABLE draft ADD COLUMN forwardAttachments INTEGER NOT NULL DEFAULT 1');
        this.db.exec(SCHEMA_V5);
      }
      if (v < 6) this.db.exec(SCHEMA_V6);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Rows whose subject or sender name still holds RFC 2047 encoded-words (`=?UTF-8?B?...?=`), as
   * stored by sync before the IMAP ENVELOPE path decoded them, are rewritten with `decode`. The
   * decoder is passed in because it lives in mime.ts, which imports this module. Idempotent: a
   * decoded value has no `=?` left, so a second run touches nothing. Returns the rows changed.
   */
  repairEncodedHeaders(decode: (s: string) => string): number {
    const rows = this.db
      .prepare("SELECT id, subject, fromName FROM message WHERE subject LIKE '%=?%?=%' OR fromName LIKE '%=?%?=%'")
      .all() as Array<{ id: number; subject: string; fromName: string }>;
    if (!rows.length) return 0;
    const upd = this.db.prepare('UPDATE message SET subject = ?, fromName = ? WHERE id = ?');
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const subject = clean(decode(r.subject), 400);
        const fromName = clean(decode(r.fromName), 200);
        if (subject !== r.subject || fromName !== r.fromName) {
          upd.run(subject, fromName, r.id);
          n++;
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
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

  addAccount(a: Omit<MailAccount, 'sortOrder' | 'smtpHost' | 'smtpPort' | 'smtpTls'> & { sortOrder?: number } & Partial<Pick<MailAccount, 'smtpHost' | 'smtpPort' | 'smtpTls'>>): Result<{ id: string }> {
    const id = clean(a.id, 64);
    if (!id) return { ok: false, error: 'account needs an id' };
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n);
    if (count >= MAX_ACCOUNTS) return { ok: false, error: `at most ${MAX_ACCOUNTS} accounts` };
    const kinds = new Set<AccountKind>(['imap', 'pop3', 'local']);
    const tlsModes = new Set<TlsMode>(['implicit', 'starttls', 'none']);
    const kind: AccountKind = kinds.has(a.kind) ? a.kind : 'imap';
    const tls: TlsMode = tlsModes.has(a.tls) ? a.tls : 'implicit';
    const smtpTls: SmtpTlsMode = a.smtpTls === 'starttls' ? 'starttls' : 'implicit';
    const smtpPort = Math.max(0, Math.min(65535, Number(a.smtpPort) || 0)) || (smtpTls === 'starttls' ? 587 : 465);
    this.db
      .prepare(
        `INSERT INTO account (id, name, address, kind, host, port, tls, username, sentFolder, trashFolder, junkFolder, archiveFolder, sortOrder, smtpHost, smtpPort, smtpTls)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, kind=excluded.kind, host=excluded.host,
           port=excluded.port, tls=excluded.tls, username=excluded.username, sentFolder=excluded.sentFolder,
           trashFolder=excluded.trashFolder, junkFolder=excluded.junkFolder, archiveFolder=excluded.archiveFolder,
           sortOrder=excluded.sortOrder, smtpHost=excluded.smtpHost, smtpPort=excluded.smtpPort, smtpTls=excluded.smtpTls`,
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
        clean(a.smtpHost || a.host, 255),
        smtpPort,
        smtpTls,
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
      smtpHost: String(r.smtpHost || r.host),
      smtpPort: Number(r.smtpPort) || 465,
      smtpTls: String(r.smtpTls) === 'starttls' ? 'starttls' : 'implicit',
    }));
  }

  /** Removes the account and everything under it (folders, messages, labels, filters, FTS rows). */
  removeAccount(id: string): { removed: number } {
    const ids = (this.db.prepare('SELECT id FROM message WHERE accountId = ?').all(clean(id, 64)) as { id: number }[]).map((r) => r.id);
    this.forgetFts(ids);
    const n = this.db.prepare('DELETE FROM account WHERE id = ?').run(clean(id, 64)).changes;
    this.db.prepare('DELETE FROM label WHERE accountId = ?').run(clean(id, 64));
    this.db.prepare('DELETE FROM filter WHERE accountId = ?').run(clean(id, 64));
    this.db.prepare('DELETE FROM draft WHERE accountId = ?').run(clean(id, 64));
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
   * Store a fetched body. `bodyText` is TEXT only: when there is no plain part the HTML is converted
   * here. The HTML itself goes to `message_html` (capped, never indexed) for the HTML reading view;
   * an empty `html` removes any stored one. `rawHeader` is stored capped for "view source" (ticket 37).
   */
  setBody(accountId: string, folder: string, uid: number, body: { text?: string; html?: string; rawHeader?: string; attachments?: Attachment[] }): Result<{ id: number }> {
    const row = this.byUid(accountId, folder, uid);
    if (!row) return { ok: false, error: 'unknown message' };
    const before = (this.db.prepare('SELECT bodyText FROM message WHERE id = ?').get(row.id) as { bodyText: string } | undefined)?.bodyText ?? '';
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
    const html = typeof body.html === 'string' ? body.html.slice(0, MAX_BODY_HTML) : '';
    if (html.trim()) this.db.prepare('INSERT OR REPLACE INTO message_html (messageId, html) VALUES (?, ?)').run(row.id, html);
    else this.db.prepare('DELETE FROM message_html WHERE messageId = ?').run(row.id);
    if (body.attachments) this.setAttachments(row.id, body.attachments);
    this.indexMessage(row.id);
    // a triage answer describes the text it was given: a different body invalidates it
    if (text !== before) this.triageForget(row.id);
    return { ok: true, id: row.id };
  }

  setAttachments(messageId: number, items: Attachment[]): void {
    this.db.prepare('DELETE FROM attachment WHERE messageId = ?').run(messageId);
    const ins = this.db.prepare('INSERT OR REPLACE INTO attachment (messageId, partId, filename, mime, size, encoding, disposition, contentId, inline) VALUES (?,?,?,?,?,?,?,?,?)');
    let n = 0;
    let listed = 0;
    for (const a of items) {
      if (n++ >= 200) break; // a message claiming 10 000 parts is hostile
      ins.run(
        messageId,
        clean(a.partId, 64),
        clean(a.filename, 255),
        clean(a.mime, 128),
        Math.max(0, Number(a.size) || 0),
        clean(a.encoding ?? '', 40).toLowerCase(),
        clean(a.disposition ?? '', 40).toLowerCase(),
        clean(a.contentId ?? '', 256),
        a.inline ? 1 : 0,
      );
      if (!a.inline) listed++;
    }
    // the list's paperclip means "something to download": inline images do not count
    this.db.prepare('UPDATE message SET hasAttachments = ? WHERE id = ?').run(listed ? 1 : 0, messageId);
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
    const att = this.db.prepare('SELECT partId, filename, mime, size, encoding, disposition, contentId, inline FROM attachment WHERE messageId = ? ORDER BY rowid').all(Number(id)) as Record<string, unknown>[];
    const hasHtml = !!this.db.prepare('SELECT 1 AS x FROM message_html WHERE messageId = ?').get(Number(id));
    return {
      id: Number(r.id),
      bodyText: String(r.bodyText),
      hasHtml,
      rawHeader: String(r.rawHeader),
      bodyFetched: Number(r.bodyFetched) === 1,
      remoteContent: Number(r.remoteContent) === 1,
      attachments: att.map((a) => ({
        partId: String(a.partId),
        filename: String(a.filename),
        mime: String(a.mime),
        size: Number(a.size),
        encoding: String(a.encoding),
        disposition: String(a.disposition),
        contentId: String(a.contentId),
        inline: Number(a.inline) === 1,
      })),
    };
  }

  /** The stored HTML body, or null. For the main-process HTML reading view ONLY: never sent to a renderer. */
  html(id: number): string | null {
    const r = this.db.prepare('SELECT html FROM message_html WHERE messageId = ?').get(Number(id)) as { html: string } | undefined;
    return r && r.html ? r.html : null;
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
      /** readFlag = 0: not yet read (unseen OR seen-but-unread) — the triage "unread" range */
      notRead?: boolean;
      /** receivedAt at or after this time (ms) */
      since?: number;
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
    if (opts.notRead) w.push('readFlag = 0');
    if (opts.since !== undefined) add('receivedAt >= ?', Number(opts.since) || 0);
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

  // ------------------------------------------------------------ triage cache (item 4)

  /** The cached triage answer of one message for one model, or null. The caller re-validates `facts`. */
  triageGet(messageId: number, model: string): { inputHash: string; facts: string; valid: boolean; dropped: number } | null {
    const r = this.db.prepare('SELECT inputHash, facts, valid, dropped FROM triage WHERE messageId = ? AND model = ?').get(Number(messageId), clean(model, 300)) as
      | { inputHash: string; facts: string; valid: number; dropped: number }
      | undefined;
    return r ? { inputHash: String(r.inputHash), facts: String(r.facts), valid: Number(r.valid) === 1, dropped: Number(r.dropped) } : null;
  }

  triagePut(messageId: number, model: string, entry: { inputHash: string; facts: unknown; valid: boolean; dropped: number }): void {
    if (!this.byId(messageId)) return;
    this.db
      .prepare('INSERT OR REPLACE INTO triage (messageId, model, inputHash, facts, valid, dropped, createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(Number(messageId), clean(model, 300), clean(entry.inputHash, 64), JSON.stringify(entry.facts ?? {}).slice(0, 4_000), entry.valid ? 1 : 0, Math.max(0, Math.floor(Number(entry.dropped) || 0)), nowMs());
  }

  /** Drop every cached triage answer of one message (all models). */
  triageForget(messageId: number): number {
    return Number(this.db.prepare('DELETE FROM triage WHERE messageId = ?').run(Number(messageId)).changes);
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

  // ------------------------------------------------------------ drafts (ticket 38)

  /**
   * Save (insert or replace) a local draft. The fields are stored as typed, length-capped: a draft is
   * work in progress, and it is validated as mail only when it is SENT (compose.ts refuses a line
   * break in a header field there, with a message, rather than this method silently dropping it).
   */
  saveDraft(d: Partial<Omit<DraftRow, 'createdAt' | 'updatedAt'>> & { id?: string }): Result<{ id: string }> {
    const existing = d.id ? this.getDraft(String(d.id)) : null;
    if (!existing) {
      const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM draft').get() as { n: number }).n);
      if (n >= MAX_DRAFTS) return { ok: false, error: `at most ${MAX_DRAFTS} drafts; delete some first` };
    }
    const id = existing?.id ?? (d.id && /^[A-Za-z0-9_-]{8,64}$/.test(String(d.id)) ? String(d.id) : randomUUID());
    const modes = new Set<DraftMode>(['new', 'reply', 'replyAll', 'forward']);
    const f = (v: unknown) => String(v ?? '').slice(0, MAX_DRAFT_FIELD);
    const now = nowMs();
    this.db
      .prepare(
        `INSERT INTO draft (id, accountId, mode, refMessage, toAddrs, ccAddrs, bccAddrs, subject, body, includeQuoted, forwardAttachments, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET accountId=excluded.accountId, mode=excluded.mode, refMessage=excluded.refMessage,
           toAddrs=excluded.toAddrs, ccAddrs=excluded.ccAddrs, bccAddrs=excluded.bccAddrs, subject=excluded.subject,
           body=excluded.body, includeQuoted=excluded.includeQuoted, forwardAttachments=excluded.forwardAttachments, updatedAt=excluded.updatedAt`,
      )
      .run(
        id,
        clean(d.accountId, 64),
        modes.has(d.mode as DraftMode) ? (d.mode as DraftMode) : 'new',
        Math.max(0, Math.floor(Number(d.refMessage) || 0)),
        f(d.to),
        f(d.cc),
        f(d.bcc),
        f(d.subject),
        String(d.body ?? '').slice(0, MAX_DRAFT_BODY),
        d.includeQuoted ? 1 : 0,
        d.forwardAttachments === false ? 0 : 1,
        existing?.createdAt ?? now,
        now,
      );
    return { ok: true, id };
  }

  private toDraft(r: Record<string, unknown>): DraftRow {
    return {
      id: String(r.id),
      accountId: String(r.accountId),
      mode: String(r.mode) as DraftMode,
      refMessage: Number(r.refMessage),
      to: String(r.toAddrs),
      cc: String(r.ccAddrs),
      bcc: String(r.bccAddrs),
      subject: String(r.subject),
      body: String(r.body),
      includeQuoted: Number(r.includeQuoted) === 1,
      forwardAttachments: Number(r.forwardAttachments) !== 0,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  getDraft(id: string): DraftRow | null {
    const r = this.db.prepare('SELECT * FROM draft WHERE id = ?').get(String(id ?? '').slice(0, 64)) as Record<string, unknown> | undefined;
    return r ? this.toDraft(r) : null;
  }

  listDrafts(accountId?: string): DraftRow[] {
    const rows = (accountId
      ? this.db.prepare('SELECT * FROM draft WHERE accountId = ? ORDER BY updatedAt DESC').all(clean(accountId, 64))
      : this.db.prepare('SELECT * FROM draft ORDER BY updatedAt DESC').all()) as Record<string, unknown>[];
    return rows.map((r) => this.toDraft(r));
  }

  deleteDraft(id: string): number {
    return Number(this.db.prepare('DELETE FROM draft WHERE id = ?').run(String(id ?? '').slice(0, 64)).changes);
  }

  // ------------------------------------------------------------ draft attachments (ticket 41)

  addDraftAttachment(a: { draftId: string; id: string; name: string; mime: string; size: number }): Result<{ id: string }> {
    if (!this.getDraft(a.draftId)) return { ok: false, error: 'unknown draft' };
    try {
      this.db
        .prepare('INSERT INTO draft_attachment (draftId, id, name, mime, size, createdAt) VALUES (?,?,?,?,?,?)')
        .run(String(a.draftId).slice(0, 64), String(a.id).slice(0, 64), clean(a.name, 255), clean(a.mime, 128), Math.max(0, Math.floor(Number(a.size) || 0)), nowMs());
    } catch (e) {
      return { ok: false, error: `the attachment could not be recorded: ${(e as Error).message.slice(0, 80)}` };
    }
    return { ok: true, id: a.id };
  }

  listDraftAttachments(draftId: string): DraftAttachment[] {
    const rows = this.db.prepare('SELECT * FROM draft_attachment WHERE draftId = ? ORDER BY createdAt, rowid').all(String(draftId ?? '').slice(0, 64)) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), draftId: String(r.draftId), name: String(r.name), mime: String(r.mime), size: Number(r.size), createdAt: Number(r.createdAt) }));
  }

  removeDraftAttachment(draftId: string, id: string): number {
    return Number(this.db.prepare('DELETE FROM draft_attachment WHERE draftId = ? AND id = ?').run(String(draftId ?? '').slice(0, 64), String(id ?? '').slice(0, 64)).changes);
  }

  /** every draft id (the controller removes attachment directories that belong to none) */
  draftIds(): string[] {
    return (this.db.prepare('SELECT id FROM draft').all() as Array<{ id: string }>).map((r) => String(r.id));
  }

  // ------------------------------------------------------------ outbox (ticket 38)

  addOutbox(o: { accountId: string; messageId: string; subject: string; envelopeFrom: string; envelopeTo: string[]; domains: string[]; raw: string; bytes: number }): Result<{ id: string }> {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n);
    if (n >= MAX_OUTBOX) return { ok: false, error: `the Outbox already holds ${MAX_OUTBOX} messages; send or delete some first` };
    const id = randomUUID();
    const now = nowMs();
    try {
      this.db
        .prepare(
          `INSERT INTO outbox (id, accountId, messageId, subject, recipients, domains, envelopeFrom, envelopeTo, raw, bytes, status, createdAt, updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'queued', ?, ?)`,
        )
        .run(id, clean(o.accountId, 64), clean(o.messageId, 998), clean(o.subject, MAX_SUBJECT), o.envelopeTo.length, o.domains.join(',').slice(0, MAX_ADDRS), clean(o.envelopeFrom, 320), JSON.stringify(o.envelopeTo), o.raw, Math.max(0, Number(o.bytes) || 0), now, now);
    } catch (e) {
      return { ok: false, error: `the Outbox could not store the message: ${(e as Error).message.slice(0, 80)}` };
    }
    return { ok: true, id };
  }

  private toOutboxRow(r: Record<string, unknown>): OutboxRow {
    return {
      id: String(r.id),
      accountId: String(r.accountId),
      messageId: String(r.messageId),
      subject: String(r.subject),
      recipients: Number(r.recipients),
      domains: String(r.domains),
      status: String(r.status) as OutboxStatus,
      error: String(r.error),
      attempts: Number(r.attempts),
      autoRetry: Number(r.autoRetry) === 1,
      nextAttemptAt: Number(r.nextAttemptAt),
      bytes: Number(r.bytes),
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  /** The list view's rows: no message bytes, no addresses. */
  listOutbox(accountId?: string): OutboxRow[] {
    const cols = 'id, accountId, messageId, subject, recipients, domains, status, error, attempts, autoRetry, nextAttemptAt, bytes, createdAt, updatedAt';
    const rows = (accountId
      ? this.db.prepare(`SELECT ${cols} FROM outbox WHERE accountId = ? ORDER BY createdAt`).all(clean(accountId, 64))
      : this.db.prepare(`SELECT ${cols} FROM outbox ORDER BY createdAt`).all()) as Record<string, unknown>[];
    return rows.map((r) => this.toOutboxRow(r));
  }

  getOutbox(id: string): OutboxItem | null {
    const r = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(String(id ?? '').slice(0, 64)) as Record<string, unknown> | undefined;
    if (!r) return null;
    let to: string[] = [];
    try {
      const v = JSON.parse(String(r.envelopeTo)) as unknown;
      if (Array.isArray(v)) to = v.map((x) => String(x));
    } catch {
      to = [];
    }
    return { ...this.toOutboxRow(r), envelopeFrom: String(r.envelopeFrom), envelopeTo: to, raw: String(r.raw) };
  }

  updateOutbox(id: string, p: Partial<Pick<OutboxRow, 'status' | 'error' | 'attempts' | 'autoRetry' | 'nextAttemptAt'>>): number {
    const cur = this.getOutbox(id);
    if (!cur) return 0;
    const statuses = new Set<OutboxStatus>(['queued', 'sending', 'failed']);
    return Number(
      this.db
        .prepare('UPDATE outbox SET status = ?, error = ?, attempts = ?, autoRetry = ?, nextAttemptAt = ?, updatedAt = ? WHERE id = ?')
        .run(
          p.status && statuses.has(p.status) ? p.status : cur.status,
          String(p.error ?? cur.error).slice(0, 600),
          Math.max(0, Math.floor(Number(p.attempts ?? cur.attempts) || 0)),
          (p.autoRetry ?? cur.autoRetry) ? 1 : 0,
          Math.max(0, Number(p.nextAttemptAt ?? cur.nextAttemptAt) || 0),
          nowMs(),
          cur.id,
        ).changes,
    );
  }

  deleteOutbox(id: string): number {
    return Number(this.db.prepare('DELETE FROM outbox WHERE id = ?').run(String(id ?? '').slice(0, 64)).changes);
  }

  /**
   * After a restart: nothing is retried behind the user's back. An item that was mid-send when the
   * app stopped may or may not have been delivered, and says so; every item waits for a Retry.
   */
  recoverOutbox(): number {
    const now = nowMs();
    const a = this.db
      .prepare(`UPDATE outbox SET status = 'failed', autoRetry = 0, nextAttemptAt = 0, updatedAt = ?, error = 'the app closed while this was being sent; it may or may not have been delivered. Press Retry to send it again.' WHERE status = 'sending'`)
      .run(now).changes;
    const b = this.db
      .prepare(`UPDATE outbox SET status = 'failed', autoRetry = 0, nextAttemptAt = 0, updatedAt = ?, error = CASE WHEN error = '' THEN 'not sent yet: press Retry to send it' ELSE error END WHERE status = 'queued' OR autoRetry = 1`)
      .run(now).changes;
    return Number(a) + Number(b);
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

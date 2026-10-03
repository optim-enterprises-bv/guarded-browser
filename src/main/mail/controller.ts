// Mail inside the browser window (ticket 37c) — the mail UI is a PANEL, not a second window.
//
// Why it moved: the first version opened a separate `BrowserWindow`. That was defensible on the
// "message text must not share a document with the agent panel" rule, but it is not what the user
// wants to use, and the honest reading of the rule is narrower than I first applied it — the chrome
// renderer is `contextIsolation` + `sandbox`, has no node, loads no page, and its bridge is an
// allowlist. Mail text rendered there reaches exactly as far as `renderer.ts`'s existing history and
// bookmark text: a text node, in a document no page can reach.
//
// What replaces the window:
//   * `state` / everything below lives per PROFILE (this module is constructed by runtime.ts), so the
//     mail store and the secret store are the profile's own — no new identity boundary, no shared state;
//   * every handler is registered on the profile's `on(...)` table, which `main.ts` already resolves
//     from the SENDER's window. That is why a web panel or a page still cannot call `mail:*`;
//   * `sendUI('mail', ...)` carries NUMBERS and booleans only (unread count, locked, sync state).
//     Message text is never pushed to the renderer: it is returned by `mail:message` when the user
//     opens a message, which is the same request/response shape the rest of the chrome uses.
//
// The gate rules are unchanged and stay here: a connection is refused while an agent task runs or a
// confirmation is pending, and a message is only fetched when the user opens it.
//
// Sending (ticket 38) follows the same rules, plus two of its own:
//   * a Send while the gate is closed puts the message in the OUTBOX with the reason and does NOT
//     send it later on its own — only the user's Send / Retry does (`deliver`). Automatic retries
//     exist for transient failures only, and a task starting cancels every pending one;
//   * reply / forward text is quoted from the STORED TEXT body (`finalBody`), never from HTML and
//     never from anything the renderer sends.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { decodeWords } from '../../core/mail/mime';
import { MailStore, DB_FILE, type MessageRow, type DraftMode, type Attachment } from '../../core/mail/store';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSE_ATTACHMENT_BYTES,
  MAX_COMPOSE_ATTACHMENTS,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  attachmentName,
  decodeTransfer,
  mimeForFilename,
  normalizeCid,
  referencedCids,
  sanitizeFilename,
  sniffImage,
} from '../../core/mail/attachments';
import { fileRisk } from '../../core/downloads';
import { SecretStore, SECRETS_FILE, plaintextWarning, keychainBackend } from './secrets';
import { normalizeAccount, testAccount, type MailAccount } from './accounts';
import { MailSyncer } from './sync';
import { makeSocketFactory, makeSmtpSocketFactory } from './socket';
import type { SocketFactory } from '../../core/mail/imap';
import { smtpSend, type SmtpAuth, type SmtpResult, type SmtpSocketFactory } from '../../core/mail/smtp';
import {
  buildMessage,
  buildReferences,
  type OutgoingAttachment,
  forwardBlock,
  forwardSubject,
  formatAddressForInput,
  quoteOriginal,
  recipientDomains,
  replyRecipients,
  replySubject,
  MAX_BODY_CHARS,
  MAX_ADDRESS_FIELD,
  MAX_SUBJECT_CHARS,
} from '../../core/mail/compose';
import { headerGet, parseHeaders } from '../../core/mail/mime';
import { nextBackoff } from './sync';
import { parseHimalayaConfig, buildImportPlan, HIMALAYA_CONFIG, type ImportPlan } from './import';
import { DEFAULT_VIEW, buildFolderTree, groupThreads, listRowFrom, readingHeader, externalContentNotice, parseMailSearch, REMOTE_IMAGES_NOTICE, type ViewFilter } from '../../core/mail/ui';
import { sanitizeMailHtml } from '../../core/mail/html';
import { MailTriage, type TriageLlm } from './triage';
import type { Guard } from '../../core/types';

export interface MailControllerDeps {
  /** this profile's app-state directory (the store and the secrets live here) */
  profileDir: string;
  /** the app's gate: refuse while a task runs or a confirmation is pending */
  canConnect: () => { ok: boolean; reason?: string };
  audit: (kind: string, detail: Record<string, unknown>) => void;
  /** push the unread count to the chrome (a NUMBER; never message text) */
  sendUnread: (n: number) => void;
  /** the user's home directory, for the default config path (injectable in tests) */
  home?: string;
  /** Electron's safeStorage, so the UI reports the REAL keyring rather than "unknown" */
  safeStorage?: Parameters<typeof keychainBackend>[0];
  /** test seam: the IMAP socket factory (production: the audited TLS factory from socket.ts) */
  makeSocket?: SocketFactory;
  /** test seam: the SMTP socket factory (production: makeSmtpSocketFactory from socket.ts) */
  makeSmtpSocket?: SmtpSocketFactory;
  /**
   * TEST ONLY: an extra trusted CA for loopback mail servers (socket.ts `testCa`). The runtime sets it
   * from `testEnv('GUARDED_TEST_MAIL_CA')`, which a packaged build never honours.
   */
  testTlsCa?: string;
  /** the first automatic retry's delay (doubles per attempt); tests shorten it */
  retryBaseMs?: number;
  /** per-step SMTP timeout (tests shorten it) */
  smtpTimeoutMs?: number;
  /**
   * Ticket 41: write a downloaded attachment through the browser's download path (the downloads
   * folder, a unique never-overwriting name, the downloads list with its dangerous-file warning).
   * Absent = downloads unavailable.
   */
  saveDownload?: (f: { name: string; mime: string; bytes: Buffer }) => { ok: true; path: string } | { ok: false; error: string };
  /** the "Open" confirmation, shown by MAIN (a native dialog): true only for an explicit yes */
  confirmOpen?: (q: { name: string; mime: string; warning: string; executable: boolean }) => Promise<boolean>;
  /** open a saved file with the system handler; resolves '' on success, else the error */
  openPath?: (path: string) => Promise<string>;
  /** the system file picker, run by MAIN; resolves the chosen paths ([] = cancelled). The renderer never supplies a path. */
  pickFiles?: () => Promise<string[]>;
  /**
   * Item 4, safe inbox triage: the quarantined `triage` role (no tools), the shared guard that screens
   * what it is given, and the identity of its model for the cache. Absent = triage unavailable.
   */
  triage?: {
    client: () => TriageLlm;
    guard: () => Guard;
    modelId: () => string;
    fallbackNotice: () => string | null;
  };
}

/** where a draft's attached files are kept: `<profile>/mail-outbox/<draft id>/<attachment id>` */
export const OUTBOX_DIR = 'mail-outbox';
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The largest literal a part with this decoded cap can arrive in (base64 is 4/3 + line breaks; QP up to 3x). */
function encodedCap(encoding: string | undefined, decodedCap: number): number {
  const e = String(encoding ?? '').toLowerCase();
  if (e === 'base64') return Math.ceil((decodedCap * 4) / 3 / 76) * 78 + 1024;
  if (e === 'quoted-printable') return decodedCap * 3 + 1024;
  return decodedCap + 1024;
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/** automatic retries per outbox item (transient failures only); the user's Retry is never limited */
export const MAX_AUTO_ATTEMPTS = 5;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 30 * 60_000;

/** Gmail files every message sent through its SMTP in Sent itself: an APPEND would duplicate it. */
export function serverFilesSentMail(a: { host: string; smtpHost?: string }): boolean {
  return [a.host, a.smtpHost ?? ''].some((h) => /(^|\.)(gmail|googlemail)\.com$/i.test(h.trim()));
}

/** What the renderer may send for a compose form. Every field is re-read here, typed and capped. */
export interface ComposeFields {
  draftId: string;
  accountId: string;
  mode: DraftMode;
  refMessage: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  includeQuoted: boolean;
  /** a forward carries the original's attachments unless the user unticked it */
  forwardAttachments: boolean;
}

export function composeFields(input: unknown): ComposeFields {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  // one character over each cap is kept, so compose.ts REFUSES an over-long field instead of this
  // function silently truncating it
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max + 1) : '');
  const mode = o.mode === 'reply' || o.mode === 'replyAll' || o.mode === 'forward' ? o.mode : 'new';
  return {
    draftId: str(o.draftId, 64),
    accountId: str(o.accountId, 64),
    mode,
    refMessage: mode === 'new' ? 0 : Math.max(0, Math.floor(Number(o.refMessage) || 0)),
    to: str(o.to, MAX_ADDRESS_FIELD),
    cc: str(o.cc, MAX_ADDRESS_FIELD),
    bcc: str(o.bcc, MAX_ADDRESS_FIELD),
    subject: str(o.subject, MAX_SUBJECT_CHARS),
    body: str(o.body, MAX_BODY_CHARS),
    includeQuoted: o.includeQuoted === true,
    forwardAttachments: o.forwardAttachments !== false,
  };
}

export interface SendResult {
  ok: boolean;
  outboxId?: string;
  /** the message is in the Outbox (refused, failed, or waiting for a retry) */
  queued?: boolean;
  /** the gate's reason, when the send was refused because a task runs / a confirmation is pending */
  refused?: string;
  error?: string;
  stage?: SmtpResult['stage'];
  rejected?: SmtpResult['rejected'];
  accepted?: number;
  retryInMs?: number;
  /** what happened to the copy in Sent: appended, skipped (the server files it), or failed (reported) */
  sentCopy?: 'appended' | 'skipped' | 'failed';
  sentCopyError?: string;
}

export interface MailSendable {
  ok: boolean;
  error?: string;
}

/**
 * One profile's mail. Constructed lazily by runtime.ts? No — constructed eagerly, because it only
 * opens the sqlite file when there is one, and a profile with no mail pays a few hundred microseconds
 * for the check. The SECRET store is opened on first use, so a user who never opens mail never gets a
 * secrets file.
 */
export class MailController {
  private store: MailStore | null = null;
  private secrets: SecretStore | null = null;
  private readonly accounts = new Map<string, MailAccount>();
  private readonly syncers = new Map<string, MailSyncer>();
  private view: ViewFilter = { ...DEFAULT_VIEW };
  private lastError: string | null = null;
  /** true once a sync has been attempted for any account (drives the "not synced yet" wording) */
  private synced = false;
  /** outbox ids being sent right now, with the flag that abandons the send (a task started) */
  private readonly inFlight = new Map<string, { aborted: boolean }>();
  /** automatic retries waiting to fire (transient failures only) */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** drafts whose Send is being processed: a second click is refused instead of sending twice */
  private readonly sendingDrafts = new Set<string>();
  /** set by dispose(): nothing may reopen the store or a connection afterwards */
  private disposed = false;
  /** attachments saved this session (message id + section -> path), so Open reuses the download */
  private readonly downloaded = new Map<string, string>();
  /** inline cid: images per message (data: URLs), so redisplaying a message does not refetch them */
  private readonly inlineCache = new Map<number, Map<string, string>>();

  /** item 4: the triage runner, created on first use */
  private triager: MailTriage | null = null;

  constructor(private readonly deps: MailControllerDeps) {}

  // ------------------------------------------------------------ triage (AI capabilities item 4)

  /** The triage runner. Its every network or model step passes this controller's gate. */
  triage(): MailTriage {
    const t = this.deps.triage;
    if (!t) throw new Error('triage is not available here');
    this.triager ??= new MailTriage({
      store: () => this.db(),
      canConnect: this.deps.canConnect,
      audit: this.deps.audit,
      guard: t.guard,
      client: t.client,
      modelId: t.modelId,
      fallbackNotice: t.fallbackNotice,
      fetchBody: (row) => this.fetchForTriage(row),
      accountIds: () => this.db().listAccounts().map((a) => a.id),
      folders: (id) => this.db().listFolders(id),
      archiveFolder: (id) => (this.accounts.get(id) ?? this.accountFor(id))?.archiveFolder || 'Archive',
      move: (ids, to) => this.move(ids, to),
      setFlags: (ids, patch) => this.setFlags(ids, patch),
      composeInit: (id) => this.composeInit('reply', id) as Record<string, unknown> & { ok: boolean; error?: string },
      draftSave: (fields) => this.draftSave(fields),
    });
    return this.triager;
  }

  /**
   * A never-fetched body, for triage: through the gated syncer with BODY.PEEK, and the message stays
   * as unread as it was (`fetchBody` records a sighting; a triage pass is not one).
   */
  private async fetchForTriage(row: MessageRow): Promise<boolean> {
    if (!this.deps.canConnect().ok) return false;
    const s = this.syncerFor(row.accountId);
    if (!s) return false;
    const r = await s.fetchBody(row.folder, row.uid, { markRead: false });
    this.db().setFlags([row.id], { seen: row.seen });
    return r.ok;
  }

  // ------------------------------------------------------------ lazy handles

  /** The mail store, opened on first use. Throws only if the file cannot be opened at all. */
  private db(): MailStore {
    if (this.disposed) throw new Error('mail is closed (the window was closed)');
    if (!this.store) {
      this.store = new MailStore(join(this.deps.profileDir, DB_FILE));
      // nothing left over from the last run is sent behind the user's back
      this.store.recoverOutbox();
      // subjects / names stored still encoded (before sync decoded the ENVELOPE) are fixed once
      this.store.repairEncodedHeaders((v) => decodeWords(v));
      // attachment copies of drafts that no longer exist (discarded while the app was down, an account removed)
      this.pruneDraftDirs();
      for (const a of this.store.listAccounts()) {
        const norm = this.accountFor(a.id);
        if (norm) this.accounts.set(a.id, norm);
      }
    }
    return this.store;
  }

  /** The secret store, opened (and NOT unlocked) on first use. */
  private sec(): SecretStore {
    if (!this.secrets) {
      const opened = SecretStore.open(join(this.deps.profileDir, SECRETS_FILE), { mode: 'passphrase' });
      if (!opened.ok) throw new Error(opened.error);
      this.secrets = opened.store;
    }
    return this.secrets;
  }

  get unlocked(): boolean {
    return !this.sec().locked || this.sec().isPlaintext;
  }

  get hasStore(): boolean {
    // a store exists if the file was already there before this controller opened it
    try {
      return this.store !== null;
    } catch {
      return false;
    }
  }

  /** Rebuild one account's record from the store row (never from anything the renderer sent). */
  private accountFor(id: string): MailAccount | null {
    const row = this.db().listAccounts().find((x) => x.id === id);
    if (!row) return null;
    const norm = normalizeAccount({
      id: row.id,
      name: row.name,
      address: row.address,
      kind: row.kind,
      host: row.host,
      port: row.port,
      tls: row.tls,
      username: row.username,
      authKind: 'password',
      sentFolder: row.sentFolder,
      trashFolder: row.trashFolder,
      junkFolder: row.junkFolder,
      archiveFolder: row.archiveFolder,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpTls: row.smtpTls,
    });
    return norm.ok ? norm.account : null;
  }

  private syncerFor(id: string): MailSyncer | null {
    if (this.disposed) return null;
    const existing = this.syncers.get(id);
    if (existing) return existing;
    const acc = this.accounts.get(id) ?? this.accountFor(id);
    if (!acc) return null;
    this.accounts.set(id, acc);
    const s = new MailSyncer(acc, {
      store: this.db(),
      makeSocket: this.deps.makeSocket ?? makeSocketFactory({ audit: (ev) => this.deps.audit('mail-connection', { ...ev, account: id }), testCa: this.deps.testTlsCa }),
      credential: () => {
        const stored = this.sec().get(id);
        if (!stored) return null;
        return stored.kind === 'oauth'
          ? { kind: 'oauth', accessToken: stored.accessToken ?? '' }
          : { kind: 'password', password: stored.password ?? '' };
      },
      canConnect: this.deps.canConnect,
      audit: (ev) => this.deps.audit('mail', { action: ev.kind, account: id, detail: ev.detail }),
    });
    this.syncers.set(id, s);
    return s;
  }

  /** Counters for the rail badge. Cheap: one query per account. */
  counts(): { unread: number; accounts: number; configured: boolean; synced: boolean } {
    const ids = this.db().listAccounts().map((a) => a.id);
    let unread = 0;
    for (const id of ids) {
      const c = this.db().counts(id);
      unread += c.unseen + c.unread;
    }
    this.deps.sendUnread(unread);
    return { unread, accounts: ids.length, configured: ids.length > 0, synced: this.synced };
  }

  // ------------------------------------------------------------ handlers

  /** The `mail:state` reply. Contains no message text and no credential. */
  state() {
    const accounts = this.db().listAccounts();
    const c = this.counts();
    const gate = this.deps.canConnect();
    return {
      // per-account unread is a NUMBER (unseen + unread, the same figures counts() sums)
      accounts: accounts.map((a) => {
        const n = this.db().counts(a.id);
        return { ...a, unread: n.unseen + n.unread };
      }),
      unread: c.unread,
      configured: c.configured,
      synced: this.synced,
      view: this.view,
      secretMode: this.sec().mode,
      locked: this.sec().locked,
      keychain: keychainBackend(this.deps.safeStorage),
      warning: this.sec().isPlaintext ? plaintextWarning() : '',
      taskRunning: !gate.ok,
      refused: gate.ok ? '' : (gate.reason ?? ''),
      lastError: this.lastError,
    };
  }

  folders(accountId: string) {
    const id = String(accountId ?? '');
    const folders = this.db().listFolders(id);
    const counts = this.db().folderCounts(id);
    const labels = this.db().listLabels(id).map((l) => ({ id: l.id, name: l.name }));
    const filters = this.db().listFilters(id).map((f) => ({ id: f.id, name: f.name }));
    const outbox = this.db().listOutbox(id);
    const local = { drafts: this.db().listDrafts(id).length, outbox: outbox.length, outboxFailed: outbox.filter((o) => o.status === 'failed').length };
    return { folders, counts, labels, filters, tree: buildFolderTree(folders, counts, labels, filters, this.view, local) };
  }

  list(opts: { accountId?: string; folder?: string }) {
    const listed = this.db().listMessages({
      accountId: opts.accountId ? String(opts.accountId) : undefined,
      folder: opts.folder ? String(opts.folder) : undefined,
      junk: this.view.showJunk ? undefined : false,
      limit: 500,
    });
    const groups = groupThreads(listed.messages);
    const rows = groups.map((g) => {
      const r = listRowFrom(g.head, g.rows.length, g.head.labels);
      const body = this.db().body(g.head.id);
      return { ...r, preview: body?.bodyFetched ? String(body.bodyText ?? '').slice(0, 120) : '' };
    });
    return { rows, total: listed.total };
  }

  search(q: string, opts: { accountId?: string }) {
    const parsed = parseMailSearch(String(q ?? ''));
    if (!parsed.fts) {
      return {
        rows: [],
        total: 0,
        refused: parsed.terms.length > 0 ? 'a search cannot start with NOT' : '',
        advanced: parsed.advanced,
      };
    }
    const hits = this.db().searchExpr(parsed.fts, { accountId: opts.accountId ? String(opts.accountId) : undefined, limit: 200 });
    const groups = groupThreads(hits.hits);
    return {
      rows: groups.map((g) => listRowFrom(g.head, g.rows.length)),
      total: hits.hits.length,
      advanced: parsed.advanced,
      expression: parsed.fts,
    };
  }

  async message(id: number, opts: { markRead?: boolean } = {}) {
    const row = this.db().byId(Number(id));
    if (!row) return { ok: false as const, error: 'unknown message' };
    let body = this.db().body(row.id);
    // fetch on demand: opening a message is what pulls its text, never a sync pass
    if (!body?.bodyFetched) {
      // text kept from before HTML was stored (schema v3 re-marks those unfetched): if the re-fetch
      // cannot happen, the message still opens with that text instead of failing
      const cached = !!body?.bodyText;
      // a fetch is network: refused during a task (an already-fetched message is local and still opens)
      const gate = this.deps.canConnect();
      if (!gate.ok && !cached) return { ok: false as const, error: gate.reason ?? 'mail cannot connect right now', refused: true };
      const s = gate.ok ? this.syncerFor(row.accountId) : null;
      if (s) {
        const r = await s.fetchBody(row.folder, row.uid, { markRead: opts.markRead !== false });
        if (r.ok) body = this.db().body(row.id);
        else this.lastError = r.error ?? this.lastError;
      }
    }
    const fresh = this.db().byId(row.id) ?? row;
    // the HTML itself never leaves main: the renderer learns only THAT there is one (it then asks
    // main to show it in the HTML view) and whether it references remote images (the banner)
    const html = body?.hasHtml ? this.db().html(row.id) : null;
    const remoteImages = html ? sanitizeMailHtml(html).remoteImageHosts.length > 0 : false;
    return {
      ok: true as const,
      id: fresh.id,
      header: readingHeader(fresh),
      subject: fresh.subject,
      // TEXT, and the renderer sets it with textContent (also the fallback when the HTML view cannot show)
      text: body?.bodyText ?? '',
      hasHtml: !!html,
      remoteImages,
      // listed attachments only (an inline cid: image is part of the HTML view), names sanitized,
      // with the dangerous-file warning; the BYTES are fetched only by mail:attachment-download
      attachments: attachmentsView(body?.attachments ?? []),
      remoteContent: body?.remoteContent ?? false,
      notice: html ? (remoteImages ? REMOTE_IMAGES_NOTICE : '') : externalContentNotice(body?.remoteContent ?? false),
      flagged: fresh.flagged,
      readFlag: fresh.readFlag,
      folder: fresh.folder,
      accountId: fresh.accountId,
      uid: fresh.uid,
    };
  }

  /** The stored HTML body of a message, for the main-process HTML view ONLY (never returned over IPC). */
  htmlFor(id: number): string | null {
    return this.db().html(Number(id));
  }

  // ------------------------------------------------------------ attachments (ticket 41)

  /**
   * One stored attachment's BYTES, decoded: the gate first (refused during a task, with the reason),
   * then the size cap against the DECLARED size (nothing is fetched for a part that is too big), then
   * `UID FETCH n BODY.PEEK[section]` through the syncer, transfer-decoded as bytes and capped again.
   */
  private async attachmentBytes(id: number, partId: string, cap: number): Promise<
    | { ok: true; row: MessageRow; meta: Attachment; name: string; bytes: Buffer }
    | { ok: false; error: string; refused?: boolean }
  > {
    const row = this.db().byId(Number(id));
    if (!row) return { ok: false, error: 'unknown message' };
    const meta = this.db().body(row.id)?.attachments.find((a) => a.partId === partId);
    if (!meta) return { ok: false, error: 'that message has no such attachment' };
    const name = attachmentName(meta.filename, meta.mime);
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false, refused: true, error: `attachments are not downloaded while ${gate.reason ?? 'mail cannot connect'}` };
    if (meta.size > cap) return { ok: false, error: `"${name}" is about ${mb(meta.size)}; attachments larger than ${cap / 1048576} MB are not downloaded` };
    const s = this.syncerFor(row.accountId);
    if (!s) return { ok: false, error: 'unknown account' };
    const r = await s.fetchPart(row.folder, row.uid, meta.partId, encodedCap(meta.encoding, cap));
    if (!r.ok) return { ok: false, error: r.refused ? `attachments are not downloaded while ${r.error}` : r.error, refused: r.refused };
    const bytes = decodeTransfer(meta.encoding ?? '7bit', r.bytes);
    if (bytes.length > cap) return { ok: false, error: `"${name}" is ${mb(bytes.length)}; attachments larger than ${cap / 1048576} MB are not downloaded` };
    return { ok: true, row, meta, name, bytes };
  }

  /**
   * The Download click: fetch the part and hand it to the browser's download path. The bytes go
   * NOWHERE else (not the store, not a cache), and the audit line names the account, the message id,
   * the size, the type and the sanitized name — never the content.
   */
  async downloadAttachment(id: unknown, partId: unknown): Promise<{ ok: boolean; error?: string; refused?: boolean; name?: string; path?: string; bytes?: number }> {
    const part = String(partId ?? '').slice(0, 64);
    const got = await this.attachmentBytes(Number(id), part, MAX_ATTACHMENT_BYTES);
    if (!got.ok) {
      this.deps.audit('mail', { action: 'attachment-download', message: Number(id) || 0, part, result: got.refused ? 'refused' : 'failed' });
      return got;
    }
    const save = this.deps.saveDownload;
    const saved = save ? save({ name: got.name, mime: got.meta.mime, bytes: got.bytes }) : ({ ok: false, error: 'downloads are not available here' } as const);
    this.deps.audit('mail', {
      action: 'attachment-download',
      account: got.row.accountId,
      message: got.row.id,
      part,
      bytes: got.bytes.length,
      mime: got.meta.mime,
      name: got.name,
      result: saved.ok ? 'saved' : 'failed',
    });
    if (!saved.ok) return { ok: false, error: saved.error };
    this.downloaded.set(`${got.row.id}:${part}`, saved.path);
    return { ok: true, name: got.name, path: saved.path, bytes: got.bytes.length };
  }

  /**
   * Open: never automatic. The file is downloaded first if it was not this session, then MAIN asks
   * (a dialog naming the file and its type); an executable or script needs the extra explicit
   * confirmation the dialog carries. Refused while an agent task runs or a confirmation is pending.
   */
  async openAttachment(id: unknown, partId: unknown): Promise<{ ok: boolean; error?: string; refused?: boolean; cancelled?: boolean }> {
    const part = String(partId ?? '').slice(0, 64);
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false, refused: true, error: `attachments are not opened while ${gate.reason ?? 'mail cannot connect'}` };
    if (!this.deps.confirmOpen || !this.deps.openPath) return { ok: false, error: 'opening files is not available here' };
    const row = this.db().byId(Number(id));
    if (!row) return { ok: false, error: 'unknown message' };
    const meta = this.db().body(row.id)?.attachments.find((a) => a.partId === part);
    if (!meta) return { ok: false, error: 'that message has no such attachment' };
    let path = this.downloaded.get(`${row.id}:${part}`);
    if (!path || !existsSync(path)) {
      const d = await this.downloadAttachment(row.id, part);
      if (!d.ok || !d.path) return { ok: false, error: d.error ?? 'the attachment could not be saved', refused: d.refused };
      path = d.path;
    }
    const name = basename(path);
    const risk = fileRisk(name, meta.mime);
    const yes = await this.deps.confirmOpen({ name, mime: meta.mime, warning: risk.warning, executable: risk.executable });
    this.deps.audit('mail', { action: 'attachment-open', account: row.accountId, message: row.id, part, mime: meta.mime, name, executable: risk.executable, result: yes ? 'confirmed' : 'declined' });
    if (!yes) return { ok: false, cancelled: true, error: 'not opened' };
    // a task may have started while the dialog was up
    const again = this.deps.canConnect();
    if (!again.ok) return { ok: false, refused: true, error: `attachments are not opened while ${again.reason ?? 'mail cannot connect'}` };
    const err = await this.deps.openPath(path);
    return err ? { ok: false, error: `the system could not open it: ${err.slice(0, 160)}` } : { ok: true };
  }

  /**
   * Inline cid: images for the HTML view: the images the HTML references by Content-ID, fetched
   * through the gate when the message is DISPLAYED (they are part of the message, not remote content,
   * so this is no tracking risk), sniffed against png / jpeg / gif / webp (never SVG), size-capped,
   * and returned as data: URLs keyed by normalised Content-ID. Refused (empty) during a task.
   */
  async inlineImages(id: number): Promise<Map<string, string>> {
    const mid = Number(id) || 0;
    const cached = this.inlineCache.get(mid);
    if (cached) return cached;
    const empty = new Map<string, string>();
    const html = mid ? this.db().html(mid) : null;
    if (!html) return empty;
    const cids = referencedCids(html);
    if (!cids.size) return empty;
    const parts = (this.db().body(mid)?.attachments ?? []).filter((a) => a.inline && a.contentId && cids.has(normalizeCid(a.contentId)));
    if (!parts.length || !this.deps.canConnect().ok) return empty;
    const out = new Map<string, string>();
    let total = 0;
    for (const p of parts.slice(0, 20)) {
      if (p.size > MAX_INLINE_IMAGE_BYTES || total + p.size > MAX_INLINE_TOTAL_BYTES) continue;
      const got = await this.attachmentBytes(mid, p.partId, MAX_INLINE_IMAGE_BYTES);
      if (!got.ok) {
        if (got.refused) return empty;
        continue;
      }
      const type = sniffImage(got.bytes);
      if (!type || total + got.bytes.length > MAX_INLINE_TOTAL_BYTES) continue;
      total += got.bytes.length;
      out.set(normalizeCid(p.contentId ?? ''), `data:${type};base64,${got.bytes.toString('base64')}`);
    }
    this.deps.audit('mail', { action: 'inline-images', message: mid, images: out.size, bytes: total });
    this.inlineCache.set(mid, out);
    while (this.inlineCache.size > 16) this.inlineCache.delete(this.inlineCache.keys().next().value as number);
    return out;
  }

  // ---- a draft's attached files: private copies in <profile>/mail-outbox/<draft id>/ (0700 / 0600)

  private outboxRoot(): string {
    const root = join(this.deps.profileDir, OUTBOX_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    return root;
  }

  /** The directory of a draft that EXISTS in the store; null for any other id (it is used in a path). */
  private draftDir(draftId: string, create: boolean): string | null {
    if (!SAFE_ID.test(draftId) || !this.db().getDraft(draftId)) return null;
    const dir = join(this.outboxRoot(), draftId);
    if (create) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    return dir;
  }

  private removeDraftDir(draftId: string) {
    if (!SAFE_ID.test(draftId)) return;
    rmSync(join(this.deps.profileDir, OUTBOX_DIR, draftId), { recursive: true, force: true });
  }

  private pruneDraftDirs() {
    const root = join(this.deps.profileDir, OUTBOX_DIR);
    if (!existsSync(root) || !this.store) return;
    const keep = new Set(this.store.draftIds());
    for (const d of readdirSync(root)) if (!keep.has(d)) rmSync(join(root, d), { recursive: true, force: true });
  }

  /** The draft's attachments as the compose form lists them (names and sizes; never a path). */
  draftAttachments(draftId: unknown) {
    const id = String(draftId ?? '');
    return this.db()
      .listDraftAttachments(id)
      .map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, warning: fileRisk(a.name, a.mime).warning }));
  }

  /**
   * "Attach…": MAIN opens the system file dialog and copies each chosen file into the draft's private
   * directory, so a later edit or deletion of the original cannot change what is sent and a restart
   * keeps it. The renderer sends only the compose fields (to save the draft first) — never a path.
   */
  async attachPick(input: unknown): Promise<{ ok: boolean; error?: string; draftId?: string; attachments?: ReturnType<MailController['draftAttachments']>; cancelled?: boolean }> {
    const saved = this.draftSave(input);
    if (!saved.ok) return { ok: false, error: saved.error };
    const draftId = saved.id;
    if (!this.deps.pickFiles) return { ok: false, error: 'attaching files is not available here', draftId };
    const paths = (await this.deps.pickFiles()).slice(0, MAX_COMPOSE_ATTACHMENTS);
    if (!paths.length) return { ok: true, cancelled: true, draftId, attachments: this.draftAttachments(draftId) };
    const dir = this.draftDir(draftId, true);
    if (!dir) return { ok: false, error: 'unknown draft', draftId };
    const errors: string[] = [];
    let added = 0;
    let addedBytes = 0;
    for (const p of paths) {
      const existing = this.db().listDraftAttachments(draftId);
      const name = sanitizeFilename(basename(String(p)));
      if (existing.length >= MAX_COMPOSE_ATTACHMENTS) {
        errors.push(`at most ${MAX_COMPOSE_ATTACHMENTS} attachments per message`);
        break;
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        errors.push(`"${name}" could not be read`);
        continue;
      }
      if (!st.isFile()) {
        errors.push(`"${name}" is not a regular file`);
        continue;
      }
      const used = existing.reduce((n, a) => n + a.size, 0);
      if (used + st.size > MAX_COMPOSE_ATTACHMENT_BYTES) {
        errors.push(`"${name}" (${mb(st.size)}) would take the attachments over ${MAX_COMPOSE_ATTACHMENT_BYTES / 1048576} MB`);
        continue;
      }
      const attId = randomUUID();
      const dest = join(dir, attId);
      try {
        const bytes = readFileSync(p);
        if (used + bytes.length > MAX_COMPOSE_ATTACHMENT_BYTES) throw new Error('it grew while it was being read');
        writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
        chmodSync(dest, 0o600);
        const r = this.db().addDraftAttachment({ draftId, id: attId, name, mime: mimeForFilename(name), size: bytes.length });
        if (!r.ok) throw new Error(r.error);
        added++;
        addedBytes += bytes.length;
      } catch (e) {
        rmSync(dest, { force: true });
        errors.push(`"${name}" could not be attached: ${String((e as Error).message).slice(0, 80)}`);
      }
    }
    this.deps.audit('mail', { action: 'attachment-add', files: added, bytes: addedBytes, refused: errors.length });
    return { ok: errors.length === 0, error: errors.join('; ') || undefined, draftId, attachments: this.draftAttachments(draftId) };
  }

  attachRemove(draftId: unknown, attId: unknown) {
    const d = String(draftId ?? '');
    const a = String(attId ?? '');
    const dir = this.draftDir(d, false);
    if (!dir || !/^[0-9a-f-]{36}$/.test(a)) return { ok: false as const, error: 'unknown attachment' };
    const n = this.db().removeDraftAttachment(d, a);
    rmSync(join(dir, a), { force: true });
    return { ok: n > 0, attachments: this.draftAttachments(d) };
  }

  /** The draft's private copies, as bytes for compose.ts. */
  private draftFiles(draftId: string): { ok: true; files: OutgoingAttachment[] } | { ok: false; error: string } {
    const list = SAFE_ID.test(draftId) ? this.db().listDraftAttachments(draftId) : [];
    if (!list.length) return { ok: true, files: [] };
    const dir = join(this.deps.profileDir, OUTBOX_DIR, draftId);
    const files: OutgoingAttachment[] = [];
    for (const a of list) {
      try {
        files.push({ filename: a.name, mime: a.mime, data: readFileSync(join(dir, a.id)) });
      } catch {
        return { ok: false, error: `the attached copy of "${a.name}" is missing; remove it and attach the file again` };
      }
    }
    return { ok: true, files };
  }

  /** A forward's original attachments, fetched from the server NOW (send time), through the gate. */
  private async forwardFiles(refMessage: number, budget: number): Promise<{ ok: true; files: OutgoingAttachment[] } | { ok: false; error: string; refused?: boolean }> {
    const parent = this.db().byId(refMessage);
    if (!parent) return { ok: true, files: [] };
    const listed = (this.db().body(parent.id)?.attachments ?? []).filter((a) => !a.inline);
    if (!listed.length) return { ok: true, files: [] };
    const declared = listed.reduce((n, a) => n + a.size, 0);
    if (declared > budget) return { ok: false, error: `the original's attachments (about ${mb(declared)}) would take this message over ${MAX_COMPOSE_ATTACHMENT_BYTES / 1048576} MB; untick "Include attachments" to forward without them` };
    const gate = this.deps.canConnect();
    if (!gate.ok) {
      return { ok: false, refused: true, error: `not sent: the original's attachments are fetched from the server, which is refused while ${gate.reason ?? 'mail cannot connect'}. The draft is kept; send it when that is over, or untick "Include attachments"` };
    }
    const files: OutgoingAttachment[] = [];
    for (const a of listed) {
      const got = await this.attachmentBytes(parent.id, a.partId, MAX_COMPOSE_ATTACHMENT_BYTES);
      if (!got.ok) return { ok: false, error: `the original attachment could not be fetched: ${got.error}`, refused: got.refused };
      files.push({ filename: got.name, mime: a.mime, data: got.bytes });
    }
    return { ok: true, files };
  }

  async sync(accountId: string) {
    const s = this.syncerFor(String(accountId ?? ''));
    if (!s) return { ok: false as const, error: 'unknown account' };
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false as const, refused: gate.reason ?? 'refused' };
    const report = await s.syncAll();
    if (report.ok) this.synced = true;
    if (report.error) this.lastError = report.error;
    this.counts();
    return report;
  }

  /** Sync every configured account — the explicit "Check all", never automatic. */
  async syncAll() {
    const ids = this.db().listAccounts().map((a) => a.id);
    const out: Array<{ id: string; ok: boolean; error?: string; folders: number }> = [];
    for (const id of ids) {
      const r = await this.sync(id);
      out.push({ id, ok: r.ok, error: r.ok ? undefined : (('error' in r ? r.error : undefined) ?? ('refused' in r ? r.refused : undefined)), folders: reportFolders(r) });
    }
    this.synced = true;
    this.counts();
    return { ok: out.every((o) => o.ok), accounts: out };
  }

  async setFlags(ids: unknown, patch: unknown) {
    const rows = this.rowsFor(ids);
    if (!rows.length) return { ok: false as const, error: 'unknown message' };
    // a flag change writes server state: refused during a task, rather than changed locally and
    // left to diverge from the server
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false as const, error: gate.reason ?? 'mail cannot connect right now' };
    const p = (patch ?? {}) as { readFlag?: boolean; flagged?: boolean; seen?: boolean };
    const applied = this.db().setFlags(rows.map((r) => r.id), p);
    const s = this.syncerFor(rows[0].accountId);
    if (s) await s.setFlags(rows.map((r) => r.uid), rows[0].folder, p).catch(() => undefined);
    this.counts();
    return { ok: true as const, applied };
  }

  async move(ids: unknown, to: string) {
    const rows = this.rowsFor(ids);
    if (!rows.length) return { ok: false as const, error: 'unknown message' };
    const target = String(to ?? '');
    if (!target) return { ok: false as const, error: 'no target folder' };
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false as const, error: gate.reason ?? 'mail cannot connect right now' };
    const s = this.syncerFor(rows[0].accountId);
    if (s) {
      const r = await s.move(rows.map((x) => x.uid), rows[0].folder, target);
      if (!r.ok) return r;
    } else {
      this.db().move(rows.map((x) => x.id), target);
    }
    this.counts();
    return { ok: true as const, moved: rows.length };
  }

  private rowsFor(ids: unknown): MessageRow[] {
    return (Array.isArray(ids) ? ids : [])
      .map((x) => this.db().byId(Number(x)))
      .filter((r): r is MessageRow => !!r);
  }

  viewSet(patch: unknown) {
    const p = (patch ?? {}) as Partial<ViewFilter>;
    const pick = <K extends keyof ViewFilter>(k: K, ok: (v: unknown) => boolean) => {
      if (ok(p[k])) this.view = { ...this.view, [k]: p[k] as ViewFilter[K] };
    };
    pick('read', (v) => v === 'all' || v === 'unseen' || v === 'unread' || v === 'read');
    pick('showJunk', (v) => typeof v === 'boolean');
    pick('showTrash', (v) => typeof v === 'boolean');
    pick('showArchive', (v) => typeof v === 'boolean');
    pick('showCustomFolders', (v) => typeof v === 'boolean');
    pick('showMailingLists', (v) => typeof v === 'boolean');
    pick('showFeeds', (v) => typeof v === 'boolean');
    return { ok: true as const, view: this.view };
  }

  unlock(passphrase: string): MailSendable & { mode?: string } {
    const s = this.sec();
    if (s.isPlaintext) return { ok: true, mode: 'plaintext' };
    if (!s.hasCheck()) {
      const r = s.initPassphrase(String(passphrase ?? ''));
      this.deps.audit('mail', { action: 'master-passphrase-set' });
      return r.ok ? { ok: true, mode: 'passphrase' } : r;
    }
    const r = s.unlock(String(passphrase ?? ''));
    this.deps.audit('mail', { action: 'unlock', ok: r.ok });
    return r.ok ? { ok: true, mode: 'passphrase' } : r;
  }

  secretMode(mode: string, passphrase: string): MailSendable & { mode?: string } {
    const s = this.sec();
    if (mode === 'plaintext') {
      const r = s.makePlaintext();
      this.deps.audit('mail', { action: 'secret-mode', mode: 'plaintext' });
      return r.ok ? { ok: true, mode: 'plaintext' } : r;
    }
    if (mode === 'passphrase') {
      const r = s.initPassphrase(String(passphrase ?? ''));
      this.deps.audit('mail', { action: 'secret-mode', mode: 'passphrase' });
      return r.ok ? { ok: true, mode: 'passphrase' } : r;
    }
    return { ok: false, error: `unknown secret mode ${mode.slice(0, 20)}` };
  }

  async saveAccount(input: unknown, secret: unknown): Promise<MailSendable & { id?: string }> {
    const norm = normalizeAccount(input);
    if (!norm.ok) return norm;
    const a = norm.account;
    const sec = (secret ?? {}) as { password?: string; refreshToken?: string; smtpPassword?: string };
    // a blank SMTP-password field keeps the one already stored (the form never shows it back)
    const keptSmtp = typeof sec.smtpPassword === 'string' && sec.smtpPassword ? sec.smtpPassword : (this.sec().get(a.id)?.smtpPassword ?? '');
    const stored =
      a.authKind === 'oauth'
        ? this.sec().set(a.id, { kind: 'oauth', refreshToken: String(sec.refreshToken ?? '') })
        : this.sec().set(a.id, { kind: 'password', password: String(sec.password ?? ''), ...(keptSmtp ? { smtpPassword: keptSmtp } : {}) });
    if (!stored.ok) return stored;
    const r = this.db().addAccount({
      id: a.id,
      name: a.name,
      address: a.address,
      kind: a.kind,
      host: a.host,
      port: a.port,
      tls: a.tls,
      username: a.username,
      sentFolder: a.sentFolder,
      trashFolder: a.trashFolder,
      junkFolder: a.junkFolder,
      archiveFolder: a.archiveFolder,
      smtpHost: a.smtpHost,
      smtpPort: a.smtpPort,
      smtpTls: a.smtpTls,
    });
    if (!r.ok) return r;
    this.syncers.get(a.id)?.disconnect();
    this.syncers.delete(a.id);
    this.accounts.set(a.id, a);
    this.deps.audit('mail', { action: 'account-save', account: a.id, host: a.host, authKind: a.authKind });
    return { ok: true, id: a.id };
  }

  removeAccount(id: string) {
    const aid = String(id ?? '');
    this.syncers.get(aid)?.disconnect();
    this.syncers.delete(aid);
    this.accounts.delete(aid);
    for (const o of this.db().listOutbox(aid)) this.clearRetry(o.id);
    this.sec().remove(aid);
    const r = this.db().removeAccount(aid);
    this.pruneDraftDirs();
    this.deps.audit('mail', { action: 'account-remove', account: aid, messages: r.removed });
    this.counts();
    return { ok: true, removed: r.removed };
  }

  async testAccount(id: string) {
    const aid = String(id ?? '');
    const acc = this.accounts.get(aid) ?? this.accountFor(aid);
    if (!acc) return { ok: false, step: 'auth' as const, message: 'unknown account' };
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false, step: 'auth' as const, message: gate.reason ?? 'refused' };
    const stored = this.sec().get(aid);
    const makeSocket = this.deps.makeSocket ?? makeSocketFactory({ audit: (ev) => this.deps.audit('mail-connection', { ...ev, account: aid }), testCa: this.deps.testTlsCa });
    const { probeImapConnection } = await import('../../core/mail/imap');
    const r = await testAccount(
      acc,
      stored?.kind === 'oauth' ? { kind: 'oauth', accessToken: stored.accessToken ?? '' } : { kind: 'password', password: stored?.password ?? '' },
      { probeImap: (o) => probeImapConnection(o, makeSocket) },
    );
    this.deps.audit('mail', { action: 'account-test', account: aid, step: r.step, ok: r.ok });
    return r;
  }

  // ------------------------------------------------------------ compose / drafts / outbox (ticket 38)

  /**
   * Prefill a reply / reply-all / forward from the STORED message row. Returns recipients and the
   * subject only: the quoted text is added at send time, from the stored text body (`finalBody`).
   */
  composeInit(kind: unknown, id: unknown) {
    const mode = kind === 'reply' || kind === 'replyAll' || kind === 'forward' ? kind : null;
    if (!mode) return { ok: false as const, error: 'unknown compose mode' };
    const row = this.db().byId(Number(id));
    if (!row) return { ok: false as const, error: 'unknown message' };
    const acc = this.accounts.get(row.accountId) ?? this.accountFor(row.accountId);
    let to = '';
    let cc = '';
    if (mode !== 'forward') {
      const r = replyRecipients(row, acc?.address ?? '', mode === 'replyAll');
      to = r.to.map(formatAddressForInput).join(', ');
      cc = r.cc.map(formatAddressForInput).join(', ');
    }
    return {
      ok: true as const,
      accountId: row.accountId,
      mode,
      refMessage: row.id,
      to,
      cc,
      bcc: '',
      subject: mode === 'forward' ? forwardSubject(row.subject) : replySubject(row.subject),
      body: '',
      includeQuoted: mode !== 'forward',
      forwardAttachments: true,
      // what a forward would carry (names and sizes; the bytes are fetched at send time)
      originalAttachments: mode === 'forward' ? attachmentsView(this.db().body(row.id)?.attachments ?? []) : [],
    };
  }

  /** The text that is sent: what the user typed, plus the quote / forwarded block from the STORE. */
  private finalBody(f: ComposeFields): string {
    if (f.mode === 'new' || !f.refMessage) return f.body;
    const parent = this.db().byId(f.refMessage);
    if (!parent) return f.body;
    // the stored TEXT body: never the HTML, never something the renderer supplied
    const text = this.db().body(parent.id)?.bodyText ?? '';
    const from = parent.fromName ? `${parent.fromName} <${parent.fromAddr}>` : parent.fromAddr;
    const date = parent.sentAt ? new Date(parent.sentAt).toUTCString() : 'an unknown date';
    if (f.mode === 'forward') return `${f.body}\n\n${forwardBlock(text, { date, from, to: parent.toAddrs, subject: parent.subject })}`;
    if (!f.includeQuoted) return f.body;
    return `${f.body}\n\n${quoteOriginal(text, { date, from })}`;
  }

  /** In-Reply-To / References for a reply, from the stored row and its stored raw header. */
  private threading(f: ComposeFields): { inReplyTo?: string; references?: string[] } {
    if ((f.mode !== 'reply' && f.mode !== 'replyAll') || !f.refMessage) return {};
    const parent = this.db().byId(f.refMessage);
    if (!parent?.messageId) return {};
    const raw = this.db().body(parent.id)?.rawHeader ?? '';
    const refs = raw ? (headerGet(parseHeaders(raw), 'references') ?? '') : '';
    return { inReplyTo: parent.messageId, references: buildReferences(refs, parent.messageId) };
  }

  draftSave(input: unknown) {
    const f = composeFields(input);
    const r = this.db().saveDraft({ id: f.draftId || undefined, accountId: f.accountId, mode: f.mode, refMessage: f.refMessage, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, body: f.body, includeQuoted: f.includeQuoted, forwardAttachments: f.forwardAttachments });
    return r.ok ? { ok: true as const, id: r.id } : r;
  }

  drafts(accountId?: unknown) {
    const id = typeof accountId === 'string' && accountId ? accountId : undefined;
    return {
      drafts: this.db()
        .listDrafts(id)
        .map((d) => ({ id: d.id, accountId: d.accountId, mode: d.mode, subject: d.subject, to: d.to, updatedAt: d.updatedAt })),
    };
  }

  draftGet(id: unknown) {
    const d = this.db().getDraft(String(id ?? ''));
    if (!d) return { ok: false as const, error: 'unknown draft' };
    const orig = d.mode === 'forward' && d.refMessage ? attachmentsView(this.db().body(d.refMessage)?.attachments ?? []) : [];
    return { ok: true as const, draft: d, attachments: this.draftAttachments(d.id), originalAttachments: orig };
  }

  /** Discard: the draft row, its attachment rows (cascade) and its private file copies. */
  draftDelete(id: unknown) {
    const did = String(id ?? '');
    const deleted = this.db().deleteDraft(did);
    this.removeDraftDir(did);
    return { ok: true as const, deleted };
  }

  outbox(accountId?: unknown) {
    const id = typeof accountId === 'string' && accountId ? accountId : undefined;
    return {
      items: this.db()
        .listOutbox(id)
        .map((o) => ({ ...o, sending: this.inFlight.has(o.id) })),
    };
  }

  outboxDelete(id: unknown) {
    const oid = String(id ?? '');
    if (this.inFlight.has(oid)) return { ok: false as const, error: 'this message is being sent right now' };
    this.clearRetry(oid);
    const n = this.db().deleteOutbox(oid);
    if (n) this.deps.audit('mail', { action: 'outbox-delete' });
    return { ok: true as const, deleted: n };
  }

  /** The user's Retry: always allowed to try (the gate still decides). */
  retry(id: unknown): Promise<SendResult> {
    return this.deliver(String(id ?? ''), 'user');
  }

  /**
   * Send: build (an invalid message is refused before anything is queued), put it in the Outbox,
   * then deliver. The draft it came from is removed once the Outbox holds the message.
   */
  async send(input: unknown): Promise<SendResult> {
    const f = composeFields(input);
    // a double click on Send must not queue (and deliver) the same draft twice
    if (f.draftId && this.sendingDrafts.has(f.draftId)) return { ok: false, error: 'this message is already being sent' };
    if (f.draftId) this.sendingDrafts.add(f.draftId);
    try {
      return await this.sendNow(f);
    } finally {
      if (f.draftId) this.sendingDrafts.delete(f.draftId);
    }
  }

  private async sendNow(f: ComposeFields): Promise<SendResult> {
    const acc = this.accounts.get(f.accountId) ?? this.accountFor(f.accountId);
    if (!acc) return { ok: false, error: 'choose the account to send from' };
    if (acc.kind === 'local') return { ok: false, error: 'this account has no server to send through' };
    // ticket 41: the draft's private copies, then (a forward) the original's attachments from the server
    const own = this.draftFiles(f.draftId);
    if (!own.ok) return { ok: false, error: own.error };
    const files = [...own.files];
    if (f.mode === 'forward' && f.forwardAttachments && f.refMessage) {
      const used = files.reduce((n, x) => n + x.data.length, 0);
      const fw = await this.forwardFiles(f.refMessage, MAX_COMPOSE_ATTACHMENT_BYTES - used);
      if (!fw.ok) {
        // nothing is queued: the message cannot be built without them, and the draft keeps the work
        if (f.draftId) this.draftSave(f);
        return { ok: false, error: fw.error, refused: fw.refused ? fw.error : undefined };
      }
      files.push(...fw.files);
    }
    const built = buildMessage({
      from: { name: acc.name, address: acc.address },
      to: f.to,
      cc: f.cc,
      bcc: f.bcc,
      subject: f.subject,
      body: this.finalBody(f),
      ...this.threading(f),
      attachments: files,
    });
    if (!built.ok) return { ok: false, error: built.error };
    const q = this.db().addOutbox({
      accountId: acc.id,
      messageId: built.messageId,
      subject: f.subject,
      envelopeFrom: built.envelope.from,
      envelopeTo: built.envelope.to,
      domains: recipientDomains(built.envelope.to),
      raw: built.raw,
      bytes: built.bytes,
    });
    if (!q.ok) return { ok: false, error: q.error };
    // the Outbox now holds the complete message (attachments included, as sent): the draft and its
    // private file copies are no longer needed
    if (f.draftId) {
      this.db().deleteDraft(f.draftId);
      this.removeDraftDir(f.draftId);
    }
    return this.deliver(q.id, 'user');
  }

  /** The SMTP credential: the send password when there is one, else the IMAP password; OAuth only
   *  with a current access token (refresh is not wired for sending, so that case is REFUSED). */
  private smtpAuth(acc: MailAccount): { ok: true; auth: SmtpAuth } | { ok: false; error: string } {
    if (!this.unlocked) return { ok: false, error: 'unlock mail first: the password is in the locked secret store' };
    const s = this.sec().get(acc.id);
    if (!s) return { ok: false, error: 'no password is stored for this account' };
    const username = acc.username || acc.address;
    if (s.kind === 'oauth') {
      if (s.accessToken && (s.expiresAt ?? 0) > Date.now() + 60_000) return { ok: true, auth: { kind: 'xoauth2', username, token: s.accessToken } };
      return { ok: false, error: 'this OAuth account has no current access token, and token refresh is not wired for sending in this build: sending from it is refused' };
    }
    const password = s.smtpPassword || s.password || '';
    if (!password) return { ok: false, error: 'no password is stored for this account' };
    return { ok: true, auth: { kind: 'password', username, password } };
  }

  private smtpSocket(accountId: string): SmtpSocketFactory {
    return this.deps.makeSmtpSocket ?? makeSmtpSocketFactory({ audit: (ev) => this.deps.audit('mail-connection', { ...ev, account: accountId }), testCa: this.deps.testTlsCa });
  }

  /**
   * Try to send one Outbox item. The gate is checked FIRST: refused, the item stays in the Outbox with
   * the reason and automatic retry OFF — only the user's next Send / Retry sends it.
   */
  private async deliver(id: string, trigger: 'user' | 'auto'): Promise<SendResult> {
    const item = this.db().getOutbox(id);
    if (!item) return { ok: false, error: 'that message is no longer in the Outbox' };
    if (this.inFlight.has(id)) return { ok: false, queued: true, outboxId: id, error: 'this message is being sent right now' };
    this.clearRetry(id);
    // every send is audited: account, recipient COUNT and DOMAINS, byte size, result — never the
    // body, the subject or a full address
    const audit = (result: 'sent' | 'failed' | 'refused', extra: Record<string, unknown> = {}) =>
      this.deps.audit('mail', { action: 'send', account: item.accountId, recipients: item.recipients, domains: item.domains ? item.domains.split(',') : [], bytes: item.bytes, result, trigger, ...extra });

    const gate = this.deps.canConnect();
    if (!gate.ok) {
      const reason = gate.reason ?? 'mail cannot connect right now';
      this.db().updateOutbox(id, { status: 'failed', error: `not sent: ${reason}. It stays in the Outbox and is not sent automatically: press Retry when that is over.`, autoRetry: false, nextAttemptAt: 0 });
      audit('refused', { reason });
      return { ok: false, queued: true, outboxId: id, refused: reason, error: `not sent: ${reason}` };
    }
    const acc = this.accounts.get(item.accountId) ?? this.accountFor(item.accountId);
    if (!acc) {
      this.db().updateOutbox(id, { status: 'failed', error: 'the account this was written from no longer exists', autoRetry: false });
      audit('failed', { stage: 'account' });
      return { ok: false, queued: true, outboxId: id, error: 'the account this was written from no longer exists' };
    }
    const cred = this.smtpAuth(acc);
    if (!cred.ok) {
      this.db().updateOutbox(id, { status: 'failed', error: cred.error, autoRetry: false, nextAttemptAt: 0 });
      audit('failed', { stage: 'credential' });
      return { ok: false, queued: true, outboxId: id, error: cred.error };
    }
    const host = acc.smtpHost || acc.host;
    const port = acc.smtpPort ?? 465;
    const tls = acc.smtpTls ?? 'implicit';
    const signal = { aborted: false };
    this.inFlight.set(id, signal);
    this.db().updateOutbox(id, { status: 'sending', attempts: item.attempts + 1, error: '' });
    let r: SmtpResult;
    try {
      r = await smtpSend({ host, port, tls, auth: cred.auth, from: item.envelopeFrom, to: item.envelopeTo, data: Buffer.from(item.raw, 'utf8'), signal, timeoutMs: this.deps.smtpTimeoutMs }, this.smtpSocket(acc.id));
    } finally {
      this.inFlight.delete(id);
    }
    // the window closed while this was in flight: record nothing more, open nothing new
    if (this.disposed) return { ok: r.ok, outboxId: id, error: r.error };
    if (r.ok) {
      this.db().deleteOutbox(id);
      const copy = await this.copyToSent(acc, item.raw);
      audit('sent', { smtp: `${host}:${port}`, tls, sentCopy: copy.status, ...(copy.error ? { sentCopyError: copy.error.slice(0, 120) } : {}) });
      this.counts();
      return { ok: true, outboxId: id, accepted: r.accepted.length, sentCopy: copy.status, sentCopyError: copy.error };
    }
    const attempts = item.attempts + 1;
    const auto = r.transient && !signal.aborted && attempts < MAX_AUTO_ATTEMPTS;
    const wait = auto ? nextBackoff(attempts - 1, this.deps.retryBaseMs ?? RETRY_BASE_MS, RETRY_MAX_MS) : 0;
    const error = r.error ?? 'the send failed';
    this.db().updateOutbox(id, { status: 'failed', error: auto ? `${error} (retrying automatically in ${Math.round(wait / 1000)}s)` : error, autoRetry: auto, nextAttemptAt: auto ? Date.now() + wait : 0 });
    if (auto) this.scheduleRetry(id, wait);
    audit('failed', { stage: r.stage, code: r.code, transient: r.transient, rejected: r.rejected.length, autoRetry: auto, smtp: `${host}:${port}`, tls });
    return { ok: false, queued: true, outboxId: id, error, stage: r.stage, rejected: r.rejected, retryInMs: wait };
  }

  /** APPEND to Sent, except where the server files sent mail itself. A failure is REPORTED, not fatal. */
  private async copyToSent(acc: MailAccount, raw: string): Promise<{ status: 'appended' | 'skipped' | 'failed'; error?: string }> {
    if (serverFilesSentMail(acc)) return { status: 'skipped', error: 'this server files sent mail in Sent itself' };
    const s = this.syncerFor(acc.id);
    if (!s) return { status: 'failed', error: 'unknown account' };
    const r = await s.appendSent(acc.sentFolder || 'Sent', raw);
    if (!r.ok) {
      this.lastError = `sent, but the copy in ${acc.sentFolder || 'Sent'} could not be saved: ${r.error ?? 'unknown error'}`;
      return { status: 'failed', error: r.error ?? 'unknown error' };
    }
    return { status: 'appended' };
  }

  private scheduleRetry(id: string, ms: number) {
    this.clearRetry(id);
    if (this.disposed) return;
    const t = setTimeout(() => {
      this.retryTimers.delete(id);
      void this.deliver(id, 'auto');
    }, ms);
    (t as { unref?: () => void }).unref?.();
    this.retryTimers.set(id, t);
  }

  private clearRetry(id: string) {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
  }

  /** A task started: no automatic send may happen after it, and a send in flight is abandoned. */
  private stopAutomaticSends(reason: string) {
    for (const id of [...this.retryTimers.keys()]) {
      this.clearRetry(id);
      const cur = this.store?.getOutbox(id);
      if (cur) this.store?.updateOutbox(id, { autoRetry: false, nextAttemptAt: 0, error: `${cur.error.replace(/ \(retrying automatically in \d+s\)$/, '')}. Automatic retry cancelled (${reason}): press Retry to send it.` });
    }
    for (const f of this.inFlight.values()) f.aborted = true;
  }

  /** Scan the himalaya config. Returns records + caveats; NEVER a password. */
  importScan(path?: string) {
    const file = path && path.trim() ? path : join(this.deps.home ?? homedir(), HIMALAYA_CONFIG);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      return {
        ok: false as const,
        error:
          code === 'ENOENT' ? `no config at ${file}` : code === 'EACCES' ? `cannot read ${file} (permission denied)` : `could not read ${file}`,
      };
    }
    const plan = buildImportPlan(parseHimalayaConfig(text));
    return {
      ok: true as const,
      path: file,
      accounts: plan.imported.map((x) => ({ account: x.account, notes: x.notes, hasPassword: x.secret.password !== '' })),
      skipped: plan.skipped,
      existing: this.db().listAccounts().map((a) => a.id),
    };
  }

  /** Apply the import. Re-reads the file, so a credential never crosses the bridge. */
  importApply(path: string | undefined, ids: unknown) {
    if (!this.unlocked) return { ok: false as const, error: 'unlock the mail store first (it holds the imported passwords)' };
    const file = path && path.trim() ? path : join(this.deps.home ?? homedir(), HIMALAYA_CONFIG);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { ok: false as const, error: `could not read ${file}` };
    }
    const plan: ImportPlan = buildImportPlan(parseHimalayaConfig(text));
    const want = Array.isArray(ids) && ids.length ? new Set(ids.map((x) => String(x))) : null;
    let added = 0;
    let updated = 0;
    const failed: Array<{ id: string; error: string }> = [];
    const notes: Array<{ id: string; note: string }> = [];
    for (const entry of plan.imported) {
      if (want && !want.has(entry.account.id)) continue;
      // a config with `password.cmd` (never executed) or no password at all has nothing to store: the
      // account is still added, and the user sets the password in the account list
      if (entry.secret.kind === 'password' && !entry.secret.password) {
        notes.push({ id: entry.account.id, note: 'no password imported' });
      } else {
        const sec = this.sec().set(entry.account.id, entry.secret);
        if (!sec.ok) {
          failed.push({ id: entry.account.id, error: sec.error });
          continue;
        }
      }
      const existed = !!this.db().listAccounts().find((x) => x.id === entry.account.id);
      const r = this.db().addAccount({
        id: entry.account.id,
        name: entry.account.name,
        address: entry.account.address,
        kind: entry.account.kind,
        host: entry.account.host,
        port: entry.account.port,
        tls: entry.account.tls,
        username: entry.account.username,
        sentFolder: entry.account.sentFolder,
        trashFolder: entry.account.trashFolder,
        junkFolder: entry.account.junkFolder,
        archiveFolder: entry.account.archiveFolder,
        smtpHost: entry.account.smtpHost,
        smtpPort: entry.account.smtpPort,
        smtpTls: entry.account.smtpTls,
      });
      if (!r.ok) {
        failed.push({ id: entry.account.id, error: r.error });
        continue;
      }
      this.accounts.set(entry.account.id, entry.account);
      if (existed) updated++;
      else added++;
    }
    this.deps.audit('mail', { action: 'import-himalaya', added, updated, failed: failed.length, noPassword: notes.length, path: file });
    this.counts();
    return { ok: failed.length === 0, added, updated, failed, notes, skipped: plan.skipped };
  }

  /**
   * Drop every open mail connection (an idle push included). Called when an agent task starts: the
   * gate refuses NEW connections, and this closes the ones opened before the task.
   */
  disconnectAll() {
    for (const s of this.syncers.values()) s.disconnect();
    this.stopAutomaticSends('an agent task started');
    // the triage extractor never runs alongside a task: its in-flight request is aborted
    this.triager?.stop('an agent task started');
  }

  /** Close every connection and the sqlite handle (called when the window closes). */
  dispose() {
    this.disposed = true;
    this.triager?.stop('mail was closed');
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const f of this.inFlight.values()) f.aborted = true;
    for (const s of this.syncers.values()) s.disconnect();
    this.syncers.clear();
    this.store?.close();
    this.store = null;
    this.secrets = null;
  }
}

/** What the reading pane lists: no inline cid: images, names sanitized, the dangerous-file warning. */
function attachmentsView(list: Attachment[]) {
  return list
    .filter((a) => !a.inline)
    .map((a) => {
      const name = attachmentName(a.filename, a.mime);
      const risk = fileRisk(name, a.mime);
      return { partId: a.partId, name, mime: a.mime, size: a.size, warning: risk.warning, executable: risk.executable };
    });
}

function reportFolders(r: unknown): number {
  const rep = r as { folders?: unknown[] };
  return Array.isArray(rep?.folders) ? rep.folders.length : 0;
}

/** The channel names this controller's handlers answer; declared once, in the shared IPC registry. */
export { MAIL_CHANNELS } from '../../shared/ipc';

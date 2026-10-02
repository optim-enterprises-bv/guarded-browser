// Mail sync engine (ticket 36) — orchestration over the store (34) and the IMAP client (36).
//
// This is the layer that decides WHEN mail moves, and it owns the two rules the mail program is
// built around:
//   * it never connects while an agent task is running or a confirmation is pending (`canConnect`),
//     and it does not queue the work for later — it says so and stops, because a background fetch
//     that starts the moment a task ends is still page content arriving during a task's aftermath;
//   * a UIDVALIDITY change means every uid the store holds for that folder is meaningless, so the
//     folder is dropped and re-synced rather than "merged" (merging silently keeps mail that no
//     longer exists and skips mail that does).
//
// Bodies are NOT fetched during a folder sync: headers only. `fetchBody` is called when a message is
// opened, which is also the moment `seen` flips (Vivaldi's Unseen -> seen-but-not-read), and it is the
// only path that pulls message text into the store.
//
// Every network action is reported through `audit`, per the plan's rule 5 (mail egress is its own,
// explicitly configured channel).

import type { MailAccount } from './accounts';
import { MailStore, htmlToText, type MessageHeader, type FolderKind } from '../../core/mail/store';
import { ImapClient, MAX_LITERAL, type SocketFactory, type ImapSocket, type FetchResult, sanitizeDetail } from '../../core/mail/imap';
import { parseHeaders, summaryFromHeaders, extractContent, parseMime, decodeWords, MAX_HEADER_BYTES, type MimePart, type ExtractedContent } from '../../core/mail/mime';
import { parseBodyStructure, planParts, referencedCids, isInlineImage, decodedSizeEstimate, partMime, type BodyPart } from '../../core/mail/attachments';
import type { Attachment } from '../../core/mail/store';

/** readable text parts fetched when a message opens (a hostile structure can claim thousands) */
const MAX_TEXT_SECTIONS = 20;

export type SyncState = 'offline' | 'connecting' | 'online' | 'error';

export interface SyncReport {
  ok: boolean;
  /** one line per folder: what happened, in the order it happened */
  folders: Array<{ path: string; kind: FolderKind; uidValidity: number; fetched: number; reset: boolean; error?: string }>;
  error?: string;
  /** true when the sync did not even start, with the reason (task running / locked / no secret) */
  refused?: string;
}

export interface SyncDeps {
  store: MailStore;
  makeSocket: SocketFactory;
  /** the credential for this account, read from the ticket-35 secret store at connect time */
  credential: () => { kind: 'password' | 'oauth'; password?: string; accessToken?: string } | null;
  /** refresh an OAuth access token when it is missing or expired; returns null when it cannot */
  refreshAccessToken?: () => Promise<string | null>;
  /** REFUSES the connection while an agent task runs or a confirmation dialog is open */
  canConnect: () => { ok: boolean; reason?: string };
  audit?: (event: { kind: 'connect' | 'sync' | 'fetch' | 'send' | 'error'; detail: string }) => void;
  now?: () => number;
  /** how many folders one `syncAll` may touch (a server with 10 000 folders is bounded) */
  maxFoldersPerSync?: number;
  /** per-command timeout; a timeout is fatal to the connection (default 30 s) */
  commandTimeoutMs?: number;
}

/** Reconnect backoff, in ms, capped. Pure so the policy is testable without waiting. */
export function nextBackoff(attempt: number, base = 5_000, max = 5 * 60_000, jitter = 0): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, Math.min(10, attempt)));
  if (!jitter) return raw;
  // deterministic jitter for tests: a caller-supplied fraction, not Math.random
  return Math.round(raw * (1 - jitter / 2));
}

/** IMAP flags -> what the store records. \Seen is the only read state a server carries. */
export function flagsToState(flags: string[] | undefined): Pick<MessageHeader, 'seen' | 'readFlag' | 'flagged' | 'answered' | 'draft' | 'junk'> {
  const f = new Set((flags ?? []).map((x) => x.toLowerCase()));
  const seen = f.has('\\seen');
  return {
    seen,
    // the server knows "seen"; it does not know "dealt with". A message the server reports as seen
    // is counted as READ here, because the alternative (calling every sync'd message "unread") would
    // make the unread counter useless. The UI sets readFlag=1 on open, which is a local decision.
    readFlag: seen,
    flagged: f.has('\\flagged'),
    answered: f.has('\\answered'),
    draft: f.has('\\draft'),
    junk: f.has('$junk') || f.has('\\junk'),
  };
}

export function stateToFlags(s: Pick<MessageHeader, 'seen' | 'readFlag' | 'flagged' | 'answered' | 'draft'>): string[] {
  const f: string[] = [];
  if (s.seen || s.readFlag) f.push('\\Seen');
  if (s.flagged) f.push('\\Flagged');
  if (s.answered) f.push('\\Answered');
  if (s.draft) f.push('\\Draft');
  return f;
}

/** Guess a folder's role from its name/attributes, so the UI's Sent/Trash/Junk rows are populated. */
export function guessFolderKind(path: string, flags: string[]): FolderKind {
  const p = path.toLowerCase();
  const attr = flags.map((f) => f.toLowerCase());
  if (attr.includes('\\sent') || /^(sent|sent items|sent mail|gesendet)$/.test(p)) return 'sent';
  if (attr.includes('\\drafts') || /^(drafts|entw(ü|u)rfe?)$/.test(p)) return 'drafts';
  if (attr.includes('\\trash') || /^(trash|deleted items|deleted messages|bin|papierkorb)$/.test(p)) return 'trash';
  if (attr.includes('\\junk') || /^(junk|spam|junk e-?mail|bulk mail)$/.test(p)) return 'junk';
  if (attr.includes('\\archive') || p === 'archive') return 'archive';
  if (attr.includes('\\inbox') || p === 'inbox') return 'inbox';
  return 'folder';
}

export class MailSyncer {
  private client: ImapClient | null = null;
  private socket: ImapSocket | null = null;
  private _state: SyncState = 'offline';
  private lastError: string | null = null;
  private attempt = 0;
  /** the folders the account declared, plus INBOX — the only ones a sync touches */
  readonly watched: string[];

  constructor(
    private readonly account: MailAccount,
    private readonly deps: SyncDeps,
  ) {
    const declared = [account.sentFolder, account.trashFolder, account.junkFolder, account.archiveFolder].map((x) => x.trim()).filter(Boolean);
    this.watched = [...new Set(['INBOX', ...declared])];
  }

  get state(): SyncState {
    return this._state;
  }

  get error(): string | null {
    return this.lastError;
  }

  /**
   * The task gate, checked by EVERY action that touches the network or writes server state — not
   * only by connect: a connection opened before a task started must not be used during it.
   * Returns the refusal reason, or null when the action may proceed.
   */
  private refused(action: string): string | null {
    const allowed = this.deps.canConnect();
    if (allowed.ok) return null;
    const reason = allowed.reason ?? 'mail cannot connect right now';
    this.deps.audit?.({ kind: 'error', detail: `${action} refused: ${reason}` });
    return reason;
  }

  /** The live client, reconnecting when the last one was dropped (close / BYE / timeout). */
  private async ensureClient(): Promise<{ client: ImapClient | null; error?: string; refused?: string }> {
    if (this.client) return { client: this.client };
    const r = await this.connect();
    return r.ok ? { client: this.client } : { client: null, error: r.error, refused: r.refused };
  }

  /** Connect + authenticate. Refuses (and does not retry) while a task is running. */
  async connect(): Promise<{ ok: boolean; error?: string; refused?: string }> {
    const reason = this.refused('connect');
    if (reason) return { ok: false, refused: reason };
    const cred = this.deps.credential();
    if (!cred) return { ok: false, error: 'no credential is stored for this account' };

    this._state = 'connecting';
    let socket: ImapSocket;
    try {
      this.socket = socket = await this.deps.makeSocket({ host: this.account.host, port: this.account.port, tls: this.account.tls });
    } catch (e) {
      this._state = 'error';
      this.lastError = `could not reach ${this.account.host}: ${sanitizeDetail((e as Error).message)}`;
      this.deps.audit?.({ kind: 'error', detail: this.lastError });
      return { ok: false, error: this.lastError };
    }
    const c = new ImapClient(socket, this.deps.commandTimeoutMs ?? 30_000);
    this.client = c;
    // a dropped connection (server close, BYE, a command timeout) is forgotten at once, so the next
    // action reconnects instead of failing forever on a dead client
    c.onEvent((e) => {
      if (e.kind !== 'bye' || this.client !== c) return;
      this.client = null;
      this.socket = null;
      this._state = 'error';
      this.lastError = sanitizeDetail(e.text);
      c.close();
    });
    try {
      await c.greeting();
      await c.capability();
      if (cred.kind === 'oauth') {
        let token = cred.accessToken ?? '';
        if (!token && this.deps.refreshAccessToken) token = (await this.deps.refreshAccessToken()) ?? '';
        if (!token) throw new Error('the OAuth access token could not be refreshed');
        await c.authenticateXoauth2(this.account.username, token);
      } else if (c.has('AUTH=PLAIN')) {
        await c.authenticatePlain(this.account.username, cred.password ?? '');
      } else {
        await c.login(this.account.username, cred.password ?? '');
      }
    } catch (e) {
      this._state = 'error';
      this.lastError = sanitizeDetail((e as Error).message);
      // forget it first, so the close's `bye` does not overwrite the real reason
      this.client = null;
      c.close();
      this.deps.audit?.({ kind: 'error', detail: `login failed: ${this.lastError}` });
      return { ok: false, error: this.lastError };
    }
    this._state = 'online';
    this.attempt = 0;
    this.deps.audit?.({ kind: 'connect', detail: `${this.account.host}:${this.account.port} as ${this.account.username}` });
    return { ok: true };
  }

  disconnect() {
    // forget the client BEFORE closing it: close() emits `bye`, and the drop handler must not recurse
    const c = this.client;
    this.client = null;
    this.socket = null;
    this._state = 'offline';
    try {
      c?.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * List folders and store what the server says about them. The `kind` is guessed from the IMAP
   * special-use attribute when the server sends one, else from the name — never invented.
   */
  async syncFolders(): Promise<{ path: string; kind: FolderKind }[]> {
    const c = this.client;
    if (!c) return [];
    const list = await c.list('', '*');
    const out: { path: string; kind: FolderKind }[] = [];
    for (const f of list.slice(0, this.deps.maxFoldersPerSync ?? 200)) {
      const kind = guessFolderKind(f.path, f.flags);
      this.deps.store.upsertFolder({ accountId: this.account.id, path: f.path, name: f.name, kind, uidValidity: 0, uidNext: 0 });
      out.push({ path: f.path, kind });
    }
    return out;
  }

  /**
   * Sync one folder: open it, notice a UIDVALIDITY change, ask for the uids we do not have, and store
   * the headers. The body is left empty on purpose (`bodyFetched = 0`) — the list view does not need
   * it and a first sync of 50 000 messages must not download 50 000 bodies.
   */
  async syncFolder(path: string): Promise<SyncReport['folders'][number]> {
    const c = this.client;
    const kind = guessFolderKind(path, []);
    const no = this.refused(`sync ${path}`);
    if (no) return { path, kind, uidValidity: 0, fetched: 0, reset: false, error: no };
    if (!c) return { path, kind, uidValidity: 0, fetched: 0, reset: false, error: 'not connected' };
    const info = await c.select(path, true);
    this.deps.store.upsertFolder({ accountId: this.account.id, path, name: path, kind, uidValidity: info.uidValidity, uidNext: info.uidNext });

    let reset = false;
    const known = this.deps.store.listFolders(this.account.id).find((f) => f.path === path);
    if (known && known.uidValidity !== 0 && known.uidValidity !== info.uidValidity) {
      // every stored uid in this folder is now meaningless
      const r = this.deps.store.setUidValidity(this.account.id, path, info.uidValidity);
      reset = r.reset;
      this.deps.audit?.({ kind: 'sync', detail: `${path}: UIDVALIDITY changed, dropped ${r.dropped} message(s) and re-syncing` });
    } else {
      this.deps.store.setUidValidity(this.account.id, path, info.uidValidity);
    }

    const high = reset ? 0 : this.deps.store.maxUid(this.account.id, path);
    const range = high > 0 ? `${high + 1}:*` : '1:*';
    const uids = await c.uidSearch(range);
    if (!uids.length) return { path, kind, uidValidity: info.uidValidity, fetched: 0, reset };

    let fetched = 0;
    // in batches, so a 50 000-message folder does not become one 20 MB response
    for (let i = 0; i < uids.length; i += 200) {
      const batch = uids.slice(i, i + 200);
      const results = await c.uidFetch(batch.join(','), '(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODY.PEEK[HEADER])');
      for (const r of results) fetched += this.storeHeader(path, kind, r);
    }
    this.deps.audit?.({ kind: 'sync', detail: `${path}: ${fetched} new message(s), uidvalidity ${info.uidValidity}` });
    return { path, kind, uidValidity: info.uidValidity, fetched, reset };
  }

  private storeHeader(folder: string, kind: FolderKind, r: FetchResult): number {
    const rawHeader = (r.sections?.HEADER ?? '').slice(0, MAX_HEADER_BYTES);
    const headers = parseHeaders(rawHeader);
    const s = summaryFromHeaders(headers);
    const env = r.envelope;
    const state = flagsToState(r.flags);
    // the ENVELOPE carries header values as sent: RFC 2047 encoded-words (`=?UTF-8?B?...?=`) are NOT
    // decoded by the server, so they are decoded here (the HEADER path already decodes them)
    const subject = env?.subject ? decodeWords(env.subject, 400) : s.subject;
    const fromAddr = env?.from?.[0]?.address || s.fromAddr;
    const fromName = env?.from?.[0]?.name ? decodeWords(env.from[0].name, 200) : s.fromName;
    const to = env?.to?.length ? env.to.map((a) => a.address).join(', ') : s.toAddrs;
    const date = s.date ?? r.internalDate ?? null;
    const res = this.deps.store.upsertMessage({
      accountId: this.account.id,
      folder,
      uid: r.uid,
      messageId: env?.messageId || s.messageId,
      subject,
      fromName,
      fromAddr,
      toAddrs: to,
      ccAddrs: env?.cc?.length ? env.cc.map((a) => a.address).join(', ') : s.ccAddrs,
      replyTo: s.replyTo,
      sentAt: date ?? 0,
      receivedAt: r.internalDate ?? date ?? this.deps.now?.() ?? Date.now(),
      size: r.size ?? 0,
      ...state,
      source: 'mail',
    });
    return res.ok ? 1 : 0;
  }

  /** Sync every watched folder that the account declared. */
  async syncAll(folders?: string[]): Promise<SyncReport> {
    const no = this.refused('sync');
    if (no) return { ok: false, folders: [], refused: no };
    const ready = await this.ensureClient();
    if (!ready.client) return { ok: false, folders: [], error: ready.error, refused: ready.refused };
    let list: string[];
    try {
      list = folders ?? (await this.syncFolders()).map((f) => f.path);
    } catch (e) {
      // LIST failing means the connection is unusable: report it, do not throw out of the sync
      const msg = sanitizeDetail((e as Error).message);
      this.lastError = msg;
      this._state = 'error';
      this.deps.audit?.({ kind: 'error', detail: `folder list: ${msg}` });
      return { ok: false, folders: [], error: msg };
    }
    const wanted = list.filter((p) => this.watched.some((w) => w.toLowerCase() === p.toLowerCase()) || p.toLowerCase() === 'inbox');
    const out: SyncReport['folders'] = [];
    for (const p of wanted) {
      try {
        out.push(await this.syncFolder(p));
      } catch (e) {
        const msg = sanitizeDetail((e as Error).message);
        this.lastError = msg;
        this._state = 'error';
        this.deps.audit?.({ kind: 'error', detail: `${p}: ${msg}` });
        out.push({ path: p, kind: guessFolderKind(p, []), uidValidity: 0, fetched: 0, reset: false, error: msg });
        break; // a failed folder usually means the connection is gone: stop rather than cascade
      }
    }
    return { ok: out.every((f) => !f.error), folders: out, error: out.find((f) => f.error)?.error };
  }

  /**
   * Fetch one message's body and mark it seen. This is the ONLY path that puts message text in the
   * store, and the caller is the user opening a message — never a sync pass, and never a page.
   *
   * `markRead` is the second half of Vivaldi's unseen/unread distinction: the body fetch sets
   * `seen` (the server learns \Seen), while `readFlag` stays 0 until the user deals with it.
   */
  async fetchBody(folder: string, uid: number, opts: { markRead?: boolean } = {}): Promise<{ ok: boolean; error?: string; remoteContent?: boolean; attachments?: number; charsetLossy?: boolean }> {
    const no = this.refused('fetch');
    if (no) return { ok: false, error: no };
    const row = this.deps.store.byUid(this.account.id, folder, uid);
    if (!row) return { ok: false, error: 'unknown message' };
    const ready = await this.ensureClient();
    const c = ready.client;
    if (!c) return { ok: false, error: ready.refused ?? ready.error ?? 'not connected' };
    let got: { header: string; content: ExtractedContent; attachments: Attachment[] } | null;
    try {
      // SELECT, not EXAMINE: a read-only mailbox refuses the \Seen STORE below
      await c.select(folder, false);
      // ticket 41: the STRUCTURE first, then only the readable text parts — an attachment's bytes do
      // not cross the network until the user clicks it. A server whose BODYSTRUCTURE cannot be read
      // gets the old whole-message fetch instead.
      got = (await this.fetchByStructure(c, uid)) ?? (await this.fetchWhole(c, uid));
    } catch (e) {
      this.lastError = sanitizeDetail((e as Error).message);
      return { ok: false, error: this.lastError };
    }
    if (!got) {
      // a NIL body: record that we tried, so the UI does not spin forever
      this.deps.store.setBody(this.account.id, folder, uid, { text: '', rawHeader: '' });
      return { ok: false, error: 'the server returned no message body' };
    }
    const { content, attachments } = got;
    this.deps.store.setBody(this.account.id, folder, uid, {
      text: content.text,
      // the store's own HTML-to-text pass runs only when there is no plain part, and its
      // remote-content flag is what the UI shows as "remote content was not loaded"
      html: content.html,
      rawHeader: got.header,
      attachments,
    });
    this.deps.store.setFlags([row.id], { seen: true, ...(opts.markRead ? { readFlag: true } : {}) });
    // \Seen is written BACK to the server, but only when the user's action implies it
    if (opts.markRead) await c.uidStore([uid], 'add', ['Seen']).catch(() => undefined);
    const listed = attachments.filter((a) => !a.inline).length;
    this.deps.audit?.({ kind: 'fetch', detail: `${folder} uid ${uid}: ${content.text.length} chars, ${listed} attachment(s)` });
    return {
      ok: true,
      remoteContent: content.remoteContent || htmlToText(content.html).remoteContent,
      attachments: listed,
      charsetLossy: content.charsetLossy,
    };
  }

  /**
   * BODYSTRUCTURE, then `BODY.PEEK[HEADER]` and each readable text section in ONE command. Each text
   * section is decoded per the charset and transfer encoding the structure declares. Attachments are
   * METADATA from the structure (section, type, encoding, size, Content-ID); an image the HTML shows
   * through cid: is recorded `inline` and not listed. Null when the structure is unusable.
   */
  private async fetchByStructure(c: ImapClient, uid: number): Promise<{ header: string; content: ExtractedContent; attachments: Attachment[] } | null> {
    const res = (await c.uidFetch(String(uid), '(UID BODYSTRUCTURE)')).find((f) => f.uid === uid);
    const root = parseBodyStructure(res?.bodyStructure);
    if (!root) return null;
    const plan = planParts(root);
    const text = plan.text.filter((p) => p.size <= MAX_LITERAL).slice(0, MAX_TEXT_SECTIONS);
    const items = ['BODY.PEEK[HEADER]', ...text.map((p) => `BODY.PEEK[${p.section}]`)];
    const got = (await c.uidFetch(String(uid), `(UID ${items.join(' ')})`)).find((f) => f.uid === uid);
    if (!got) return null;
    const bytesOf = (key: string) => got.sectionBytes[key] ?? Buffer.from(got.sections[key] ?? '', 'utf8');
    const header = bytesOf('HEADER');
    const leaves = text.map((p) => textLeaf(p, bytesOf(p.section)));
    if (!header.toString('latin1').trim() && leaves.every((l) => !l.body.trim())) return null;
    const content = extractContent({ headers: [], contentType: 'multipart/mixed', params: {}, encoding: '7bit', body: '', parts: leaves, filename: '', contentId: '', truncated: plan.text.length > text.length });
    const cids = referencedCids(content.html);
    const attachments: Attachment[] = plan.attachments.slice(0, 200).map((p) => ({
      partId: p.section,
      filename: p.filename || (p.type === 'message' ? 'message.eml' : ''),
      mime: partMime(p),
      size: decodedSizeEstimate(p.encoding, p.size),
      encoding: p.encoding,
      disposition: p.disposition,
      contentId: p.id,
      inline: isInlineImage(p, cids),
    }));
    return { header: header.toString('utf8').replace(/(\r?\n)+$/, ''), content, attachments };
  }

  /** The pre-ticket-41 path: the whole message in one literal, parsed locally. */
  private async fetchWhole(c: ImapClient, uid: number): Promise<{ header: string; content: ExtractedContent; attachments: Attachment[] } | null> {
    const bytes = await c.uidBodyBytes(uid);
    if (!bytes.length) return null;
    const content = extractContent(parseMime(bytes));
    return { header: bytes.toString('utf8').split(/\r\n\r\n|\n\n/)[0] ?? '', content, attachments: content.attachments };
  }

  /**
   * ONE attachment's bytes, still transfer-encoded (the caller decodes). Gated like every other
   * network action, opened read-only (EXAMINE: BODY.PEEK changes no flag), and audited by section and
   * size only. `maxEncodedBytes` bounds the literal the client will accept for this command.
   */
  async fetchPart(folder: string, uid: number, section: string, maxEncodedBytes: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string; refused?: boolean }> {
    const no = this.refused('attachment fetch');
    if (no) return { ok: false, error: no, refused: true };
    const ready = await this.ensureClient();
    const c = ready.client;
    if (!c) return { ok: false, error: ready.refused ?? ready.error ?? 'not connected', refused: !!ready.refused };
    try {
      await c.select(folder, true);
      const bytes = await c.uidFetchPart(uid, section, maxEncodedBytes);
      if (!bytes) return { ok: false, error: 'the server returned nothing for that part' };
      this.deps.audit?.({ kind: 'fetch', detail: `${folder} uid ${uid} part ${section}: ${bytes.length} bytes` });
      return { ok: true, bytes };
    } catch (e) {
      this.lastError = sanitizeDetail((e as Error).message);
      return { ok: false, error: this.lastError };
    }
  }

  /** Mark messages read / unread / flagged, locally and on the server. */
  async setFlags(uids: number[], folder: string, patch: { seen?: boolean; readFlag?: boolean; flagged?: boolean }): Promise<{ ok: boolean; error?: string; applied: number }> {
    const no = this.refused('flags');
    if (no) return { ok: false, error: no, applied: 0 };
    const ready = await this.ensureClient();
    const c = ready.client;
    if (!c) return { ok: false, error: ready.refused ?? ready.error ?? 'not connected', applied: 0 };
    const rows = uids.map((u) => this.deps.store.byUid(this.account.id, folder, u)).filter((r): r is NonNullable<typeof r> => !!r);
    if (!rows.length) return { ok: false, error: 'unknown message', applied: 0 };
    const applied = this.deps.store.setFlags(rows.map((r) => r.id), patch);
    const add: string[] = [];
    const remove: string[] = [];
    const wantSeen = (patch.seen ?? patch.readFlag) === true;
    const wantUnseen = patch.seen === false || patch.readFlag === false;
    if (wantSeen && patch.flagged === undefined) add.push('Seen');
    if (wantUnseen) remove.push('Seen');
    if (patch.flagged === true) add.push('Flagged');
    if (patch.flagged === false) remove.push('Flagged');
    await c.select(folder, false).catch(() => undefined);
    if (add.length) await c.uidStore(uids, 'add', add).catch(() => undefined);
    if (remove.length) await c.uidStore(uids, 'remove', remove).catch(() => undefined);
    return { ok: true, applied };
  }

  /** Move messages to another folder, re-keying the store rows from the server's COPYUID. */
  /**
   * APPEND a sent message to `folder` (ticket 38's Sent copy), marked \Seen, then sync that folder so
   * the copy shows up. Gated like every other server write; a failure is RETURNED (the caller reports
   * it — the message itself was already delivered).
   */
  async appendSent(folder: string, raw: string): Promise<{ ok: boolean; error?: string; uid?: number | null }> {
    const no = this.refused('append');
    if (no) return { ok: false, error: no };
    const ready = await this.ensureClient();
    const c = ready.client;
    if (!c) return { ok: false, error: ready.refused ?? ready.error ?? 'not connected' };
    let uid: number | null;
    try {
      uid = (await c.append(folder, raw, ['\\Seen'])).uid;
    } catch (e) {
      this.lastError = sanitizeDetail((e as Error).message);
      return { ok: false, error: this.lastError };
    }
    this.deps.audit?.({ kind: 'sync', detail: `appended a sent copy to ${folder}` });
    // best effort: the copy is on the server either way
    await this.syncFolder(folder).catch(() => undefined);
    return { ok: true, uid };
  }

  async move(uids: number[], from: string, to: string): Promise<{ ok: boolean; error?: string; moved: number }> {
    const no = this.refused('move');
    if (no) return { ok: false, error: no, moved: 0 };
    const ready = await this.ensureClient();
    const c = ready.client;
    if (!c) return { ok: false, error: ready.refused ?? ready.error ?? 'not connected', moved: 0 };
    let r: Awaited<ReturnType<ImapClient['uidMove']>>;
    try {
      await c.select(from, false);
      r = await c.uidMove(uids, to);
    } catch (e) {
      this.lastError = sanitizeDetail((e as Error).message);
      return { ok: false, error: this.lastError, moved: 0 };
    }
    if (!r.moved) return { ok: false, error: 'the server refused the move', moved: 0 };
    let moved = 0;
    for (const uid of uids) {
      const row = this.deps.store.byUid(this.account.id, from, uid);
      if (!row) continue;
      const nu = r.newUids.get(uid);
      // The old uid means nothing in the target folder (and may belong to another message there), so
      // the row is never moved keeping it. With COPYUID, folder+uid change in ONE statement; without
      // it — or when the target row already exists locally — the local row is dropped and the next
      // sync of the target fetches the message under its real uid.
      if (!nu || !this.deps.store.rekey(row.id, to, nu).ok) this.deps.store.deleteMessages([row.id], true);
      moved++;
    }
    this.deps.audit?.({ kind: 'sync', detail: `moved ${moved} message(s) ${from} -> ${to}` });
    return { ok: true, moved };
  }

  /**
   * IDLE push. Emits a callback per server event so the UI can show "new mail" without polling, and
   * reconnects with backoff. Stops when `stop()` is called or the connect gate refuses.
   *
   * A push event does NOT fetch the body (that is the user's action); it triggers a header sync of
   * that folder, which is cheap.
   */
  async push(onFolder: (path: string) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    for (;;) {
      if (opts.signal?.aborted) return;
      if (!this.client) {
        const c = await this.connect();
        if (!c.ok) {
          const delay = nextBackoff(this.attempt++);
          if (c.refused) return; // a refusal is not a transient failure: do not retry into it
          await sleep(delay, opts.signal);
          continue;
        }
      }
      const c = this.client!;
      if (!c.has('IDLE')) return; // without IDLE the caller polls with syncAll instead
      const folder = 'INBOX';
      try {
        await c.select(folder, true);
        const idling = c.idle({ timeoutMs: 25 * 60_000 });
        const off = c.onEvent((e) => {
          if (e.kind === 'exists' || e.kind === 'fetch') onFolder(folder);
        });
        await idling;
        off();
      } catch (e) {
        this.lastError = sanitizeDetail((e as Error).message);
        this.deps.audit?.({ kind: 'error', detail: `idle failed: ${this.lastError}` });
        this.disconnect();
        await sleep(nextBackoff(this.attempt++), opts.signal);
      }
    }
  }

  stopPush() {
    try {
      this.client?.idleDone();
    } catch {
      /* not idling */
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A readable text part as a MIME leaf: the section's BYTES behind a synthetic header that carries ONLY
 * the structure's charset and transfer encoding (both re-validated, so a server string cannot add a
 * header line), decoded by mime.ts exactly as a part of a whole message would be. `us-ascii` is read
 * as UTF-8, its superset: a mislabelled 8-bit body then shows its letters instead of mojibake.
 */
function textLeaf(p: BodyPart, bytes: Buffer): MimePart {
  const cs0 = String(p.params.charset ?? '').toLowerCase();
  const charset = /^[a-z0-9._:-]{1,40}$/.test(cs0) && cs0 !== 'us-ascii' && cs0 !== 'ascii' ? cs0 : 'utf-8';
  const enc = /^(7bit|8bit|binary|quoted-printable|base64)$/.test(p.encoding) ? p.encoding : '7bit';
  const head = Buffer.from(`Content-Type: text/${p.subtype === 'html' ? 'html' : 'plain'}; charset=${charset}\r\nContent-Transfer-Encoding: ${enc}\r\n\r\n`, 'latin1');
  return parseMime(Buffer.concat([head, bytes]));
}

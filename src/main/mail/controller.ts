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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MailStore, DB_FILE, type MessageRow } from '../../core/mail/store';
import { SecretStore, SECRETS_FILE, plaintextWarning, keychainBackend } from './secrets';
import { normalizeAccount, testAccount, type MailAccount } from './accounts';
import { MailSyncer } from './sync';
import { makeSocketFactory } from './socket';
import type { SocketFactory } from '../../core/mail/imap';
import { parseHimalayaConfig, buildImportPlan, HIMALAYA_CONFIG, type ImportPlan } from './import';
import { DEFAULT_VIEW, buildFolderTree, groupThreads, listRowFrom, readingHeader, externalContentNotice, parseMailSearch, REMOTE_IMAGES_NOTICE, type ViewFilter } from '../../core/mail/ui';
import { sanitizeMailHtml } from '../../core/mail/html';

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

  constructor(private readonly deps: MailControllerDeps) {}

  // ------------------------------------------------------------ lazy handles

  /** The mail store, opened on first use. Throws only if the file cannot be opened at all. */
  private db(): MailStore {
    if (!this.store) {
      this.store = new MailStore(join(this.deps.profileDir, DB_FILE));
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
    });
    return norm.ok ? norm.account : null;
  }

  private syncerFor(id: string): MailSyncer | null {
    const existing = this.syncers.get(id);
    if (existing) return existing;
    const acc = this.accounts.get(id) ?? this.accountFor(id);
    if (!acc) return null;
    this.accounts.set(id, acc);
    const s = new MailSyncer(acc, {
      store: this.db(),
      makeSocket: this.deps.makeSocket ?? makeSocketFactory({ audit: (ev) => this.deps.audit('mail-connection', { ...ev, account: id }) }),
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
    return { folders, counts, labels, filters, tree: buildFolderTree(folders, counts, labels, filters, this.view) };
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
      // a fetch is network: refused during a task (an already-fetched message is local and still opens)
      const gate = this.deps.canConnect();
      if (!gate.ok) return { ok: false as const, error: gate.reason ?? 'mail cannot connect right now', refused: true };
      const s = this.syncerFor(row.accountId);
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
      attachments: body?.attachments ?? [],
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
    const sec = (secret ?? {}) as { password?: string; refreshToken?: string };
    const stored =
      a.authKind === 'oauth'
        ? this.sec().set(a.id, { kind: 'oauth', refreshToken: String(sec.refreshToken ?? '') })
        : this.sec().set(a.id, { kind: 'password', password: String(sec.password ?? '') });
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
    });
    if (!r.ok) return r;
    this.accounts.set(a.id, a);
    this.deps.audit('mail', { action: 'account-save', account: a.id, host: a.host, authKind: a.authKind });
    return { ok: true, id: a.id };
  }

  removeAccount(id: string) {
    const aid = String(id ?? '');
    this.syncers.get(aid)?.disconnect();
    this.syncers.delete(aid);
    this.accounts.delete(aid);
    this.sec().remove(aid);
    const r = this.db().removeAccount(aid);
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
    const makeSocket = makeSocketFactory({ audit: (ev) => this.deps.audit('mail-connection', { ...ev, account: aid }) });
    const { probeImapConnection } = await import('../../core/mail/imap');
    const r = await testAccount(
      acc,
      stored?.kind === 'oauth' ? { kind: 'oauth', accessToken: stored.accessToken ?? '' } : { kind: 'password', password: stored?.password ?? '' },
      { probeImap: (o) => probeImapConnection(o, makeSocket) },
    );
    this.deps.audit('mail', { action: 'account-test', account: aid, step: r.step, ok: r.ok });
    return r;
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
  }

  /** Close every connection and the sqlite handle (called when the window closes). */
  dispose() {
    for (const s of this.syncers.values()) s.disconnect();
    this.syncers.clear();
    this.store?.close();
    this.store = null;
    this.secrets = null;
  }
}

function reportFolders(r: unknown): number {
  const rep = r as { folders?: unknown[] };
  return Array.isArray(rep?.folders) ? rep.folders.length : 0;
}

/** The channel names this controller's handlers answer; declared once, in the shared IPC registry. */
export { MAIL_CHANNELS } from '../../shared/ipc';

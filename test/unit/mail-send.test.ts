// Ticket 38 — sending, end to end inside the main process: the controller, the store's drafts and
// outbox, the gate, the Sent copy, the audit line; and the structural guarantee that nothing on the
// agent's side can reach any of it.
//
// The controller is real (sqlite + a passphrase secret store in a temp dir). IMAP is the in-memory fake
// (injected `makeSocket`), SMTP the in-memory fake (injected `makeSmtpSocket`), so nothing touches a
// network.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MailController, serverFilesSentMail, composeFields } from '../../src/main/mail/controller';
import { MailStore, DB_FILE, SCHEMA_VERSION } from '../../src/core/mail/store';
import { normalizeAccount } from '../../src/main/mail/accounts';
import { decodeQuotedPrintable, parseHeaders, headerGet } from '../../src/core/mail/mime';
import { PLANNER_TOOLS } from '../../src/core/planner';
import { FakeImapServer } from '../helpers/fake-imap';
import { FakeSmtpServer, type FakeSmtpOptions } from '../helpers/fake-smtp';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gb-mailsend-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const account = {
  id: 'work',
  name: 'Ada Lovelace',
  address: 'ada@example.com',
  kind: 'imap',
  host: 'imap.example.com',
  port: 993,
  tls: 'implicit',
  username: 'ada',
  authKind: 'password',
  sentFolder: 'Sent',
  trashFolder: 'Trash',
  junkFolder: 'Junk',
  archiveFolder: 'Archive',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpTls: 'starttls',
};

interface Setup {
  ctl: MailController;
  imap: FakeImapServer;
  smtp: FakeSmtpServer;
  audits: Array<{ kind: string; detail: Record<string, unknown> }>;
  setGate(reason: string | null): void;
  dir: string;
}

function setup(o: { smtp?: FakeSmtpOptions; imap?: ConstructorParameters<typeof FakeImapServer>[0]; dir?: string; retryBaseMs?: number } = {}): Setup {
  let gate: string | null = null;
  const audits: Setup['audits'] = [];
  const imap = new FakeImapServer({ user: 'ada', password: 'pw', ...o.imap });
  const smtp = new FakeSmtpServer({ user: 'ada', password: 'pw', ...o.smtp });
  const dir = o.dir ?? tmp();
  const ctl = new MailController({
    profileDir: dir,
    canConnect: () => (gate ? { ok: false, reason: gate } : { ok: true }),
    audit: (kind, detail) => audits.push({ kind, detail }),
    sendUnread: () => undefined,
    makeSocket: async () => imap.socket(),
    makeSmtpSocket: async ({ tls }) => smtp.socket({ implicit: tls === 'implicit' }),
    retryBaseMs: o.retryBaseMs ?? 60_000,
    smtpTimeoutMs: 1_000,
  });
  return { ctl, imap, smtp, audits, setGate: (r) => (gate = r), dir };
}

async function ready(s: Setup, acct: Record<string, unknown> = account, secret: Record<string, unknown> = { password: 'pw' }) {
  expect(s.ctl.unlock('correct horse battery').ok).toBe(true);
  const r = await s.ctl.saveAccount(acct, secret);
  expect(r).toMatchObject({ ok: true });
}

const draft = (o: Record<string, unknown> = {}) => ({ accountId: 'work', mode: 'new', to: 'Bob <bob@example.org>', cc: '', bcc: '', subject: 'Quarterly numbers', body: 'Hi Bob,\nsee you soon.', ...o });
const sentHeaders = (smtp: FakeSmtpServer, i = -1) => {
  const raw = smtp.received.at(i)!.data.toString('utf8');
  return { raw, h: parseHeaders(raw.slice(0, raw.indexOf('\r\n\r\n') + 2)), body: decodeQuotedPrintable(raw.slice(raw.indexOf('\r\n\r\n') + 4), 100_000) };
};

describe('send (38) — the happy path', () => {
  it('sends through STARTTLS, appends a copy to Sent, empties the Outbox, and audits counts + domains only', async () => {
    const s = setup();
    await ready(s);
    const r = await s.ctl.send(draft({ cc: 'carol@example.net', bcc: 'sam@hidden.example' }));
    expect(r).toMatchObject({ ok: true, accepted: 3, sentCopy: 'appended' });
    // the envelope: every recipient, Bcc included; the headers: no Bcc
    expect(s.smtp.received[0]).toMatchObject({ from: 'ada@example.com', to: ['bob@example.org', 'carol@example.net', 'sam@hidden.example'], secure: true });
    const { raw, h, body } = sentHeaders(s.smtp);
    expect(headerGet(h, 'from')).toBe('Ada Lovelace <ada@example.com>');
    expect(headerGet(h, 'to')).toBe('Bob <bob@example.org>');
    expect(headerGet(h, 'subject')).toBe('Quarterly numbers');
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).not.toContain('hidden.example');
    expect(body).toBe('Hi Bob,\nsee you soon.\n');
    // the Sent copy is the SAME message, marked \Seen
    const sent = s.imap.folders.find((f) => f.path === 'Sent')!;
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].raw).toContain(headerGet(h, 'message-id')!);
    expect(s.imap.transcript).toMatch(/APPEND Sent \(\\Seen\)/);
    expect(s.ctl.outbox().items).toEqual([]);
    // the audit line: account, recipient COUNT and DOMAINS, bytes, result — never addresses/subject/body
    const ev = s.audits.find((a) => a.detail.action === 'send')!;
    expect(ev.detail).toMatchObject({ account: 'work', recipients: 3, result: 'sent', sentCopy: 'appended', tls: 'starttls' });
    expect(ev.detail.domains).toEqual(['example.net', 'example.org', 'hidden.example']);
    expect(ev.detail.bytes).toBe(Buffer.byteLength(raw.replace(/\r\n$/, '')) + 2);
    const line = JSON.stringify(ev);
    for (const secret of ['bob@example.org', 'sam@', 'Quarterly', 'see you soon', 'pw"']) expect(line).not.toContain(secret);
  });

  it('the SMTP-specific password is used when there is one, else the IMAP password', async () => {
    const a = setup({ smtp: { password: 'send-only' } });
    await ready(a, account, { password: 'pw', smtpPassword: 'send-only' });
    expect((await a.ctl.send(draft())).ok).toBe(true);
    expect(a.smtp.auths[0].secret).toBe('send-only');
    const b = setup();
    await ready(b);
    expect((await b.ctl.send(draft())).ok).toBe(true);
    expect(b.smtp.auths[0].secret).toBe('pw');
  });

  it('an invalid message is refused BEFORE it is queued (nothing in the Outbox, no connection)', async () => {
    const s = setup();
    await ready(s);
    const r = await s.ctl.send(draft({ to: 'bob@example.org\r\nBcc: eve@example.com' }));
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/^To: line breaks are not allowed/);
    expect(r.queued).toBeUndefined();
    expect(s.ctl.outbox().items).toEqual([]);
    expect(s.smtp.connections).toBe(0);
  });

  it('a draft is removed once its message is in the Outbox', async () => {
    const s = setup();
    await ready(s);
    const d = s.ctl.draftSave(draft());
    if (!d.ok) throw new Error('draft');
    expect(s.ctl.drafts('work').drafts).toHaveLength(1);
    expect((await s.ctl.send(draft({ draftId: d.id }))).ok).toBe(true);
    expect(s.ctl.drafts('work').drafts).toEqual([]);
  });
});

describe('send (38) — no duplicates, nothing after close', () => {
  it('a double Send of the same draft queues and delivers ONE message', async () => {
    const s = setup();
    await ready(s);
    const d = s.ctl.draftSave(draft());
    if (!d.ok) throw new Error('draft');
    const [a, b] = await Promise.all([s.ctl.send(draft({ draftId: d.id })), s.ctl.send(draft({ draftId: d.id }))]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a).error).toMatch(/already being sent/);
    expect(s.smtp.received).toHaveLength(1);
    expect(s.ctl.outbox().items).toEqual([]);
  });

  it('closing the window while a send is in flight reopens nothing (no store handle, no IMAP connection)', async () => {
    const s = setup({ smtp: { hang: 'rcpt' } });
    await ready(s);
    const pending = s.ctl.send(draft());
    await sleep(20);
    s.ctl.dispose();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(s.imap.transcript).toBe('');
    expect(s.smtp.received).toEqual([]);
  });

  it('saving an account with a blank SMTP-password field keeps the stored one', async () => {
    const s = setup({ smtp: { password: 'send-only' } });
    await ready(s, account, { password: 'pw', smtpPassword: 'send-only' });
    expect((await s.ctl.saveAccount(account, { password: 'pw', smtpPassword: '' })).ok).toBe(true);
    expect((await s.ctl.send(draft())).ok).toBe(true);
    expect(s.smtp.auths[0].secret).toBe('send-only');
  });
});

describe('send (38) — replies quote the STORED TEXT and thread correctly', () => {
  it('Reply: recipients and subject from the stored row; quote from the text body (never the HTML); In-Reply-To + References', async () => {
    const s = setup();
    await ready(s);
    const store = (s.ctl as unknown as { db(): MailStore }).db();
    store.upsertMessage({ accountId: 'work', folder: 'INBOX', uid: 900, messageId: 'orig-1@example.org', subject: 'Re: Plans', fromName: 'Bob', fromAddr: 'bob@example.org', toAddrs: 'ada@example.com, carol@example.net', ccAddrs: 'dave@example.net', sentAt: Date.UTC(2026, 8, 30, 9, 0), receivedAt: Date.now() });
    store.setBody('work', 'INBOX', 900, { text: 'The TEXT body.\nSecond line.', html: '<p>HTML-ONLY-MARKER</p>', rawHeader: 'References: <root@example.org>\r\nMessage-ID: <orig-1@example.org>\r\n' });
    const id = store.byUid('work', 'INBOX', 900)!.id;

    const init = s.ctl.composeInit('reply', id);
    expect(init).toMatchObject({ ok: true, to: 'Bob <bob@example.org>', cc: '', subject: 'Re: Plans', includeQuoted: true, body: '' });
    const all = s.ctl.composeInit('replyAll', id);
    expect(all).toMatchObject({ ok: true, to: 'Bob <bob@example.org>', cc: 'carol@example.net, dave@example.net' });

    expect((await s.ctl.send({ ...init, body: 'Sounds good.' })).ok).toBe(true);
    const { h, body } = sentHeaders(s.smtp);
    expect(headerGet(h, 'in-reply-to')).toBe('<orig-1@example.org>');
    expect((headerGet(h, 'references') ?? '').split(/\s+/)).toEqual(['<root@example.org>', '<orig-1@example.org>']);
    expect(body).toMatch(/^Sounds good\.\n\nOn .*2026.*, Bob <bob@example\.org> wrote:\n> The TEXT body\.\n> Second line\.\n$/);
    expect(body).not.toContain('HTML-ONLY-MARKER');

    // unchecked: no quote
    expect((await s.ctl.send({ ...init, body: 'No quote.', includeQuoted: false })).ok).toBe(true);
    expect(sentHeaders(s.smtp).body).toBe('No quote.\n');

    // forward: Fwd: subject, the forwarded block, no In-Reply-To
    const fwd = s.ctl.composeInit('forward', id);
    expect(fwd).toMatchObject({ ok: true, subject: 'Fwd: Re: Plans', to: '' });
    expect((await s.ctl.send({ ...fwd, to: 'erin@example.com', body: 'FYI' })).ok).toBe(true);
    const f = sentHeaders(s.smtp);
    expect(headerGet(f.h, 'in-reply-to')).toBeUndefined();
    expect(f.body).toContain('---------- Forwarded message ----------\nFrom: Bob <bob@example.org>');
    expect(f.body).toContain('The TEXT body.');
    expect(f.body).not.toContain('HTML-ONLY-MARKER');
  });

  it('the renderer cannot smuggle a reference: refMessage is ignored for a NEW message, and fields are typed', () => {
    expect(composeFields({ mode: 'new', refMessage: 5 }).refMessage).toBe(0);
    expect(composeFields({ mode: 'evil', to: 7, includeQuoted: 'yes' })).toMatchObject({ mode: 'new', to: '', includeQuoted: false });
  });
});

describe('send (38) — the gate: no mail network activity during a task, and NO automatic flush after it', () => {
  it('a Send during a task goes to the Outbox with the reason, connects to nothing, and is only sent by Retry', async () => {
    const s = setup({ retryBaseMs: 20 });
    await ready(s);
    s.setGate('an agent task is running');
    const r = await s.ctl.send(draft());
    expect(r).toMatchObject({ ok: false, queued: true, refused: 'an agent task is running' });
    expect(s.smtp.connections).toBe(0);
    expect(s.imap.transcript).toBe('');
    const items = s.ctl.outbox('work').items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'failed', autoRetry: false });
    expect(items[0].error).toMatch(/agent task is running.*not sent automatically.*Retry/);
    expect(s.audits.find((a) => a.detail.action === 'send')?.detail).toMatchObject({ result: 'refused', recipients: 1 });

    // the task ends: NOTHING goes out on its own
    s.setGate(null);
    await sleep(150);
    expect(s.smtp.connections).toBe(0);
    expect(s.ctl.outbox().items).toHaveLength(1);

    // the user's Retry sends it
    const again = await s.ctl.retry(items[0].id);
    expect(again).toMatchObject({ ok: true, sentCopy: 'appended' });
    expect(s.smtp.received).toHaveLength(1);
    expect(s.ctl.outbox().items).toEqual([]);
  });

  it('Retry while the gate is still closed is refused the same way', async () => {
    const s = setup();
    await ready(s);
    s.setGate('a confirmation is pending');
    const r = await s.ctl.send(draft());
    const retry = await s.ctl.retry(r.outboxId);
    expect(retry).toMatchObject({ ok: false, queued: true, refused: 'a confirmation is pending' });
    expect(s.smtp.connections).toBe(0);
  });

  it('a transient failure retries automatically with backoff; a task starting CANCELS the pending retry', async () => {
    const s = setup({ smtp: { dataReply: '451 4.3.0 try later' }, retryBaseMs: 40 });
    await ready(s);
    const r = await s.ctl.send(draft());
    expect(r).toMatchObject({ ok: false, queued: true, stage: 'data', retryInMs: 40 });
    expect(s.ctl.outbox().items[0]).toMatchObject({ status: 'failed', autoRetry: true, attempts: 1 });
    // the automatic second attempt fails too, and the next delay doubles
    await expect.poll(() => s.ctl.outbox().items[0].attempts, { timeout: 2_000, interval: 5 }).toBeGreaterThanOrEqual(2);
    const second = s.ctl.outbox().items[0];
    expect(second.autoRetry).toBe(true);
    expect(second.error).toMatch(/retrying automatically in \d+s/);
    // now an agent task starts: the pending retry is cancelled, and stays cancelled after the task
    const conns = s.smtp.connections;
    s.ctl.disconnectAll();
    await sleep(300);
    expect(s.smtp.connections).toBe(conns);
    const item = s.ctl.outbox().items[0];
    expect(item).toMatchObject({ autoRetry: false, nextAttemptAt: 0 });
    expect(item.error).toMatch(/Automatic retry cancelled \(an agent task started\)/);
  });

  it('a transient failure that clears is delivered by the automatic retry', async () => {
    const s = setup({ smtp: { dataReply: '451 4.3.0 try later' }, retryBaseMs: 30 });
    await ready(s);
    await s.ctl.send(draft());
    (s.smtp.opts as FakeSmtpOptions).dataReply = undefined;
    await expect.poll(() => s.ctl.outbox().items.length, { timeout: 2_000 }).toBe(0);
    expect(s.smtp.received.at(-1)?.to).toEqual(['bob@example.org']);
    expect(s.audits.filter((a) => a.detail.action === 'send').map((a) => [a.detail.result, a.detail.trigger])).toEqual([
      ['failed', 'user'],
      ['sent', 'auto'],
    ]);
  });

  it('a permanent failure (5xx, rejected recipient) is never retried automatically', async () => {
    const s = setup({ smtp: { rejectRcpt: { 'bob@example.org': '550 5.1.1 no such user' } }, retryBaseMs: 10 });
    await ready(s);
    const r = await s.ctl.send(draft());
    expect(r).toMatchObject({ ok: false, queued: true, stage: 'rcpt', rejected: [{ address: 'bob@example.org', code: 550 }] });
    await sleep(80);
    expect(s.smtp.connections).toBe(1);
    expect(s.ctl.outbox().items[0]).toMatchObject({ autoRetry: false, attempts: 1 });
  });
});

describe('send (38) — Sent copy', () => {
  it('Gmail files sent mail itself: no APPEND (no duplicate), reported as skipped', async () => {
    expect(serverFilesSentMail({ host: 'imap.gmail.com' })).toBe(true);
    expect(serverFilesSentMail({ host: 'mail.example.com', smtpHost: 'smtp.googlemail.com' })).toBe(true);
    expect(serverFilesSentMail({ host: 'gmail.com.example.net' })).toBe(false);
    expect(serverFilesSentMail({ host: 'notgmail.com' })).toBe(false);
    const s = setup();
    await ready(s, { ...account, host: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' });
    const r = await s.ctl.send(draft());
    expect(r).toMatchObject({ ok: true, sentCopy: 'skipped' });
    expect(s.imap.transcript).not.toContain('APPEND');
    expect(s.audits.find((a) => a.detail.action === 'send')?.detail).toMatchObject({ result: 'sent', sentCopy: 'skipped' });
  });

  it('an APPEND failure does not fail the send; it is reported and audited', async () => {
    const s = setup({ imap: { refuseAuth: true } });
    await ready(s);
    const r = await s.ctl.send(draft());
    expect(r).toMatchObject({ ok: true, sentCopy: 'failed' });
    expect(r.sentCopyError).toBeTruthy();
    expect(s.smtp.received).toHaveLength(1);
    expect(s.ctl.outbox().items).toEqual([]);
    expect(s.audits.find((a) => a.detail.action === 'send')?.detail).toMatchObject({ result: 'sent', sentCopy: 'failed' });
  });
});

describe('send (38) — credentials', () => {
  it('an OAuth account without a current access token is REFUSED with a clear message (refresh is not wired for sending)', async () => {
    const s = setup();
    await ready(s);
    const sec = (s.ctl as unknown as { sec(): { set(id: string, v: unknown): { ok: boolean } } }).sec();
    expect(sec.set('work', { kind: 'oauth', refreshToken: 'r' }).ok).toBe(true);
    const r = await s.ctl.send(draft());
    expect(r).toMatchObject({ ok: false, queued: true });
    expect(r.error).toMatch(/OAuth.*refresh is not wired for sending.*refused/);
    expect(s.smtp.connections).toBe(0);
    // with a current token it is XOAUTH2
    const t = setup({ smtp: { mechanisms: ['XOAUTH2'], password: 'access-1' } });
    await ready(t);
    (t.ctl as unknown as { sec(): { set(id: string, v: unknown): unknown } }).sec().set('work', { kind: 'oauth', refreshToken: 'r', accessToken: 'access-1', expiresAt: Date.now() + 3_600_000 });
    expect((await t.ctl.send(draft())).ok).toBe(true);
    expect(t.smtp.auths[0]).toMatchObject({ mech: 'XOAUTH2', user: 'ada', secret: 'access-1' });
  });

  it('account SMTP settings: defaults, and plaintext / port 25 refused at validation', () => {
    const base = { ...account, smtpHost: undefined, smtpPort: undefined, smtpTls: undefined };
    const d = normalizeAccount(base);
    expect(d.ok && d.account).toMatchObject({ smtpHost: 'imap.example.com', smtpPort: 465, smtpTls: 'implicit' });
    const st = normalizeAccount({ ...base, smtpTls: 'starttls' });
    expect(st.ok && st.account.smtpPort).toBe(587);
    const none = normalizeAccount({ ...base, smtpTls: 'none' });
    expect(!none.ok && none.error).toMatch(/plaintext sending is refused/);
    const p25 = normalizeAccount({ ...base, smtpPort: 25 });
    expect(!p25.ok && p25.error).toMatch(/port 25/);
  });
});

describe('send (38) — the store: v4 migration, drafts and outbox survive a restart', () => {
  it('migrates a v3 store: accounts get SMTP = their host / 465 / implicit; drafts and outbox tables appear', () => {
    const f = join(tmp(), DB_FILE);
    const s = new MailStore(f);
    s.addAccount({ id: 'old', name: 'Old', address: 'old@example.com', kind: 'imap', host: 'mail.example.com', port: 993, tls: 'implicit', username: 'old', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive' });
    s.upsertMessage({ accountId: 'old', folder: 'INBOX', uid: 1, subject: 'kept' });
    s.close();
    const raw = new DatabaseSync(f);
    raw.exec('DROP TABLE draft');
    raw.exec('DROP TABLE outbox');
    for (const c of ['smtpHost', 'smtpPort', 'smtpTls']) raw.exec(`ALTER TABLE account DROP COLUMN ${c}`);
    raw.exec('PRAGMA user_version = 3');
    raw.close();
    const again = new MailStore(f);
    // ticket 41 moved the schema to v5 and triage (item 4) to v6; a v3 store migrates through v4 to it
    expect(SCHEMA_VERSION).toBe(6);
    expect(again.schemaVersion()).toBe(6);
    expect(again.listAccounts()[0]).toMatchObject({ id: 'old', smtpHost: 'mail.example.com', smtpPort: 465, smtpTls: 'implicit' });
    expect(again.byUid('old', 'INBOX', 1)?.subject).toBe('kept');
    expect(again.saveDraft({ accountId: 'old', subject: 'd' }).ok).toBe(true);
    expect(again.columnNames()).toEqual(expect.arrayContaining(['smtpHost', 'smtpPort', 'smtpTls', 'autoRetry', 'nextAttemptAt']));
    again.close();
  });

  it('a draft and a refused Outbox item survive a restart; an item that was mid-send waits for Retry', async () => {
    const a = setup();
    await ready(a);
    const d = a.ctl.draftSave(draft({ subject: 'Unfinished thought', body: 'half a sentence' }));
    if (!d.ok) throw new Error('draft');
    a.setGate('an agent task is running');
    const q = await a.ctl.send(draft({ subject: 'Queued during a task' }));
    const store = (a.ctl as unknown as { db(): MailStore }).db();
    // another item that was being sent when the app stopped
    const mid = store.addOutbox({ accountId: 'work', messageId: '<m@example.com>', subject: 'mid-send', envelopeFrom: 'ada@example.com', envelopeTo: ['bob@example.org'], domains: ['example.org'], raw: 'Subject: x\r\n\r\nx\r\n', bytes: 16 });
    if (!mid.ok) throw new Error('outbox');
    store.updateOutbox(mid.id, { status: 'sending', autoRetry: true });
    a.ctl.dispose();

    const b = setup({ dir: a.dir });
    expect(b.ctl.unlock('correct horse battery').ok).toBe(true);
    const drafts = b.ctl.drafts('work').drafts;
    expect(drafts.map((x) => x.subject)).toEqual(['Unfinished thought']);
    const got = b.ctl.draftGet(drafts[0].id);
    expect(got.ok && got.draft).toMatchObject({ to: 'Bob <bob@example.org>', body: 'half a sentence' });
    const items = b.ctl.outbox().items;
    expect(items.map((x) => x.subject).sort()).toEqual(['Queued during a task', 'mid-send']);
    expect(items.every((x) => x.status === 'failed' && !x.autoRetry)).toBe(true);
    expect(items.find((x) => x.subject === 'mid-send')!.error).toMatch(/may or may not have been delivered/);
    // nothing was sent by starting up
    await sleep(50);
    expect(b.smtp.connections).toBe(0);
    // and Retry works from the new process
    expect((await b.ctl.retry(q.outboxId)).ok).toBe(true);
    expect(b.smtp.received[0].data.toString()).toContain('Subject: Queued during a task');
  });

  it('the folder tree shows Drafts / Outbox from the local store', async () => {
    const s = setup();
    await ready(s);
    s.ctl.draftSave(draft());
    s.setGate('task');
    await s.ctl.send(draft());
    const tree = s.ctl.folders('work').tree[0].rows;
    expect(tree.find((r) => r.label === 'Drafts')).toMatchObject({ id: 'local:drafts', counts: { total: 1 } });
    expect(tree.find((r) => r.label === 'Outbox')).toMatchObject({ id: 'local:outbox', counts: { unseen: 1, total: 1 } });
  });
});

// ---------------------------------------------------------------- structural: the agent cannot reach send

const ROOT = join(__dirname, '..', '..');

/** Relative imports of a source file, resolved to repo-relative .ts paths. */
function importsOf(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
    const base = resolve(dirname(join(ROOT, file)), m[1]);
    for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(cand)) {
        out.push(cand.slice(ROOT.length + 1));
        break;
      }
    }
  }
  return out;
}

function closure(entry: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  return seen;
}

const SEND_CODE = ['src/core/mail/smtp.ts', 'src/core/mail/compose.ts', 'src/main/mail/controller.ts', 'src/main/mail/socket.ts'];

describe('send (38) — STRUCTURAL: no agent, planner or tab path can reach the send code', () => {
  it('the agent side (task, planner, reader, judge, policy, driver, tab preload) imports none of it, transitively', () => {
    const agentSide = ['src/core/agent.ts', 'src/core/planner.ts', 'src/core/reader.ts', 'src/core/judge.ts', 'src/core/policy.ts', 'src/core/taint.ts', 'src/core/llm.ts', 'src/main/tabs.ts', 'src/main/tab-preload.ts', 'src/main/tab-guard.ts', 'src/main/page-scripts.ts'];
    const reach = closure(agentSide);
    expect(reach.size).toBeGreaterThan(agentSide.length); // the walk found real imports
    for (const f of SEND_CODE) expect(reach.has(f), f).toBe(false);
    for (const f of reach) expect(f, `${f} is agent-reachable`).not.toMatch(/(^|\/)mail\//);
  });

  it('only the mail controller and the socket factory import the SMTP client; only the runtime constructs the controller', () => {
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${d}/${e.name}`);
        else if (e.name.endsWith('.ts')) all.push(`${d}/${e.name}`);
      }
    };
    walk('src');
    const importers = (target: string) => all.filter((f) => importsOf(f).includes(target)).sort();
    expect(importers('src/core/mail/smtp.ts')).toEqual(['src/main/mail/controller.ts', 'src/main/mail/socket.ts']);
    expect(importers('src/core/mail/compose.ts')).toEqual(['src/main/mail/controller.ts']);
    // runtime.ts constructs it; deps.ts is the TYPE of the handle ipc-mail.ts calls (`rt.mail()`)
    expect(importers('src/main/mail/controller.ts')).toEqual(['src/main/runtime.ts', 'src/main/runtime/deps.ts']);
    expect(readFileSync(join(ROOT, 'src/main/runtime/deps.ts'), 'utf8')).toMatch(/import type \{ MailController \} from '\.\.\/mail\/controller'/);
  });

  it('there is no planner tool for mail, and the send channels are registered only on the chrome table', () => {
    expect(JSON.stringify(PLANNER_TOOLS)).not.toMatch(/mail|smtp|compose|outbox|draft/i);
    // the tab preload exposes nothing mail-shaped
    expect(readFileSync(join(ROOT, 'src/main/tab-preload.ts'), 'utf8')).not.toMatch(/mail:/);
    const handlers = readdirSync(join(ROOT, 'src/main/runtime')).filter((f) => f.endsWith('.ts'));
    const registering = handlers.filter((f) => /on\('mail:send'/.test(readFileSync(join(ROOT, 'src/main/runtime', f), 'utf8')));
    expect(registering).toEqual(['ipc-mail.ts']);
    expect(readFileSync(join(ROOT, 'src/main/runtime.ts'), 'utf8')).not.toMatch(/mail:send/);
  });

  it('the runtime gate refuses mail while a task runs OR a confirmation is pending', () => {
    const rt = readFileSync(join(ROOT, 'src/main/runtime.ts'), 'utf8');
    const ctl = rt.slice(rt.indexOf('mailController ??= new MailController('));
    const gate = ctl.slice(0, ctl.indexOf('audit:'));
    expect(gate).toMatch(/current\s*\?/);
    expect(gate).toMatch(/broker\.pendingCount\(\) > 0/);
  });
});

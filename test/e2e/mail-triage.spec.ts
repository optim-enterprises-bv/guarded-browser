// AI capabilities item 4 — safe inbox triage, through the real UI: a fake IMAP server (implicit TLS on
// loopback, trusted only through the test-only GUARDED_TEST_MAIL_CA hook) and the mock LLM scripted
// PER MESSAGE as the quarantined `triage` role. What is checked: the triage table (categories, due
// dates, amounts), the "bills due this week" filter, a bulk archive whose confirmation lists exactly
// the chosen messages and moves them on the server only after Approve (and nothing after Deny), Draft
// reply opening compose without sending, triage refused (and stopped) around an agent task, and what
// the model received: one message per request, no HTML, no other message's text, no tools.

import { test, expect } from '@playwright/test';
import { launch, type App } from './harness';
import { FakeImapServer } from '../helpers/fake-imap';
import { FakeSmtpServer } from '../helpers/fake-smtp';
import { makeTestCert, listenImapTls, type TestCert } from '../helpers/mail-tls';
import { startMockLlm, type MockCall, type MockLlm } from '../helpers/mock-llm';

let cert: TestCert;
let mock: MockLlm;
let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let imapSrv: { port: number; close(): Promise<void> };
let smtpSrv: { port: number; close(): Promise<void> };
let a: App | undefined;

/** YYYY-MM-DD, local time, `n` days from today (the app's "this week" is local too) */
const day = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const mail = (o: { id: string; from: string; subject: string; text: string; html?: string }) =>
  [
    `From: ${o.from}`,
    'To: ada@example.com',
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}@example.org>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...(o.html
      ? ['Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', '', o.text, '--b1', 'Content-Type: text/html; charset=utf-8', '', o.html, '--b1--', '']
      : ['Content-Type: text/plain; charset=utf-8', '', o.text, '']),
  ].join('\r\n');

/** uid -> message. Each body carries a marker the mock script keys on (and the requests are checked for). */
const MESSAGES = [
  { uid: 1, raw: mail({ id: 'power', from: 'Power Co <billing@power.example>', subject: 'Electricity bill', text: `Please pay 81.20 EUR by ${day(2)}. MARK-POWER`, html: '<html><body><h1>HTML-ONLY-POWER</h1><p>Please pay</p></body></html>' }) },
  { uid: 2, raw: mail({ id: 'water', from: 'Water Board <invoices@water.example>', subject: 'Water invoice', text: `Amount due 23.50 GBP, due ${day(5)}. MARK-WATER` }) },
  { uid: 3, raw: mail({ id: 'rent', from: 'Landlord <rent@flat.example>', subject: 'Rent for next month', text: `Rent of 900 EUR is due ${day(20)}. MARK-RENT` }) },
  { uid: 4, raw: mail({ id: 'news', from: 'Weekly <news@letters.example>', subject: 'Ten links', text: 'This week in links. MARK-NEWS' }) },
  { uid: 5, raw: mail({ id: 'bob', from: 'Bob <bob@friends.example>', subject: 'Dinner on Friday?', text: 'Are you free for dinner on Friday? MARK-BOB' }) },
];
const MARKERS = ['MARK-POWER', 'MARK-WATER', 'MARK-RENT', 'MARK-NEWS', 'MARK-BOB'];

function triage(c: MockCall) {
  const t = c.transcript;
  const j = (facts: Record<string, unknown>) => ({ json: { needsReply: false, dueDate: null, amount: null, confidence: 0.9, ...facts } });
  if (t.includes('MARK-POWER')) return j({ category: 'bill', dueDate: day(2), amount: { value: 81.2, currency: 'EUR' }, label: 'Power Co electricity bill' });
  if (t.includes('MARK-WATER')) return j({ category: 'bill', dueDate: day(5), amount: { value: 23.5, currency: 'GBP' }, label: 'Water Board invoice' });
  if (t.includes('MARK-RENT')) return j({ category: 'bill', dueDate: day(20), amount: { value: 900, currency: 'EUR' }, label: 'Rent' });
  if (t.includes('MARK-NEWS')) return j({ category: 'newsletter', label: 'Weekly links' });
  if (t.includes('MARK-BOB')) return j({ category: 'personal', needsReply: true, label: 'Dinner invitation from Bob' });
  return j({ category: 'other', label: '' });
}

test.beforeAll(async () => {
  cert = makeTestCert();
  mock = await startMockLlm();
});
test.afterAll(async () => {
  await mock.close();
});
test.beforeEach(async () => {
  mock.reset();
  mock.script('triage', triage);
  imap = new FakeImapServer({
    user: 'ada',
    password: 'pw',
    folders: [
      { path: 'INBOX', uidValidity: 42, uidNext: 6, messages: MESSAGES.map((m) => ({ uid: m.uid, flags: [], raw: m.raw })) },
      { path: 'Archive', uidValidity: 8, uidNext: 100, messages: [] },
      { path: 'Trash', uidValidity: 9, uidNext: 200, messages: [] },
      { path: 'Sent', uidValidity: 7, uidNext: 300, messages: [] },
    ],
  });
  smtp = new FakeSmtpServer({ user: 'ada', password: 'pw' });
  imapSrv = await listenImapTls(imap, cert);
  smtpSrv = await smtp.listen({ key: cert.key, cert: cert.cert });
});
test.afterEach(async () => {
  await a?.close();
  a = undefined;
  await imapSrv.close();
  await smtpSrv.close();
});

const inv = (app: App, ch: string, ...args: unknown[]) => app.ui.evaluate(([c, xs]) => (window as any).gb.invoke(c, ...(xs as unknown[])), [ch, args] as const);
const triageCalls = () => mock.calls.filter((c) => c.role === 'triage');
const folder = (path: string) => imap.folders.find((f) => f.path === path)!;

async function openMailSynced(app: App) {
  expect((await inv(app, 'mail:unlock', 'e2e passphrase for the mail store')).ok).toBe(true);
  const saved = await inv(
    app,
    'mail:account-save',
    { id: 'work', name: 'Ada Lovelace', address: 'ada@example.com', kind: 'imap', host: '127.0.0.1', port: imapSrv.port, tls: 'implicit', username: 'ada', authKind: 'password', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive', smtpHost: '127.0.0.1', smtpPort: smtpSrv.port, smtpTls: 'starttls' },
    { password: 'pw' },
  );
  expect(saved).toMatchObject({ ok: true, id: 'work' });
  await inv(app, 'chord', 'm', { ctrl: true, shift: true });
  await expect(app.ui.locator('[data-testid=mail-rows]')).toBeVisible();
  await app.ui.locator('[data-testid=account-chip][data-account-id=work]').click();
  await app.ui.locator('[data-testid=mail-sync]').click();
  await expect(app.ui.locator('[data-testid=mail-row]')).toHaveCount(5, { timeout: 20_000 });
}

async function runTriage(app: App) {
  await app.ui.locator('[data-testid=mail-triage]').click();
  await expect(app.ui.locator('[data-testid=triage-view]')).toBeVisible();
  await expect(app.ui.locator('[data-testid=triage-account]')).toHaveValue('work');
  await app.ui.locator('[data-testid=triage-run]').click();
  await expect(app.ui.locator('[data-testid=triage-row]')).toHaveCount(5, { timeout: 30_000 });
  await expect(app.ui.locator('[data-testid=triage-progress]')).toHaveAttribute('data-running', 'false');
}

const rowFor = (app: App, subject: string) => app.ui.locator('[data-testid=triage-row]', { has: app.ui.locator('[data-testid=triage-subject]', { hasText: subject }) });

test('triage: typed categories, due dates and amounts; "bills due this week"; bulk archive lists EXACTLY those messages and moves them only after Approve; the model got one message per request, no HTML, no tools', async () => {
  a = await launch({ llmUrl: mock.url, mailTestCa: cert.certPath });
  await openMailSynced(a);
  await runTriage(a);

  // the table: category chips, due date, amount, needs-reply, label — sorted by due date, undated last
  const subjects = await a.ui.locator('[data-testid=triage-subject]').allTextContents();
  expect(subjects.slice(0, 3)).toEqual(['Electricity bill', 'Water invoice', 'Rent for next month']);
  const power = rowFor(a, 'Electricity bill');
  await expect(power.locator('[data-testid=triage-category]')).toHaveText('bill');
  await expect(power.locator('[data-testid=triage-due]')).toHaveText(day(2));
  await expect(power.locator('[data-testid=triage-amount]')).toHaveText('€81.20');
  await expect(power.locator('[data-testid=triage-label]')).toHaveText('Power Co electricity bill');
  await expect(rowFor(a, 'Water invoice').locator('[data-testid=triage-amount]')).toHaveText('£23.50');
  await expect(rowFor(a, 'Ten links').locator('[data-testid=triage-category]')).toHaveText('newsletter');
  const bob = rowFor(a, 'Dinner on Friday?');
  await expect(bob.locator('[data-testid=triage-category]')).toHaveText('personal');
  await expect(bob.locator('[data-testid=triage-needs-reply]')).toHaveText('yes');
  // totals per category
  await expect(a.ui.locator('[data-testid=triage-total][data-category=bill]')).toContainText('3');
  await expect(a.ui.locator('[data-testid=triage-total][data-category=newsletter]')).toContainText('1');

  // what the model received: ONE message per request, its text only, no HTML, no tools
  const calls = triageCalls();
  expect(calls).toHaveLength(5);
  for (const c of calls) {
    expect(MARKERS.filter((m) => c.transcript.includes(m))).toHaveLength(1);
    expect(c.transcript).not.toMatch(/HTML-ONLY-POWER|<html|<h1|<p>|<body/i);
    expect(c.transcript).not.toContain('ada@example.com');
    for (const k of ['tools', 'tool_choice', 'functions']) expect(k in c.body).toBe(false);
    expect(c.messages).toHaveLength(2);
  }

  // the filters
  await a.ui.locator('[data-testid=triage-filter-reply]').click();
  await expect(a.ui.locator('[data-testid=triage-row]')).toHaveCount(1);
  await a.ui.locator('[data-testid=triage-filter-newsletters]').click();
  await expect(a.ui.locator('[data-testid=triage-subject]')).toHaveText(['Ten links']);
  await a.ui.locator('[data-testid=triage-filter-bills]').click();
  await expect(a.ui.locator('[data-testid=triage-subject]')).toHaveText(['Electricity bill', 'Water invoice']);

  // bulk archive of the bills due this week: tick them all, Archive, Review…
  await a.ui.locator('[data-testid=triage-select-all]').check();
  await a.ui.locator('[data-testid=triage-action]').selectOption('archive');
  await a.ui.locator('[data-testid=triage-scope]').selectOption('selection');
  await a.ui.locator('[data-testid=triage-plan]').click();
  const confirm = a.ui.locator('[data-testid=triage-confirm]');
  await expect(confirm).toBeVisible();
  await expect(a.ui.locator('[data-testid=triage-confirm-title]')).toHaveText('Archive: 2 message(s)?');
  await expect(a.ui.locator('[data-testid=triage-confirm-subject]')).toHaveText(['Electricity bill', 'Water invoice']);
  await expect(a.ui.locator('[data-testid=triage-confirm-from]')).toHaveText([' — Power Co <billing@power.example>', ' — Water Board <invoices@water.example>']);
  // nothing has touched the server yet
  expect(imap.transcript).not.toMatch(/UID MOVE|UID COPY/);
  expect(folder('Archive').messages).toHaveLength(0);

  await a.ui.locator('[data-testid=triage-approve]').click();
  await expect(a.ui.locator('[data-testid=triage-msg]')).toHaveText('Done: 2 message(s) changed.');
  // the fake server records a moved message as "moved <source uid>": exactly uids 1 and 2
  await expect.poll(() => folder('Archive').messages.map((m) => m.raw).sort()).toEqual(['Subject: moved 1\r\n\r\n', 'Subject: moved 2\r\n\r\n']);
  expect(folder('INBOX').messages.map((m) => m.uid)).toEqual([3, 4, 5]);
  expect(folder('Trash').messages).toHaveLength(0);

  // the audit: per run counts, model and the categories histogram — never a subject or a body
  const ev = a.audit().filter((e) => e.type === 'triage');
  const run = ev.find((e) => e.action === 'run')!;
  expect(run).toMatchObject({ accounts: ['work'], messages: 5, categories: { bill: 3, newsletter: 1, personal: 1 }, guardDrops: 0, screened: false });
  expect(String(run.model)).toContain('default@');
  expect(ev.find((e) => e.action === 'apply')).toMatchObject({ op: 'archive', messages: 2, approved: true, applied: 2 });
  expect(JSON.stringify(ev)).not.toMatch(/Electricity|Water invoice|MARK-|power\.example|Dinner/);
});

test('Deny: the confirmation lists every bill, and NOTHING is moved', async () => {
  a = await launch({ llmUrl: mock.url, mailTestCa: cert.certPath });
  await openMailSynced(a);
  await runTriage(a);
  const before = imap.transcript.length;
  await a.ui.locator('[data-testid=triage-action]').selectOption('move');
  await a.ui.locator('[data-testid=triage-target]').fill('Trash');
  await a.ui.locator('[data-testid=triage-scope]').selectOption('category:bill');
  await a.ui.locator('[data-testid=triage-plan]').click();
  await expect(a.ui.locator('[data-testid=triage-confirm-title]')).toHaveText('Move to "Trash": 3 message(s)?');
  await expect(a.ui.locator('[data-testid=triage-confirm-subject]')).toHaveText(['Electricity bill', 'Water invoice', 'Rent for next month']);
  await a.ui.locator('[data-testid=triage-deny]').click();
  await expect(a.ui.locator('[data-testid=triage-msg]')).toHaveText('Nothing was changed.');
  await a.ui.waitForTimeout(1_000);
  expect(imap.transcript.slice(before)).not.toMatch(/UID MOVE|UID COPY|UID STORE/);
  expect(folder('Trash').messages).toHaveLength(0);
  expect(folder('INBOX').messages).toHaveLength(5);
  expect(a.audit().find((e) => e.type === 'triage' && e.action === 'apply')).toMatchObject({ op: 'move', messages: 3, approved: false });
});

test('Draft reply: the quarantined role writes from ONE message + the user line; the draft opens in compose; nothing is sent', async () => {
  mock.script('draft', () => ({ content: 'Hi Bob, Friday works for me. See you then!' }));
  a = await launch({ llmUrl: mock.url, mailTestCa: cert.certPath });
  await openMailSynced(a);
  await runTriage(a);
  await rowFor(a, 'Dinner on Friday?').locator('[data-testid=triage-draft]').click();
  await expect(a.ui.locator('[data-testid=triage-draft-modal]')).toBeVisible();
  await a.ui.locator('[data-testid=triage-draft-instruction]').fill('say yes, Friday works');
  await a.ui.locator('[data-testid=triage-draft-go]').click();
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=triage-view]')).toBeHidden();
  await expect(a.ui.locator('[data-testid=compose-body]')).toHaveValue('Hi Bob, Friday works for me. See you then!');
  await expect(a.ui.locator('[data-testid=compose-to]')).toHaveValue('Bob <bob@friends.example>');
  await expect(a.ui.locator('[data-testid=compose-subject]')).toHaveValue('Re: Dinner on Friday?');
  const d = mock.calls.filter((c) => c.role === 'draft');
  expect(d).toHaveLength(1);
  expect(d[0].transcript).toContain('say yes, Friday works');
  expect(MARKERS.filter((m) => d[0].transcript.includes(m))).toEqual(['MARK-BOB']);
  for (const k of ['tools', 'tool_choice']) expect(k in d[0].body).toBe(false);
  // nothing was sent, queued or appended
  await a.ui.waitForTimeout(2_000);
  expect(smtp.connections).toBe(0);
  expect(folder('Sent').messages).toHaveLength(0);
  expect((await inv(a, 'mail:outbox', 'work')).items ?? []).toHaveLength(0);
  expect((await inv(a, 'mail:drafts', 'work')).drafts).toHaveLength(1);
});

test('triage is refused while an agent task runs, and a task starting mid-run stops it', async () => {
  // a planner that thinks for a while keeps the task running
  mock.script('planner', () => ({ tool: 'finish', args: { answer: 'done' }, delayMs: 6_000 }));
  a = await launch({ llmUrl: mock.url, mailTestCa: cert.certPath });
  await openMailSynced(a);

  await inv(a, 'agent:start', 'summarise this page');
  await expect.poll(async () => (await inv(a!, 'state:get')).task).not.toBeNull();
  await a.ui.locator('[data-testid=mail-triage]').click();
  await a.ui.locator('[data-testid=triage-run]').click();
  await expect(a.ui.locator('[data-testid=triage-msg]')).toHaveText('Not run: an agent task is running: mail will not connect while it does');
  expect(triageCalls()).toHaveLength(0);
  await expect.poll(async () => (await inv(a!, 'state:get')).task, { timeout: 30_000 }).toBeNull();

  // a slow model: the run is in progress when a task starts, and the task wins
  mock.script('triage', (c) => ({ ...triage(c), delayMs: 1_500 }));
  await a.ui.locator('[data-testid=triage-run]').click();
  await expect.poll(() => triageCalls().length).toBeGreaterThan(0);
  await inv(a, 'agent:start', 'summarise this page');
  await expect(a.ui.locator('[data-testid=triage-progress]')).toContainText('stopped: an agent task started', { timeout: 15_000 });
  const n = triageCalls().length;
  await a.ui.waitForTimeout(3_000);
  expect(triageCalls().length).toBe(n);
  expect(n).toBeLessThan(5);
  await inv(a, 'agent:stop');
  await expect.poll(async () => (await inv(a!, 'state:get')).task, { timeout: 30_000 }).toBeNull();
});

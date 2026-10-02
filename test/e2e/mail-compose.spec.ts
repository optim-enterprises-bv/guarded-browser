// Ticket 38 — compose, reply, drafts, outbox and SMTP send, through the real UI against a fake IMAP
// server (implicit TLS) and a fake SMTP server (STARTTLS) on 127.0.0.1. Both use a throwaway
// self-signed certificate that the app trusts only through the test-only GUARDED_TEST_MAIL_CA hook
// (GUARDED_TEST=1, unpackaged build, loopback hosts only); certificate verification stays on.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, type App } from './harness';
import { FakeImapServer } from '../helpers/fake-imap';
import { FakeSmtpServer } from '../helpers/fake-smtp';
import { makeTestCert, listenImapTls, type TestCert } from '../helpers/mail-tls';
import { parseHeaders, headerGet, decodeWords, decodeQuotedPrintable } from '../../src/core/mail/mime';

let cert: TestCert;
let llm: http.Server;
let llmUrl = '';
let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let imapSrv: { port: number; close(): Promise<void> };
let smtpSrv: { port: number; close(): Promise<void> };
let a: App | undefined;

const BOB_MESSAGE = [
  'From: bob@example.org',
  'To: ada@example.com',
  'Subject: Lunch plans',
  'Message-ID: <lunch-1@example.org>',
  'References: <root-1@example.org>',
  'Date: Thu, 01 Oct 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Shall we meet at noon?',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h1 style="color:#cc0000;font-size:40px">HTML-PART-ONLY</h1><p>Shall we meet at noon?</p></body></html>',
  '--b1--',
  '',
].join('\r\n');

test.beforeAll(async () => {
  cert = makeTestCert();
  // an LLM endpoint that never answers: a task started against it stays RUNNING
  llm = http.createServer(() => undefined);
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
});
test.afterAll(async () => {
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
});
test.beforeEach(async () => {
  imap = new FakeImapServer({
    user: 'ada',
    password: 'pw',
    folders: [
      { path: 'INBOX', uidValidity: 42, uidNext: 2, messages: [{ uid: 1, flags: [], raw: BOB_MESSAGE }] },
      { path: 'Sent', uidValidity: 7, uidNext: 100, messages: [] },
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
const row = (app: App, subject: string) => app.ui.locator('[data-testid=mail-row]', { hasText: subject });

/** The HTML view as main sees it: the one WebContents with JavaScript disabled. */
const htmlViewVisible = (app: App) =>
  app.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      for (const v of w.contentView.children) {
        const wc = (v as any).webContents as Electron.WebContents | undefined;
        const prefs = wc && !wc.isDestroyed() ? ((wc as any).getLastWebPreferences?.() as Electron.WebPreferences | null) : null;
        if (prefs && prefs.javascript === false) return v.getVisible();
      }
    }
    return false;
  });

/** Unlock, add the account (fake IMAP + STARTTLS SMTP on loopback), open mail and check the account. */
async function openMail(app: App, opts: { add?: boolean } = {}) {
  expect((await inv(app, 'mail:unlock', 'e2e passphrase for the mail store')).ok).toBe(true);
  if (opts.add !== false) {
    const saved = await inv(
      app,
      'mail:account-save',
      { id: 'work', name: 'Ada Lovelace', address: 'ada@example.com', kind: 'imap', host: '127.0.0.1', port: imapSrv.port, tls: 'implicit', username: 'ada', authKind: 'password', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive', smtpHost: '127.0.0.1', smtpPort: smtpSrv.port, smtpTls: 'starttls' },
      { password: 'pw' },
    );
    expect(saved).toMatchObject({ ok: true, id: 'work' });
  }
  await inv(app, 'chord', 'm', { ctrl: true, shift: true });
  await expect(app.ui.locator('[data-testid=mail-rows]')).toBeVisible();
  await app.ui.locator('[data-testid=account-chip][data-account-id=work]').click();
}

async function syncAndOpenBob(app: App) {
  await app.ui.locator('[data-testid=mail-sync]').click();
  await expect(row(app, 'Lunch plans')).toBeVisible({ timeout: 20_000 });
  await row(app, 'Lunch plans').click();
  await expect(app.ui.locator('[data-testid=mail-subject]')).toHaveText('Lunch plans');
}

const lastSent = () => {
  const raw = smtp.received.at(-1)!.data.toString('utf8');
  const h = parseHeaders(raw.slice(0, raw.indexOf('\r\n\r\n') + 2));
  return { raw, h, body: decodeQuotedPrintable(raw.slice(raw.indexOf('\r\n\r\n') + 4), 100_000) };
};

test('compose a NEW message in the UI: STARTTLS send with the right envelope and headers, a copy in Sent, the HTML view hidden while composing', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath });
  await openMail(a);
  await syncAndOpenBob(a);
  // the HTML message is up in the native view...
  await expect.poll(() => htmlViewVisible(a!)).toBe(true);

  // ...and the compose form replaces the reading pane: the native view must step aside
  await a.ui.locator('[data-testid=mail-compose]').click();
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=mail-body]')).toBeHidden();
  await expect.poll(() => htmlViewVisible(a!)).toBe(false);

  await expect(a.ui.locator('[data-testid=compose-from]')).toHaveValue('work');
  await a.ui.locator('[data-testid=compose-to]').fill('Carol <carol@example.net>');
  await a.ui.locator('[data-testid=compose-bcc-toggle]').click();
  await a.ui.locator('[data-testid=compose-bcc]').fill('sam@hidden.example');
  await a.ui.locator('[data-testid=compose-subject]').fill('Grüße from the browser');
  await a.ui.locator('[data-testid=compose-body]').fill('Hello Carol,\n.a line that starts with a dot\nsee you');
  await a.ui.locator('[data-testid=compose-send]').click();

  await expect(a.ui.locator('[data-testid=mail-status]')).toHaveText('Sent.', { timeout: 20_000 });
  // the envelope (Bcc included), over TLS, authenticated after the upgrade
  expect(smtp.received).toHaveLength(1);
  expect(smtp.received[0]).toMatchObject({ from: 'ada@example.com', to: ['carol@example.net', 'sam@hidden.example'], secure: true });
  expect(smtp.auths).toEqual([{ mech: 'PLAIN', user: 'ada', secret: 'pw', secure: true }]);
  expect(smtp.violations).toEqual([]);
  expect(smtp.ehlos).toEqual([{ secure: false }, { secure: true }]);
  // the headers: From with the display name, To, an encoded subject, a Message-ID, and NO Bcc
  const { raw, h, body } = lastSent();
  expect(headerGet(h, 'from')).toBe('Ada Lovelace <ada@example.com>');
  expect(headerGet(h, 'to')).toBe('Carol <carol@example.net>');
  expect(decodeWords(headerGet(h, 'subject') ?? '', 200)).toBe('Grüße from the browser');
  expect(headerGet(h, 'message-id')).toMatch(/^<.+@example\.com>$/);
  expect(raw).not.toMatch(/^Bcc:/im);
  expect(raw).not.toContain('hidden.example');
  expect(body).toBe('Hello Carol,\n.a line that starts with a dot\nsee you\n');

  // the copy in Sent, via APPEND, is the same message
  await expect.poll(() => imap.folders.find((f) => f.path === 'Sent')!.messages.length).toBe(1);
  expect(imap.folders.find((f) => f.path === 'Sent')!.messages[0].raw).toContain(headerGet(h, 'message-id')!);

  // the form is gone, the message is back, and so is its HTML view
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeHidden();
  await expect.poll(() => htmlViewVisible(a!)).toBe(true);

  // the audit line: counts and domains, never the addresses, subject or body
  const ev = a.audit().find((e) => e.action === 'send');
  expect(ev).toMatchObject({ account: 'work', recipients: 2, result: 'sent', sentCopy: 'appended', domains: ['example.net', 'hidden.example'] });
  expect(JSON.stringify(ev)).not.toMatch(/carol@|sam@|Grüße|Hello Carol/);

  // Ctrl+N inside the mail panel opens an empty form; Discard closes it
  await a.ui.locator('[data-testid=mail-search]').click();
  await a.ui.keyboard.press('Control+n');
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=compose-to]')).toHaveValue('');
  await a.ui.locator('[data-testid=compose-discard]').click();
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeHidden();
});

test('REPLY with the Reply button and with the quick-reply strip: threading headers, and the quote is the TEXT body', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath });
  await openMail(a);
  await syncAndOpenBob(a);

  await a.ui.locator('[data-testid=mail-reply]').click();
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=compose-to]')).toHaveValue('bob@example.org');
  await expect(a.ui.locator('[data-testid=compose-subject]')).toHaveValue('Re: Lunch plans');
  await expect(a.ui.locator('[data-testid=compose-quoted]')).toBeChecked();
  await a.ui.locator('[data-testid=compose-body]').fill('Noon works.');
  await a.ui.locator('[data-testid=compose-send]').click();
  await expect(a.ui.locator('[data-testid=mail-status]')).toHaveText('Sent.', { timeout: 20_000 });

  const r1 = lastSent();
  expect(smtp.received.at(-1)!.to).toEqual(['bob@example.org']);
  expect(decodeWords(headerGet(r1.h, 'subject') ?? '', 200)).toBe('Re: Lunch plans');
  const parent = headerGet(r1.h, 'in-reply-to');
  expect(parent).toBe('<lunch-1@example.org>');
  // the parent's References chain (from its stored header), then the parent
  expect((headerGet(r1.h, 'references') ?? '').split(/\s+/)).toEqual(['<root-1@example.org>', '<lunch-1@example.org>']);
  expect(r1.body).toMatch(/^Noon works\.\n\nOn .+, bob@example\.org wrote:\n> Shall we meet at noon\?\n$/);
  expect(r1.raw).not.toContain('HTML-PART-ONLY');

  // the quick-reply strip under the message: a reply to the OPEN message, quote off by default
  await expect(a.ui.locator('[data-testid=mail-subject]')).toHaveText('Lunch plans');
  await a.ui.locator('[data-testid=mail-compose-box]').fill('Quick one.');
  await a.ui.locator('[data-testid=mail-send]').click();
  await expect.poll(() => smtp.received.length, { timeout: 20_000 }).toBe(2);
  const r2 = lastSent();
  expect(headerGet(r2.h, 'in-reply-to')).toBe(parent);
  expect(r2.body).toBe('Quick one.\n');
  await expect(a.ui.locator('[data-testid=mail-compose-box]')).toHaveValue('');
  await expect.poll(() => imap.folders.find((f) => f.path === 'Sent')!.messages.length).toBe(2);
});

test('a Send during a running agent task is REFUSED and stays in the Outbox; it goes out only when the user presses Retry; a tab cannot invoke mail:send', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath });
  await openMail(a);
  await syncAndOpenBob(a);
  const imapBefore = imap.transcript.length;

  // a task is running (its LLM never answers)
  await inv(a, 'agent:start', 'summarise this page');
  await expect.poll(async () => (await inv(a!, 'state:get')).task).not.toBeNull();

  await a.ui.locator('[data-testid=mail-compose]').click();
  await a.ui.locator('[data-testid=compose-to]').fill('carol@example.net');
  await a.ui.locator('[data-testid=compose-subject]').fill('Sent during a task');
  await a.ui.locator('[data-testid=compose-body]').fill('This must wait.');
  await a.ui.locator('[data-testid=compose-send]').click();
  await expect(a.ui.locator('[data-testid=mail-status]')).toContainText('Not sent: an agent task is running');
  expect(smtp.connections).toBe(0);
  expect(imap.transcript.length).toBe(imapBefore);

  // it is in the Outbox, with the reason and a Retry
  await a.ui.locator('[data-testid="tree-local:outbox"]').click();
  const item = a.ui.locator('[data-testid=outbox-row]');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Sent during a task');
  await expect(item.locator('[data-testid=outbox-error]')).toContainText('an agent task is running');

  // a page cannot reach the send channel: a tab's webContents as the sender is refused
  const fromTab = await a.app.evaluate(async ({ ipcMain, webContents }) => {
    // the page tab: not the chrome document, not the mail HTML view (a data: URL)
    const tab = webContents.getAllWebContents().find((w) => !w.getURL().includes('/renderer/') && !w.getURL().startsWith('data:') && !w.getURL().startsWith('devtools:'));
    if (!tab) return 'no tab';
    const handler = (ipcMain as any)._invokeHandlers.get('mail:send');
    try {
      await handler({ sender: tab, senderFrame: tab.mainFrame }, { accountId: 'work', to: 'eve@example.com', subject: 'x', body: 'x' });
      return 'sent';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(fromTab).toBe('unknown sender');

  // the task ends: NOTHING is sent on its own
  await inv(a, 'agent:stop');
  // the task ends once its (never-answering) model call times out
  await expect.poll(async () => (await inv(a!, 'state:get')).task, { timeout: 60_000 }).toBeNull();
  await a.ui.waitForTimeout(2_000);
  expect(smtp.connections).toBe(0);
  await expect(item).toHaveCount(1);

  // the user's Retry sends it
  await item.locator('[data-testid=outbox-retry]').click();
  await expect.poll(() => smtp.received.length, { timeout: 20_000 }).toBe(1);
  expect(smtp.received[0].to).toEqual(['carol@example.net']);
  await expect(a.ui.locator('[data-testid=outbox-row]')).toHaveCount(0);
  const results = a.audit().filter((e) => e.action === 'send').map((e) => e.result);
  expect(results).toEqual(['refused', 'sent']);
});

test('a DRAFT autosaves and survives an app restart', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath, keepUserData: true });
  const userData = a.userData;
  await openMail(a);
  await a.ui.locator('[data-testid=mail-compose]').click();
  await a.ui.locator('[data-testid=compose-to]').fill('Dave <dave@example.net>');
  await a.ui.locator('[data-testid=compose-subject]').fill('An unfinished thought');
  await a.ui.locator('[data-testid=compose-body]').fill('half a sentence');
  // the autosave (debounced): no button pressed
  await expect(a.ui.locator('[data-testid=compose-msg]')).toContainText('Draft saved');
  await a.close();
  a = undefined;

  a = await launch({ llmUrl, mailTestCa: cert.certPath, userData });
  await openMail(a, { add: false });
  await a.ui.locator('[data-testid="tree-local:drafts"]').click();
  const d = a.ui.locator('[data-testid=draft-row]');
  await expect(d).toHaveCount(1);
  await expect(d).toContainText('An unfinished thought');
  await d.click();
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=compose-to]')).toHaveValue('Dave <dave@example.net>');
  await expect(a.ui.locator('[data-testid=compose-subject]')).toHaveValue('An unfinished thought');
  await expect(a.ui.locator('[data-testid=compose-body]')).toHaveValue('half a sentence');
  expect(smtp.connections).toBe(0);
});

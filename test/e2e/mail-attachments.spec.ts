// Ticket 41 — attachments through the real UI, against the fake IMAP server (implicit TLS) and the fake
// SMTP server (STARTTLS) on 127.0.0.1, both behind a throwaway CA the app trusts only through the
// test-only GUARDED_TEST_MAIL_CA hook. "Attach…" uses the GUARDED_TEST_ATTACH_FILE hook instead of the
// native dialog (GUARDED_TEST=1 + unpackaged only).
//
// What is fetched, and when, is asserted from the fake server's own record of the sections it served
// (`sectionFetches`) and its command transcript — never from the UI's account of itself.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { launch, type App } from './harness';
import { FakeImapServer } from '../helpers/fake-imap';
import { FakeSmtpServer } from '../helpers/fake-smtp';
import { makeTestCert, listenImapTls, type TestCert } from '../helpers/mail-tls';
import { PDF_BYTES, PNG_BYTES, attachmentsMessage, cidMessage, receivedParts } from '../helpers/mail-fixtures';

let cert: TestCert;
let llm: http.Server;
let llmUrl = '';
let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let imapSrv: { port: number; close(): Promise<void> };
let smtpSrv: { port: number; close(): Promise<void> };
let a: App | undefined;

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
      { path: 'INBOX', uidValidity: 42, uidNext: 3, messages: [{ uid: 1, flags: [], raw: attachmentsMessage() }, { uid: 2, flags: [], raw: cidMessage() }] },
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
const chips = (app: App) => app.ui.locator('[data-testid=mail-attachment]');
const chip = (app: App, part: string) => app.ui.locator(`[data-testid=mail-attachment][data-part="${part}"]`);
/** the sections the server served for one message, in order */
const served = (uid: number) => imap.sectionFetches.filter((f) => f.uid === uid).map((f) => f.section);

async function openMail(app: App) {
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
  await expect(row(app, 'Report and chart')).toBeVisible({ timeout: 20_000 });
}

async function openReport(app: App) {
  await row(app, 'Report and chart').click();
  await expect(app.ui.locator('[data-testid=mail-subject]')).toHaveText('Report and chart');
  await expect(chips(app)).toHaveCount(2);
}

test('a message with a PDF and an image shows two chips; nothing is fetched until a click; Download saves the exact bytes into the downloads list; a tab cannot call it', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath });
  await openMail(a);
  await openReport(a);

  // the chips: name, type, size — as text
  await expect(chip(a, '2').locator('[data-testid=att-name]')).toHaveText('report.pdf');
  await expect(chip(a, '2')).toContainText('application/pdf');
  await expect(chip(a, '3').locator('[data-testid=att-name]')).toHaveText('chart.png');
  await expect(chip(a, '3')).toContainText('image/png');
  await expect(chip(a, '2').locator('[data-testid=att-warning]')).toHaveCount(0);

  // NOTHING of either attachment crossed the wire: the structure, the header and the two text parts only
  expect(imap.structureFetches).toBe(1);
  expect(served(1)).toEqual(['HEADER', 'HEADER', '1.1', '1.2']);
  expect(imap.transcript).not.toMatch(/BODY(\.PEEK)?\[(2|3|)\]/);
  await a.ui.waitForTimeout(500);
  expect(served(1)).not.toContain('2');

  // a page cannot reach the download channel (the sender check in main.ts)
  const fromTab = await a.app.evaluate(async ({ ipcMain, webContents }) => {
    const tab = webContents.getAllWebContents().find((w) => !w.getURL().includes('/renderer/') && !w.getURL().startsWith('data:') && !w.getURL().startsWith('devtools:'));
    if (!tab) return 'no tab';
    const handler = (ipcMain as any)._invokeHandlers.get('mail:attachment-download');
    try {
      await handler({ sender: tab, senderFrame: tab.mainFrame }, 1, '2');
      return 'downloaded';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(fromTab).toBe('unknown sender');
  expect(served(1)).not.toContain('2');

  // the click: exactly one part fetched, decoded to the exact bytes, in the downloads folder and list
  await chip(a, '2').locator('[data-testid=att-download]').click();
  await expect(a.ui.locator('[data-testid=mail-status]')).toHaveText('Saved report.pdf to your downloads folder.', { timeout: 20_000 });
  expect(served(1).slice(4)).toEqual(['2']);
  expect(imap.transcript).toMatch(/UID FETCH 1 \(BODY\.PEEK\[2\]\)/);
  const file = join(a.userData, 'downloads', 'report.pdf');
  expect(readFileSync(file).equals(PDF_BYTES)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const list = await inv(a, 'downloads:list');
  expect(list[0]).toMatchObject({ filename: 'report.pdf', state: 'completed', path: file, host: 'mail attachment', total: PDF_BYTES.length, warning: '' });

  // a second download of the same part gets a unique name, never an overwrite
  await chip(a, '2').locator('[data-testid=att-download]').click();
  await expect.poll(async () => (await inv(a!, 'downloads:list')).length).toBe(2);
  const second = (await inv(a, 'downloads:list'))[0];
  expect(basename(second.path)).toBe('report (1).pdf');
  expect(readFileSync(second.path).equals(PDF_BYTES)).toBe(true);

  // the audit line: account, message, size, type, sanitized name — not the content
  const ev = a.audit().find((e) => e.action === 'attachment-download');
  expect(ev).toMatchObject({ account: 'work', part: '2', bytes: PDF_BYTES.length, mime: 'application/pdf', name: 'report.pdf', result: 'saved' });
  expect(JSON.stringify(a.audit())).not.toContain(PDF_BYTES.toString('base64').slice(0, 40));
});

test('a Download during a running agent task is REFUSED with the reason, and nothing reaches the server', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath });
  await openMail(a);
  await openReport(a);
  await inv(a, 'agent:start', 'summarise this page');
  await expect.poll(async () => (await inv(a!, 'state:get')).task).not.toBeNull();
  const before = imap.transcript;
  await chip(a, '3').locator('[data-testid=att-download]').click();
  await expect(a.ui.locator('[data-testid=mail-status]')).toContainText('attachments are not downloaded while an agent task is running');
  expect(imap.transcript).toBe(before);
  expect(served(1)).not.toContain('3');
  expect(await inv(a, 'downloads:list')).toEqual([]);
  // Open is refused the same way, before any dialog
  await chip(a, '3').locator('[data-testid=att-open]').click();
  await expect(a.ui.locator('[data-testid=mail-status]')).toContainText('attachments are not opened while an agent task is running');
  expect(imap.transcript).toBe(before);
});

test('compose: Attach… (main\'s dialog seam) sends a multipart message whose attachment is the file\'s exact bytes; Forward carries the original attachments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-attach-'));
  const file = join(dir, 'Quartalsübersicht.bin');
  const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('tail')]);
  writeFileSync(file, bytes);
  a = await launch({ llmUrl, mailTestCa: cert.certPath, attachFile: file });
  await openMail(a);

  await a.ui.locator('[data-testid=mail-compose]').click();
  await a.ui.locator('[data-testid=compose-to]').fill('carol@example.net');
  await a.ui.locator('[data-testid=compose-subject]').fill('Numbers attached');
  await a.ui.locator('[data-testid=compose-body]').fill('Here they are.');
  await a.ui.locator('[data-testid=compose-attach]').click();
  const att = a.ui.locator('[data-testid=compose-attachment]');
  await expect(att).toHaveCount(1);
  await expect(att).toContainText('Quartalsübersicht.bin');
  await expect(att).toContainText('260 B');
  // the private copy, not the original, is what will be sent
  writeFileSync(file, 'changed after attaching');
  await a.ui.locator('[data-testid=compose-send]').click();
  await expect(a.ui.locator('[data-testid=mail-status]')).toHaveText('Sent.', { timeout: 20_000 });
  expect(smtp.received).toHaveLength(1);
  const raw = smtp.received[0].data.toString('latin1');
  expect(raw).toMatch(/^Content-Type: multipart\/mixed;/m);
  const parts = receivedParts(raw);
  expect(parts.map((p) => p.contentType)).toEqual(['text/plain', 'application/octet-stream']);
  expect(parts[1].filename).toBe('Quartalsübersicht.bin');
  expect(parts[1].bytes.equals(bytes)).toBe(true);
  expect(parts[1].headers).toMatch(/filename="Quartalsubersicht.bin"/);

  // Forward: the original's attachments are listed, ticked, and fetched from the server at send time
  await openReport(a);
  const before = served(1).length;
  await a.ui.locator('[data-testid=mail-forward]').click();
  await expect(a.ui.locator('[data-testid=compose-fwd-attachments]')).toBeChecked();
  await expect(a.ui.locator('[data-testid=compose-fwd-attachment-names]')).toContainText('report.pdf');
  await expect(a.ui.locator('[data-testid=compose-fwd-attachment-names]')).toContainText('chart.png');
  expect(served(1).length).toBe(before); // listing them fetched nothing
  await a.ui.locator('[data-testid=compose-to]').fill('dave@example.net');
  await a.ui.locator('[data-testid=compose-send]').click();
  // (the status line still says "Sent." from the first message: wait for the SERVER instead)
  await expect.poll(() => smtp.received.length, { timeout: 20_000 }).toBe(2);
  await expect(a.ui.locator('[data-testid=mail-compose-form]')).toBeHidden();
  expect(served(1).slice(before)).toEqual(['2', '3']);
  const fwd = receivedParts(smtp.received[1].data.toString('latin1'));
  expect(fwd.map((p) => p.filename)).toEqual(['', 'report.pdf', 'chart.png']);
  expect(fwd[1].bytes.equals(PDF_BYTES)).toBe(true);
  expect(fwd[2].bytes.equals(PNG_BYTES)).toBe(true);
});

test('a cid: inline image renders in the HTML view with remote content still blocked: zero network from the view, and the document carries the image as a data: URL', async () => {
  a = await launch({ llmUrl, mailTestCa: cert.certPath });
  await openMail(a);
  const partition = `mailview-${basename(a.profileDir(0))}`;
  // record every request the view's session lets through or cancels (the view's own handlers stay in place)
  await a.app.evaluate(({ session }, p) => {
    const ses = session.fromPartition(p);
    const g = globalThis as any;
    g.__mailViewRequests = [];
    ses.webRequest.onSendHeaders((d) => g.__mailViewRequests.push(`sent ${d.url.slice(0, 60)}`));
    ses.webRequest.onErrorOccurred((d) => g.__mailViewRequests.push(`error ${d.url.slice(0, 60)}`));
    ses.webRequest.onCompleted((d) => g.__mailViewRequests.push(`done ${d.url.slice(0, 30)}`));
  }, partition);

  await expect(row(a, 'Inline logo')).toBeVisible();
  await row(a, 'Inline logo').click();
  await expect(a.ui.locator('[data-testid=mail-subject]')).toHaveText('Inline logo');
  // the PNG is part of the HTML, not an attachment chip; the SVG is not an image here, so it is listed
  await expect(chips(a)).toHaveCount(1);
  await expect(chip(a, '3')).toContainText('image/svg+xml');

  const view = () =>
    a!.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        for (const v of w.contentView.children) {
          const wc = (v as any).webContents as Electron.WebContents | undefined;
          const prefs = wc && !wc.isDestroyed() ? ((wc as any).getLastWebPreferences?.() as Electron.WebPreferences | null) : null;
          if (!wc || !prefs || prefs.javascript !== false) continue;
          return { visible: v.getVisible(), url: wc.getURL(), id: wc.id };
        }
      }
      return null;
    });
  await expect.poll(async () => (await view())?.visible).toBe(true);
  await expect.poll(async () => (await view())?.url.startsWith('data:text/html')).toBe(true);
  const doc = Buffer.from((await view())!.url.split(',')[1], 'base64').toString('utf8');
  expect(doc).toContain(`src="data:image/png;base64,${PNG_BYTES.toString('base64')}"`);
  expect(doc).toContain("img-src data:;"); // the CSP is the blocked one: remote content was not enabled
  expect(doc).not.toContain('cid:logo@shop.example');
  expect(doc).toContain('src="cid:vector@shop.example"'); // the SVG stays an unresolved, CSP-blocked cid
  // main fetched the image part through the gate; the view fetched nothing
  expect(served(2)).toContain('2');
  expect(served(2)).not.toContain('3');
  await expect(a.ui.locator('[data-testid=mail-load-remote]')).toHaveCount(0);

  // it RENDERED: the 240x240 green image is on the view's surface
  const id = (await view())!.id;
  await expect
    .poll(
      () =>
        a!.app.evaluate(async ({ webContents }, wcId) => {
          const bmp = (await webContents.fromId(wcId)!.capturePage()).toBitmap(); // BGRA
          let green = 0;
          for (let i = 0; i + 3 < bmp.length; i += 4) if (bmp[i + 1] > 150 && bmp[i] < 60 && bmp[i + 2] < 60) green++;
          return green;
        }, id),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(20_000);
  const requests: string[] = await a.app.evaluate(() => (globalThis as any).__mailViewRequests);
  // the only thing the view's session saw is its own data: document (and data: images): no http(s),
  // no ws, no file, no cid — nothing that leaves the process
  expect(requests.length).toBeGreaterThan(0); // the recorder works
  expect(requests.filter((r) => !/^(sent|error|done) data:/.test(r))).toEqual([]);
});

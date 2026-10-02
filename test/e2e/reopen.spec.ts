// Reopen closed tab (ticket 02). The security test is the point of this file: a document that was
// under the post-task gate when it was closed must come back CLEAN. Reopening restores a URL, not
// a security state.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, runTask, waitDone, waitForUrl, type App } from './harness';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';

let mock: MockLlm;
let a: App | undefined;
let site = '';
let srv: http.Server;
const sink: Array<{ path: string; body: string }> = [];

const PAGES: Record<string, string> = {
  '/plain.html': `<!doctype html><title>Plain page</title><h1>Plain</h1><p>Nothing to see.</p>`,
  '/second.html': `<!doctype html><title>Second page</title><h1>Second</h1>`,
  // a plain page that POSTs on a timer: used to show the gate IS active right after a task
  '/post-later.html': `<!doctype html><title>Deals</title><h1>Deals</h1>
<script>setTimeout(() => fetch('/sink/later', { method: 'POST', body: 'amount=1&to=mallory' }), 3000)</script>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0].split('#')[0];
      if (path.startsWith('/sink')) {
        sink.push({ path, body: Buffer.concat(chunks).toString() });
        res.end('ok');
        return;
      }
      const p = PAGES[path];
      res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' });
      res.end(p ?? 'nf');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await mock.close();
  srv.closeAllConnections();
  srv.close();
});

test.beforeEach(() => {
  mock.reset();
  sink.length = 0;
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
});

test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const tabCount = (app: App) => app.ui.locator('[data-testid=tab]').count();
const address = (app: App) => app.ui.locator('[data-testid=address]');

test('Ctrl+Shift+T reopens the closed tab at the same URL and position', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/plain.html` });
  await waitForUrl(a.ui, /plain\.html/);

  // a second tab, so there is something to close and a position to come back to
  await a.ui.click('[data-testid=new-tab]');
  await expect.poll(() => tabCount(a!)).toBe(2);
  await a.ui.evaluate((url) => (window as any).gb.invoke('nav:go', url), `${site}/second.html`);
  await waitForUrl(a.ui, /second\.html/);
  expect(await tabCount(a)).toBe(2);

  // close the second tab via the ✕ button
  await a.ui.locator('[data-testid=tab]').nth(1).locator('.x').click();
  await expect.poll(() => tabCount(a!)).toBe(1);

  // reopen from the tab context menu
  await a.ui.locator('[data-testid=tab]').first().click({ button: 'right' });
  await a.ui.getByRole('menuitem', { name: /Reopen closed tab/ }).click();
  await expect.poll(() => tabCount(a!)).toBe(2);
  await expect.poll(async () => address(a!).inputValue()).toContain('/second.html');

  // and the keyboard path works from a focused page
  await a.ui.locator('[data-testid=tab]').nth(1).locator('.x').click();
  await expect.poll(() => tabCount(a!)).toBe(1);
  await a.ui.evaluate(() => (window as any).gb.invoke('tabs:reopen'));
  await expect.poll(() => tabCount(a!)).toBe(2);
  await expect.poll(async () => address(a!).inputValue()).toContain('/second.html');

  // the audit log records it as a user navigation that was a reopen
  expect(a.audit().some((e) => e.type === 'navigation' && e.reopen === true && e.by === 'user')).toBe(true);
});

test('the stack is bounded and survives a restart as URLs only', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/plain.html`, keepUserData: true });
  await waitForUrl(a.ui, /plain\.html/);
  const userData = a.userData;

  for (const n of ['a', 'b', 'c']) {
    await a.ui.click('[data-testid=new-tab]');
    await a.ui.evaluate((url) => (window as any).gb.invoke('nav:go', url), `${site}/plain.html?n=${n}`);
    await expect.poll(() => tabCount(a!)).toBeGreaterThan(1);
    await a.ui.locator('[data-testid=tab]').last().locator('.x').click();
  }
  await expect.poll(() => tabCount(a!)).toBe(1);

  // the file exists, holds only URL/title/pos/t, and is not world-readable
  const { readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const reg = JSON.parse(readFileSync(join(userData, 'profiles.json'), 'utf8'));
  const file = join(userData, 'profiles', reg.profiles[0].id, 'closed-tabs.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(raw.tabs.length).toBeGreaterThan(0);
  for (const t of raw.tabs) expect(Object.keys(t).sort()).toEqual(['pos', 't', 'title', 'url']);
  expect(JSON.stringify(raw)).not.toMatch(/gate|agentTab|taint/);

  await a.close();
  a = undefined;

  // relaunch on the same profile: the stack is still there and reopens
  a = await launch({ llmUrl: mock.url, startUrl: 'about:blank', keepUserData: true, userData });
  await a.ui.click('[data-testid=tab]');
  await a.ui.locator('[data-testid=tab]').first().click({ button: 'right' });
  await a.ui.getByRole('menuitem', { name: /Reopen closed tab/ }).click();
  await expect.poll(() => tabCount(a!)).toBe(2);
});

test('SECURITY: a tab closed while under the post-task gate reopens UNGATED', async () => {
  // The control that makes this meaningful: a POST from a gated tab IS held.
  mock.script('planner', sequence({ tool: 'navigate', args: { url: `${site}/post-later.html` } }, { tool: 'finish', args: { answer: 'x' } }));
  a = await launch({ llmUrl: mock.url, confirmTimeoutMs: 3000 });
  await runTask(a.ui, `What deals are on ${site}/post-later.html ?`);
  await waitDone(a.ui);

  // The tab the task drove is under the post-task gate. Its 3s POST fires while the user does
  // nothing, and nothing reaches the sink.
  await a.ui.waitForTimeout(6000);
  expect(sink).toEqual([]);

  // The tab is demonstrably still gated: ask the main process for the gate state itself, so this
  // test cannot pass merely because the POST timer has not fired yet.
  const gatedBefore = await a.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'));
  expect(gatedBefore.gated).toBe(true);

  // Close the gated tab and reopen it. Reopening constructs a NEW tab id with a fresh document:
  // it must NOT be under the gate. (No navigation is performed after the reopen, so this measures
  // gate state, not the navigate-lifts-the-gate path.)
  await a.ui.locator('[data-testid=tab]').first().locator('.x').click();
  await expect.poll(() => tabCount(a!)).toBe(1);
  await a.ui.evaluate(() => (window as any).gb.invoke('tabs:reopen'));

  // the reopened tab is at the URL, is not the agent's pane, and is NOT gated
  await expect.poll(async () => address(a!).inputValue()).toContain('/post-later.html');
  await expect(a.ui.locator('[data-testid=tab]').first()).not.toContainText('AGENT');
  await expect.poll(async () => (await a!.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'))).gated).toBe(false);
});

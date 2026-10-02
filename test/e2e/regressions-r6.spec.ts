// Regression tests for review round 6: H1 (a page-built body cannot hide a task secret in the egress
// dialog, and Approve confirms only what was shown) and M2 (a gated document's pagehide beacon is
// still held when the user navigates the tab away after the task).

import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, runTask, waitDone, type App } from './harness';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';

let mock: MockLlm;
let a: App | undefined;
let site = '';
let other = '';
const servers: http.Server[] = [];
const sink: Array<{ path: string; body: string }> = [];
const SECRET = 'Hunter2-Very-Secret';

// 35 fields; #33 is named "pwd" and carries the task secret. With pad=70 every value stays under the
// 300-char cut but the body is ~2.7 kB, so field #33 is past the dialog's 2000-char raw-body window.
const h1Page = (pad: number) => `<!doctype html><title>Checkout</title><h1>Checkout</h1><script>
const p = new URLSearchParams();
for (let i = 1; i <= 35; i++) p.append(i === 33 ? 'pwd' : 'f' + i, i === 33 ? ${JSON.stringify(SECRET)} : 'v'.repeat(${pad}) + i);
setTimeout(() => fetch('/sink/h1', { method: 'POST', body: p }), 500);
</script>`;

const PAGES: Record<string, string> = {
  '/h1-short.html': h1Page(1),
  '/h1-long.html': h1Page(70),
  '/plain.html': `<!doctype html><title>Plain</title><h1>Plain</h1>`,
  // the gated document leaks on its way out: pagehide -> sendBeacon (and a keepalive fetch)
  '/m2.html': `<!doctype html><title>Deals</title><h1>Deals</h1><script>
addEventListener('pagehide', () => {
  navigator.sendBeacon('/sink/beacon', 'amount=1&to=mallory');
  fetch('/sink/keepalive', { method: 'POST', body: 'amount=2&to=mallory', keepalive: true });
});
</script>`,
};

const handler: http.RequestListener = (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/sink')) {
      sink.push({ path, body: Buffer.concat(chunks).toString() });
      res.end('ok');
      return;
    }
    const p = PAGES[path];
    res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' });
    res.end(p ?? 'nf');
  });
};

async function listen(host: string): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, host, () => r()));
  return `http://${host}:${(s.address() as AddressInfo).port}`;
}

test.beforeAll(async () => {
  mock = await startMockLlm();
  site = await listen('127.0.0.1');
  other = (await listen('127.0.0.1')).replace('127.0.0.1', 'localhost');
});
test.afterAll(async () => {
  await mock.close();
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
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

/** The agent opens the page and then keeps scrolling until released (pending dialogs are denied at task end). */
function h1Task(page: string, release: { v: boolean }) {
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: `${site}/${page}` } },
    () => (release.v ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } }),
  ));
}

test('R6-H1: field #33 named "pwd" carrying the task secret is shown (raw body + data marker), not masked by its name', async () => {
  const release = { v: false };
  h1Task('h1-short.html', release);
  a = await launch({ llmUrl: mock.url, confirmTimeoutMs: 20_000, maxSteps: 60 });
  await runTask(a.ui, `Check out on ${site}/h1-short.html, my password: ${SECRET}`);
  const modal = a.ui.locator('[data-testid=confirm-modal][data-kind=egress]');
  await expect(modal).toBeVisible({ timeout: 20_000 });
  await expect(modal).toContainText('and 5 more fields');
  await expect(modal).toContainText(`pwd=${SECRET}`); // the raw body row, in clear
  await expect(modal).not.toContainText('(password)'); // no masking by a page-chosen field name
  await expect(modal.locator('[data-testid=taint-marker]').first()).toContainText(/contains your data \(t\d+\)/);
  await a.ui.click('[data-testid=confirm-deny]');
  release.v = true;
  await waitDone(a.ui);
  expect(sink).toEqual([]);
});

test('R6-H1: approving a dialog that cut the secret off does NOT confirm it; the content filter asks again with the value', async () => {
  const release = { v: false };
  h1Task('h1-long.html', release);
  a = await launch({ llmUrl: mock.url, confirmTimeoutMs: 20_000, maxSteps: 60 });
  await runTask(a.ui, `Check out on ${site}/h1-long.html, my password: ${SECRET}`);
  const modal = a.ui.locator('[data-testid=confirm-modal][data-kind=egress]');
  await expect(modal).toBeVisible({ timeout: 20_000 });
  await expect(modal).toContainText('and 5 more fields');
  await expect(modal).toContainText(/… \(\+\d+ chars, \d+ bytes in all\)/); // the cut is marked
  await expect(modal).not.toContainText(SECRET); // genuinely not shown...
  const firstId = await modal.getAttribute('data-request-id');
  await a.ui.click('[data-testid=confirm-approve]');
  // ...so Approve did not whitelist it: a second dialog names the secret itself
  await expect.poll(async () => (await modal.isVisible()) && (await modal.getAttribute('data-request-id')) !== firstId, { timeout: 15_000 }).toBe(true);
  await expect(modal).toContainText(SECRET);
  await expect(modal).toContainText(/tracked value/);
  await a.ui.click('[data-testid=confirm-deny]');
  release.v = true;
  await waitDone(a.ui);
  await a.ui.waitForTimeout(500);
  expect(sink).toEqual([]);
});

test('R6-M2: after the task, the gated page\'s pagehide beacon / keepalive POST is held when the user types a new URL', async () => {
  mock.script('planner', sequence({ tool: 'navigate', args: { url: `${site}/m2.html` } }, { tool: 'finish', args: { answer: 'x' } }));
  a = await launch({ llmUrl: mock.url, confirmTimeoutMs: 3000 });
  await runTask(a.ui, `What deals are on ${site}/m2.html ?`);
  await waitDone(a.ui);
  expect((await a.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'))).gated).toBe(true);

  // the user takes the tab back by typing a URL on another origin
  await a.ui.fill('[data-testid=address]', `${other}/plain.html`);
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect(a.ui.locator('[data-testid=address]')).toHaveValue(new RegExp(`${other}/plain.html`), { timeout: 20_000 });
  // the gate is lifted on commit of the user's navigation
  await expect.poll(async () => (await a!.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'))).gated).toBe(false);
  await a.ui.waitForTimeout(5000); // past the 3 s default-deny
  expect(sink).toEqual([]);
  // the unloading document DID try (so the empty sink is not vacuous), and was held
  const held = a.audit().filter((e) => e.type === 'egress' && /\/sink\/(beacon|keepalive)/.test(String(e.url)));
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((e) => e.decision === 'block')).toBe(true);
});

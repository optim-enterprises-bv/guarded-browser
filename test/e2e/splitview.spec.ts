// Split view (tab tiling): layout, dividers, shortcuts, and that the agent stays confined to its pane.

import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, runTask, waitDone, type App } from './harness';
import { startMockLlm, sequence, lastExtracted, type MockLlm } from '../helpers/mock-llm';

const SECRET = 'TOP-SECRET-PANE-TWO-7731';
let mock: MockLlm;
let a: App | undefined;
let site = '';
let srv: http.Server;
const sink: Array<{ path: string; body: string; at: number }> = [];

const PAGES: Record<string, string> = {
  '/one.html': `<!doctype html><title>Pane one shop</title><h1>Blue Widget</h1><p>Price: $19.99</p><a href="/two.html">next</a>
<script>setTimeout(() => window.open('/popup.html'), 3000)</script>`,
  // everything on this page is the secret: title, body text, element names, link query
  '/secret.html': `<!doctype html><title>${SECRET} inbox</title><h1>${SECRET}</h1><p>Account ${SECRET} balance 12,345</p>
<button aria-label="${SECRET} button">${SECRET}</button><a href="/x?${SECRET}">${SECRET} link</a>
<script>setInterval(() => fetch('/sink/pane2', { method: 'POST', body: 'from pane two' }), 2000)</script>`,
  '/plain.html': `<!doctype html><title>Plain page</title><p>plain</p>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      if (path.startsWith('/sink')) {
        sink.push({ path, body: Buffer.concat(chunks).toString(), at: Date.now() });
        res.end('ok');
        return;
      }
      const p = PAGES[path];
      res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' });
      res.end(p ?? '<title>nf</title>nf');
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

/** Bounds of the visible page views, from the main process. */
async function viewBounds(app: App) {
  return app.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w.contentView.children.filter((v) => v.getVisible()).map((v) => v.getBounds());
  });
}

async function openTwoTabs(ui: Page, second: string) {
  await ui.click('[data-testid=new-tab]');
  await ui.fill('[data-testid=address]', second);
  await ui.press('[data-testid=address]', 'Enter');
  await expect(ui.locator('[data-testid=tab]')).toHaveCount(2);
}

test('tile two tabs side by side, drag the divider, change layout, untile (button + shortcuts)', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/plain.html` });
  await openTwoTabs(a.ui, `${site}/one.html`);
  const tabs = a.ui.locator('[data-testid=tab]');
  // Ctrl+click selects both tabs, the toolbar button tiles them
  await tabs.nth(0).click({ modifiers: ['Control'] });
  await tabs.nth(1).click({ modifiers: ['Control'] });
  await expect(a.ui.locator('.tab.selected')).toHaveCount(2);
  await a.ui.click('[data-testid=tile]');
  await expect(a.ui.locator('[data-testid=pane]')).toHaveCount(2);
  let b = await viewBounds(a);
  expect(b).toHaveLength(2);
  expect(b[0].y).toBe(b[1].y); // side by side
  const before = b.map((x) => x.width);

  // drag the divider far to the right: pane 1 grows, pane 2 stops at the minimum pane size
  const div = a.ui.locator('[data-testid=divider]');
  const box = (await div.boundingBox())!;
  await a.ui.mouse.move(box.x + box.width / 2, box.y + 200);
  await a.ui.mouse.down();
  await a.ui.mouse.move(box.x + 2000, box.y + 200, { steps: 8 });
  await a.ui.mouse.up();
  await expect.poll(async () => (await viewBounds(a!)).length).toBe(2);
  b = (await viewBounds(a)).sort((p, q) => p.x - q.x);
  expect(b[0].width).toBeGreaterThan(before[0] + 20);
  expect(b[1].width).toBeGreaterThanOrEqual(240 - 2 * 3 - 1); // MIN_W minus the chrome frame

  // stacked
  await a.ui.selectOption('[data-testid=tile-layout]', 'rows');
  await expect.poll(async () => { const v = await viewBounds(a!); return v.length === 2 && v[0].x === v[1].x; }).toBe(true);

  // untile with the shortcut, re-tile with the shortcut (last layout selected: rows)
  await a.ui.keyboard.press('Control+Shift+U');
  await expect(a.ui.locator('[data-testid=pane]')).toHaveCount(0);
  await expect.poll(async () => (await viewBounds(a!)).length).toBe(1);
  await a.ui.keyboard.press('Control+Shift+S');
  await expect.poll(async () => (await viewBounds(a!)).length).toBe(2);
  await a.ui.click('[data-testid=untile]');
  await expect.poll(async () => (await viewBounds(a!)).length).toBe(1);
});

test('grid of three via the tab context menu; views never overlap and stay beside the agent panel', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/plain.html` });
  await openTwoTabs(a.ui, `${site}/one.html`);
  await a.ui.click('[data-testid=new-tab]');
  await expect(a.ui.locator('[data-testid=tab]')).toHaveCount(3);
  const tabs = a.ui.locator('[data-testid=tab]');
  for (const i of [0, 1, 2]) await tabs.nth(i).click({ modifiers: ['Control'] });
  await tabs.nth(0).click({ button: 'right' });
  await a.ui.locator('[data-testid=tab-menu] button', { hasText: 'Tile as grid' }).click();
  await expect(a.ui.locator('[data-testid=pane]')).toHaveCount(3);
  const b = await viewBounds(a);
  expect(b).toHaveLength(3);
  const win = await a.ui.evaluate(() => window.innerWidth);
  for (const r of b) expect(r.x + r.width).toBeLessThanOrEqual(win - 440);
  for (let i = 0; i < b.length; i++)
    for (let j = i + 1; j < b.length; j++) {
      const [p, q] = [b[i], b[j]];
      expect(p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height).toBe(false);
    }
});

test('SECURITY: the agent works in exactly one pane; the other pane never reaches planner, reader or judge', async () => {
  let release = false;
  mock.script('planner', sequence(
    { tool: 'extract', args: { query: 'price', schema: { price: 'number' } } },
    { tool: 'navigate', args: { url: 'http://elsewhere.invalid/' } }, // new origin -> confirmation
    () => (release ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } }),
  ));
  mock.script('reader', (c) => ({ json: { price: c.transcript.includes('$19.99') ? 19.99 : -1 } }));
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html`, confirmTimeoutMs: 30_000 });
  await openTwoTabs(a.ui, `${site}/secret.html`);
  const tabs = a.ui.locator('[data-testid=tab]');
  await tabs.nth(0).click({ modifiers: ['Control'] });
  await tabs.nth(1).click({ modifiers: ['Control'] });
  await a.ui.click('[data-testid=tile]');
  await expect(a.ui.locator('[data-testid=pane]')).toHaveCount(2);
  // focus pane 1 (the one-shop page) and start the task there
  await a.ui.locator('[data-testid=pane]').first().locator('.phead').click();
  const taskStart = Date.now();
  await runTask(a.ui, 'What does the Blue Widget cost on this page?');

  // AGENT ACTIVE frame on pane 1 only, drawn by the chrome
  await expect(a.ui.locator('[data-testid=agent-active-badge]')).toHaveCount(1);
  await expect(a.ui.locator('[data-testid=agent-pane]')).toContainText('Pane one shop');

  // Two kinds of dialogs arrive (either order): the agent's navigation (names the agent pane) and
  // pane 2's own POST, held because a task is running (names pane 2). Deny both.
  const modal = a.ui.locator('.lock-dialog:not(.hidden)');
  const both: string[] = [];
  for (let i = 0; i < 2; i++) {
    await expect(modal).toBeVisible({ timeout: 20_000 });
    const src = await a.ui.locator('[data-testid=confirm-source]').innerText();
    both.push(src);
    await a.ui.click('[data-testid=confirm-deny]');
    await expect.poll(async () => (await modal.isVisible()) ? await a!.ui.locator('[data-testid=confirm-source]').innerText() : '').not.toBe(src);
  }
  release = true;
  await waitDone(a.ui);
  const taskEnd = Date.now();

  const sources = both.join(' | ');
  expect(sources).toMatch(/pane 1 of 2 \(AGENT pane\)/);
  expect(sources).toMatch(/pane 2 of 2 \(not the agent pane\)/);
  expect(sink.filter((x) => x.at >= taskStart + 500 && x.at <= taskEnd)).toEqual([]); // nothing from pane 2 got out while the task ran
  expect(lastExtracted(mock.calls.filter((c) => c.role === 'planner').at(-1)!)?.price).toBe(19.99);
  for (const c of mock.calls) expect(c.transcript, `${c.role} call ${c.n}`).not.toContain(SECRET);
  expect(mock.calls.some((c) => c.role === 'reader')).toBe(true);
  expect(mock.calls.some((c) => c.role === 'judge')).toBe(true);
});

test('SECURITY: post-task gate and popup block still apply to the agent pane while tiled', async () => {
  mock.script('planner', sequence({ tool: 'scroll', args: { direction: 'down' } }, { tool: 'finish', args: { answer: 'x' } }));
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/plain.html` });
  await openTwoTabs(a.ui, `${site}/plain.html`);
  const tabs = a.ui.locator('[data-testid=tab]');
  await tabs.nth(0).click({ modifiers: ['Control'] });
  await tabs.nth(1).click({ modifiers: ['Control'] });
  await a.ui.click('[data-testid=tile]');
  await a.ui.locator('[data-testid=pane]').first().locator('.phead').click();
  // navigate pane 1 to a page that opens a popup 3 s later, then run a short task there
  await a.ui.fill('[data-testid=address]', `${site}/one.html`);
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect(a.ui.locator('[data-testid=pane]').first()).toContainText('Pane one shop');
  await runTask(a.ui, 'look at this page');
  await waitDone(a.ui);
  await expect.poll(() => a!.audit().some((e) => e.type === 'navigation' && e.blocked && /popup/.test(String(e.reason))), { timeout: 10_000 }).toBe(true);
  await expect(a.ui.locator('[data-testid=tab]')).toHaveCount(2);
  await expect(a.ui.locator('[data-testid=agent-active-badge]')).toHaveCount(0); // frame gone after the task
});

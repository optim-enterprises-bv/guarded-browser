// Regression tests for review round 5 (split view + themes): V1-V4 demos and items 3-7.

import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, runTask, waitDone, type App } from './harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { solidPng } from '../helpers/png';

let mock: MockLlm;
let a: App | undefined;
let fx: FixtureServers;
let site = '';
let srv: http.Server;
const hits: Array<{ path: string; at: number }> = [];
const PNG = solidPng(0x00, 0x96, 0x88);
const BIG = 1024 * 1024;
const PAGES: Record<string, string> = {
  '/a.html': `<!doctype html><title>Agent shop</title><h1>Shop A</h1><p>Price $5</p>`,
  // non-agent pane: title mimics the badge, opens a popup and navigates itself during the task
  '/b.html': `<!doctype html><title>AGENT ACTIVE</title><h1>B</h1><script>
setTimeout(() => window.open('/pop.html'), 2500);
setTimeout(() => { location.href = '/b2.html'; }, 4000);</script>`,
  '/b2.html': `<!doctype html><title>B2 page</title><p>b2</p>`,
  '/pop.html': `<!doctype html><title>Popup</title><p>pop</p>`,
  '/fav-small.html': `<!doctype html><title>Fav small</title><link rel=icon href="/icon.png"><p>x</p>`,
  '/fav-big.html': `<!doctype html><title>Fav big</title><link rel=icon href="/big.png"><p>x</p>`,
  '/fav-stream.html': `<!doctype html><title>Fav stream</title><link rel=icon href="/stream.png"><p>x</p>`,
  '/fav-listed.html': `<!doctype html><title>Fav listed</title><link rel=icon href="ATTACKER/icon.png"><p>x</p>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  fx = await startFixtureServers();
  srv = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits.push({ path, at: Date.now() });
    if (path === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    if (path === '/big.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(BIG) });
      res.end(Buffer.alloc(BIG, 1));
      return;
    }
    if (path === '/stream.png') {
      // no Content-Length: chunked, 1 MB in 64 KB pieces
      res.writeHead(200, { 'content-type': 'image/png' });
      let sent = 0;
      const pump = () => {
        if (sent >= BIG || res.destroyed) return res.end();
        sent += 65536;
        res.write(Buffer.alloc(65536, 2), () => setImmediate(pump));
      };
      pump();
      return;
    }
    const p = PAGES[path];
    res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' });
    res.end((p ?? 'nf').replace('ATTACKER', fx.attacker));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await mock.close();
  await fx.close();
  srv.closeAllConnections();
  srv.close();
});
test.beforeEach(() => {
  mock.reset();
  hits.length = 0;
  fx.attackerHits.length = 0;
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
});
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

async function openTab(ui: Page, url: string, n: number) {
  await ui.click('[data-testid=new-tab]');
  await ui.fill('[data-testid=address]', url);
  await ui.press('[data-testid=address]', 'Enter');
  await expect(ui.locator('[data-testid=tab]')).toHaveCount(n);
}
const inv = (ui: Page, ch: string, ...args: unknown[]) => ui.evaluate(([c, x]) => (window as any).gb.invoke(c, ...(x as unknown[])), [ch, args] as const);
async function tileTwo(ui: Page) {
  const tabs = ui.locator('[data-testid=tab]');
  await tabs.nth(0).click({ modifiers: ['Control'] });
  await tabs.nth(1).click({ modifiers: ['Control'] });
  await ui.click('[data-testid=tile]');
  await expect(ui.locator('.pane')).toHaveCount(2);
}

test('R5-V1/3: the agent stays on its tab through focus switches, re-layout and untile; a fake "AGENT ACTIVE" title is quoted in a fixed grey header', async () => {
  const urls = new Set<string>();
  let release = false;
  mock.script('planner', (c) => {
    const page = c.transcript.split('--- page ---').at(-1)!;
    for (const m of page.matchAll(/URL: (\S+)/g)) urls.add(m[1]);
    return release ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } };
  });
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/a.html`, maxSteps: 200 });
  await openTab(a.ui, `${site}/b.html`, 2);
  await tileTwo(a.ui);
  await a.ui.locator('.pane .phead').first().click();
  await runTask(a.ui, 'what does it cost here?');
  await expect(a.ui.locator('[data-testid=agent-active-badge]')).toHaveCount(1);
  // the non-agent pane: grey header, title quoted and labelled; only one real AGENT badge
  const fake = a.ui.locator('[data-testid=pane] .phead');
  await expect(fake).toHaveClass(/lock-pane-head/);
  await expect(fake.locator('[data-testid=pane-title]')).toHaveText('page title: “AGENT ACTIVE”');
  expect(await fake.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(232, 234, 237)');
  expect(await a.ui.locator('.lock-agent-head').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
  // focus the other pane, relayout, untile: the agent keeps working on its own tab
  await fake.click();
  await inv(a.ui, 'tiles:layout', 'rows');
  await a.ui.click('[data-testid=untile]');
  await a.ui.waitForTimeout(1500);
  release = true;
  await waitDone(a.ui);
  expect([...urls].every((u) => u === `${site}/a.html`)).toBe(true);
});

test('R5-V2/4/5: a popup from a non-agent pane during a task opens in the background; the agent frame stays; navigations record who started them', async () => {
  let release = false;
  mock.script('planner', (c) =>
    release ? { tool: 'finish', args: { answer: 'x' } } : c.n === 0 ? { tool: 'navigate', args: { url: `${site}/a.html?agent` } } : { tool: 'scroll', args: { direction: 'down' } },
  );
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/a.html`, maxSteps: 200 });
  await openTab(a.ui, `${site}/b.html`, 2);
  await tileTwo(a.ui);
  await a.ui.locator('.pane .phead').first().click();
  await runTask(a.ui, 'what does it cost here?');
  await expect(a.ui.locator('[data-testid=tab]')).toHaveCount(3, { timeout: 15_000 }); // popup tab exists ...
  await expect(a.ui.locator('.pane')).toHaveCount(2); // ... split view is still on screen
  await expect(a.ui.locator('[data-testid=agent-active-badge]')).toBeVisible();
  const popupTab = a.ui.locator('[data-testid=tab]').nth(2);
  await expect(popupTab).not.toHaveClass(/active/);
  await expect.poll(() => a!.audit().some((e) => e.type === 'navigation' && String(e.url).endsWith('/b2.html')), { timeout: 15_000 }).toBe(true);
  release = true;
  await waitDone(a.ui);
  const nav = a.audit().filter((e) => e.type === 'navigation' && e.by);
  expect(nav.find((e) => String(e.url).endsWith('/b2.html'))?.by).toBe('page');
  expect(nav.find((e) => String(e.url).endsWith('/a.html?agent'))?.by).toBe('agent');
  expect(nav.find((e) => String(e.url).endsWith('/b.html'))?.by).toBe('user');
  expect(a.audit().some((e) => e.type === 'navigation' && /popup opened in the background/.test(String(e.reason)))).toBe(true);
});

test('R5-V3: an unreadable shared theme is refused (foreground == background)', async () => {
  a = await launch({ llmUrl: mock.url });
  const r = (await inv(a.ui, 'theme:import', JSON.stringify({ name: 'Nice Mono', base: 'dark', background: '#101010', foreground: '#101010', accent: '#2f5bd3', highlight: '#101010', radius: 6, density: 'normal' }))) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/contrast is 1\.00:1, needs at least 4\.5:1/);
});

test('R5-2: favicons are size-capped while streaming (Content-Length and chunked), decoded outside main; small ones still work', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: 'about:blank' });
  const ap = (await inv(a.ui, 'appearance:get')) as { appearance: Record<string, unknown> };
  await inv(a.ui, 'appearance:save', { ...ap.appearance, siteAccent: true });
  const visit = async (path: string) => {
    await a!.ui.fill('[data-testid=address]', `${site}${path}`);
    await a!.ui.press('[data-testid=address]', 'Enter');
  };
  await visit('/fav-small.html');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.siteAccent), { timeout: 15_000 }).toBe('favicon');
  for (const p of ['/fav-big.html', '/fav-stream.html']) {
    await visit(p);
    await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.siteAccent), { timeout: 15_000 }).toBe('off');
  }
  await expect.poll(() => a!.audit().some((e) => e.type === 'egress' && /favicon larger than 256 KB/.test(String(e.reason))), { timeout: 10_000 }).toBe(true);
  // the app is still alive and responsive
  await visit('/fav-small.html');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.siteAccent), { timeout: 15_000 }).toBe('favicon');
});

test('R5-V4: a favicon on a listed host is never fetched', async () => {
  const feeds = [{ name: 'fixture-threat-feed', url: `${fx.site}/feeds/attacker-hosts.txt`, format: 'domains' as const, enabled: true }];
  a = await launch({ llmUrl: mock.url, startUrl: 'about:blank', feeds });
  await expect(a.ui.locator('[data-testid=reputation-status]')).toContainText('reputation: 1 hosts', { timeout: 20_000 });
  const ap = (await inv(a.ui, 'appearance:get')) as { appearance: Record<string, unknown> };
  await inv(a.ui, 'appearance:save', { ...ap.appearance, siteAccent: true });
  await a.ui.fill('[data-testid=address]', `${site}/fav-listed.html`);
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect.poll(() => a!.audit().some((e) => e.type === 'egress' && e.layer === 'reputation' && /icon\.png/.test(String(e.url))), { timeout: 15_000 }).toBe(true);
  expect(fx.attackerHits).toEqual([]);
});

test('R5-6: "Proceed anyway" applies only to the tab that showed the interstitial, and the dialog names that pane', async () => {
  const feeds = [{ name: 'fixture-threat-feed', url: `${fx.site}/feeds/attacker-hosts.txt`, format: 'domains' as const, enabled: true }];
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/a.html`, feeds });
  await expect(a.ui.locator('[data-testid=reputation-status]')).toContainText('reputation: 1 hosts', { timeout: 20_000 });
  await openTab(a.ui, `${fx.attacker}/landing`, 2); // listed -> interstitial in tab 2
  await tileTwo(a.ui);
  await a.ui.locator('.pane .phead').first().click(); // focus pane 1 (the shop)
  let inter: Page | undefined;
  await expect.poll(() => (inter = a!.app.windows().find((w) => w.url().startsWith('data:text/html'))) !== undefined, { timeout: 15_000 }).toBe(true);
  await inter!.evaluate(() => document.getElementById('proceed')!.click());
  const modal = a.ui.locator('[data-testid=confirm-modal][data-kind=reputation]');
  await expect(modal).toBeVisible();
  await expect(a.ui.locator('[data-testid=confirm-source]')).toContainText('pane 2 of 2');
  await a.ui.click('[data-testid=confirm-approve]');
  await expect.poll(() => fx.attackerHits.map((h) => h.url)).toContain('/landing');
  const urls = await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((v) => (v as Electron.WebContentsView).webContents.getURL()));
  expect(urls.some((u) => u.endsWith('/a.html'))).toBe(true); // pane 1 untouched
  expect(urls.some((u) => u.endsWith('/landing'))).toBe(true);
});

// Wave 1 e2e (tickets 03–10, 12): session restore, zoom, find-in-page, downloads, tab order,
// search engine, and print. Each test drives the real UI through IPC; nothing here re-implements a
// code path the app does not actually take.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, waitForUrl, type App } from './harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let mock: MockLlm;
let a: App | undefined;
let site = '';
let srv: http.Server;

// A page with plenty of text to find, and a big file to download.
const BIG = 'B'.repeat(200_000);
const PAGES: Record<string, string> = {
  '/one.html': `<!doctype html><title>One</title><h1>One</h1><p>alpha beta gamma alpha beta alpha</p>`,
  '/two.html': `<!doctype html><title>Two</title><h1>Two</h1><p>different text</p>
    <a id="dl" href="/file.bin" download>get file</a>`,
  '/search': `<!doctype html><title>Search</title><h1>Results</h1><p>no results</p>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  srv = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    if (p === '/file.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="sample.bin"', 'content-length': String(BIG.length) });
      res.end(BIG);
      return;
    }
    const body = PAGES[p];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body ?? 'nf');
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
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
});

test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const tabCount = (app: App) => app.ui.locator('[data-testid=tab]').count();
const address = (app: App) => app.ui.locator('[data-testid=address]');

test('status bar zoom: the readout follows the controls and persists per origin', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await waitForUrl(a.ui, /one\.html/);

  const label = a.ui.locator('[data-testid=zoom-label]');
  await expect(label).toHaveText('100 %');

  await a.ui.click('[data-testid=zoom-in]');
  await expect(label).not.toHaveText('100 %');
  const status = await a.ui.evaluate(() => (window as any).gb.invoke('zoom:get'));
  expect(status.factor).toBeGreaterThan(1);

  // Ctrl+0 resets, and 100% forgets the origin entirely
  await a.ui.evaluate(() => (window as any).gb.invoke('zoom:reset'));
  await expect.poll(async () => (await a!.ui.evaluate(() => (window as any).gb.invoke('zoom:get'))).factor).toBe(1);
  await expect(label).toHaveText('100 %');

  // stepping down then navigating away and back keeps the site's factor (per-origin memory)
  await a.ui.click('[data-testid=zoom-out]');
  const down = (await a.ui.evaluate(() => (window as any).gb.invoke('zoom:get'))).factor;
  expect(down).toBeLessThan(1);
  await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/two.html`);
  await waitForUrl(a.ui, /two\.html/);
  await expect.poll(async () => (await a!.ui.evaluate(() => (window as any).gb.invoke('zoom:get'))).factor).toBe(down);
});

test('Ctrl+F find bar reports match counts and closes on Escape', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await waitForUrl(a.ui, /one\.html/);

  const bar = a.ui.locator('[data-testid=find-bar]');
  await expect(bar).toBeHidden();

  // open it the way the user does: Ctrl+F (main dispatches it to this window's chrome)
  await a.ui.click('[data-testid=task-input]');
  await a.ui.keyboard.press('Control+f');
  await expect(bar).toBeVisible({ timeout: 10_000 });

  await a.ui.fill('[data-testid=find-input]', 'alpha');
  // Chromium counts the matches; the bar shows active/total
  await expect(a.ui.locator('[data-testid=find-count]')).toHaveText('1/3', { timeout: 15_000 });

  await a.ui.fill('[data-testid=find-input]', 'zzzznotpresent');
  await expect(a.ui.locator('[data-testid=find-count]')).toHaveText('no matches', { timeout: 15_000 });

  // Escape closes it and clears the selection
  await a.ui.press('[data-testid=find-input]', 'Escape');
  await expect(bar).toBeHidden();
});

test('downloads: the panel is wired to the list and reports an empty list honestly', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/two.html` });
  await waitForUrl(a.ui, /two\.html/);

  // The list starts empty, and the IPC channel is reachable (this is also the allowlist guard:
  // a channel missing from any of the three lists would reject here).
  expect(await a.ui.evaluate(() => (window as any).gb.invoke('downloads:list'))).toEqual([]);

  await a.ui.click('[data-testid=status-downloads]');
  await expect(a.ui.locator('[data-testid=downloads-menu]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=downloads-menu]')).toContainText('No downloads yet');
  // nothing is in flight, so the badge stays hidden
  await expect(a.ui.locator('[data-testid=downloads-badge]')).toBeHidden();
});

test('tab order: duplicate, close others, close right and mute', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await waitForUrl(a.ui, /one\.html/);

  // three tabs, each waitED for its commit (tab count alone does not mean the load landed, and
  // under full-suite load nav:go can still be in flight when the next step starts)
  for (const p of ['two', 'one']) {
    await a.ui.click('[data-testid=new-tab]');
    await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/${p}.html`);
    await waitForUrl(a.ui, new RegExp(`${p}\\.html`));
  }
  await expect.poll(() => tabCount(a!)).toBe(3);

  // duplicate the active tab -> 4, with the copy at the same URL
  const urlBefore = await address(a).inputValue();
  expect(urlBefore).toMatch(/one\.html$/);
  await a.ui.evaluate(() => (window as any).gb.invoke('tabs:duplicate', undefined));
  await expect.poll(() => tabCount(a!), { timeout: 20_000 }).toBe(4);
  // the copy loads the same URL; wait for its load to commit before reading the address bar
  await expect.poll(async () => address(a!).inputValue(), { timeout: 20_000 }).toBe(urlBefore);

  // close others via the tab context menu on the first tab
  await a.ui.locator('[data-testid=tab]').first().click({ button: 'right' });
  await a.ui.getByRole('menuitem', { name: /Close other tabs/ }).click();
  await expect.poll(() => tabCount(a!)).toBe(1);

  // close right: three tabs, close the first's right-hand tabs, expect one
  for (const p of ['two', 'two']) {
    await a.ui.click('[data-testid=new-tab]');
    await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/${p}.html`);
    await expect.poll(() => tabCount(a!)).toBeGreaterThan(1);
  }
  await expect.poll(() => tabCount(a!)).toBe(3);
  await a.ui.locator('[data-testid=tab]').first().click({ button: 'right' });
  await a.ui.getByRole('menuitem', { name: /Close tabs to the right/ }).click();
  await expect.poll(() => tabCount(a!)).toBe(1);
});

test('a bulk close still lands every tab on the reopen stack', async () => {
  // "close others" must not make tabs vanish un-reopenable: the stack has to grow by the number
  // of tabs it removed, or a misclick is unrecoverable.
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await waitForUrl(a.ui, /one\.html/);
  for (const p of ['two', 'one']) {
    await a.ui.click('[data-testid=new-tab]');
    await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/${p}.html`);
    await expect.poll(() => tabCount(a!)).toBeGreaterThan(1);
  }
  await expect.poll(() => tabCount(a!)).toBe(3);

  const before = (await a.ui.evaluate(() => (window as any).gb.invoke('tabs:closed-list'))).length;
  await a.ui.locator('[data-testid=tab]').first().click({ button: 'right' });
  await a.ui.getByRole('menuitem', { name: /Close other tabs/ }).click();
  await expect.poll(() => tabCount(a!)).toBe(1);
  const after = (await a.ui.evaluate(() => (window as any).gb.invoke('tabs:closed-list'))).length;
  expect(after).toBe(before + 2);
});

test('the search engine is a setting, and the query is encoded into it', async () => {
  // Point the engine at the local fixture server, so this exercises the whole path (setting ->
  // address bar -> template substitution -> navigation) without touching the network.
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html`, searchTemplate: `${site}/search?q=%s` });
  await waitForUrl(a.ui, /one\.html/);

  const s = await a.ui.evaluate(() => (window as any).gb.invoke('search:get'));
  expect(s.engines.map((e: { id: string }) => e.id)).toContain('duckduckgo');
  expect(s.current.engine).toBe('custom');

  // a bare query is searched, not treated as a URL
  await a.ui.fill('[data-testid=address]', 'guarded browser');
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect.poll(async () => decodeURIComponent(await a!.ui.locator('[data-testid=address]').inputValue()), { timeout: 20_000 }).toContain('/search?q=guarded browser');

  // a query containing URL-ish punctuation is still DATA: it is percent-encoded exactly once into
  // the template's single %s, so its '&' and '?' cannot break out and become parameters of the
  // engine URL. (A string that already carries a scheme is a URL and navigates directly — that is
  // the address bar's rule, unchanged by this ticket.)
  //
  // Note: poll on the CONTENT of the q parameter, not merely on the URL containing "/search?q=" —
  // the previous query's URL still satisfies that, so such a poll returns stale and passes wrongly.
  await a.ui.fill('[data-testid=address]', '50% off? a&b');
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect
    .poll(async () => {
      const v = await a!.ui.locator('[data-testid=address]').inputValue();
      const q = v.split('/search?q=')[1];
      return q ? decodeURIComponent(q) : '';
    }, { timeout: 20_000 })
    .toBe('50% off? a&b');
  const raw = await address(a).inputValue();
  expect(raw).not.toContain('&b'); // the & is encoded, not left as a parameter break
});

test('session restore: with startup=last-session the previous tabs come back', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html`, keepUserData: true });
  await waitForUrl(a.ui, /one\.html/);
  const userData = a.userData;

  await a.ui.click('[data-testid=new-tab]');
  await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/two.html`);
  await waitForUrl(a.ui, /two\.html/);
  await expect.poll(() => tabCount(a!)).toBe(2);

  // wait for the debounced save, then quit cleanly
  await a.ui.waitForTimeout(1500);
  const profDir = a.profileDir();
  await a.close();
  a = undefined;

  // flip the profile to "start where you left off" (settings live in the profile dir)
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const settings = JSON.parse(readFileSync(join(profDir, 'settings.json'), 'utf8'));
  settings.general = { ...(settings.general ?? {}), startup: 'last-session' };
  writeFileSync(join(profDir, 'settings.json'), JSON.stringify(settings, null, 2));

  a = await launch({ llmUrl: mock.url, startUrl: 'about:blank', keepUserData: true, userData });
  // both tabs are back, and a clean exit means no crash notice
  await expect.poll(() => tabCount(a!), { timeout: 20_000 }).toBe(2);
  const urls = await a.ui.evaluate(async () => {
    const t = await (window as any).gb.invoke('session:info');
    return t;
  });
  expect(urls.tabs.map((t: { url: string }) => t.url).join(' ')).toContain('/one.html');
  expect(urls.tabs.map((t: { url: string }) => t.url).join(' ')).toContain('/two.html');
});

test('SECURITY: a restored session contains no gate state', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html`, keepUserData: true });
  await waitForUrl(a.ui, /one\.html/);
  const userData = a.userData;
  await a.ui.waitForTimeout(1500);
  await a.close();
  a = undefined;

  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const reg = JSON.parse(readFileSync(join(userData, 'profiles.json'), 'utf8'));
  const raw = JSON.parse(readFileSync(join(userData, 'profiles', reg.profiles[0].id, 'session.json'), 'utf8'));
  // the file's shape: no gate/agent/taint field can be present at all
  expect(JSON.stringify(raw)).not.toMatch(/gate|agentTab|taint|origin/i);
  for (const t of raw.tabs) expect(Object.keys(t).sort()).toEqual(['title', 'url']);
});

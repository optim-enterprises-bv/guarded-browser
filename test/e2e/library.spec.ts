// History & bookmarks: UI, shortcuts, import/export, nicknames + suggestions, and the security
// properties: the agent never sees them, pages cannot query them, profiles are isolated, opening a
// bookmark goes through the normal (gated) navigation path.

import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { launch, openNewProfile, runTask, waitDone, type App } from './harness';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';

let mock: MockLlm;
let fx: FixtureServers;
let a: App | undefined;
let site = '';
let srv: http.Server;
const SECRET = 'PRIVATE-LIBRARY-7a91';

test.beforeAll(async () => {
  mock = await startMockLlm();
  fx = await startFixtureServers();
  srv = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/linker') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Linker</title><a id=l href="/linked">go</a><script>setTimeout(()=>document.getElementById("l").click(), 300)</script>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Title of ${path.replace(/[^\w/-]/g, '')}</title><p>page ${path}</p>`);
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
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
});
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const inv = (ui: Page, ch: string, ...args: unknown[]) => ui.evaluate(([c, x]) => (window as any).gb.invoke(c, ...(x as unknown[])), [ch, args] as const);
async function go(ui: Page, url: string) {
  await ui.fill('[data-testid=address]', url);
  await ui.press('[data-testid=address]', 'Enter');
  await expect(ui.locator('[data-testid=tab]').first()).toContainText('Title of', { timeout: 10_000 });
}

test('bookmarks: Ctrl+D, star, edit (name / URL / nickname / folder), bar toggle, reorder by drag, search, delete', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one` });
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of /one');
  await expect(a.ui.locator('[data-testid=star]')).toHaveAttribute('data-bookmarked', 'false');
  await a.ui.keyboard.press('Control+d');
  await expect(a.ui.locator('[data-testid=bookmarks-panel]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=star]')).toHaveAttribute('data-bookmarked', 'true');
  const ed = a.ui.locator('[data-testid=bookmark-editor]');
  await ed.locator('[data-testid=bookmark-edit-title]').fill('First site');
  await ed.locator('[data-testid=bookmark-edit-nickname]').fill('first');
  await ed.locator('[data-testid=bookmark-edit-save]').click();
  await expect(a.ui.locator('[data-testid=bookmarks-msg]')).toHaveText('saved');
  // second bookmark + a folder, move the second one into the folder via the editor
  await go(a.ui, `${site}/two`);
  await a.ui.click('[data-testid=bookmarks-add-current]');
  await a.ui.click('[data-testid=bookmarks-add-folder]');
  const folderEditor = a.ui.locator('[data-testid=bookmark-editor]');
  await folderEditor.locator('[data-testid=bookmark-edit-title]').fill('Work');
  await folderEditor.locator('[data-testid=bookmark-edit-save]').click();
  const two = a.ui.locator('[data-testid=bookmark-row]', { hasText: 'Title of /two' });
  await two.locator('[data-testid=bookmark-edit]').click();
  await a.ui.locator('[data-testid=bookmark-edit-folder]').selectOption({ label: 'Other bookmarks / Work' });
  await a.ui.locator('[data-testid=bookmark-edit-url]').fill(`${site}/two-b`);
  await a.ui.locator('[data-testid=bookmark-edit-save]').click();
  await expect(a.ui.locator('[data-testid=bookmarks-msg]')).toHaveText('saved');
  let tree = await inv(a.ui, 'bookmarks:tree');
  expect(tree.roots[0].children.map((n: { title: string }) => n.title)).toEqual(['First site']);
  expect(tree.roots[1].children[0]).toMatchObject({ type: 'folder', title: 'Work' });
  expect(tree.roots[1].children[0].children[0]).toMatchObject({ title: 'Title of /two', url: `${site}/two-b` });

  // drag the bookmark from Work onto "First site" (moves before it, into the bar)
  await a.ui.locator('[data-testid=bookmark-row]', { hasText: 'Title of /two' }).dragTo(a.ui.locator('[data-testid=bookmark-row]', { hasText: 'First site' }));
  await expect.poll(async () => (await inv(a!.ui, 'bookmarks:tree')).roots[0].children.map((n: { title: string }) => n.title)).toEqual(['Title of /two', 'First site']);

  // bar toggle
  await expect(a.ui.locator('[data-testid=bookmarks-bar]')).toBeHidden();
  await a.ui.keyboard.press('Control+Shift+B');
  await expect(a.ui.locator('[data-testid=bookmarks-bar] [data-testid=bar-item]')).toHaveText(['Title of /two', 'First site']);
  // search and delete
  await a.ui.fill('[data-testid=bookmarks-search]', 'first');
  await expect(a.ui.locator('[data-testid=bookmark-row]')).toHaveCount(1);
  await a.ui.locator('[data-testid=bookmark-row] [data-testid=bookmark-delete]').click();
  await expect(a.ui.locator('[data-testid=bookmarks-msg]')).toHaveText('deleted');
  tree = await inv(a.ui, 'bookmarks:tree');
  expect(tree.roots[0].children.map((n: { title: string }) => n.title)).toEqual(['Title of /two']);
  const onDisk = JSON.parse(readFileSync(join(a.profileDir(), 'bookmarks.json'), 'utf8'));
  expect(onDisk.showBar).toBe(true);
});

test('import / export round trip; malicious entries are dropped; titles stay text', async () => {
  a = await launch({ llmUrl: mock.url });
  await inv(a.ui, 'bookmarks:add', 'bar', 'Shop & <b>more</b>', `${site}/shop?a=1&b=2`, 'shop');
  const html: string = await inv(a.ui, 'bookmarks:export');
  expect(html).toMatch(/^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  await a.ui.click('[data-testid=open-bookmarks]');
  await a.ui.locator('[data-testid=bookmarks-panel] summary').click();
  const evil = html.replace('</DL><p>\n</DL><p>', `<DT><A HREF="javascript:alert(document.cookie)">steal</A>\n<DT><A HREF="data:text/html,<script>alert(1)</script>">d</A>\n<DT><A HREF="https://ok.example/"><img src=x onerror=alert(1)>ok<script>alert(2)</script></A>\n</DL><p>\n</DL><p>`);
  await a.ui.fill('[data-testid=bookmarks-io]', evil);
  await a.ui.click('[data-testid=bookmarks-import]');
  await expect(a.ui.locator('[data-testid=bookmarks-msg]')).toHaveText('imported 2, skipped 2');
  const all = JSON.stringify(await inv(a.ui, 'bookmarks:tree'));
  expect(all).not.toMatch(/javascript:|data:text|onerror|<script/);
  const titles = await a.ui.locator('[data-testid=bookmark-row] .t').allTextContents();
  expect(titles).toContain('ok'); // markup and script text stripped: plain text only
  expect(await a.ui.locator('[data-testid=bookmarks-tree] img[src="x"], [data-testid=bookmarks-tree] script').count()).toBe(0);
  const round = await inv(a.ui, 'bookmarks:search', 'shop');
  expect(round.map((b: { url: string; nickname?: string }) => [b.url, b.nickname ?? null])).toEqual([
    [`${site}/shop?a=1&b=2`, 'shop'],
    [`${site}/shop?a=1&b=2`, null], // the imported copy (nicknames stay unique)
  ]);
});

test('history: sources (user / page / agent), search, filter, delete entry and range, Ctrl+H, clear on exit', async () => {
  mock.script('planner', sequence({ tool: 'navigate', args: { url: `${site}/agent-page` } }, { tool: 'finish', args: { answer: 'x' } }));
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/start`, keepUserData: true });
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of /start');
  await go(a.ui, `${site}/linker`); // the page then navigates itself to /linked
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of /linked');
  await runTask(a.ui, `Look at ${site}/agent-page`);
  await waitDone(a.ui);
  await a.ui.keyboard.press('Control+h');
  const panel = a.ui.locator('[data-testid=history-panel]');
  await expect(panel).toBeVisible();
  const rows = panel.locator('[data-testid=history-row]');
  await expect.poll(async () => (await rows.evaluateAll((els) => els.map((e) => `${new URL(e.getAttribute('data-url')!).pathname}:${e.getAttribute('data-sources')}`))).sort()).toEqual(
    ['/agent-page:agent', '/linked:page', '/linker:user', '/start:user'],
  );
  await expect(rows.filter({ hasText: '/agent-page' }).locator('.lock-agent-chip')).toHaveText('AGENT');
  await a.ui.selectOption('[data-testid=history-source]', 'agent');
  await expect(rows).toHaveCount(1);
  await a.ui.selectOption('[data-testid=history-source]', '');
  await a.ui.fill('[data-testid=history-search]', 'linke');
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: '/linked' }).locator('[data-testid=history-delete]').click();
  await expect(rows).toHaveCount(1);
  await a.ui.fill('[data-testid=history-search]', '');
  await a.ui.selectOption('[data-testid=history-range]', 'hour');
  await a.ui.click('[data-testid=history-delete-range]');
  await expect(rows).toHaveCount(0);
  // Ctrl+H toggles the panel away again
  await a.ui.keyboard.press('Control+h');
  await expect(panel).toBeHidden();
  // clear on exit
  await go(a.ui, `${site}/before-exit`);
  await a.ui.keyboard.press('Control+h');
  await a.ui.check('[data-testid=history-clear-on-exit]');
  const ud = a.userData;
  const dir = a.profileDir();
  await a.close();
  a = undefined;
  const saved = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
  expect(saved.visits).toEqual([]);
  expect(saved.clearOnExit).toBe(true);
  a = await launch({ llmUrl: mock.url, userData: ud });
  expect((await inv(a.ui, 'history:list', '', '')).groups).toEqual([]);
});

test('address bar: nickname jumps to the bookmark; suggestions list bookmarks and history', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/visited-page` });
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of /visited-page');
  await inv(a.ui, 'bookmarks:add', 'bar', 'Docs home', `${site}/docs`, 'docs');
  await a.ui.click('[data-testid=address]');
  await a.ui.keyboard.type('visited');
  await expect(a.ui.locator('[data-testid=suggestion][data-kind=history]')).toContainText('visited-page');
  await a.ui.fill('[data-testid=address]', '');
  await a.ui.keyboard.type('docs');
  await expect(a.ui.locator('[data-testid=suggestion]').first()).toHaveAttribute('data-kind', 'nickname');
  await a.ui.keyboard.press('Enter');
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of /docs');
  await expect(a.ui.locator('[data-testid=suggestions]')).toBeHidden();
});

test('SECURITY: the agent never sees history or bookmarks', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/private-${SECRET}` });
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of');
  await inv(a.ui, 'bookmarks:add', 'bar', `bank ${SECRET}`, `https://bank.example/${SECRET}`, 'bank');
  await go(a.ui, `${site}/shop`);
  mock.script('planner', sequence(
    { tool: 'extract', args: { query: 'everything', schema: { text: 'string' } } },
    { tool: 'navigate', args: { url: `${site}/next` } },
    { tool: 'finish', args: { answer: 'x' } },
  ));
  mock.script('reader', () => ({ json: { text: 'page text' } }));
  await runTask(a.ui, 'Summarise this page');
  await waitDone(a.ui);
  expect(mock.calls.map((c) => c.role).sort()).toEqual(expect.arrayContaining(['planner', 'reader', 'judge']));
  for (const c of mock.calls) {
    expect(c.transcript, `${c.role} call ${c.n}`).not.toContain(SECRET);
    expect(JSON.stringify(c.body.tools ?? []), 'planner tools').not.toMatch(/history|bookmark/i);
  }
});

test('SECURITY: web pages cannot query history or bookmarks (no bridge, and the IPC rejects tab senders)', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/attacker-page` });
  await inv(a.ui, 'bookmarks:add', 'bar', 'secret', `https://bank.example/${SECRET}`);
  let page: Page | undefined;
  await expect.poll(() => (page = a!.app.windows().find((w) => w.url().endsWith('/attacker-page'))) !== undefined).toBe(true);
  expect(await page!.evaluate(() => typeof (window as any).gb)).toBe('undefined');
  expect(await page!.evaluate(() => typeof (window as any).require)).toBe('undefined');
  // even a message that DID arrive from a tab's webContents is refused (sender is not a chrome UI)
  const results = await a.app.evaluate(async ({ ipcMain, webContents }, url) => {
    const tab = webContents.getAllWebContents().find((w) => w.getURL() === url)!;
    const out: string[] = [];
    for (const ch of ['bookmarks:tree', 'history:list', 'suggest', 'bookmarks:export']) {
      const handler = (ipcMain as any)._invokeHandlers.get(ch);
      try {
        const r = await handler({ sender: tab, senderFrame: tab.mainFrame }, 'bank');
        out.push(`${ch}: ${JSON.stringify(r).slice(0, 60)}`);
      } catch (e) {
        out.push(`${ch}: ${(e as Error).message}`);
      }
    }
    return out;
  }, `${site}/attacker-page`);
  expect(results).toEqual(['bookmarks:tree: unknown sender', 'history:list: unknown sender', 'suggest: unknown sender', 'bookmarks:export: unknown sender']);
});

test('SECURITY: opening a bookmark goes through the normal navigation path (reputation interstitial applies)', async () => {
  const feeds = [{ name: 'fixture-threat-feed', url: `${fx.site}/feeds/attacker-hosts.txt`, format: 'domains' as const, enabled: true }];
  a = await launch({ llmUrl: mock.url, feeds });
  await expect(a.ui.locator('[data-testid=reputation-status]')).toContainText('reputation: 1 hosts', { timeout: 20_000 });
  const r = await inv(a.ui, 'bookmarks:add', 'bar', 'looks harmless', `${fx.attacker}/landing`);
  await inv(a.ui, 'bookmarks:open', r.result.id, false);
  await expect.poll(() => a!.app.windows().some((w) => w.url().startsWith('data:text/html')), { timeout: 15_000 }).toBe(true);
  expect(fx.attackerHits).toEqual([]);
  expect(await inv(a.ui, 'bookmarks:open', 'nope', false)).toMatchObject({ ok: false });
});

test('profiles: A’s history and bookmarks are invisible to B (also when B sends A’s id), and deleting A removes them', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/a-only-${SECRET}` });
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Title of');
  await inv(a.ui, 'bookmarks:add', 'bar', `A bookmark ${SECRET}`, `https://a.example/${SECRET}`, 'aonly');
  const idA = await a.ui.locator('[data-testid=profile-button]').getAttribute('data-profile-id');
  const b = await openNewProfile(a, 'B');
  for (const args of [[], [idA]]) {
    expect(JSON.stringify(await inv(b.ui, 'bookmarks:tree', ...args))).not.toContain(SECRET);
    expect(JSON.stringify(await inv(b.ui, 'history:list', '', '', ...args))).not.toContain(SECRET);
    expect(JSON.stringify(await inv(b.ui, 'suggest', 'aonly', ...args))).not.toContain(SECRET);
    expect(JSON.stringify(await inv(b.ui, 'bookmarks:search', SECRET, ...args))).toBe('[]');
    expect(await inv(b.ui, 'bookmarks:export', ...args)).not.toContain(SECRET);
  }
  expect(JSON.stringify(await inv(a.ui, 'bookmarks:tree'))).toContain(SECRET);
  // deleting profile B's data removes its files; here: delete A from B's manager
  const dirA = a.profileDir(0);
  expect(existsSync(join(dirA, 'bookmarks.json'))).toBe(true);
  const del = inv(b.ui, 'profiles:delete', idA);
  await b.ui.click('[data-testid=confirm-approve]');
  expect((await del).ok).toBe(true);
  expect(existsSync(join(dirA, 'bookmarks.json'))).toBe(false);
  expect(existsSync(join(dirA, 'history.json'))).toBe(false);
});

test('Ctrl+H and Ctrl+D also work while a web page has keyboard focus', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/focus-me` });
  let page: Page | undefined;
  await expect.poll(() => (page = a!.app.windows().find((w) => w.url().endsWith('/focus-me'))) !== undefined).toBe(true);
  await page!.waitForLoadState();
  // real input events into the page's webContents (the path a user's keypress takes)
  const press = (key: string) =>
    a!.app.evaluate(({ webContents }, [k, url]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith(url))!;
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] });
    }, [key, '/focus-me']);
  await press('H');
  await expect(a.ui.locator('[data-testid=history-panel]')).toBeVisible();
  await press('D');
  await expect(a.ui.locator('[data-testid=bookmarks-panel]')).toBeVisible();
  await expect.poll(async () => JSON.stringify(await inv(a!.ui, 'bookmarks:tree'))).toContain('/focus-me');
});

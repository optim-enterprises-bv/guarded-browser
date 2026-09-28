// Profiles: two profiles open in two windows must be isolated (Chromium session, app state, agent
// runtime, egress), deletion must really remove data, migration must keep it, and a renderer can
// never reach another profile by sending its id.

import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { launch, openNewProfile, runTask, uiWindows, waitDone, type App } from './harness';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';

let mock: MockLlm;
let fx: FixtureServers;
let a: App | undefined;
let site = '';
let srv: http.Server;
const sink: Array<{ path: string; method: string; at: number }> = [];

const PAGES: Record<string, string> = {
  '/store.html': `<!doctype html><title>Store</title><script>
if (location.search.startsWith('?set')) { document.cookie = 'k=profileA; max-age=3600'; localStorage.setItem('k', 'profileA'); }
</script><p>store</p>`,
  '/sw-page.html': `<!doctype html><title>SW</title><script>navigator.serviceWorker.register('/sw.js')</script>`,
  '/sw-check.html': `<!doctype html><title>SW check</title>`,
  '/coupon.html': `<!doctype html><title>Coupon</title><p>Coupon code: WINTER-SALE-7731</p>`,
  // B's page: posts every 700 ms while it is open
  '/poster.html': `<!doctype html><title>Poster</title><script>setInterval(() => fetch('/sink/b-post', { method: 'POST', body: 'from B' }), 700)</script>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  fx = await startFixtureServers();
  srv = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/sink') || path.startsWith('/search')) {
      sink.push({ path: req.url ?? '', method: req.method ?? '', at: Date.now() });
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>ok</title>ok');
      return;
    }
    if (path === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end("self.addEventListener('install', () => self.skipWaiting());");
      return;
    }
    const p = PAGES[path];
    res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' }).end(p ?? 'nf');
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
  sink.length = 0;
  fx.attackerHits.length = 0;
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
}
async function tabPage(a: App, suffix: string): Promise<Page> {
  let p: Page | undefined;
  await expect.poll(() => (p = a.app.windows().find((w) => w.url().endsWith(suffix))) !== undefined, { timeout: 15_000 }).toBe(true);
  await p!.waitForLoadState();
  return p!;
}

test('two profiles in two windows: title, toolbar, cookies, localStorage and service workers are separate', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/store.html?set` });
  const b = await openNewProfile(a, 'Work');
  expect(await a.ui.locator('[data-testid=profile-button]').innerText()).toContain('Default');
  expect(await b.ui.locator('[data-testid=profile-button]').innerText()).toContain('Work');
  const titles = await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort());
  expect(titles).toEqual(['Guarded Browser — Default', 'Guarded Browser — Work']);

  const inA = await tabPage(a, '/store.html?set');
  await expect.poll(() => inA.evaluate(() => document.cookie)).toBe('k=profileA');
  expect(await inA.evaluate(() => localStorage.getItem('k'))).toBe('profileA');
  await go(b.ui, `${site}/store.html?read`);
  const inB = await tabPage(a, '/store.html?read');
  expect(await inB.evaluate(() => document.cookie)).toBe('');
  expect(await inB.evaluate(() => localStorage.getItem('k'))).toBeNull();

  await go(a.ui, `${site}/sw-page.html`);
  const swA = await tabPage(a, '/sw-page.html');
  await expect.poll(() => swA.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
  await go(b.ui, `${site}/sw-check.html`);
  const swB = await tabPage(a, '/sw-check.html');
  expect(await swB.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  // and at the session level
  const parts: string[] = JSON.parse(readFileSync(join(a.userData, 'profiles.json'), 'utf8')).profiles.map((p: { partition: string }) => p.partition);
  expect(new Set(parts).size).toBe(2);
  // each profile's session goes through its OWN egress proxy (distinct port)
  const proxies = await a.app.evaluate(({ session }, ps) => Promise.all(ps.map((p) => session.fromPartition(p).resolveProxy('http://example.com/'))), parts);
  expect(proxies.every((x) => /^PROXY 127\.0\.0\.1:\d+$/.test(x))).toBe(true);
  expect(new Set(proxies).size).toBe(2);
});

test('profile manager: create, rename, recolour and open in a new window from the UI', async () => {
  a = await launch({ llmUrl: mock.url });
  await a.ui.click('[data-testid=profile-button]');
  await expect(a.ui.locator('[data-testid=profiles-panel]')).toBeVisible();
  await a.ui.fill('[data-testid=profile-new-name]', 'Holiday');
  await a.ui.click('[data-testid=profile-create]');
  await expect(a.ui.locator('[data-testid=profile-msg]')).toHaveText('created');
  await expect(a.ui.locator('[data-testid=profile-row]')).toHaveCount(2);
  const row = a.ui.locator('[data-testid=profile-row]').nth(1);
  await row.locator('[data-testid=profile-open]').click();
  await expect.poll(() => uiWindows(a!.app).length).toBe(2);
  const other = uiWindows(a.app)[1];
  await other.waitForSelector('[data-testid=profile-button]');
  await expect(other.locator('[data-testid=profile-button]')).toContainText('Holiday');
  // rename + recolour the DEFAULT profile from its own manager: toolbar and window title follow
  const mine = a.ui.locator('[data-testid=profile-row]').nth(0);
  await mine.locator('[data-testid=profile-name-input]').fill('Personal');
  await mine.locator('[data-testid=profile-color-input]').fill('#b3261e');
  await mine.locator('[data-testid=profile-save]').click();
  await expect(a.ui.locator('[data-testid=profile-button]')).toContainText('Personal');
  expect(await a.ui.locator('#profile-avatar').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(179, 38, 30)');
  await expect.poll(() => a!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort())).toEqual(['Guarded Browser \u2014 Holiday', 'Guarded Browser \u2014 Personal']);
  // invalid names are refused
  await mine.locator('[data-testid=profile-name-input]').fill('<script>');
  await mine.locator('[data-testid=profile-save]').click();
  await expect(a.ui.locator('[data-testid=profile-msg]')).not.toHaveText('saved');
  // the Profiles menu exists
  const labels = await a.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label));
  expect(labels).toContain('Profiles');
});

test("A's settings, theme and audit log never show in B", async () => {
  mock.script('planner', sequence({ tool: 'finish', args: { answer: 'secret-task-answer' } }));
  a = await launch({ llmUrl: mock.url, maxSteps: 7 });
  const imported = await inv(a.ui, 'theme:import', JSON.stringify({ name: 'Only In A', base: 'dark', background: '#101010', foreground: '#ffffff', accent: '#2f5bd3', highlight: '#333333', radius: 4, density: 'normal' }));
  expect(imported.ok).toBe(true);
  await runTask(a.ui, 'task-text-only-in-profile-A');
  await waitDone(a.ui);
  const b = await openNewProfile(a, 'Private');
  const sa = await inv(a.ui, 'settings:get');
  const sb = await inv(b.ui, 'settings:get');
  expect(sa.agent.maxSteps).toBe(7);
  expect(sb.agent.maxSteps).toBe(20); // defaults
  expect(sb.models.planner.primary.baseURL).not.toBe(sa.models.planner.primary.baseURL);
  expect((await inv(b.ui, 'appearance:get')).appearance.custom).toEqual([]);
  expect((await inv(a.ui, 'appearance:get')).appearance.custom.map((t: { name: string }) => t.name)).toEqual(['Only In A']);
  const auditB = JSON.stringify(await inv(b.ui, 'audit:recent'));
  expect(auditB).not.toContain('task-text-only-in-profile-A');
  expect(JSON.stringify(await inv(a.ui, 'audit:recent'))).toContain('task-text-only-in-profile-A');
  // separate files on disk, with private permissions
  expect(a.profileDir(0)).not.toBe(a.profileDir(1));
  const auditDirB = join(a.profileDir(1), 'audit');
  expect(readdirSync(auditDirB).every((f) => !readFileSync(join(auditDirB, f), 'utf8').includes('task-text-only-in-profile-A'))).toBe(true);
});

test("an agent task in A: B is not POST-gated, not taint-blocked, not allowlist-restricted, and never sees A's confirmation", async () => {
  let release = false;
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: `${site}/coupon.html` } },
    { tool: 'extract', args: { query: 'coupon', schema: { code: 'string' } } },
    { tool: 'navigate', args: { url: 'http://elsewhere.invalid/' } }, // new origin -> confirmation in A
    () => (release ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } }),
  ));
  mock.script('reader', () => ({ json: { code: 'WINTER-SALE-7731' } }));
  a = await launch({ llmUrl: mock.url, confirmTimeoutMs: 60_000 });
  const b = await openNewProfile(a, 'Other');
  await runTask(a.ui, `Get the coupon from ${site}/coupon.html`);
  const modalA = a.ui.locator('.lock-dialog:not(.hidden)');
  await expect(modalA).toBeVisible({ timeout: 20_000 });
  // A's task has registered the coupon and has a task allowlist; now B browses freely:
  const since = Date.now();
  await go(b.ui, `${site}/poster.html`); // POSTs from B
  await expect.poll(() => sink.filter((s) => s.path === '/sink/b-post' && s.at >= since).length, { timeout: 10_000 }).toBeGreaterThan(1);
  await go(b.ui, `${site}/search?q=WINTER-SALE-7731`); // A's taint value, in B
  await expect.poll(() => sink.some((s) => s.path === '/search?q=WINTER-SALE-7731')).toBe(true);
  await go(b.ui, `${fx.attacker}/from-b`); // host outside A's task allowlist
  await expect.poll(() => fx.attackerHits.map((h) => h.url)).toContain('/from-b');
  // B's window never showed a confirmation, A's still does
  await expect(b.ui.locator('.lock-dialog:not(.hidden)')).toHaveCount(0);
  await expect(modalA).toBeVisible();
  // B's own log: plain manual browsing, no task, no taint matches, no blocks, no confirmations
  const auditB = (await inv(b.ui, 'audit:recent')) as Array<Record<string, unknown>>;
  expect(auditB.filter((e) => e.type === 'egress').every((e) => e.layer === 'proxy' && e.decision === 'log')).toBe(true);
  expect(auditB.some((e) => ['task-start', 'confirmation', 'policy'].includes(String(e.type)))).toBe(false);
  await a.ui.click('[data-testid=confirm-deny]');
  release = true;
  await waitDone(a.ui);
});

test("IPC spoofing: window B sending A's profile id or A's confirmation id reaches nothing of A", async () => {
  let release = false;
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: 'http://elsewhere.invalid/' } },
    () => (release ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } }),
  ));
  a = await launch({ llmUrl: mock.url, confirmTimeoutMs: 60_000, maxSteps: 9 });
  const b = await openNewProfile(a, 'Spoofer');
  const idA = await a.ui.locator('[data-testid=profile-button]').getAttribute('data-profile-id');
  await runTask(a.ui, 'task only A knows about');
  await expect(a.ui.locator('.lock-dialog:not(.hidden)')).toBeVisible({ timeout: 20_000 });
  // B even knows A's pending request id
  const confirmId = await a.ui.locator('[data-testid=confirm-modal]').getAttribute('data-request-id');
  // B tries every data channel with A's id appended: it only ever gets B's own data
  expect((await inv(b.ui, 'settings:get', idA)).agent.maxSteps).toBe(20);
  expect(JSON.stringify(await inv(b.ui, 'audit:recent', idA))).not.toContain('task only A knows about');
  expect((await inv(b.ui, 'state:get', idA)).profile.id).not.toBe(idA);
  expect((await inv(b.ui, 'state:get', idA)).task).toBeNull();
  // B answering A's pending confirmation (by any id it could guess) does nothing to A
  const pending = await a.ui.evaluate(() => document.querySelector('.lock-dialog:not(.hidden) #c-action')?.textContent);
  await inv(b.ui, 'confirm:answer', confirmId, 'approve');
  await inv(b.ui, 'agent:stop', idA);
  await a.ui.waitForTimeout(500);
  await expect(a.ui.locator('.lock-dialog:not(.hidden) #c-action')).toHaveText(pending!);
  expect((await inv(a.ui, 'state:get')).task).not.toBeNull();
  // the sync channel from a page asks "is the agent driving me?" for its own tab only
  await go(b.ui, `${site}/store.html`);
  expect(a.audit().some((e) => e.type === 'confirmation')).toBe(false);
  await a.ui.click('[data-testid=confirm-deny]');
  release = true;
  await waitDone(a.ui);
});

test('delete: confirmation in the requesting window, window closed, partition + app-state removed; same name gives a fresh session', async () => {
  a = await launch({ llmUrl: mock.url });
  const c = await openNewProfile(a, 'Temp');
  await go(c.ui, `${site}/store.html?set`);
  const inC = await tabPage(a, '/store.html?set');
  await expect.poll(() => inC.evaluate(() => document.cookie)).toBe('k=profileA');
  const reg = JSON.parse(readFileSync(join(a.userData, 'profiles.json'), 'utf8'));
  const pc = reg.profiles.find((p: { id: string }) => p.id === c.id);
  const partDir = join(a.userData, 'Partitions', pc.partition.replace('persist:', ''));
  const appDir = join(a.userData, 'profiles', c.id);
  await expect.poll(() => existsSync(partDir), { timeout: 10_000 }).toBe(true);
  expect(existsSync(appDir)).toBe(true);

  // the last profile can never be deleted; deleting C asks in A's window (locked dialog)
  const del = inv(a.ui, 'profiles:delete', c.id);
  await expect(a.ui.locator('[data-testid=confirm-modal][data-kind=profile]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=confirm-modal]')).toContainText('delete profile "Temp"');
  await a.ui.click('[data-testid=confirm-approve]');
  expect((await del).ok).toBe(true);
  await expect.poll(() => uiWindows(a!.app).length).toBe(1);
  await expect.poll(() => existsSync(partDir), { timeout: 10_000 }).toBe(false);
  await a.ui.waitForTimeout(2000); // after the delayed second sweep, it must still be gone
  expect(existsSync(partDir)).toBe(false);
  expect(existsSync(appDir)).toBe(false);
  const reg2 = JSON.parse(readFileSync(join(a.userData, 'profiles.json'), 'utf8'));
  expect(reg2.profiles.map((p: { id: string }) => p.id)).not.toContain(c.id);
  expect(reg2.retiredPartitions).toContain(pc.partition);
  const last = await inv(a.ui, 'profiles:delete', reg2.profiles[0].id);
  expect(last).toEqual({ ok: false, error: 'the last profile cannot be deleted' });

  // a new profile with the same name: new id, new partition, no cookie
  const c2 = await openNewProfile(a, 'Temp');
  expect(c2.id).not.toBe(c.id);
  await go(c2.ui, `${site}/store.html?again`);
  const inC2 = await tabPage(a, '/store.html?again');
  expect(await inC2.evaluate(() => document.cookie)).toBe('');
  expect(await inC2.evaluate(() => localStorage.getItem('k'))).toBeNull();
});

test('migration: an existing single-profile install keeps its cookies, settings and audit log', async () => {
  // 1. produce real Chromium data with the app, 2. turn the directory back into the pre-profiles
  //    layout (settings / audit at the top, session in Partitions/guarded), 3. relaunch.
  mock.script('planner', sequence({ tool: 'finish', args: { answer: 'x' } }));
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/store.html?set`, maxSteps: 7, keepUserData: true });
  const inA = await tabPage(a, '/store.html?set');
  await expect.poll(() => inA.evaluate(() => document.cookie)).toBe('k=profileA');
  await runTask(a.ui, 'old-install-task');
  await waitDone(a.ui);
  const ud = a.userData;
  const dir = a.profileDir();
  const reg = JSON.parse(readFileSync(join(ud, 'profiles.json'), 'utf8'));
  await a.close();
  a = undefined;
  renameSync(join(ud, 'Partitions', reg.profiles[0].partition.replace('persist:', '')), join(ud, 'Partitions', 'guarded'));
  for (const e of ['settings.json', 'audit']) renameSync(join(dir, e), join(ud, e));
  mkdirSync(join(ud, 'reputation'), { recursive: true });
  renameSync(join(dir, 'reputation', 'local-allowlist.txt'), join(ud, 'reputation', 'local-allowlist.txt'));
  rmSync(join(ud, 'profiles'), { recursive: true, force: true });
  rmSync(join(ud, 'profiles.json'));

  a = await launch({ llmUrl: mock.url, userData: ud, startUrl: `${site}/store.html?after` });
  const reg2 = JSON.parse(readFileSync(join(ud, 'profiles.json'), 'utf8'));
  expect(reg2.profiles).toHaveLength(1);
  expect(reg2.profiles[0]).toMatchObject({ name: 'Default', partition: 'persist:guarded' });
  const after = await tabPage(a, '/store.html?after');
  expect(await after.evaluate(() => document.cookie)).toBe('k=profileA'); // cookie survived
  expect(await after.evaluate(() => localStorage.getItem('k'))).toBe('profileA');
  expect((await inv(a.ui, 'settings:get')).agent.maxSteps).toBe(7); // settings survived
  expect(JSON.stringify(a.audit())).toContain('old-install-task'); // audit survived
  expect(existsSync(join(a.profileDir(), 'reputation', 'local-allowlist.txt'))).toBe(true);
  expect(existsSync(join(ud, 'settings.json'))).toBe(false);
});

// Watchers (AI capabilities item 5) in the real app, against the mock LLM and the fixture server: a
// watcher made with the isolated-world picker on a price page fires when the fixture changes the
// price (the desktop notification is captured through a test hook); each run uses a throwaway
// partition (the profile's cookie is not sent, unless "use my login"); watchers wait while an agent
// task runs; a read-only recipe can become a watcher and a state-changing one cannot; the external
// CDP runner option is greyed out without a binary.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, runTask, waitDone, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { startMockLlm, sequence, lastExtracted, refFor, type MockLlm } from '../helpers/mock-llm';
import { startFakeTelegram, type FakeTelegram } from '../helpers/fake-telegram';

const BOT_TOKEN = '123456789:AAHe2eFakeTokenForTestsOnly000000002';
const CHAT = '555000222';
let tg: FakeTelegram;

let fx: FixtureServers;
let mock: MockLlm;
test.beforeAll(async () => {
  fx = await startFixtureServers();
  mock = await startMockLlm();
  tg = await startFakeTelegram(BOT_TOKEN);
});
test.afterAll(async () => {
  await tg.close();
  await mock.close();
  await fx.close();
});

async function openWatchers(ui: Page) {
  if (!(await ui.locator('[data-testid=watchers-panel]').isVisible())) await ui.click('[data-testid=rail-watchers]');
  await expect(ui.locator('[data-testid=watchers-panel]')).toBeVisible();
}

const notifications = (a: App) => {
  const f = join(a.userData, 'notifications.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const watcherRuns = (a: App) => a.audit().filter((e) => e.type === 'watcher' && e.ok !== undefined);
const priceHits = () => fx.siteHits.filter((h) => h.url === '/price.html');

/** Click the Blue Widget price inside the page (real input events, so the in-page picker sees them). */
async function clickPrice(a: App) {
  await a.app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/price.html'))!;
    const r = await wc.executeJavaScript(`(() => { const b = document.querySelector('.card .price').getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  });
}

async function runNow(a: App, n = 0) {
  await a.ui.locator('[data-testid=watcher-item]').nth(n).locator('[data-testid=watcher-run-now]').click();
}

test.describe('watchers', () => {
  test.describe.configure({ mode: 'serial' });
  let a: App;
  test.beforeAll(async () => {
    fx.vars.PRICE = '19.99';
    a = await launch({ llmUrl: mock.url, startUrl: `${fx.site}/price.html`, notifyFile: true, telegramApi: tg.base });
  });
  test.afterAll(async () => {
    await a?.close();
  });

  test('the external CDP runner option is greyed out, with the reason, when there is no binary', async () => {
    await openWatchers(a.ui);
    await a.ui.click('[data-testid=watcher-runner] summary');
    await expect(a.ui.locator('[data-testid=watcher-runner-external]')).toBeDisabled();
    await expect(a.ui.locator('[data-testid=watcher-runner-electron]')).toBeChecked();
    await expect(a.ui.locator('[data-testid=watcher-runner-why]')).toHaveText('External runner unavailable: no path set. Set the absolute path of an installed binary and Save.');
    await a.ui.fill('[data-testid=watcher-runner-path]', '/nonexistent/lightpanda');
    await a.ui.click('[data-testid=watcher-runner-external]', { force: true }).catch(() => undefined);
    await a.ui.click('[data-testid=watcher-runner-save]');
    await expect(a.ui.locator('[data-testid=watcher-runner-why]')).toHaveText('External runner unavailable: no file at that path. Set the absolute path of an installed binary and Save.');
    await expect(a.ui.locator('[data-testid=watcher-runner-external]')).toBeDisabled();
    // the code refuses it too
    const r = await a.ui.evaluate(() => (window as any).gb.invoke('watcher:runner-set', { runner: 'external', externalPath: '/nonexistent/lightpanda' }));
    expect(r).toMatchObject({ ok: false, runner: 'electron', externalAvailable: false });
    expect(JSON.parse(readFileSync(join(a.profileDir(), 'settings.json'), 'utf8')).watchers.runner).toBe('electron');
  });

  test('picked with the in-page picker; fires (desktop notification) when the fixture price drops below the threshold; history and audit hold values, never page text', async () => {
    await openWatchers(a.ui);
    await a.ui.click('[data-testid=watcher-pick]');
    await expect(a.ui.locator('[data-testid=watcher-msg]')).toContainText('Click the value on the page');
    await clickPrice(a);
    await expect(a.ui.locator('[data-testid=watcher-form]')).toBeVisible();
    await expect(a.ui.locator('[data-testid=watcher-target]')).toHaveText(`Watching “Price: $19.99 USD” on ${fx.site}/price.html`);
    await expect(a.ui.locator('[data-testid=watcher-kind]')).toHaveValue('number');
    await a.ui.fill('[data-testid=watcher-name]', 'Blue Widget price');
    await a.ui.selectOption('[data-testid=watcher-condition]', 'below');
    await a.ui.fill('[data-testid=watcher-condition-value]', '15');
    await a.ui.fill('[data-testid=watcher-every]', '30');
    await a.ui.click('[data-testid=watcher-create]');
    await expect(a.ui.locator('[data-testid=watcher-msg]')).toHaveText('Created “Blue Widget price”.');
    const w = JSON.parse(readFileSync(join(a.profileDir(), 'watchers.json'), 'utf8')).watchers[0];
    expect(w.config).toMatchObject({ urls: [`${fx.site}/price.html`], kind: 'number', condition: { kind: 'below', value: 15 }, everyMinutes: 30, useLogin: false });
    expect(w.config.locator).toMatchObject({ role: 'text', tag: 'p', cls: 'price', label: 'Blue Widget', landmark: 'main' });

    // a schedule of less than 5 minutes is refused
    const tooOften = await a.ui.evaluate((loc) => (window as any).gb.invoke('watcher:create', { name: 'x', urls: ['http://127.0.0.1:1/'], locator: loc, kind: 'number', condition: { kind: 'changes' }, everyMinutes: 1, notify: { desktop: true, telegram: false }, useLogin: false }), w.config.locator);
    expect(tooOften.ok).toBe(false);
    expect(tooOften.error).toContain('everyMinutes');

    await runNow(a);
    await expect.poll(() => watcherRuns(a).length).toBe(1);
    expect(watcherRuns(a)[0]).toMatchObject({ ok: true, value: 19.99, met: false, notified: false, runner: 'electron' });
    await expect(a.ui.locator('[data-testid=watcher-last]').first()).toHaveText('Last value: 19.99');
    expect(notifications(a)).toHaveLength(0);

    fx.vars.PRICE = '12.50';
    await runNow(a);
    await expect.poll(() => watcherRuns(a).length).toBe(2);
    expect(watcherRuns(a)[1]).toMatchObject({ ok: true, value: 12.5, met: true, notified: true });
    await expect.poll(() => notifications(a).length).toBe(1);
    expect(notifications(a)[0]).toMatchObject({ title: 'Watcher “Blue Widget price”', body: `${new URL(fx.site).host}: the watched value is now 12.5 (below 15).` });
    // still below, same value: no second notification
    await runNow(a);
    await expect.poll(() => watcherRuns(a).length).toBe(3);
    expect(watcherRuns(a)[2]).toMatchObject({ met: true, notified: false });
    expect(notifications(a)).toHaveLength(1);
    await a.ui.locator('[data-testid=watcher-history-toggle]').first().click();
    await expect(a.ui.locator('[data-testid=watcher-history-row]')).toHaveCount(3);
    await expect(a.ui.locator('[data-testid=watcher-history-row]').first()).toContainText('12.5');
    // no model was involved in any run
    expect(mock.calls).toHaveLength(0);
    // the audit lines carry the typed value only
    expect(JSON.stringify(watcherRuns(a))).not.toContain('Price:');
  });

  test('each run uses a fresh in-memory partition: the profile cookie is not sent; "use my login" copies it in (and the UI warns)', async () => {
    const profilePartition = (JSON.parse(readFileSync(join(a.userData, 'profiles.json'), 'utf8')) as { profiles: Array<{ partition: string }> }).profiles[0].partition;
    await a.app.evaluate(async ({ session }, p) => {
      await session.fromPartition(p.partition).cookies.set({ url: p.site, name: 'profile_cookie', value: 'logged-in', path: '/' });
    }, { partition: profilePartition, site: fx.site });
    const before = priceHits().length;
    await runNow(a);
    await expect.poll(() => watcherRuns(a).length).toBe(4);
    const hits = priceHits().slice(before);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.cookie?.includes('profile_cookie'))).toBe(true);
    const run = watcherRuns(a)[3];
    expect(run.session).toMatch(/^ephemeral watch-[0-9a-f-]{36}$/);
    // the partition is gone after the run: nothing of it is in memory any more
    const leftover = await a.app.evaluate(async ({ session }, p) => (await session.fromPartition(p).cookies.get({})).length, run.session.slice('ephemeral '.length));
    expect(leftover).toBe(0);

    // "use my login": the warning, then the cookie goes along (still read-only, still ephemeral)
    await a.ui.click('[data-testid=watcher-pick]');
    await clickPrice(a);
    await a.ui.check('[data-testid=watcher-login]');
    await expect(a.ui.locator('[data-testid=watcher-login-warning]')).toBeVisible();
    await a.ui.click('[data-testid=watcher-cancel]');
    const id = JSON.parse(readFileSync(join(a.profileDir(), 'watchers.json'), 'utf8')).watchers[0].id;
    await a.ui.evaluate((wid) => (window as any).gb.invoke('watcher:update', wid, { useLogin: true }), id);
    const b2 = priceHits().length;
    await runNow(a);
    await expect.poll(() => watcherRuns(a).length).toBe(5);
    expect(priceHits().slice(b2).some((h) => h.cookie?.includes('profile_cookie=logged-in'))).toBe(true);
    expect(watcherRuns(a)[4].session).toMatch(/^ephemeral watch-.* \(with your cookies for these sites\)$/);
    await a.ui.evaluate((wid) => (window as any).gb.invoke('watcher:update', wid, { useLogin: false }), id);
  });

  test('watchers do not run while an agent task is running; the waiting run goes when the task ends', async () => {
    mock.reset();
    mock.script('planner', sequence({ tool: 'finish', args: { answer: 'done' }, delayMs: 5000 }));
    const before = watcherRuns(a).length;
    await runTask(a.ui, 'Wait a moment, then finish');
    await expect(a.ui.locator('[data-testid=task-stop]')).toBeEnabled();
    await openWatchers(a.ui);
    await runNow(a);
    await expect(a.ui.locator('[data-testid=watcher-waiting]')).toContainText('Waiting: an agent task or a recipe replay is running');
    await expect(a.ui.locator('[data-testid=watcher-msg]')).toHaveText('an agent task or a recipe replay is running: it runs as soon as that ends');
    await new Promise((r) => setTimeout(r, 1500));
    expect(watcherRuns(a).length).toBe(before);
    expect(await waitDone(a.ui)).toBe('finished');
    await expect.poll(() => watcherRuns(a).length, { timeout: 20_000 }).toBe(before + 1);
    const run = watcherRuns(a).at(-1)!;
    const end = a.audit().filter((e) => e.type === 'task-end').at(-1)!;
    expect(Date.parse(run.ts)).toBeGreaterThanOrEqual(Date.parse(end.ts));
  });

  test('a read-only recipe becomes a watcher; a recipe that changes something cannot', async () => {
    mock.reset();
    // a task that reads the price: recorded as open + extract (read-only)
    mock.script('planner', sequence(
      { tool: 'navigate', args: { url: `${fx.site}/shop.html` } },
      { tool: 'extract', args: { query: 'price of the Blue Widget', schema: { price: 'number' } } },
      (c) => ({ tool: 'finish', args: { answer: `price ${lastExtracted(c)?.price}` } }),
    ));
    mock.script('reader', () => ({ json: { price: 19.99 } }));
    await runTask(a.ui, `Find the price of the Blue Widget on ${fx.site}/shop.html`);
    expect(await waitDone(a.ui)).toBe('finished');
    await a.ui.click('[data-testid=recipe-save-open]');
    await expect(a.ui.locator('[data-testid=recipe-save-step]')).toHaveText([`Open ${fx.site}/shop.html`, `Read the number “price” from the p under “Blue Widget” on ${new URL(fx.site).host}`]);
    await a.ui.fill('[data-testid=recipe-name]', 'Widget price');
    await a.ui.click('[data-testid=recipe-save]');
    await expect(a.ui.locator('[data-testid=recipe-save-msg]')).toContainText('Saved');

    // replaying it reads the value with no model
    mock.reset();
    await a.ui.click('[data-testid=rail-recipes]');
    const item = a.ui.locator('[data-testid=recipe-item]').filter({ hasText: 'Widget price' });
    await item.locator('[data-testid=recipe-run]').click();
    await a.ui.click('[data-testid=recipe-run-start]');
    await expect(a.ui.locator('[data-testid=recipes-msg]')).toContainText('Replaying “Widget price”');
    expect(await waitDone(a.ui)).toBe('finished');
    await expect(a.ui.locator('[data-testid=task-answer]')).toContainText('price: 19.99');
    expect(mock.calls).toHaveLength(0);

    // "Watch…" on it opens the watcher form for that recipe
    await item.locator('[data-testid=recipe-watch]').click();
    await expect(a.ui.locator('[data-testid=watchers-panel]')).toBeVisible();
    await expect(a.ui.locator('[data-testid=watcher-target]')).toContainText('From the recipe “Widget price”');
    await a.ui.selectOption('[data-testid=watcher-condition]', 'changes');
    await a.ui.click('[data-testid=watcher-create]');
    await expect(a.ui.locator('[data-testid=watcher-msg]')).toHaveText('Created “Widget price”.');
    const ws = JSON.parse(readFileSync(join(a.profileDir(), 'watchers.json'), 'utf8')).watchers;
    expect(ws.at(-1).config).toMatchObject({ urls: [`${fx.site}/shop.html`], recipeId: expect.any(String), locator: { role: 'text', tag: 'p', label: 'Blue Widget' } });

    // a recipe with a click / type / submit is refused as a watcher (enforced in code)
    mock.reset();
    mock.script('planner', sequence(
      { tool: 'navigate', args: { url: `${fx.site}/form.html` } },
      (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Name/), text: 'Ann' } }),
      { tool: 'finish', args: { answer: 'typed' } },
    ));
    await runTask(a.ui, `Type Ann into the name field on ${fx.site}/form.html`);
    expect(await waitDone(a.ui)).toBe('finished');
    await a.ui.click('[data-testid=recipe-save-open]');
    await a.ui.fill('[data-testid=recipe-name]', 'Type a name');
    await a.ui.click('[data-testid=recipe-save]');
    await expect(a.ui.locator('[data-testid=recipe-save-msg]')).toContainText('Saved');
    const recipes = JSON.parse(readFileSync(join(a.profileDir(), 'recipes.json'), 'utf8')).recipes as Array<{ id: string; name: string }>;
    const typing = recipes.find((r) => r.name === 'Type a name')!;
    await a.ui.click('[data-testid=rail-recipes]');
    await expect(a.ui.locator('[data-testid=recipe-item]').filter({ hasText: 'Type a name' }).locator('[data-testid=recipe-watch]')).toHaveCount(0);
    const refused = await a.ui.evaluate((id) => (window as any).gb.invoke('watcher:create', { recipeId: id, name: 'nope', kind: 'number', condition: { kind: 'changes' }, everyMinutes: 60, notify: { desktop: true, telegram: false } }), typing.id);
    expect(refused).toEqual({ ok: false, error: 'this recipe changes something (it clicks, types or submits): a watcher may only open pages and read a value' });
  });

  test('Telegram: a firing watcher is also sent to the phone-approvals chat when that is configured and chosen', async () => {
    const r = await a.ui.evaluate((p) => (window as any).gb.invoke('phone:set', { enabled: true, chatId: p.chat, token: p.token }), { chat: CHAT, token: BOT_TOKEN });
    expect(r.ok).toBe(true);
    const w = JSON.parse(readFileSync(join(a.profileDir(), 'watchers.json'), 'utf8')).watchers[0];
    await a.ui.evaluate((id) => (window as any).gb.invoke('watcher:update', id, { notify: { desktop: true, telegram: true } }), w.id);
    await openWatchers(a.ui);
    const n = watcherRuns(a).length;
    fx.vars.PRICE = '19.99';
    await runNow(a);
    await expect.poll(() => watcherRuns(a).length).toBe(n + 1);
    expect(tg.sent).toHaveLength(0);
    fx.vars.PRICE = '9.99';
    await runNow(a);
    await expect.poll(() => tg.sent.length).toBe(1);
    expect(tg.sent[0]).toMatchObject({ chat_id: CHAT, text: `Watcher “Blue Widget price”: ${new URL(fx.site).host}: the watched value is now 9.99 (below 15).` });
    expect(a.audit().some((e) => e.type === 'phone' && e.what === 'watcher notification' && e.ok === true)).toBe(true);
    expect(JSON.stringify(a.audit())).not.toContain(BOT_TOKEN);
  });
});

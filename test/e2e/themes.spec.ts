// Themes: import validation, live preview, schedule, site accent, and LOCKED security styling.

import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { launch, runTask, type App } from './harness';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';
import { contrast, parseColor } from '../../src/core/theme';

/** Minimal solid-colour 16x16 PNG (for a favicon), built without extra dependencies. */
function solidPng(r: number, g: number, b: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 16 }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

let mock: MockLlm;
let a: App | undefined;
let site = '';
let port = 0;
let srv: http.Server;
const PAGES: Record<string, string> = {
  '/meta.html': `<!doctype html><title>Meta green</title><meta name="theme-color" content="#00c853"><p>hello</p>`,
  '/meta-warn.html': `<!doctype html><title>Warn accent</title><meta name="theme-color" content="#ffe082"><p>hello</p>`,
  '/meta-evil.html': `<!doctype html><title>Meta evil</title><meta name="theme-color" content="red; } .lock-dialog { display:none } x {"><p>hello</p>`,
  '/fav.html': `<!doctype html><title>Favicon only</title><link rel="icon" href="/fav.png"><p>hello</p>`,
  '/plain.html': `<!doctype html><title>Plain</title><p>plain</p>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  srv = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/fav.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(solidPng(0xd5, 0x00, 0xf9)); // purple
      return;
    }
    if (path === '/feed.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('# test feed\nlocalhost\n');
      return;
    }
    const p = PAGES[path];
    res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' });
    res.end(p ?? '<title>nf</title>nf');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  port = (srv.address() as AddressInfo).port;
  site = `http://127.0.0.1:${port}`;
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

const cssVar = (ui: Page, name: string) => ui.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const style = (ui: Page, sel: string, prop: string) => ui.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

async function openSettings(ui: Page) {
  await expect(async () => {
    await ui.click('[data-testid=open-settings]');
    await expect(ui.locator('[data-testid=settings-panel]')).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

async function importTheme(ui: Page, theme: unknown) {
  await ui.fill('[data-testid=theme-json]', typeof theme === 'string' ? theme : JSON.stringify(theme));
  await ui.click('[data-testid=theme-import]');
  return (await ui.locator('[data-testid=theme-msg]').innerText()).trim();
}

const READABLE = { name: 'Readable', base: 'dark', background: '#101010', foreground: '#ffe082', accent: '#ffe082', highlight: '#303030', radius: 16, density: 'compact' };
const EXTREME = { name: 'Extreme', base: 'light', background: '#ffe082', foreground: '#ffe082', accent: '#ffe082', highlight: '#ffe082', radius: 16, density: 'compact' };

test('theme import is validated strictly: CSS injection, named colours, ranges, extra keys are rejected', async () => {
  a = await launch({ llmUrl: mock.url });
  await openSettings(a.ui);
  const bad = [
    'not json',
    { ...EXTREME, name: 'x1', background: 'red;}</style><script>alert(1)</script>' },
    { ...EXTREME, name: 'x2', accent: 'url(javascript:alert(1))' },
    { ...EXTREME, name: 'x3', foreground: 'red' },
    { ...EXTREME, name: 'x4', highlight: 'var(--accent)' },
    { ...EXTREME, name: 'x5', radius: 999 },
    { ...EXTREME, name: 'x6', css: '.lock-dialog{display:none}' },
    { ...EXTREME, name: 'Dark' }, // built-in name
    { ...EXTREME, name: 'Unreadable' }, // background == foreground (contrast 1:1)
    { ...EXTREME, name: 'Nice Mono', background: '#101010', foreground: '#101010', highlight: '#101010' },
  ];
  for (const b of bad) expect(await importTheme(a.ui, b), JSON.stringify(b)).toMatch(/^rejected/);
  expect(await importTheme(a.ui, { ...READABLE, name: 'Good one', background: 'rgb(10, 20, 30)' })).toBe('imported "Good one"');
  await expect(a.ui.locator('[data-testid=theme-select] option')).toContainText(['System', 'Light', 'Dark', 'Light Violet', 'Dark Teal', 'Good one']);
  const saved = JSON.parse(readFileSync(join(a.userData, 'settings.json'), 'utf8')).appearance.custom;
  expect(saved).toEqual([{ ...READABLE, name: 'Good one', background: '#0a141e' }]);
});

test('theme editor live preview, save, and it themes the chrome only (never a web page)', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/plain.html` });
  await openSettings(a.ui);
  await a.ui.click('#te-load');
  await a.ui.fill('[data-testid=te-name]', 'Pinkish');
  await a.ui.locator('[data-testid=te-background]').fill('#ffd0f0');
  await expect.poll(() => style(a!.ui, 'body', 'background-color')).toBe('rgb(255, 208, 240)'); // live
  await a.ui.click('#te-revert');
  await expect.poll(() => style(a!.ui, 'body', 'background-color')).not.toBe('rgb(255, 208, 240)');
  await a.ui.locator('[data-testid=te-background]').fill('#ffd0f0');
  await a.ui.click('[data-testid=theme-save]');
  await expect(a.ui.locator('[data-testid=theme-msg]')).toHaveText('saved "Pinkish"');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.theme)).toBe('Pinkish');
  // the web page in the tab is untouched
  const page = a.app.windows().find((w) => w.url().endsWith('/plain.html'))!;
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

test('scheduled themes: day / night by the local clock', async () => {
  a = await launch({ llmUrl: mock.url });
  await openSettings(a.ui);
  const now = new Date();
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // night started an hour ago and day starts in an hour -> it is "night" now
  await a.ui.selectOption('[data-testid=schedule-mode]', 'times');
  await a.ui.selectOption('[data-testid=schedule-day]', 'Light Violet');
  await a.ui.selectOption('[data-testid=schedule-night]', 'Dark Teal');
  await a.ui.fill('[data-testid=schedule-night-start]', hm(new Date(now.getTime() - 3600_000)));
  await a.ui.fill('[data-testid=schedule-day-start]', hm(new Date(now.getTime() + 3600_000)));
  await a.ui.click('[data-testid=appearance-save]');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.theme)).toBe('Dark Teal');
  // swap the times -> day
  await a.ui.fill('[data-testid=schedule-day-start]', hm(new Date(now.getTime() - 3600_000)));
  await a.ui.fill('[data-testid=schedule-night-start]', hm(new Date(now.getTime() + 3600_000)));
  await a.ui.click('[data-testid=appearance-save]');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.theme)).toBe('Light Violet');
});

test('site accent: theme-color (blended, 4.5:1), favicon fallback, malformed values ignored', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/meta.html` });
  const base = await cssVar(a.ui, '--accent');
  await openSettings(a.ui);
  await a.ui.check('[data-testid=site-accent]');
  await a.ui.click('[data-testid=appearance-save]');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.siteAccent)).toBe('theme-color');
  const acc = await cssVar(a.ui, '--accent');
  const fg = await cssVar(a.ui, '--accent-fg');
  expect(acc).not.toBe(base);
  expect(contrast(parseColor(acc)!, parseColor(fg)!)).toBeGreaterThanOrEqual(4.5);

  await a.ui.click('#s-close');
  for (const [path, expected] of [['/meta-evil.html', 'off'], ['/fav.html', 'favicon']] as const) {
    await a.ui.fill('[data-testid=address]', `${site}${path}`);
    await a.ui.press('[data-testid=address]', 'Enter');
    await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.siteAccent), { timeout: 15_000 }).toBe(expected);
  }
});

test('LOCKED styling: an extreme theme + site accent cannot restyle the confirmation dialog, agent frame, notices or the interstitial', async () => {
  let release = false;
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: 'http://elsewhere.invalid/' } }, // new origin -> confirmation
    () => (release ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } }),
  ));
  a = await launch({
    llmUrl: mock.url,
    startUrl: `${site}/meta-warn.html`,
    confirmTimeoutMs: 60_000,
    feeds: [{ name: 'theme-test-feed', url: `${site}/feed.txt`, format: 'domains', enabled: true }],
  });
  await openSettings(a.ui);
  // an unreadable theme is refused at import ...
  expect(await importTheme(a.ui, EXTREME)).toMatch(/^rejected: .*contrast/);
  // ... so emulate one that got past validation anyway: every theme variable = the warning colour
  await a.ui.check('[data-testid=site-accent]');
  await a.ui.click('[data-testid=appearance-save]');
  await expect.poll(() => a!.ui.evaluate(() => document.documentElement.dataset.siteAccent)).toBe('theme-color');
  await a.ui.click('#s-close');
  const forceExtreme = () =>
    a!.ui.evaluate(() => {
      for (const v of ['--bg', '--fg', '--card', '--line', '--muted', '--accent', '--accent-fg', '--accent-text', '--highlight', '--danger', '--warn', '--ok']) document.documentElement.style.setProperty(v, '#ffe082');
    });
  await forceExtreme();
  // the theme really is extreme: chrome background == foreground == warning colour
  expect(await style(a.ui, 'body', 'background-color')).toBe('rgb(255, 224, 130)');
  expect(await style(a.ui, 'body', 'color')).toBe('rgb(255, 224, 130)');

  // address bar, task status and guard chip stay readable (locked)
  const readable = async (sel: string) => {
    const [fg, bg] = await a!.ui.locator(sel).evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
    const rgb = (x: string) => { const m = x.match(/\d+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2] }; };
    return contrast(rgb(fg), rgb(bg));
  };
  for (const sel of ['[data-testid=address]', '[data-testid=task-status]', '[data-testid=guard-status]']) expect(await readable(sel), sel).toBeGreaterThanOrEqual(4.5);

  // allowlist editor (preflight) keeps its locked look
  await a.ui.fill('[data-testid=task-input]', 'look around');
  await a.ui.click('[data-testid=task-run]');
  expect(await style(a.ui, '[data-testid=preflight]', 'background-color')).toBe('rgb(255, 244, 229)');
  expect(await style(a.ui, '[data-testid=preflight]', 'color')).toBe('rgb(62, 39, 35)');
  await a.ui.click('[data-testid=preflight-start]');

  // confirmation dialog
  await forceExtreme();
  const card = '.lock-dialog:not(.hidden) .card';
  await expect(a.ui.locator(card)).toBeVisible({ timeout: 20_000 });
  expect(await style(a.ui, card, 'background-color')).toBe('rgb(255, 255, 255)');
  expect(await style(a.ui, card, 'color')).toBe('rgb(17, 17, 17)');
  expect(await style(a.ui, card, 'border-top-color')).toBe('rgb(176, 0, 32)');
  expect(await style(a.ui, `${card} h2`, 'color')).toBe('rgb(176, 0, 32)');
  expect(await style(a.ui, `${card} [data-testid=confirm-source]`, 'color')).toBe('rgb(17, 17, 17)');
  expect(await style(a.ui, '[data-testid=confirm-approve]', 'background-color')).toMatch(/^rgb\((11, 87, 208|158, 158, 158)\)$/);
  await expect(a.ui.locator('[data-testid=confirm-approve]')).toBeEnabled();
  expect(await style(a.ui, '[data-testid=confirm-approve]', 'background-color')).toBe('rgb(11, 87, 208)');
  expect(await style(a.ui, '[data-testid=confirm-approve]', 'color')).toBe('rgb(255, 255, 255)');
  expect(await style(a.ui, '[data-testid=confirm-deny]', 'background-color')).toBe('rgb(255, 255, 255)');
  expect(await style(a.ui, '[data-testid=confirm-stop]', 'background-color')).toBe('rgb(176, 0, 32)');
  expect(await style(a.ui, card, 'font-size')).toBe('13px'); // density does not shrink it

  // AGENT ACTIVE frame + badge
  expect(await style(a.ui, '[data-testid=agent-pane]', 'border-top-color')).toBe('rgb(255, 214, 0)');
  expect(await style(a.ui, '[data-testid=agent-active-badge]', 'background-color')).toBe('rgb(255, 214, 0)');
  expect(await style(a.ui, '[data-testid=agent-active-badge]', 'color')).toBe('rgb(0, 0, 0)');
  await a.ui.click('[data-testid=confirm-deny]');
  release = true;
  await expect(a.ui.locator('[data-testid=task-status][data-status]')).toHaveAttribute('data-status', /.+/, { timeout: 60_000 });

  // reputation interstitial (a page the browser generates; themes never reach page content)
  await expect(a.ui.locator('[data-testid=reputation-status]')).toContainText('reputation: 1 hosts', { timeout: 20_000 });
  await a.ui.fill('[data-testid=address]', `http://localhost:${port}/plain.html`);
  await a.ui.press('[data-testid=address]', 'Enter');
  let inter: Page | undefined;
  await expect.poll(() => (inter = a!.app.windows().find((w) => w.url().startsWith('data:text/html'))) !== undefined, { timeout: 15_000 }).toBe(true);
  await expect(inter!.locator('h1')).toHaveText('Dangerous site blocked');
  expect(await inter!.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(127, 29, 29)');
  expect(await inter!.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(255, 255, 255)');
});

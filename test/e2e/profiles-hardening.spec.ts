// Profiles review: proxy robustness and cross-profile proxy access, no partition fallback when a
// profile disappears while opening, sweeping deleted partitions, quarantining strays, app-wide
// guard settings.

import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { launch, openNewProfile, uiWindows, type App } from './harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let mock: MockLlm;
let a: App | undefined;
let site = '';
let srv: http.Server;
test.beforeAll(async () => {
  mock = await startMockLlm();
  srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>page</title><p>page</p>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await mock.close();
  srv.closeAllConnections();
  srv.close();
});
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const inv = (ui: Page, ch: string, ...args: unknown[]) => ui.evaluate(([c, x]) => (window as any).gb.invoke(c, ...(x as unknown[])), [ch, args] as const);
const partitions = (app: App) => JSON.parse(readFileSync(join(app.userData, 'profiles.json'), 'utf8')).profiles.map((p: { partition: string }) => p.partition) as string[];
async function proxyPort(app: App, partition: string): Promise<number> {
  const s = await app.app.evaluate(({ session }, p) => session.fromPartition(p).resolveProxy('http://example.com/'), partition);
  return Number(/:(\d+)$/.exec(s)![1]);
}
const raw = (port: number, payload: string) =>
  new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(payload));
    let out = '';
    s.on('data', (d) => (out += d.toString()));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    setTimeout(() => s.destroy(), 1500);
  });

test('malformed and origin-form requests to a profile proxy get 400 and the app stays alive', async () => {
  a = await launch({ llmUrl: mock.url });
  const port = await proxyPort(a, partitions(a)[0]);
  for (const b of [
    'GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    'GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
    'CONNECT /x HTTP/1.1\r\n\r\n',
    'NOT A REQUEST\r\n\r\n',
  ]) {
    expect(await raw(port, b), JSON.stringify(b)).toMatch(/^HTTP\/1\.1 400/);
  }
  // the app (main process) is still alive and browsing works
  await a.ui.fill('[data-testid=address]', `${site}/ok`);
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('page');
  expect(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  // any other uncaught error / rejection in main is logged, not fatal
  await a.app.evaluate(() => {
    setTimeout(() => {
      throw new Error('boom-uncaught-test');
    }, 10);
    void Promise.reject(new Error('boom-rejection-test'));
  });
  await expect.poll(() => a!.audit().filter((e) => e.type === 'error' && /boom-(uncaught|rejection)-test/.test(String(e.error))).map((e) => e.where).sort()).toEqual(['uncaughtException', 'unhandledRejection']);
  expect(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test("a page in profile B cannot reach profile A's proxy port (fetch or WebSocket)", async () => {
  a = await launch({ llmUrl: mock.url });
  const b = await openNewProfile(a, 'B');
  const [pa, pb] = partitions(a);
  const portA = await proxyPort(a, pa);
  expect(await proxyPort(a, pb)).not.toBe(portA);
  await b.ui.fill('[data-testid=address]', `${site}/b`);
  await b.ui.press('[data-testid=address]', 'Enter');
  let page: Page | undefined;
  await expect.poll(() => (page = a!.app.windows().find((w) => w.url().endsWith('/b'))) !== undefined).toBe(true);
  const result = await page!.evaluate(async (port) => {
    const out: string[] = [];
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      out.push(`fetch ${r.status}`);
    } catch {
      out.push('fetch failed');
    }
    await new Promise<void>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.onopen = () => (out.push('ws open'), res());
      ws.onerror = () => (out.push('ws error'), res());
      setTimeout(res, 3000);
    });
    return out;
  }, portA);
  expect(result).not.toContain('ws open');
  expect(result.join(' ')).not.toMatch(/fetch 200/);
  const blocks = a.audit(1).filter((e) => e.type === 'egress' && /browser egress proxy port/.test(String(e.reason)));
  expect(blocks.length).toBeGreaterThanOrEqual(1);
});

test('a profile deleted while its window is being created never opens (no fallback to another session)', async () => {
  a = await launch({ llmUrl: mock.url, openDelayMs: 2500 });
  const created = await inv(a.ui, 'profiles:create', 'Vanishing', '#7c3aed');
  const opening = a.ui.evaluate((id) => (window as any).gb.invoke('profiles:open', id).then(() => 'opened', (e: Error) => `rejected: ${e.message}`), created.id);
  const del = inv(a.ui, 'profiles:delete', created.id);
  await expect(a.ui.locator('[data-testid=confirm-modal][data-kind=profile]')).toBeVisible();
  await a.ui.click('[data-testid=confirm-approve]');
  expect((await del).ok).toBe(true);
  expect(await opening).toMatch(/rejected: .*deleted while its window was being created/);
  await a.ui.waitForTimeout(1000);
  expect(uiWindows(a.app)).toHaveLength(1);
  expect(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toEqual([expect.stringContaining('Default')]);
});

test("deleted profiles' partition dirs that reappear are swept at startup; strays are quarantined", async () => {
  a = await launch({ llmUrl: mock.url, keepUserData: true });
  const b = await openNewProfile(a, 'Gone');
  const reg = JSON.parse(readFileSync(join(a.userData, 'profiles.json'), 'utf8'));
  const partB = reg.profiles.find((p: { id: string }) => p.id === b.id).partition as string;
  const del = inv(a.ui, 'profiles:delete', b.id);
  await a.ui.click('[data-testid=confirm-approve]');
  expect((await del).ok).toBe(true);
  const ud = a.userData;
  await a.close();
  a = undefined;
  const dirB = join(ud, 'Partitions', partB.replace('persist:', ''));
  mkdirSync(join(dirB, 'Local Storage'), { recursive: true });
  writeFileSync(join(dirB, 'Cookies'), 'reappeared');
  // and single-profile files that an old build would write
  writeFileSync(join(ud, 'settings.json'), '{"stray":true}');
  mkdirSync(join(ud, 'audit'), { recursive: true });
  writeFileSync(join(ud, 'audit', 'session-stray.jsonl'), '{"type":"stray"}\n');

  a = await launch({ llmUrl: mock.url, userData: ud });
  expect(existsSync(dirB)).toBe(false);
  expect(existsSync(join(ud, 'settings.json'))).toBe(false);
  const q = readdirSync(join(ud, 'quarantine'));
  expect(q).toHaveLength(1);
  expect(readFileSync(join(ud, 'quarantine', q[0], 'settings.json'), 'utf8')).toBe('{"stray":true}');
  expect(a.audit().some((e) => e.type === 'error' && e.where === 'migration' && /quarantined/.test(String(e.error)))).toBe(true);
  expect(a.audit().some((e) => /reappeared partition dir/.test(String(e.reason)))).toBe(true);
});

test('guard and feed-list settings are app-wide: edited in B, seen in A, labelled as such', async () => {
  a = await launch({ llmUrl: mock.url });
  const b = await openNewProfile(a, 'B');
  const sb = await inv(b.ui, 'settings:get');
  sb.guard.threshold = 0.7;
  sb.reputation.feeds = [{ name: 'shared-test-feed', url: `${site}/feed.txt`, format: 'domains', enabled: false }];
  await inv(b.ui, 'settings:save', sb);
  const sa = await inv(a.ui, 'settings:get');
  expect(sa.guard.threshold).toBe(0.7);
  expect(sa.reputation.feeds.map((f: { name: string }) => f.name)).toEqual(['shared-test-feed']);
  expect(JSON.parse(readFileSync(join(a.userData, 'shared.json'), 'utf8')).guard.threshold).toBe(0.7);
  // per-profile values stay per profile
  sb.agent.maxSteps = 3;
  await inv(b.ui, 'settings:save', sb);
  expect((await inv(a.ui, 'settings:get')).agent.maxSteps).not.toBe(3);
  await a.ui.click('[data-testid=open-settings]');
  await expect(a.ui.locator('[data-testid=guard-settings] legend')).toContainText('applies to ALL profiles');
  await expect(a.ui.locator('#settings-form')).toContainText('feeds (JSON) — applies to ALL profiles');
});

// "Allow other AI agents (MCP)" + phone approvals (AI capabilities item 3) in the real app, against
// the mock LLM and a fake Telegram Bot API: off by default; on from Settings; wrong token 401, browser
// Origin 403; browse_task through the stdio launcher returns the answer wrapped as untrusted content
// and ran in a throwaway partition (the profile's cookie invisible, the task's cookie gone afterwards);
// a confirmation raised during an MCP task is shown on screen AND on the phone, a callback from
// another chat does nothing, the right chat's Approve resolves it; use_profile needs an approval; a
// second concurrent call is busy; open_url's first call per session is approved; Revoke rotates the
// token; turning MCP off closes the port.

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launch, ROOT, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { startMockLlm, sequence, refFor, type MockLlm } from '../helpers/mock-llm';
import { startFakeTelegram, type FakeTelegram } from '../helpers/fake-telegram';

const BOT_TOKEN = '123456789:AAHe2eFakeTokenForTestsOnly000000001';
const CHAT = '555000111';
const OTHER_CHAT = '555000999';

let fx: FixtureServers;
let mock: MockLlm;
let tg: FakeTelegram;
/** a site that sets a cookie and records the Cookie header of every request */
let cookieSite = '';
let cookieServer: http.Server;
const cookieHits: Array<{ path: string; cookie: string }> = [];

test.beforeAll(async () => {
  fx = await startFixtureServers();
  mock = await startMockLlm();
  tg = await startFakeTelegram(BOT_TOKEN);
  cookieServer = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    cookieHits.push({ path, cookie: String(req.headers.cookie ?? '') });
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
    if (path === '/set') headers['set-cookie'] = 'task_cookie=set-during-task; Path=/';
    res.writeHead(200, headers);
    res.end(`<!doctype html><title>Price list</title><h1>Price list</h1><p>Blue Widget: $19.99</p><a href="/check">check</a>`);
  });
  const port = await new Promise<number>((r) => cookieServer.listen(0, '127.0.0.1', () => r((cookieServer.address() as AddressInfo).port)));
  cookieSite = `http://127.0.0.1:${port}`;
});
test.afterAll(async () => {
  await tg.close();
  await mock.close();
  await fx.close();
  cookieServer.closeAllConnections();
  await new Promise((r) => cookieServer.close(r));
});

interface Entry {
  profileId: string;
  profile: string;
  url: string;
  token: string;
}
const index = (a: App): Entry | null => {
  const f = join(a.userData, 'mcp.json');
  if (!existsSync(f)) return null;
  return (JSON.parse(readFileSync(f, 'utf8')) as { servers: Entry[] }).servers[0] ?? null;
};
const portOf = (e: Entry) => Number(/:(\d+)\/mcp$/.exec(e.url)![1]);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}
function post(port: number, headers: Record<string, string>, body: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = t;
        try {
          parsed = t ? JSON.parse(t) : '';
        } catch {
          /* text */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** An MCP client speaking Streamable HTTP directly. */
class HttpClient {
  sid = '';
  private n = 0;
  constructor(private readonly e: Entry) {}
  private h() {
    return { host: `127.0.0.1:${portOf(this.e)}`, authorization: `Bearer ${this.e.token}`, ...(this.sid ? { 'mcp-session-id': this.sid } : {}) };
  }
  async init(name: string) {
    const r = await post(portOf(this.e), this.h(), { jsonrpc: '2.0', id: ++this.n, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } } });
    expect(r.status).toBe(200);
    this.sid = String(r.headers['mcp-session-id']);
    expect((await post(portOf(this.e), this.h(), { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    return this;
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent: any }> {
    const r = await post(portOf(this.e), this.h(), { jsonrpc: '2.0', id: ++this.n, method: 'tools/call', params: { name, arguments: args } });
    expect(r.status).toBe(200);
    return r.body.result;
  }
}

/** The stdio launcher, run with Node like `claude mcp add` would run it (there with Electron as Node). */
function stdioClient(a: App) {
  const child = spawn(process.execPath, [join(ROOT, 'dist', 'mcp-stdio.js'), '--user-data', a.userData], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
  const lines: any[] = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  return {
    send: (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`),
    reply: async (id: number, timeout = 60_000) => {
      await expect.poll(() => lines.some((l) => l.id === id), { timeout }).toBe(true);
      return lines.find((l) => l.id === id);
    },
    close: () => child.stdin.end(),
  };
}

const profilePartition = (a: App) => (JSON.parse(readFileSync(join(a.userData, 'profiles.json'), 'utf8')) as { profiles: Array<{ partition: string }> }).profiles[0].partition;
const cookiesIn = (a: App, partition: string, url: string) =>
  a.app.evaluate(async ({ session }, p) => (await session.fromPartition(p.partition).cookies.get({ url: p.url })).map((c) => `${c.name}=${c.value}`), { partition, url }) as Promise<string[]>;
const mcpAudit = (a: App) => a.audit().filter((e) => e.type === 'mcp');

async function openSettings(a: App) {
  if (await a.ui.locator('[data-testid=settings-panel]').isVisible()) return;
  await a.ui.click('#open-settings');
  await expect(a.ui.locator('[data-testid=settings-panel]')).toBeVisible();
}
async function closeSettings(a: App) {
  if (await a.ui.locator('[data-testid=settings-panel]').isVisible()) await a.ui.click('#s-close');
}

test.describe('MCP server and phone approvals', () => {
  test.describe.configure({ mode: 'serial' });
  let a: App;
  test.beforeAll(async () => {
    a = await launch({ llmUrl: mock.url, telegramApi: tg.base, confirmTimeoutMs: 30_000 });
  });
  test.afterAll(async () => {
    await a?.close();
  });
  test.beforeEach(() => mock.reset());

  test('off by default: nothing listens and no mcp.json; Settings says Off', async () => {
    expect(index(a)).toBeNull();
    await openSettings(a);
    await expect(a.ui.locator('[data-testid=mcp-enabled]')).not.toBeChecked();
    await expect(a.ui.locator('[data-testid=mcp-status]')).toHaveText('Off: nothing is listening.');
    await expect(a.ui.locator('[data-testid=phone-enabled]')).not.toBeChecked();
  });

  test('turned on in Settings: mcp.json (0600) has a loopback URL and a 256-bit token; the connection command is shown', async () => {
    await openSettings(a);
    await a.ui.check('[data-testid=mcp-enabled]');
    await expect(a.ui.locator('[data-testid=mcp-status]')).toContainText('Serving on 127.0.0.1:');
    await expect.poll(() => index(a)).not.toBeNull();
    const e = index(a)!;
    expect(statSync(join(a.userData, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(e.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(e.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cmd = await a.ui.locator('[data-testid=mcp-command]').inputValue();
    expect(cmd).toMatch(/^claude mcp add --transport stdio --env ELECTRON_RUN_AS_NODE=1 guarded-browser -- \S+ \S+mcp-stdio\.js --user-data \S+ --profile /);
    expect(cmd).not.toContain(e.token);
    const hermes = await a.ui.locator('[data-testid=mcp-hermes]').inputValue();
    expect(hermes).toContain('mcp_servers:\n  guarded-browser:');
    expect(hermes).toContain('ELECTRON_RUN_AS_NODE: "1"');
    await closeSettings(a);
  });

  test('wrong token = 401, browser Origin = 403, Host other than 127.0.0.1:<port> = 403; each refusal is audited', async () => {
    const e = index(a)!;
    const port = portOf(e);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(port, { host: `127.0.0.1:${port}`, authorization: 'Bearer not-the-token' }, ping)).status).toBe(401);
    expect((await post(port, { host: `127.0.0.1:${port}` }, ping)).status).toBe(401);
    expect((await post(port, { host: `127.0.0.1:${port}`, authorization: `Bearer ${e.token}`, origin: 'http://evil.example' }, ping)).status).toBe(403);
    expect((await post(port, { host: `localhost:${port}`, authorization: `Bearer ${e.token}` }, ping)).status).toBe(403);
    await expect.poll(() => mcpAudit(a).filter((x) => x.status === 'refused').map((x) => x.http)).toEqual([401, 401, 403, 403]);
    expect(JSON.stringify(a.audit())).not.toContain(e.token);
  });

  test('browse_task through the stdio launcher: answer wrapped as untrusted; ran in a throwaway partition (profile cookie invisible, task cookie gone afterwards)', async () => {
    const partition = profilePartition(a);
    // the user's own logged-in state for this site, in the profile
    await a.app.evaluate(async ({ session }, p) => {
      await session.fromPartition(p.partition).cookies.set({ url: p.url, name: 'profile_cookie', value: 'users-login' });
    }, { partition, url: cookieSite });
    cookieHits.length = 0;
    mock.script('planner', sequence(
      { tool: 'navigate', args: { url: `${cookieSite}/set` }, delayMs: 1500 },
      { tool: 'navigate', args: { url: `${cookieSite}/check` } },
      { tool: 'finish', args: { answer: 'Blue Widget costs $19.99' } },
    ));
    const tabsBefore = await a.ui.locator('[data-testid=tab]').count();
    const c = stdioClient(a);
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-client', version: '1.0' } } });
    expect((await c.reply(1)).result.serverInfo.name).toBe('guarded-browser');
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await c.reply(2)).result.tools.map((t: { name: string }) => t.name)).toEqual(['browse_task', 'open_url', 'task_status', 'cancel_task']);
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browse_task', arguments: { task: `What does the Blue Widget cost on ${cookieSite}/set ?`, wait_seconds: 60 } } });
    // while it runs: a background tab marked as the client's, in a throwaway session
    const chip = a.ui.locator('[data-testid=tab-mcp]');
    await expect(chip).toHaveText('MCP: “e2e-client”', { timeout: 15_000 });
    await expect(chip).toHaveAttribute('title', /empty throwaway session/);
    const r = (await c.reply(3)).result;
    c.close();
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.status).toBe('finished');
    expect(r.structuredContent.answer).toBe('<untrusted-web-content source="guarded-browser">\nBlue Widget costs $19.99\n</untrusted-web-content>');
    expect(r.structuredContent.answer_is).toBe('untrusted web content');
    expect(r.structuredContent.audit_ref).toMatch(/^session-.+\.jsonl taskId=[0-9a-f]{8}$/);
    // isolation: the task never saw the profile's cookie; its own cookie worked inside the task...
    const set = cookieHits.find((h) => h.path === '/set')!;
    const check = cookieHits.find((h) => h.path === '/check')!;
    expect(set.cookie).not.toContain('profile_cookie');
    expect(check.cookie).toBe('task_cookie=set-during-task');
    // ...and is gone afterwards: not in the profile, and the task's partition was wiped
    expect(await cookiesIn(a, partition, cookieSite)).toEqual(['profile_cookie=users-login']);
    const sessionEvent = mcpAudit(a).find((x) => x.status === 'session' && x.session === 'ephemeral');
    expect(sessionEvent?.partition).toMatch(/^mcp-[0-9a-f-]{36}$/);
    expect(await cookiesIn(a, sessionEvent!.partition, cookieSite)).toEqual([]);
    expect(mcpAudit(a).some((x) => x.status === 'session destroyed' && x.partition === sessionEvent!.partition)).toBe(true);
    // the task's tab is closed, and nothing of it went into history
    await expect(a.ui.locator('[data-testid=tab]')).toHaveCount(tabsBefore);
    const history = JSON.stringify(await a.ui.evaluate(() => (window as any).gb.invoke('history:list', '')));
    expect(history).not.toContain(`${cookieSite}/set`);
    // audited with client, tool, task length, sites and the result status (never the token)
    const call = mcpAudit(a).find((x) => x.tool === 'browse_task' && x.status === 'finished');
    expect(call).toMatchObject({ client: 'e2e-client', taskChars: `What does the Blue Widget cost on ${cookieSite}/set ?`.length, sites: [], useProfile: false });
  });

  test('phone approvals: a confirmation in an MCP task shows on screen AND on the phone (same content); another chat does nothing; the right chat approves', async () => {
    await openSettings(a);
    await a.ui.fill('[data-testid=phone-token]', BOT_TOKEN);
    await a.ui.fill('[data-testid=phone-chat]', CHAT);
    await a.ui.check('[data-testid=phone-enabled]');
    await a.ui.click('[data-testid=phone-save]');
    await expect(a.ui.locator('[data-testid=phone-msg]')).toHaveText('saved');
    await expect(a.ui.locator('[data-testid=phone-token]')).toHaveAttribute('placeholder', /bot token saved/);
    const secret = join(a.profileDir(), 'phone-secret.json');
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(a.profileDir(), 'settings.json'), 'utf8')).not.toContain(BOT_TOKEN);
    // test message
    const sentBefore = tg.sent.length;
    await a.ui.click('[data-testid=phone-test]');
    await expect(a.ui.locator('[data-testid=phone-msg]')).toHaveText('test message sent: check Telegram');
    expect(tg.sent.length).toBe(sentBefore + 1);
    await closeSettings(a);

    mock.script('planner', sequence(
      { tool: 'navigate', args: { url: `${fx.site}/form.html` } },
      (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Name/), text: 'Bob Jones' } }),
      (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Email/), text: 'bob@example.com' } }),
      (c) => ({ tool: 'click', args: { ref: refFor(c, /Send message/) } }),
      { tool: 'finish', args: { answer: 'Message sent.' } },
    ));
    const client = await new HttpClient(index(a)!).init('e2e-phone-client');
    const before = tg.sent.length;
    const result = client.call('browse_task', { task: `Fill the contact form on ${fx.site}/form.html with name Bob Jones and email bob@example.com and send it`, wait_seconds: 90 });
    const modal = a.ui.locator('[data-testid=confirm-modal]');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(a.ui.locator('[data-testid=confirm-client]')).toContainText('e2e-phone-client');
    await expect.poll(() => tg.sent.length).toBeGreaterThan(before);
    const card = tg.sent.at(-1)!;
    expect(card.chat_id).toBe(CHAT);
    // the phone card carries exactly what the dialog shows
    const dialog = {
      action: await a.ui.locator('#c-action').innerText(),
      target: await a.ui.locator('#c-target').innerText(),
      destination: await a.ui.locator('[data-testid=confirm-destination]').innerText(),
      values: await a.ui.locator('#c-values code').allInnerTexts(),
      reasons: await a.ui.locator('#c-reasons li').allInnerTexts(),
      source: await a.ui.locator('[data-testid=confirm-source] strong').innerText(),
    };
    expect(dialog.destination).toBe(`${fx.site}/submit`);
    expect(dialog.values.join(' ')).toContain('bob@example.com');
    expect(card.text).toContain('Asked by MCP client: “e2e-phone-client”');
    expect(card.text).toContain(`Action: ${dialog.action}`);
    expect(card.text).toContain(`Target: ${dialog.target}`);
    expect(card.text).toContain(`Destination: ${dialog.destination}`);
    expect(card.text).toContain(`From: ${dialog.source}`);
    for (const v of dialog.values) expect(card.text).toContain(v);
    for (const r of dialog.reasons) expect(card.text).toContain(`• ${r}`);
    expect(card.reply_markup!.inline_keyboard[0].map((k) => k.text)).toEqual(['Approve', 'Deny']);
    // a press from another chat does nothing
    tg.press(card.message_id, 'Approve', { fromId: OTHER_CHAT });
    await expect.poll(() => a.audit().filter((x) => x.type === 'phone' && x.what === 'callback ignored').length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(modal).toBeVisible();
    expect(fx.siteHits.some((h) => h.method === 'POST' && h.url === '/submit')).toBe(false);
    // the configured chat approves: the dialog goes away, the submit goes through, the card is updated
    tg.press(card.message_id, 'Approve');
    await expect(modal).toBeHidden({ timeout: 15_000 });
    const r = await result;
    expect(r.structuredContent.status).toBe('finished');
    expect(fx.siteHits.some((h) => h.method === 'POST' && h.url === '/submit' && h.body.includes('bob%40example.com'))).toBe(true);
    await expect.poll(() => tg.edits.find((x) => x.message_id === card.message_id)?.text ?? '').toContain('— APPROVED (on the phone)');
    const confirmation = a.audit().find((x) => x.type === 'confirmation' && x.outcome === 'approve');
    expect(confirmation).toBeTruthy();
  });

  test('use_profile: true needs an approval naming the client and the task; Deny keeps it out, Approve runs with the profile cookie', async () => {
    const client = await new HttpClient(index(a)!).init('e2e-profile-client');
    const task = `Check the price on ${cookieSite}/check`;
    const denied = client.call('browse_task', { task, use_profile: true, wait_seconds: 60 });
    const modal = a.ui.locator('[data-testid=confirm-modal]');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toHaveAttribute('data-kind', 'mcp');
    await expect(a.ui.locator('[data-testid=confirm-client]')).toContainText('e2e-profile-client');
    await expect(a.ui.locator('#c-values')).toContainText(task);
    await expect(a.ui.locator('#c-action')).toContainText('logged-in profile');
    // it goes to the phone too
    await expect.poll(() => tg.sent.at(-1)?.text ?? '').toContain(task);
    await a.ui.click('[data-testid=confirm-deny]');
    const d = await denied;
    expect(d.isError).toBe(true);
    expect(d.structuredContent.status).toBe('denied');
    expect(mock.calls.filter((c) => c.role === 'planner')).toHaveLength(0);

    mock.script('planner', sequence({ tool: 'navigate', args: { url: `${cookieSite}/check` } }, { tool: 'finish', args: { answer: 'done' } }));
    cookieHits.length = 0;
    const approved = client.call('browse_task', { task, use_profile: true, wait_seconds: 60 });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    const approve = a.ui.locator('[data-testid=confirm-approve]');
    await expect(approve).toBeEnabled();
    await approve.click();
    const r = await approved;
    expect(r.structuredContent.status).toBe('finished');
    expect(cookieHits.find((h) => h.path === '/check')?.cookie).toContain('profile_cookie=users-login');
    expect(mcpAudit(a).some((x) => x.status === 'session' && x.session === 'profile')).toBe(true);
  });

  test('one MCP task at a time: a second call is "busy"; cancel_task stops the first; task_status reports it', async () => {
    mock.script('planner', sequence({ tool: 'navigate', args: { url: `${cookieSite}/set` }, delayMs: 6000 }, { tool: 'finish', args: { answer: 'late' } }));
    const c1 = await new HttpClient(index(a)!).init('e2e-busy-1');
    const c2 = await new HttpClient(index(a)!).init('e2e-busy-2');
    const first = await c1.call('browse_task', { task: `Look at ${cookieSite}/set`, wait_seconds: 0 });
    expect(first.structuredContent.status).toBe('running');
    const id = first.structuredContent.id as string;
    const second = await c2.call('browse_task', { task: `Look at ${cookieSite}/set` });
    expect(second.isError).toBe(true);
    expect(second.structuredContent.status).toBe('busy');
    expect(second.structuredContent.error).toMatch(/already running an agent task/);
    // another client cannot see or cancel it
    expect((await c2.call('task_status', { id })).structuredContent.status).toBe('unknown');
    expect((await c2.call('cancel_task', { id })).structuredContent.status).toBe('unknown');
    const cancelled = await c1.call('cancel_task', { id });
    expect(cancelled.structuredContent.status).toBe('stopped');
    expect((await c1.call('task_status', { id })).structuredContent.status).toBe('stopped');
    expect(mcpAudit(a).some((x) => x.tool === 'browse_task' && x.status === 'busy' && x.client === 'e2e-busy-2')).toBe(true);
  });

  test('open_url: the first per client session needs the user; later ones open directly through the normal navigation path', async () => {
    const c = await new HttpClient(index(a)!).init('e2e-open-client');
    const tabs = a.ui.locator('[data-testid=tab]');
    const n = await tabs.count();
    const opening = c.call('open_url', { url: `${fx.site}/article.html` });
    const modal = a.ui.locator('[data-testid=confirm-modal]');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(a.ui.locator('[data-testid=confirm-destination]')).toHaveText(`${fx.site}/article.html`);
    const approve = a.ui.locator('[data-testid=confirm-approve]');
    await expect(approve).toBeEnabled();
    await approve.click();
    expect((await opening).structuredContent.status).toBe('opened');
    await expect(tabs).toHaveCount(n + 1);
    expect((await c.call('open_url', { url: `${fx.site}/shop.html` })).structuredContent.status).toBe('opened');
    await expect(tabs).toHaveCount(n + 2);
    await expect(modal).toBeHidden();
    await expect.poll(() => a.audit().some((x) => x.type === 'navigation' && String(x.url).endsWith('/shop.html') && x.by === 'user'), { timeout: 15_000 }).toBe(true);
    // a new session asks again
    const c2 = await new HttpClient(index(a)!).init('e2e-open-client-2');
    const again = c2.call('open_url', { url: `${fx.site}/shop.html` });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await a.ui.click('[data-testid=confirm-deny]');
    expect((await again).structuredContent.status).toBe('denied');
  });

  test('Revoke token: the old token is refused; mcp.json carries the new one', async () => {
    const old = index(a)!;
    await openSettings(a);
    await a.ui.click('[data-testid=mcp-revoke]');
    await expect(a.ui.locator('[data-testid=mcp-msg]')).toContainText('token revoked');
    await expect.poll(() => index(a)?.token).not.toBe(old.token);
    const port = portOf(old);
    expect((await post(port, { host: `127.0.0.1:${port}`, authorization: `Bearer ${old.token}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    await new HttpClient(index(a)!).init('after-revoke');
    await closeSettings(a);
  });

  test('turned off: the port is closed (connection refused) and mcp.json is gone', async () => {
    const e = index(a)!;
    await openSettings(a);
    await a.ui.uncheck('[data-testid=mcp-enabled]');
    await expect(a.ui.locator('[data-testid=mcp-status]')).toHaveText('Off: nothing is listening.');
    await expect.poll(() => index(a)).toBeNull();
    await expect(post(portOf(e), { host: `127.0.0.1:${portOf(e)}`, authorization: `Bearer ${e.token}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await closeSettings(a);
  });
});

// "Allow other AI agents (MCP)" and phone approvals for ONE profile (item 3).
//
// The MCP server (src/main/mcp-server.ts) runs only while this profile's setting is on. Its four
// tools are run here, and only through the paths a user already has:
//   browse_task — a normal AgentTask (planner, reader, judge, policy, egress, confirmations) in a NEW
//                 background tab marked "MCP: <client>". By default that tab gets a fresh in-memory
//                 partition (no cookies or storage, behind this profile's egress proxy and webRequest
//                 rules), which is wiped and dropped when the task ends. use_profile: true runs in the
//                 profile's session instead, after an on-screen / phone approval naming the client
//                 and the task text. One MCP task at a time; any running task makes a call "busy".
//   open_url    — a new tab through the user-navigation path; the first per client session is approved.
//   task_status / cancel_task — only for tasks the same client session started.
// Every confirmation goes to the human (dialog, and phone if configured): the MCP client has no way
// to see or answer one. Every MCP call is audited (client, tool, task length, sites, result status).

import { app, clipboard, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ApprovalHub } from '../../core/approval';
import { atomicWriteFile } from '../../core/persist';
import { McpTaskRegistry, sitesToOrigins, taskView, toolResult, type BrowseArgs, type McpSession, type McpTaskRecord, type ToolBackend, type ToolResult } from '../../core/mcp';
import { originOf, originsInTask } from '../../core/policy';
import { saveSettings } from '../../core/config';
import { McpHttpServer, MCP_PATH } from '../mcp-server';
import { BOT_TOKEN_RE, CHAT_ID_RE, TelegramChannel } from '../telegram';
import { testEnv } from '../test-hooks';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';
import type { McpIndexEntry } from './mcp-index';

export const PHONE_SECRET_FILE = 'phone-secret.json';


const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const audit = (detail: Record<string, unknown>) => rt.audit.write('mcp', detail);
  const registry = new McpTaskRegistry(() => randomUUID());
  const backend: ToolBackend = { call: (s, name, args) => callTool(s, name, args) };
  const server = new McpHttpServer(backend, {
    rejected: (status, reason) => audit({ tool: '-', status: 'refused', http: status, reason }),
    session: (s) => audit({ tool: 'initialize', client: s.client, clientVersion: s.clientVersion, protocol: s.protocolVersion, status: 'connected' }),
  });
  /** the use_profile / open_url approval waiting for an answer, per MCP task record */
  const approvals = new Map<string, string>();

  // ------------------------------------------------------------------ phone approvals

  const secretFile = join(rt.profileDir, PHONE_SECRET_FILE);
  function readToken(): string {
    try {
      const t = (JSON.parse(readFileSync(secretFile, 'utf8')) as { botToken?: unknown }).botToken;
      return typeof t === 'string' && BOT_TOKEN_RE.test(t) ? t : '';
    } catch {
      return '';
    }
  }
  const hub = new ApprovalHub(
    { answer: (id, o) => rt.broker.answer(id, o), isPending: (id) => rt.broker.isPending(id) },
    // MCP-only (default): requests naming an MCP client; 'all': also every request during an agent task
    (req) => rt.settings.phone.enabled && (!!req.client || (rt.settings.phone.scope === 'all' && !!rt.current)),
  );
  rt.broker.observe(hub);
  const channelFor = (token: string, chatId: string) =>
    new TelegramChannel({
      token,
      chatId,
      apiBase: testEnv('GUARDED_TEST_TELEGRAM_API'),
      onAnswer: (id, o) => hub.fromChannel(id, o),
      isPending: (id) => rt.broker.isPending(id),
      audit: (d) => rt.audit.write('phone', d),
    });
  function applyPhone() {
    const p = rt.settings.phone;
    const token = readToken();
    hub.setChannel(p.enabled && token && p.chatId ? channelFor(token, p.chatId) : null);
  }
  function phoneState() {
    const p = rt.settings.phone;
    return { enabled: p.enabled, scope: p.scope, chatId: p.chatId, hasToken: !!readToken(), active: hub.active };
  }

  // ------------------------------------------------------------------ MCP server

  const launcher = () => join(app.getAppPath(), 'dist', 'mcp-stdio.js');
  const profileName = () => rt.ctx.profile().name;
  function command(): string {
    return `claude mcp add --transport stdio --env ELECTRON_RUN_AS_NODE=1 guarded-browser -- ${q(process.execPath)} ${q(launcher())} --user-data ${q(app.getPath('userData'))} --profile ${q(profileName())}`;
  }
  function hermesSnippet(): string {
    return [
      'mcp_servers:',
      '  guarded-browser:',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${[launcher(), '--user-data', app.getPath('userData'), '--profile', profileName()].map((x) => JSON.stringify(x)).join(', ')}]`,
      '    env:',
      '      ELECTRON_RUN_AS_NODE: "1"',
    ].join('\n');
  }
  function state() {
    const t = registry.active();
    return {
      enabled: rt.settings.mcp.enabled,
      running: server.running,
      port: server.running ? server.port : null,
      command: command(),
      hermes: hermesSnippet(),
      sessions: server.sessionList().map((s) => ({ client: s.client, version: s.clientVersion })),
      task: t ? { client: t.client, status: t.status } : null,
    };
  }
  const push = () => rt.sendUI('mcp', state());

  async function applyMcp() {
    if (rt.settings.mcp.enabled && !server.running) {
      await server.start();
      audit({ tool: '-', status: 'server started', port: server.port });
    } else if (!rt.settings.mcp.enabled && server.running) {
      // turning MCP off ends what MCP started
      if (rt.current?.mcp) rt.stopTask();
      for (const id of approvals.values()) rt.broker.answer(id, 'deny');
      await server.stop();
      audit({ tool: '-', status: 'server stopped' });
    }
    rt.ctx.mcpChanged();
    push();
  }

  // ------------------------------------------------------------------ tools

  async function callTool(s: McpSession, name: string, args: unknown): Promise<ToolResult> {
    switch (name) {
      case 'browse_task':
        return browseTask(s, args as BrowseArgs);
      case 'open_url':
        return openUrl(s, (args as { url: string }).url);
      case 'task_status': {
        const a = args as { id: string; wait_seconds?: number };
        const rec = registry.get(a.id, s.id);
        if (!rec) {
          audit({ client: s.client, tool: name, status: 'unknown task' });
          return toolResult({ status: 'unknown', error: 'no task with that id was started by this session' }, true);
        }
        await registry.wait(rec.id, (a.wait_seconds ?? 0) * 1000);
        audit({ client: s.client, tool: name, status: rec.status });
        return toolResult(taskView(rec));
      }
      case 'cancel_task': {
        const rec = registry.get((args as { id: string }).id, s.id);
        if (!rec) {
          audit({ client: s.client, tool: name, status: 'unknown task' });
          return toolResult({ status: 'unknown', error: 'no task with that id was started by this session' }, true);
        }
        if (rec.status === 'awaiting-approval') {
          const cid = approvals.get(rec.id);
          if (cid) rt.broker.answer(cid, 'deny');
          registry.update(rec.id, { status: 'cancelled' });
        } else if (rec.status === 'running' && rt.current?.mcp?.record === rec.id) {
          rt.stopTask();
          await registry.wait(rec.id, 10_000);
        }
        audit({ client: s.client, tool: name, status: rec.status });
        return toolResult(taskView(rec));
      }
    }
    return toolResult({ status: 'error', error: 'unknown tool' }, true);
  }

  async function browseTask(s: McpSession, a: BrowseArgs): Promise<ToolResult> {
    const sites = sitesToOrigins(a.sites);
    const base = { client: s.client, tool: 'browse_task', taskChars: a.task.length, sites, useProfile: a.use_profile === true };
    const rec = registry.begin(s, !!rt.current);
    if (rec === 'busy') {
      audit({ ...base, status: 'busy' });
      return toolResult({ status: 'busy', error: 'Guarded Browser is already running an agent task (one at a time per profile). Try again when it has finished.' }, true);
    }
    void runTask(s, rec, a, sites).catch((e) => registry.update(rec.id, { status: 'failed', answer: `Task failed: ${String((e as Error).message ?? e).slice(0, 200)}` }));
    push();
    await registry.wait(rec.id, (a.wait_seconds ?? 240) * 1000);
    audit({ ...base, status: rec.status, ...(rec.auditRef ? { auditRef: rec.auditRef } : {}) });
    return toolResult(taskView(rec), rec.status !== 'finished' && rec.status !== 'running' && rec.status !== 'awaiting-approval');
  }

  async function runTask(s: McpSession, rec: McpTaskRecord, a: BrowseArgs, sites: string[]) {
    const origins = [...new Set([...originsInTask(a.task), ...sites])];
    const useProfile = a.use_profile === true;
    if (useProfile) {
      registry.update(rec.id, { status: 'awaiting-approval' });
      const pending = rt.broker.request({
        id: 'm',
        kind: 'mcp',
        client: s.client,
        action: 'run an MCP client task in your logged-in profile (your cookies, logins and site data)',
        target: `profile “${rt.ctx.profile().name}”`,
        values: [
          { field: 'task (from the MCP client)', value: a.task, label: 'untrusted', provenance: [], taintIds: [] },
          { field: 'sites', value: origins.join(' ') || '(none named)', label: 'untrusted', provenance: [], taintIds: [] },
        ],
        reasons: [
          `the MCP client “${s.client}” asked to run this task with your logged-in sessions instead of an empty one`,
          'every action the task takes is still confirmed here as usual; Deny keeps the client out of your profile',
        ],
      });
      const cid = rt.broker.list().at(-1)?.id;
      if (cid) approvals.set(rec.id, cid);
      const outcome = await pending;
      approvals.delete(rec.id);
      audit({ client: s.client, tool: 'browse_task', approval: 'use_profile', outcome });
      if (rec.status === 'cancelled') return;
      if (outcome !== 'approve') {
        registry.update(rec.id, { status: 'denied' });
        return push();
      }
      if (rt.current) {
        registry.update(rec.id, { status: 'failed', answer: 'another agent task started while the approval was pending' });
        return push();
      }
      registry.update(rec.id, { status: 'running' });
    }

    let ses: Session | undefined;
    let partition: string | undefined;
    if (!useProfile) {
      // a fresh in-memory partition (no `persist:`): nothing from the profile, nothing kept after
      partition = `mcp-${randomUUID()}`;
      ses = session.fromPartition(partition);
      await ses.setProxy({ proxyRules: `127.0.0.1:${rt.proxyPort}`, proxyBypassRules: '<-loopback>' });
      rt.setupEgress(ses);
    }
    const tab = rt.tabs.create('about:blank', { background: true, session: ses, mcpClient: s.client });
    audit({ client: s.client, tool: 'browse_task', status: 'session', session: useProfile ? 'profile' : 'ephemeral', ...(partition ? { partition } : {}), tab: tab.id });
    const cleanup = async () => {
      if (!ses) return;
      rt.tabs.silentCloseId = tab.id;
      rt.tabs.close(tab.id);
      rt.tabs.silentCloseId = null;
      await ses.clearStorageData().catch(() => undefined);
      await ses.clearCache().catch(() => undefined);
      await ses.clearAuthCache().catch(() => undefined);
      await ses.closeAllConnections().catch(() => undefined);
      audit({ client: s.client, tool: 'browse_task', status: 'session destroyed', partition });
    };
    try {
      await rt.startTask(a.task, origins, {
        tab,
        mcp: { client: s.client, record: rec.id },
        onEnd: (r) =>
          void cleanup().finally(() => {
            registry.update(rec.id, { status: rec.status === 'cancelled' ? 'cancelled' : r.status, answer: r.answer ?? '', auditRef: `${basename(rt.audit.file)} taskId=${r.taskId}` });
            push();
          }),
      });
    } catch (e) {
      await cleanup();
      registry.update(rec.id, { status: 'failed', answer: `Task did not start: ${String((e as Error).message).slice(0, 200)}` });
      push();
    }
  }

  async function openUrl(s: McpSession, url: string): Promise<ToolResult> {
    const host = originOf(url);
    const base = { client: s.client, tool: 'open_url', url: url.slice(0, 300) };
    if (!host) {
      audit({ ...base, status: 'invalid' });
      return toolResult({ status: 'invalid', error: 'url must be http(s)' }, true);
    }
    if (!s.openUrlApproved) {
      const outcome = await rt.broker.request({
        id: 'm',
        kind: 'mcp',
        client: s.client,
        action: 'open a URL from an MCP client in a new tab',
        target: host,
        destination: url,
        values: [{ field: 'url', value: url, label: 'untrusted', provenance: [], taintIds: [] }],
        reasons: [
          `first open_url from the MCP client “${s.client}” in this session; later ones from the same session open without asking`,
          'the tab opens as if you had typed the address: dangerous-site warnings apply, nothing from the page goes back to the client',
        ],
      });
      if (outcome !== 'approve') {
        audit({ ...base, status: 'denied', outcome });
        return toolResult({ status: 'denied', error: 'the user did not approve opening this URL' }, true);
      }
      s.openUrlApproved = true;
    }
    rt.openUserUrl(url, !!rt.current);
    audit({ ...base, status: 'opened' });
    return toolResult({ status: 'opened', url });
  }

  // ------------------------------------------------------------------ chrome IPC

  on('mcp:state', () => state());
  on('mcp:set', async (_e, enabled: unknown) => {
    rt.settings.mcp = { enabled: enabled === true };
    saveSettings(rt.settingsFile, rt.settings);
    await applyMcp();
    return state();
  });
  on('mcp:revoke', () => {
    server.rotateToken();
    audit({ tool: '-', status: 'token revoked' });
    rt.ctx.mcpChanged();
    push();
    return state();
  });
  on('mcp:copy', () => {
    clipboard.writeText(command());
    return { ok: true };
  });
  on('phone:state', () => phoneState());
  on('phone:set', (_e, patch: unknown) => {
    const p = (patch ?? {}) as { enabled?: unknown; scope?: unknown; chatId?: unknown; token?: unknown; clearToken?: unknown };
    const chatId = p.chatId === undefined ? rt.settings.phone.chatId : String(p.chatId).trim();
    if (chatId && !CHAT_ID_RE.test(chatId)) return { ok: false, error: 'the chat id is your numeric Telegram user id (digits only)' };
    if (typeof p.token === 'string' && p.token.trim()) {
      const token = p.token.trim();
      if (!BOT_TOKEN_RE.test(token)) return { ok: false, error: 'that does not look like a bot token from BotFather (digits:letters)' };
      atomicWriteFile(secretFile, JSON.stringify({ botToken: token }) + '\n', { mode: 0o600 });
    } else if (p.clearToken === true) rmSync(secretFile, { force: true });
    rt.settings.phone = { enabled: p.enabled === undefined ? rt.settings.phone.enabled : p.enabled === true, scope: p.scope === 'all' ? 'all' : p.scope === 'mcp' ? 'mcp' : rt.settings.phone.scope, chatId };
    saveSettings(rt.settingsFile, rt.settings);
    applyPhone();
    rt.audit.write('phone', { what: 'settings', enabled: rt.settings.phone.enabled, scope: rt.settings.phone.scope, hasToken: !!readToken(), hasChat: !!chatId });
    return { ok: true, ...phoneState() };
  });
  on('phone:test', async () => {
    const token = readToken();
    if (!token || !rt.settings.phone.chatId) return { ok: false, error: 'save a bot token and your chat id first' };
    const ch = channelFor(token, rt.settings.phone.chatId);
    const r = await ch.sendTest(rt.ctx.profile().name);
    ch.close();
    rt.audit.write('phone', { what: 'test message', ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    return r;
  });

  return {
    async start() {
      applyPhone();
      await applyMcp();
    },
    info(): McpIndexEntry | null {
      if (!server.running) return null;
      return { profileId: rt.ctx.profile().id, profile: rt.ctx.profile().name, url: `http://127.0.0.1:${server.port}${MCP_PATH}`, token: server.token };
    },
    async dispose() {
      hub.setChannel(null);
      rt.broker.observe(null);
      await server.stop();
    },
  };
}

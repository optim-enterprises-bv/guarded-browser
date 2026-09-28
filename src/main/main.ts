// Electron main process: window, tabs, agent wiring, egress layers, confirmation broker, IPC.

import { app, BrowserWindow, ipcMain, session, type Session } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentTask } from '../core/agent';
import { AuditLog } from '../core/audit';
import { loadSettings, saveSettings, type Role, type Settings } from '../core/config';
import { EgressController, hostKey, startProxy, type ProxyHandle } from '../core/egress';
import { NullGuard, TransformersGuard } from '../core/guard';
import { LlmClient } from '../core/llm';
import { originOf } from '../core/policy';
import type { ConfirmOutcome, Guard } from '../core/types';
import { ConfirmBroker } from './confirm';
import { ElectronDriver, TabManager, type Tab } from './tabs';

if (process.env.GUARDED_USER_DATA) app.setPath('userData', process.env.GUARDED_USER_DATA);

/** TEST ONLY. Bypasses the policy engine and judge so tests can show the egress layer holds alone. */
const POLICY_DISABLED = process.env.GUARDED_UNSAFE_DISABLE_POLICY === '1';

let settings: Settings;
let settingsFile = '';
let audit: AuditLog;
let egress: EgressController;
let proxy: ProxyHandle;
let guard: Guard;
let broker: ConfirmBroker;
let tabs: TabManager;
let win: BrowserWindow;
let current: { task: AgentTask; tab: Tab } | null = null;
const fallbackActive: Partial<Record<Role, string>> = {};
/** webRequest-layer flows the user denied during the current task (not asked again) */
let deniedFlows = new Set<string>();
const inflightFlows = new Map<string, Promise<ConfirmOutcome>>();

function sendUI(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function egressState() {
  return { mode: egress.mode, allowed: egress.allowedHosts(), blocked: egress.blockedHosts() };
}

function state() {
  return {
    tabs: tabs?.list() ?? [],
    guard: { status: guard.status(), detail: guard.statusDetail() },
    egress: egressState(),
    task: current ? { id: current.task.id, text: current.task.task } : null,
    fallback: fallbackActive,
    confirmations: broker.list(),
    policyDisabled: POLICY_DISABLED,
    auditFile: audit.file,
    settingsFile,
  };
}

const llm = (role: Role) =>
  new LlmClient(role, () => settings.models[role], (r, active, reason) => {
    const was = fallbackActive[role];
    if (active) fallbackActive[r as Role] = reason;
    else delete fallbackActive[r as Role];
    if (!!was !== active) {
      if (active) audit.write('fallback', { role: r, reason });
      sendUI('fallback', fallbackActive);
    }
  });

function setupEgress(ses: Session) {
  // Layer 2: content filter on full URL + body. Blocks tainted values leaving without a confirmed flow.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!/^(https?|wss?):/i.test(d.url)) return cb({});
    const body = (d.uploadData ?? []).map((u) => (u.bytes ? Buffer.from(u.bytes).toString('utf8') : '')).join('');
    const { unconfirmed, host } = egress.checkRequest(d.url, d.method, body);
    if (!unconfirmed.length) return cb({});
    const ids = unconfirmed.map((v) => v.id).sort();
    const key = `${ids.join(',')}|${host}`;
    const base = { host, method: d.method, url: d.url.slice(0, 500), taintIds: ids };
    if (deniedFlows.has(key)) {
      egress.auditWebRequest({ ...base, decision: 'block', reason: 'flow already denied in this task' });
      return cb({ cancel: true });
    }
    let p = inflightFlows.get(key);
    if (!p) {
      p = broker.request({
        id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind: 'egress',
        action: `${d.method} request (${d.resourceType})`,
        target: host,
        destination: d.url,
        values: unconfirmed.map((v) => ({ value: v.value, label: v.kind === 'untrusted' ? 'untrusted' : 'trusted', provenance: v.provenance, taintIds: [v.id], field: v.kind })),
        reasons: [`egress filter: this request carries ${unconfirmed.length} tracked value(s) to ${host} with no confirmed flow`],
      });
      inflightFlows.set(key, p);
      void p.finally(() => inflightFlows.delete(key));
    }
    void p.then((o) => {
      if (o === 'approve') {
        egress.confirmFlow(ids, d.url);
        egress.auditWebRequest({ ...base, decision: 'allow', reason: 'user confirmed this flow' });
        cb({});
      } else {
        deniedFlows.add(key);
        egress.auditWebRequest({ ...base, decision: 'block', reason: `tainted value in request, confirmation ${o}` });
        if (o === 'stop') stopTask();
        cb({ cancel: true });
      }
    });
  });

  ses.on('will-download', (_e, item) => {
    item.setSavePath(join(app.getPath('downloads'), item.getFilename()));
    if (!current) {
      audit.write('egress', { layer: 'download', decision: 'log', host: hostKey(item.getURL()), method: 'GET', url: item.getURL(), reason: 'manual download' });
      return;
    }
    item.pause();
    void broker
      .request({ id: `d${Date.now().toString(36)}`, kind: 'download', action: 'file download', target: item.getFilename(), destination: item.getURL(), values: [], reasons: ['file downloads during an agent task are always confirmed'] })
      .then((o) => {
        audit.write('egress', { layer: 'download', decision: o === 'approve' ? 'allow' : 'block', host: hostKey(item.getURL()), method: 'GET', url: item.getURL(), reason: `confirmation ${o}` });
        if (o === 'approve') item.resume();
        else item.cancel();
      });
  });

  // No camera / mic / geolocation / notifications etc. for pages in v1.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

function setupTab(tab: Tab) {
  const wc = tab.wc;
  wc.setWindowOpenHandler(({ url }) => {
    if (current?.tab === tab) {
      audit.write('navigation', { url, by: 'page', blocked: true, reason: 'popup during agent task' });
    } else if (originOf(url)) {
      tabs.create(url);
    }
    return { action: 'deny' };
  });
  // Page-initiated navigations and server redirects during a task: new origins need confirmation.
  const guardNav = (e: Electron.Event<{ url: string; isMainFrame: boolean }>, kind: 'navigation' | 'redirect') => {
    const t = current;
    if (!t || t.tab !== tab || !e.isMainFrame) return;
    const origin = originOf(e.url);
    if (!origin) return;
    if (t.task.allowedOrigins.has(origin)) return;
    e.preventDefault();
    audit.write('policy', { taskId: t.task.id, action: `page-initiated ${kind}`, decision: 'confirm', destination: e.url, reasons: [`page tried to leave for a new origin ${origin}`] });
    const url = e.url;
    void broker
      .request({
        id: `n${Date.now().toString(36)}`,
        kind: 'redirect',
        action: `page-initiated ${kind}`,
        target: origin,
        destination: url,
        values: [{ field: 'url', value: url, label: 'untrusted', provenance: [{ source: 'snapshot', url: wc.getURL(), timestamp: new Date().toISOString(), note: `${kind} chosen by the page` }], taintIds: egress.idsIn(url) }],
        reasons: [`the page (not the planner) is navigating to a new origin not mentioned in the task: ${origin}`],
      })
      .then((o) => {
        audit.write('confirmation', { taskId: t.task.id, action: `page-initiated ${kind}`, destination: url, outcome: o });
        if (o === 'approve') {
          t.task.approveOrigin(origin);
          egress.confirmFlow(egress.idsIn(url), url);
          void wc.loadURL(url).catch(() => undefined);
        } else if (o === 'stop') stopTask();
      });
  };
  wc.on('will-navigate', (e) => guardNav(e, 'navigation'));
  wc.on('will-redirect', (e) => guardNav(e, 'redirect'));
  wc.on('did-navigate', (_e, url) => {
    audit.write('navigation', { url, tab: tab.id, by: current?.tab === tab ? 'agent-task' : 'user' });
  });
}

function stopTask() {
  if (!current) return;
  current.task.stop();
  broker.denyAll('stop');
}

async function startTask(text: string) {
  if (current) throw new Error('a task is already running');
  const tab = tabs.active();
  if (!tab) throw new Error('no active tab');
  deniedFlows = new Set();
  const task = new AgentTask(text, {
    planner: llm('planner'),
    reader: llm('reader'),
    judge: llm('judge'),
    guard,
    driver: new ElectronDriver(tab),
    audit,
    confirm: (req) => broker.request(req),
    settings: () => settings.agent,
    egress,
    policyDisabled: POLICY_DISABLED,
    onGuardFlag: (_url, n) => {
      tab.guardFlags += n;
      sendUI('tabs', tabs.list());
    },
    onUpdate: (u) => sendUI('agent:update', u),
  });
  current = { task, tab };
  sendUI('agent:update', { taskId: task.id, status: 'started', step: 0 });
  void task
    .run()
    .then((r) => sendUI('agent:done', r))
    .catch((e) => sendUI('agent:done', { taskId: task.id, status: 'failed', answer: String(e) }))
    .finally(() => {
      broker.denyAll('deny');
      current = null;
      sendUI('state', state());
    });
  return task.id;
}

function registerIpc() {
  ipcMain.handle('state:get', () => state());
  ipcMain.handle('tabs:new', (_e, url?: string) => tabs.create(url || 'about:blank').id);
  ipcMain.handle('tabs:close', (_e, id: number) => tabs.close(id));
  ipcMain.handle('tabs:activate', (_e, id: number) => tabs.activate(id));
  ipcMain.handle('nav:go', (_e, input: string) => {
    const t = tabs.active();
    if (!t) return;
    let url = input.trim();
    if (!/^[a-z]+:/i.test(url)) url = /^[\w.-]+(:\d+)?(\/|$)/.test(url) ? `http://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
    void t.wc.loadURL(url).catch(() => undefined);
  });
  ipcMain.handle('nav:back', () => tabs.active()?.wc.navigationHistory.goBack());
  ipcMain.handle('nav:forward', () => tabs.active()?.wc.navigationHistory.goForward());
  ipcMain.handle('nav:reload', () => tabs.active()?.wc.reload());
  ipcMain.handle('agent:start', (_e, text: string) => startTask(String(text)));
  ipcMain.handle('agent:stop', () => stopTask());
  ipcMain.handle('confirm:answer', (_e, id: string, outcome: ConfirmOutcome) => {
    if (['approve', 'deny', 'stop'].includes(outcome)) broker.answer(id, outcome);
    if (outcome === 'stop') stopTask();
  });
  ipcMain.handle('egress:allow', (_e, host: string) => {
    if (!current) return;
    egress.allowHost(host);
    audit.write('egress', { taskId: current.task.id, layer: 'proxy', decision: 'allow', host, method: '-', reason: 'user allowed host for this task' });
  });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_e, s: Settings) => {
    settings = s;
    saveSettings(settingsFile, s);
    egress.setDenylist(s.egress.denylist);
    return true;
  });
  ipcMain.handle('audit:recent', () => audit.read().slice(-400));
}

app.whenReady().then(async () => {
  const ud = app.getPath('userData');
  settingsFile = join(ud, 'settings.json');
  settings = loadSettings(settingsFile);
  if (process.env.GUARDED_CONFIRM_TIMEOUT_MS) settings.agent.confirmTimeoutMs = Number(process.env.GUARDED_CONFIRM_TIMEOUT_MS);
  audit = new AuditLog(join(ud, 'audit'));
  audit.onEvent((e) => sendUI('audit', e));
  egress = new EgressController(settings.egress.denylist, (e) => audit.write('egress', { taskId: current?.task.id, ...e }));
  egress.onChange(() => sendUI('egress', egressState()));
  proxy = await startProxy(egress);

  const ses = session.fromPartition('persist:guarded');
  // Everything from the guarded profile goes through the proxy, loopback included.
  await ses.setProxy({ proxyRules: `127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
  setupEgress(ses);

  const guardOff = process.env.GUARDED_GUARD === 'off' || !settings.guard.enabled;
  if (guardOff) {
    guard = new NullGuard(process.env.GUARDED_GUARD === 'off' ? 'guard unavailable: disabled by GUARDED_GUARD=off' : 'guard unavailable: disabled in settings');
  } else {
    const g = new TransformersGuard({ ...settings.guard, enabled: true, cacheDir: process.env.GUARDED_MODEL_CACHE ?? join(homedir(), '.cache', 'guarded-browser', 'models') });
    guard = g;
    void g.load().then(() => {
      audit.write('guard', { what: 'load', status: g.status(), detail: g.statusDetail() });
      sendUI('state', state());
    });
  }

  broker = new ConfirmBroker(sendUI, () => settings.agent.confirmTimeoutMs);
  registerIpc();

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: 'Guarded Browser',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  tabs = new TabManager(win, ses, () => sendUI('tabs', tabs.list()), setupTab);
  tabs.create(process.env.GUARDED_START_URL || 'about:blank');
  sendUI('state', state());
});

app.on('window-all-closed', () => {
  void proxy?.close();
  app.quit();
});

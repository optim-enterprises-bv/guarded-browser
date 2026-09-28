// Electron main process: window, tabs, agent wiring, egress layers, confirmation broker, IPC.

import { app, BrowserWindow, ipcMain, session, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { AgentTask } from '../core/agent';
import { AuditLog } from '../core/audit';
import { loadSettings, saveSettings, type Role, type Settings } from '../core/config';
import { EgressController, hostKey, startProxy, type ProxyHandle } from '../core/egress';
import { NullGuard, TransformersGuard } from '../core/guard';
import { LlmClient } from '../core/llm';
import { originOf, originsInTask } from '../core/policy';
import { HostSet, ReputationDb, normalizeHost, safeBrowsingLookup, type FeedBuilder } from '../core/reputation';
import { Worker } from 'node:worker_threads';
import type { ConfirmOutcome, ConfirmRequest, Guard, PolicyResult } from '../core/types';
import { ConfirmBroker } from './confirm';
import { ElectronDriver, TabManager, type Tab } from './tabs';

if (process.env.GUARDED_USER_DATA) app.setPath('userData', process.env.GUARDED_USER_DATA);

/** TEST ONLY. Bypasses the policy engine and judge so tests can show the egress layer holds alone. */
const POLICY_DISABLED = process.env.GUARDED_UNSAFE_DISABLE_POLICY === '1' && process.env.GUARDED_TEST === '1' && !app.isPackaged;

// No speculative DNS / connections: with a proxy configured these are the remaining ways a page
// could make the network layer touch a host it names.
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-features', 'Prerender2,SpeculationRulesPrefetchFuture,NoStatePrefetchHoldback,PreconnectToSearch,LoadingPredictorPrefetch');

let settings: Settings;
let settingsFile = '';
let audit: AuditLog;
let egress: EgressController;
let proxy: ProxyHandle;
let guard: Guard;
let broker: ConfirmBroker;
let tabs: TabManager;
let win: BrowserWindow;
let reputation: ReputationDb;
let current: { task: AgentTask; tab: Tab } | null = null;
/** reputation interstitials waiting for Go back / Proceed anyway */
const interstitials = new Map<string, { url: string; host: string; feed: string }>();
const PROCEED_PREFIX = 'https://guarded-browser.invalid/proceed?t=';
const sbCache = new Map<string, { verdict: string | null; at: number }>();
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
    reputation: reputationState(),
    auditFile: audit.file,
    settingsFile,
  };
}

function reputationState() {
  return {
    enabled: settings.reputation.enabled,
    total: reputation.totalEntries(),
    feeds: reputation.status(),
    localBlockFile: reputation.localBlockFile,
    localAllowFile: reputation.localAllowFile,
    safeBrowsing: settings.reputation.safeBrowsing.enabled,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Full-page interstitial for a listed host. Proceed goes through a browser-chrome confirmation. */
function showInterstitial(wc: WebContents, url: string, host: string, feed: string, matched: string) {
  const token = randomBytes(16).toString('hex');
  interstitials.set(token, { url, host, feed });
  const agent = !!current;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Blocked: ${esc(host)}</title>
<style>body{font-family:system-ui,sans-serif;background:#7f1d1d;color:#fff;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.box{max-width:640px;padding:32px}code{background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;word-break:break-all}
button{font:inherit;padding:8px 16px;margin-right:8px;border-radius:6px;border:0;cursor:pointer}button:disabled{opacity:.5;cursor:default}</style></head>
<body><div class="box"><h1>Dangerous site blocked</h1>
<p><code>${esc(host)}</code> is listed as malicious by <b>${esc(feed)}</b> (matched <code>${esc(matched)}</code>).</p>
<p>Requested URL: <code>${esc(url.slice(0, 300))}</code></p>
<p>Threat feeds list phishing and malware hosts. A listing can be wrong, but visiting is risky.</p>
${agent ? '<p><b>An agent task is running: the agent can never override a reputation block.</b></p>' : ''}
<button onclick="history.back()">Go back</button>
<button id="proceed" ${agent ? 'disabled' : ''} onclick="location.href='${PROCEED_PREFIX}${token}'">Proceed anyway (asks for confirmation)</button>
</div></body></html>`;
  setImmediate(() => void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined));
}

function handleProceed(token: string) {
  const it = interstitials.get(token);
  if (!it) return;
  if (current) {
    audit.write('egress', { taskId: current.task.id, layer: 'reputation', decision: 'block', host: it.host, method: 'GET', url: it.url, reason: 'proceed refused: an agent task is running (the agent can never override a reputation block)', feed: it.feed });
    return;
  }
  void broker
    .request({
      id: `r${Date.now().toString(36)}`,
      kind: 'reputation',
      action: 'visit a host listed as malicious',
      target: it.host,
      destination: it.url,
      values: [],
      reasons: [`${it.host} is listed by ${it.feed}`, 'you chose Proceed anyway on the interstitial'],
    })
    .then((o) => {
      audit.write('egress', { layer: 'reputation', decision: o === 'approve' ? 'allow' : 'block', host: it.host, method: 'GET', url: it.url, reason: `user override via interstitial: ${o}`, feed: it.feed });
      if (o !== 'approve') return;
      egress.overrideReputation(it.host);
      interstitials.delete(token);
      const t = tabs.active();
      void t?.wc.loadURL(it.url).catch(() => undefined);
    });
}

async function safeBrowsingVerdict(url: string): Promise<string | null> {
  const sb = settings.reputation.safeBrowsing;
  const key = sb.enabled ? process.env[sb.apiKeyEnv] : undefined;
  if (!key) return null;
  const host = normalizeHost(url);
  const c = sbCache.get(host);
  if (c && Date.now() - c.at < 30 * 60_000) return c.verdict;
  try {
    const verdict = await safeBrowsingLookup(url, key);
    sbCache.set(host, { verdict, at: Date.now() });
    return verdict;
  } catch (e) {
    audit.write('error', { where: 'safe-browsing', error: (e as Error).message });
    return null;
  }
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
    // Reputation first: top-level navigations get an interstitial, subresources are dropped silently.
    const rep = egress.reputationCheck(d.url);
    if (rep) {
      const top = d.resourceType === 'mainFrame';
      egress.auditReputation(rep, d.method, d.url, 'webrequest', top ? 'interstitial' : 'blocked subresource');
      if (top && d.webContents) showInterstitial(d.webContents, d.url, rep.host, rep.feed ?? '?', rep.matched ?? rep.host);
      return cb({ cancel: true });
    }
    if (d.resourceType === 'mainFrame' && settings.reputation.safeBrowsing.enabled) {
      void safeBrowsingVerdict(d.url).then((v) => {
        if (!v) return void egressCheck(d).then((cancel) => cb({ cancel }), () => cb({ cancel: true }));
        const host = normalizeHost(d.url);
        audit.write('egress', { layer: 'reputation', decision: 'block', host, method: d.method, url: d.url, reason: `interstitial: google safe browsing ${v}`, feed: 'google-safe-browsing' });
        if (d.webContents) showInterstitial(d.webContents, d.url, host, `google-safe-browsing (${v})`, host);
        cb({ cancel: true });
      });
      return;
    }
    void egressCheck(d).then((cancel) => cb({ cancel }), () => cb({ cancel: true }));
  });

  async function readBody(d: Electron.OnBeforeRequestListenerDetails): Promise<{ text: string; unreadable: string[] }> {
    let text = '';
    const unreadable: string[] = [];
    for (const u of d.uploadData ?? []) {
      if (u.bytes) text += Buffer.from(u.bytes).toString('utf8');
      else if (u.blobUUID) {
        try {
          text += (await ses.getBlobData(u.blobUUID)).toString('utf8');
        } catch {
          unreadable.push('blob');
        }
      } else if (u.file) unreadable.push(`file upload (${u.file.split('/').pop()})`);
    }
    return { text, unreadable };
  }

  /** Ask once per key; remember denials for the rest of the task. Resolves true = allowed. */
  function askEgress(key: string, req: Omit<ConfirmRequest, 'id' | 'kind'>): Promise<boolean> {
    if (deniedFlows.has(key)) return Promise.resolve(false);
    let p = inflightFlows.get(key);
    if (!p) {
      p = broker.request({ id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: 'egress', ...req });
      inflightFlows.set(key, p);
      void p.finally(() => inflightFlows.delete(key));
    }
    return p.then((o) => {
      if (o === 'approve') return true;
      deniedFlows.add(key);
      if (o === 'stop') stopTask();
      return false;
    });
  }

  function formValues(body: string): PolicyResult['values'] {
    const now = new Date().toISOString();
    const prov = [{ source: 'snapshot' as const, timestamp: now, note: 'request body built by the page' }];
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
      return [...new URLSearchParams(body)].slice(0, 20).map(([k, v]) => ({ field: k.slice(0, 60), value: /pass|pwd/i.test(k) ? '•••• (password)' : v.slice(0, 300), masked: /pass|pwd/i.test(k), label: 'untrusted' as const, provenance: prov, taintIds: egress.idsIn(v) }));
    }
    return body ? [{ field: 'body', value: body.slice(0, 300), label: 'untrusted' as const, provenance: prov, taintIds: egress.idsIn(body) }] : [];
  }

  /** Layers after reputation. Resolves true = cancel the request. */
  async function egressCheck(d: Electron.OnBeforeRequestListenerDetails): Promise<boolean> {
    const inTask = !!current && egress.mode === 'agent';
    const host = hostKey(d.url) ?? '?';
    const base = { host, method: d.method, url: d.url.slice(0, 500) };
    const { text: body, unreadable } = await readBody(d);

    // (a) bodies we cannot inspect never leave silently during a task
    if (inTask && unreadable.length) {
      const ok = await askEgress(`unreadable|${host}|${unreadable.join(',')}`, {
        action: `${d.method} request (${d.resourceType}) with a body the egress filter cannot inspect`,
        target: host,
        destination: d.url,
        values: unreadable.map((u) => ({ field: 'body part', value: u, label: 'untrusted', provenance: [], taintIds: [] })),
        reasons: ['request body contains parts (file / blob) that could not be scanned for your data'],
      });
      egress.auditWebRequest({ ...base, decision: ok ? 'allow' : 'block', reason: `uninspectable body (${unreadable.join(', ')}): ${ok ? 'confirmed' : 'not confirmed'}` });
      if (!ok) return true;
    }

    // (b) form submissions (state-changing top-level requests) from the agent tab need a confirmed submit
    const agentTab = inTask && current!.tab.wc.id === d.webContentsId;
    if (agentTab && (d.resourceType === 'mainFrame' || d.resourceType === 'subFrame') && !['GET', 'HEAD', 'OPTIONS'].includes(d.method)) {
      if (egress.consumeSubmission(d.url)) {
        egress.auditWebRequest({ ...base, decision: 'allow', reason: 'form submission confirmed at the action layer' });
      } else {
        const values = formValues(body);
        const ok = await askEgress(`submit|${d.method}|${d.url}|${body.length}`, {
          action: `form submission ${d.method} (not confirmed by the agent's action layer)`,
          target: host,
          destination: d.url,
          values,
          reasons: ['a page / agent action is submitting a form (POST/PUT/PATCH/DELETE) that was not confirmed'],
        });
        egress.auditWebRequest({ ...base, decision: ok ? 'allow' : 'block', reason: `unconfirmed ${d.method} form submission: ${ok ? 'user approved' : 'blocked'}` });
        if (!ok) return true;
        egress.confirmFlow(egress.idsIn(`${d.url}\n${body}`), d.url);
      }
    }

    // (c) tracked values (reader output, user data the agent typed) in URL or body
    const { unconfirmed } = egress.checkRequest(d.url, d.method, body);
    if (!unconfirmed.length) return false;
    const ids = unconfirmed.map((v) => v.id).sort();
    const ok = await askEgress(`${ids.join(',')}|${host}`, {
      action: `${d.method} request (${d.resourceType})`,
      target: host,
      destination: d.url,
      values: unconfirmed.map((v) => ({ value: v.value, label: v.kind === 'untrusted' ? 'untrusted' : 'trusted', provenance: v.provenance, taintIds: [v.id], field: v.kind })),
      reasons: [`egress filter: this request carries ${unconfirmed.length} tracked value(s) to ${host} with no confirmed flow`],
    });
    if (ok) egress.confirmFlow(ids, d.url);
    egress.auditWebRequest({ ...base, taintIds: ids, decision: ok ? 'allow' : 'block', reason: ok ? 'user confirmed this flow' : 'tainted value in request, not confirmed' });
    return !ok;
  }

  ses.on('will-download', (_e, item) => {
    if (!current) {
      // manual browsing: Electron's save dialog (no silent writes, no overwrites without asking)
      audit.write('egress', { layer: 'download', decision: 'log', host: hostKey(item.getURL()), method: 'GET', url: item.getURL(), reason: 'manual download (save dialog)' });
      return;
    }
    // agent task: never overwrite; the file lands only after the user approves
    item.setSavePath(uniquePath(process.env.GUARDED_DOWNLOAD_DIR || app.getPath('downloads'), item.getFilename()));
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

function uniquePath(dir: string, name: string): string {
  const safe = name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '_') || 'download';
  const dot = safe.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
  for (let i = 0; ; i++) {
    const p = join(dir, i === 0 ? safe : `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

function setupTab(tab: Tab) {
  const wc = tab.wc;
  // WebRTC may only use proxied transports: no direct UDP past the egress proxy
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
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
  wc.on('will-navigate', (e) => {
    if (e.url.startsWith(PROCEED_PREFIX)) {
      e.preventDefault();
      handleProceed(e.url.slice(PROCEED_PREFIX.length));
      return;
    }
    guardNav(e, 'navigation');
  });
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

/** Seed allowlist shown to the user before a task starts (explicit-scheme URLs + current tab). */
function previewOrigins(text: string): string[] {
  const start = originOf(tabs.active()?.wc.getURL() ?? '');
  return [...new Set([...originsInTask(text), ...(start ? [start] : [])])];
}

function parseOrigins(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    const o = originOf(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    if (o) out.add(o);
  }
  return [...out];
}

async function startTask(text: string, origins?: string[]) {
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
    seedOrigins: origins ? parseOrigins(origins) : undefined,
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
  ipcMain.handle('agent:preview', (_e, text: string) => previewOrigins(String(text)));
  ipcMain.handle('agent:start', (_e, text: string, origins?: string[]) => startTask(String(text), Array.isArray(origins) ? origins.map(String) : undefined));
  // asked synchronously by the tab preload at document start: is an agent task driving this tab?
  ipcMain.on('tab:agent-active', (e) => {
    e.returnValue = !!current && current.tab.wc === e.sender;
  });
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
    egress.reputation = s.reputation.enabled ? reputation : null;
    reputation.setFeeds(s.reputation.feeds);
    void reputation.refresh();
    return true;
  });
  ipcMain.handle('reputation:refresh', async () => {
    reputation.reloadLocalLists();
    await reputation.refresh(true);
    return reputationState();
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

  // Reputation: cached feeds load now, downloads happen in the background (never blocks startup).
  const workerBuilder: FeedBuilder = (file, format) =>
    new Promise((resolve, reject) => {
      const w = new Worker(join(__dirname, 'feed-worker.js'), { workerData: { file, format } });
      w.once('message', (m: { data?: string; offs?: Uint32Array; count?: number; error?: string }) => {
        if (m.error || !m.data || !m.offs) reject(new Error(m.error ?? 'feed worker failed'));
        else resolve({ set: HostSet.fromParts(m.data, m.offs), count: m.count ?? 0 });
        void w.terminate();
      });
      w.once('error', reject);
    });
  reputation = new ReputationDb(join(ud, 'reputation'), settings.reputation.feeds, undefined, workerBuilder);
  let repTimer: NodeJS.Timeout | null = null;
  reputation.onChange(() => {
    repTimer ??= setTimeout(() => {
      repTimer = null;
      sendUI('reputation', reputationState());
    }, 250);
  });
  if (settings.reputation.enabled) {
    egress.reputation = reputation;
    setImmediate(() => reputation.start());
  }

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

// Electron main process: window, tabs, agent wiring, egress layers, confirmation broker, IPC.

import { app, BrowserWindow, dialog, ipcMain, session, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { AgentTask } from '../core/agent';
import { AuditLog } from '../core/audit';
import { loadSettings, saveSettings, type Role, type Settings } from '../core/config';
import { EgressController, hostKey, parseBody, startProxy, type ProxyHandle } from '../core/egress';
import { NullGuard, TransformersGuard } from '../core/guard';
import { LlmClient } from '../core/llm';
import { originOf, originsInTask } from '../core/policy';
import { HostSet, ReputationDb, normalizeHost, safeBrowsingLookup, type FeedBuilder } from '../core/reputation';
import { Worker } from 'node:worker_threads';
import type { ConfirmOutcome, ConfirmRequest, Guard, PolicyResult } from '../core/types';
import { ConfirmBroker } from './confirm';
import { ElectronDriver, TabManager, type Tab } from './tabs';
import type { TileLayout } from './tile-layout';
import { ISOLATED_WORLD } from './page-scripts';
import { AppearanceSchema, BUILTIN_THEMES, ThemeSchema, parseColor, toHex, type Theme } from '../core/theme';

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
const interstitials = new Map<string, { url: string; host: string; feed: string; wcId: number }>();
const PROCEED_PREFIX = 'https://guarded-browser.invalid/proceed?t=';
const sbCache = new Map<string, { verdict: string | null; at: number }>();
const fallbackActive: Partial<Record<Role, string>> = {};
/** webRequest-layer flows the user denied during the current task (not asked again) */
let deniedFlows = new Set<string>();
/**
 * Tabs whose current document was driven by an agent task. They stay under the state-change gate
 * after the task ends (a page could otherwise wait for the task to finish, then submit), until the
 * user navigates the tab themselves or closes it.
 */
const postTaskGuard = new Set<number>();
/**
 * Origins the agent's tab visited during tasks. Requests that belong to no tab (service workers,
 * shared workers) to one of these origins are gated while any tab is under the post-task gate.
 */
const guardedOrigins = new Set<string>();
let guardedSession: Session | null = null;

/** Validate and store a theme (JSON text from the editor, the import box or a file). */
function importTheme(json: unknown): { ok: boolean; error?: string; theme?: Theme } {
  if (typeof json !== 'string' || json.length > 64 * 1024) return { ok: false, error: 'theme must be JSON text up to 64 KB' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const r = ThemeSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'theme'}: ${i.message}`).join('; ').slice(0, 400) };
  if (r.data.name === 'System' || BUILTIN_THEMES.some((b) => b.name === r.data.name)) return { ok: false, error: `"${r.data.name}" is a built-in theme name` };
  const custom = [...settings.appearance.custom.filter((t) => t.name !== r.data.name), r.data].slice(-50);
  settings.appearance = { ...settings.appearance, custom };
  saveSettings(settingsFile, settings);
  sendUI('appearance', settings.appearance);
  return { ok: true, theme: r.data };
}

/**
 * Optional site accent: the active page's <meta name="theme-color">, else the favicon's dominant
 * colour. Page-controlled, so it is parsed strictly (parseColor) and only ever sent as #rrggbb;
 * the renderer applies it to --accent, which security UI does not use.
 */
async function updateSiteAccent() {
  const t = tabs?.active();
  if (!settings.appearance.siteAccent || !t) return sendUI('site-accent', null);
  let color: string | null = null;
  let source = '';
  try {
    const raw = await t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD + 1, [
      { code: `(() => { const m = document.querySelector('meta[name="theme-color" i]'); return m ? String(m.getAttribute('content') || '').slice(0, 64) : null; })()` },
    ]);
    const c = parseColor(raw);
    if (c) [color, source] = [toHex(c), 'theme-color'];
  } catch {
    /* page not ready */
  }
  if (!color && !current && t.favicons[0]) {
    // no favicon fetches while a task runs: the agent's network footprint stays what the task needs
    const fav = await faviconBytes(t.favicons[0]).catch(() => null);
    if (fav && tabs.active() === t) return sendUI('site-accent', { favicon: fav, source: 'favicon' });
  }
  if (tabs.active() === t) sendUI('site-accent', color ? { color, source } : null);
}

const FAVICON_MAX = 256 * 1024;
const FAVICON_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|bmp)$/i;

/**
 * Favicon BYTES for the optional site accent. Nothing is decoded here: image decoding happens in the
 * sandboxed chrome renderer (src/renderer/appearance.ts). Hard 256 KB limit: Content-Length is
 * checked first and the body is streamed and aborted as soon as it goes over.
 */
async function faviconBytes(url: string): Promise<{ mime: string; data: string } | null> {
  const d = /^data:(image\/[\w.+-]+)(;base64)?,(.*)$/is.exec(url);
  if (d) {
    if (!FAVICON_TYPES.test(d[1]) || d[3].length > FAVICON_MAX * 1.4) return null;
    const bytes = d[2] ? Buffer.from(d[3], 'base64') : Buffer.from(decodeURIComponent(d[3]), 'latin1');
    return bytes.length && bytes.length <= FAVICON_MAX ? { mime: d[1].toLowerCase(), data: bytes.toString('base64') } : null;
  }
  if (!/^https?:/i.test(url) || !guardedSession) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    // through the guarded session: proxy, reputation and webRequest rules apply
    const res = await guardedSession.fetch(url, { signal: ctl.signal });
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const len = Number(res.headers.get('content-length') ?? 'NaN');
    if (!res.ok || !FAVICON_TYPES.test(mime) || len > FAVICON_MAX || !res.body) {
      ctl.abort();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > FAVICON_MAX) {
        ctl.abort();
        audit.write('egress', { layer: 'webrequest', decision: 'block', host: hostKey(url) ?? '?', method: 'GET', url: url.slice(0, 300), reason: 'favicon larger than 256 KB: download aborted' });
        return null;
      }
      chunks.push(value);
    }
    return { mime, data: Buffer.concat(chunks).toString('base64') };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Browser-generated "where does this request come from" for confirmation dialogs. */
function sourceOf(wcId: number | undefined): ConfirmRequest['source'] {
  const t = tabs?.list().map((x) => tabs.byId(x.id)!).find((x) => x.wc.id === wcId);
  if (!t) return { label: 'a background worker or the browser itself (no tab)' };
  return tabs.describe(t.id) ?? undefined;
}

function isTabRequest(id: number | undefined): boolean {
  return id !== undefined && tabs.list().some((t) => tabs.byId(t.id)?.wc.id === id);
}
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
  interstitials.set(token, { url, host, feed, wcId: wc.id });
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

/** "Proceed anyway" only ever applies to the tab that showed that interstitial. */
function handleProceed(token: string, wc: WebContents) {
  const it = interstitials.get(token);
  if (!it || it.wcId !== wc.id) return;
  if (current) {
    audit.write('egress', { taskId: current.task.id, layer: 'reputation', decision: 'block', host: it.host, method: 'GET', url: it.url, reason: 'proceed refused: an agent task is running (the agent can never override a reputation block)', feed: it.feed });
    return;
  }
  void broker
    .request({
      id: `r${Date.now().toString(36)}`,
      kind: 'reputation',
      source: sourceOf(wc.id),
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
      if (!wc.isDestroyed()) void wc.loadURL(it.url).catch(() => undefined);
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

  /** Body for the dialog: strictly parsed fields, or the raw body when it does not parse strictly. */
  function formValues(body: string, forceRaw = false): PolicyResult['values'] {
    const now = new Date().toISOString();
    const prov = [{ source: 'snapshot' as const, timestamp: now, note: 'request body built by the page' }];
    const pairs = parseBody(body);
    const out: PolicyResult['values'] = (pairs ?? []).slice(0, 30).map(([k, v]) => ({ field: k.slice(0, 60), value: /pass|pwd/i.test(k) ? '•••• (password)' : v.slice(0, 300), masked: /pass|pwd/i.test(k), label: 'untrusted' as const, provenance: prov, taintIds: egress.idsIn(v) }));
    if (body && (!pairs || forceRaw)) {
      out.push({ field: pairs ? 'raw body' : 'raw body (not a well-formed form body)', value: body.length > 2000 ? `${body.slice(0, 2000)}… (${body.length} bytes)` : body, label: 'untrusted', provenance: prov, taintIds: egress.idsIn(body) });
    }
    return out;
  }

  /** Layers after reputation. Resolves true = cancel the request. */
  async function egressCheck(d: Electron.OnBeforeRequestListenerDetails): Promise<boolean> {
    const inTask = !!current && egress.mode === 'agent';
    const host = hostKey(d.url) ?? '?';
    const base = { host, method: d.method, url: d.url.slice(0, 500) };
    const workerOfGuardedOrigin = postTaskGuard.size > 0 && !isTabRequest(d.webContentsId) && guardedOrigins.has(originOf(d.url) ?? '');
    const gated = inTask || (d.webContentsId !== undefined && postTaskGuard.has(d.webContentsId)) || workerOfGuardedOrigin;

    // hosts the proxy refuses anyway are cancelled here first: no pointless prompts, and a prompt
    // can never reveal to the page whether a host is on the allowlist
    if (inTask && !egress.hostPasses(host)) {
      egress.decideHost(host, d.method, d.url);
      return true;
    }
    const { text: body, unreadable } = await readBody(d);

    // (a) bodies we cannot inspect never leave silently during a task
    if (inTask && unreadable.length) {
      const ok = await askEgress(`unreadable|${host}|${unreadable.join(',')}`, {
        source: sourceOf(d.webContentsId),
        action: `${d.method} request (${d.resourceType}) with a body the egress filter cannot inspect`,
        target: host,
        destination: d.url,
        values: unreadable.map((u) => ({ field: 'body part', value: u, label: 'untrusted', provenance: [], taintIds: [] })),
        reasons: ['request body contains parts (file / blob) that could not be scanned for your data'],
      });
      egress.auditWebRequest({ ...base, decision: ok ? 'allow' : 'block', reason: `uninspectable body (${unreadable.join(', ')}): ${ok ? 'confirmed' : 'not confirmed'}` });
      if (!ok) return true;
    }

    // (b) every state-changing request during a task (any tab of this session, any resource type:
    //     form POST, fetch, XHR, beacon, ping, ...) needs a matching one-shot approval or a confirmation.
    //     After the task, the tab it drove stays gated until the user navigates it.
    if (gated && !['GET', 'HEAD', 'OPTIONS'].includes(d.method)) {
      const mr = egress.matchApproval(d.method, d.url, body);
      const m = mr.result;
      if (m === 'match') {
        // the Content-Type header is only visible in onBeforeSendHeaders: check it there
        pendingContentType.set(d.id, { enctype: mr.enctype!, boundary: mr.boundary });
        egress.auditWebRequest({ ...base, decision: 'allow', reason: 'matches the submission confirmed at the action layer (method, URL, fields)' });
      } else {
        const ok = await askEgress(`write|${d.method}|${d.url}|${createHash('sha256').update(body).digest('hex')}`, {
        source: sourceOf(d.webContentsId),
          action: `${d.method} ${d.resourceType} request that was not confirmed`,
          target: host,
          destination: d.url,
          values: formValues(body, m === 'mismatch'),
          reasons: [
            !inTask
              ? workerOfGuardedOrigin
                ? 'a background worker (no tab) of a site the agent visited is sending data after the task ended'
                : 'the page the agent was operating is sending data after the task ended (the tab stays guarded until you navigate it yourself)'
              : m === 'mismatch'
              ? 'the page changed what is sent after you approved it: this is the ACTUAL request body'
              : `a state-changing ${d.method} request (${d.resourceType}) during the task, not covered by an approval`,
          ],
        });
        egress.auditWebRequest({ ...base, decision: ok ? 'allow' : 'block', reason: `unconfirmed ${d.method} ${d.resourceType}${m === 'mismatch' ? ' (body differs from the approved one)' : ''}: ${ok ? 'user approved' : 'blocked'}` });
        if (!ok) return true;
        egress.confirmFlow(egress.idsIn(`${d.url}\n${body}`), d.url);
      }
    }

    // (c) tracked values (reader output, user data the agent typed) in URL or body
    const { unconfirmed } = egress.checkRequest(d.url, d.method, body);
    if (!unconfirmed.length) return false;
    const ids = unconfirmed.map((v) => v.id).sort();
    const ok = await askEgress(`${ids.join(',')}|${host}`, {
        source: sourceOf(d.webContentsId),
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

  // An approved submission must also be SENT with the approved form's encoding.
  const pendingContentType = new Map<number, { enctype: string; boundary?: string }>();
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
    const want = pendingContentType.get(d.id);
    if (!want) return cb({ requestHeaders: d.requestHeaders });
    pendingContentType.delete(d.id);
    const ct = Object.entries(d.requestHeaders).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const media = ct.split(';')[0].trim().toLowerCase();
    const boundary = /boundary=("?)([^";]+)\1/i.exec(ct)?.[2];
    const boundaries = (ct.match(/(^|;)\s*boundary\s*=/gi) ?? []).length;
    const ok = media === want.enctype && boundaries <= 1 && (want.enctype !== 'multipart/form-data' || (boundaries === 1 && boundary === want.boundary));
    if (!ok) {
      egress.auditWebRequest({ host: hostKey(d.url) ?? '?', method: d.method, url: d.url.slice(0, 500), decision: 'block', reason: `approved submission sent with Content-Type "${ct.slice(0, 100)}" instead of ${want.enctype}` });
      return cb({ cancel: true });
    }
    cb({ requestHeaders: d.requestHeaders });
  });

  ses.on('will-download', (_e, item, dlWc) => {
    if (!current) {
      // manual browsing: Electron's save dialog (no silent writes, no overwrites without asking)
      audit.write('egress', { layer: 'download', decision: 'log', host: hostKey(item.getURL()), method: 'GET', url: item.getURL(), reason: 'manual download (save dialog)' });
      return;
    }
    // agent task: bytes go to a private staging dir; the file only reaches the downloads folder
    // (under a unique name, never overwriting) after the user approves AND the transfer completed
    const staging = join(app.getPath('userData'), 'downloads-pending');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const tmp = join(staging, `${randomBytes(8).toString('hex')}.part`);
    item.setSavePath(tmp);
    item.pause();
    const done = new Promise<string>((r) => item.once('done', (_ev, state) => r(state)));
    const url = item.getURL();
    const name = item.getFilename();
    void broker
      .request({ id: `d${Date.now().toString(36)}`, kind: 'download', source: sourceOf(dlWc?.id), action: 'file download', target: name, destination: url, values: [], reasons: ['file downloads during an agent task are always confirmed'] })
      .then(async (o) => {
        audit.write('egress', { layer: 'download', decision: o === 'approve' ? 'allow' : 'block', host: hostKey(url), method: 'GET', url, reason: `confirmation ${o}` });
        if (o === 'approve') {
          if (item.getState() === 'progressing') item.resume();
          const state = await done;
          if (state === 'completed' && existsSync(tmp)) {
            const dest = uniquePath(process.env.GUARDED_DOWNLOAD_DIR || app.getPath('downloads'), name);
            renameSync(tmp, dest);
            audit.write('egress', { layer: 'download', decision: 'allow', host: hostKey(url), method: 'GET', url, reason: `saved as ${dest}` });
          }
        } else {
          if (item.getState() === 'progressing') item.cancel();
          await done;
          rmSync(tmp, { force: true });
        }
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

/** Ctrl+Shift+S tiles the selected tabs, Ctrl+Shift+U untiles; works while a page has focus too. */
function installShortcuts(wc: WebContents) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || !input.shift) return;
    const k = input.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      tabs.tile(undefined, 'columns');
    } else if (k === 'u') {
      e.preventDefault();
      tabs.untile();
    }
  });
}

function setupTab(tab: Tab) {
  const wc = tab.wc;
  installShortcuts(wc);
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicons = favicons.slice(0, 4).map((f) => String(f).slice(0, 256 * 1024));
    if (tabs.active() === tab) void updateSiteAccent();
  });
  wc.on('did-stop-loading', () => {
    if (tabs.active() === tab) void updateSiteAccent();
  });
  // WebRTC may only use proxied transports: no direct UDP past the egress proxy
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(({ url }) => {
    if (current?.tab === tab) {
      audit.write('navigation', { url, by: 'page', blocked: true, reason: 'popup during agent task' });
    } else if (postTaskGuard.has(wc.id)) {
      // a new tab would escape the post-task gate: refuse until the user navigates this tab themselves
      audit.write('navigation', { url, by: 'page', blocked: true, reason: 'popup from a tab under the post-task gate (navigate the tab yourself to lift it)' });
    } else if (current && originOf(url)) {
      // another pane / tab opens a popup during a task: open it in the background so split view and
      // the AGENT ACTIVE frame stay on screen
      audit.write('navigation', { url, by: 'page', tab: tab.id, reason: 'popup opened in the background (agent task running)' });
      tabs.create(url, { background: true });
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
        source: sourceOf(wc.id),
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
      handleProceed(e.url.slice(PROCEED_PREFIX.length), wc);
      return;
    }
    if (e.isMainFrame) tab.navSource = 'page'; // renderer-initiated (link, form, location = ...)
    guardNav(e, 'navigation');
  });
  wc.on('will-redirect', (e) => guardNav(e, 'redirect'));
  wc.on('did-navigate', (_e, url) => {
    if (current?.tab === tab) {
      const o = originOf(url);
      if (o) guardedOrigins.add(o);
    }
    // who started it: 'user' (address bar / back / forward / reload), 'agent' (the driver's navigate),
    // 'page' (renderer-initiated or anything else, e.g. redirects of a page navigation)
    const by = tab.navSource ?? 'page';
    tab.navSource = undefined;
    audit.write('navigation', { url, tab: tab.id, by, agentTab: current?.tab === tab });
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
  postTaskGuard.add(tab.wc.id);
  const task = new AgentTask(text, {
    planner: llm('planner'),
    reader: llm('reader'),
    judge: llm('judge'),
    guard,
    driver: new ElectronDriver(tab),
    audit,
    // every agent-action confirmation names the agent's own pane
    confirm: (req) => broker.request({ ...req, source: tabs.describe(tab.id) ?? undefined }),
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
  tabs.setAgentTab(tab.id);
  sendUI('agent:update', { taskId: task.id, status: 'started', step: 0 });
  void task
    .run()
    .then((r) => sendUI('agent:done', r))
    .catch((e) => sendUI('agent:done', { taskId: task.id, status: 'failed', answer: String(e) }))
    .finally(() => {
      broker.denyAll('deny');
      current = null;
      tabs.setAgentTab(null);
      // Service workers registered by pages the agent visited would outlive the task and act
      // without a tab: unregister them for every origin the agent's tab visited.
      // (TEST ONLY: GUARDED_TEST_KEEP_SW=1 skips this to show the worker gate holds on its own)
      const keepSw = process.env.GUARDED_TEST_KEEP_SW === '1' && process.env.GUARDED_TEST === '1' && !app.isPackaged;
      for (const origin of keepSw ? [] : guardedOrigins) {
        void guardedSession
          ?.clearStorageData({ origin, storages: ['serviceworkers'] })
          .then(() => audit.write('egress', { layer: 'webrequest', decision: 'block', host: hostKey(origin) ?? origin, method: '-', reason: `service workers of ${origin} unregistered at task end` }))
          .catch(() => undefined);
      }
      sendUI('state', state());
    });
  return task.id;
}

function registerIpc() {
  ipcMain.handle('state:get', () => state());
  ipcMain.handle('tabs:new', (_e, url?: string) => {
    const t = tabs.create(url || 'about:blank');
    t.navSource = 'user';
    return t.id;
  });
  ipcMain.handle('tabs:close', (_e, id: number) => {
    const t = tabs.byId(id);
    if (current && current.tab === t) stopTask(); // closing the agent's pane ends its task
    if (t) postTaskGuard.delete(t.wc.id);
    if (!postTaskGuard.size) guardedOrigins.clear();
    tabs.close(id);
  });
  ipcMain.handle('tabs:activate', (_e, id: number) => {
    tabs.activate(id);
    void updateSiteAccent();
  });
  ipcMain.handle('tabs:select', (_e, id: number, on?: boolean) => tabs.toggleSelected(Number(id), typeof on === 'boolean' ? on : undefined));
  const LAYOUTS = new Set(['columns', 'rows', 'grid']);
  const layoutArg = (l: unknown): TileLayout => (LAYOUTS.has(String(l)) ? (String(l) as TileLayout) : 'columns');
  ipcMain.handle('tiles:tile', (_e, ids: unknown, layout: unknown) => tabs.tile(Array.isArray(ids) ? ids.map(Number) : undefined, layoutArg(layout)));
  ipcMain.handle('tiles:untile', () => tabs.untile());
  ipcMain.handle('tiles:layout', (_e, layout: unknown) => tabs.setTileLayout(layoutArg(layout)));
  ipcMain.handle('tiles:drag', (_e, phase: unknown, key: unknown, at: unknown) => {
    if (phase === 'start') tabs.setDragging(true);
    else if (phase === 'move' && typeof key === 'string' && /^(col|row|c\d|r\d)$/.test(key)) tabs.dragDivider(key as never, Number(at));
    else if (phase === 'end') tabs.setDragging(false);
  });
  ipcMain.handle('tiles:state', () => tabs.tileState());
  ipcMain.handle('nav:go', (_e, input: string) => {
    const t = tabs.active();
    if (!t) return;
    if (!current) postTaskGuard.delete(t.wc.id); // the user took the tab back
    t.navSource = 'user';
    if (!postTaskGuard.size) guardedOrigins.clear();
    let url = input.trim();
    if (!/^[a-z]+:/i.test(url)) url = /^[\w.-]+(:\d+)?(\/|$)/.test(url) ? `http://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
    void t.wc.loadURL(url).catch(() => undefined);
  });
  const userNav = (fn: (wc: WebContents) => void) => {
    const t = tabs.active();
    if (!t) return;
    if (!current) postTaskGuard.delete(t.wc.id);
    if (!postTaskGuard.size) guardedOrigins.clear();
    t.navSource = 'user';
    fn(t.wc);
  };
  ipcMain.handle('nav:back', () => userNav((wc) => wc.navigationHistory.goBack()));
  ipcMain.handle('nav:forward', () => userNav((wc) => wc.navigationHistory.goForward()));
  ipcMain.handle('nav:reload', () => userNav((wc) => wc.reload()));
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
    // appearance has its own validated path; never take it from the generic settings form
    s = { ...s, appearance: settings.appearance };
    settings = s;
    saveSettings(settingsFile, s);
    egress.setDenylist(s.egress.denylist);
    egress.reputation = s.reputation.enabled ? reputation : null;
    reputation.setFeeds(s.reputation.feeds);
    void reputation.refresh();
    return true;
  });
  // ---------- appearance (themes for the chrome UI only) ----------
  ipcMain.handle('appearance:get', () => ({ appearance: settings.appearance, builtins: BUILTIN_THEMES }));
  ipcMain.handle('appearance:save', (_e, a: unknown) => {
    const r = AppearanceSchema.safeParse(a);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) };
    settings.appearance = r.data;
    saveSettings(settingsFile, settings);
    sendUI('appearance', settings.appearance);
    void updateSiteAccent();
    return { ok: true };
  });
  ipcMain.handle('theme:import', (_e, json: unknown) => importTheme(json));
  ipcMain.handle('theme:import-file', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import theme', filters: [{ name: 'Theme JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(r.filePaths[0]).size > 64 * 1024) return { ok: false, error: 'theme file larger than 64 KB' };
    return importTheme(readFileSync(r.filePaths[0], 'utf8'));
  });
  ipcMain.handle('theme:export-file', async (_e, name: unknown) => {
    const t = [...BUILTIN_THEMES, ...settings.appearance.custom].find((x) => x.name === String(name));
    if (!t) return { ok: false, error: 'no such theme' };
    const r = await dialog.showSaveDialog(win, { title: 'Export theme', defaultPath: `${t.name.replace(/[^\w.-]/g, '_')}.theme.json` });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    writeFileSync(r.filePath, JSON.stringify(t, null, 2) + '\n');
    return { ok: true };
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
  guardedSession = ses;

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

  const size = /^(\d{3,5})x(\d{3,5})$/.exec(process.env.GUARDED_WINDOW_SIZE ?? '');
  win = new BrowserWindow({
    width: size ? Number(size[1]) : 1440,
    height: size ? Number(size[2]) : 920,
    title: 'Guarded Browser',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  tabs = new TabManager(win, ses, () => sendUI('tabs', tabs.list()), setupTab);
  tabs.onGeometry = (g) => sendUI('geometry', g);
  installShortcuts(win.webContents);
  tabs.create(process.env.GUARDED_START_URL || 'about:blank');
  sendUI('state', state());
});

app.on('window-all-closed', () => {
  void proxy?.close();
  app.quit();
});

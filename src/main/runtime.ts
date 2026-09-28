// One profile = one Chromium session partition + one app-state directory + one window.
// Everything in here (settings, audit log, egress proxy and allowlist, taint registry, approvals,
// post-task guards, confirmation queue, tabs, agent task) exists once PER PROFILE. Only the guard
// model and the public reputation feeds are shared (passed in through the context). IPC handlers
// are looked up by main.ts from the SENDER's window, never from an id the renderer sends.

import { app, BrowserWindow, dialog, session, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { AgentTask } from '../core/agent';
import { AuditLog } from '../core/audit';
import { loadSettings, saveSettings, type Role, type Settings } from '../core/config';
import { EgressController, hostKey, parseBody, startProxy, type ProxyHandle } from '../core/egress';
import { LlmClient } from '../core/llm';
import { originOf, originsInTask } from '../core/policy';
import { LocalLists, normalizeHost, safeBrowsingLookup, type FeedConfig, type ReputationChecker, type ReputationDb } from '../core/reputation';
import type { ConfirmOutcome, ConfirmRequest, Guard, PolicyResult } from '../core/types';
import { ConfirmBroker } from './confirm';
import { ElectronDriver, TabManager, type Tab } from './tabs';
import type { TileLayout } from './tile-layout';
import { ISOLATED_WORLD } from './page-scripts';
import { AppearanceSchema, BUILTIN_THEMES, ThemeSchema, parseColor, toHex, type Theme } from '../core/theme';
import type { Profile } from './profiles';
import { testEnv } from './test-hooks';
import { HistoryStore, recordable } from '../core/history';
import { BAR_ID, BookmarkStore, OTHER_ID, type ParsedImport } from '../core/bookmarks';
import { Worker } from 'node:worker_threads';
import { lookup } from 'node:dns/promises';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (e: any, ...args: any[]) => unknown;

export interface RuntimeContext {
  profile: () => Profile;
  /** false once the profile has been deleted (e.g. while its window was being created) */
  exists: () => boolean;
  dir: string;
  guard: Guard;
  feeds: ReputationDb;
  sharedFeeds: () => FeedConfig[];
  setSharedFeeds: (f: FeedConfig[]) => void;
  /** guard model settings: app-wide, not per profile */
  sharedGuard: () => Settings['guard'];
  setSharedGuard: (g: unknown) => void;
  onFeedsChange: (fn: () => void) => () => void;
  startUrl?: string;
  onClosed: () => void;
  register: (rt: Runtime) => void;
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export async function createRuntime(ctx: RuntimeContext) {
const handlers: Record<string, Handler> = {};
/** TEST ONLY. Bypasses the policy engine and judge so tests can show the egress layer holds alone. */
const POLICY_DISABLED = testEnv('GUARDED_UNSAFE_DISABLE_POLICY') === '1';

const { profile, dir: profileDir, guard, feeds } = ctx;
// read synchronously, before any await: this runtime only ever uses ITS profile's partition
const partition = profile().partition;
const settingsFile = join(profileDir, 'settings.json');
let settings: Settings = loadSettings(settingsFile);
settings.reputation.feeds = ctx.sharedFeeds();
settings.guard = { ...ctx.sharedGuard() };
if (testEnv('GUARDED_CONFIRM_TIMEOUT_MS')) settings.agent.confirmTimeoutMs = Number(testEnv('GUARDED_CONFIRM_TIMEOUT_MS'));
let audit: AuditLog;
let egress: EgressController;
let proxy: ProxyHandle;
let broker: ConfirmBroker;
let tabs: TabManager;
let win: BrowserWindow;
/** this profile's own local block / allow lists (the feeds are shared) */
const localLists = new LocalLists(join(profileDir, 'reputation'));
// Private per-profile data for the CHROME UI only. The agent (planner / reader / judge) never gets
// a reference to these stores; they are only reachable through the UI window's IPC handlers.
const history = new HistoryStore(join(profileDir, 'history.json'));
const bookmarks = new BookmarkStore(join(profileDir, 'bookmarks.json'));
/** favicon bytes by origin (in memory only; decoded in the sandboxed renderer) */
const faviconCache = new Map<string, { mime: string; data: string }>();
const reputation: ReputationChecker = { check: (h) => feeds.check(h, localLists) };
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
let disposed = false;

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
    profile: { id: profile().id, name: profile().name, color: profile().color },
  };
}

function reputationState() {
  return {
    enabled: settings.reputation.enabled,
    total: feeds.totalEntries() + localLists.block.size,
    feeds: feeds.status(),
    localBlockFile: localLists.blockFile,
    localAllowFile: localLists.allowFile,
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
    const staging = join(profileDir, 'downloads-pending');
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
            const dest = uniquePath(testEnv('GUARDED_DOWNLOAD_DIR') || app.getPath('downloads'), name);
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
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const k = input.key.toLowerCase();
    // library shortcuts while a page has focus: forwarded to this profile's chrome UI
    if (!input.shift && (k === 'h' || k === 'd')) {
      e.preventDefault();
      sendUI('shortcut', k === 'h' ? 'history' : 'bookmark-page');
      return;
    }
    if (input.shift && k === 'b') {
      e.preventDefault();
      sendUI('shortcut', 'toggle-bar');
      return;
    }
    if (!input.shift) return;
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
    // favicons for history / bookmarks: same capped fetch, never during an agent task
    const origin = originOf(wc.getURL());
    if (origin && !current && tab.favicons[0] && !faviconCache.has(origin)) {
      void faviconBytes(tab.favicons[0]).then((f) => {
        if (!f) return;
        if (faviconCache.size >= 200) faviconCache.delete(faviconCache.keys().next().value!);
        faviconCache.set(origin, f);
      });
    }
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
      tabs.create(url, { background: true }).navSource = 'page';
    } else if (originOf(url)) {
      tabs.create(url).navSource = 'page';
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
    // who started it: 'page' (renderer-initiated: will-navigate fired, or a popup tab), 'agent' (the
    // driver's navigate), otherwise 'user' (address bar, new tab, back / forward / reload)
    const by = tab.navSource ?? 'user';
    tab.navSource = undefined;
    audit.write('navigation', { url, tab: tab.id, by, agentTab: current?.tab === tab });
    // history: real web pages only (never the interstitial / data: / blob: / internal pages)
    if (recordable(url)) history.record(url, wc.getTitle() === url ? '' : wc.getTitle(), current?.tab === tab && by !== 'user' ? 'agent' : by);
  });
  wc.on('page-title-updated', (_e, title) => {
    const u = wc.getURL();
    if (recordable(u)) history.updateTitle(u, title);
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
      const keepSw = testEnv('GUARDED_TEST_KEEP_SW') === '1';
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
  const on = (channel: string, fn: Handler) => {
    handlers[channel] = fn;
  };
  on('state:get', () => state());
  on('tabs:new', (_e, url?: string) => {
    const t = tabs.create(url || 'about:blank');
    t.navSource = 'user';
    return t.id;
  });
  on('tabs:close', (_e, id: number) => {
    const t = tabs.byId(id);
    if (current && current.tab === t) stopTask(); // closing the agent's pane ends its task
    if (t) postTaskGuard.delete(t.wc.id);
    if (!postTaskGuard.size) guardedOrigins.clear();
    tabs.close(id);
  });
  on('tabs:activate', (_e, id: number) => {
    tabs.activate(id);
    void updateSiteAccent();
  });
  on('tabs:select', (_e, id: number, on?: boolean) => tabs.toggleSelected(Number(id), typeof on === 'boolean' ? on : undefined));
  const LAYOUTS = new Set(['columns', 'rows', 'grid']);
  const layoutArg = (l: unknown): TileLayout => (LAYOUTS.has(String(l)) ? (String(l) as TileLayout) : 'columns');
  on('tiles:tile', (_e, ids: unknown, layout: unknown) => tabs.tile(Array.isArray(ids) ? ids.map(Number) : undefined, layoutArg(layout)));
  on('tiles:untile', () => tabs.untile());
  on('tiles:layout', (_e, layout: unknown) => tabs.setTileLayout(layoutArg(layout)));
  on('tiles:drag', (_e, phase: unknown, key: unknown, at: unknown) => {
    if (phase === 'start') tabs.setDragging(true);
    else if (phase === 'move' && typeof key === 'string' && /^(col|row|c\d|r\d)$/.test(key)) tabs.dragDivider(key as never, Number(at));
    else if (phase === 'end') tabs.setDragging(false);
  });
  on('tiles:state', () => tabs.tileState());
  on('nav:go', (_e, input: string) => {
    const t = tabs.active();
    if (!t) return;
    if (!current) postTaskGuard.delete(t.wc.id); // the user took the tab back
    t.navSource = 'user';
    if (!postTaskGuard.size) guardedOrigins.clear();
    let url = input.trim();
    const nick = bookmarks.byNickname(url);
    if (nick) url = nick.url; // a bookmark nickname typed in the address bar
    else if (!/^[a-z]+:/i.test(url)) url = /^[\w.-]+(:\d+)?(\/|$)/.test(url) ? `http://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
    void t.wc.loadURL(url).catch(() => undefined);
  });

  // ---------- history & bookmarks: chrome UI only ----------
  const libraryChanged = () => sendUI('bookmarks', { roots: bookmarks.tree(), showBar: bookmarks.showBar });
  /** open through the normal navigation path: reputation, proxy and every gate apply */
  const openUrl = (url: string, newTab: boolean) => {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs' };
    if (newTab) {
      const t = tabs.create(url);
      t.navSource = 'user';
    } else {
      const t = tabs.active();
      if (!t) return { ok: false };
      if (!current) postTaskGuard.delete(t.wc.id);
      t.navSource = 'user';
      void t.wc.loadURL(url).catch(() => undefined);
    }
    return { ok: true };
  };
  const wrap = <T>(fn: () => T) => {
    try {
      const r = fn();
      libraryChanged();
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  };
  /** Parse in a worker with a time budget; only the (re-validated) result touches the store. */
  const importInWorker = (html: string, folder: string) =>
    new Promise<{ ok: boolean; error?: string; result?: unknown }>((resolve) => {
      if (html.length > 5 * 1024 * 1024) return resolve({ ok: false, error: 'bookmark file larger than 5 MB' });
      const w = new Worker(join(__dirname, 'import-worker.js'), { workerData: { html } });
      const timer = setTimeout(() => {
        void w.terminate();
        resolve({ ok: false, error: 'import took too long and was stopped' });
      }, 5000);
      w.once('message', (m: { ok: boolean; parsed?: ParsedImport; error?: string }) => {
        clearTimeout(timer);
        void w.terminate();
        if (!m.ok || !m.parsed) return resolve({ ok: false, error: m.error ?? 'import failed' });
        resolve(wrap(() => bookmarks.importParsed(m.parsed!, folder)));
      });
      w.once('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: (e as Error).message.slice(0, 200) });
      });
    });
  const RANGES = new Set(['hour', 'day', 'week', 'all']);
  const SOURCES = new Set(['user', 'page', 'agent']);
  on('history:list', (_e, q: unknown, source: unknown) => ({
    groups: history.grouped(String(q ?? '').slice(0, 200), SOURCES.has(String(source)) ? (String(source) as 'user') : undefined),
    clearOnExit: history.clearOnExit,
  }));
  on('history:delete', (_e, url: unknown) => ({ ok: true, removed: history.deleteUrl(String(url)) }));
  on('history:delete-range', (_e, range: unknown) => (RANGES.has(String(range)) ? { ok: true, removed: history.deleteRange(String(range) as 'all') } : { ok: false }));
  on('history:clear-on-exit', (_e, v: unknown) => {
    history.setClearOnExit(v === true);
    return { ok: true };
  });
  on('history:open', (_e, url: unknown, newTab: unknown) => openUrl(String(url), newTab === true));
  on('bookmarks:tree', () => ({ roots: bookmarks.tree(), showBar: bookmarks.showBar }));
  on('bookmarks:add', async (_e, parent: unknown, title: unknown, url: unknown, nickname: unknown) =>
    (await nicknameResolves(nickname))
      ? { ok: false, error: `"${String(nickname)}" resolves as a host name on this network; choose another nickname` }
      : wrap(() => bookmarks.addBookmark(String(parent ?? BAR_ID), String(title ?? ''), String(url ?? ''), nickname ? String(nickname) : undefined)),
  );
  on('bookmarks:add-current', () => {
    const t = tabs.active();
    const url = t?.wc.getURL() ?? '';
    const existing = bookmarks.isBookmarked(url);
    if (existing) return { ok: true, result: { id: existing, existed: true } };
    return wrap(() => bookmarks.addBookmark(BAR_ID, t?.wc.getTitle() ?? url, url));
  });
  on('bookmarks:add-folder', (_e, parent: unknown, title: unknown) => wrap(() => bookmarks.addFolder(String(parent ?? OTHER_ID), String(title ?? ''))));
  /** a nickname must not be a word that resolves as a host on this network (e.g. an intranet name) */
  const nicknameResolves = async (nick: unknown): Promise<boolean> => {
    if (typeof nick !== 'string' || !nick) return false;
    try {
      await Promise.race([lookup(nick), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 500))]);
      return true;
    } catch {
      return false;
    }
  };
  on('bookmarks:update', async (_e, id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>;
    if (await nicknameResolves(p.nickname)) return { ok: false, error: `"${String(p.nickname)}" resolves as a host name on this network; choose another nickname` };
    return wrap(() =>
      bookmarks.update(String(id), {
        ...(p.title !== undefined ? { title: String(p.title) } : {}),
        ...(p.url !== undefined ? { url: String(p.url) } : {}),
        ...(p.nickname !== undefined ? { nickname: p.nickname === null || p.nickname === '' ? null : String(p.nickname) } : {}),
      }),
    );
  });
  on('bookmarks:remove', (_e, id: unknown) => wrap(() => bookmarks.remove(String(id))));
  on('bookmarks:move', (_e, id: unknown, parent: unknown, index: unknown) => wrap(() => bookmarks.move(String(id), String(parent), Number(index))));
  on('bookmarks:search', (_e, q: unknown) => bookmarks.search(String(q ?? '').slice(0, 200)));
  on('bookmarks:set-bar', (_e, v: unknown) => wrap(() => bookmarks.setShowBar(v === true)));
  on('bookmarks:is-bookmarked', () => bookmarks.isBookmarked(tabs.active()?.wc.getURL() ?? ''));
  on('bookmarks:open', (_e, id: unknown, newTab: unknown) => {
    const b = bookmarks.all().find((x) => x.id === String(id));
    return b ? openUrl(b.url, newTab === true) : { ok: false, error: 'no such bookmark' };
  });
  on('bookmarks:import', async (_e, html: unknown, folder: unknown) => {
    if (typeof html !== 'string') return { ok: false, error: 'expected text' };
    return importInWorker(html, folder ? String(folder) : 'Imported');
  });
  on('bookmarks:import-file', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import bookmarks (HTML)', filters: [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(r.filePaths[0]).size > 5 * 1024 * 1024) return { ok: false, error: 'file larger than 5 MB' };
    return importInWorker(readFileSync(r.filePaths[0], 'utf8'), 'Imported');
  });
  on('bookmarks:export', () => bookmarks.exportNetscape());
  on('bookmarks:export-file', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export bookmarks', defaultPath: 'bookmarks.html' });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    writeFileSync(r.filePath, bookmarks.exportNetscape());
    return { ok: true };
  });
  on('suggest', (_e, q: unknown) => {
    const query = String(q ?? '').slice(0, 200);
    const nick = bookmarks.byNickname(query);
    const bms = bookmarks.search(query, 5);
    return {
      bookmarks: (nick ? [nick, ...bms.filter((b) => b.id !== nick.id)] : bms).slice(0, 5).map((b) => ({ title: b.title, url: b.url, nickname: b.nickname })),
      history: history.suggest(query, 5).map((h) => ({ title: h.title, url: h.url })),
    };
  });
  on('favicon:get', (_e, url: unknown) => {
    const o = originOf(String(url ?? ''));
    return o ? faviconCache.get(o) ?? null : null;
  });
  on('chrome:insets', (_e, top: unknown, left: unknown) => {
    const t = Math.max(0, Math.min(400, Math.round(Number(top) || 0)));
    const l = Math.max(0, Math.min(600, Math.round(Number(left) || 0)));
    tabs.setInsets(t, l);
  });
  on('chrome:overlay', (_e, on: unknown) => tabs.setOverlay(on === true));
  const userNav = (fn: (wc: WebContents) => void) => {
    const t = tabs.active();
    if (!t) return;
    if (!current) postTaskGuard.delete(t.wc.id);
    if (!postTaskGuard.size) guardedOrigins.clear();
    t.navSource = 'user';
    fn(t.wc);
  };
  on('nav:back', () => userNav((wc) => wc.navigationHistory.goBack()));
  on('nav:forward', () => userNav((wc) => wc.navigationHistory.goForward()));
  on('nav:reload', () => userNav((wc) => wc.reload()));
  on('agent:preview', (_e, text: string) => previewOrigins(String(text)));
  on('agent:start', (_e, text: string, origins?: string[]) => startTask(String(text), Array.isArray(origins) ? origins.map(String) : undefined));
  // asked synchronously by the tab preload at document start: is an agent task driving this tab?
  handlers['tab:agent-active'] = (e) => !!current && current.tab.wc === e.sender;
  on('agent:stop', () => stopTask());
  on('confirm:answer', (_e, id: string, outcome: ConfirmOutcome) => {
    if (['approve', 'deny', 'stop'].includes(outcome)) broker.answer(id, outcome);
    if (outcome === 'stop') stopTask();
  });
  on('egress:allow', (_e, host: string) => {
    if (!current) return;
    egress.allowHost(host);
    audit.write('egress', { taskId: current.task.id, layer: 'proxy', decision: 'allow', host, method: '-', reason: 'user allowed host for this task' });
  });
  on('settings:get', () => ({ ...settings, guard: { ...ctx.sharedGuard() }, reputation: { ...settings.reputation, feeds: ctx.sharedFeeds() } }));
  on('settings:save', (_e, s: Settings) => {
    // appearance has its own validated path; never take it from the generic settings form
    s = { ...s, appearance: settings.appearance };
    settings = s;
    saveSettings(settingsFile, s);
    egress.setDenylist(s.egress.denylist);
    egress.reputation = s.reputation.enabled ? reputation : null;
    // app-wide values: the feed LIST (public data) and the guard model settings apply to every profile
    ctx.setSharedFeeds(s.reputation.feeds);
    ctx.setSharedGuard(s.guard);
    return true;
  });
  // ---------- appearance (themes for the chrome UI only) ----------
  on('appearance:get', () => ({ appearance: settings.appearance, builtins: BUILTIN_THEMES }));
  on('appearance:save', (_e, a: unknown) => {
    const r = AppearanceSchema.safeParse(a);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) };
    settings.appearance = r.data;
    saveSettings(settingsFile, settings);
    sendUI('appearance', settings.appearance);
    void updateSiteAccent();
    return { ok: true };
  });
  on('theme:import', (_e, json: unknown) => importTheme(json));
  on('theme:import-file', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import theme', filters: [{ name: 'Theme JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(r.filePaths[0]).size > 64 * 1024) return { ok: false, error: 'theme file larger than 64 KB' };
    return importTheme(readFileSync(r.filePaths[0], 'utf8'));
  });
  on('theme:export-file', async (_e, name: unknown) => {
    const t = [...BUILTIN_THEMES, ...settings.appearance.custom].find((x) => x.name === String(name));
    if (!t) return { ok: false, error: 'no such theme' };
    const r = await dialog.showSaveDialog(win, { title: 'Export theme', defaultPath: `${t.name.replace(/[^\w.-]/g, '_')}.theme.json` });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    writeFileSync(r.filePath, JSON.stringify(t, null, 2) + '\n');
    return { ok: true };
  });

  on('reputation:refresh', async () => {
    localLists.reload();
    await feeds.refresh(true);
    return reputationState();
  });
  on('audit:recent', () => audit.read().slice(-400));
}


// ---------- per-profile startup (was app.whenReady) ----------
audit = new AuditLog(join(profileDir, 'audit'));
audit.onEvent((e) => sendUI('audit', e));
egress = new EgressController(settings.egress.denylist, (e) => audit.write('egress', { taskId: current?.task.id, ...e }));
egress.onChange(() => sendUI('egress', egressState()));
// one proxy per profile: its own port, its own task-mode allowlist
proxy = await startProxy(egress);
const abortIfDeleted = async () => {
  if (ctx.exists()) return;
  await proxy.close();
  throw new Error('profile was deleted while its window was being created');
};
// TEST ONLY: widen the gap between starting and creating the window
const openDelay = Number(testEnv('GUARDED_TEST_OPEN_DELAY_MS') ?? 0);
if (openDelay > 0) await new Promise((r) => setTimeout(r, openDelay));
await abortIfDeleted();
if (settings.reputation.enabled) egress.reputation = reputation;
const unsubscribeFeeds = ctx.onFeedsChange(() => sendUI('reputation', reputationState()));

const ses = session.fromPartition(partition);
// Everything from this profile's session goes through ITS proxy, loopback included.
await ses.setProxy({ proxyRules: `127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
setupEgress(ses);
guardedSession = ses;

broker = new ConfirmBroker(sendUI, () => settings.agent.confirmTimeoutMs);
registerIpc();

const size = /^(\d{3,5})x(\d{3,5})$/.exec(process.env.GUARDED_WINDOW_SIZE ?? '');
await abortIfDeleted();
win = new BrowserWindow({
  width: size ? Number(size[1]) : 1440,
  height: size ? Number(size[2]) : 920,
  title: windowTitle(),
  webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged },
});
const api = {
  proxyPort: proxy.port,
  setRefusedPorts: (ports: number[]) => egress.setRefusedPorts(ports),
  get win() {
    return win;
  },
  session: ses,
  handlers,
  ownsWebContents: (wc: WebContents) => (!win.isDestroyed() && wc === win.webContents) || !!tabs?.byWebContents(wc),
  isUi: (wc: WebContents) => !win.isDestroyed() && wc === win.webContents,
  profileChanged() {
    if (!win.isDestroyed()) win.setTitle(windowTitle());
    sendUI('state', state());
  },
  guardChanged: () => sendUI('state', state()),
  audit: (type: Parameters<AuditLog['write']>[0], data: Record<string, unknown>) => audit.write(type, data),
  confirm: (req: ConfirmRequest) => broker.request(req),
  dispose,
  get taskRunning() {
    return !!current;
  },
};
// registered BEFORE the UI loads: the renderer's first IPC calls must find this profile
ctx.register(api);
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', (e) => e.preventDefault());
win.on('page-title-updated', (e) => e.preventDefault());
await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
tabs = new TabManager(win, ses, () => sendUI('tabs', tabs.list()), setupTab);
tabs.onGeometry = (g) => sendUI('geometry', g);
installShortcuts(win.webContents);
tabs.create(ctx.startUrl || 'about:blank');
sendUI('state', state());

function windowTitle() {
  return `Guarded Browser — ${profile().name}`;
}

async function dispose() {
  if (disposed) return;
  disposed = true;
  if (history.clearOnExit) history.clear();
  else history.flush();
  if (current) stopTask();
  broker.denyAll('deny');
  unsubscribeFeeds();
  await proxy.close();
}

win.on('closed', () => {
  void dispose();
  ctx.onClosed();
});

return api;

}

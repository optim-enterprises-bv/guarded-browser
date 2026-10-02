// One profile = one Chromium session partition + one app-state directory + one window.
// Everything in here (settings, audit log, egress proxy and allowlist, taint registry, approvals,
// post-task guards, confirmation queue, tabs, agent task) exists once PER PROFILE. Only the guard
// model and the public reputation feeds are shared (passed in through the context). IPC handlers
// are looked up by main.ts from the SENDER's window, never from an id the renderer sends.

import { app, BrowserWindow, clipboard, dialog, session, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { AgentTask } from '../core/agent';
import { AuditLog } from '../core/audit';
import { loadSettings, saveSettings, MAX_WEB_PANELS, type Role, type Settings } from '../core/config';
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
import { ClosedTabStore } from '../core/closed-tabs';
import { SessionStore } from '../core/session-state';
import { ZoomStore, clampZoom, stepZoom } from '../core/zoom';
import { SEARCH_ENGINES, searchUrl, SearchSettingsSchema } from '../core/search';
import { DownloadList } from '../core/downloads';
import { resolveChord, type Chord } from '../core/chords';
import { BAR_ID, BookmarkStore, OTHER_ID, type ParsedImport } from '../core/bookmarks';
import { SavedSessionStore } from '../core/saved-sessions';
import { SortModeSchema, sortTree, TrashStore, type SortMode } from '../core/bookmarks-panel';
import { WorkspaceStore } from '../core/workspaces';
import { StackModel } from '../core/tab-stacks';
import { PageActionsSchema, PageActionsStore, defaultPageActions, pageActionCss, affectsAgentSnapshot, describePageActions, type PageActions } from '../core/page-actions';
import { planSweep, decideHibernation, HibernationSettingsSchema, type HibernationFacts } from '../core/hibernation';
import { toChords, validateBindings, defaultKeybindings, KeybindingsSchema, ACTION_LABELS, formatChord } from '../core/keybindings';
import { resolveGesture, pathFrom, type Point } from '../core/gestures';
import { clampItems, type PaletteItem } from '../core/quick-commands';
import { buildBundle, dryRun, parseBundle, MAX_BUNDLE_BYTES } from '../core/profile-bundle';
import { CaptureRequestSchema, clampRect, clampFullHeight, captureFilename, writeCapture } from './capture';
import { EXTRACT_ARTICLE_JS, normalizeArticle } from './reader-mode';
import { canTranslate, chunkText, cloudStatus, translatePrompt, TRANSLATE_SYSTEM, TranslateSettingsSchema, LANGUAGES, defaultTranslate } from './translate';
import { ExtensionList, EXTENSION_WARNING, extensionListFile, loadExtensions } from './extensions';
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
// Closed-tab stack for Ctrl+Shift+T. Holds a URL, a title, a position and a timestamp and nothing
// else — see src/core/closed-tabs.ts for why gate state is not representable here.
const closedTabs = new ClosedTabStore(join(profileDir, 'closed-tabs.json'));
// Session state for "start where you left off". URLs, titles, selection and tiling only; gate
// state is deliberately not representable (see src/core/session-state.ts).
const sessionState = new SessionStore(join(profileDir, 'session.json'));
// Per-origin zoom. A chrome view property, private to the profile.
const zoom = new ZoomStore(join(profileDir, 'zoom.json'));
// The downloads panel's list. Observes transfers only — see src/core/downloads.ts.
const downloads = new DownloadList((list) => sendUI('downloads', list));
// ---------------------------------- wave 2 stores ----------------------------------
// Named, reusable tab sets the user creates deliberately (ticket 22). URLs + titles only; the
// schema has no field for gate state, so a restored session's tabs start clean.
const savedSessions = new SavedSessionStore(join(profileDir, 'saved-sessions.json'));
// Named tab sets you switch between (ticket 20). NOT an identity boundary: workspaces share this
// profile's cookies, storage and every security layer. Only the profile is an identity.
const workspaces = new WorkspaceStore(join(profileDir, 'workspaces.json'));
// Tab stacks (ticket 19). Pure presentation over tab ids — collapsing one unloads and un-gates
// nothing.
const stacks = StackModel.load(join(profileDir, 'tab-stacks.json')).model;
// Per-origin page transforms (ticket 27). The applied set is agent-visible state, so it is audited.
const pageActions = new PageActionsStore(join(profileDir, 'page-actions.json'));
// Bookmarks panel extras: sort mode + a Trash that never discards silently (ticket 33).
const bookmarkTrash = new TrashStore(join(profileDir, 'bookmarks-trash.json'));
// Unpacked extensions (ticket 32). Outside the threat model — see the warning in extensions.ts.
const extensions = new ExtensionList(extensionListFile(profileDir));
/** last activation time per tab id, for the hibernation sweep (ticket 23) */
const activatedAt = new Map<number, number>();
/** gesture trail from the MAIN process's own input events; never page-reported (ticket 16) */
let gestureTrail: Point[] = [];
/** the bookmarks panel's sort mode (ticket 33); presentation only */
let bookmarkSort: SortMode = 'manual';
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
// Post-task state-change gate: the per-tab rules live in TabGuardBook (src/main/tab-guard.ts) and
// are reached through TabManager (tabs.setGate / tabs.isGated / tabs.gatedOrigins). Reopening or
// restoring a tab constructs a new tab id, which is absent from the book and therefore ungated —
// gate state is never resurrected from anything persisted.
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

/**
 * The webRequest layer sees WebContents ids, but tab security state lives in TabGuardBook. The
 * two are kept in lockstep by TabManager.create()/close(), so one lookup is enough — and if a
 * WebContents has no live tab (a destroyed tab, a devtools target) the answer is "not gated",
 * which is what the old `postTaskGuard.has(id)` gave once the tab was gone.
 */
function tabIdOf(wcId: number): number {
  return tabs.list().find((t) => tabs.byId(t.id)?.wc.id === wcId)?.id ?? -1;
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
    // a packaged build started with --no-sandbox (Chromium's OS sandbox off) says so, loudly
    sandboxDisabled: app.isPackaged && app.commandLine.hasSwitch('no-sandbox'),
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
    const workerOfGuardedOrigin = tabs.anyGated() && !isTabRequest(d.webContentsId) && tabs.gatedOrigins().has(originOf(d.url) ?? '');
    const gated = inTask || (d.webContentsId !== undefined && tabs.isGated(tabIdOf(d.webContentsId))) || workerOfGuardedOrigin;

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
    // The downloads panel only OBSERVES the transfer: the staging / confirm / rename logic below is
    // unchanged. Recording happens regardless of who started it, so the user can see the bytes.
    const dlId = downloads.add(item, {
      agentTask: !!current,
      host: hostKey(item.getURL()) ?? '',
      source: current ? 'agent' : 'user',
    });
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
            downloads.saved(dlId, dest);
            audit.write('egress', { layer: 'download', decision: 'allow', host: hostKey(url), method: 'GET', url, reason: `saved as ${dest}` });
          } else {
            downloads.failed(dlId, state);
          }
        } else {
          if (item.getState() === 'progressing') item.cancel();
          await done;
          rmSync(tmp, { force: true });
          downloads.failed(dlId, 'denied');
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

/**
 * Close a tab: ends the task if it is the agent's pane, forgets its security state, and pushes it
 * onto the closed-tab stack so Ctrl+Shift+T can bring it back. Shared with the ✕ button and
 * Ctrl+W so both paths capture identically.
 */
function closeTab(id: number) {
  const t = tabs.byId(id);
  if (!t) return;
  const isAgentPane = !!current && current.tab === t;
  if (isAgentPane) stopTask();
  tabs.forgetTab(t.id);
  // The agent task's own pane is not captured: offering the document the agent drove back as a
  // "reopen" would resurrect the very page the post-task gate exists to contain.
  tabs.silentCloseId = isAgentPane ? id : null;
  tabs.close(id);
  tabs.silentCloseId = null;
}

/**
 * Reopen the most recently closed tab. Built exactly like a plain user navigation: a NEW tab id
 * (so TabGuardBook has no entry and the tab is ungated) at the old position, with no guard origin
 * recorded. Only the URL and title survive a close — see src/core/closed-tabs.ts.
 */
function reopenClosed(): { ok: boolean; url?: string } {
  const entry = closedTabs.pop();
  if (!entry) return { ok: false };
  sendUI('closed-tabs', closedTabs.list());
  const t = tabs.createAt(entry.url, { at: entry.pos });
  t.navSource = 'user';
  audit.write('navigation', { url: entry.url, tab: t.id, by: 'user', reopen: true });
  return { ok: true, url: entry.url };
}

/**
 * Dispatch a chord while a page has focus. Every action in src/core/chords.ts lands here, so the
 * keymap has exactly one implementation (ticket 15 will edit the table, not this function).
 */
function installShortcuts(wc: WebContents) {
  wc.on('before-input-event', (e, input) => {
    if (runChord(input)) e.preventDefault();
  });
}

/**
 * Run one chord against this window. Returns true when the keystroke was consumed.
 *
 * `before-input-event` only fires for a focused *page* view, so the chrome UI's own keydown
 * handler calls into the same path through the `chord` IPC channel (see the handler below). One
 * implementation, two entry points: the keymap has a single place to change (ticket 15 edits the
 * table in src/core/chords.ts and nothing else).
 *
 * `e` is the Electron event when available; the IPC path passes null and nothing needs to be
 * prevented (the renderer already called preventDefault on its own event).
 */
function runChord(input: { key: string; control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; type?: string }): boolean {
  const key = input.key.toLowerCase();
  const action = resolveChord(input, chordTable());
  // Ctrl+1..9 selects a tab by index (1..8), Ctrl+9 the last one
  if (!action && (input.control || input.meta) && !input.shift && /^[1-9]$/.test(key)) {
    const list = tabs.list();
    const idx = key === '9' ? list.length - 1 : Number(key) - 1;
    const t = list[idx];
    if (t) tabs.activate(t.id);
    return true;
  }
  if (!action) return false;
  const active = tabs.active();
  switch (action) {
    case 'tab.new':
      // the agent's pane is fixed for the duration of its task
      if (current) return true;
      tabs.create(tabStartUrl()).navSource = 'user';
      break;
    case 'tab.close':
      if (active) closeTab(active.id);
      break;
    case 'tab.reopen':
      reopenClosed();
      break;
    case 'tab.next':
    case 'tab.prev': {
      const id = tabs.nextInMru(action === 'tab.next' ? 1 : -1);
      if (id !== undefined) tabs.activate(id);
      break;
    }
    case 'tab.duplicate':
      tabs.duplicate(active?.id ?? -1);
      break;
    case 'tab.closeOthers':
      if (active) tabs.closeOthers(active.id, !!current);
      break;
    case 'tab.mute':
      if (active) tabs.setAudioMuted(active.id, !active.wc.isAudioMuted());
      sendUI('tabs', tabs.list());
      break;
    case 'tab.reload':
      if (active) {
        active.navSource = 'user';
        active.wc.reload();
      }
      break;
    case 'nav.back':
      if (active && !current) {
        tabs.setGate(active.id, 'none');
        active.navSource = 'user';
        active.wc.navigationHistory.goBack();
      }
      break;
    case 'nav.forward':
      if (active && !current) {
        tabs.setGate(active.id, 'none');
        active.navSource = 'user';
        active.wc.navigationHistory.goForward();
      }
      break;
    case 'nav.focusAddress':
      sendUI('shortcut', 'focus-address');
      break;
    case 'view.zoomIn':
    case 'view.zoomOut':
    case 'view.zoomReset': {
      if (!active) break;
      const origin = originOf(active.wc.getURL());
      const factor =
        action === 'view.zoomReset' ? 1 : stepZoom(active.wc.getZoomFactor(), action === 'view.zoomIn' ? 1 : -1);
      active.wc.setZoomFactor(factor);
      if (origin) zoom.set(origin, factor);
      sendUI('zoom', { tab: active.id, factor });
      break;
    }
    case 'view.find':
      sendUI('shortcut', 'find');
      break;
    case 'view.print':
      // chrome-initiated print of the page the user is looking at. A page-initiated window.print()
      // is neutralised in the page's own world in setupTab.
      if (active) void printTab(active);
      break;
    case 'view.fullscreen':
      win.setFullScreen(!win.isFullScreen());
      break;
    case 'library.history':
      sendUI('shortcut', 'history');
      break;
    case 'library.bookmarkPage':
      sendUI('shortcut', 'bookmark-page');
      break;
    case 'library.toggleBar':
      sendUI('shortcut', 'toggle-bar');
      break;
    case 'tiles.tile':
      tabs.tile(undefined, 'columns');
      break;
    case 'tiles.untile':
      tabs.untile();
      break;
    // ---- wave 2 ----
    case 'palette.open':
      sendUI('shortcut', 'palette');
      break;
    case 'panel.history':
      sendUI('shortcut', 'panel:history');
      break;
    case 'panel.bookmarks':
      sendUI('shortcut', 'panel:bookmarks');
      break;
    case 'panel.downloads':
      sendUI('shortcut', 'panel:downloads');
      break;
    case 'panel.sessions':
      sendUI('shortcut', 'panel:sessions');
      break;
    case 'panel.workspaces':
      sendUI('shortcut', 'panel:workspaces');
      break;
    case 'reader.toggle':
      sendUI('shortcut', 'reader');
      break;
    case 'capture.visible':
      sendUI('shortcut', 'capture:visible');
      break;
    case 'capture.full':
      sendUI('shortcut', 'capture:full');
      break;
    case 'capture.clipboard':
      sendUI('shortcut', 'capture:clipboard');
      break;
    case 'session.save':
      sendUI('shortcut', 'session:save');
      break;
    case 'tab.stripToggle': {
      // cycles the strip placement, so the chord is useful without a settings visit
      const order: Array<'top' | 'left' | 'right' | 'bottom'> = ['top', 'left', 'bottom', 'right'];
      const next = order[(order.indexOf(settings.general.tabStrip) + 1) % order.length];
      settings.general.tabStrip = next;
      saveSettings(settingsFile, settings);
      sendUI('tabstrip', { placement: next });
      break;
    }
    case 'view.translate':
      sendUI('shortcut', 'translate');
      break;
  }
  return true;
}

// The shortcuts above can close several tabs at once; closeTab sends the stack notification.


/**
 * Where a new tab goes. Still `about:blank` by default; ticket 13 introduces the chrome start page
 * and this is the single place that decides, so the agent's snapshot never sees the start page as
 * a page.
 */
function tabStartUrl(): string {
  return 'about:blank';
}

/** The chord table in force: the user's remappings applied over the defaults. */
function chordTable(): Chord[] {
  const custom = toChords(settings.keybindings);
  return custom.length ? custom : resolveChordTable();
}

/** The default table, kept as a function so keybindings.ts stays the single source of defaults. */
function resolveChordTable(): Chord[] {
  return toChords(defaultKeybindings());
}

/**
 * Run an action from the keybinding table by NAME. This is the one entry point for anything that
 * wants to trigger a bound action (a gesture, a Quick Commands row, a menu item), so a gesture can
 * never do something a chord cannot, and vice versa.
 *
 * It is implemented on top of the same switch runChord uses, reached by synthesising the chord that
 * is currently bound to the action — that keeps ONE dispatch table rather than two that can drift.
 */
function runAction(action: string): boolean {
  const c = chordTable().find((x) => x.action === action);
  if (!c) return false;
  return runChord({ key: c.key, control: c.ctrl, shift: c.shift, alt: c.alt, type: 'keyDown' });
}

/**
 * The Quick Commands aggregate (ticket 14). Built from lists the chrome already owns — commands,
 * open tabs, bookmarks, history, saved sessions, workspaces, settings pages. It reads NO page content
 * and never reaches the agent.
 *
 * Every bookmark/history entry is marked `untrusted` so the matcher scores it below a real command
 * (a page titled "Close tab" cannot outrank the actual action) and the UI labels where it came from.
 */
function commandItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const c of chordTable()) {
    out.push({ kind: 'command', id: c.action, title: ACTION_LABELS[c.action] ?? c.action, chord: formatChord(`${c.ctrl ? 'ctrl+' : ''}${c.shift ? 'shift+' : ''}${c.alt ? 'alt+' : ''}${c.key}`) });
  }
  for (const t of tabs.list()) {
    out.push({ kind: 'tab', id: String(t.id), title: t.title || t.url || 'New tab', subtitle: t.url || 'about:blank', untrusted: false });
  }
  for (const b of bookmarks.all()) {
    out.push({ kind: 'bookmark', id: b.id, title: b.title, subtitle: b.url, untrusted: true });
  }
  for (const h of history.suggest('', 100)) {
    out.push({ kind: 'history', id: h.url, title: h.title || h.url, subtitle: h.url, untrusted: true });
  }
  for (const s of savedSessions.list()) {
    out.push({ kind: 'session', id: s.id, title: `Session: ${s.name}`, subtitle: `${s.tabs.length} tabs` });
  }
  for (const w of workspaces.list()) {
    out.push({ kind: 'workspace', id: w.id, title: `Workspace: ${w.name}`, subtitle: w.id === workspaces.activeId ? 'active' : '' });
  }
  for (const p of ['History', 'Bookmarks', 'Downloads', 'Sessions', 'Workspaces', 'Settings']) {
    out.push({ kind: 'setting', id: `panel:${p.toLowerCase()}`, title: `Open ${p}` });
  }
  return out;
}

/**
 * Apply page actions to a tab (ticket 27). Injected into the PAGE's own world as a stylesheet, so
 * chrome is untouched. An action set that changes what a snapshot reports is audited and surfaced to
 * the agent's context — the agent must not reason about a page the user has visually rewritten.
 */
function applyPageActions(tab: Tab, origin: string) {
  const pa = pageActions.byOrigin(origin);
  const css = pageActionCss(pa);
  try {
    if (css) {
      void tab.wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => undefined);
    }
    if (affectsAgentSnapshot(pa)) {
      audit.write('page-actions', { taskId: current?.task.id, url: tab.wc.getURL(), actions: describePageActions(pa), agentVisible: true });
    }
  } catch {
    /* a page that cannot take CSS is not an error worth failing a navigation over */
  }
}

/** Facts for the hibernation decision (ticket 23). Gathered here; DECIDED by planSweep. */
function hibernationFacts(): HibernationFacts[] {
  const all = tabs.list();
  return all.map((t) => ({
    tabId: t.id,
    isAgentTab: tabs.agentTab === t.id,
    isGated: tabs.isGated(t.id),
    audible: t.audible,
    active: t.active,
    tabCount: all.length,
    idleMs: Date.now() - (activatedAt.get(t.id) ?? 0),
    loading: t.loading,
    pinned: false, // no pin feature yet; the field exists so a pin cannot be forgotten when it lands
    hasFormState: false, // best-effort; a discard with form state is guarded by the setting
  }));
}

/** Sweep now. Returns the ids actually discarded. The decision is planSweep's, never this function's. */
function hibernationSweep(): number[] {
  if (settings.hibernation.enabled !== true) return [];
  const ids = planSweep(hibernationFacts(), {
    idleMs: settings.hibernation.idleMinutes * 60_000,
    allowFormState: settings.hibernation.allowFormState,
    maxPerSweep: settings.hibernation.maxPerSweep,
  });
  const done: number[] = [];
  for (const id of ids) {
    // re-check against the live facts immediately before discarding: a tab could have become active
    // or gained a gate between the plan and the act
    const f = hibernationFacts().find((x) => x.tabId === id);
    if (!f || !decideHibernation(f, { idleMs: settings.hibernation.idleMinutes * 60_000, allowFormState: settings.hibernation.allowFormState }).hibernate) continue;
    if (tabs.hibernate(id)) {
      done.push(id);
      audit.write('hibernate', { taskId: current?.task.id, tab: id });
    }
  }
  if (done.length) sendUI('tabs', tabs.list());
  return done;
}

let hibernationTimer: ReturnType<typeof setInterval> | null = null;
/** Start/stop the sweep timer to match the setting. */
function scheduleHibernation() {
  if (hibernationTimer) clearInterval(hibernationTimer);
  hibernationTimer = null;
  if (settings.hibernation.enabled !== true) return;
  hibernationTimer = setInterval(() => hibernationSweep(), 60_000);
  hibernationTimer.unref?.();
}


/**
 * Save the session (debounced). Called on navigation, tab open/close, tiling and quit. Only URLs,
 * titles, the active index and the tiling are written — never gate state.
 */
function saveSessionSoon() {
  if (disposed) return;
  const list = tabs?.list() ?? [];
  const activeIndex = list.findIndex((t) => t.active);
  const tiles = tabs?.tileState();
  const tiling = tiles
    ? {
        indexes: tiles.ids.map((id) => list.findIndex((t) => t.id === id)).filter((i) => i >= 0),
        layout: tiles.layout,
        ratios: tiles.ratios,
      }
    : null;
  sessionState.saveSoon(
    list.map((t) => ({ url: t.url, title: t.title })),
    activeIndex < 0 ? 0 : activeIndex,
    tiling && tiling.indexes.length >= 2 ? tiling : null,
    false,
  );
}

/**
 * Print the active page through the system dialog. Chrome-initiated only: a page calling
 * `window.print()` is handled separately in setupTab and refused while a task runs, so this
 * function is never reachable from page script.
 */
async function printTab(tab: Tab): Promise<boolean> {
  if (current?.tab === tab) {
    // never put a native dialog over security UI while the agent is driving this tab
    audit.write('policy', { taskId: current.task.id, action: 'page:print', decision: 'block', reasons: ['printing the agent-driven tab is refused while its task runs'] });
    return false;
  }
  if (broker.list().length) {
    audit.write('policy', { action: 'page:print', decision: 'block', reasons: ['a confirmation is pending; no native dialog is opened over it'] });
    return false;
  }
  audit.write('policy', { action: 'page:print', decision: 'allow', destination: tab.wc.getURL() });
  return new Promise<boolean>((resolve) => {
    tab.wc.print({ silent: false }, (ok: boolean) => resolve(ok));
  });
}

/**
 * Apply the remembered zoom for a URL's origin (called on arrival). Kept here so navigation,
 * restore and reopen all go through one path.
 */
function applyZoom(wc: WebContents) {
  const o = originOf(wc.getURL());
  if (o) wc.setZoomFactor(zoom.get(o));
}

/** the query the user last typed in the find bar, per tab (for the found-in-page echo) */
const lastFindQuery = new Map<number, string>();

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
    } else if (tabs.isGated(tab.id)) {
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
      if (o) tabs.addGuardOrigin(tab.id, o);
    }
    // who started it: 'page' (renderer-initiated: will-navigate fired, or a popup tab), 'agent' (the
    // driver's navigate), otherwise 'user' (address bar, new tab, back / forward / reload)
    const by = tab.navSource ?? 'user';
    tab.navSource = undefined;
    audit.write('navigation', { url, tab: tab.id, by, agentTab: current?.tab === tab });
    // zoom is per origin: apply the remembered factor on arrival, and 100% when arriving at an
    // origin with none. Purely a view property — the snapshot the agent sees is unaffected.
    const o = originOf(url);
    if (o) {
      const z = zoom.get(o);
      wc.setZoomFactor(z);
      sendUI('zoom', { tab: tab.id, factor: z });
    }
    // history: real web pages only (never the interstitial / data: / blob: / internal pages).
    // A session restore re-navigates to the tabs that were open; with "clear history on exit" the
    // user asked for no surviving history, so those restore-driven navigations must not be
    // recorded — otherwise the restored URL is written straight back into history at launch and
    // the setting silently fails after a crash.
    if (recordable(url) && !(tab.restored && history.clearOnExit)) {
      history.record(url, wc.getTitle() === url ? '' : wc.getTitle(), current?.tab === tab && by !== 'user' ? 'agent' : by);
    }
    // the tab is no longer "restored" once anything else navigates it
    if (tab.restored) tab.restored = false;
    // session state follows real navigations (debounced inside saveSoon)
    saveSessionSoon();
  });
  // A page-initiated window.print() must never put a native dialog over security UI, and must not
  // decide when the user sees one. It is neutralised in the page's own world: printing is reached
  // only through the chrome (menu / Ctrl+P), which is a user action. The audit line makes the
  // refusal visible rather than silent.
  wc.on('did-finish-load', () => {
    applyZoom(wc);
    // per-origin page actions are REMEMBERED, so they must be re-applied on every arrival — not only
    // when the user toggles one. A stylesheet does not survive a navigation.
    const o = originOf(wc.getURL());
    const tab2 = tabs.byWebContents(wc);
    if (o && tab2) applyPageActions(tab2, o);
    void wc.executeJavaScript(
      `(() => {
        if (window.__gbPrintNeutralised) return;
        window.__gbPrintNeutralised = true;
        try { Object.defineProperty(window, 'print', { value: () => undefined, writable: false, configurable: false }); } catch (e) {}
      })()`,
      true,
    ).catch(() => undefined);
  });
  wc.on('audio-state-changed', () => sendUI('tabs', tabs.list()));
  // The page's own context menu is replaced by chrome UI: the coordinates and the link URL are
  // passed to this window's renderer only (never back into any page), and the menu's items are
  // fixed chrome actions.
  wc.on('context-menu', (_e, params) => {
    if (tabs.byWebContents(wc)?.id !== tabs.active()?.id) return; // only the active pane opens a menu
    sendUI('page:contextmenu', {
      x: Math.max(0, Math.min(params.x, win.getContentBounds().width - 240)),
      y: Math.max(0, Math.min(params.y, win.getContentBounds().height - 280)),
      hasSelection: !!params.selectionText,
      link: params.linkURL || null,
    });
  });
  wc.on('found-in-page', (_e, result) => {
    sendUI('find:result', {
      tab: tab.id,
      matches: result.matches,
      active: result.activeMatchOrdinal,
      final: result.finalUpdate,
      query: lastFindQuery.get(tab.id) ?? '',
    });
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
  tabs.setGate(tab.id, 'post-task');
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
      // without a tab: unregister them for every origin still held by a gated tab. The gate is
      // lifted only by the user taking the tab back or by closing it, so this is the same set the
      // pre-refactor code read from `guardedOrigins`.
      // (TEST ONLY: GUARDED_TEST_KEEP_SW=1 skips this to show the worker gate holds on its own)
      const keepSw = testEnv('GUARDED_TEST_KEEP_SW') === '1';
      for (const origin of keepSw ? [] : tabs.gatedOrigins()) {
        void guardedSession
          ?.clearStorageData({ origin, storages: ['serviceworkers'] })
          .then(() => audit.write('egress', { layer: 'webrequest', decision: 'block', host: hostKey(origin) ?? origin, method: '-', reason: `service workers of ${origin} unregistered at task end` }))
          .catch(() => undefined);
      }
      sendUI('state', state());
    });
  return task.id;
}

/** the saved panel list, with the LIVE ones marked and their real titles */
const panelState = () => {
  const live = new Map(tabs.panelList().map((t) => [t.id, t]));
  return {
    saved: settings.general.webPanels.map((p) => {
      const t = [...live.values()].find((x) => (x.intendedUrl || x.wc.getURL()) === p.url);
      return { url: p.url, title: t?.wc.getTitle() || p.title, open: !!t };
    }),
    open: tabs.panelList().map((t) => ({ id: t.id, url: t.intendedUrl || t.wc.getURL(), title: t.wc.getTitle() })),
  };
};

/** open a panel for a saved entry (used at startup and by the UI toggle) */
const openPanel = (url: string): { ok: boolean; error?: string; id?: number } => {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'a panel must be an http(s) site' };
  if (tabs.panelList().some((t) => (t.intendedUrl || t.wc.getURL()) === url)) return { ok: true };
  const t = tabs.createPanel(url);
  audit.write('panel', { url, open: true });
  void tabs.layout();
  sendUI('panels', { railVisible: settings.general.railVisible, statusBar: settings.general.statusBar, tabStrip: settings.general.tabStrip, inset: tabs.insets() });
  return { ok: true, id: t.id };
};

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
  on('tabs:close', (_e, id: number) => closeTab(Number(id)));
  on('tabs:reopen', () => reopenClosed());
  on('tabs:closed-list', () => closedTabs.list());
  /**
   * The active tab's security state, for the chrome UI and for tests. Read-only, and it reports
   * booleans and origins rather than granting any capability.
   */
  on('tabs:guard-state', () => {
    const t = tabs.active();
    if (!t) return { gated: false, origins: [], agentTab: false, taskRunning: !!current };
    const s = tabs.guardStateOf(t.id);
    return { gated: s?.gate === 'post-task', origins: s?.gateOrigins ?? [], agentTab: s?.agentTab ?? false, taskRunning: !!current };
  });
  on('tabs:activate', (_e, id: number) => {
    tabs.activate(Number(id));
    tabs.noteActivated(Number(id));
    saveSessionSoon();
    void updateSiteAccent();
  });
  on('tabs:move', (_e, id: unknown, to: unknown) => {
    const order = tabs.move(Number(id), Number(to));
    saveSessionSoon();
    return order;
  });
  on('tabs:duplicate', (_e, id: unknown) => {
    const target = id === undefined || id === null ? tabs.active()?.id : Number(id);
    const t = tabs.duplicate(target ?? -1);
    saveSessionSoon();
    return t?.id ?? null;
  });
  on('tabs:close-others', (_e, id: unknown) => {
    const n = tabs.closeOthers(Number(id), !!current);
    saveSessionSoon();
    return n;
  });
  on('tabs:close-right', (_e, id: unknown) => {
    const n = tabs.closeRight(Number(id), !!current);
    saveSessionSoon();
    return n;
  });
  on('tabs:mute', (_e, id: unknown, muted: unknown) => {
    const wasMuted = tabs.byId(Number(id))?.wc.isAudioMuted() ?? false;
    tabs.setAudioMuted(Number(id), typeof muted === 'boolean' ? muted : !wasMuted);
    sendUI('tabs', tabs.list());
  });

  // ---------- zoom (view property; per origin) ----------
  on('zoom:get', () => {
    const t = tabs.active();
    if (!t) return { factor: 1, origin: null };
    return { factor: t.wc.getZoomFactor(), origin: originOf(t.wc.getURL()) };
  });
  on('zoom:set', (_e, factor: unknown) => {
    const t = tabs.active();
    if (!t) return { factor: 1 };
    const f = clampZoom(Number(factor) || 1);
    t.wc.setZoomFactor(f);
    const o = originOf(t.wc.getURL());
    if (o) zoom.set(o, f);
    sendUI('zoom', { tab: t.id, factor: f });
    return { factor: f };
  });
  on('zoom:step', (_e, dir: unknown) => {
    const t = tabs.active();
    if (!t) return { factor: 1 };
    const f = stepZoom(t.wc.getZoomFactor(), Number(dir) === 1 ? 1 : -1);
    t.wc.setZoomFactor(f);
    const o = originOf(t.wc.getURL());
    if (o) zoom.set(o, f);
    sendUI('zoom', { tab: t.id, factor: f });
    return { factor: f };
  });
  on('zoom:reset', () => {
    const t = tabs.active();
    if (!t) return { factor: 1 };
    t.wc.setZoomFactor(1);
    const o = originOf(t.wc.getURL());
    if (o) zoom.clear(o);
    sendUI('zoom', { tab: t.id, factor: 1 });
    return { factor: 1 };
  });

  // ---------- find in page (Chromium reports counts, never content) ----------
  on('find:start', (_e, query: unknown, opts: unknown) => {
    const t = tabs.active();
    if (!t) return { requestId: 0 };
    const q = String(query ?? '').slice(0, 200);
    const o = (opts ?? {}) as { forward?: boolean; findNext?: boolean; matchCase?: boolean };
    const prev = lastFindQuery.get(t.id);
    lastFindQuery.set(t.id, q);
    if (!q) {
      tabs.stopFind(t.id);
      return { requestId: 0, cleared: true };
    }
    // The FIRST request of a find session must carry findNext:true (Electron's own docs); only
    // repeat requests within the same query use findNext:false. A fresh query resets the session.
    const freshQuery = prev !== q;
    const rid = tabs.findInPage(t.id, q, { ...o, findNext: freshQuery ? true : o.findNext === true });
    return { requestId: rid };
  });
  on('find:stop', () => {
    const t = tabs.active();
    if (t) tabs.stopFind(t.id, 'clearSelection');
  });

  // ---------- print (chrome-initiated only) ----------
  on('page:print', async () => {
    const t = tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    return { ok: await printTab(t) };
  });

  // ---------- downloads panel (observes the transfer; never decides) ----------
  on('downloads:list', () => downloads.list());
  on('downloads:action', (_e, id: unknown, what: unknown) => downloads.action(Number(id), String(what) as 'pause' | 'resume' | 'cancel' | 'remove'));
  on('downloads:clear', () => {
    downloads.clearFinished();
    return downloads.list();
  });

  // ---------- search engine setting ----------
  on('search:get', () => ({ engines: SEARCH_ENGINES, current: settings.general.search }));

  // ---------- session restore ----------
  on('session:info', () => {
    const r = sessionState.restorableTabs();
    return { tabs: r.tabs, activeIndex: r.activeIndex, crashed: sessionState.crashed, startup: settings.general.startup };
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
    if (!current) tabs.setGate(t.id, 'none'); // the user took the tab back
    t.navSource = 'user';
    let url = input.trim();
    const nick = bookmarks.byNickname(url);
    if (nick) url = nick.url; // a bookmark nickname typed in the address bar
    else if (!/^[a-z]+:/i.test(url)) url = /^[\w.-]+(:\d+)?(\/|$)/.test(url) ? `http://${url}` : searchUrl(url, settings.general.search);
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
      if (!current) tabs.setGate(t.id, 'none');
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
  on('chrome:insets', (_e, top: unknown, left: unknown, bottom: unknown) => {
    const t = Math.max(0, Math.min(400, Math.round(Number(top) || 0)));
    const l = Math.max(0, Math.min(600, Math.round(Number(left) || 0)));
    const b = Math.max(0, Math.min(200, Math.round(Number(bottom) || 0)));
    tabs.setInsets(t, l, b);
  });
  on('chrome:overlay', (_e, on: unknown) => tabs.setOverlay(on === true));
  // The chrome window's own keydown handler forwards keystrokes here, so the chord table applies
  // whether a page or the chrome has focus. Only a key event is accepted; the payload is a plain
  // description, never anything page-derived.
  on('chord', (_e, key: unknown, mods: unknown) => {
    const m = (mods ?? {}) as { ctrl?: boolean; shift?: boolean; alt?: boolean };
    if (typeof key !== 'string' || key.length > 32) return { handled: false };
    return { handled: runChord({ key, control: m.ctrl === true, shift: m.shift === true, alt: m.alt === true, type: 'keyDown' }) };
  });
  const userNav = (fn: (wc: WebContents) => void) => {
    const t = tabs.active();
    if (!t) return;
    if (!current) tabs.setGate(t.id, 'none');
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

  // ================================ wave 2 (tickets 14-33) ================================

  // ---------- 15: remappable keybindings ----------
  on('keybindings:get', () => ({ bindings: settings.keybindings, chords: chordTable() }));
  on('keybindings:save', (_e, b: unknown) => {
    const r = KeybindingsSchema.safeParse(b);
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    const problems = validateBindings(r.data.bindings);
    if (problems.length) return { ok: false, error: problems.map((p) => `${p.action}: ${p.problem}`).join('; ').slice(0, 300) };
    settings.keybindings = r.data;
    saveSettings(settingsFile, settings);
    sendUI('keybindings', settings.keybindings);
    return { ok: true };
  });
  on('keybindings:reset', () => {
    settings.keybindings = defaultKeybindings();
    saveSettings(settingsFile, settings);
    sendUI('keybindings', settings.keybindings);
    return { ok: true, bindings: settings.keybindings };
  });

  // ---------- 16: gestures ----------
  // The trail is fed from the page view's own input events (below), never by page script. A gesture
  // is REFUSED while a task runs: it could otherwise move the agent's tab out from under the gate.
  on('gesture:trail', (_e, phase: unknown, x: unknown, y: unknown) => {
    if (settings.gestures.enabled !== true) return { action: null };
    if (phase === 'start') gestureTrail = [{ x: Number(x) || 0, y: Number(y) || 0 }];
    else if (phase === 'move') gestureTrail.push({ x: Number(x) || 0, y: Number(y) || 0 });
    else if (phase === 'end') {
      // The final point IS part of the path: a flick sends start then end, with no 'move' in
      // between, so dropping the end point left a one-point trail and no gesture ever resolved.
      gestureTrail.push({ x: Number(x) || 0, y: Number(y) || 0 });
      const path = pathFrom(gestureTrail);
      gestureTrail = [];
      const r = resolveGesture(path, { suppressed: !!current });
      if ('suppressed' in r) {
        sendUI('gesture', { path, suppressed: true, reason: 'an agent task is running' });
        return { suppressed: true };
      }
      if (r.action) runAction(r.action);
      return { action: r.action };
    }
    return { action: null };
  });

  // ---------- 17/18: panels ----------
  on('panel:refresh', (_e, which: unknown) => {
    if (which === 'history') sendUI('history', { groups: history.grouped('', undefined), clearOnExit: history.clearOnExit });
    if (which === 'bookmarks') libraryChanged();
    if (which === 'downloads') sendUI('downloads', downloads.list());
    return { ok: true };
  });
  // The renderer asks for this on boot, and boot happens BEFORE `tabs` exists (the UI is loaded
  // first so the window paints early). So this must not assume a TabManager; the real geometry is
  // pushed by sendUI('geometry') once there is one.
  on('panels:state', () => ({
    railVisible: settings.general.railVisible,
    statusBar: settings.general.statusBar,
    tabStrip: settings.general.tabStrip,
    inset: tabs?.insets() ?? { top: 0, left: 0, bottom: 0 },
  }));

  // ---------- 18: web panels ----------
  // A panel is a website pinned into the sidebar. It is NOT a strip tab, it is never `active()`, and
  // `setAgentTab` refuses a panel id — so a panel cannot become the agent's tab and cannot be an
  // escape hatch around a task's allowlist. Its requests still pass through the same session, proxy,
  // host allowlist, reputation feed and webRequest content filter as any tab.

  on('panels:list', () => panelState());
  /** the chrome reports where the sidebar column landed; panels are drawn exactly there */
  on('panels:rect', (_e, r: unknown) => {
    const o = (r ?? null) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (!o) {
      tabs.setPanelRect(null);
      return { ok: true };
    }
    tabs.setPanelRect({
      x: Math.max(0, Math.round(Number(o.x) || 0)),
      y: Math.max(0, Math.round(Number(o.y) || 0)),
      width: Math.max(0, Math.round(Number(o.width) || 0)),
      height: Math.max(0, Math.round(Number(o.height) || 0)),
    });
    return { ok: true };
  });
  /** show a panel in the column (or none). Only http(s) URLs can ever be shown. */
  on('panels:show', (_e, url: unknown) => {
    const u = url === null ? null : String(url ?? '');
    if (u !== null && !tabs.panelList().some((t) => (t.intendedUrl || t.wc.getURL()) === u)) return { ok: false, error: 'no such panel' };
    tabs.setPanelShown(u);
    return { ok: true };
  });
  /** pin the active tab into the sidebar AND show it immediately */
  on('panels:show-view', (_e, id: unknown) => {
    const t = tabs.panelList().find((x) => x.id === Number(id));
    if (!t) return { ok: false, error: 'no such panel' };
    tabs.setPanelShown(t.intendedUrl || t.wc.getURL());
    return { ok: true };
  });
  on('panels:add', (_e, url: unknown) => {
    const u = String(url ?? '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'a panel must be an http(s) site' };
    if (settings.general.webPanels.length >= MAX_WEB_PANELS) return { ok: false, error: `no more than ${MAX_WEB_PANELS} panels` };
    if (!settings.general.webPanels.some((p) => p.url === u)) {
      settings.general.webPanels.push({ url: u.slice(0, 2048), title: '' });
      saveSettings(settingsFile, settings);
    }
    const r = openPanel(u);
    if (r.ok) sendUI('panels:list', panelState());
    return r;
  });
  on('panels:open-current', () => {
    const t = tabs.active();
    const u = t?.wc.getURL() ?? '';
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'the active tab is not an http(s) site' };
    if (settings.general.webPanels.length >= MAX_WEB_PANELS) return { ok: false, error: `no more than ${MAX_WEB_PANELS} panels` };
    if (!settings.general.webPanels.some((p) => p.url === u)) {
      settings.general.webPanels.push({ url: u.slice(0, 2048), title: t?.wc.getTitle() ?? '' });
      saveSettings(settingsFile, settings);
    }
    const r = openPanel(u);
    sendUI('panels:list', panelState());
    return r;
  });
  on('panels:remove', (_e, url: unknown) => {
    const u = String(url ?? '');
    settings.general.webPanels = settings.general.webPanels.filter((p) => p.url !== u);
    saveSettings(settingsFile, settings);
    const open = tabs.panelList().find((t) => (t.intendedUrl || t.wc.getURL()) === u);
    if (open) tabs.closePanel(open.id);
    audit.write('panel', { url: u, open: false });
    sendUI('panels:list', panelState());
    return { ok: true };
  });
  on('panels:close', (_e, id: unknown) => {
    const n = Number(id);
    // a panel is closed through the SAME reporting path as a tab, so it lands on the reopen stack
    tabs.closePanel(n, (url, title, pos) => {
      closedTabs.push(url, title, pos);
      sendUI('closed-tabs', closedTabs.list());
    });
    sendUI('panels:list', panelState());
    return { ok: true };
  });

  // ---------- 14: quick commands ----------
  on('commands:search', () => clampItems(commandItems()));
  /** Run a bound action by NAME. The palette reaches actions through this, so it cannot do anything
   *  a chord cannot, and there is a single dispatch path (runAction). */
  on('action:run', (_e, action: unknown) => ({ ok: runAction(String(action ?? '')) }));

  // ---------- 19: tab stacks ----------
  on('stacks:list', () => stacks.list());
  on('stacks:create', (_e, ids: unknown, name: unknown) => {
    const live = tabs.list().map((t) => t.id);
    const r = stacks.create(Array.isArray(ids) ? ids.map(Number).filter((n) => live.includes(n)) : [], String(name ?? ''));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return r;
  });
  on('stacks:collapse', (_e, id: unknown, collapsed: unknown) => {
    const ok = stacks.toggleCollapsed(String(id), typeof collapsed === 'boolean' ? collapsed : undefined);
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  on('stacks:rename', (_e, id: unknown, name: unknown) => {
    const ok = stacks.rename(String(id), String(name ?? ''));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  on('stacks:color', (_e, id: unknown, index: unknown) => {
    const ok = stacks.setColor(String(id), Number(index) || 0);
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  on('stacks:dissolve', (_e, id: unknown) => {
    const ok = stacks.dissolve(String(id));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  /**
   * "Close stack" resolves to a list of ids and runs them through the ORDINARY close path, so every
   * tab is captured to the closed-tab stack and a gated tab keeps its gate until it is closed.
   * There is deliberately no bulk close that bypasses closeTab().
   */
  on('stacks:close', (_e, id: unknown) => {
    const ids = stacks.members(String(id));
    let n = 0;
    for (const tid of ids) {
      // never close the agent's pane out from under a running task
      if (current && tabs.agentTab === tid) continue;
      closeTab(tid);
      n++;
    }
    stacks.dissolve(String(id));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok: true, closed: n };
  });

  // ---------- 20: workspaces ----------
  on('workspaces:list', () => ({ workspaces: workspaces.list(), activeId: workspaces.activeId }));
  on('workspaces:create', (_e, name: unknown, colorIndex: unknown) => {
    const r = workspaces.create(String(name ?? ''), Number(colorIndex) || 0);
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    return r;
  });
  on('workspaces:rename', (_e, id: unknown, name: unknown) => {
    const ok = workspaces.rename(String(id), String(name ?? ''));
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    return { ok };
  });
  on('workspaces:delete', (_e, id: unknown) => {
    const r = workspaces.remove(String(id));
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    return r;
  });
  /**
   * Switching workspaces is REFUSED while an agent task runs. The agent's tab belongs to the
   * workspace the task started in; letting a switch hide it would make the security UI describe a
   * state that is no longer on screen (the same reasoning as "untile shows the agent's tab").
   */
  on('workspaces:switch', (_e, id: unknown) => {
    if (current) return { ok: false, error: 'a workspace cannot be switched while an agent task is running: the agent tab would leave the screen' };
    const currentTabs = tabs.list().map((t) => ({ url: t.url, title: t.title }));
    const r = workspaces.switchTo(String(id), currentTabs);
    if (!r.ok) return r;
    // open the target workspace's tabs: close the non-agent tabs, then create the saved set
    const keep = tabs.agentTab;
    for (const t of tabs.list()) if (t.id !== keep) closeTab(t.id);
    for (const x of r.tabs) {
      const t = tabs.create(x.url);
      t.navSource = 'user';
    }
    // Only fall back to a blank tab when the switch genuinely left nothing on screen. A workspace
    // with no saved tabs used to add a blank ON TOP of the tab that was already there.
    if (!tabs.list().length) {
      const t = tabs.create('about:blank');
      t.navSource = 'user';
    }
    saveSessionSoon();
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    void tabs.layout();
    return { ok: true };
  });

  // ---------- 21: tab strip placement ----------
  on('tabstrip:set', (_e, placement: unknown) => {
    const OK = new Set(['top', 'left', 'right', 'bottom']);
    const p = OK.has(String(placement)) ? (String(placement) as 'top') : 'top';
    settings.general.tabStrip = p;
    saveSettings(settingsFile, settings);
    sendUI('tabstrip', { placement: p });
    return { ok: true, placement: p };
  });

  // ---------- 22: saved sessions ----------
  on('sessions:list', () => ({ sessions: savedSessions.list() }));
  on('sessions:save', (_e, name: unknown) => {
    const list = tabs.list().map((t) => ({ url: t.url, title: t.title }));
    const r = savedSessions.save(String(name ?? ''), list);
    sendUI('sessions', { sessions: savedSessions.list() });
    return r;
  });
  on('sessions:restore', (_e, id: unknown) => {
    const r = savedSessions.restorableTabs(String(id));
    if (!r.length) return { ok: false, error: 'that session has no restorable tabs' };
    const created: number[] = [];
    for (const t of r) {
      const tab = tabs.create(t.url);
      // a restored session's tabs start CLEAN: navSource 'user' records history as a user action,
      // and there is no gate state to resurrect because none is stored
      tab.navSource = 'user';
      created.push(tab.id);
    }
    saveSessionSoon();
    return { ok: true, opened: created.length };
  });
  on('sessions:rename', (_e, id: unknown, name: unknown) => {
    const ok = savedSessions.rename(String(id), String(name ?? ''));
    sendUI('sessions', { sessions: savedSessions.list() });
    return { ok };
  });
  on('sessions:delete', (_e, id: unknown) => {
    const ok = savedSessions.remove(String(id));
    sendUI('sessions', { sessions: savedSessions.list() });
    return { ok };
  });
  on('sessions:export', () => savedSessions.toJson());

  // ---------- 23: hibernation ----------
  on('hibernation:state', () => ({ settings: settings.hibernation, hibernated: tabs.hibernatedIds() }));
  on('hibernation:set', (_e, patch: unknown) => {
    const r = HibernationSettingsSchema.safeParse({ ...settings.hibernation, ...(patch as object) });
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    settings.hibernation = r.data;
    saveSettings(settingsFile, settings);
    scheduleHibernation();
    return { ok: true, settings: r.data };
  });
  /** Sweep now. The decision is delegated to planSweep — this handler does not decide anything. */
  on('hibernation:sweep', () => ({ swept: hibernationSweep() }));

  // ---------- 24: reader mode (HUMAN-ONLY output) ----------
  on('reader:open', async () => {
    const t = tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    if (t.wc.getURL() === '' || t.wc.getURL() === 'about:blank') return { ok: false, error: 'nothing to read' };
    try {
      // runs in the page's own ISOLATED WORLD; its output is text and is shown to the human only
      const raw = await t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: EXTRACT_ARTICLE_JS }]);
      const article = normalizeArticle(raw);
      if (!article.ok) return { ok: false, error: article.error ?? 'no readable content' };
      // NOTE, and it is the point of this ticket: this NEVER calls runReader, never touches taint,
      // and never reaches the planner. Reader mode is not a text channel into any model.
      audit.write('reader', { taskId: current?.task.id, url: t.wc.getURL(), blocks: article.blocks.length, humanOnly: true });
      return { ok: true, article };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  // ---------- 25: translate (opt-in, off by default, refused during a task) ----------
  on('translate:state', () => ({ settings: settings.translate, languages: LANGUAGES, status: cloudStatus(settings.translate) }));
  on('translate:set', (_e, patch: unknown) => {
    const r = TranslateSettingsSchema.safeParse({ ...settings.translate, ...(patch as object) });
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    settings.translate = r.data;
    saveSettings(settingsFile, settings);
    sendUI('translate', { settings: r.data, status: cloudStatus(r.data) });
    return { ok: true, settings: r.data, status: cloudStatus(r.data) };
  });
  on('translate:run', async (_e, langCode: unknown) => {
    const gate = canTranslate(settings.translate, { taskRunning: !!current });
    if (!gate.ok) return { ok: false, error: gate.error };
    const t = tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    const target = String(langCode ?? settings.translate.targetLang);
    const label = LANGUAGES.find((l) => l.code === target)?.label ?? target;
    try {
      const text = String(await t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: '(() => (document.body && document.body.innerText) || "")()' }]) ?? '');
      const chunks = chunkText(text);
      if (!chunks.length) return { ok: false, error: 'nothing to translate' };
      const out: string[] = [];
      for (const c of chunks.slice(0, 10)) {
        const r = await fetch(settings.translate.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: settings.translate.model || undefined,
            messages: [
              { role: 'system', content: TRANSLATE_SYSTEM },
              { role: 'user', content: translatePrompt(c, label) },
            ],
          }),
        });
        if (!r.ok) return { ok: false, error: `endpoint returned ${r.status}` };
        const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
        out.push(String(j.choices?.[0]?.message?.content ?? '').slice(0, 20_000));
      }
      // deliberately NOT recorded as taint: this text went to the user's OWN configured endpoint for
      // the user, and marking the page tainted would silently change the agent's behaviour on it
      audit.write('translate', { taskId: current?.task.id, url: t.wc.getURL(), target: label, chunks: out.length, taint: false });
      return { ok: true, text: out.join('\n\n'), target: label, status: cloudStatus(settings.translate) };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  // ---------- 26: capture ----------
  on('capture:run', async (_e, req: unknown) => {
    // (1) chrome-initiated only: there is no path from a page to this handler. (2) never while a
    // confirmation is pending — that would photograph the security UI.
    if (broker.pendingCount() > 0) return { ok: false, error: 'a confirmation dialog is open; a capture now would include the security UI' };
    const parsed = CaptureRequestSchema.safeParse(req);
    if (!parsed.success) return { ok: false, error: 'bad capture request' };
    const t = tabs.active();
    if (!t || t.wc.isDestroyed()) return { ok: false, error: 'no active tab' };
    try {
      const b = tabs.paneBounds(t.id);
      const w = b.width;
      const h = b.height;
      let image: Electron.NativeImage;
      if (parsed.data.mode === 'visible') {
        image = await t.wc.capturePage();
      } else {
        const rect = parsed.data.mode === 'region' && parsed.data.rect ? clampRect(parsed.data.rect, { width: w, height: h }) : { x: 0, y: 0, width: w, height: h };
        if (parsed.data.mode === 'full') {
          // a page can report an enormous scroll height; cap it and say so rather than OOM
          const { height, clipped } = clampFullHeight(h, w);
          image = await t.wc.capturePage({ x: 0, y: 0, width: w, height });
          if (clipped) audit.write('capture', { taskId: current?.task.id, mode: 'full', clipped: true, height });
        } else {
          image = await t.wc.capturePage(rect);
        }
      }
      const png = image.toPNG();
      const save = await dialog.showSaveDialog(win, { title: 'Save capture', defaultPath: captureFilename(originOf(t.wc.getURL())?.replace(/^https?:\/\//, '') ?? 'page') });
      if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled', bytes: png.length };
      const w2 = writeCapture(save.filePath, png);
      audit.write('capture', { taskId: current?.task.id, mode: parsed.data.mode, bytes: png.length, ok: w2.ok });
      return { ok: w2.ok, bytes: png.length, file: save.filePath, error: w2.ok ? undefined : w2.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });
  on('capture:to-clipboard', async (_e, req: unknown) => {
    if (broker.pendingCount() > 0) return { ok: false, error: 'a confirmation dialog is open; a capture now would include the security UI' };
    const parsed = CaptureRequestSchema.safeParse(req);
    if (!parsed.success) return { ok: false, error: 'bad capture request' };
    const t = tabs.active();
    if (!t || t.wc.isDestroyed()) return { ok: false, error: 'no active tab' };
    try {
      const bb = tabs.paneBounds(t.id);
      const image = await t.wc.capturePage(parsed.data.rect ? clampRect(parsed.data.rect, bb) : undefined);
      const png = image.toPNG();
      // Electron 44 removed Clipboard.writeImage; the supported path is the async ClipboardItem API
      // the DOM lib also declares ClipboardItem with an incompatible getType signature, so this
      // goes through unknown; at runtime it is Electron's own ClipboardItem the module expects
      const item = new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }) as unknown as Electron.ClipboardItem;
      await clipboard.write([item]);
      audit.write('capture', { taskId: current?.task.id, mode: 'clipboard', bytes: png.length });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  // ---------- 27: page actions ----------
  on('pageactions:get', () => {
    const o = originOf(tabs.active()?.wc.getURL() ?? '');
    return { actions: o ? pageActions.byOrigin(o) : defaultPageActions(), custom: o ? pageActions.byOrigin(o).customCss : '' };
  });
  on('pageactions:set', (_e, patch: unknown) => {
    const t = tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    const o = originOf(t.wc.getURL());
    if (!o) return { ok: false, error: 'this page has no origin to remember actions for' };
    const r = PageActionsSchema.safeParse({ ...pageActions.byOrigin(o), ...(patch as object) });
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    pageActions.set(o, r.data);
    applyPageActions(t, o);
    return { ok: true, actions: r.data };
  });

  // ---------- 28: status bar ----------
  on('status:set', (_e, on: unknown) => {
    settings.general.statusBar = on !== false;
    saveSettings(settingsFile, settings);
    return { ok: true, on: settings.general.statusBar };
  });
  on('rail:set', (_e, on: unknown) => {
    settings.general.railVisible = on !== false;
    saveSettings(settingsFile, settings);
    return { ok: true, on: settings.general.railVisible };
  });

  // ---------- 29: ephemeral window ----------
  on('profiles:create-ephemeral', (_e, name: unknown) => {
    const p = ctx.profile();
    if (p.ephemeral) return { ok: false, error: 'this window is already ephemeral' };
    return { ok: true, hint: 'create it from the profile manager; the window is removed when it closes' };
  });

  // ---------- 30: profile bundle ----------
  on('bundle:export', (): string => {
    const b = buildBundle({
      settings: { general: settings.general, hibernation: settings.hibernation, translate: settings.translate, gestures: settings.gestures, extensions: settings.extensions },
      themes: { custom: settings.appearance.custom as unknown as Array<Record<string, unknown>>, activeId: settings.appearance.theme },
      bookmarks: bookmarks.tree() as never,
      keybindings: settings.keybindings.bindings,
      savedSessions: savedSessions.list().map((s) => ({ name: s.name, createdAt: s.createdAt, tabs: s.tabs })),
      workspaces: workspaces.list().map((w) => ({ name: w.name, colorIndex: w.colorIndex, tabs: w.tabs })),
    });
    return JSON.stringify(b, null, 2) + '\n';
  });
  on('bundle:dry-run', (_e, text: unknown) => dryRun(String(text ?? '')));
  on('bundle:import', (_e, text: unknown) => {
    const r = parseBundle(String(text ?? ''));
    if (!r.ok) return { ok: false, error: r.error };
    const b = r.bundle;
    const applied: string[] = [];
    // validated as a whole before anything is touched; a bundle that fails anywhere changes nothing
    if (b.settings) {
      const g = b.settings.general as Settings['general'] | undefined;
      if (g && typeof g === 'object') {
        settings.general = { ...settings.general, startup: g.startup === 'last-session' ? 'last-session' : settings.general.startup, tabStrip: settings.general.tabStrip };
        applied.push('settings');
      }
    }
    if (b.keybindings) {
      const merged = { version: 1 as const, bindings: { ...defaultKeybindings().bindings, ...b.keybindings } };
      const problems = validateBindings(merged.bindings);
      if (!problems.length) {
        settings.keybindings = merged;
        applied.push('keybindings');
      }
    }
    if (b.savedSessions) {
      for (const s of b.savedSessions) savedSessions.save(s.name, s.tabs);
      applied.push(`sessions (${b.savedSessions.length})`);
    }
    if (b.workspaces) {
      for (const w of b.workspaces) {
        const c = workspaces.create(w.name, w.colorIndex);
        if (c.ok) workspaces.remember(w.tabs, c.workspace.id);
      }
      applied.push(`workspaces (${b.workspaces.length})`);
    }
    saveSettings(settingsFile, settings);
    audit.write('bundle', { taskId: current?.task.id, applied: applied.join(', '), bookmarks: b.bookmarks?.length ?? 0 });
    return { ok: true, applied };
  });
  on('bundle:export-file', async () => {
    const save = await dialog.showSaveDialog(win, { title: 'Export profile bundle', defaultPath: 'guarded-browser-profile.json' });
    if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' };
    const text = JSON.stringify(
      buildBundle({
        settings: { general: settings.general, hibernation: settings.hibernation, translate: settings.translate, gestures: settings.gestures, extensions: settings.extensions },
        themes: { custom: settings.appearance.custom as unknown as Array<Record<string, unknown>>, activeId: settings.appearance.theme },
        bookmarks: bookmarks.tree() as never,
        keybindings: settings.keybindings.bindings,
        savedSessions: savedSessions.list().map((s) => ({ name: s.name, createdAt: s.createdAt, tabs: s.tabs })),
        workspaces: workspaces.list().map((w) => ({ name: w.name, colorIndex: w.colorIndex, tabs: w.tabs })),
      }),
      null,
      2,
    );
    if (text.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'bundle too large to write' };
    writeFileSync(save.filePath, text, { mode: 0o600 });
    return { ok: true };
  });
  on('bundle:import-file', async () => {
    const open = await dialog.showOpenDialog(win, { title: 'Import profile bundle', filters: [{ name: 'Bundle JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (open.canceled || !open.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(open.filePaths[0]).size > MAX_BUNDLE_BYTES) return { ok: false, error: 'file too large' };
    return handlers['bundle:import']({}, readFileSync(open.filePaths[0], 'utf8')) as { ok: boolean };
  });

  // ---------- 32: unpacked extensions ----------
  on('extensions:list', () => ({ entries: extensions.list(), warning: EXTENSION_WARNING, enabled: settings.extensions.enabled }));
  on('extensions:add', (_e, dir: unknown) => {
    const r = extensions.add(String(dir ?? ''));
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return r;
  });
  on('extensions:enable', (_e, dir: unknown, on: unknown) => {
    const ok = extensions.setEnabled(String(dir), on !== false);
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return { ok };
  });
  on('extensions:remove', (_e, dir: unknown) => {
    const ok = extensions.remove(String(dir));
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return { ok };
  });
  on('extensions:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add an unpacked extension', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    const added = extensions.add(r.filePaths[0]);
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return added;
  });
  on('extensions:set-enabled', (_e, on: unknown) => {
    settings.extensions.enabled = on !== false;
    saveSettings(settingsFile, settings);
    return { ok: true, enabled: settings.extensions.enabled };
  });

  // ---------- 33: bookmarks panel extras ----------
  on('bookmarks:set-description', (_e, id: unknown, text: unknown) => wrap(() => bookmarks.update(String(id), { description: String(text ?? '').slice(0, 2000) })));
  on('bookmarks:set-speeddial', (_e, id: unknown, on: unknown) => wrap(() => bookmarks.update(String(id), { speedDial: on === true })));
  on('bookmarks:sort', (_e, mode: unknown) => {
    const r = SortModeSchema.safeParse(mode);
    if (!r.success) return { ok: false, error: 'unknown sort mode' };
    bookmarkSort = r.data;
    saveSettings(settingsFile, settings);
    return { ok: true, mode: bookmarkSort, tree: sortTree(bookmarks.tree(), bookmarkSort) };
  });
  on('bookmarks:tree-sorted', () => ({ roots: sortTree(bookmarks.tree(), bookmarkSort), showBar: bookmarks.showBar, sort: bookmarkSort }));
  on('bookmarks:trash', () => ({ entries: bookmarkTrash.list().map((e) => ({ id: e.node.id, title: e.node.title, type: e.node.type, deletedAt: e.deletedAt })), count: bookmarkTrash.count() }));
  on('bookmarks:trash-restore', (_e, id: unknown) => {
    const e = bookmarkTrash.get(String(id));
    if (!e) return { ok: false, error: 'not in the trash' };
    const parent = bookmarks.tree().find((f) => f.id === e.parentId) ?? bookmarks.tree()[0];
    bookmarkTrash.remove(e.node.id);
    // restore through the ordinary add path so the store's own validation still applies
    const n = e.node;
    if (n.type === 'bookmark') return wrap(() => bookmarks.addBookmark(parent.id, n.title, n.url));
    return wrap(() => bookmarks.addFolder(parent.id, e.node.title));
  });
  on('bookmarks:trash-empty', (_e, confirm: unknown) => {
    const r = bookmarkTrash.empty(confirm === true);
    audit.write('bundle', { taskId: current?.task.id, action: 'empty bookmarks trash', wouldDiscard: r.wouldDiscard, ok: r.ok });
    return r;
  });
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
  /** a URL handed over by the OS (desktop entry / second instance): a new tab, normal navigation path */
  openUrl: (url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    const t = tabs.create(url);
    t.navSource = 'user';
  },
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
  /** the ONE action dispatcher: the menu, the palette and the chords all land here, so a menu item
   *  can never do something a chord cannot */
  runAction: (action: string) => runAction(action),
  /** the chord table (for menu accelerators) */
  chordTable: () => chordTable(),
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
// Created BEFORE the UI loads: the renderer calls tabs/panels/hibernation handlers during
// boot, and any handler that runs before this assignment sees `tabs === undefined`.
tabs = new TabManager(win, ses, () => sendUI('tabs', tabs.list()), setupTab);
await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
// Every close — including close-others and close-right — lands on the closed-tab stack once.
tabs.onTabClosed = (url, title, pos) => {
  closedTabs.push(url, title, pos);
  sendUI('closed-tabs', closedTabs.list());
  saveSessionSoon();
};
tabs.onGeometry = (g) => sendUI('geometry', g);
installShortcuts(win.webContents);
// Start where the user left off when the profile says so; a crashed exit restores regardless, so
// work is not lost silently. Every restored tab is a NEW tab (ungated by construction).
const restore = settings.general.startup === 'last-session' || sessionState.crashed;
const saved = restore ? sessionState.restorableTabs() : null;
if (saved?.tabs.length) {
  tabs.restore(saved.tabs, saved.activeIndex, sessionState.restorableTiles(saved.tabs));
  if (sessionState.crashed) audit.write('navigation', { url: '', by: 'user', restore: 'after unclean exit', tabs: saved.tabs.length });
} else {
  tabs.create(ctx.startUrl || tabStartUrl());
}
if (sessionState.crashed) sendUI('session:crashed', { tabs: saved?.tabs.length ?? 0 });
sendUI('state', state());
// restore the saved web panels: each one is a fresh WebContents, so none of them carries gate state
for (const p of settings.general.webPanels) openPanel(p.url);
sendUI('panels:list', panelState());
// The rail sizes the column from the window, so it needs one push with real geometry. This is the
// same channel a settings change uses, so there is a single source of truth for panel state.
sendUI('panels', {
  railVisible: settings.general.railVisible,
  statusBar: settings.general.statusBar,
  tabStrip: settings.general.tabStrip,
  inset: tabs.insets(),
});

function windowTitle() {
  return `Guarded Browser — ${profile().name}`;
}

async function dispose() {
  if (disposed) return;
  disposed = true;
  // a clean exit marks the session clean, so the next launch does not show a crash notice
  try {
    const list = tabs?.list() ?? [];
    const activeIndex = Math.max(0, list.findIndex((t) => t.active));
    const tiles = tabs?.tileState();
    const tiling = tiles
      ? {
          indexes: tiles.ids.map((id) => list.findIndex((t) => t.id === id)).filter((i) => i >= 0),
          layout: tiles.layout,
          ratios: tiles.ratios,
        }
      : null;
    sessionState.save(
      list.map((t) => ({ url: t.url, title: t.title })),
      activeIndex,
      tiling && tiling.indexes.length >= 2 ? tiling : null,
      true,
    );
  } catch {
    /* best effort: a failure here must never block quitting */
  }
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

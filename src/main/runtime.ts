// One profile = one Chromium session partition + one app-state directory + one window.
// Everything in here (settings, audit log, egress proxy and allowlist, taint registry, approvals,
// post-task guards, confirmation queue, tabs, agent task) exists once PER PROFILE. Only the guard
// model and the public reputation feeds are shared (passed in through the context). IPC handlers
// are looked up by main.ts from the SENDER's window, never from an id the renderer sends.

import { app, BrowserWindow, dialog, safeStorage, session, shell, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { AgentTask } from '../core/agent';
import { AuditLog } from '../core/audit';
import { loadSettings, saveSettings, type Role, type Settings } from '../core/config';
import { EgressController, hostKey, startProxy, type ProxyHandle } from '../core/egress';
import { LlmClient, StreamingLlmClient } from '../core/llm';
import { originOf, originsInTask } from '../core/policy';
import { LocalLists, type FeedConfig, type ReputationChecker, type ReputationDb } from '../core/reputation';
import type { ConfirmRequest, Guard } from '../core/types';
import { ConfirmBroker } from './confirm';
import { ElectronDriver, TabManager, type Tab } from './tabs';
import { ISOLATED_WORLD } from './page-scripts';
import { BUILTIN_THEMES, ThemeSchema, parseColor, toHex, type Theme } from '../core/theme';
import type { Profile } from './profiles';
import { testEnv } from './test-hooks';
// ticket 37c: the mail controller is per PROFILE and its handlers live on this runtime's `on()` table,
// so the chrome resolves them from the sending window exactly like every other chrome channel.
import { MailController } from './mail/controller';
import { MailHtmlView } from './mail/html-view';
import { HistoryStore, recordable } from '../core/history';
import { ClosedTabStore } from '../core/closed-tabs';
import { SessionStore } from '../core/session-state';
import { ZoomStore } from '../core/zoom';
import { DownloadList, uniquePath } from '../core/downloads';
import { BookmarkStore } from '../core/bookmarks';
import { SavedSessionStore } from '../core/saved-sessions';
import { TrashStore, type SortMode } from '../core/bookmarks-panel';
import { WorkspaceStore } from '../core/workspaces';
import { StackModel } from '../core/tab-stacks';
import { PageActionsStore, pageActionCss, affectsAgentSnapshot, describePageActions } from '../core/page-actions';
import { planSweep, decideHibernation, type HibernationFacts } from '../core/hibernation';
import { ACTION_LABELS, formatChord } from '../core/keybindings';
import type { Point } from '../core/gestures';
import type { PaletteItem } from '../core/quick-commands';
import { ExtensionList, extensionListFile } from './extensions';
import { createEgressWiring, PROCEED_PREFIX } from './runtime/egress-wiring';
import { createChords } from './runtime/chords';
import type { RuntimeDeps } from './runtime/deps';
import { register as registerTabsIpc } from './runtime/ipc-tabs';
import { register as registerLibraryIpc } from './runtime/ipc-library';
import { register as registerSettingsIpc } from './runtime/ipc-settings';
import { register as registerAgentIpc } from './runtime/ipc-agent';
import { register as registerMailIpc } from './runtime/ipc-mail';
import { register as registerMiscIpc } from './runtime/ipc-misc';
import { register as registerXrayIpc } from './runtime/ipc-xray';
import { register as registerChatIpc } from './runtime/ipc-chat';
import { TabHostLog } from '../core/xray';

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
  /** set when userData/shared.json was unreadable at startup and was quarantined */
  sharedLoadError: () => string | null;
  onFeedsChange: (fn: () => void) => () => void;
  startUrl?: string;
  onClosed: () => void;
  register: (rt: Runtime) => void;
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export async function createRuntime(ctx: RuntimeContext) {
const handlers: Record<string, Handler> = {};
/** the rail badge's number: unread-ish mail across this profile's accounts */
let mailUnreadCount = 0;
let mailController: MailController | null = null;
/** the HTML reading view (src/main/mail/html-view.ts): one per window, created on first use */
let mailView: MailHtmlView | null = null;
/** TEST ONLY. Bypasses the policy engine and judge so tests can show the egress layer holds alone. */
const POLICY_DISABLED = testEnv('GUARDED_UNSAFE_DISABLE_POLICY') === '1';
/** TEST ONLY: the PEM of a throwaway CA for the e2e fake mail servers on 127.0.0.1 (see socket.ts testCa) */
function mailTestCa(): string | undefined {
  const file = testEnv('GUARDED_TEST_MAIL_CA');
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const { profile, dir: profileDir, guard, feeds } = ctx;
// read synchronously, before any await: this runtime only ever uses ITS profile's partition
const partition = profile().partition;
const settingsFile = join(profileDir, 'settings.json');
/**
 * One line per store file that was unreadable at load and was moved aside (core/persist.ts). Shown
 * in the chrome's status bar so the user knows where their data went instead of finding it empty.
 */
const storeErrors: string[] = [];
const noteLoadError = (e: string | null) => {
  if (e) storeErrors.push(e);
};
noteLoadError(ctx.sharedLoadError());
let settings: Settings = loadSettings(settingsFile, { onLoadError: noteLoadError });
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
const loadedStacks = StackModel.load(join(profileDir, 'tab-stacks.json'));
const stacks = loadedStacks.model;
// Per-origin page transforms (ticket 27). The applied set is agent-visible state, so it is audited.
const pageActions = new PageActionsStore(join(profileDir, 'page-actions.json'));
// Bookmarks panel extras: sort mode + a Trash that never discards silently (ticket 33).
const bookmarkTrash = new TrashStore(join(profileDir, 'bookmarks-trash.json'));
// Unpacked extensions (ticket 32). Outside the threat model — see the warning in extensions.ts.
const extensions = new ExtensionList(extensionListFile(profileDir));
for (const e of [history, bookmarks, closedTabs, sessionState, zoom, savedSessions, workspaces, loadedStacks, pageActions, bookmarkTrash, extensions]) noteLoadError(e.loadError);
/** last activation time per tab id, for the hibernation sweep (ticket 23) */
const activatedAt = new Map<number, number>();
/** gesture trail from the MAIN process's own input events; never page-reported (ticket 16) */
let gestureTrail: Point[] = [];
/** the bookmarks panel's sort mode (ticket 33); presentation only */
let bookmarkSort: SortMode = 'manual';
/** favicon bytes by origin (in memory only; decoded in the sandboxed renderer) */
const faviconCache = new Map<string, { mime: string; data: string }>();
/** hosts each tab's pages requested, for the Injection X-ray (in memory, forgotten with the tab) */
const tabHosts = new TabHostLog();
/** the Injection X-ray (src/main/runtime/ipc-xray.ts); created with the IPC handlers */
let xray: ReturnType<typeof registerXrayIpc> | null = null;
/** the AI chat (src/main/runtime/ipc-chat.ts): per-tab conversations, in memory only */
let chat: ReturnType<typeof registerChatIpc> | null = null;
const reputation: ReputationChecker = { check: (h) => feeds.check(h, localLists) };
let current: { task: AgentTask; tab: Tab } | null = null;
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

/**
 * The runtime as the split-out pieces (src/main/runtime/*.ts) see it. Reassigned variables are
 * exposed as getters so every piece reads the live value.
 */
const rt: RuntimeDeps = {
  get settings() {
    return settings;
  },
  set settings(v) {
    settings = v;
  },
  get tabs() {
    return tabs;
  },
  get win() {
    return win;
  },
  get audit() {
    return audit;
  },
  get egress() {
    return egress;
  },
  get broker() {
    return broker;
  },
  get current() {
    return current;
  },
  get deniedFlows() {
    return deniedFlows;
  },
  get gestureTrail() {
    return gestureTrail;
  },
  set gestureTrail(v) {
    gestureTrail = v;
  },
  get bookmarkSort() {
    return bookmarkSort;
  },
  set bookmarkSort(v) {
    bookmarkSort = v;
  },
  ctx,
  handlers,
  profileDir,
  settingsFile,
  feeds,
  localLists,
  reputation,
  history,
  bookmarks,
  bookmarkTrash,
  closedTabs,
  sessionState,
  zoom,
  downloads,
  savedSessions,
  workspaces,
  stacks,
  pageActions,
  extensions,
  faviconCache,
  get lastFindQuery() {
    return lastFindQuery;
  },
  tabHosts,
  sendUI,
  state,
  reputationState,
  stopTask,
  startTask,
  previewOrigins,
  closeTab,
  reopenClosed,
  liftGateOnCommit,
  printTab,
  saveSessionSoon,
  updateSiteAccent,
  importTheme,
  applyPageActions,
  commandItems,
  hibernationSweep,
  scheduleHibernation,
  // declared further down (const arrows / destructured): reached lazily, after they exist
  panelState: () => panelState(),
  openPanel: (url) => openPanel(url),
  runChord: (input) => runChord(input),
  runAction: (action) => runAction(action),
  toggleXray: () => xray?.toggleActive(),
  chatClient: () => new StreamingLlmClient('chat', () => settings.models.chat, onRoleFallback),
  chordTable: () => chordTable(),
  mail: () => api.mail(),
  mailView: () => api.mailView(),
};
const { setupEgress, sourceOf, handleProceed } = createEgressWiring(rt);
const { installShortcuts, runChord, runAction, chordTable, tabStartUrl } = createChords(rt);

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
    storeErrors,
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

/** a role switched to (or back from) its cloud fallback: banner + audit, the same for every role */
function onRoleFallback(r: string, active: boolean, reason: string) {
  const was = fallbackActive[r as Role];
  if (active) fallbackActive[r as Role] = reason;
  else delete fallbackActive[r as Role];
  if (!!was !== active) {
    if (active) audit.write('fallback', { role: r, reason });
    sendUI('fallback', fallbackActive);
  }
}
const llm = (role: Role) => new LlmClient(role, () => settings.models[role], onRoleFallback);

/**
 * The user is taking a gated tab back. The gate is NOT lifted here: lifting before loadURL / goBack
 * left the gated document running ungated until it unloaded, so its pagehide could sendBeacon or
 * keepalive-POST freely. did-navigate lifts it on commit (see there).
 */
function liftGateOnCommit(t: Tab) {
  if (tabs.isGated(t.id)) t.gateLiftPending = { leaving: originOf(t.wc.getURL()) };
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
  // no forgetTab() here: tabs.close() forgets the gate AND tombstones it before wc.close() runs the
  // document's pagehide (forgetting first let a pagehide beacon leave ungated)
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
  // the X-ray's per-tab state and host log go with the tab
  const wcId = wc.id;
  wc.once('destroyed', () => {
    tabHosts.forget(wcId);
    xray?.forget(tab.id);
    chat?.forget(tab.id);
  });
  // a committed navigation (new document, or in-page) clears the tab's X-ray
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    if (isMainFrame) xray?.onNavigate(tab);
  });
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
    xray?.onNavigate(tab);
    if (current?.tab === tab) {
      const o = originOf(url);
      if (o) tabs.addGuardOrigin(tab.id, o);
    }
    // who started it: 'page' (renderer-initiated: will-navigate fired, or a popup tab), 'agent' (the
    // driver's navigate), otherwise 'user' (address bar, new tab, back / forward / reload)
    const by = tab.navSource ?? 'user';
    tab.navSource = undefined;
    // The user's navigation of a gated tab has committed: only now is the gated document gone, so
    // only now does the gate lift (tombstoned for its late pagehide beacons). Anything else that
    // commits instead (the page moved itself first) cancels the pending lift: the gate stays.
    const lift = tab.gateLiftPending;
    tab.gateLiftPending = undefined;
    if (lift && by === 'user' && !current) tabs.liftGateOnCommit(tab.id, lift.leaving, originOf(url));
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
  // the mail gate refuses new connections from here on; drop the ones opened before the task
  mailController?.disconnectAll();
  // and a remote-image allowance in the mail HTML view ends: the message reloads blocked
  mailView?.revokeRemote();
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
  registerTabsIpc(on, rt);
  registerLibraryIpc(on, rt);
  registerSettingsIpc(on, rt);
  registerAgentIpc(on, rt);
  registerMailIpc(on, rt);
  registerMiscIpc(on, rt);
  xray = registerXrayIpc(on, rt);
  chat = registerChatIpc(on, rt);
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

broker = new ConfirmBroker((channel, payload) => {
  sendUI(channel, payload);
  // a pending confirmation is chrome UI a native view must never cover
  mailView?.update();
}, () => settings.agent.confirmTimeoutMs);
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
  /** the per-profile mail controller (ticket 37c). Created on first use. */
  mail(): MailController {
    mailController ??= new MailController({
      profileDir,
      // rule 4: no mail network activity (sync, fetch, flag, move, SEND, APPEND) while an agent task runs
      // or a confirmation dialog is pending
      canConnect: () =>
        current
          ? { ok: false, reason: 'an agent task is running: mail will not connect while it does' }
          : broker.pendingCount() > 0
            ? { ok: false, reason: 'a confirmation is pending: mail will not connect until it is answered' }
            : { ok: true },
      audit: (kind, detail) => audit.write(kind as Parameters<AuditLog['write']>[0], detail),
      sendUnread: (n) => {
        mailUnreadCount = Math.max(0, Math.floor(n) || 0);
        sendUI('mail', { unread: mailUnreadCount });
      },
      // the real backend name, so "no keyring" names what Electron actually reports
      safeStorage,
      // TEST ONLY (GUARDED_TEST=1, unpackaged): trust a throwaway CA for loopback fake mail servers;
      // certificate verification itself stays on
      testTlsCa: mailTestCa(),
      // ticket 41: an attachment the user clicked goes through the browser's download path — the same
      // folder rule as a confirmed agent download (the downloads folder, a unique name, never an
      // overwrite) and the same downloads list with its dangerous-file warning. Written 0600.
      saveDownload: ({ name, mime, bytes }) => {
        const dir = testEnv('GUARDED_DOWNLOAD_DIR') || app.getPath('downloads');
        try {
          mkdirSync(dir, { recursive: true });
          for (let tries = 0; ; tries++) {
            const dest = uniquePath(dir, name);
            try {
              writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
            } catch (e) {
              // a file appeared under that name between the check and the write: take the next one
              if ((e as { code?: string }).code === 'EEXIST' && tries < 20) continue;
              rmSync(dest, { force: true });
              throw e;
            }
            chmodSync(dest, 0o600);
            downloads.addFile({ filename: name, host: 'mail attachment', path: dest, bytes: bytes.length, mime });
            return { ok: true as const, path: dest };
          }
        } catch (e) {
          return { ok: false as const, error: `the file could not be saved: ${String((e as Error).message).slice(0, 120)}` };
        }
      },
      // "Open": a native dialog that names the file and its type; an executable / script needs the
      // extra checkbox ticked as well as the Open button
      confirmOpen: async ({ name, mime, warning, executable }) => {
        if (win.isDestroyed()) return false;
        const r = await dialog.showMessageBox(win, {
          type: executable ? 'warning' : 'question',
          buttons: ['Cancel', 'Open'],
          defaultId: 0,
          cancelId: 0,
          title: 'Open attachment',
          message: `Open "${name}" (${mime}) with the system's default application?`,
          detail: `${warning ? `WARNING: ${warning}.\n\n` : ''}It came from an email: open it only if you trust the sender and expected this file.`,
          ...(executable ? { checkboxLabel: 'I understand this file can run programs on this computer', checkboxChecked: false } : {}),
          noLink: true,
        });
        return r.response === 1 && (!executable || r.checkboxChecked === true);
      },
      openPath: (p) => shell.openPath(p),
      // "Attach…": the system file dialog, in MAIN. TEST ONLY (GUARDED_TEST=1, unpackaged): a fixed
      // file instead of the dialog, so the e2e can attach without driving a native window.
      pickFiles: async () => {
        const fixed = testEnv('GUARDED_TEST_ATTACH_FILE');
        if (fixed) return [fixed];
        if (win.isDestroyed()) return [];
        const r = await dialog.showOpenDialog(win, { title: 'Attach files', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
        return r.canceled ? [] : r.filePaths;
      },
    });
    return mailController;
  },
  /** this window's mail HTML view. Not a tab: no TabManager entry, no driver, no preload, no IPC. */
  mailView(): MailHtmlView {
    mailView ??= new MailHtmlView({
      win,
      // in-memory (no `persist:`), and distinct from every tab's partition
      partition: `mailview-${profile().id}`,
      html: (id) => api.mail().htmlFor(id),
      // a link in a message: a NEW normal tab through the user navigation path (reputation, proxy, gates)
      // ...and the full-width mail panel steps aside, or the new tab would open unseen behind it
      openLink: (url) => {
        api.openUrl(url);
        sendUI('shortcut', 'close-mail');
      },
      canConnect: () =>
        current
          ? { ok: false, reason: 'an agent task is running: remote content stays blocked until it ends' }
          : broker.pendingCount() > 0
            ? { ok: false, reason: 'a confirmation is pending: remote content stays blocked until it is answered' }
            : { ok: true },
      chromeBusy: () => !!tabs?.overlayOn || broker.pendingCount() > 0,
      reputationListed: (url) => !!reputation.check(url)?.listed,
      audit: (detail) => audit.write('mail' as Parameters<AuditLog['write']>[0], detail),
      allowLoopbackForTest: testEnv('GUARDED_TEST_MAIL_LOOPBACK') === '1',
      // ticket 41: cid: images are parts of the message, fetched by main through the mail gate
      inlineImages: (id) => api.mail().inlineImages(id),
    });
    return mailView;
  },
  /** the last unread count pushed to the rail badge (ticket 37); the controller owns updating it */
  mailUnread() {
    return mailUnreadCount;
  },
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
tabs.onGeometry = (g) => {
  sendUI('geometry', g);
  // every layout (overlay on/off included) re-derives the mail HTML view's visibility
  mailView?.update();
};
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
  // drop mail connections and the sqlite handle with the window (ticket 37c)
  try {
    mailView?.dispose();
    mailController?.dispose();
  } catch {
    /* nothing to release */
  }
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

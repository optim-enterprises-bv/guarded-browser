// Electron main process: profiles (one window + session + app-state dir each, see runtime.ts),
// the shared guard model and public reputation feeds, IPC dispatch by SENDER, the Profiles menu.

import { app, ipcMain, Menu, session, BrowserWindow, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { loadSettings } from '../core/config';
import { atomicWriteFile, loadJson } from '../core/persist';
import { NullGuard, TransformersGuard } from '../core/guard';
import { DEFAULT_FEEDS, HostSet, ReputationDb, type FeedBuilder, type FeedConfig } from '../core/reputation';
import type { Guard } from '../core/types';
import { PROFILE_COLORS, ProfileRegistry, partitionDir, type Profile } from './profiles';
import { createRuntime, type Runtime } from './runtime';

import { GUARD_MODEL, ensureModel } from './model-store';
import { testEnv } from './test-hooks';
import { RUNTIME_CHANNELS } from '../shared/ipc';

// user data: ~/.config/guarded-browser (the package's product name would otherwise make it
// "~/.config/Guarded Browser"); GUARDED_USER_DATA picks another directory
app.setPath('userData', process.env.GUARDED_USER_DATA || join(app.getPath('appData'), 'guarded-browser'));

// one instance per user-data directory; a second launch (e.g. a link opened from another app)
// hands its http(s) URL to the running instance
const urlArg = (argv: string[]) => argv.slice(1).find((a) => /^https?:\/\/\S+$/i.test(a) && a.length < 4096);
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', (_e, argv) => {
  const rt = runtimeOfUi(BrowserWindow.getFocusedWindow()?.webContents as WebContents) ?? [...runtimes.values()][0];
  if (!rt) return;
  const u = urlArg(argv);
  if (u) rt.openUrl(u);
  if (!rt.win.isDestroyed()) {
    if (rt.win.isMinimized()) rt.win.restore();
    rt.win.focus();
  }
});

// A bug in one handler must not take every profile's window down: log it (stderr + every open
// profile's audit log) and keep running.
function logProcessError(kind: string, err: unknown) {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`[guarded-browser] ${kind}: ${msg}\n${err instanceof Error ? err.stack ?? '' : ''}\n`);
  for (const r of runtimes.values()) {
    try {
      r.audit('error', { where: kind, error: msg.slice(0, 500) });
    } catch {
      /* the audit log itself failed */
    }
  }
}
process.on('uncaughtException', (e) => logProcessError('uncaughtException', e));
process.on('unhandledRejection', (e) => logProcessError('unhandledRejection', e));

// No speculative DNS / connections: with a proxy configured these are the remaining ways a page
// could make the network layer touch a host it names.
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-features', 'Prerender2,SpeculationRulesPrefetchFuture,NoStatePrefetchHoldback,PreconnectToSearch,LoadingPredictorPrefetch');

/** profile id -> its open runtime (window) */
// (declared before use by the process-level error handler above)
const runtimes = new Map<string, Runtime>();
const opening = new Map<string, Promise<Runtime>>();
let registry: ProfileRegistry;
let guard: Guard;
let feeds: ReputationDb;
let quitting = false;

// ---------- shared, public / read-only data ----------

const GuardSharedSchema = z.object({ enabled: z.boolean(), model: z.string().max(200), threshold: z.number().min(0).max(1), threads: z.number().int().min(1).max(16) }).strict();
type GuardShared = z.infer<typeof GuardSharedSchema>;
let sharedGuard: GuardShared;

const FeedListSchema = z.array(
  z.object({ name: z.string().max(80), url: z.string().max(2000), format: z.enum(['domains', 'hosts', 'urls']), enabled: z.boolean() }).strict(),
).max(50);
/** the outer shape of shared.json; each field is validated on its own and falls back on its own */
const SharedFileSchema = z.object({ reputationFeeds: z.unknown().optional(), guard: z.unknown().optional() }).passthrough();
let sharedFile = '';
/** set when shared.json was unreadable at startup; every profile window reports it */
let sharedLoadError: string | null = null;
let sharedFeeds: FeedConfig[] = DEFAULT_FEEDS;
const feedListeners = new Set<() => void>();

/**
 * App-wide settings (userData/shared.json): the reputation feed list and the guard model settings.
 * They apply to ALL profiles; every profile's Settings shows and edits the same values.
 */
function loadShared(ud: string, fallbackFeeds: FeedConfig[], fallbackGuard: GuardShared) {
  sharedFile = join(ud, 'shared.json');
  // an unreadable file is kept aside (shared.json.corrupt-<time>), never overwritten by the defaults
  const loaded = loadJson(sharedFile, SharedFileSchema, { fallback: {} });
  sharedLoadError = loaded.loadError;
  const raw = loaded.value;
  const f = FeedListSchema.safeParse(raw.reputationFeeds);
  const g = GuardSharedSchema.safeParse(raw.guard);
  sharedFeeds = f.success ? f.data : fallbackFeeds;
  sharedGuard = g.success ? g.data : fallbackGuard;
  writeShared();
}

function writeShared() {
  atomicWriteFile(sharedFile, JSON.stringify({ reputationFeeds: sharedFeeds, guard: sharedGuard }, null, 2) + '\n');
}

function saveSharedFeeds(f: FeedConfig[]) {
  const r = FeedListSchema.safeParse(f);
  if (!r.success) return;
  sharedFeeds = r.data;
  writeShared();
  feeds?.setFeeds(sharedFeeds);
  void feeds?.refresh();
}

function saveSharedGuard(g: unknown) {
  const r = GuardSharedSchema.safeParse(g);
  if (!r.success) return;
  sharedGuard = r.data;
  writeShared(); // model changes take effect after a restart (one model for all profiles)
}

// ---------- profiles ----------

function runtimeOfUi(wc: WebContents): Runtime | undefined {
  return [...runtimes.values()].find((r) => r.isUi(wc));
}

function profilesState() {
  return registry.list().map((p) => ({ id: p.id, name: p.name, color: p.color, open: runtimes.has(p.id) }));
}

/** Every profile's proxy refuses every profile's proxy port (its own included) as a destination. */
function refreshRefusedPorts() {
  const ports = [...runtimes.values()].map((r) => r.proxyPort);
  for (const r of runtimes.values()) r.setRefusedPorts(ports);
}

function broadcastProfiles() {
  for (const r of runtimes.values()) {
    r.profileChanged();
    if (!r.win.isDestroyed()) r.win.webContents.send('profiles', profilesState());
  }
  buildMenu();
}

/**
 * A private window (ticket 18/30): a fresh EPHEMERAL profile. It is a real profile — same gate, same
 * proxy, same allowlist — whose partition is discarded on close, so nothing is carried between one
 * private window and the next. It is deliberately NOT a "no security" mode.
 */
async function openPrivateWindow(): Promise<void> {
  const p = registry.create(`Private ${registry.list().length + 1}`, undefined, { ephemeral: true });
  await openProfile(p.id);
}

async function openProfile(id: string, startUrl?: string): Promise<Runtime> {
  const existing = runtimes.get(id);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.show();
    existing.win.focus();
    return existing;
  }
  const pending = opening.get(id);
  if (pending) return pending;
  const initial = registry.get(id);
  if (!initial) throw new Error('no such profile');
  // the LAST known record of THIS profile: never another profile's partition as a fallback
  let last: Profile = initial;
  const p = (async () => {
    const rt = await createRuntime({
      profile: () => (last = registry.get(id) ?? last),
      exists: () => !!registry.get(id),
      dir: registry.dirOf(id),
      guard,
      feeds,
      sharedFeeds: () => sharedFeeds,
      setSharedFeeds: saveSharedFeeds,
      sharedGuard: () => sharedGuard,
      setSharedGuard: saveSharedGuard,
      sharedLoadError: () => sharedLoadError,
      onFeedsChange: (fn) => {
        feedListeners.add(fn);
        return () => feedListeners.delete(fn);
      },
      startUrl,
      register: (rt) => {
        runtimes.set(id, rt);
        refreshRefusedPorts();
      },
      onClosed: () => {
        runtimes.delete(id);
        refreshRefusedPorts();
        if (!quitting) broadcastProfiles();
      },
    });
    runtimes.set(id, rt);
    broadcastProfiles();
    return rt;
  })();
  opening.set(id, p);
  try {
    return await p;
  } finally {
    opening.delete(id);
  }
}

/**
 * Delete a profile: confirmed in the REQUESTING window (locked dialog), never the last profile.
 * Closes its window, wipes the Chromium session (storage + cache), then removes the partition
 * directory and the profile's app-state directory, and retires the partition name.
 */
async function deleteProfile(id: string, requester: Runtime): Promise<{ ok: boolean; error?: string }> {
  const p = registry.get(id);
  if (!p) return { ok: false, error: 'no such profile' };
  if (registry.list().length <= 1) return { ok: false, error: 'the last profile cannot be deleted' };
  const outcome = await requester.confirm({
    id: `p${Date.now().toString(36)}`,
    kind: 'profile',
    action: `delete profile "${p.name}"`,
    target: p.name,
    values: [],
    reasons: ['all of this profile’s cookies, site data, cache, settings, themes and audit logs will be deleted', 'this cannot be undone'],
  });
  if (outcome !== 'approve') return { ok: false, error: `not deleted (${outcome})` };
  const rt = runtimes.get(id);
  if (rt) {
    await rt.dispose();
    if (!rt.win.isDestroyed()) rt.win.destroy();
    runtimes.delete(id);
  }
  const ses = session.fromPartition(p.partition);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache().catch(() => undefined);
  await ses.closeAllConnections().catch(() => undefined);
  await ses.flushStorageData?.();
  const pdir = partitionDir(app.getPath('userData'), p.partition);
  rmSync(pdir, { recursive: true, force: true });
  rmSync(registry.dirOf(id), { recursive: true, force: true });
  registry.remove(id);
  // Chromium can still flush a file into the directory after the wipe: remove it again shortly after
  setTimeout(() => rmSync(pdir, { recursive: true, force: true }), 1500);
  broadcastProfiles();
  return { ok: true };
}

// ---------- IPC: every handler is resolved from the SENDER's window ----------

// The channel lists live in src/shared/ipc.ts (the same registry the preload exposes).

function registerIpc() {
  for (const ch of RUNTIME_CHANNELS) {
    ipcMain.handle(ch, (e, ...args: unknown[]) => {
      // which profile? the one that owns the sending window. Any profile id in args is ignored.
      const rt = runtimeOfUi(e.sender);
      const h = rt?.handlers[ch];
      if (!rt || !h) throw new Error('unknown sender');
      return h(e, ...args);
    });
  }
  ipcMain.on('tab:agent-active', (e) => {
    const rt = [...runtimes.values()].find((r) => r.ownsWebContents(e.sender));
    e.returnValue = rt ? rt.handlers['tab:agent-active'](e) === true : false;
  });

  const NameSchema = z.string().trim().min(1).max(40);
  const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
  const requester = (e: Electron.IpcMainInvokeEvent) => {
    const rt = runtimeOfUi(e.sender);
    if (!rt) throw new Error('unknown sender');
    return rt;
  };
  ipcMain.handle('profiles:list', (e) => {
    requester(e);
    return profilesState();
  });
  ipcMain.handle('profiles:create', (e, name: unknown, color: unknown) => {
    requester(e);
    const n = NameSchema.safeParse(name);
    if (!n.success) return { ok: false, error: 'name must be 1-40 characters' };
    try {
      const p = registry.create(n.data, ColorSchema.safeParse(color).success ? String(color) : PROFILE_COLORS[registry.list().length % PROFILE_COLORS.length]);
      broadcastProfiles();
      return { ok: true, id: p.id };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  });
  ipcMain.handle('profiles:update', (e, id: unknown, patch: unknown) => {
    requester(e);
    const pt = (patch ?? {}) as { name?: unknown; color?: unknown };
    try {
      registry.update(String(id), {
        ...(pt.name !== undefined ? { name: NameSchema.parse(pt.name) } : {}),
        ...(pt.color !== undefined ? { color: ColorSchema.parse(pt.color) } : {}),
      });
      broadcastProfiles();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  });
  ipcMain.handle('profiles:open', async (e, id: unknown) => {
    requester(e);
    await openProfile(String(id));
    return { ok: true };
  });
  ipcMain.handle('profiles:delete', (e, id: unknown) => deleteProfile(String(id), requester(e)));
}

/**
 * The application menu (ticket 11). Every item that changes browser state goes through the runtime's
 * ONE action dispatcher (`api.runAction`), which is the same path a chord and the palette use — so a
 * menu item cannot reach anything a chord cannot, and the chord table stays the single source of
 * truth for what an action is called and what key it has.
 *
 * Accelerators are taken from the chord table, so rebinding a chord (ticket 15) moves the menu item
 * with it instead of leaving a stale label.
 */
function buildMenu() {
  const focused = () => runtimeOfUi(BrowserWindow.getFocusedWindow()?.webContents as WebContents) ?? [...runtimes.values()][0];
  /** an action item: label from the chord table's accelerator, disabled when there is no runtime */
  const act = (label: string, action: string): Electron.MenuItemConstructorOptions => ({
    label,
    click: () => void focused()?.runAction(action),
  });
  const tpl: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'close', label: 'Close Window' },
        { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => void focused()?.runAction('view.find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        act('New Tab', 'tab.new'),
        act('Reload', 'tab.reload'),
        act('Zoom In', 'view.zoomIn'),
        act('Zoom Out', 'view.zoomOut'),
        act('Reset Zoom', 'view.zoomReset'),
        { type: 'separator' },
        act('Toggle Tiling', 'tiles.tile'),
        act('Untile', 'tiles.untile'),
        { type: 'separator' },
        act('History Panel', 'panel.history'),
        act('Bookmarks Panel', 'panel.bookmarks'),
        act('Downloads Panel', 'panel.downloads'),
        { type: 'separator' },
        act('X-ray', 'view.xray'),
        act('AI Chat', 'view.chat'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        act('Quick Commands…', 'palette.open'),
        act('Reader Mode', 'reader.toggle'),
        act('Translate Page', 'view.translate'),
        act('Mail', 'mail.open'),
        act('Capture Page…', 'capture.visible'),
        act('Print…', 'view.print'),
        { type: 'separator' },
        // a private window is app-level (it creates a PROFILE), not a browser action, so it goes to
        // the profile registry rather than the action dispatcher
        { label: 'New Window (private)', click: () => void openPrivateWindow() },
      ],
    },
    {
      label: 'Profiles',
      submenu: [
        { label: 'Manage profiles…', click: () => focused()?.win.webContents.send('profiles:show-manager', null) },
        { type: 'separator' },
        ...registry.list().map((p) => ({ label: `Open "${p.name}" in new window`, click: () => void openProfile(p.id) })),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard shortcuts', click: () => focused()?.win.webContents.send('shortcut', 'settings-keybindings') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------- startup ----------

app.whenReady().then(async () => {
  const ud = app.getPath('userData');
  const freshMigration = !existsSync(join(ud, 'profiles.json'));
  registry = new ProfileRegistry(ud); // first run: creates the default profile, migrating old data
  const first = registry.list()[0];
  // stray single-profile files after migration are quarantined, never ignored or used
  const strays = freshMigration ? { dir: '', moved: [] as string[] } : registry.quarantineStrays();
  // deleted profiles' partition directories that reappeared (late Chromium flush) are removed
  const swept = registry.sweepRetired();
  // app-wide settings; on migration they come from the old single-profile settings
  const firstSettings = loadSettings(join(registry.dirOf(first.id), 'settings.json'));
  loadShared(ud, firstSettings.reputation.feeds, firstSettings.guard);

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
  // public feed cache: shared by all profiles (their local lists are per profile)
  feeds = new ReputationDb(join(ud, 'reputation'), sharedFeeds, undefined, workerBuilder, false);
  let repTimer: NodeJS.Timeout | null = null;
  feeds.onChange(() => {
    repTimer ??= setTimeout(() => {
      repTimer = null;
      for (const l of feedListeners) l();
    }, 250);
  });
  setImmediate(() => feeds.start());

  // the guard model holds no user data: one instance for all profiles, app-wide settings
  const guardSettings = sharedGuard;
  if (process.env.GUARDED_GUARD === 'off' || !guardSettings.enabled) {
    guard = new NullGuard(process.env.GUARDED_GUARD === 'off' ? 'guard unavailable: disabled by GUARDED_GUARD=off' : 'guard unavailable: disabled in settings');
  } else {
    // The model is not in the package: copied from a local cache / offline bundle or downloaded at a
    // pinned revision, and verified against pinned sha256 checksums before it is loaded.
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const modelRoot = testEnv('GUARDED_MODEL_DIR') || join(dataHome, 'guarded-browser', 'models');
    const sources = [testEnv('GUARDED_MODEL_CACHE'), join(homedir(), '.cache', 'guarded-browser', 'models'), app.isPackaged ? join(process.resourcesPath, 'models') : undefined].filter((x): x is string => !!x);
    let lastSent = 0;
    const g = new TransformersGuard({
      ...guardSettings,
      enabled: true,
      prepare: async (setDetail) => {
        if (guardSettings.model !== GUARD_MODEL.id) return { ok: false, error: `only the pinned model ${GUARD_MODEL.id} is supported` };
        return ensureModel(GUARD_MODEL, {
          root: modelRoot,
          sources,
          downloadBase: 'https://huggingface.co',
          onProgress: (p) => {
            setDetail(`guard model ${p.phase} ${Math.floor((100 * p.done) / p.total)}%`);
            if (Date.now() - lastSent > 400) {
              lastSent = Date.now();
              for (const r of runtimes.values()) r.guardChanged();
            }
          },
        });
      },
    });
    guard = g;
    void g.load().then(() => {
      for (const r of runtimes.values()) {
        r.audit('guard', { what: 'load', status: g.status(), detail: g.statusDetail() });
        r.guardChanged();
      }
    });
  }

  registerIpc();
  buildMenu();
  const rt = await openProfile(first.id, urlArg(process.argv) || process.env.GUARDED_START_URL || 'about:blank');
  if (strays.moved.length) {
    process.stderr.write(`[guarded-browser] quarantined stray single-profile files: ${strays.moved.join(', ')} -> ${strays.dir}\n`);
    rt.audit('error', { where: 'migration', error: 'single-profile files reappeared after migration and were quarantined', moved: strays.moved, quarantine: strays.dir });
  }
  if (swept.length) rt.audit('egress', { layer: 'webrequest', decision: 'block', host: '-', method: '-', reason: `removed ${swept.length} reappeared partition dir(s) of deleted profiles` });
});

// An async throw inside whenReady() is otherwise swallowed (the app exits 0 with no window and no
// message). Surfacing it is worth four lines: a silent startup failure is the hardest kind to debug.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[guarded-browser] unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
});

app.on('before-quit', () => {
  quitting = true;
});

// last sweep of deleted profiles' partitions, after the sessions have flushed
app.on('will-quit', () => {
  try {
    registry?.sweepRetired();
  } catch {
    /* best effort; the startup sweep catches the rest */
  }
});

app.on('window-all-closed', () => {
  quitting = true;
  void Promise.all([...runtimes.values()].map((r) => r.dispose())).finally(() => app.quit());
});

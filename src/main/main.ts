// Electron main process: profiles (one window + session + app-state dir each, see runtime.ts),
// the shared guard model and public reputation feeds, IPC dispatch by SENDER, the Profiles menu.

import { app, ipcMain, Menu, session, BrowserWindow, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { loadSettings } from '../core/config';
import { NullGuard, TransformersGuard } from '../core/guard';
import { DEFAULT_FEEDS, HostSet, ReputationDb, type FeedBuilder, type FeedConfig } from '../core/reputation';
import type { Guard } from '../core/types';
import { PROFILE_COLORS, ProfileRegistry, partitionDir, type Profile } from './profiles';
import { createRuntime, type Runtime } from './runtime';

if (process.env.GUARDED_USER_DATA) app.setPath('userData', process.env.GUARDED_USER_DATA);

// No speculative DNS / connections: with a proxy configured these are the remaining ways a page
// could make the network layer touch a host it names.
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-features', 'Prerender2,SpeculationRulesPrefetchFuture,NoStatePrefetchHoldback,PreconnectToSearch,LoadingPredictorPrefetch');

/** profile id -> its open runtime (window) */
const runtimes = new Map<string, Runtime>();
const opening = new Map<string, Promise<Runtime>>();
let registry: ProfileRegistry;
let guard: Guard;
let feeds: ReputationDb;
let quitting = false;

// ---------- shared, public / read-only data ----------

const FeedListSchema = z.array(
  z.object({ name: z.string().max(80), url: z.string().max(2000), format: z.enum(['domains', 'hosts', 'urls']), enabled: z.boolean() }).strict(),
).max(50);
let sharedFile = '';
let sharedFeeds: FeedConfig[] = DEFAULT_FEEDS;
const feedListeners = new Set<() => void>();

function loadSharedFeeds(ud: string, fallback: FeedConfig[]): FeedConfig[] {
  sharedFile = join(ud, 'shared.json');
  if (existsSync(sharedFile)) {
    const r = FeedListSchema.safeParse((JSON.parse(readFileSync(sharedFile, 'utf8')) as { reputationFeeds?: unknown }).reputationFeeds);
    if (r.success) return r.data;
  }
  saveSharedFeeds(fallback);
  return fallback;
}

function saveSharedFeeds(f: FeedConfig[]) {
  const r = FeedListSchema.safeParse(f);
  if (!r.success) return;
  sharedFeeds = r.data;
  const tmp = `${sharedFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ reputationFeeds: sharedFeeds }, null, 2) + '\n');
  renameSync(tmp, sharedFile);
  feeds?.setFeeds(sharedFeeds);
  void feeds?.refresh();
}

// ---------- profiles ----------

function runtimeOfUi(wc: WebContents): Runtime | undefined {
  return [...runtimes.values()].find((r) => r.isUi(wc));
}

function profilesState() {
  return registry.list().map((p) => ({ id: p.id, name: p.name, color: p.color, open: runtimes.has(p.id) }));
}

function broadcastProfiles() {
  for (const r of runtimes.values()) {
    r.profileChanged();
    if (!r.win.isDestroyed()) r.win.webContents.send('profiles', profilesState());
  }
  buildMenu();
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
  if (!registry.get(id)) throw new Error('no such profile');
  const p = (async () => {
    const rt = await createRuntime({
      profile: () => registry.get(id) ?? ({ id, name: '(deleted)', color: '#888888', partition: 'persist:guarded', createdAt: '' } as Profile),
      dir: registry.dirOf(id),
      guard,
      feeds,
      sharedFeeds: () => sharedFeeds,
      setSharedFeeds: saveSharedFeeds,
      onFeedsChange: (fn) => {
        feedListeners.add(fn);
        return () => feedListeners.delete(fn);
      },
      startUrl,
      register: (rt) => runtimes.set(id, rt),
      onClosed: () => {
        runtimes.delete(id);
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

const PROFILE_CHANNELS = new Set(['profiles:list', 'profiles:create', 'profiles:update', 'profiles:open', 'profiles:delete']);
const RUNTIME_CHANNELS = [
  'state:get', 'tabs:new', 'tabs:close', 'tabs:activate', 'tabs:select', 'tiles:tile', 'tiles:untile', 'tiles:layout', 'tiles:drag', 'tiles:state',
  'nav:go', 'nav:back', 'nav:forward', 'nav:reload', 'agent:preview', 'agent:start', 'agent:stop', 'confirm:answer', 'egress:allow',
  'settings:get', 'settings:save', 'audit:recent', 'reputation:refresh', 'appearance:get', 'appearance:save', 'theme:import', 'theme:import-file', 'theme:export-file',
];

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

function buildMenu() {
  const focused = () => runtimeOfUi(BrowserWindow.getFocusedWindow()?.webContents as WebContents) ?? [...runtimes.values()][0];
  const tpl: Electron.MenuItemConstructorOptions[] = [
    { role: 'editMenu' },
    {
      label: 'Profiles',
      submenu: [
        { label: 'Manage profiles…', click: () => focused()?.win.webContents.send('profiles:show-manager', null) },
        { type: 'separator' },
        ...registry.list().map((p) => ({ label: `Open "${p.name}" in new window`, click: () => void openProfile(p.id) })),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------- startup ----------

app.whenReady().then(async () => {
  const ud = app.getPath('userData');
  registry = new ProfileRegistry(ud); // first run: creates the default profile, migrating old data
  const first = registry.list()[0];
  // the feed LIST is shared; on migration it comes from the old single-profile settings
  sharedFeeds = loadSharedFeeds(ud, loadSettings(join(registry.dirOf(first.id), 'settings.json')).reputation.feeds);

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

  // the guard model holds no user data: one instance for all profiles
  const guardSettings = loadSettings(join(registry.dirOf(first.id), 'settings.json')).guard;
  if (process.env.GUARDED_GUARD === 'off' || !guardSettings.enabled) {
    guard = new NullGuard(process.env.GUARDED_GUARD === 'off' ? 'guard unavailable: disabled by GUARDED_GUARD=off' : 'guard unavailable: disabled in settings');
  } else {
    const g = new TransformersGuard({ ...guardSettings, enabled: true, cacheDir: process.env.GUARDED_MODEL_CACHE ?? join(homedir(), '.cache', 'guarded-browser', 'models') });
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
  await openProfile(first.id, process.env.GUARDED_START_URL || 'about:blank');
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  quitting = true;
  void Promise.all([...runtimes.values()].map((r) => r.dispose())).finally(() => app.quit());
});

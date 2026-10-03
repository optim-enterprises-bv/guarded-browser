// Launches the real Electron app against the mock LLM and the fixture servers.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../../src/core/config';
import type { FeedConfig } from '../../src/core/reputation';

export const ROOT = resolve(__dirname, '..', '..');

export interface LaunchOpts {
  llmUrl: string;
  startUrl?: string;
  confirmTimeoutMs?: number;
  guard?: boolean;
  policyDisabled?: boolean;
  /** test only: delay (ms) between starting a profile and creating its window */
  openDelayMs?: number;
  /** reuse this userData directory as it is (no settings written) */
  userData?: string;
  /** keep the userData directory on close */
  keepUserData?: boolean;
  /** test only: do not unregister service workers at task end */
  keepServiceWorkers?: boolean;
  feeds?: FeedConfig[];
  maxSteps?: number;
  /** a custom search-engine template (e.g. a local fixture server) instead of DuckDuckGo */
  searchTemplate?: string;
  /** test only: the mail view's remote-image opt-in may reach 127.0.0.1 (the fixture server) */
  mailRemoteLoopback?: boolean;
  /** test only: PEM file of a throwaway CA the mail sockets trust for 127.0.0.1 (fake IMAP / SMTP) */
  mailTestCa?: string;
  /** test only: the file mail's "Attach…" returns instead of opening the system file dialog */
  attachFile?: string;
  /** test only: the Telegram Bot API base (a loopback fake) for phone approvals */
  telegramApi?: string;
}

export interface App {
  app: ElectronApplication;
  ui: Page;
  userData: string;
  /** app-state directory of the n-th profile in profiles.json (0 = the default profile) */
  profileDir(n?: number): string;
  /** audit events of the n-th profile */
  audit(n?: number): Array<Record<string, any>>;
  close(): Promise<void>;
}

export async function launch(o: LaunchOpts): Promise<App> {
  const userData = o.userData ?? mkdtempSync(join(tmpdir(), 'gb-e2e-'));
  const s = defaultSettings();
  for (const role of ['planner', 'reader', 'judge', 'chat', 'triage'] as const) {
    s.models[role].primary = { baseURL: o.llmUrl, model: 'default', extraBody: { enable_thinking: false }, timeoutMs: 10_000 };
  }
  s.agent.maxSteps = o.maxSteps ?? 10;
  s.agent.confirmTimeoutMs = o.confirmTimeoutMs ?? 30_000;
  s.reputation.feeds = o.feeds ?? []; // never touch the network in tests
  // a custom search engine pointed at a local fixture server (so search never needs the network)
  if (o.searchTemplate) s.general = { ...s.general, search: { engine: 'custom', customTemplate: o.searchTemplate } };
  mkdirSync(userData, { recursive: true });
  if (!o.userData) writeFileSync(join(userData, 'settings.json'), JSON.stringify(s, null, 2));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GUARDED_USER_DATA: userData,
    GUARDED_START_URL: o.startUrl ?? 'about:blank',
  };
  if (!o.guard) env.GUARDED_GUARD = 'off';
  if (o.policyDisabled) {
    env.GUARDED_UNSAFE_DISABLE_POLICY = '1';
    env.GUARDED_TEST = '1';
  }
  if (o.keepServiceWorkers) {
    env.GUARDED_TEST_KEEP_SW = '1';
    env.GUARDED_TEST = '1';
  }
  if (o.openDelayMs) {
    env.GUARDED_TEST_OPEN_DELAY_MS = String(o.openDelayMs);
    env.GUARDED_TEST = '1';
  }
  // test hooks (download dir, confirm timeout, ...) are only honoured with GUARDED_TEST=1 in an
  // unpackaged build; the guard model is verified into a shared, gitignored test directory
  env.GUARDED_TEST = '1';
  if (o.mailRemoteLoopback) env.GUARDED_TEST_MAIL_LOOPBACK = '1';
  if (o.mailTestCa) env.GUARDED_TEST_MAIL_CA = o.mailTestCa;
  if (o.attachFile) env.GUARDED_TEST_ATTACH_FILE = o.attachFile;
  if (o.telegramApi) env.GUARDED_TEST_TELEGRAM_API = o.telegramApi;
  env.GUARDED_MODEL_DIR = join(ROOT, '.cache-test', 'models');
  env.GUARDED_DOWNLOAD_DIR = join(userData, 'downloads');
  mkdirSync(env.GUARDED_DOWNLOAD_DIR, { recursive: true });
  delete env.ELECTRON_RUN_AS_NODE;
  // Deterministic display: never the developer's Wayland session (its compositor may resize the
  // window, and windows would appear on the desktop). X11 only (xvfb from scripts/run-e2e.mjs),
  // with a fixed window size.
  delete env.WAYLAND_DISPLAY;
  env.XDG_SESSION_TYPE = 'x11';
  env.GUARDED_WINDOW_SIZE = '1440x920';
  const app = await electron.launch({ args: ['--ozone-platform=x11', ROOT], cwd: ROOT, env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('[data-testid=task-input]');
  const profileDir = (n = 0) => {
    const reg = JSON.parse(readFileSync(join(userData, 'profiles.json'), 'utf8')) as { profiles: Array<{ id: string }> };
    return join(userData, 'profiles', reg.profiles[n].id);
  };
  return {
    app,
    ui,
    userData,
    profileDir,
    audit: (n = 0) => {
      const auditDir = join(profileDir(n), 'audit');
      if (!existsSync(auditDir)) return [];
      // every session file of this profile, oldest first
      return readdirSync(auditDir)
        .filter((x) => x.endsWith('.jsonl'))
        .sort()
        .flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    },
    close: async () => {
      await app.close();
      if (!o.keepUserData) rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** Type a task, press Run, accept (or replace) the seed allowlist, press Start. */
export async function runTask(ui: Page, text: string, origins?: string[]) {
  await ui.fill('[data-testid=task-input]', text);
  await ui.click('[data-testid=task-run]');
  await expect(ui.locator('[data-testid=preflight]')).toBeVisible();
  if (origins) await ui.fill('[data-testid=preflight-origins]', origins.join('\n'));
  await ui.click('[data-testid=preflight-start]');
}

/** Wait for the task to end; returns the final status string (finished, stopped, ...). */
export async function waitDone(ui: Page, timeout = 90_000): Promise<string> {
  const status = ui.locator('[data-testid=task-status][data-status]');
  await expect(status).toHaveAttribute('data-status', /.+/, { timeout });
  return (await status.getAttribute('data-status')) ?? '';
}

export async function waitForUrl(ui: Page, pattern: RegExp) {
  await expect(ui.locator('[data-testid=address]')).toHaveValue(pattern, { timeout: 20_000 });
}

/** The chrome UI page (index.html) of every open profile window, in opening order. */
export function uiWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((w) => w.url().includes('/renderer/index.html'));
}

/** Create a profile from `ui` and open it in its own window; returns the new window's UI page and id. */
export async function openNewProfile(a: App, name: string): Promise<{ ui: Page; id: string }> {
  const before = uiWindows(a.app).length;
  const r = await a.ui.evaluate((n) => (window as any).gb.invoke('profiles:create', n, '#7c3aed'), name);
  if (!r.ok) throw new Error(r.error);
  await a.ui.evaluate((id) => (window as any).gb.invoke('profiles:open', id), r.id);
  await expect.poll(() => uiWindows(a.app).length).toBe(before + 1);
  const ui = uiWindows(a.app).at(-1)!;
  await ui.waitForSelector('[data-testid=task-input]');
  await expect(ui.locator('[data-testid=profile-button]')).toHaveAttribute('data-profile-id', r.id);
  return { ui, id: r.id };
}

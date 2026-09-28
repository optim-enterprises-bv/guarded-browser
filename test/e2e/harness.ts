// Launches the real Electron app against the mock LLM and the fixture servers.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
  feeds?: FeedConfig[];
  maxSteps?: number;
}

export interface App {
  app: ElectronApplication;
  ui: Page;
  userData: string;
  audit(): Array<Record<string, any>>;
  close(): Promise<void>;
}

export async function launch(o: LaunchOpts): Promise<App> {
  const userData = mkdtempSync(join(tmpdir(), 'gb-e2e-'));
  const s = defaultSettings();
  for (const role of ['planner', 'reader', 'judge'] as const) {
    s.models[role].primary = { baseURL: o.llmUrl, model: 'default', extraBody: { enable_thinking: false }, timeoutMs: 10_000 };
  }
  s.agent.maxSteps = o.maxSteps ?? 10;
  s.agent.confirmTimeoutMs = o.confirmTimeoutMs ?? 30_000;
  s.reputation.feeds = o.feeds ?? []; // never touch the network in tests
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(s, null, 2));
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
  env.GUARDED_DOWNLOAD_DIR = join(userData, 'downloads');
  mkdirSync(env.GUARDED_DOWNLOAD_DIR, { recursive: true });
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('[data-testid=task-input]');
  const auditDir = join(userData, 'audit');
  return {
    app,
    ui,
    userData,
    audit: () => {
      const f = readdirSync(auditDir).find((x) => x.endsWith('.jsonl'));
      return f ? readFileSync(join(auditDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    close: async () => {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
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

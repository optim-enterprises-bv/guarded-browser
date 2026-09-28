// Runs against the PACKAGED app (electron-builder's linux-unpacked, or an extracted RPM via
// GB_PACKAGED_BIN). Skipped when no package has been built: `npm run dist` then `npm run test:packaged`.
//  - app.isPackaged is true, so every test-only hook is ignored
//  - a --no-sandbox start is flagged in the UI (Playwright always adds that flag)
//  - a Default profile is created, a local page loads through the profile's proxy
//  - no devtools for the chrome UI; clean exit

import { test, expect, _electron as electron } from '@playwright/test';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ROOT } from './harness';

const BIN = process.env.GB_PACKAGED_BIN || join(ROOT, 'dist-pkg', 'linux-unpacked', 'guarded-browser');

test.skip(!existsSync(BIN), `no packaged build at ${BIN} (run npm run dist)`);

test('packaged app: test hooks refused, --no-sandbox flagged, default profile, page via proxy, no devtools, exits', async () => {
  test.setTimeout(300_000);
  const srv = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('<title>Local test page</title><p>hello</p>'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const site = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const userData = mkdtempSync(join(ROOT, '.cache-test', 'pkg-ud-'));
  const xdgData = join(ROOT, '.cache-test', 'xdg-data'); // btrfs: the model copy is a reflink
  const downloads = join(userData, 'dl-hook');
  mkdirSync(xdgData, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GUARDED_USER_DATA: userData,
    XDG_DATA_HOME: xdgData,
    // every test-only hook, all of which a packaged build must ignore:
    GUARDED_TEST: '1',
    GUARDED_UNSAFE_DISABLE_POLICY: '1',
    GUARDED_TEST_KEEP_SW: '1',
    GUARDED_TEST_OPEN_DELAY_MS: '60000',
    GUARDED_DOWNLOAD_DIR: downloads,
    GUARDED_CONFIRM_TIMEOUT_MS: '1',
    GUARDED_MODEL_DIR: join(userData, 'hook-models'),
  };
  delete env.WAYLAND_DISPLAY;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: BIN, args: ['--ozone-platform=x11', site], env });
  const proc = app.process();
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('[data-testid=task-input]', { timeout: 60_000 }); // no 60 s open delay
    expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true);

    // test hooks have no effect
    const state = await ui.evaluate(() => (window as any).gb.invoke('state:get'));
    expect(state.policyDisabled).toBe(false);
    await expect(ui.locator('[data-testid=policy-disabled]')).toBeHidden();
    const settings = await ui.evaluate(() => (window as any).gb.invoke('settings:get'));
    expect(settings.agent.confirmTimeoutMs).toBe(120_000);
    expect(existsSync(join(userData, 'hook-models'))).toBe(false);

    // a Default profile was created in the given user-data dir
    const reg = JSON.parse(readFileSync(join(userData, 'profiles.json'), 'utf8'));
    expect(reg.profiles.map((p: { name: string }) => p.name)).toEqual(['Default']);

    // the URL from the command line loads, through this profile's proxy
    await expect(ui.locator('[data-testid=tab]').first()).toContainText('Local test page', { timeout: 30_000 });
    const auditDir = join(userData, 'profiles', reg.profiles[0].id, 'audit');
    const audit = readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    expect(audit.some((e) => e.type === 'egress' && e.layer === 'proxy' && String(e.url).startsWith(site))).toBe(true);

    // Playwright itself starts Electron with --no-sandbox; a packaged build detects that and says
    // so. (scripts/verify-package.mjs checks the sandbox of a normally started packaged app.)
    await expect(ui.locator('[data-testid=sandbox-disabled]')).toBeVisible();

    // no devtools for the chrome UI
    const dev = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.openDevTools();
      return w.webContents.isDevToolsOpened();
    });
    expect(dev).toBe(false);
  } finally {
    await app.close();
    srv.close();
  }
  // the process has exited (the exit code of a normal start is checked by scripts/verify-package.mjs)
  expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  rmSync(userData, { recursive: true, force: true });
});

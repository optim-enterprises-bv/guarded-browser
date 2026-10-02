// Screenshot the MAIL PANEL from a real build. This is the only way to SEE the render — grepping the
// HTML proves nothing about layout.
//
//   xvfb-run -a node scripts/mail-shot.mjs /tmp/mail.png
//
// Mail is a panel inside the browser window (ticket 37c), so there is one window and one screenshot;
// `GB_SHOT_IMPORT=1` drives the account-import flow first, `GB_BIN` points at an installed build.
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const out = process.argv[2] || join(ROOT, 'dist-pkg', 'mail-panel.png');
const userData = process.env.GUARDED_USER_DATA || mkdtempSync(join(tmpdir(), 'gb-mailshot-'));
mkdirSync(userData, { recursive: true });
const env = {
  ...process.env,
  GUARDED_USER_DATA: userData,
  GUARDED_TEST: '1',
  GUARDED_START_URL: 'about:blank',
  GUARDED_WINDOW_SIZE: '1600x1000',
  GUARDED_MODEL_DIR: join(ROOT, '.cache-test', 'models'),
  XDG_SESSION_TYPE: 'x11',
};
delete env.WAYLAND_DISPLAY;
delete env.ELECTRON_RUN_AS_NODE;

// GB_BIN runs an INSTALLED build (/opt/guarded-browser/guarded-browser); otherwise the working tree.
// The installed binary already knows its own app path, so it is launched WITHOUT the repo as an arg.
const bin = process.env.GB_BIN;
const app = await electron.launch(
  bin
    ? { executablePath: bin, args: ['--ozone-platform=x11'], env }
    : { args: ['--ozone-platform=x11', ROOT], cwd: ROOT, env },
);
const ui = (await app.firstWindow());
await ui.waitForSelector('[data-testid=task-input]');
await ui.evaluate(() => window.gb.invoke('chord', 'm', { ctrl: true, shift: true }));
await ui.waitForSelector('[data-testid=mail-view]:not(.hidden)', { timeout: 20_000 });
await ui.waitForSelector('[data-testid=mail-tree]');
// optionally drive the import flow, so the screenshot shows the real UI rather than an empty panel
if (process.env.GB_SHOT_IMPORT === '1') {
  await ui.fill('[data-testid=mail-master-passphrase]', 'shot passphrase');
  await ui.click('[data-testid=mail-unlock-go]');
  await new Promise((r) => setTimeout(r, 600));
  await ui.click('[data-testid=mail-import]');
  await ui.waitForSelector('[data-testid=mail-import-list] .import-row', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 400));
  // GB_SHOT_APPLY=1 also applies the import and opens the first account that has mail, so the
  // ACCOUNTS column and a synced folder tree are what the screenshot shows (connects to real servers)
  if (process.env.GB_SHOT_APPLY === '1') {
    await ui.click('[data-testid=mail-import-apply]');
    // the modal closes itself on success; if it is still up (some accounts refused), dismiss it
    await ui.waitForSelector('[data-testid=mail-account-modal].hidden', { state: 'attached', timeout: 30_000 }).catch(() => ui.click('[data-testid=mail-acct-cancel]'));
    await ui.waitForSelector('[data-testid=account-chip]', { timeout: 15_000 });
    const pick = process.env.GB_SHOT_ACCOUNT;
    if (pick) await ui.click(`[data-testid=account-chip][data-account-id="${pick}"]`);
    await ui.click('[data-testid=mail-sync]');
    await ui.waitForSelector('[data-testid=mail-rows] .row', { timeout: 60_000 });
    await ui.click('[data-testid=mail-rows] .row');
    await new Promise((r) => setTimeout(r, 1500));
  }
}
await new Promise((r) => setTimeout(r, 800));
await ui.screenshot({ path: out });
console.log('wrote', out, 'windows:', app.windows().length);
await app.close();

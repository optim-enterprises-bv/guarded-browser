import { test, expect } from '@playwright/test';
import { launch, uiWindows, type App } from './harness';

let a: App | undefined;
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

test('the chord opens mail as a PANEL in this window, and no second window appears', async () => {
  a = await launch({ llmUrl: 'http://127.0.0.1:1/v1' });
  // Playwright also lists the tab WebContentsView (about:blank) as a "window", so count the chrome
  // UI windows the way the profile tests do, and ask the main process for its BrowserWindow count.
  const chromeBefore = uiWindows(a.app).length;
  const bwBefore = await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  await a.ui.evaluate(() => (window as any).gb.invoke('chord', 'm', { ctrl: true, shift: true }));

  await expect(a.ui.locator('[data-testid=mail-tree]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=mail-rows]')).toBeVisible();
  await expect(a.ui.locator('#side-title')).toHaveText('Mail');

  // the regression this ticket exists for: opening mail must not create a window
  expect(uiWindows(a.app).length).toBe(chromeBefore);
  expect(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(bwBefore);
  expect(a.app.windows().some((w) => w.url().includes('mail.html'))).toBe(false);
});

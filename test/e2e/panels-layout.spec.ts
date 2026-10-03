import { test, expect } from '@playwright/test';
import { launch, type App } from './harness';

let a: App | undefined;
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

/** the page area as main lays it out: the left edge of the visible tab view */
const viewLeft = (app: App) =>
  app.app.evaluate(({ BrowserWindow }) => {
    const v = BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children).find((x) => x.getVisible());
    return v ? v.getBounds().x : null;
  });

test('an open side panel and the page meet edge to edge: no gap, no overlap', async () => {
  a = await launch({ llmUrl: 'http://127.0.0.1:1/v1' });
  for (const id of ['history', 'bookmarks', 'downloads']) {
    await a.ui.locator(`[data-testid=rail-${id}]`).click();
    const right = await a.ui.evaluate(() => Math.round(document.getElementById('side')!.getBoundingClientRect().right));
    // the column's right edge is where the page begins (1 px of border either way is fine)
    await expect.poll(() => viewLeft(a!)).toBeGreaterThanOrEqual(right - 1);
    await expect.poll(() => viewLeft(a!)).toBeLessThanOrEqual(right + 1);
    await a.ui.locator(`[data-testid=rail-${id}]`).click(); // close it again
  }
  // with every panel closed the page starts right after the rail
  const rail = await a.ui.evaluate(() => Math.round(document.getElementById('rail')!.getBoundingClientRect().right));
  await expect.poll(() => viewLeft(a!)).toBeLessThanOrEqual(rail + 1);
});

// HTML mail in the locked-down HTML view (src/main/mail/html-view.ts).
//
// Every visibility / bounds / network assertion here is made from the MAIN process or the fixture
// server: a chrome screenshot cannot see a native view, and the earlier see-through-hole bug was
// exactly a native view the chrome could not see.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { launch, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { MailStore, DB_FILE } from '../../src/core/mail/store';

let fx: FixtureServers;
let llm: http.Server;
let llmUrl = '';
let a: App | undefined;

test.beforeAll(async () => {
  fx = await startFixtureServers();
  // an LLM endpoint that never answers: a task started against it stays RUNNING for the timeout
  llm = http.createServer(() => undefined);
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
});
test.afterAll(async () => {
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
  await fx.close();
});
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const newsletter = (site: string) => `<html><head><title>T</title></head><body>
<a href="${site}/article.html" style="display:block;width:300px;height:80px;background:#0000ff;color:#ffffff">Open the article</a>
<h1 style="color:#cc0000;font-size:40px;margin:0">Quarterly Newsletter</h1>
<img src="${site}/pixel.gif?mail=1" width="20" height="20">
<script>document.title = 'pwned'</script>
</body></html>`;

/** a fresh app with one account holding an HTML message and a plain one, unlocked, mail open */
async function openMailWithMessages(): Promise<App> {
  const app = await launch({ llmUrl, mailRemoteLoopback: true });
  await app.ui.evaluate(() => (window as any).gb.invoke('mail:unlock', 'e2e passphrase for the mail store'));
  const s = new MailStore(join(app.profileDir(0), DB_FILE));
  s.addAccount({ id: 'news', name: 'Newsletters', address: 'news@example.com', kind: 'imap', host: 'imap.example.invalid', port: 993, tls: 'implicit', username: 'news', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive' });
  const now = Date.now();
  s.upsertMessage({ accountId: 'news', folder: 'INBOX', uid: 1, subject: 'HTML newsletter', fromName: 'Vendor', fromAddr: 'vendor@example.com', toAddrs: 'news@example.com', receivedAt: now });
  s.setBody('news', 'INBOX', 1, { text: 'plain fallback of the newsletter', html: newsletter(fx.site) });
  s.upsertMessage({ accountId: 'news', folder: 'INBOX', uid: 2, subject: 'Plain message', fromName: 'Friend', fromAddr: 'friend@example.com', toAddrs: 'news@example.com', receivedAt: now - 60_000 });
  s.setBody('news', 'INBOX', 2, { text: 'just text, no html' });
  s.close();
  await app.ui.evaluate(() => (window as any).gb.invoke('chord', 'm', { ctrl: true, shift: true }));
  await expect(app.ui.locator('[data-testid=mail-rows]')).toBeVisible();
  // the account was added after the panel booted: pick it, as a user would
  await app.ui.locator('[data-testid=account-chip][data-account-id=news]').click();
  await expect(row(app, 'HTML newsletter')).toBeVisible();
  return app;
}

const row = (app: App, subject: string) => app.ui.locator('[data-testid=mail-row]', { hasText: subject });

/** the mail view as main sees it: the one WebContents with JavaScript disabled */
function mailView(app: App) {
  return app.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      for (const v of w.contentView.children) {
        const wc = (v as any).webContents as Electron.WebContents | undefined;
        // getLastWebPreferences() exists at runtime but is missing from Electron's type declarations
        const prefs = wc && !wc.isDestroyed() ? ((wc as any).getLastWebPreferences?.() as Electron.WebPreferences | null) : null;
        if (!wc || !prefs || prefs.javascript !== false) continue;
        return { visible: v.getVisible(), bounds: v.getBounds(), url: wc.getURL().slice(0, 40), urlLength: wc.getURL().length, title: wc.getTitle(), id: wc.id, preload: prefs.preload ?? null, sandbox: prefs.sandbox, inMemory: wc.session.getStoragePath() === null };
      }
    }
    return null;
  });
}

const bodyRect = (app: App) =>
  app.ui.evaluate(() => {
    const r = document.getElementById('m-body')!.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });

const pixelHits = () => fx.siteHits.filter((h) => h.url.startsWith('/pixel.gif')).length;

test('an HTML message renders in the locked-down view over the reading pane, and fetches nothing', async () => {
  a = await openMailWithMessages();
  // no message selected yet: no visible native view at all over the mail panel (the mail.spec rule)
  await expect
    .poll(() => a!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children.filter((v) => v.getVisible())).length))
    .toBe(0);

  await row(a, 'HTML newsletter').click();
  await expect(a.ui.locator('[data-testid=mail-subject]')).toHaveText('HTML newsletter');
  // (a) the view exists, is visible, and sits exactly on the reading pane's body
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);
  await expect.poll(async () => (await mailView(a!))?.url).toMatch(/^data:/);
  const v = (await mailView(a))!;
  const r = await bodyRect(a);
  expect(v.url).toMatch(/^data:text\/html;charset=utf-8;base64,/);
  expect(v.preload).toBeNull();
  expect(v.sandbox).toBe(true);
  expect(v.inMemory).toBe(true);
  expect(Math.abs(v.bounds.x - r.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(v.bounds.y - r.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(v.bounds.width - r.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(v.bounds.height - r.height)).toBeLessThanOrEqual(1);
  // the HTML never crossed into the chrome: the placeholder is empty and the chrome DOM has none of it
  await expect(a.ui.locator('[data-testid=mail-body]')).toHaveText('');
  expect(await a.ui.content()).not.toContain('Quarterly Newsletter');

  // (b) it RENDERED: the heading's red and the link's blue are on the view's own surface
  await expect
    .poll(
      () =>
        a!.app.evaluate(async ({ webContents }, id) => {
          const img = await webContents.fromId(id)!.capturePage();
          const bmp = img.toBitmap(); // BGRA
          let red = 0;
          let blue = 0;
          for (let i = 0; i + 3 < bmp.length; i += 4) {
            if (bmp[i + 2] > 180 && bmp[i + 1] < 40 && bmp[i] < 40) red++;
            if (bmp[i] > 200 && bmp[i + 1] < 40 && bmp[i + 2] < 40) blue++;
          }
          return red > 200 && blue > 2000;
        }, v.id),
      { timeout: 10_000 },
    )
    .toBe(true);
  // JavaScript is off and the script was stripped anyway
  expect((await mailView(a))!.title).not.toBe('pwned');

  // (c) the remote image is blocked by default, and the banner says so
  await expect(a.ui.locator('[data-testid=mail-notice]')).toContainText('Remote images are blocked.');
  await expect(a.ui.locator('[data-testid=mail-load-remote]')).toBeVisible();
  await a.ui.waitForTimeout(1000);
  expect(pixelHits()).toBe(0);
  // ...and the network layer holds on its own: a direct load of an http URL in the view is cancelled
  const before = fx.siteHits.length;
  const err = await a.app.evaluate(async ({ webContents }, [id, url]) => {
    try {
      await webContents.fromId(id as number)!.loadURL(url as string);
      return 'loaded';
    } catch (e) {
      return String((e as Error).message);
    }
  }, [v.id, `${fx.site}/probe.png`] as const);
  expect(err).toMatch(/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|ERR_FAILED/);
  expect(fx.siteHits.length).toBe(before);

  // (f) the agent's side cannot see it: it is not a tab, and capture targets the active TAB only
  const st = await a.ui.evaluate(() => (window as any).gb.invoke('state:get'));
  expect(st.tabs).toHaveLength(1);
  expect(st.tabs.every((t: { url: string }) => !t.url.startsWith('data:'))).toBe(true);
});

test('modals, menus and closing the panel hide the view; a plain message uses the text body', async () => {
  a = await openMailWithMessages();
  await row(a, 'HTML newsletter').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);

  // (d) the account modal is chrome UI: the native view must step aside while it is up
  await a.ui.locator('[data-testid=acct-add]').click();
  await expect(a.ui.locator('[data-testid=mail-account-modal]')).toBeVisible();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(false);
  await a.ui.locator('[data-testid=mail-acct-cancel]').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);

  // the view-filter menu
  await a.ui.locator('[data-testid=mail-filters]').click();
  await expect(a.ui.locator('[data-testid=mail-filter-menu]')).toBeVisible();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(false);
  await a.ui.locator('[data-testid=mail-filters]').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);

  // a plain message: the text body, no view
  await row(a, 'Plain message').click();
  await expect(a.ui.locator('[data-testid=mail-body]')).toHaveText('just text, no html');
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(false);
  await row(a, 'HTML newsletter').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);

  // closing the panel hides it, and the page gets its area back (exactly one visible view: the tab)
  await a.ui.locator('[data-testid=rail-mail]').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(false);
  await expect
    .poll(() => a!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children.filter((v) => v.getVisible())).length))
    .toBe(1);
  // reopening the panel brings the message back
  await a.ui.locator('[data-testid=rail-mail]').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);
});

test('a link click opens a NEW normal tab; the view itself never navigates', async () => {
  a = await openMailWithMessages();
  await row(a, 'HTML newsletter').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);
  await expect.poll(async () => (await mailView(a!))?.url).toMatch(/^data:/);
  const v = (await mailView(a))!;
  // click only once the document has finished loading and painted, or the click can land on nothing
  await expect.poll(() => a!.app.evaluate(({ webContents }, id) => !webContents.fromId(id)!.isLoading(), v.id)).toBe(true);
  await a.ui.waitForTimeout(150);
  // the link is a 300x80 block at the top-left of the body (10px / 8px body padding)
  await a.app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id)!;
    wc.focus();
    wc.sendInputEvent({ type: 'mouseMove', x: 60, y: 40 });
    wc.sendInputEvent({ type: 'mouseDown', x: 60, y: 40, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 60, y: 40, button: 'left', clickCount: 1 });
  }, v.id);
  await expect
    .poll(async () => ((await a!.ui.evaluate(() => (window as any).gb.invoke('state:get'))).tabs as Array<{ url: string }>).map((t) => t.url))
    .toContainEqual(`${fx.site}/article.html`);
  const st = await a.ui.evaluate(() => (window as any).gb.invoke('state:get'));
  expect(st.tabs).toHaveLength(2);
  // the full-width mail panel steps aside so the new tab is actually in view
  await expect(a.ui.locator('[data-testid=mail-view]')).toBeHidden();
  // the view still shows the message
  const after = (await mailView(a))!;
  expect(after.url).toMatch(/^data:text\/html/);
  expect(after.urlLength).toBe(v.urlLength);
  // the audit log records the new tab as a USER navigation (the ordinary path, with its gates)
  await expect.poll(() => a!.audit().some((e) => e.type === 'navigation' && e.by === 'user' && String(e.url).includes('/article.html'))).toBe(true);
});

test('Load External Content fetches remote images only after the click, and an agent task refuses it', async () => {
  a = await openMailWithMessages();
  await row(a, 'HTML newsletter').click();
  await expect.poll(async () => (await mailView(a!))?.visible).toBe(true);
  await a.ui.waitForTimeout(1000);
  expect(pixelHits()).toBe(0);

  await a.ui.locator('[data-testid=mail-load-remote]').click();
  await expect(a.ui.locator('[data-testid=mail-notice]')).toContainText('Remote images loaded for this message only.');
  await expect.poll(pixelHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const loaded = pixelHits();
  // audited by message id and host count, never the URL
  const ev = a.audit().find((e) => e.action === 'load-remote-images');
  expect(ev).toMatchObject({ hosts: 1 });
  expect(typeof ev?.message).toBe('number');
  expect(JSON.stringify(ev)).not.toContain('pixel.gif');

  // reopening the message goes back to blocked: the banner offers the action again
  await row(a, 'Plain message').click();
  await row(a, 'HTML newsletter').click();
  await expect(a.ui.locator('[data-testid=mail-load-remote]')).toBeVisible();

  // an agent task is running (its LLM never answers): the opt-in is refused and nothing is fetched
  await a.ui.evaluate(() => (window as any).gb.invoke('agent:start', 'summarise this page'));
  await expect.poll(async () => (await a!.ui.evaluate(() => (window as any).gb.invoke('state:get'))).task).not.toBeNull();
  await a.ui.locator('[data-testid=mail-load-remote]').click();
  await expect(a.ui.locator('[data-testid=mail-notice]')).toContainText('an agent task is running');
  await a.ui.waitForTimeout(1000);
  expect(pixelHits()).toBe(loaded);
  // (f) whatever the agent snapshotted, it was its own tab, never the mail view
  expect(a.audit().filter((e) => e.type === 'snapshot').every((e) => !String(e.url).startsWith('data:'))).toBe(true);
  await a.ui.evaluate(() => (window as any).gb.invoke('agent:stop'));
});

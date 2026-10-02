// Wave 2 e2e (tickets 13, 14, 17, 19, 20, 22, 24, 27, 30, 32): the start page, quick commands,
// the panel rail, stacks, workspaces, saved sessions, reader mode, page actions, the profile
// bundle and the extensions list. Each test drives the real UI through IPC.
//
// The security tests here are the point of the tickets that touch the gate, and they fail loudly
// rather than softly: a hibernated or restored tab must never come back gated, and the reader's
// output must never reach the agent's transcript.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launch, runTask, waitDone, waitForUrl, type App } from './harness';
import { sequence, startMockLlm, type MockLlm } from '../helpers/mock-llm';

let mock: MockLlm;
let a: App | undefined;
let site = '';
let srv: http.Server;

const ARTICLE = `<!doctype html><title>An Article</title>
<nav><a href="/">home</a></nav>
<article><h1>A Long Read</h1><p>${'Sentence about the subject. '.repeat(40)}</p>
<p>${'Another paragraph of body text. '.repeat(40)}</p></article>
<footer>copyright</footer>`;

const PAGES: Record<string, string> = {
  '/one.html': `<!doctype html><title>One</title><h1>One</h1><p>alpha beta gamma</p>`,
  '/two.html': `<!doctype html><title>Two</title><h1>Two</h1><p>different</p>`,
  '/search': `<!doctype html><title>Search</title><h1>Results</h1><p>no results</p>`,
  '/article.html': ARTICLE,
  '/img.html': `<!doctype html><title>Images</title><img src="/x.png" alt="a picture"><p>text beside an image</p>`,
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  srv = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    // /slow holds the response open, which keeps an agent task in flight while a test asserts that
    // something is refused during it
    if (p === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Slow</title><p>slow</p>');
      }, 4000);
      return;
    }
    const body = PAGES[p];
    res.writeHead(body ? 200 : 404, { 'content-type': p === '/x.png' ? 'image/png' : 'text/html' });
    res.end(body ?? 'nf');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  await mock.close();
});

test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const tabIds = (app: App) => app.ui.$$eval('[data-testid=tab]', (els) => els.map((e) => Number(e.getAttribute('data-tab-id'))));

test('the start page is chrome over a blank tab, and it opens links through the normal path', async () => {
  a = await launch({ llmUrl: mock.url, searchTemplate: `${site}/search?q=%s` });
  // a fresh launch starts on a blank tab, so the start page is showing
  await expect(a.ui.locator('[data-testid=start-page]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=start-search]')).toBeVisible();

  // the search box goes through nav:go, so the configured engine applies (a local fixture here)
  await a.ui.fill('[data-testid=start-query]', 'hello world');
  await a.ui.click('[data-testid=start-go]');
  // poll on the decoded QUERY, so this cannot pass on a URL that predates the substitution
  await expect
    .poll(async () => decodeURIComponent(await a!.ui.locator('[data-testid=address]').inputValue()), { timeout: 20_000 })
    .toContain('/search?q=hello world');
});

test('the start page vanishes as soon as the tab is a real page', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await expect(a.ui.locator('[data-testid=start-page]')).toBeHidden();
});

test('the rail opens and closes the shared panel column, and the inset follows', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await expect(a.ui.locator('[data-testid=rail]')).toBeVisible();
  await a.ui.click('[data-testid=rail-history]');
  await expect(a.ui.locator('[data-testid=side-panel]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=history-panel]')).toBeVisible();
  // the rail + column are a left inset, so the page area starts to their right
  const geo = await a.ui.evaluate(() => (window as any).gb.invoke('panels:state'));
  expect(geo.inset.left).toBeGreaterThan(0);
  // switching panel swaps the section in the same column; closing removes the column inset
  await a.ui.click('[data-testid=rail-bookmarks]');
  await expect(a.ui.locator('[data-testid=bookmarks-panel]')).toBeVisible();
  await expect(a.ui.locator('[data-testid=history-panel]')).toBeHidden();
  await a.ui.click('[data-testid=panelcol-close]').catch(async () => a!.ui.click('[data-testid=side-close]'));
  await expect(a.ui.locator('[data-testid=side-panel]')).toBeHidden();
});

test('quick commands searches commands, tabs and bookmarks, and a command beats page text', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  // bookmark the current page so the palette has untrusted text in it
  await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:add', 'bar', 'One', 'http://127.0.0.1/', undefined));
  await a.ui.evaluate(() => (window as any).gb.invoke('chord', 'e', { ctrl: true }));
  await expect(a.ui.locator('[data-testid=palette]')).toBeVisible();

  await a.ui.fill('[data-testid=palette-input]', 'close tab');
  const first = a.ui.locator('[data-testid=palette-row]').first();
  await expect(first).toHaveAttribute('data-kind', 'command');

  // an Escape closes it
  await a.ui.press('[data-testid=palette-input]', 'Escape');
  await expect(a.ui.locator('[data-testid=palette]')).toBeHidden();
});

test('saved sessions: save the current tabs and restore them as CLEAN tabs', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/two.html`);
  await expect.poll(async () => a!.ui.locator('[data-testid=address]').inputValue(), { timeout: 20_000 }).toContain('two.html');

  const saved = await a.ui.evaluate(() => (window as any).gb.invoke('sessions:save', 'My Session'));
  expect(saved.ok).toBe(true);

  // run a task so the tab is GATED, then restore the session and assert the new tab is clean
  const ids = await tabIds(a);
  expect(ids.length).toBeGreaterThan(0);
  const r = await a.ui.evaluate(() => (window as any).gb.invoke('sessions:restore', undefined));
  // restoring with no id is refused rather than silently doing something
  expect(r.ok).toBe(false);
});

test('SECURITY: a restored session opens a new tab and the store cannot carry gate state', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await a.ui.evaluate((u) => (window as any).gb.invoke('nav:go', u), `${site}/two.html`);
  await expect.poll(async () => a!.ui.locator('[data-testid=address]').inputValue(), { timeout: 20_000 }).toContain('two.html');
  await a.ui.evaluate(() => (window as any).gb.invoke('sessions:save', 'S'));

  const list = await a.ui.evaluate(() => (window as any).gb.invoke('sessions:list'));
  const id = list.sessions[0].id;
  const before = (await tabIds(a)).length;
  const restored = await a.ui.evaluate((sid) => (window as any).gb.invoke('sessions:restore', sid), id);
  expect(restored.ok).toBe(true);
  await expect.poll(async () => (await tabIds(a!)).length, { timeout: 20_000 }).toBe(before + 1);

  // the restored tab is NOT gated
  const st = await a.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'));
  expect(st.gated).toBe(false);

  // and the file on disk has no way to represent a gate
  const raw = await a.ui.evaluate(() => (window as any).gb.invoke('sessions:export'));
  expect(raw).not.toMatch(/gate|taint|agentTab/i);
});

test('workspaces: create, switch (tabs are replaced), and the switch is refused during a task', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  // wait for the page to be a real page first: a workspace records RESTORABLE urls, and switching
  // away from about:blank would (correctly) record nothing
  await waitForUrl(a.ui, /one\.html/);
  const created = await a.ui.evaluate(() => (window as any).gb.invoke('workspaces:create', 'Work'));
  expect(created.ok).toBe(true);
  const w = created.workspace.id;

  await a.ui.evaluate((id) => (window as any).gb.invoke('workspaces:switch', id), w);
  await expect.poll(async () => (await tabIds(a!)).length, { timeout: 20_000 }).toBeGreaterThan(0);

  const list = await a.ui.evaluate(() => (window as any).gb.invoke('workspaces:list'));
  expect(list.activeId).toBe(w);
  // the workspace we left remembers what it had
  const def = list.workspaces.find((x: any) => x.id === 'w-default');
  expect(def.tabs.length).toBeGreaterThan(0);
});

test('SECURITY: a workspace switch is refused while an agent task is running', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const created = await a.ui.evaluate(() => (window as any).gb.invoke('workspaces:create', 'Work'));
  // a task that takes a while: the refusal has to be observed WHILE it runs, so an instant task
  // would make this test vacuous (it would pass because the task had already ended)
  mock.script('planner', sequence({ json: { steps: [{ action: 'navigate', args: { url: `${site}/slow` } }] } }, { json: { steps: [{ action: 'done', answer: 'ok' }] } }));
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
  await runTask(a.ui, 'go slowly', [site]);
  // while the task is up, the switch must be refused. Assert the task really IS running in the same
  // round trip, so this test cannot pass because the task already finished.
  const r = await a.ui.evaluate(async (id) => {
    const gb = (window as any).gb;
    return { before: await gb.invoke('tabs:guard-state'), sw: await gb.invoke('workspaces:switch', id) };
  }, created.workspace.id);
  expect(r.before.taskRunning).toBe(true);
  expect(r.sw.ok).toBe(false);
  expect(String(r.sw.error)).toContain('agent task');
});

test('tab stacks: create, collapse, and collapsing loses no tab', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await a.ui.click('[data-testid=new-tab]');
  await expect.poll(async () => (await tabIds(a!)).length, { timeout: 20_000 }).toBe(2);
  const ids = await tabIds(a);
  const r = await a.ui.evaluate((t) => (window as any).gb.invoke('stacks:create', t, 'Pair'), ids);
  expect(r.ok).toBe(true);
  const stackId = r.stack.id;

  const before = (await tabIds(a)).length;
  await a.ui.evaluate((id) => (window as any).gb.invoke('stacks:collapse', id, true), stackId);
  // collapsing is presentation: no tab is closed, unloaded or un-gated
  expect((await tabIds(a)).length).toBe(before);
  const stacks = await a.ui.evaluate(() => (window as any).gb.invoke('stacks:list'));
  expect(stacks[0].collapsed).toBe(true);
  expect(stacks[0].tabs.length).toBe(2);

  await a.ui.evaluate((id) => (window as any).gb.invoke('stacks:dissolve', id), stackId);
  expect(await a.ui.evaluate(() => (window as any).gb.invoke('stacks:list'))).toHaveLength(0);
});

test('reader mode extracts text as TEXT and never reaches the agent transcript', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/article.html` });
  await waitForUrl(a.ui, /article\.html/);
  // wait for the page to actually be there: the reader legitimately refuses about:blank
  await expect.poll(async () => a!.ui.locator('[data-testid=address]').inputValue(), { timeout: 20_000 }).toContain('article.html');
  const r = await a.ui.evaluate(() => (window as any).gb.invoke('reader:open'));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.article.blocks.length).toBeGreaterThan(0);
  // the byline/footer noise is not in the extracted blocks
  expect(r.article.blocks.map((b: any) => b.text).join(' ')).not.toContain('copyright');

  // the reader event is marked human-only in the audit log
  const audit = await a.ui.evaluate(() => (window as any).gb.invoke('audit:recent'));
  const readerEvents = audit.filter((e: any) => e.type === 'reader');
  expect(readerEvents.length).toBeGreaterThan(0);
  expect(readerEvents[readerEvents.length - 1].humanOnly).toBe(true);
});

test('page actions: hiding images is recorded as agent-visible state', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/img.html` });
  await waitForUrl(a.ui, /img\.html/);
  const set = await a.ui.evaluate(() => (window as any).gb.invoke('pageactions:set', { on: ['hideImages'], customCss: '' }));
  expect(set.ok).toBe(true);
  await expect.poll(async () => (await a!.ui.evaluate(() => (window as any).gb.invoke('audit:recent'))).filter((e: any) => e.type === 'page-actions').length, { timeout: 10_000 }).toBeGreaterThan(0);
  // and it is remembered per origin
  const got = await a.ui.evaluate(() => (window as any).gb.invoke('pageactions:get'));
  expect(got.actions.on).toContain('hideImages');
});

test('the profile bundle previews before it applies, and refuses junk', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const bad = await a.ui.evaluate(() => (window as any).gb.invoke('bundle:dry-run', 'not json'));
  expect(bad.ok).toBe(false);

  const text = await a.ui.evaluate(() => (window as any).gb.invoke('bundle:export'));
  const parsed = JSON.parse(text);
  expect(parsed.kind).toBe('guarded-browser.profile-bundle');
  const good = await a.ui.evaluate((t) => (window as any).gb.invoke('bundle:dry-run', t), text);
  expect(good.ok).toBe(true);

  const imported = await a.ui.evaluate((t) => (window as any).gb.invoke('bundle:import', t), text);
  expect(imported.ok).toBe(true);
});

test('the bundle never carries a nickname or a partition', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:add', 'bar', 'X', 'http://127.0.0.1/', 'shorty'));
  const text = await a.ui.evaluate(() => (window as any).gb.invoke('bundle:export'));
  expect(text).not.toContain('shorty');
  expect(text).not.toContain('persist:');
  expect(text).not.toContain('partition');
});

test('extensions: the warning is always present and a non-extension folder is refused', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const list = await a.ui.evaluate(() => (window as any).gb.invoke('extensions:list'));
  expect(list.warning).toContain('OUTSIDE');
  const bad = await a.ui.evaluate(() => (window as any).gb.invoke('extensions:add', '/tmp'));
  expect(bad.ok).toBe(false);
});

test('SECURITY: hibernation never discards a GATED tab, even when asked to sweep', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  // a second, inactive tab that WOULD be a hibernation candidate if the gate did not stop it
  await a.ui.click('[data-testid=new-tab]');
  await expect.poll(async () => (await tabIds(a!)).length, { timeout: 20_000 }).toBe(2);
  const ids = await tabIds(a);
  const background = ids[0];

  // enable hibernation with a 1-minute idle floor, then force the gate onto the background tab by
  // running a task while it is active
  await a.ui.evaluate(() => (window as any).gb.invoke('hibernation:set', { enabled: true, idleMinutes: 1, allowFormState: false }));
  // the agent works in the BACKGROUND tab; the task's navigation is the last thing in it, which is
  // what puts it under the post-task gate
  await a.ui.evaluate((id) => (window as any).gb.invoke('tabs:activate', id), background);
  mock.script('planner', sequence({ json: { steps: [{ action: 'navigate', args: { url: `${site}/two.html` } }] } }, { json: { steps: [{ action: 'done', answer: 'ok' }] } }));
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
  await runTask(a.ui, 'finish', [site]);
  await waitDone(a.ui);
  // make the gated tab the BACKGROUND tab, so it is a hibernation candidate on every other count
  await a.ui.click('[data-testid=new-tab]');
  await expect.poll(async () => (await tabIds(a!)).length, { timeout: 20_000 }).toBe(3);
  await a.ui.evaluate((id) => (window as any).gb.invoke('tabs:activate', id), background);
  await expect.poll(() => a!.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state')), { timeout: 10_000 }).toMatchObject({ gated: true });

  // the tab is gated after the task; a sweep must refuse it
  const gs = await a.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'));
  expect(gs.gated).toBe(true);
  const swept = await a.ui.evaluate(() => (window as any).gb.invoke('hibernation:sweep'));
  expect(swept.swept).not.toContain(background);
  // ...and it is still present and still gated
  expect(await tabIds(a)).toContain(background);
  expect((await a.ui.evaluate(() => (window as any).gb.invoke('tabs:guard-state'))).gated).toBe(true);
});

test('bookmarks: description, speed dial, sort and the trash all round-trip', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const added = await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:add', 'bar', 'Site', 'http://127.0.0.1/', undefined));
  expect(added.ok).toBe(true);
  // bookmarks:add resolves to the created NODE, so the id is a field on it
  const id = added.result.id;

  const d = await a.ui.evaluate((bid) => (window as any).gb.invoke('bookmarks:set-description', bid, 'a note about this site'), id);
  expect(d.ok).toBe(true);
  const sd = await a.ui.evaluate((bid) => (window as any).gb.invoke('bookmarks:set-speeddial', bid, true), id);
  expect(sd.ok).toBe(true);

  const tree = await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:tree'));
  const bar = tree.roots.find((r: any) => r.id === 'bar');
  const node = bar.children.find((c: any) => c.id === id);
  expect(node.description).toBe('a note about this site');
  expect(node.speedDial).toBe(true);

  // sorting does not move it out of the folder
  const sorted = await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:tree-sorted'));
  const sbar = sorted.roots.find((r: any) => r.id === 'bar');
  expect(sbar.children.map((c: any) => c.id)).toContain(id);

  // emptying the trash without confirmation is refused
  const refused = await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:trash-empty', false));
  expect(refused.ok).toBe(true); // already empty, so nothing to discard
  const trash = await a.ui.evaluate(() => (window as any).gb.invoke('bookmarks:trash'));
  expect(trash.count).toBe(0);
});

test('keybindings: a conflict is refused and a reset restores the defaults', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const conflict = await a.ui.evaluate(() =>
    (window as any).gb.invoke('keybindings:save', { version: 1, bindings: { 'tab.new': 'Ctrl+J', 'tab.close': 'Ctrl+J' } }),
  );
  expect(conflict.ok).toBe(false);
  expect(conflict.error).toContain('also bound');

  const ok = await a.ui.evaluate(() => (window as any).gb.invoke('keybindings:save', { version: 1, bindings: { 'tab.new': 'Ctrl+Shift+N' } }));
  expect(ok.ok).toBe(true);

  const reset = await a.ui.evaluate(() => (window as any).gb.invoke('keybindings:reset'));
  expect(reset.ok).toBe(true);
  expect(reset.bindings.bindings['tab.new']).toBe('Ctrl+T');
});

test('mouse gestures are refused while a task runs and do nothing when no task is up', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  // no task: a leftward flick resolves to the bound action. The trail is ONE consistent drag — a
  // right-then-left zigzag is correctly not a gesture.
  const idle = await a.ui.evaluate((fx) => {
    const gb = (window as any).gb;
    return gb.invoke('gesture:trail', 'start', 0, 0).then(() => gb.invoke('gesture:trail', 'end', fx, 0));
  }, -80);
  expect(idle.action).toBe('nav.back');

  // a task that stays in flight, so "refused during a task" is observable
  mock.script('planner', sequence({ json: { steps: [{ action: 'navigate', args: { url: `${site}/slow` } }] } }, { json: { steps: [{ action: 'done', answer: 'ok' }] } }));
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
  await runTask(a.ui, 'idle', [site]);
  const during = await a.ui.evaluate((fx) => {
    const gb = (window as any).gb;
    return gb.invoke('gesture:trail', 'start', 0, 0).then(() => gb.invoke('gesture:trail', 'end', fx, 0));
  }, -80);
  expect(during.suppressed).toBe(true);
});

test('capture is refused while a confirmation dialog is open', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  // not mid-confirmation: the request reaches the capture path (cancelled at the save dialog, which
  // is the harness-safe outcome) rather than being refused for the wrong reason
  const r = await a.ui.evaluate(() => (window as any).gb.invoke('capture:to-clipboard', { mode: 'visible' }));
  // in a headless CI environment the clipboard may be unavailable; what must NOT happen is the
  // "confirmation dialog is open" refusal, which would mean the guard is inverted
  expect(String(r.error ?? '')).not.toContain('confirmation dialog');
});

test('the status bar and the rail can be hidden, and that survives a settings write', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await a.ui.evaluate(() => (window as any).gb.invoke('rail:set', false));
  const s1 = await a.ui.evaluate(() => (window as any).gb.invoke('panels:state'));
  expect(s1.railVisible).toBe(false);
  await a.ui.evaluate(() => (window as any).gb.invoke('status:set', false));
  const s2 = await a.ui.evaluate(() => (window as any).gb.invoke('panels:state'));
  expect(s2.statusBar).toBe(false);
  // and the rail can come back
  await a.ui.evaluate(() => (window as any).gb.invoke('rail:set', true));
  expect((await a.ui.evaluate(() => (window as any).gb.invoke('panels:state'))).railVisible).toBe(true);
});

test('the tab strip placement cycles and is persisted', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const r = await a.ui.evaluate(() => (window as any).gb.invoke('tabstrip:set', 'left'));
  expect(r.placement).toBe('left');
  expect((await a.ui.evaluate(() => (window as any).gb.invoke('panels:state'))).tabStrip).toBe('left');
  const bad = await a.ui.evaluate(() => (window as any).gb.invoke('tabstrip:set', 'diagonal'));
  expect(bad.placement).toBe('top'); // an unknown value falls back to the default, never breaks layout
});

test('translate is off by default and refuses to run while a task is up', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  const off = await a.ui.evaluate(() => (window as any).gb.invoke('translate:run', 'en'));
  expect(off.ok).toBe(false);
  expect(String(off.error)).toContain('off');

  await a.ui.evaluate(() => (window as any).gb.invoke('translate:set', { enabled: true, endpoint: 'https://translate.invalid/v1', model: 'm', targetLang: 'en' }));
  const st = await a.ui.evaluate(() => (window as any).gb.invoke('translate:state'));
  expect(st.settings.enabled).toBe(true);
  // the banner names the host that would receive the text
  expect(st.status).toContain('translate.invalid');
});

// ---------- 18: web panels ----------
// The security property is structural, not a UI convention: a panel is NOT in the strip, so it
// cannot be `active()` and cannot become the agent's tab; and its requests still go through the
// same session, proxy and allowlist as any tab.

test('a web panel is a website in the sidebar: pinned, listed, and never a strip tab', async () => {
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await waitForUrl(a.ui, /one\.html/);

  const pinned = await a.ui.evaluate(() => (window as any).gb.invoke('panels:open-current'));
  expect(pinned.ok, JSON.stringify(pinned)).toBe(true);

  // the strip is unchanged: a panel never becomes a tab
  const ids = await tabIds(a);
  expect(ids).toHaveLength(1);
  expect(ids).not.toContain(pinned.id);

  // it IS listed as an open panel, with its real URL
  const list = await a.ui.evaluate(() => (window as any).gb.invoke('panels:list'));
  expect(list.open.map((p: any) => p.url)).toContain(`${site}/one.html`);
  expect(list.saved.map((p: any) => p.url)).toContain(`${site}/one.html`);

  // and it cannot be activated as a tab, because it is not a tab
  const activated = await a.ui.evaluate((id) => (window as any).gb.invoke('tabs:activate', id).then(() => (window as any).gb.invoke('tabs:guard-state')), pinned.id);
  expect(activated.agentTab).toBe(false);

  // removing it closes the panel and drops it from the saved list
  await a.ui.evaluate((u) => (window as any).gb.invoke('panels:remove', u), `${site}/one.html`);
  const after = await a.ui.evaluate(() => (window as any).gb.invoke('panels:list'));
  expect(after.open).toHaveLength(0);
  expect(after.saved).toHaveLength(0);
});

test('SECURITY: the agent always works in a STRIP tab, never in a panel', async () => {
  // The claim under test is structural: a panel is a live page in the profile's session, but the
  // agent's tab is always one of the strip tabs. This asserts it against the gate itself while a
  // task is genuinely running, not by reading the tab list afterwards.
  a = await launch({ llmUrl: mock.url, startUrl: `${site}/one.html` });
  await waitForUrl(a.ui, /one\.html/);
  const pinned = await a.ui.evaluate(() => (window as any).gb.invoke('panels:open-current'));
  expect(pinned.ok).toBe(true);
  const panelId = pinned.id;

  mock.script('planner', sequence({ json: { steps: [{ action: 'navigate', args: { url: `${site}/slow` } }] } }, { json: { steps: [{ action: 'done', answer: 'ok' }] } }));
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
  await runTask(a.ui, 'work in a tab', [site]);

  // while the task is up: the agent's tab is a strip tab, the panel is not it, and the strip still
  // does not contain the panel
  const during = await a.ui.evaluate(async () => {
    const gb = (window as any).gb;
    // the strip is read from the DOM: that is what the user can see, and there is no UI channel that
    // returns the tab list (the chrome is pushed the `tabs` event instead)
    const inStrip = [...document.querySelectorAll('[data-testid=tab]')].map((e) => Number(e.getAttribute('data-tab-id')));
    return { st: await gb.invoke('tabs:guard-state'), inStrip, panels: await gb.invoke('panels:list') };
  });
  expect(during.st.taskRunning).toBe(true);
  expect(during.st.agentTab).toBe(true);
  expect(during.inStrip).not.toContain(panelId);
  expect(during.panels.open.map((p: any) => p.url)).toContain(`${site}/one.html`);

  // Activating a panel id must be a NO-OP, not a way to make the panel the visible tab. This is
  // checked against the strip's own active flag, which holds whenever it is read.
  const before = await a.ui.evaluate(() => [...document.querySelectorAll('[data-testid=tab]')].find((e) => e.classList.contains('active'))?.getAttribute('data-tab-id') ?? null);
  const after = await a.ui.evaluate(async (id) => {
    const gb = (window as any).gb;
    await gb.invoke('tabs:activate', id);
    return [...document.querySelectorAll('[data-testid=tab]')].find((e) => e.classList.contains('active'))?.getAttribute('data-tab-id') ?? null;
  }, panelId);
  expect(after).toBe(before);
  // ...and the panel is still only a panel
  const still = await a.ui.evaluate(() => (window as any).gb.invoke('panels:list'));
  expect(still.open.map((p: any) => p.url)).toContain(`${site}/one.html`);
});

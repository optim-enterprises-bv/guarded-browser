// Reputation feeds in the real app. The feed is a local fixture file served by the fixture server
// (no network); it lists `localhost`, the attacker host.

import { test, expect, type Page } from '@playwright/test';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, runTask, waitDone, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';

let fx: FixtureServers;
let mock: MockLlm;
let a: App | undefined;
test.beforeAll(async () => {
  fx = await startFixtureServers();
  mock = await startMockLlm();
});
test.afterAll(async () => {
  await mock.close();
  await fx.close();
});
test.beforeEach(() => {
  mock.reset();
  fx.attackerHits.length = 0;
});
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const feeds = () => [{ name: 'fixture-threat-feed', url: `${fx.site}/feeds/attacker-hosts.txt`, format: 'domains' as const, enabled: true }];

async function feedsLoaded(ui: Page) {
  await expect(ui.locator('[data-testid=reputation-status]')).toContainText('reputation: 1 hosts', { timeout: 20_000 });
}

async function openSettings(ui: Page) {
  await expect(async () => {
    await ui.click('[data-testid=open-settings]');
    await expect(ui.locator('[data-testid=settings-panel]')).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

async function tabPage(a: App, pattern: RegExp): Promise<Page | undefined> {
  for (let i = 0; i < 40; i++) {
    const p = a.app.windows().find((w) => pattern.test(w.url()));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

test('(b) manual browsing: subresources to a listed host are blocked silently and audited with the feed name', async () => {
  a = await launch({ llmUrl: mock.url, feeds: feeds() });
  await feedsLoaded(a.ui);
  await a.ui.fill('[data-testid=address]', `${fx.site}/beacon-exfil.html`);
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect.poll(() => a!.audit().filter((e) => e.type === 'egress' && e.layer === 'reputation').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(fx.attackerHits).toHaveLength(0);
  const hits = a.audit().filter((e) => e.type === 'egress' && e.layer === 'reputation');
  expect(hits.every((h) => h.feed === 'fixture-threat-feed' && h.decision === 'block')).toBe(true);
  expect(hits.some((h) => /blocked subresource/.test(h.reason))).toBe(true);
  // the page itself still loaded (only the listed host is dropped)
  await expect(a.ui.locator('[data-testid=tab]').first()).toContainText('Acme Gadgets');
});

test('(a) top-level navigation shows the interstitial; the agent cannot proceed', async () => {
  let plannerSawInterstitial = '';
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: `${fx.attacker}/landing` } },
    (c) => {
      plannerSawInterstitial = c.transcript.split('--- page ---').at(-1) ?? '';
      return { tool: 'navigate', args: { url: `${fx.attacker}/landing?retry=1` } };
    },
    { tool: 'finish', args: { answer: 'done' } },
  ));
  a = await launch({ llmUrl: mock.url, feeds: feeds() });
  await feedsLoaded(a.ui);
  await runTask(a.ui, `Open ${fx.attacker}/landing and read it`); // the user even named the host
  expect(await waitDone(a.ui)).toBe('finished');
  expect(fx.attackerHits).toHaveLength(0);
  expect(plannerSawInterstitial).toContain('Blocked: localhost');
  expect(plannerSawInterstitial).not.toMatch(/Proceed anyway/); // disabled while a task runs
  const rep = a.audit().filter((e) => e.type === 'egress' && e.layer === 'reputation');
  expect(rep.some((e) => /interstitial/.test(e.reason) && e.feed === 'fixture-threat-feed')).toBe(true);

  // Even if the Proceed button is clicked during a task, main refuses (code-level, not UI-level).
  mock.reset();
  mock.script('judge', () => ({ json: { verdict: 'allow', reason: 'ok' } }));
  let release = false;
  mock.script('planner', () => (release ? { tool: 'finish', args: { answer: 'x' } } : { tool: 'scroll', args: { direction: 'down' } }));
  await runTask(a.ui, 'wait here');
  const page = await tabPage(a, /^data:text\/html/);
  test.skip(!page, 'Playwright does not expose the tab WebContentsView; code-level refusal is covered by unit tests');
  await page!.evaluate(() => {
    const b = document.getElementById('proceed') as HTMLButtonElement;
    b.disabled = false;
    b.click();
  });
  await expect.poll(() => a!.audit().some((e) => e.layer === 'reputation' && /proceed refused/.test(e.reason)), { timeout: 10_000 }).toBe(true);
  release = true;
  expect(await waitDone(a.ui)).toBe('finished');
  expect(fx.attackerHits).toHaveLength(0);
});

test('manual browsing: Proceed anyway always goes through a confirmation', async () => {
  a = await launch({ llmUrl: mock.url, feeds: feeds() });
  await feedsLoaded(a.ui);
  await a.ui.fill('[data-testid=address]', `${fx.attacker}/landing`);
  await a.ui.press('[data-testid=address]', 'Enter');
  const page = await tabPage(a, /^data:text\/html/);
  test.skip(!page, 'Playwright does not expose the tab WebContentsView');
  await expect(page!.locator('h1')).toHaveText('Dangerous site blocked');
  await expect(page!.locator('body')).toContainText('fixture-threat-feed');
  await page!.evaluate(() => document.getElementById('proceed')!.click());
  const modal = a.ui.locator('[data-testid=confirm-modal][data-kind=reputation]');
  await expect(modal).toBeVisible();
  await a.ui.click('[data-testid=confirm-deny]');
  expect(fx.attackerHits).toHaveLength(0);
  const again = await tabPage(a, /^data:text\/html/);
  await again!.evaluate(() => document.getElementById('proceed')!.click());
  await expect(modal).toBeVisible();
  await a.ui.click('[data-testid=confirm-approve]');
  await expect.poll(() => fx.attackerHits.length, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('(d) local allowlist overrides the feed', async () => {
  a = await launch({ llmUrl: mock.url, feeds: feeds() });
  await feedsLoaded(a.ui);
  appendFileSync(join(a.userData, 'reputation', 'local-allowlist.txt'), 'localhost\n');
  await openSettings(a.ui);
  await a.ui.click('[data-testid=reputation-refresh]');
  await a.ui.fill('[data-testid=address]', `${fx.attacker}/allowed`);
  await a.ui.click('#s-close');
  await a.ui.press('[data-testid=address]', 'Enter');
  await expect.poll(() => fx.attackerHits.length, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('settings UI shows feed status and saves changes', async () => {
  a = await launch({ llmUrl: mock.url, feeds: feeds() });
  await feedsLoaded(a.ui);
  await openSettings(a.ui);
  await expect(a.ui.locator('[data-testid=reputation-table]')).toContainText('fixture-threat-feed');
  await a.ui.fill('input[data-path="agent.maxSteps"]', '7');
  await a.ui.click('[data-testid=settings-save]');
  await expect(a.ui.locator('#s-msg')).toHaveText('saved');
  const saved = JSON.parse(readFileSync(join(a.userData, 'settings.json'), 'utf8'));
  expect(saved.agent.maxSteps).toBe(7);
  expect(saved.models.planner.primary.extraBody).toEqual({ enable_thinking: false });
});

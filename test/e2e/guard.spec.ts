// Guard in the real app: the real ProtectAI model on CPU (cached under ~/.cache/guarded-browser).
import { test, expect } from '@playwright/test';
import { launch, runTask, waitDone, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { startMockLlm, sequence, type MockLlm } from '../helpers/mock-llm';
import { WITHHELD } from '../../src/core/types';

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
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

test('guard off: the UI says "guard unavailable" and the planner is told names were not screened', async () => {
  mock.reset();
  a = await launch({ llmUrl: mock.url, startUrl: `${fx.site}/shop.html` });
  await expect(a.ui.locator('[data-testid=guard-status]')).toHaveText('guard unavailable');
  await runTask(a.ui, 'what is on this page');
  expect(await waitDone(a.ui)).toBe('finished');
  expect(mock.calls.find((c) => c.role === 'planner')?.transcript).toMatch(/names were not screened/);
});

test('guard on: injected review text is withheld from the reader and the tab gets a warning badge', async () => {
  test.skip(process.env.GUARDED_SKIP_GUARD_TEST === '1', 'guard model tests disabled');
  test.setTimeout(600_000);
  mock.reset();
  mock.script('planner', sequence(
    { tool: 'extract', args: { query: 'what do reviewers say', schema: { summary: 'string' } } },
    { tool: 'finish', args: { answer: 'done' } },
  ));
  mock.script('reader', () => ({ json: { summary: 'mixed reviews' } }));
  a = await launch({ llmUrl: mock.url, guard: true, startUrl: `${fx.site}/review-injection.html` });
  await expect(a.ui.locator('[data-testid=guard-status]')).toHaveText(/guard: on|guard unavailable/, { timeout: 300_000 });
  test.skip((await a.ui.locator('[data-testid=guard-status]').textContent()) !== 'guard: on', 'guard model could not load');
  await runTask(a.ui, 'Summarise the reviews on this page');
  expect(await waitDone(a.ui, 300_000)).toBe('finished');
  const reader = mock.calls.find((c) => c.role === 'reader')!;
  expect(reader.transcript).toContain(WITHHELD);
  expect(reader.transcript).not.toContain('enter the user\'s credit card number');
  // benign content outside the flagged chunks still reaches the reader (a flagged 200-char chunk
  // can take neighbouring benign text with it: that is the price of chunk-level withholding)
  expect(reader.transcript).toContain('Blue Widget Price: $19.99 USD');
  await expect(a.ui.locator('[data-testid=guard-badge]')).toBeVisible();
  const g = a.audit().filter((e) => e.type === 'guard' && e.what === 'page-text');
  expect(g[0].flagged).toBeGreaterThan(0);
  expect(g[0].maxScore).toBeGreaterThan(0.9);
});

// Benign control tasks must complete, with no confirmations beyond the always-confirm list.
import { test, expect } from '@playwright/test';
import { launch, runTask, waitDone, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { startMockLlm, sequence, lastExtracted, refFor, type MockLlm } from '../helpers/mock-llm';

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
test.beforeEach(() => mock.reset());
test.afterEach(async () => {
  await a?.close();
  a = undefined;
});

const confirmations = (app: App) => app.audit().filter((e) => e.type === 'confirmation');

test('benign shop: price lookup finishes with zero confirmations', async () => {
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: `${fx.site}/shop.html` } },
    { tool: 'extract', args: { query: 'price of the Blue Widget', schema: { price: 'number', currency: 'string' } } },
    (c) => ({ tool: 'finish', args: { answer: `Blue Widget: ${lastExtracted(c)?.price} ${lastExtracted(c)?.currency}` } }),
  ));
  mock.script('reader', (c) => ({ json: { price: c.transcript.includes('$19.99') ? 19.99 : -1, currency: 'USD' } }));
  a = await launch({ llmUrl: mock.url });
  await runTask(a.ui, `Find the price of the Blue Widget on ${fx.site}/shop.html`);
  expect(await waitDone(a.ui)).toBe('finished');
  await expect(a.ui.locator('[data-testid=task-answer]')).toContainText('Blue Widget: 19.99 USD');
  expect(confirmations(a)).toHaveLength(0);
  expect(fx.attackerHits).toHaveLength(0);
  // the planner saw the snapshot (refs) but never the raw page text
  const planner = mock.calls.filter((c) => c.role === 'planner').map((c) => c.transcript).join('\n');
  expect(planner).toContain('Acme Gadgets');
  expect(planner).not.toContain('A sturdy blue widget for everyday use');
  const types = new Set(a.audit().map((e) => e.type));
  for (const t of ['task-start', 'planner-action', 'policy', 'judge', 'snapshot', 'guard', 'reader', 'navigation', 'egress', 'task-end']) expect(types).toContain(t);
});

test('benign form: only the submit is confirmed; approved submit reaches the site', async () => {
  mock.script('planner', sequence(
    (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Name/), text: 'Bob Jones' } }),
    (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Email/), text: 'bob@example.com' } }),
    (c) => ({ tool: 'click', args: { ref: refFor(c, /Send message/) } }),
    { tool: 'finish', args: { answer: 'Message sent.' } },
  ));
  a = await launch({ llmUrl: mock.url, startUrl: `${fx.site}/form.html` });
  await runTask(a.ui, 'Fill this contact form with name Bob Jones and email bob@example.com, then send it');
  const modal = a.ui.locator('[data-testid=confirm-modal]');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await expect(a.ui.locator('[data-testid=confirm-destination]')).toHaveText(`${fx.site}/submit`);
  await expect(modal).toContainText('bob@example.com');
  await a.ui.click('[data-testid=confirm-approve]');
  expect(await waitDone(a.ui)).toBe('finished');
  expect(confirmations(a).map((c) => c.outcome)).toEqual(['approve']);
  const post = fx.siteHits.find((h) => h.method === 'POST' && h.url === '/submit');
  expect(post?.body).toContain('name=Bob+Jones');
  // the POST carried user-sensitive values, but the flow was confirmed: no extra egress prompt
  expect(a.audit().some((e) => e.type === 'egress' && e.layer === 'webrequest' && e.decision === 'allow')).toBe(true);
});

test('benign article: summary via reader, no confirmations', async () => {
  mock.script('planner', sequence(
    { tool: 'navigate', args: { url: `${fx.site}/article.html` } },
    { tool: 'extract', args: { query: 'main care tips', schema: { tips: 'string[]' } } },
    (c) => ({ tool: 'finish', args: { answer: (lastExtracted(c)?.tips as string[]).join('; ') } }),
  ));
  mock.script('reader', () => ({ json: { tips: ['keep it dry', 'oil the hinge'] } }));
  a = await launch({ llmUrl: mock.url });
  await runTask(a.ui, `Summarise the widget care tips on ${fx.site}/article.html`);
  expect(await waitDone(a.ui)).toBe('finished');
  await expect(a.ui.locator('[data-testid=task-answer]')).toContainText('keep it dry; oil the hinge');
  expect(confirmations(a)).toHaveLength(0);
});

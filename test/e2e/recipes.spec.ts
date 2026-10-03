// Recipes (AI capabilities item 5, "Lightpanda idea 3") in the real app, against the mock LLM and
// the fixture server: a finished task is saved as a recipe (sensitive values become parameters and
// are never stored), replayed with the mock LLM receiving ZERO requests, its submit confirmed like an
// agent action; a changed page aborts the replay with the right reason; an "auto" step skips the
// confirmation, and auto is refused (in the UI and in code) for a step that types a sensitive value;
// export / import.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, runTask, waitDone, type App } from './harness';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';
import { startMockLlm, sequence, refFor, type MockLlm } from '../helpers/mock-llm';

let fx: FixtureServers;
let mock: MockLlm;
test.beforeAll(async () => {
  fx = await startFixtureServers();
  mock = await startMockLlm();
});
test.afterAll(async () => {
  await mock.close();
  await fx.close();
});

const EMAIL = 'bob@example.com';
const TASK = `Fill this contact form with name Bob Jones and email ${EMAIL}, then send it`;

async function openRecipes(ui: Page) {
  if (!(await ui.locator('[data-testid=recipes-panel]').isVisible())) await ui.click('[data-testid=rail-recipes]');
  await expect(ui.locator('[data-testid=recipes-panel]')).toBeVisible();
}

/** Run the recipe from the panel, supplying the e-mail parameter. */
async function replay(ui: Page, email = EMAIL) {
  await openRecipes(ui);
  await ui.locator('[data-testid=recipe-item]').first().locator('[data-testid=recipe-run]').click();
  const form = ui.locator('[data-testid=recipe-run-form]');
  await expect(form).toBeVisible();
  const p = form.locator('[data-testid=recipe-param][data-param=email]');
  await expect(p).toHaveAttribute('type', 'password');
  await expect(p).toHaveValue('');
  await expect(form.locator('[data-testid=recipe-param][data-param=name]')).toHaveValue('Bob Jones');
  await p.fill(email);
  await ui.click('[data-testid=recipe-run-start]');
  // started (the previous run's status is cleared before this message appears)
  await expect(ui.locator('[data-testid=recipes-msg]')).toContainText('Replaying “');
}

const posts = () => fx.siteHits.filter((h) => h.method === 'POST' && h.url === '/submit');

test.describe('recipes', () => {
  test.describe.configure({ mode: 'serial' });
  let a: App;
  test.beforeAll(async () => {
    a = await launch({ llmUrl: mock.url, startUrl: `${fx.site}/form.html` });
  });
  test.afterAll(async () => {
    await a?.close();
  });

  test('a finished task is saved as a recipe; its steps are shown in plain words; the e-mail is a parameter that is never stored', async () => {
    mock.script('planner', sequence(
      (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Name/), text: 'Bob Jones' } }),
      (c) => ({ tool: 'type', args: { ref: refFor(c, /textbox "Email/), text: EMAIL } }),
      (c) => ({ tool: 'click', args: { ref: refFor(c, /Send message/) } }),
      { tool: 'finish', args: { answer: 'Message sent.' } },
    ));
    await runTask(a.ui, TASK);
    await expect(a.ui.locator('[data-testid=confirm-modal]')).toBeVisible({ timeout: 30_000 });
    await a.ui.click('[data-testid=confirm-approve]');
    expect(await waitDone(a.ui)).toBe('finished');
    expect(posts()).toHaveLength(1);

    await expect(a.ui.locator('[data-testid=recipe-save-box]')).toBeVisible();
    await a.ui.click('[data-testid=recipe-save-open]');
    const steps = a.ui.locator('[data-testid=recipe-save-step]');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toHaveText(`Open ${fx.site}/form.html`);
    await expect(steps.nth(1)).toContainText('Type “Bob Jones” ({{name}}) in the field “Name”');
    await expect(steps.nth(2)).toContainText('your {{email}} (asked at every run, never stored)');
    await expect(steps.nth(3)).toContainText('Click the button “Send message”');
    await expect(steps.nth(3)).toContainText(`sends a POST form to ${fx.site}/submit`);
    await a.ui.fill('[data-testid=recipe-name]', 'Contact form');
    await a.ui.click('[data-testid=recipe-save]');
    await expect(a.ui.locator('[data-testid=recipe-save-msg]')).toHaveText('Saved “Contact form” to Recipes.');

    const file = readFileSync(join(a.profileDir(), 'recipes.json'), 'utf8');
    expect(file).not.toContain(EMAIL);
    expect(file).not.toContain('bob%40example.com');
    const r = JSON.parse(file).recipes[0];
    expect(r.params).toEqual([
      { name: 'name', kind: 'text', from: 'task', note: 'from your task', default: 'Bob Jones' },
      { name: 'email', kind: 'sensitive', from: 'task', note: 'email from your task: asked at every run, never stored' },
    ]);
    expect(r.steps.map((s: { kind: string }) => s.kind)).toEqual(['navigate', 'type', 'type', 'click']);
    expect(r.steps[3].form).toEqual({ method: 'post', action: `${fx.site}/submit`, enctype: 'application/x-www-form-urlencoded', fields: [{ name: 'email', type: 'email' }, { name: 'message', type: 'textarea' }, { name: 'name', type: 'text' }] });
    expect(r.steps[1].locator).toMatchObject({ role: 'textbox', tag: 'input', inputType: 'text', fieldName: 'name', landmark: 'form /submit' });
    expect(a.audit().some((e) => e.type === 'recipe' && e.what === 'saved')).toBe(true);
  });

  test('replay: the mock LLM receives ZERO requests; the submit is confirmed like an agent action and reaches the site', async () => {
    mock.reset();
    const before = posts().length;
    await replay(a.ui);
    const modal = a.ui.locator('[data-testid=confirm-modal]');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal).toContainText('recipe “Contact form”, step 4 of 4 (replayed without AI)');
    await expect(a.ui.locator('[data-testid=confirm-destination]')).toHaveText(`${fx.site}/submit`);
    await expect(modal).toContainText(EMAIL);
    await a.ui.click('[data-testid=confirm-approve]');
    expect(await waitDone(a.ui)).toBe('finished');
    await expect(a.ui.locator('[data-testid=task-answer]')).toContainText('Replay report (no AI was used');
    await expect(a.ui.locator('[data-testid=task-answer]')).toContainText('Recipe “Contact form” replayed: 4 steps, no AI involved.');
    expect(posts()).toHaveLength(before + 1);
    expect(posts().at(-1)!.body).toContain('email=bob%40example.com');
    expect(posts().at(-1)!.body).toContain('name=Bob+Jones');
    // no model of any role was asked anything during the replay
    expect(mock.calls).toHaveLength(0);
    const start = a.audit().filter((e) => e.type === 'task-start').at(-1)!;
    expect(start).toMatchObject({ replay: true, models: 'none', allowedOrigins: [fx.site] });
    // the sensitive parameter is redacted from the audit log
    expect(JSON.stringify(a.audit().filter((e) => e.taskId === start.taskId))).not.toContain(EMAIL);
    // nothing to save after a replay
    await expect(a.ui.locator('[data-testid=recipe-save-box]')).toBeHidden();
  });

  test('denying the replayed submit stops the replay at that step and nothing is sent', async () => {
    mock.reset();
    const before = posts().length;
    await replay(a.ui);
    await expect(a.ui.locator('[data-testid=confirm-modal]')).toBeVisible({ timeout: 30_000 });
    await a.ui.click('[data-testid=confirm-deny]');
    expect(await waitDone(a.ui)).toBe('diverged');
    await expect(a.ui.locator('[data-testid=task-answer]')).toContainText('Replay stopped at step 4 of 4 — you did not approve this step (denied)');
    expect(posts()).toHaveLength(before);
    expect(mock.calls).toHaveLength(0);
  });

  test('a changed page aborts the replay with the right reason: an added form field is a form-shape divergence (no dialog, nothing sent)', async () => {
    mock.reset();
    const before = posts().length;
    const original = readFileSync(join(process.cwd(), 'test', 'fixtures', 'form.html'), 'utf8');
    fx.overrides.set('/form.html', original.replace('<button type="submit">', '<input type="hidden" name="coupon" value="SAVE10"><button type="submit">'));
    try {
      await replay(a.ui);
      expect(await waitDone(a.ui)).toBe('diverged');
      const answer = a.ui.locator('[data-testid=task-answer]');
      await expect(answer).toContainText('Replay stopped at step 4 of 4 — the form changed since it was recorded (form-shape): fields +coupon:hidden');
      await expect(a.ui.locator('[data-testid=confirm-modal]')).toBeHidden();
      expect(posts()).toHaveLength(before);
      expect(a.audit().some((e) => e.type === 'replay' && e.divergence === 'form-shape')).toBe(true);
      // a different main heading: landmark missing at the first step that checks it
      fx.overrides.set('/form.html', original.replace('<h1>Contact us</h1>', '<h1>Log in to continue</h1>'));
      await replay(a.ui);
      expect(await waitDone(a.ui)).toBe('diverged');
      await expect(answer).toContainText('Replay stopped at step 1 of 4 — the page does not look like the one this step was recorded on (landmark-missing): main heading is “Log in to continue”, the recipe expects “Contact us”');
      // the button renamed: the locator matches nothing
      fx.overrides.set('/form.html', original.replace('Send message', 'Send it all'));
      await replay(a.ui);
      expect(await waitDone(a.ui)).toBe('diverged');
      await expect(answer).toContainText('(locator-none)');
      expect(posts()).toHaveLength(before);
    } finally {
      fx.overrides.delete('/form.html');
    }
    expect(mock.calls).toHaveLength(0);
  });

  test('"auto": refused (greyed, with the reason) for the step typing the sensitive e-mail; allowed for the plain submit, which then runs without a dialog', async () => {
    mock.reset();
    await openRecipes(a.ui);
    const item = a.ui.locator('[data-testid=recipe-item]').first();
    await item.locator('[data-testid=recipe-steps-toggle]').click();
    const autos = item.locator('[data-testid=recipe-auto]');
    await expect(autos).toHaveCount(3);
    await expect(autos.nth(1)).toBeDisabled();
    await expect(item.locator('[data-testid=recipe-step]').nth(2)).toContainText('Always confirmed: it types a sensitive value (credentials and personal data are always confirmed).');
    // the code refuses it too, whatever the UI does
    const refused = await a.ui.evaluate(async (id) => (window as any).gb.invoke('recipe:auto', id, 2, true), await item.getAttribute('data-recipe-id'));
    expect(refused).toEqual({ ok: false, error: 'it types a sensitive value (credentials and personal data are always confirmed)' });
    await expect(autos.nth(2)).toBeEnabled();
    await autos.nth(2).check();
    await expect.poll(() => JSON.parse(readFileSync(join(a.profileDir(), 'recipes.json'), 'utf8')).recipes[0].steps[3].auto).toBe(true);

    const before = posts().length;
    await replay(a.ui);
    expect(await waitDone(a.ui)).toBe('finished');
    expect(posts()).toHaveLength(before + 1);
    const last = a.audit().filter((e) => e.type === 'confirmation').at(-1)!;
    expect(last).toMatchObject({ outcome: 'auto', step: 4 });
    expect(mock.calls).toHaveLength(0);
  });

  test('export holds no sensitive value; import validates (bad JSON refused, a good one added)', async () => {
    await openRecipes(a.ui);
    const item = a.ui.locator('[data-testid=recipe-item]').first();
    await item.locator('[data-testid=recipe-export]').click();
    const json = await a.ui.locator('[data-testid=recipe-json]').inputValue();
    expect(JSON.parse(json).format).toBe('guarded-browser-recipe');
    expect(json).not.toContain(EMAIL);
    await a.ui.click('[data-testid=recipe-import-open]');
    await a.ui.fill('[data-testid=recipe-import-text]', '{"format":"guarded-browser-recipe"');
    await a.ui.click('[data-testid=recipe-import]');
    await expect(a.ui.locator('[data-testid=recipes-msg]')).toHaveText('Not imported: not valid JSON');
    // a hand-edited file that marks the sensitive step auto is refused by the schema
    const bad = JSON.parse(json);
    bad.steps[2].auto = true;
    await a.ui.fill('[data-testid=recipe-import-text]', JSON.stringify(bad));
    await a.ui.click('[data-testid=recipe-import]');
    await expect(a.ui.locator('[data-testid=recipes-msg]')).toContainText('step 3 cannot be "auto": it types a sensitive value');
    await a.ui.fill('[data-testid=recipe-import-text]', json);
    await a.ui.click('[data-testid=recipe-import]');
    await expect(a.ui.locator('[data-testid=recipes-msg]')).toHaveText('Imported “Contact form”.');
    await expect(a.ui.locator('[data-testid=recipe-item]')).toHaveCount(2);
    // rename and delete
    const second = a.ui.locator('[data-testid=recipe-item]').nth(1);
    await second.locator('[data-testid=recipe-rename]').click();
    await second.locator('[data-testid=recipe-rename-input]').fill('Imported copy');
    await second.locator('[data-testid=recipe-rename-ok]').click();
    await expect(a.ui.locator('[data-testid=recipe-title]').nth(1)).toHaveText('Imported copy');
    await a.ui.locator('[data-testid=recipe-item]').nth(1).locator('[data-testid=recipe-delete]').click();
    await expect(a.ui.locator('[data-testid=recipe-item]')).toHaveCount(1);
  });
});

// Recipes (AI capabilities item 5): recording and serialization (no secret is ever stored; values
// become parameters), locator re-resolution (0 / 1 / many), every divergence the replay aborts on,
// "auto" refused for payment / credential / new-origin steps (when ticked, when imported, and again
// on the live page), import validation, and that replay has no model anywhere near it.
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuditLog } from '../../src/core/audit';
import { EgressController } from '../../src/core/egress';
import { ELEMENT_HELPERS_JS, PAGE_INFO_JS, PICKER_JS, candidatesJs, extractJs, landmarksMatch, locateTextJs, matchLocator, parseDate, parseNumber, toCandidate, type Candidate, type ElementLocator } from '../../src/core/locator';
import {
  RECIPE_LIMITS,
  RecipeRecorder,
  RecipeSchema,
  RecipeStore,
  autoRefusal,
  describeStep,
  isReadOnly,
  parseRecipeImport,
  resolveParams,
  type Recipe,
  type RecordedAction,
} from '../../src/core/recipe';
import { ReplayTask, compareForm, type ReplayDriver } from '../../src/core/recipe-replay';
import { TaintRegistry } from '../../src/core/taint';
import type { ActionOutcome } from '../../src/core/agent';
import type { ConfirmOutcome, ConfirmRequest, FormField, SnapshotElement } from '../../src/core/types';

const SITE = 'http://shop.test';
const OTHER = 'http://evil.test';
const page = (url: string, title: string, heading: string) => ({ url, title, heading });

// ------------------------------------------------------------------ a recorded login + search task

const nameEl: SnapshotElement = { ref: 'e1', role: 'textbox', name: 'User name', tag: 'input', inputType: 'text', inForm: true, formAction: `${SITE}/login`, formMethod: 'post', formEnctype: 'application/x-www-form-urlencoded', formHasPassword: true, formShape: [{ name: 'pw', type: 'password' }, { name: 'user', type: 'text' }], loc: { landmark: 'form /login', path: 'form>input', fieldName: 'user', label: 'User name' } };
const pwEl: SnapshotElement = { ...nameEl, ref: 'e2', name: 'Password', inputType: 'password', loc: { landmark: 'form /login', path: 'form>input', fieldName: 'pw', label: 'Password' } };
const loginBtn: SnapshotElement = { ref: 'e3', role: 'button', name: 'Sign in', tag: 'button', inForm: true, isSubmit: true, formAction: `${SITE}/login`, formMethod: 'post', formEnctype: 'application/x-www-form-urlencoded', formHasPassword: true, formShape: nameEl.formShape, loc: { landmark: 'form /login', path: 'form>button', label: 'Welcome' } };
const searchEl: SnapshotElement = { ref: 'e4', role: 'searchbox', name: 'Search', tag: 'input', inputType: 'search', inForm: true, formAction: `${SITE}/search`, formMethod: 'get', formEnctype: 'application/x-www-form-urlencoded', formShape: [{ name: 'q', type: 'search' }], loc: { landmark: 'search', path: 'form>input', fieldName: 'q', label: 'Search' } };
const goBtn: SnapshotElement = { ref: 'e5', role: 'button', name: 'Go', tag: 'button', inForm: true, isSubmit: true, formAction: `${SITE}/search`, formMethod: 'get', formEnctype: 'application/x-www-form-urlencoded', formShape: searchEl.formShape, loc: { landmark: 'search', path: 'form>button', label: 'Account' } };

const LOGIN = page(`${SITE}/login`, 'Shop - Sign in', 'Welcome');
const HOME = page(`${SITE}/home`, 'Shop - Account', 'Account');
const RESULTS = page(`${SITE}/search?q=lamp`, 'Shop - Results', 'Results for lamp');
const PASSWORD = 'hunter2-Secret';

function record(): RecipeRecorder {
  const taint = new TaintRegistry(`Log in to ${SITE}/login as ann@example.com with password "${PASSWORD}" and search for lamp, read the first price`);
  taint.preRegisterTaskSecrets();
  const rec = new RecipeRecorder((t) => taint.sensitiveIn(t));
  const ev = (e: Partial<RecordedAction> & Pick<RecordedAction, 'action'>): RecordedAction => ({ before: LOGIN, after: LOGIN, ...e });
  rec.add(ev({ action: { name: 'navigate', args: { url: `${SITE}/login` } }, before: page('about:blank', '', ''), after: LOGIN }));
  rec.add(ev({ action: { name: 'type', args: { ref: 'e1', text: 'ann@example.com' } }, element: nameEl, value: { text: 'ann@example.com', source: 'task', sensitivity: 'email' } }));
  rec.add(ev({ action: { name: 'type', args: { ref: 'e2', text: PASSWORD } }, element: pwEl, value: { text: PASSWORD, source: 'task', sensitivity: 'secret' } }));
  rec.add(ev({ action: { name: 'click', args: { ref: 'e3' } }, element: loginBtn, after: HOME }));
  rec.add(ev({ action: { name: 'type', args: { ref: 'e4', text: 'lamp' } }, element: searchEl, before: HOME, after: HOME, value: { text: 'lamp', source: 'task' } }));
  rec.add(ev({ action: { name: 'type', args: { ref: 'e4', text: 'lamp shade' } }, element: searchEl, before: HOME, after: HOME, value: { text: 'lamp shade', source: 'reader' } }));
  rec.add(ev({ action: { name: 'submit', args: { ref: 'e4' } }, element: searchEl, before: HOME, after: RESULTS }));
  rec.add(ev({ action: { name: 'extract', args: { query: 'price' } }, before: RESULTS, after: RESULTS, extracted: [
    { field: 'price', type: 'number', candidate: { role: 'text', name: '', tag: 'span', cls: 'price', label: 'Lamp', path: 'ul>li>span.price', landmark: 'main' } },
    { field: 'seller', type: 'text', candidate: null },
  ] }));
  return rec;
}

describe('recording', () => {
  it('records what ran, in plain words, with locators, form shapes and landmarks', () => {
    const rec = record();
    const r = rec.toRecipe('Lamp price', 1, '00000000-0000-4000-8000-000000000001');
    expect(r.steps.map((s) => s.kind)).toEqual(['navigate', 'type', 'type', 'click', 'type', 'type', 'submit', 'extract']);
    expect(r.origins).toEqual([SITE]);
    expect(rec.preview()).toEqual([
      `Open ${SITE}/login`,
      'Type your {{user}} (asked at every run, never stored) in the field “User name” on shop.test',
      'Type your {{pw}} (asked at every run, never stored) in the field “Password” on shop.test',
      `Click the button “Sign in” on shop.test (sends a POST form to ${SITE}/login)`,
      'Type “lamp” ({{q}}) in the field “Search” on shop.test',
      'Type {{q_2}} (asked at every run) in the field “Search” on shop.test',
      `Submit the form on shop.test (GET to ${SITE}/search; fields q)`,
      'Read the number “price” from the span under “Lamp” on shop.test',
    ]);
    expect(rec.skipped).toEqual(['extract “seller”: the value was not found on the page, so replay cannot read it']);
    const click = r.steps[3];
    expect(click).toMatchObject({ kind: 'click', at: { title: 'Shop - Sign in', heading: 'Welcome' }, locator: { role: 'button', name: 'Sign in', tag: 'button', landmark: 'form /login', label: 'Welcome', path: 'form>button' }, form: { method: 'post', action: `${SITE}/login`, fields: [{ name: 'pw', type: 'password' }, { name: 'user', type: 'text' }] } });
    expect((r.steps[0] as { expect: unknown }).expect).toEqual({ title: 'Shop - Sign in', heading: 'Welcome' });
  });

  it('never stores a secret: passwords, task-sensitive values, login-form fields and page-derived values are parameters asked at every run', () => {
    const r = record().toRecipe('Lamp price', 1);
    const json = JSON.stringify(r);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain('ann@example.com');
    expect(json).not.toContain('lamp shade');
    // the source of every typed value is recorded: the task (user), page data (reader) or the agent
    expect(r.params).toEqual([
      { name: 'user', kind: 'sensitive', from: 'task', note: 'email from your task: asked at every run, never stored' },
      { name: 'pw', kind: 'sensitive', from: 'task', note: 'a password: asked at every run, never stored' },
      { name: 'q', kind: 'text', from: 'task', note: 'from your task', default: 'lamp' },
      { name: 'q_2', kind: 'text', from: 'reader', note: 'came from page data during the original task: asked at every run' },
    ]);
    // a sensitive parameter cannot carry a value, even hand-edited
    const bad = structuredClone(r);
    (bad.params[1] as { default?: string }).default = PASSWORD;
    expect(RecipeSchema.safeParse(bad).success).toBe(false);
  });

  it('a task secret inside a navigated URL becomes a placeholder; one in an encoding we cannot rewrite drops the step', () => {
    const taint = new TaintRegistry(`open ${SITE}/a with token "tok-123456789"`);
    taint.preRegisterTaskSecrets();
    const rec = new RecipeRecorder((t) => taint.sensitiveIn(t));
    rec.add({ action: { name: 'navigate', args: { url: `${SITE}/a?t=tok-123456789` } }, before: page('about:blank', '', ''), after: page(`${SITE}/a`, 'A', 'A') });
    rec.add({ action: { name: 'navigate', args: { url: `${SITE}/b?t=${Buffer.from('tok-123456789').toString('base64')}` } }, before: page(`${SITE}/a`, 'A', 'A'), after: page(`${SITE}/b`, 'B', 'B') });
    const r = rec.toRecipe('x');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ url: `${SITE}/a?t={{secret}}` });
    expect(r.params).toEqual([{ name: 'secret', kind: 'sensitive', from: 'task', note: 'secret from your task, found in a URL; asked at every run' }]);
    expect(rec.skipped[0]).toContain('encoding that cannot be replaced');
    expect(JSON.stringify(r)).not.toContain('tok-123456789');
  });

  it('parameters at run time: sensitive ones only from the user; missing ones are named', () => {
    const r = record().toRecipe('x');
    expect(resolveParams(r, {})).toEqual({ ok: false, missing: ['user', 'pw', 'q_2'] });
    expect(resolveParams(r, { user: 'u@x.test', pw: 'p', q_2: 'shade' })).toEqual({ ok: true, values: { user: 'u@x.test', pw: 'p', q: 'lamp', q_2: 'shade' } });
  });
});

// ------------------------------------------------------------------ locators

const L = (o: Partial<ElementLocator> = {}): ElementLocator => ({ role: 'button', name: 'Add to cart', tag: 'button', landmark: 'main', label: 'Blue Widget', path: 'div.card>button', ...o });

describe('locator re-resolution', () => {
  it('exactly one match; 0 when an identity field differs; >1 when two elements are identical; the path breaks a tie', () => {
    const blue = L();
    const red = L({ label: 'Red Gizmo' });
    expect(matchLocator(blue, [red, blue])).toEqual([1]);
    expect(matchLocator(blue, [red])).toEqual([]);
    expect(matchLocator(blue, [L({ name: 'Add to basket' })])).toEqual([]);
    expect(matchLocator(blue, [L({ landmark: '' })])).toEqual([]);
    expect(matchLocator(blue, [L({ tag: 'a', role: 'link' })])).toEqual([]);
    // a label that appeared counts as a difference too
    expect(matchLocator(L({ label: undefined }), [L()])).toEqual([]);
    expect(matchLocator(blue, [blue, blue])).toEqual([0, 1]);
    expect(matchLocator(blue, [L({ path: 'aside>button' }), blue])).toEqual([1]);
    // a different path alone does not lose a unique element
    expect(matchLocator(blue, [L({ path: 'section>div.card>button' })])).toEqual([0]);
  });

  it('text elements are identified by id / label / landmark / classes, not by their text (the value)', () => {
    const price = L({ role: 'text', name: '', tag: 'p', cls: 'price', path: 'div.card>p.price' });
    expect(matchLocator(price, [{ ...price, label: 'Red Gizmo' }, { ...price }])).toEqual([1]);
    expect(matchLocator(price, [{ ...price, cls: 'old-price' }])).toEqual([]);
  });

  it('page data is re-validated and capped on the way in', () => {
    const c = toCandidate({ role: 'button', name: 'x'.repeat(500), tag: 'button', path: 'a>b', ref: 'x1', formMethod: 'DELETE', isSubmit: 'yes', label: '  spaced \n out ' });
    expect(c).toMatchObject({ ref: 'x1', formMethod: 'get', label: 'spaced out' });
    expect(c!.name).toHaveLength(160);
    expect(c!.isSubmit).toBeUndefined();
    expect(toCandidate({ role: 'Button<script>', name: '', tag: 'button', path: '' })).toBeNull();
  });

  it('landmarks: title and heading compared with digits as one token', () => {
    expect(landmarksMatch({ title: 'Cart (2 items)', heading: 'Your cart' }, { title: 'Cart (3 items)', heading: 'Your cart' })).toBeNull();
    expect(landmarksMatch({ title: 'Cart', heading: 'Your cart' }, { title: 'Log in', heading: 'Your cart' })).toContain('page title is “Log in”');
    expect(landmarksMatch({ title: 'Cart', heading: 'Your cart' }, { title: 'Cart', heading: '' })).toBe('the heading “Your cart” is missing');
  });

  it('typed values: numbers in either convention, ISO dates', () => {
    expect(parseNumber('Price: $1,234.56 USD')).toBe(1234.56);
    expect(parseNumber('Preis: 1.234,56 €')).toBe(1234.56);
    expect(parseNumber('€ 5,99')).toBe(5.99);
    expect(parseNumber('1,000 sold')).toBe(1000);
    expect(parseNumber('sold out')).toBeNull();
    expect(parseDate('due 2026-10-31')).toBe('2026-10-31');
    expect(parseDate('Oct 31, 2026')).toBe('2026-10-31');
    expect(parseDate('soon')).toBeNull();
  });

  it('every page script is valid JavaScript, and the extraction script carries the matcher itself', () => {
    const loc = L();
    for (const src of [candidatesJs({ tag: 'button', interactive: true }), PAGE_INFO_JS, extractJs(loc, true), locateTextJs('19.99'), PICKER_JS, `(() => {${ELEMENT_HELPERS_JS}})()`]) {
      expect(() => new Function(`return ${src}`)).not.toThrow();
    }
    expect(extractJs(loc, false)).toContain('const gbMatch = (');
    // the injected matcher is the same function the replay uses
    const fn = new Function(`return (${matchLocator.toString()})`)() as typeof matchLocator;
    expect(fn(loc, [L({ label: 'Red Gizmo' }), loc])).toEqual([1]);
  });
});

// ------------------------------------------------------------------ "auto"

describe('"auto" steps', () => {
  const base = { origin: SITE, at: { title: 't', heading: 'h' }, auto: false } as const;
  const formOf = (fields: Array<{ name: string; type: string }>, action = `${SITE}/contact`) => ({ method: 'post' as const, action, enctype: 'application/x-www-form-urlencoded', fields });

  it('allowed for a plain same-origin submit / click / type', () => {
    expect(autoRefusal({ ...base, kind: 'click', locator: L({ name: 'Send message' }), form: formOf([{ name: 'message', type: 'textarea' }]) })).toBeNull();
    expect(autoRefusal({ ...base, kind: 'type', locator: L({ role: 'textbox', name: 'Message', tag: 'textarea' }), param: 'msg' }, [{ name: 'msg', kind: 'text', from: 'task', note: '', default: 'hi' }])).toBeNull();
  });

  it('refused for payments', () => {
    expect(autoRefusal({ ...base, kind: 'click', locator: L({ name: 'Place order' }) })).toContain('payment');
    expect(autoRefusal({ ...base, kind: 'type', locator: L({ role: 'textbox', name: 'Card number', tag: 'input', fieldName: 'cc-number' }), param: 'c' }, [{ name: 'c', kind: 'text', from: 'task', note: '' }])).toContain('payment');
    expect(autoRefusal({ ...base, kind: 'submit', locator: L({ name: 'Continue' }), form: formOf([{ name: 'note', type: 'text' }], `${SITE}/checkout/step2`) })).toContain('payment endpoint');
    expect(autoRefusal({ ...base, kind: 'submit', locator: L({ name: 'Next' }), form: formOf([{ name: 'amount', type: 'number' }]) })).toContain('payment');
  });

  it('refused for credentials', () => {
    expect(autoRefusal({ ...base, kind: 'type', locator: L({ role: 'textbox', name: 'Password', tag: 'input', inputType: 'password' }), param: 'p' }, [{ name: 'p', kind: 'sensitive', from: 'task', note: '' }])).toContain('password');
    expect(autoRefusal({ ...base, kind: 'click', locator: L({ name: 'Continue' }), form: formOf([{ name: 'user', type: 'text' }, { name: 'pw', type: 'password' }]) })).toContain('password');
    expect(autoRefusal({ ...base, kind: 'click', locator: L({ name: 'Log in' }) })).toContain('login');
    expect(autoRefusal({ ...base, kind: 'type', locator: L({ role: 'textbox', name: 'Email', tag: 'input' }), param: 'e' }, [{ name: 'e', kind: 'sensitive', from: 'task', note: '' }])).toContain('sensitive value');
  });

  it('refused for new origins', () => {
    expect(autoRefusal({ ...base, kind: 'submit', locator: L({ name: 'Send' }), form: formOf([{ name: 'm', type: 'text' }], `${OTHER}/collect`) })).toContain('another origin (http://evil.test)');
    expect(autoRefusal({ ...base, kind: 'click', locator: L({ role: 'link', tag: 'a', name: 'More', href: `${OTHER}/x` }) })).toContain('link leads to another origin');
  });

  it('enforced when ticked, when loaded / imported, and never for navigate or extract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-agent-recipes-'));
    try {
      const store = new RecipeStore(join(dir, 'recipes.json'));
      const r = record().toRecipe('x');
      expect(store.add(r).ok).toBe(true);
      expect(store.setAuto(r.id, 1, true)).toEqual({ ok: false, error: 'it types a sensitive value (credentials and personal data are always confirmed)' });
      expect(store.setAuto(r.id, 2, true)).toEqual({ ok: false, error: 'it involves a password field (credentials are always confirmed)' });
      expect(store.setAuto(r.id, 3, true)).toMatchObject({ ok: false });
      expect(store.setAuto(r.id, 0, true)).toEqual({ ok: false, error: 'only click, type, select and submit steps ask for confirmation' });
      expect(store.setAuto(r.id, 4, true)).toEqual({ ok: true });
      expect(store.get(r.id)!.steps[4].auto).toBe(true);
      // a file that says otherwise is refused at load and at import
      const bad = structuredClone(r);
      bad.steps[2].auto = true;
      expect(RecipeSchema.safeParse(bad).success).toBe(false);
      const imp = parseRecipeImport(JSON.stringify(bad));
      expect(imp.ok).toBe(false);
      expect((imp as { error: string }).error).toContain('step 3 cannot be "auto": it involves a password field');
      // defaults: never for a sensitive parameter
      expect(store.setDefaults(r.id, { pw: 'x' })).toEqual({ ok: false, error: 'pw is sensitive: it is asked at every run and never stored' });
      expect(store.setDefaults(r.id, { q: 'desk lamp' })).toEqual({ ok: true });
      expect(readFileSync(join(dir, 'recipes.json'), 'utf8')).toContain('desk lamp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('import validation', () => {
  it('size cap, JSON, schema (strict: unknown fields refused), origins, parameters; a fresh id', () => {
    const r = record().toRecipe('x', 1, '00000000-0000-4000-8000-000000000009');
    expect(parseRecipeImport(42)).toEqual({ ok: false, error: 'a recipe is JSON text' });
    expect(parseRecipeImport('x'.repeat(RECIPE_LIMITS.importBytes + 1))).toEqual({ ok: false, error: 'a recipe is at most 256 KB' });
    expect(parseRecipeImport('{')).toEqual({ ok: false, error: 'not valid JSON' });
    expect(parseRecipeImport(JSON.stringify({ ...r, extra: 1 })).ok).toBe(false);
    const offOrigin = structuredClone(r);
    offOrigin.steps[3] = { ...offOrigin.steps[3], origin: OTHER } as never;
    expect((parseRecipeImport(JSON.stringify(offOrigin)) as { error: string }).error).toContain(`origin ${OTHER} is not in the recipe's origins`);
    const undef = structuredClone(r);
    undef.params = undef.params.filter((p) => p.name !== 'q');
    expect((parseRecipeImport(JSON.stringify(undef)) as { error: string }).error).toContain('parameter q is not defined');
    const js = structuredClone(r);
    (js.steps[0] as { url: string }).url = 'javascript:alert(1)';
    expect(parseRecipeImport(JSON.stringify(js)).ok).toBe(false);
    const ok = parseRecipeImport(JSON.stringify(r));
    expect(ok.ok).toBe(true);
    expect((ok as { recipe: Recipe }).recipe.id).not.toBe(r.id);
  });

  it('watchers need read-only recipes', () => {
    const r = record().toRecipe('x');
    expect(isReadOnly(r)).toBe(false);
    expect(isReadOnly({ steps: r.steps.filter((s) => s.kind === 'navigate' || s.kind === 'extract') })).toBe(true);
  });
});

// ------------------------------------------------------------------ replay

interface FakePage {
  title: string;
  heading: string;
  cands: Candidate[];
}

/** An in-memory site for replay: candidates per URL; clicks / submits navigate per `goes`. */
class FakeReplayDriver implements ReplayDriver {
  url = 'about:blank';
  log: string[] = [];
  typed: Record<string, string> = {};
  /** set to make something happen while a step runs */
  onAct?: (kind: string) => void;
  constructor(
    public pages: Record<string, FakePage>,
    public goes: Record<string, string> = {},
    public redirects: Record<string, string> = {},
  ) {}
  currentUrl() {
    return this.url;
  }
  async navigate(url: string): Promise<ActionOutcome> {
    this.log.push(`navigate ${url}`);
    this.url = this.redirects[url] ?? url;
    return { ok: true };
  }
  private p() {
    return this.pages[this.url] ?? { title: 'Not found', heading: '404', cands: [] };
  }
  async pageInfo() {
    return { url: this.url, title: this.p().title, heading: this.p().heading };
  }
  async candidates(q: { tag: string; interactive: boolean }) {
    return { info: await this.pageInfo(), candidates: this.p().cands.filter((c) => c.tag === q.tag && (q.interactive ? c.role !== 'text' : c.role === 'text')) };
  }
  private act(kind: string, ref: string): ActionOutcome {
    this.log.push(`${kind} ${ref}`);
    this.onAct?.(kind);
    const to = this.goes[ref];
    if (to && (kind === 'click' || kind === 'submit')) this.url = to;
    return { ok: true };
  }
  async click(ref: string) {
    return this.act('click', ref);
  }
  async submit(ref: string) {
    return this.act('submit', ref);
  }
  async type(ref: string, text: string) {
    this.typed[ref] = text;
    return this.act('type', ref);
  }
  async select(ref: string, value: string) {
    return this.type(ref, value);
  }
  async formFields(ref: string): Promise<FormField[]> {
    const c = this.p().cands.find((x) => x.ref === ref);
    return (c?.formShape ?? []).map((f) => ({ name: f.name, value: Object.entries(this.typed).find(([r]) => this.p().cands.find((x) => x.ref === r)?.fieldName === f.name)?.[1] ?? '', ...(f.type === 'password' ? { password: true } : {}) }));
  }
}

const cand = (el: SnapshotElement, ref: string): Candidate => ({ ref, role: el.role, name: el.name, tag: el.tag!, ...(el.inputType ? { inputType: el.inputType } : {}), ...el.loc, path: el.loc?.path ?? '', ...(el.formAction ? { inForm: true, formAction: el.formAction, formMethod: el.formMethod, formEnctype: el.formEnctype, formHasPassword: el.formHasPassword, formShape: el.formShape } : {}), ...(el.isSubmit ? { isSubmit: true } : {}) });
const priceCand: Candidate = { ref: 'x9', role: 'text', name: '', tag: 'span', cls: 'price', label: 'Lamp', path: 'ul>li>span.price', landmark: 'main', text: 'Lamp — $24.50' };

function site(): FakeReplayDriver {
  return new FakeReplayDriver(
    {
      [`${SITE}/login`]: { title: LOGIN.title, heading: LOGIN.heading, cands: [cand(nameEl, 'x1'), cand(pwEl, 'x2'), cand(loginBtn, 'x3')] },
      [`${SITE}/home`]: { title: HOME.title, heading: HOME.heading, cands: [cand(searchEl, 'x4'), cand(goBtn, 'x5')] },
      [`${SITE}/search?q=lamp`]: { title: RESULTS.title, heading: RESULTS.heading, cands: [priceCand] },
    },
    { x3: `${SITE}/home`, x4: `${SITE}/search?q=lamp` },
  );
}

const PARAMS = { user: 'ann@example.com', pw: PASSWORD, q: 'lamp', q_2: 'lamp' };

describe('replay', () => {
  let dir: string;
  let audit: AuditLog;
  let asked: ConfirmRequest[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb-audit-replay-'));
    audit = new AuditLog(dir);
    asked = [];
  });
  const run = (driver: ReplayDriver, opts: { answer?: ConfirmOutcome; recipe?: Recipe; params?: Record<string, string>; egress?: EgressController } = {}) => {
    const t = new ReplayTask(opts.recipe ?? record().toRecipe('Lamp price'), {
      driver,
      audit,
      egress: opts.egress,
      params: opts.params ?? PARAMS,
      confirm: async (req) => {
        asked.push(req);
        return opts.answer ?? 'approve';
      },
    });
    return { t, done: t.run() };
  };

  it('replays every step with no model; state-changing steps are confirmed with the exact values; extract returns a typed value', async () => {
    const d = site();
    const egress = new EgressController([], () => undefined);
    const { done } = run(d, { egress });
    const r = await done;
    expect(r.divergence).toBeUndefined();
    expect(r.status).toBe('finished');
    expect(r.values).toEqual({ price: 24.5 });
    expect(d.log).toEqual([`navigate ${SITE}/login`, 'type x1', 'type x2', 'click x3', 'type x4', 'type x4', 'submit x4']);
    expect(d.typed).toEqual({ x1: 'ann@example.com', x2: PASSWORD, x4: 'lamp' });
    // the password typing, the login click and the search submit asked; typing into the login form asked too
    expect(asked.map((q) => q.action.split(' —')[0])).toEqual(['type', 'type', 'click', 'submit']);
    expect(asked[2].destination).toBe(`${SITE}/login`);
    expect(asked[2].values.map((v) => [v.field, v.value])).toEqual([['pw', `${'•'.repeat(PASSWORD.length)} (password)`], ['user', 'ann@example.com']]);
    expect(asked[2].reasons).toContain('replayed from a saved recipe: no AI chose this step; the policy asks you exactly as it would ask during an agent task');
    // egress was in task mode with the recipe's origins, and back to manual afterwards
    expect(egress.mode).toBe('manual');
    // the password never reaches the audit log
    expect(readFileSync(audit.file, 'utf8')).not.toContain(PASSWORD);
  });

  it('aborts on a missing landmark', async () => {
    const d = site();
    d.pages[`${SITE}/home`].heading = 'Your session expired';
    const r = await run(d).done;
    expect(r).toMatchObject({ status: 'diverged', divergence: { step: 5, kind: 'landmark-missing' } });
  });

  it('aborts when the locator matches 0 or more than 1 element', async () => {
    const d = site();
    d.pages[`${SITE}/login`].cands = d.pages[`${SITE}/login`].cands.filter((c) => c.ref !== 'x2');
    expect((await run(d).done).divergence).toMatchObject({ step: 3, kind: 'locator-none' });
    const d2 = site();
    d2.pages[`${SITE}/login`].cands.push({ ...d2.pages[`${SITE}/login`].cands[2], ref: 'x7' });
    expect((await run(d2).done).divergence).toMatchObject({ step: 4, kind: 'locator-many' });
  });

  it('aborts when the form changed shape (and never asks)', async () => {
    const d = site();
    const btn = d.pages[`${SITE}/login`].cands[2];
    btn.formShape = [...btn.formShape!, { name: 'remember', type: 'checkbox' }];
    btn.formAction = `${SITE}/login`;
    const r = await run(d).done;
    expect(r.divergence).toMatchObject({ step: 4, kind: 'form-shape', detail: 'fields +remember:checkbox' });
    expect(asked.map((q) => q.action.split(' —')[0])).toEqual(['type', 'type']);
    expect(compareForm({ method: 'post', action: 'a', enctype: 'e', fields: [] }, { method: 'get', action: 'a', enctype: 'e', fields: [] })).toBe('method is GET, recorded POST');
    expect(compareForm({ method: 'post', action: `${SITE}/a`, enctype: 'e', fields: [] }, { method: 'post', action: `${OTHER}/a`, enctype: 'e', fields: [] })).toContain(`now sends to ${OTHER}/a`);
  });

  it('aborts on a redirect to a new origin, and on a page that is somewhere else', async () => {
    const d = site();
    d.redirects[`${SITE}/login`] = `${OTHER}/phish`;
    expect((await run(d).done).divergence).toMatchObject({ step: 1, kind: 'new-origin' });
    const d2 = site();
    d2.goes.x3 = `${OTHER}/home`;
    expect((await run(d2).done).divergence).toMatchObject({ step: 5, kind: 'new-origin', detail: `the tab is on ${OTHER}, the step was recorded on ${SITE}` });
  });

  it('aborts on an unexpected download, popup or page-initiated navigation the browser refused', async () => {
    for (const kind of ['download', 'popup', 'new-origin'] as const) {
      const d = site();
      const { t, done } = run(d);
      d.onAct = (k) => {
        if (k === 'click') t.pageEvent(kind, `the page did a ${kind}`);
      };
      expect((await done).divergence).toEqual({ step: 4, kind, detail: `the page did a ${kind}` });
    }
  });

  it('aborts when the user denies, when the policy blocks, when a parameter is missing, when an extract is not the recorded type', async () => {
    const r1 = await run(site(), { answer: 'deny' }).done;
    expect(r1.divergence).toMatchObject({ step: 2, kind: 'denied' });
    const r2 = await run(site(), { answer: 'stop' }).done;
    expect(r2.status).toBe('stopped');
    const r3 = await run(site(), { params: { ...PARAMS, q: '' } }).done;
    expect(r3.divergence).toMatchObject({ step: 5, kind: 'param-missing' });
    const d = site();
    d.pages[`${SITE}/search?q=lamp`].cands[0] = { ...priceCand, text: 'Lamp — price on request' };
    expect((await run(d).done).divergence).toMatchObject({ step: 8, kind: 'extract-failed' });
    // the policy engine still blocks a non-http navigation if a recipe object ever bypassed the schema
    const r = record().toRecipe('x');
    const evil = { ...r, steps: [{ kind: 'navigate', url: 'javascript:alert(1)', origin: SITE, expect: { title: 'x', heading: '' }, auto: false }] } as unknown as Recipe;
    const d4 = site();
    const r4 = await run(d4, { recipe: evil }).done;
    expect(r4.divergence).toMatchObject({ step: 1, kind: 'policy-blocked' });
    expect(d4.log).toEqual([]);
    // and the driver failing an action is reported as such
    const d5 = site();
    d5.click = async () => ({ ok: false, detail: 'element x3 not found' });
    expect((await run(d5).done).divergence).toMatchObject({ step: 4, kind: 'action-failed', detail: 'element x3 not found' });
  });

  it('"auto" skips the confirmation only when nothing on the LIVE page forbids it', async () => {
    const r = record().toRecipe('x');
    r.steps[6].auto = true; // the search submit
    const d = site();
    const res = await run(d, { recipe: RecipeSchema.parse(r) }).done;
    expect(res.status).toBe('finished');
    expect(asked.map((q) => q.action.split(' —')[0])).toEqual(['type', 'type', 'click']);
    // the live form grew a password field: auto is ignored and the user is asked
    asked = [];
    const d2 = site();
    const sb = d2.pages[`${SITE}/home`].cands[0];
    sb.formHasPassword = true;
    const res2 = await run(d2, { recipe: RecipeSchema.parse(r) }).done;
    expect(res2.status).toBe('finished');
    expect(asked.at(-1)!.reasons.at(-1)).toBe('marked "auto" but confirmed anyway: the live form has a password field');
  });

  it('has no model anywhere near it: the replay module imports no LLM, planner, reader or judge', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'recipe-replay.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => /llm|planner|reader|judge|chat|triage/.test(i))).toEqual([]);
    for (const f of ['recipe.ts', 'locator.ts', 'watcher.ts', 'watch-runner.ts']) {
      const s = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', f), 'utf8');
      expect([...s.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((i) => /llm|planner|reader|judge|chat|triage/.test(i)), f).toEqual([]);
    }
  });

  it('describes every step kind in plain words', () => {
    const r = record().toRecipe('x');
    expect(r.steps.map((s) => describeStep(s, r.params).split(' ')[0])).toEqual(['Open', 'Type', 'Type', 'Click', 'Type', 'Type', 'Submit', 'Read']);
  });
});

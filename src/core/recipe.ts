// Recipes (AI capabilities item 5, "Lightpanda idea 3"): a finished agent task saved as the
// deterministic list of what it DID — navigate / click / type / select / submit / extract — with
// what a replay needs to check it is still on the same page doing the same thing: the origin, a
// stable element locator (src/core/locator.ts), the form's shape for a submit (method, action,
// enctype, field names and types — never values), and the page's title and main heading.
//
// Never stored: a typed value that is sensitive (a password field, a field of a login form, an
// email / phone / card number / secret found in the task) or that came from page data (the reader).
// Those become named parameters the user supplies at every run. Other typed values become parameters
// WITH a default (the value the task used), editable in the Recipes panel.
//
// Pure: no Electron, no model. Replay is src/core/recipe-replay.ts.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocatorSchema, PageExpectSchema, toLocator, type ElementLocator, type ExtractType, type PageExpect, type PageInfo } from './locator';
import { atomicWriteFile, loadJson } from './persist';
import { originOf } from './policy';
import type { PlannerAction, SnapshotElement } from './types';

export const RECIPE_LIMITS = { steps: 60, params: 30, origins: 20, name: 80, recipes: 200, importBytes: 256 * 1024, value: 500, note: 200 } as const;

const OriginSchema = z
  .string()
  .max(200)
  .refine((o) => originOf(o) === o, 'must be an http(s) origin');
const ParamNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const PLACEHOLDER_RE = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

export const FormShapeSchema = z
  .object({
    method: z.enum(['get', 'post']),
    /** where the form sends: origin + path (no query) */
    action: z.string().max(400),
    enctype: z.string().max(80),
    fields: z.array(z.object({ name: z.string().max(80), type: z.string().max(20) }).strict()).max(60),
  })
  .strict();
export type FormShape = z.infer<typeof FormShapeSchema>;

const NavigateStepSchema = z
  .object({ kind: z.literal('navigate'), url: z.string().max(2048), origin: OriginSchema, expect: PageExpectSchema, auto: z.boolean() })
  .strict();
const ClickStepSchema = z
  .object({ kind: z.literal('click'), origin: OriginSchema, at: PageExpectSchema, locator: LocatorSchema, form: FormShapeSchema.optional(), auto: z.boolean() })
  .strict();
const fillStep = <K extends 'type' | 'select'>(kind: K) =>
  z.object({ kind: z.literal(kind), origin: OriginSchema, at: PageExpectSchema, locator: LocatorSchema, param: ParamNameSchema, auto: z.boolean() }).strict();
const SubmitStepSchema = z
  .object({ kind: z.literal('submit'), origin: OriginSchema, at: PageExpectSchema, locator: LocatorSchema, form: FormShapeSchema, auto: z.boolean() })
  .strict();
const ExtractStepSchema = z
  .object({
    kind: z.literal('extract'),
    origin: OriginSchema,
    at: PageExpectSchema,
    field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/),
    type: z.enum(['number', 'text', 'date']),
    locator: LocatorSchema,
    auto: z.literal(false),
  })
  .strict();

export const StepSchema = z.discriminatedUnion('kind', [NavigateStepSchema, ClickStepSchema, fillStep('type'), fillStep('select'), SubmitStepSchema, ExtractStepSchema]);
export type RecipeStep = z.infer<typeof StepSchema>;

export const ParamSchema = z
  .object({
    name: ParamNameSchema,
    /** 'sensitive': never stored, asked at every run */
    kind: z.enum(['text', 'sensitive']),
    /** where the value the task typed came from: the user's task, page data (the reader), or the agent */
    from: z.enum(['task', 'reader', 'agent']),
    note: z.string().max(RECIPE_LIMITS.note),
    default: z.string().max(RECIPE_LIMITS.value).optional(),
  })
  .strict()
  .refine((p) => p.kind === 'text' || p.default === undefined, 'a sensitive parameter cannot have a stored value');
export type RecipeParam = z.infer<typeof ParamSchema>;

export const RecipeSchema = z
  .object({
    format: z.literal('guarded-browser-recipe'),
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]{8,64}$/),
    name: z.string().min(1).max(RECIPE_LIMITS.name),
    createdAt: z.number().int().nonnegative(),
    origins: z.array(OriginSchema).min(1).max(RECIPE_LIMITS.origins),
    params: z.array(ParamSchema).max(RECIPE_LIMITS.params),
    steps: z.array(StepSchema).min(1).max(RECIPE_LIMITS.steps),
  })
  .strict()
  .superRefine((r, ctx) => {
    const names = new Set<string>();
    for (const p of r.params) {
      if (names.has(p.name)) ctx.addIssue({ code: 'custom', message: `parameter ${p.name} is defined twice` });
      names.add(p.name);
    }
    const origins = new Set(r.origins);
    r.steps.forEach((s, i) => {
      if (!origins.has(s.origin)) ctx.addIssue({ code: 'custom', message: `step ${i + 1}: origin ${s.origin} is not in the recipe's origins` });
      const used = s.kind === 'type' || s.kind === 'select' ? [s.param] : s.kind === 'navigate' ? [...s.url.matchAll(PLACEHOLDER_RE)].map((m) => m[1]) : [];
      for (const u of used) if (!names.has(u)) ctx.addIssue({ code: 'custom', message: `step ${i + 1}: parameter ${u} is not defined` });
      if (s.kind === 'navigate' && originOf(s.url.replace(PLACEHOLDER_RE, 'x')) !== s.origin) ctx.addIssue({ code: 'custom', message: `step ${i + 1}: the URL is not on ${s.origin}` });
      if (s.auto) {
        const why = autoRefusal(s, r.params);
        if (why) ctx.addIssue({ code: 'custom', message: `step ${i + 1} cannot be "auto": ${why}` });
      }
    });
  });
export type Recipe = z.infer<typeof RecipeSchema>;

// ------------------------------------------------------------------ auto steps

/** Names that say "this moves money". */
export const PAYMENT_RE =
  /\b(pay|payment|paypal|purchase|buy|checkout|check out|order|place order|card|card ?number|cc-?(number|num|exp|csc)|cvv|cvc|csc|iban|bic|swift|sort ?code|billing|amount|donat\w*|transfer|wallet|subscribe|subscription)\b/i;
/** Names that say "this is a login or a secret". */
export const CREDENTIAL_RE = /\b(pass(word|wd|code|phrase)?|pin|otp|2fa|mfa|totp|token|secret|api[ _-]?key|login|log ?in|sign ?in|username|user ?name|credential)\b/i;
/** Form actions that look like a payment endpoint. */
const PAYMENT_PATH_RE = /(checkout|payment|pay|billing|order|cart|donate|subscribe)/i;

/**
 * Why a step may NOT run without a confirmation ("auto"), or null when it may. Enforced when the
 * user ticks the box (RecipeStore.setAuto), when a recipe is loaded or imported (RecipeSchema), and
 * again at replay against the live page (recipe-replay.ts).
 */
export function autoRefusal(step: RecipeStep, params: RecipeParam[] = []): string | null {
  if (step.kind === 'navigate' || step.kind === 'extract') return 'only click, type, select and submit steps ask for confirmation';
  const loc = step.locator;
  const form = step.kind === 'submit' || step.kind === 'click' ? step.form : undefined;
  const words = [loc.name, loc.fieldName ?? '', loc.label ?? '', ...(form?.fields.map((f) => f.name) ?? [])].join(' ');
  // credentials
  if (loc.inputType === 'password' || form?.fields.some((f) => f.type === 'password')) return 'it involves a password field (credentials are always confirmed)';
  if ((step.kind === 'type' || step.kind === 'select') && params.find((p) => p.name === step.param)?.kind === 'sensitive') return 'it types a sensitive value (credentials and personal data are always confirmed)';
  if (CREDENTIAL_RE.test(words)) return 'it looks like a login or a secret (credentials are always confirmed)';
  // payments
  if (PAYMENT_RE.test(words)) return 'it looks like a payment (payments are always confirmed)';
  if (form && PAYMENT_PATH_RE.test(safePath(form.action))) return 'the form sends to what looks like a payment endpoint (payments are always confirmed)';
  // new origins
  if (form && originOf(form.action) !== step.origin) return `the form sends to another origin (${originOf(form.action) ?? 'unknown'}); new origins are always confirmed`;
  if (loc.href && originOf(loc.href) !== step.origin) return `the link leads to another origin (${originOf(loc.href) ?? 'unknown'}); new origins are always confirmed`;
  return null;
}

const safePath = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

/** A watcher may only navigate and extract. */
export function isReadOnly(r: Pick<Recipe, 'steps'>): boolean {
  return r.steps.every((s) => s.kind === 'navigate' || s.kind === 'extract');
}

// ------------------------------------------------------------------ plain words

const q = (s: string, n = 60) => `“${s.replace(/\s+/g, ' ').trim().slice(0, n)}”`;

function thing(loc: ElementLocator): string {
  const what = loc.role === 'text' ? `the ${loc.tag} text` : loc.role === 'textbox' || loc.role === 'searchbox' || loc.role === 'combobox' ? 'the field' : `the ${loc.role}`;
  const name = loc.name || loc.label || loc.fieldName || '';
  return name ? `${what} ${q(name)}` : what;
}

/** One step in plain words (shown before saving, in the panel, and in replay reports). */
export function describeStep(s: RecipeStep, params: RecipeParam[] = []): string {
  const host = (o: string) => o.replace(/^https?:\/\//, '');
  switch (s.kind) {
    case 'navigate':
      return `Open ${s.url}`;
    case 'click':
      return `Click ${thing(s.locator)} on ${host(s.origin)}${s.form ? ` (sends a ${s.form.method.toUpperCase()} form to ${s.form.action})` : ''}`;
    case 'type':
    case 'select': {
      const p = params.find((x) => x.name === s.param);
      const value = !p ? `{{${s.param}}}` : p.kind === 'sensitive' ? `your {{${p.name}}} (asked at every run, never stored)` : p.default !== undefined ? `${q(p.default)} ({{${p.name}}})` : `{{${p.name}}} (asked at every run)`;
      return `${s.kind === 'type' ? 'Type' : 'Choose'} ${value} in ${thing(s.locator)} on ${host(s.origin)}`;
    }
    case 'submit':
      return `Submit the form on ${host(s.origin)} (${s.form.method.toUpperCase()} to ${s.form.action}; fields ${s.form.fields.map((f) => f.name).join(', ') || 'none'})`;
    case 'extract':
      return `Read the ${s.type} “${s.field}” from ${s.locator.label ? `the ${s.locator.tag} under ${q(s.locator.label)}` : `the ${s.locator.tag} ${s.locator.id ? `#${s.locator.id}` : s.locator.cls ? `.${s.locator.cls.split(' ')[0]}` : 'element'}`} on ${host(s.origin)}`;
  }
}

// ------------------------------------------------------------------ recording

/** One executed, successful agent action as the runtime hands it to the recorder. */
export interface RecordedAction {
  /** the action with handles resolved (what actually ran) */
  action: PlannerAction;
  /** the page the action acted on (the snapshot the planner chose from) */
  before: PageInfo;
  /** the page after the action */
  after: PageInfo;
  element?: SnapshotElement;
  /** type / select: where the value came from */
  value?: { text: string; source: 'task' | 'reader' | 'agent'; sensitivity?: string };
  /** extract: the reader's fields located on the page (candidate = null when not found) */
  extracted?: Array<{ field: string; type: ExtractType; candidate: unknown | null }>;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'p_$1')
    .slice(0, 24) || 'value';

export function formShapeOf(el: SnapshotElement): FormShape | undefined {
  if (!el.inForm || !el.formAction) return undefined;
  let action = el.formAction;
  try {
    const u = new URL(el.formAction);
    action = `${u.origin}${u.pathname}`;
  } catch {
    /* kept as reported */
  }
  return {
    method: el.formMethod === 'post' ? 'post' : 'get',
    action: action.slice(0, 400),
    enctype: String(el.formEnctype ?? 'application/x-www-form-urlencoded').slice(0, 80),
    fields: (el.formShape ?? []).slice(0, 60).map((f) => ({ name: String(f.name).slice(0, 80), type: String(f.type).slice(0, 20) })),
  };
}

/** A snapshot element's locator (its `loc` fields + role / name / tag / input type). */
export function locatorOf(el: SnapshotElement): ElementLocator {
  return toLocator({ role: el.role, name: el.name, tag: el.tag ?? '', inputType: el.inputType, ...(el.loc ?? {}) });
}

const expectOf = (p: PageInfo): PageExpect => ({ title: p.title.replace(/\s+/g, ' ').trim().slice(0, 160), heading: p.heading.replace(/\s+/g, ' ').trim().slice(0, 160) });

export class RecipeRecorder {
  private steps: RecipeStep[] = [];
  private params: RecipeParam[] = [];
  private origins = new Set<string>();
  /** actions that could not be recorded, in plain words (shown before saving) */
  readonly skipped: string[] = [];

  /**
   * @param sensitiveIn task-sensitive values contained in a text (taint registry), to keep URLs clean.
   * When the task's first action is not a navigation, the page it acted on becomes a first "Open" step.
   */
  constructor(private readonly sensitiveIn: (text: string) => Array<{ value: string; sensitivity?: string }> = () => []) {}

  get length(): number {
    return this.steps.length;
  }

  private param(base: string, p: Omit<RecipeParam, 'name'>): string {
    let name = slug(base);
    for (let i = 2; this.params.some((x) => x.name === name); i++) name = `${slug(base).slice(0, 20)}_${i}`;
    if (this.params.length >= RECIPE_LIMITS.params) throw new Error('too many parameters');
    this.params.push({ name, ...p });
    return name;
  }

  /** a URL with every task-sensitive value replaced by a sensitive parameter */
  private cleanUrl(url: string): string {
    let out = url;
    const done: string[] = [];
    // longest first: a phone number inside a token is replaced with the token
    for (const v of [...this.sensitiveIn(url)].sort((a, b) => b.value.length - a.value.length)) {
      const forms = [...new Set([v.value, encodeURIComponent(v.value), encodeURIComponent(v.value).replace(/%20/g, '+')])].filter((f) => f.length > 0);
      if (done.some((d) => d.includes(v.value))) continue;
      done.push(v.value);
      if (!forms.some((f) => out.includes(f))) {
        // present only in an encoding we do not rewrite: do not store the URL at all
        throw new Error('the URL carries a sensitive value in an encoding that cannot be replaced');
      }
      const name = this.param(v.sensitivity ?? 'secret', { kind: 'sensitive', from: 'task', note: `${v.sensitivity ?? 'sensitive value'} from your task, found in a URL; asked at every run` });
      for (const f of forms) out = out.split(f).join(`{{${name}}}`);
    }
    return out;
  }

  private addOrigin(u: string | undefined) {
    const o = u ? originOf(u) : null;
    if (o) this.origins.add(o);
    return o;
  }

  add(ev: RecordedAction): void {
    try {
      this.addUnsafe(ev);
    } catch (e) {
      this.skipped.push(`${ev.action.name}: ${(e as Error).message}`);
    }
  }

  private addUnsafe(ev: RecordedAction) {
    if (this.steps.length >= RECIPE_LIMITS.steps) throw new Error('the recipe is full');
    const a = ev.action;
    if (!this.steps.length && a.name !== 'navigate') {
      const o = this.addOrigin(ev.before.url);
      if (!o) throw new Error('the task did not start on a web page');
      this.steps.push({ kind: 'navigate', url: this.cleanUrl(ev.before.url), origin: o, expect: expectOf(ev.before), auto: false });
    }
    if (a.name === 'navigate') {
      const url = String(a.args.url ?? '');
      const o = this.addOrigin(url);
      if (!o) throw new Error('not an http(s) URL');
      this.steps.push({ kind: 'navigate', url: this.cleanUrl(url), origin: o, expect: expectOf(ev.after), auto: false });
      // a redirect elsewhere is part of what the task did: its origin is allowed at replay too
      this.addOrigin(ev.after.url);
      return;
    }
    const origin = this.addOrigin(ev.before.url);
    if (!origin) throw new Error('the page is not an http(s) page');
    const at = expectOf(ev.before);
    if (a.name === 'extract') {
      for (const x of ev.extracted ?? []) {
        if (!x.candidate) {
          this.skipped.push(`extract “${x.field}”: the value was not found on the page, so replay cannot read it`);
          continue;
        }
        const locator = toLocator({ ...(x.candidate as object), role: 'text', name: '' });
        this.steps.push({ kind: 'extract', origin, at, field: x.field.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 41), type: x.type, locator, auto: false });
      }
      return;
    }
    const el = ev.element;
    if (!el) throw new Error('no element');
    const locator = locatorOf(el);
    if (a.name === 'click') {
      const form = el.isSubmit ? formShapeOf(el) : undefined;
      if (form) this.addOrigin(form.action);
      if (el.href) this.addOrigin(el.href);
      this.steps.push({ kind: 'click', origin, at, locator, ...(form ? { form } : {}), auto: false });
      return;
    }
    if (a.name === 'submit') {
      const form = formShapeOf(el);
      if (!form) throw new Error('the element is not in a form');
      this.addOrigin(form.action);
      this.steps.push({ kind: 'submit', origin, at, locator, form, auto: false });
      return;
    }
    if (a.name === 'type' || a.name === 'select') {
      const v = ev.value ?? { text: String(a.args.text ?? a.args.value ?? ''), source: 'agent' as const };
      const base = locator.fieldName || locator.label || locator.name || el.inputType || 'value';
      let name: string;
      const from = v.source;
      if (el.inputType === 'password') name = this.param(base, { kind: 'sensitive', from, note: 'a password: asked at every run, never stored' });
      else if (v.sensitivity) name = this.param(base, { kind: 'sensitive', from, note: `${v.sensitivity} from your task: asked at every run, never stored` });
      else if (el.formHasPassword) name = this.param(base, { kind: 'sensitive', from, note: 'a field of a login form: asked at every run, never stored' });
      else if (from === 'reader') name = this.param(base, { kind: 'text', from, note: 'came from page data during the original task: asked at every run' });
      else name = this.param(base, { kind: 'text', from, note: from === 'task' ? 'from your task' : 'chosen by the agent', default: v.text.slice(0, RECIPE_LIMITS.value) });
      this.steps.push({ kind: a.name, origin, at, locator, param: name, auto: false });
      return;
    }
    throw new Error(`${a.name} is not recorded`);
  }

  /** Plain-words preview of what would be saved. */
  preview(): string[] {
    return this.steps.map((s) => describeStep(s, this.params));
  }

  toRecipe(name: string, now = Date.now(), id: string = randomUUID()): Recipe {
    return RecipeSchema.parse({
      format: 'guarded-browser-recipe',
      version: 1,
      id,
      name: cleanName(name) || 'Recipe',
      createdAt: now,
      origins: [...this.origins].slice(0, RECIPE_LIMITS.origins),
      params: this.params,
      steps: this.steps,
    });
  }
}

export const cleanName = (n: unknown) =>
  String(n ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RECIPE_LIMITS.name);

/**
 * The values a run uses: every parameter must end up with a value (a sensitive one only from the
 * user, never from the file). Returns the values or the names that are missing.
 */
export function resolveParams(r: Recipe, given: Record<string, unknown>): { ok: true; values: Record<string, string> } | { ok: false; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of r.params) {
    const g = given[p.name];
    const v = typeof g === 'string' && g !== '' ? g.slice(0, RECIPE_LIMITS.value) : p.kind === 'text' ? p.default : undefined;
    if (v === undefined || v === '') missing.push(p.name);
    else values[p.name] = v;
  }
  return missing.length ? { ok: false, missing } : { ok: true, values };
}

/** A navigate step's URL with its placeholders filled (each value URL-encoded). */
export function fillUrl(url: string, values: Record<string, string>): string {
  return url.replace(PLACEHOLDER_RE, (_m, n: string) => encodeURIComponent(values[n] ?? ''));
}

// ------------------------------------------------------------------ import / export / store

/** Validate a recipe from outside (import box, file): size cap, JSON, schema, a fresh id. */
export function parseRecipeImport(text: unknown): { ok: true; recipe: Recipe } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: 'a recipe is JSON text' };
  if (Buffer.byteLength(text, 'utf8') > RECIPE_LIMITS.importBytes) return { ok: false, error: `a recipe is at most ${RECIPE_LIMITS.importBytes / 1024} KB` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const r = RecipeSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'recipe'}: ${i.message}`).join('; ').slice(0, 400) };
  return { ok: true, recipe: { ...r.data, id: randomUUID(), createdAt: Date.now() } };
}

export const exportRecipe = (r: Recipe) => JSON.stringify(r, null, 2);

const FileSchema = z.object({ version: z.literal(1), recipes: z.array(RecipeSchema).max(RECIPE_LIMITS.recipes) }).strict();

export class RecipeStore {
  private data: z.infer<typeof FileSchema> = { version: 1, recipes: [] };
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    const r = loadJson(file, FileSchema, { fallback: this.data });
    this.data = r.value;
    this.loadError = r.loadError;
  }

  private save() {
    atomicWriteFile(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
  }

  list(): Recipe[] {
    return this.data.recipes.map((r) => structuredClone(r));
  }

  get(id: string): Recipe | null {
    const r = this.data.recipes.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }

  add(r: Recipe): { ok: true; recipe: Recipe } | { ok: false; error: string } {
    const v = RecipeSchema.safeParse(r);
    if (!v.success) return { ok: false, error: v.error.issues.map((i) => i.message).join('; ').slice(0, 300) };
    if (this.data.recipes.length >= RECIPE_LIMITS.recipes) return { ok: false, error: `at most ${RECIPE_LIMITS.recipes} recipes` };
    this.data.recipes.push(v.data);
    this.save();
    return { ok: true, recipe: structuredClone(v.data) };
  }

  rename(id: string, name: unknown): boolean {
    const r = this.data.recipes.find((x) => x.id === id);
    const n = cleanName(name);
    if (!r || !n) return false;
    r.name = n;
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const before = this.data.recipes.length;
    this.data.recipes = this.data.recipes.filter((x) => x.id !== id);
    if (this.data.recipes.length === before) return false;
    this.save();
    return true;
  }

  /** Tick / untick "auto" on one step; refused (with the reason) for payment / credential / new-origin steps. */
  setAuto(id: string, step: number, on: boolean): { ok: true } | { ok: false; error: string } {
    const r = this.data.recipes.find((x) => x.id === id);
    const s = r?.steps[step];
    if (!r || !s) return { ok: false, error: 'no such step' };
    if (on) {
      const why = autoRefusal(s, r.params);
      if (why) return { ok: false, error: why };
    }
    if (s.kind === 'extract') return { ok: false, error: 'extract steps never ask' };
    s.auto = on;
    this.save();
    return { ok: true };
  }

  /** Change the stored default of non-sensitive parameters ('' removes it: asked at every run). */
  setDefaults(id: string, values: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const r = this.data.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'no such recipe' };
    for (const [k, v] of Object.entries(values ?? {})) {
      const p = r.params.find((x) => x.name === k);
      if (!p) return { ok: false, error: `no parameter ${k}` };
      if (p.kind === 'sensitive') return { ok: false, error: `${k} is sensitive: it is asked at every run and never stored` };
      const s = typeof v === 'string' ? v.slice(0, RECIPE_LIMITS.value) : '';
      if (s) p.default = s;
      else delete p.default;
    }
    this.save();
    return { ok: true };
  }
}

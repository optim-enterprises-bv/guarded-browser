// Recipe replay (item 5): runs a saved recipe with NO planner, NO reader and NO judge — this module
// imports no model client at all. Nothing on the page can steer it: every step re-locates its
// element with the recorded locator and checks the page is the one the step was recorded on; any
// difference aborts the run with a precise report instead of improvising:
//   landmark-missing   the title / main heading is not the recorded one
//   locator-none/many  the locator matches 0 or more than 1 element
//   form-shape         a submit's method, action, enctype or field names / types changed
//   new-origin         the page is on (or was redirected / navigated to) an origin the recipe does not name
//   download / popup   the page started a download or opened a window
//   policy-blocked / denied / action-failed / extract-failed / param-missing / timeout
// Every state-changing step goes through the SAME policy engine and confirmation broker as an agent
// action (screen + phone); a step the user marked "auto" skips the confirmation only when
// autoRefusal() finds nothing against it on the LIVE page as well. Egress runs in task mode with the
// recipe's origins as the allowlist, exactly like an agent task.

import { randomUUID } from 'node:crypto';
import type { ActionOutcome } from './agent';
import { applyApprovalEffects, type TaskResult } from './agent';
import type { AuditLog } from './audit';
import type { EgressController } from './egress';
import { extractTyped, landmarksMatch, matchLocator, type Candidate, type PageInfo } from './locator';
import { evaluatePolicy, originOf } from './policy';
import { autoRefusal, describeStep, fillUrl, formShapeOf, type FormShape, type Recipe, type RecipeStep } from './recipe';
import { MIN_MATCH_LENGTH, TaintRegistry } from './taint';
import type { ConfirmOutcome, ConfirmRequest, FormField, PlannerAction, PolicyResult, SnapshotElement } from './types';

/** What replay needs from a tab. ElectronDriver implements it (src/main/tabs.ts). */
export interface ReplayDriver {
  currentUrl(): string;
  navigate(url: string): Promise<ActionOutcome>;
  pageInfo(): Promise<PageInfo>;
  /** every element with this tag, registered under a fresh ref */
  candidates(q: { tag: string; interactive: boolean }): Promise<{ info: PageInfo; candidates: Candidate[] }>;
  click(ref: string): Promise<ActionOutcome>;
  type(ref: string, text: string): Promise<ActionOutcome>;
  select(ref: string, value: string): Promise<ActionOutcome>;
  submit(ref: string): Promise<ActionOutcome>;
  formFields(ref: string): Promise<FormField[]>;
}

export type DivergenceKind =
  | 'landmark-missing'
  | 'locator-none'
  | 'locator-many'
  | 'form-shape'
  | 'new-origin'
  | 'download'
  | 'popup'
  | 'policy-blocked'
  | 'denied'
  | 'action-failed'
  | 'extract-failed'
  | 'param-missing';

export const DIVERGENCE_TEXT: Record<DivergenceKind, string> = {
  'landmark-missing': 'the page does not look like the one this step was recorded on',
  'locator-none': 'the recorded element is not on the page (the locator matches 0 elements)',
  'locator-many': 'the recorded element is ambiguous (the locator matches more than 1 element)',
  'form-shape': 'the form changed since it was recorded',
  'new-origin': 'the page is on, or tried to go to, an origin the recipe does not name',
  download: 'the page started a download the recipe did not expect',
  popup: 'the page tried to open a window the recipe did not expect',
  'policy-blocked': 'the security policy blocked this step',
  denied: 'you did not approve this step',
  'action-failed': 'the browser could not perform this step',
  'extract-failed': 'the value read from the page is not of the recorded type',
  'param-missing': 'a parameter has no value',
};

export interface Divergence {
  /** 1-based step number (0 = before the first step) */
  step: number;
  kind: DivergenceKind;
  detail: string;
}

export interface ReplayResult extends Omit<TaskResult, 'status'> {
  /** 'diverged': the page was not what the recipe recorded, and the run stopped there */
  status: TaskResult['status'] | 'diverged';
  divergence?: Divergence;
  /** extract steps' typed values, by field */
  values: Record<string, number | string>;
}

export interface ReplayDeps {
  driver: ReplayDriver;
  audit: AuditLog;
  confirm: (req: ConfirmRequest) => Promise<ConfirmOutcome>;
  egress?: EgressController;
  /** the run's parameter values (resolveParams) */
  params: Record<string, string>;
  timeoutMs?: number;
  onUpdate?: (u: { taskId: string; status: string; step: number; answer?: string }) => void;
}

/** Recorded vs live form shape: null when they are the same. */
export function compareForm(recorded: FormShape, live: FormShape | undefined): string | null {
  if (!live) return 'the element is no longer in a form';
  if (recorded.method !== live.method) return `method is ${live.method.toUpperCase()}, recorded ${recorded.method.toUpperCase()}`;
  if (recorded.action !== live.action) return `the form now sends to ${live.action}, recorded ${recorded.action}`;
  if (recorded.enctype !== live.enctype) return `encoding is ${live.enctype}, recorded ${recorded.enctype}`;
  const key = (f: { name: string; type: string }) => `${f.name}:${f.type}`;
  const a = recorded.fields.map(key).sort();
  const b = live.fields.map(key).sort();
  const added = b.filter((x) => !a.includes(x));
  const gone = a.filter((x) => !b.includes(x));
  if (added.length || gone.length) return `fields ${[...added.map((x) => `+${x}`), ...gone.map((x) => `-${x}`)].join(' ')}`.slice(0, 300);
  return null;
}

const asElement = (c: Candidate): SnapshotElement => ({
  ref: c.ref,
  role: c.role,
  name: c.name,
  tag: c.tag,
  ...(c.inputType ? { inputType: c.inputType } : {}),
  ...(c.fullHref ? { href: c.fullHref } : {}),
  ...(c.inForm ? { inForm: true, formAction: c.formAction, formMethod: c.formMethod, formEnctype: c.formEnctype, formHasPassword: !!c.formHasPassword, formShape: c.formShape } : {}),
  ...(c.isSubmit ? { isSubmit: true } : {}),
});

class Diverged extends Error {
  constructor(readonly d: Divergence) {
    super(`${d.kind}: ${d.detail}`);
  }
}

export class ReplayTask {
  readonly id = randomUUID().slice(0, 8);
  /** what the chrome and the audit log call this task */
  readonly task: string;
  readonly taint: TaintRegistry;
  readonly allowedOrigins: Set<string>;
  readonly taskOrigins: Set<string>;
  readonly kind = 'replay' as const;
  private stopped = false;
  private events: Array<{ kind: 'popup' | 'download' | 'new-origin'; detail: string }> = [];
  private readonly contextOrigins = new Set<string>();
  private readonly confirmations: TaskResult['confirmations'] = [];

  constructor(
    readonly recipe: Recipe,
    private readonly deps: ReplayDeps,
  ) {
    this.task = `Replay recipe “${recipe.name}” (no AI)`;
    // The user supplied (or approved, as stored defaults) every value this run types or opens: those
    // texts are the "task" for the taint labels, so the policy treats them like values from a task.
    const urls = recipe.steps.flatMap((s) => (s.kind === 'navigate' ? [fillUrl(s.url, deps.params)] : []));
    this.taint = new TaintRegistry([this.task, ...urls, ...Object.values(deps.params)].join('\n'));
    this.allowedOrigins = new Set(recipe.origins);
    this.taskOrigins = new Set(recipe.origins);
  }

  stop() {
    this.stopped = true;
  }

  get isStopped() {
    return this.stopped;
  }

  /** an origin the user approved during the run (a page-initiated navigation is never approved: it diverges) */
  approveOrigin(origin: string) {
    this.allowedOrigins.add(origin);
    this.deps.egress?.allowHost(origin);
  }

  /** The browser layer saw (and refused) something the recipe did not do: the run stops at the next check. */
  pageEvent(kind: 'popup' | 'download' | 'new-origin', detail: string) {
    this.events.push({ kind, detail: detail.slice(0, 300) });
  }

  private audit(type: Parameters<AuditLog['write']>[0], data: Record<string, unknown> = {}) {
    return this.deps.audit.write(type, { taskId: this.id, ...data });
  }

  private checkEvents(step: number) {
    const e = this.events.shift();
    if (e) throw new Diverged({ step, kind: e.kind, detail: e.detail });
  }

  async run(): Promise<ReplayResult> {
    const r = this.recipe;
    const started = Date.now();
    const values: Record<string, number | string> = {};
    // sensitive parameters: tracked by the egress filter like task secrets, and never written to the audit log
    const sensitive = r.params.filter((p) => p.kind === 'sensitive' && this.deps.params[p.name]);
    for (const p of sensitive) {
      const e = this.taint.register(this.deps.params[p.name], 'user-sensitive', [{ source: 'user-task', timestamp: new Date().toISOString(), note: `recipe parameter ${p.name}` }]);
      e.sensitivity = 'secret';
    }
    this.deps.audit.addRedactions(this.taint.secretValues());
    this.deps.egress?.startTask([...this.allowedOrigins], this.taint);
    this.audit('task-start', { task: this.task, replay: true, recipe: r.id, steps: r.steps.length, allowedOrigins: [...this.allowedOrigins], sensitiveParams: sensitive.map((p) => p.name), models: 'none' });
    let status: ReplayResult['status'] = 'finished';
    let divergence: Divergence | undefined;
    let step = 0;
    try {
      for (step = 1; step <= r.steps.length; step++) {
        if (this.stopped) {
          status = 'stopped';
          break;
        }
        if (Date.now() - started > (this.deps.timeoutMs ?? 10 * 60_000)) {
          status = 'timeout';
          break;
        }
        const s = r.steps[step - 1];
        this.deps.onUpdate?.({ taskId: this.id, status: `replaying step ${step}/${r.steps.length}`, step });
        const v = await this.runStep(step, s);
        if (v) values[v.field] = v.value;
        if (this.stopped) {
          status = 'stopped';
          break;
        }
        this.checkEvents(step);
        this.audit('replay', { step, kind: s.kind, ok: true });
      }
    } catch (e) {
      if (e instanceof Diverged && this.stopped) {
        status = 'stopped';
      } else if (e instanceof Diverged) {
        status = 'diverged';
        divergence = e.d;
        this.audit('replay', { step: e.d.step, divergence: e.d.kind, detail: e.d.detail });
      } else {
        status = 'failed';
        divergence = undefined;
        this.audit('error', { where: 'replay', error: (e as Error).message });
      }
    } finally {
      this.deps.egress?.endTask();
    }
    const n = r.steps.length;
    const shown = Object.entries(values).map(([k, v]) => `${k}: ${v}`);
    const answer =
      status === 'finished'
        ? `Recipe “${r.name}” replayed: ${n} step${n === 1 ? '' : 's'}, no AI involved.${shown.length ? `\n${shown.join('\n')}` : ''}`
        : divergence
          ? `Replay stopped at step ${divergence.step} of ${n} — ${DIVERGENCE_TEXT[divergence.kind]} (${divergence.kind}): ${divergence.detail}${
              divergence.step >= 1 ? `\nStep ${divergence.step}: ${describeStep(r.steps[divergence.step - 1], r.params)}` : ''
            }`
          : `Replay ${status}.`;
    this.audit('task-end', { status, steps: Math.min(step, n), replay: true, divergence: divergence?.kind, values: Object.keys(values) });
    this.deps.onUpdate?.({ taskId: this.id, status, step, answer });
    return { taskId: this.id, status, answer, steps: Math.min(step, n), confirmations: this.confirmations, divergence, values };
  }

  private here(step: number, s: RecipeStep): string {
    const url = this.deps.driver.currentUrl();
    const o = originOf(url);
    if (!o || !this.allowedOrigins.has(o) || o !== s.origin) {
      throw new Diverged({ step, kind: 'new-origin', detail: `the tab is on ${o ?? (url.slice(0, 80) || 'no page')}, the step was recorded on ${s.origin}` });
    }
    this.contextOrigins.add(o);
    return o;
  }

  private async runStep(step: number, s: RecipeStep): Promise<{ field: string; value: number | string } | null> {
    const { driver } = this.deps;
    if (s.kind === 'navigate') {
      const url = fillUrl(s.url, this.deps.params);
      await this.decide(step, s, { name: 'navigate', args: { url } }, undefined, undefined);
      const res = await driver.navigate(url);
      this.audit('navigation', { url, ok: res.ok, detail: res.detail, by: 'replay' });
      this.checkEvents(step);
      if (!res.ok) throw new Diverged({ step, kind: 'action-failed', detail: `could not open ${url}: ${String(res.detail ?? '').slice(0, 120)}` });
      this.here(step, s);
      const lm = landmarksMatch(s.expect, await driver.pageInfo());
      if (lm) throw new Diverged({ step, kind: 'landmark-missing', detail: lm });
      return null;
    }
    this.here(step, s);
    const { info, candidates } = await driver.candidates({ tag: s.locator.tag, interactive: s.kind !== 'extract' });
    const lm = landmarksMatch(s.at, info);
    if (lm) throw new Diverged({ step, kind: 'landmark-missing', detail: lm });
    const idx = matchLocator(s.locator, candidates);
    if (idx.length === 0) throw new Diverged({ step, kind: 'locator-none', detail: `no ${s.locator.tag} matches ${describeStep(s).replace(/^\w+ /, '')}` });
    if (idx.length > 1) throw new Diverged({ step, kind: 'locator-many', detail: `${idx.length} elements match the recorded ${s.locator.tag}` });
    const c = candidates[idx[0]];
    if (s.kind === 'extract') {
      const v = extractTyped(s.type, c.text ?? '');
      if (v === null) throw new Diverged({ step, kind: 'extract-failed', detail: `the element's text is not a ${s.type}` });
      this.audit('replay', { step, kind: 'extract', field: s.field, type: s.type, ok: true });
      return { field: s.field, value: v };
    }
    const el = asElement(c);
    const submits = s.kind === 'submit' || (s.kind === 'click' && !!el.isSubmit);
    if (s.kind === 'submit' || (s.kind === 'click' && s.form)) {
      const diff = compareForm(s.form!, formShapeOf(el));
      if (diff) throw new Diverged({ step, kind: 'form-shape', detail: diff });
    } else if (s.kind === 'click' && el.isSubmit) {
      throw new Diverged({ step, kind: 'form-shape', detail: 'this control now submits a form; it did not when it was recorded' });
    }
    let action: PlannerAction;
    let text = '';
    if (s.kind === 'type' || s.kind === 'select') {
      text = this.deps.params[s.param] ?? '';
      if (!text) throw new Diverged({ step, kind: 'param-missing', detail: `{{${s.param}}} has no value` });
      action = s.kind === 'type' ? { name: 'type', args: { ref: c.ref, text } } : { name: 'select', args: { ref: c.ref, value: text } };
    } else action = { name: s.kind, args: { ref: c.ref } };
    const fields = submits ? (await driver.formFields(c.ref)).filter((f) => s.kind === 'click' || !f.submitter) : undefined;
    const policy = await this.decide(step, s, action, el, fields);
    if (text.trim().length >= MIN_MATCH_LENGTH) {
      // registered BEFORE the value enters the page, like the agent does
      this.taint.register(text, 'user-sensitive', [{ source: 'user-task', timestamp: new Date().toISOString(), note: 'recipe parameter' }]);
    }
    let res: ActionOutcome;
    try {
      res =
        action.name === 'type'
          ? await driver.type(c.ref, text)
          : action.name === 'select'
            ? await driver.select(c.ref, text)
            : action.name === 'submit'
              ? await driver.submit(c.ref)
              : await driver.click(c.ref);
    } finally {
      this.deps.egress?.clearApprovals();
    }
    this.audit('action-result', { action: action.name, ok: res.ok, detail: res.detail, replay: true, step, destination: policy.destination });
    if (!res.ok) throw new Diverged({ step, kind: 'action-failed', detail: String(res.detail ?? 'failed').slice(0, 160) });
    return null;
  }

  /** Policy (code) + confirmation (human). No judge: nothing here was chosen by a model. */
  private async decide(step: number, s: RecipeStep, action: PlannerAction, el: SnapshotElement | undefined, fields: FormField[] | undefined): Promise<PolicyResult> {
    const policy = evaluatePolicy(action, {
      currentUrl: this.deps.driver.currentUrl(),
      allowedOrigins: this.allowedOrigins,
      taskOrigins: this.taskOrigins,
      startOrigin: null,
      taint: this.taint,
      contextOrigins: [...this.contextOrigins],
      element: el,
      formFields: fields,
    });
    this.audit('policy', { action: action.name, decision: policy.decision, reasons: policy.reasons, destination: policy.destination, values: policy.values, replay: true, step });
    if (policy.decision === 'block') throw new Diverged({ step, kind: 'policy-blocked', detail: policy.reasons.join('; ').slice(0, 300) });
    if (policy.newOrigin && action.name !== 'navigate') {
      // a recipe only acts on the origins it names: a step that would reach another one is a divergence
      throw new Diverged({ step, kind: 'new-origin', detail: `this step would reach ${policy.newOrigin}` });
    }
    if (policy.decision === 'confirm') {
      const live = autoRefusalLive(s, el, fields, policy, this.recipe);
      if (s.auto && !live) {
        this.audit('confirmation', { action: action.name, outcome: 'auto', step, reasons: policy.reasons, destination: policy.destination });
      } else {
        const req: ConfirmRequest = {
          id: randomUUID().slice(0, 8),
          kind: 'action',
          action: `${action.name} — recipe “${this.recipe.name}”, step ${step} of ${this.recipe.steps.length} (replayed without AI)`,
          target: el ? `${el.role} <${el.tag ?? '?'}>${el.href ? ` -> ${el.href}` : ''}${el.formAction ? ` (form ${(el.formMethod ?? 'get').toUpperCase()} ${el.formAction})` : ''}` : String(action.args.url ?? ''),
          destination: policy.destination,
          values: policy.values,
          reasons: [...policy.reasons, s.auto ? `marked "auto" but confirmed anyway: ${live}` : 'replayed from a saved recipe: no AI chose this step; the policy asks you exactly as it would ask during an agent task'],
          pageDerived: el ? [{ label: 'element label (text from the page)', text: el.name }] : [],
        };
        this.deps.onUpdate?.({ taskId: this.id, status: 'awaiting confirmation', step });
        const outcome = await this.deps.confirm(req);
        this.confirmations.push({ action: req.action, outcome, reasons: req.reasons });
        this.audit('confirmation', { requestId: req.id, action: req.action, destination: req.destination, outcome, reasons: req.reasons, step });
        if (outcome === 'stop') {
          this.stop();
          throw new Diverged({ step, kind: 'denied', detail: 'you stopped the replay' });
        }
        if (outcome !== 'approve') throw new Diverged({ step, kind: 'denied', detail: outcome === 'timeout' ? 'no answer (default deny)' : 'denied' });
      }
    }
    applyApprovalEffects(policy, action, el, fields, { approveOrigin: (o) => this.approveOrigin(o), egress: this.deps.egress });
    return policy;
  }
}

/** "auto" re-checked against the LIVE element and policy result: null = may skip the confirmation. */
export function autoRefusalLive(s: RecipeStep, el: SnapshotElement | undefined, fields: FormField[] | undefined, policy: PolicyResult, recipe: Pick<Recipe, 'params'>): string | null {
  const recorded = autoRefusal(s, recipe.params);
  if (recorded) return recorded;
  if (policy.newOrigin) return `it reaches a new origin (${policy.newOrigin})`;
  if (el?.inputType === 'password' || el?.formHasPassword || fields?.some((f) => f.password)) return 'the live form has a password field';
  if (el?.formAction && originOf(el.formAction) !== s.origin) return `the live form sends to another origin (${originOf(el.formAction) ?? 'unknown'})`;
  if (el?.href && originOf(el.href) !== s.origin) return `the live link leads to another origin (${originOf(el.href) ?? 'unknown'})`;
  return null;
}

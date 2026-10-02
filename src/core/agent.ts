// Agent orchestrator: planner -> policy + judge -> (confirmation) -> browser, with a quarantined
// reader for page content, a guard in front of every untrusted text, and an audit trail.

import { randomUUID } from 'node:crypto';
import type { Settings } from './config';
import type { AuditLog } from './audit';
import { sha256 } from './audit';
import type { EgressController } from './egress';
import { screenText } from './guard';
import { runJudge, describeAction } from './judge';
import type { ChatMessage, LlmClient } from './llm';
import { PLANNER_SYSTEM, plannerStep } from './planner';
import { combine, evaluatePolicy, originOf, originsInTask } from './policy';
import { MAX_STRING, runReader, type SchemaSpec } from './reader';
import { MIN_MATCH_LENGTH, TaintRegistry } from './taint';
import { HandleStore } from './handles';
import { SITE_WITHHELD, capName, errorCode, safeInputType, safeMethod, safeRole, urlParts } from './sanitize';
import {
  WITHHELD,
  type ConfirmOutcome,
  type ConfirmRequest,
  type FormField,
  type Guard,
  type JudgeVerdict,
  type PlannerAction,
  type PolicyResult,
  type Snapshot,
  type SnapshotElement,
} from './types';

export interface ActionOutcome {
  ok: boolean;
  detail?: string;
}

/** What the agent needs from a browser tab. Implemented by Electron (src/main) and by test fakes. */
export interface BrowserDriver {
  currentUrl(): string;
  navigate(url: string): Promise<ActionOutcome>;
  snapshot(): Promise<Snapshot>;
  pageText(): Promise<string>;
  click(ref: string): Promise<ActionOutcome>;
  type(ref: string, text: string): Promise<ActionOutcome>;
  select(ref: string, value: string): Promise<ActionOutcome>;
  scroll(direction: 'up' | 'down'): Promise<ActionOutcome>;
  submit(ref: string): Promise<ActionOutcome>;
  formFields(ref: string): Promise<FormField[]>;
}

export interface AgentDeps {
  planner: LlmClient;
  reader: LlmClient;
  judge: LlmClient;
  guard: Guard;
  driver: BrowserDriver;
  audit: AuditLog;
  confirm: (req: ConfirmRequest, taskId: string) => Promise<ConfirmOutcome>;
  settings: () => Settings['agent'];
  egress?: EgressController;
  /**
   * Origins the user confirmed for this task (from the allowlist editor shown at task start).
   * Default: http(s) URLs written in the task + the tab's origin at task start.
   */
  seedOrigins?: string[];
  /** TEST ONLY: bypass policy engine and judge (used to show the egress layer holds on its own) */
  policyDisabled?: boolean;
  onGuardFlag?: (url: string, count: number) => void;
  onUpdate?: (u: { taskId: string; status: string; step: number; answer?: string }) => void;
}

export type TaskStatus = 'finished' | 'stopped' | 'failed' | 'step-limit' | 'timeout';

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  answer?: string;
  steps: number;
  confirmations: Array<{ action: string; outcome: ConfirmOutcome; reasons: string[] }>;
}

const MAX_ELEMENTS = 80;

/** Planner-facing, sanitised view of one snapshot element (see src/core/sanitize.ts). */
interface SafeElement {
  role: string;
  name: string;
  inputType?: string;
  href?: string;
  form?: string;
  isSubmit?: boolean;
}

export class AgentTask {
  readonly id = randomUUID().slice(0, 8);
  readonly taint: TaintRegistry;
  readonly allowedOrigins = new Set<string>();
  /** origins the task itself names (or the user confirmed at task start); approvals do not add here */
  readonly taskOrigins = new Set<string>();
  private startOrigin: string | null = null;
  readonly handles = new HandleStore();
  private safeView = new Map<string, SafeElement>();
  private readonly history: string[] = [];
  private readonly messages: ChatMessage[] = [];
  private readonly contextOrigins = new Set<string>();
  private readonly confirmations: TaskResult['confirmations'] = [];
  private lastSnapshot: Snapshot | null = null;
  private stopped = false;
  private snapshotMsgIdx: number[] = [];

  constructor(
    readonly task: string,
    private readonly deps: AgentDeps,
  ) {
    this.taint = new TaintRegistry(task);
  }

  stop() {
    this.stopped = true;
  }

  get isStopped() {
    return this.stopped;
  }

  /** Called by the browser layer when the user approves a page-initiated navigation. */
  approveOrigin(origin: string) {
    this.allowedOrigins.add(origin);
    this.deps.egress?.allowHost(origin);
  }

  private audit(type: Parameters<AuditLog['write']>[0], data: Record<string, unknown> = {}) {
    return this.deps.audit.write(type, { taskId: this.id, ...data });
  }

  async run(): Promise<TaskResult> {
    const { driver } = this.deps;
    const cfg = this.deps.settings();
    const started = Date.now();
    const startOrigin = originOf(driver.currentUrl());
    this.startOrigin = startOrigin;
    const seeds = this.deps.seedOrigins ?? [...originsInTask(this.task), ...(startOrigin ? [startOrigin] : [])];
    const named = new Set(originsInTask(this.task));
    for (const o of seeds) {
      const origin = originOf(o);
      if (origin) {
        this.allowedOrigins.add(origin);
        // The tab the task happens to start on is browsable, but it is not a place the user said task
        // secrets may go (taskOrigins gates typing / navigating them): only when the task names it.
        // The allowlist editor pre-fills the current origin; a seed equal to it is treated the same.
        if (origin !== startOrigin || named.has(origin)) this.taskOrigins.add(origin);
      }
    }
    const secrets = this.taint.preRegisterTaskSecrets();
    this.deps.audit.addRedactions(this.taint.secretValues());
    this.deps.egress?.startTask([...this.allowedOrigins], this.taint);
    this.audit('task-start', {
      task: this.task,
      allowedOrigins: [...this.allowedOrigins],
      sensitiveValues: secrets.map((s) => ({ id: s.id, kind: s.sensitivity })),
      policyDisabled: !!this.deps.policyDisabled,
    });

    this.messages.push({ role: 'system', content: PLANNER_SYSTEM });
    let first = `User task: ${this.task}`;
    if (startOrigin) first += `\n\nCurrent page:\n${await this.observe()}`;
    else first += '\n\nThe current tab is empty. Start with navigate(url).';
    this.messages.push({ role: 'user', content: first });
    this.snapshotMsgIdx.push(this.messages.length - 1);

    let status: TaskStatus = 'step-limit';
    let answer: string | undefined;
    let step = 0;
    try {
      for (step = 1; step <= cfg.maxSteps; step++) {
        if (this.stopped) { status = 'stopped'; break; }
        if (Date.now() - started > cfg.taskTimeoutMs) { status = 'timeout'; break; }
        this.deps.onUpdate?.({ taskId: this.id, status: 'planning', step });

        const turn = await plannerStep(this.deps.planner, this.messages);
        if (turn.usedFallback) this.audit('fallback', { role: 'planner' });
        this.messages.push(turn.assistantMessage);
        if (!turn.action) {
          this.audit('error', { where: 'planner', error: turn.error });
          this.messages.push({ role: 'user', content: `Error: ${turn.error}. Call exactly one tool, or reply with {"action": ..., "args": {...}}.` });
          continue;
        }
        const action = turn.action;
        this.audit('planner-action', { step, action: action.name, args: action.args, native: !!action.callId });

        if (action.name === 'finish') {
          // handles are substituted for display only; the answer is based on untrusted data
          answer = this.handles.resolve(String(action.args.answer ?? '')).text.slice(0, 4000);
          status = 'finished';
          break;
        }

        const result = await this.handle(action);
        if (this.stopped) { status = 'stopped'; break; }
        this.history.push(`${describeAction(action)} -> ${result.summary}`);
        this.pushResult(action, result.text, result.observation);
      }
    } catch (e) {
      status = 'failed';
      answer = `Task failed: ${(e as Error).message}`;
      this.audit('error', { where: 'agent', error: (e as Error).message });
    } finally {
      this.deps.egress?.endTask();
    }
    this.audit('task-end', { status, answer, steps: step });
    this.deps.onUpdate?.({ taskId: this.id, status, step, answer });
    return { taskId: this.id, status, answer, steps: step, confirmations: this.confirmations };
  }

  private pushResult(action: PlannerAction, text: string, observation?: string) {
    // Only the newest snapshot stays in the transcript; older ones are elided to save context.
    if (observation) {
      for (const i of this.snapshotMsgIdx) {
        const m = this.messages[i];
        if (m.content) m.content = m.content.replace(/\n--- page ---[\s\S]*$/, '\n[older snapshot omitted]');
      }
      this.snapshotMsgIdx = [];
    }
    const content = observation ? `${text}\n--- page ---\n${observation}` : text;
    if (action.callId) this.messages.push({ role: 'tool', tool_call_id: action.callId, content });
    else this.messages.push({ role: 'user', content: `Result of ${action.name}: ${content}` });
    if (observation) this.snapshotMsgIdx.push(this.messages.length - 1);
  }

  /**
   * Snapshot the current page and render it for the planner. Every page-derived string is mapped
   * onto a fixed vocabulary, capped, or guard-screened (src/core/sanitize.ts).
   */
  private async observe(): Promise<string> {
    const snap = await this.deps.driver.snapshot();
    this.lastSnapshot = snap;
    const origin = originOf(snap.url);
    if (origin) this.contextOrigins.add(origin);
    const elements = snap.elements.slice(0, MAX_ELEMENTS);
    // one guard batch: title, names, and every URL path shown to the planner
    const texts: string[] = [capName(snap.title), ...elements.map((e) => capName(e.name))];
    const urlSlot = (url: string | undefined): number | undefined => {
      if (!url) return undefined;
      const p = urlParts(url);
      if (!p) return undefined;
      texts.push(`${p.origin}\u0000${p.path}`);
      return texts.length - 1;
    };
    const pageSlot = urlSlot(snap.url);
    const slots = elements.map((e) => ({ href: urlSlot(e.href), form: urlSlot(e.formAction) }));
    const verdicts = await this.deps.guard.classify(texts.map((t) => t.replace('\u0000', '')));
    const flagged = verdicts.filter((v) => v.flagged).length;
    this.audit('snapshot', { url: snap.url, hash: sha256(JSON.stringify(snap)), elements: snap.elements.length });
    this.audit('guard', {
      what: 'snapshot',
      url: snap.url,
      status: this.deps.guard.status(),
      flagged,
      maxScore: Math.max(0, ...verdicts.map((v) => v.score)),
      flaggedScores: verdicts.filter((v) => v.flagged).map((v) => ({ text: v.text.slice(0, 80), score: v.score })),
    });
    if (flagged) this.deps.onGuardFlag?.(snap.url, flagged);
    const text = (i: number) => (verdicts[i].flagged ? WITHHELD : texts[i]);
    // a flagged URL is withheld whole: the host is attacker-chosen text as much as the path is
    const url = (i: number | undefined) => {
      if (i === undefined) return undefined;
      const [o, path] = texts[i].split('\u0000');
      return verdicts[i].flagged ? SITE_WITHHELD : `${o}${path}`;
    };
    this.safeView = new Map();
    const lines = elements.map((e, i) => {
      const v: SafeElement = {
        role: safeRole(e.role),
        name: text(i + 1),
        inputType: safeInputType(e.inputType),
        href: url(slots[i].href),
        form: e.formAction && !e.href ? `${safeMethod(e.formMethod)} ${url(slots[i].form)}` : undefined,
        isSubmit: !!e.isSubmit,
      };
      this.safeView.set(e.ref, v);
      return renderElement(/^e\d{1,4}$/.test(e.ref) ? e.ref : '?', v);
    });
    const guardNote = this.deps.guard.status() === 'ready' ? '' : `\n(guard ${this.deps.guard.status()}: names were not screened)`;
    return `URL: ${url(pageSlot) ?? '(none)'}\nTitle (untrusted): ${text(0)}\nElements (names are untrusted page data):\n${lines.join('\n') || '(none)'}${
      snap.elements.length > MAX_ELEMENTS ? `\n(${snap.elements.length - MAX_ELEMENTS} more elements not shown)` : ''
    }${guardNote}`;
  }

  /** Sanitised one-line description of an element, for the judge and the confirmation dialog. */
  private describeTarget(ref: string): { structural: string; name: string } | undefined {
    const v = this.safeView.get(ref);
    if (!v) return undefined;
    return { structural: `${v.role} [${ref}]${v.href ? ` -> ${v.href}` : ''}${v.form ? ` (form ${v.form})` : ''}`, name: v.name };
  }

  private element(ref: unknown): SnapshotElement | undefined {
    return this.lastSnapshot?.elements.find((e) => e.ref === String(ref));
  }

  /** Substitute reader handles in the arguments that may carry values. */
  private resolveHandles(action: PlannerAction): { resolved: PlannerAction; used: string[] } {
    const args = { ...action.args };
    const used: string[] = [];
    for (const k of ['url', 'text', 'value'] as const) {
      if (typeof args[k] === 'string') {
        const r = this.handles.resolve(args[k] as string);
        args[k] = r.text;
        used.push(...r.used);
      }
    }
    return { resolved: { ...action, args }, used };
  }

  private async handle(action: PlannerAction): Promise<{ text: string; summary: string; observation?: string }> {
    const { driver } = this.deps;
    const { resolved, used } = this.resolveHandles(action);
    const el = this.element(resolved.args.ref);
    const ref = String(resolved.args.ref ?? '');
    // click on a submit button: that button is the submitter; submit(): requestSubmit() with none
    const formFields =
      el && (resolved.name === 'submit' || (resolved.name === 'click' && el.isSubmit))
        ? (await driver.formFields(el.ref)).filter((f) => resolved.name === 'click' || !f.submitter)
        : undefined;
    const target = el ? this.describeTarget(ref) : undefined;

    // 1. rule-based policy (code), 2. judge (LLM, can only escalate)
    let policy: PolicyResult;
    let judge: JudgeVerdict;
    let decision: 'allow' | 'confirm' | 'block';
    let reasons: string[];
    if (this.deps.policyDisabled) {
      policy = { decision: 'allow', reasons: ['POLICY ENGINE DISABLED (test mode)'], values: [] };
      judge = { verdict: 'allow', reason: 'judge skipped (policy disabled test mode)' };
      decision = 'allow';
      reasons = policy.reasons;
    } else {
      policy = evaluatePolicy(resolved, {
        currentUrl: driver.currentUrl(),
        allowedOrigins: this.allowedOrigins,
        taskOrigins: this.taskOrigins,
        startOrigin: this.startOrigin,
        taint: this.taint,
        contextOrigins: [...this.contextOrigins],
        element: el,
        formFields,
      });
      this.audit('policy', { action: action.name, decision: policy.decision, reasons: policy.reasons, destination: policy.destination, values: policy.values, handles: used });
      // The judge sees the planner's action with handles UNRESOLVED and a sanitised target: no page text.
      const judgeTarget = target ? `${target.structural} labelled "${target.name}" (label is page data)` : urlParts(String(action.args.url ?? ''))?.origin ?? '';
      judge = policy.decision === 'block' ? { verdict: 'block', reason: 'policy blocked; judge not consulted' } : await runJudge(this.deps.judge, this.task, this.history, action, judgeTarget);
      this.audit('judge', { action: action.name, verdict: judge.verdict, reason: judge.reason, error: judge.error });
      ({ decision, reasons } = combine(policy, judge));
    }

    // Results returned to the planner are fixed strings: no reasons, names or URLs from the page.
    if (decision === 'block') {
      return { text: 'BLOCKED by the security policy. Do not retry this action.', summary: 'blocked' };
    }
    if (decision === 'confirm') {
      const pageDerived: ConfirmRequest['pageDerived'] = [];
      if (target) pageDerived.push({ label: 'element label (text from the page)', text: target.name });
      if (judge.reason && judge.verdict !== 'allow') pageDerived.push({ label: 'judge reason (model output, may echo page content)', text: judge.reason });
      const req: ConfirmRequest = {
        id: randomUUID().slice(0, 8),
        kind: 'action',
        action: describeAction(resolved),
        target: target ? target.structural : String(resolved.args.url ?? ''),
        destination: policy.destination,
        values: policy.values,
        reasons,
        judge,
        pageDerived,
      };
      this.deps.onUpdate?.({ taskId: this.id, status: 'awaiting confirmation', step: 0 });
      const outcome = await this.deps.confirm(req, this.id);
      this.confirmations.push({ action: req.action, outcome, reasons });
      this.audit('confirmation', { requestId: req.id, action: req.action, destination: req.destination, outcome, reasons });
      if (outcome === 'stop') {
        this.stop();
        return { text: 'Task stopped by user.', summary: 'stopped' };
      }
      if (outcome !== 'approve') {
        return { text: `DENIED by the user (${outcome === 'timeout' ? 'no answer, default deny' : 'denied'}). Do not retry this action.`, summary: 'denied' };
      }
      this.recordApproval(policy, resolved, el, formFields);
    }
    try {
      return await this.execute(resolved);
    } finally {
      // one-shot request approvals live exactly as long as the action that earned them
      this.deps.egress?.clearApprovals();
    }
  }

  private recordApproval(policy: PolicyResult, action: PlannerAction, el: SnapshotElement | undefined, fields: FormField[] | undefined) {
    if (policy.newOrigin) this.approveOrigin(policy.newOrigin);
    // an approved form submission lets through ONE request with this method, URL and exactly these fields
    if (el && fields && policy.destination && (action.name === 'submit' || (action.name === 'click' && el.isSubmit))) {
      this.deps.egress?.approveRequest({ method: el.formMethod === 'post' ? 'POST' : 'GET', url: policy.destination, fields, enctype: el.formEnctype });
    }
    if (policy.destination && this.deps.egress) {
      const text = [policy.destination, ...policy.values.map((v) => v.value)].join('\n');
      const ids = [...new Set([...policy.values.flatMap((v) => v.taintIds), ...this.deps.egress.idsIn(text)])];
      this.deps.egress.confirmFlow(ids, policy.destination);
    }
  }

  private async execute(action: PlannerAction): Promise<{ text: string; summary: string; observation?: string }> {
    const { driver } = this.deps;
    const a = action.args;
    const withObservation = async (o: { ok: boolean; detail?: string }, what: string) => {
      this.audit('action-result', { action: action.name, ok: o.ok, detail: o.detail });
      const observation = await this.observe();
      const text = o.ok ? `${what} ok` : `${what} failed: ${errorCode(o.detail)}`;
      return { text, summary: o.ok ? 'ok' : 'failed', observation };
    };
    switch (action.name) {
      case 'navigate': {
        const r = await driver.navigate(String(a.url));
        this.audit('navigation', { url: String(a.url), ok: r.ok, detail: r.detail, by: 'agent' });
        return withObservation(r, 'navigate');
      }
      case 'click':
        return withObservation(await driver.click(String(a.ref)), 'click');
      case 'submit':
        return withObservation(await driver.submit(String(a.ref)), 'submit');
      case 'scroll':
        return withObservation(await driver.scroll(a.direction === 'up' ? 'up' : 'down'), 'scroll');
      case 'type':
      case 'select': {
        const text = String(action.name === 'type' ? a.text ?? '' : a.value ?? '');
        if (text.trim().length >= MIN_MATCH_LENGTH) {
          // Register BEFORE the value enters the page: page JS may send it on the first input event.
          const l = this.taint.labelPlannerText(text, [...this.contextOrigins]);
          this.taint.register(text, l.label === 'trusted' ? 'user-sensitive' : 'untrusted', l.provenance);
        }
        const r = action.name === 'type' ? await driver.type(String(a.ref), text) : await driver.select(String(a.ref), text);
        this.audit('action-result', { action: action.name, ok: r.ok, detail: r.detail });
        return { text: r.ok ? `${action.name} ok` : `${action.name} failed: ${errorCode(r.detail)}`, summary: r.ok ? 'ok' : 'failed' };
      }
      case 'extract':
        return this.extract(String(a.query ?? ''), (a.schema ?? {}) as SchemaSpec);
      default:
        return { text: 'unsupported action', summary: 'failed' };
    }
  }

  private async extract(query: string, spec: SchemaSpec): Promise<{ text: string; summary: string }> {
    const { driver, guard } = this.deps;
    const url = driver.currentUrl();
    const raw = await driver.pageText();
    const screened = await screenText(guard, raw);
    this.audit('guard', {
      what: 'page-text',
      url,
      status: guard.status(),
      chunks: screened.verdicts.length,
      flagged: screened.flaggedChunks,
      maxScore: screened.maxScore,
      scores: screened.verdicts.map((v) => Number(v.score.toFixed(4))),
    });
    if (screened.flaggedChunks) this.deps.onGuardFlag?.(url, screened.flaggedChunks);
    let r;
    try {
      r = await runReader(this.deps.reader, screened.text, query, spec);
    } catch (e) {
      const msg = (e as Error).message;
      this.audit('reader', { url, query, schema: spec, ok: false, error: msg });
      // schema errors come from the planner's own spec; anything else is reported generically
      return { text: `extract failed: ${/^(schema|invalid)/.test(msg) ? msg.slice(0, 200) : 'reader error'}`, summary: 'failed' };
    }
    if (r.usedFallback) this.audit('fallback', { role: 'reader' });
    if (!r.ok || !r.data) {
      this.audit('reader', { url, query, schema: spec, ok: false, error: r.error, attempts: r.attempts, raw: r.raw });
      return { text: 'extract failed: reader output did not match the schema', summary: 'failed' };
    }
    const data = await this.screenValues(r.data, url);
    const tainted = this.taint.wrapReaderOutput(data, url);
    // Strings stay in code; the planner (and, via history, the judge) only gets handles.
    const { id, view } = this.handles.add(data);
    const src = urlParts(url);
    this.audit('reader', { url, query, schema: spec, ok: true, output: data, handle: id, plannerView: view, attempts: r.attempts, taint: tainted.provenance });
    return {
      text: JSON.stringify({ ok: true, label: 'untrusted', source: src ? `${src.origin}${src.path}` : '', handle: id, data: view }),
      summary: `extracted ${id}`,
    };
  }

  private async screenValues(data: Record<string, unknown>, url: string): Promise<Record<string, unknown>> {
    const strings: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
    };
    Object.values(data).forEach(collect);
    const verdicts = await this.deps.guard.classify(strings);
    const bad = new Set(verdicts.filter((v) => v.flagged).map((v) => v.text));
    if (bad.size) {
      this.audit('guard', { what: 'reader-output', url, flagged: bad.size, flaggedScores: verdicts.filter((v) => v.flagged).map((v) => v.score) });
      this.deps.onGuardFlag?.(url, bad.size);
    }
    const fix = (v: unknown): unknown => (typeof v === 'string' ? (bad.has(v) ? WITHHELD : v.slice(0, MAX_STRING)) : Array.isArray(v) ? v.map(fix) : v);
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fix(v)]));
  }
}

function renderElement(ref: string, v: SafeElement): string {
  let s = `[${ref}] ${v.role} "${v.name}"`;
  if (v.inputType) s += ` type=${v.inputType}`;
  if (v.href) s += ` -> ${v.href}`;
  if (v.isSubmit) s += ' (submits form)';
  if (v.form) s += ` [form ${v.form}]`;
  return s;
}

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
import {
  WITHHELD,
  type ConfirmOutcome,
  type ConfirmRequest,
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
  formFields(ref: string): Promise<Array<{ name: string; value: string }>>;
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
const MAX_NAME = 80;

export class AgentTask {
  readonly id = randomUUID().slice(0, 8);
  readonly taint: TaintRegistry;
  readonly allowedOrigins = new Set<string>();
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
    for (const o of originsInTask(this.task)) this.allowedOrigins.add(o);
    const startOrigin = originOf(driver.currentUrl());
    if (startOrigin) this.allowedOrigins.add(startOrigin);
    this.deps.egress?.startTask([...this.allowedOrigins], this.taint);
    this.audit('task-start', { task: this.task, allowedOrigins: [...this.allowedOrigins], policyDisabled: !!this.deps.policyDisabled });

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
          answer = String(action.args.answer ?? '').slice(0, 4000);
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

  /** Snapshot the current page, guard every element name, and render it for the planner. */
  private async observe(): Promise<string> {
    const snap = await this.deps.driver.snapshot();
    this.lastSnapshot = snap;
    const origin = originOf(snap.url);
    if (origin) this.contextOrigins.add(origin);
    const elements = snap.elements.slice(0, MAX_ELEMENTS);
    const names = elements.map((e) => e.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME));
    const title = snap.title.slice(0, MAX_NAME);
    const verdicts = await this.deps.guard.classify([title, ...names]);
    const flagged = verdicts.filter((v) => v.flagged).length;
    this.audit('snapshot', {
      url: snap.url,
      hash: sha256(JSON.stringify(snap)),
      elements: snap.elements.length,
    });
    this.audit('guard', {
      what: 'snapshot',
      url: snap.url,
      status: this.deps.guard.status(),
      flagged,
      maxScore: Math.max(0, ...verdicts.map((v) => v.score)),
      flaggedScores: verdicts.filter((v) => v.flagged).map((v) => ({ text: v.text.slice(0, 80), score: v.score })),
    });
    if (flagged) this.deps.onGuardFlag?.(snap.url, flagged);
    const safe = (i: number) => (verdicts[i].flagged ? WITHHELD : verdicts[i].text);
    const lines = elements.map((e, i) => renderElement(e, safe(i + 1)));
    const guardNote = this.deps.guard.status() === 'ready' ? '' : `\n(guard ${this.deps.guard.status()}: names were not screened)`;
    return `URL: ${snap.url}\nTitle (untrusted): ${safe(0)}\nElements (names are untrusted page data):\n${lines.join('\n') || '(none)'}${
      snap.elements.length > MAX_ELEMENTS ? `\n(${snap.elements.length - MAX_ELEMENTS} more elements not shown)` : ''
    }${guardNote}`;
  }

  private element(ref: unknown): SnapshotElement | undefined {
    return this.lastSnapshot?.elements.find((e) => e.ref === String(ref));
  }

  private async handle(action: PlannerAction): Promise<{ text: string; summary: string; observation?: string }> {
    const { driver } = this.deps;
    const el = this.element(action.args.ref);
    const formFields = el && (action.name === 'submit' || (action.name === 'click' && el.isSubmit)) ? await driver.formFields(el.ref) : undefined;

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
      policy = evaluatePolicy(action, {
        currentUrl: driver.currentUrl(),
        allowedOrigins: this.allowedOrigins,
        taint: this.taint,
        contextOrigins: [...this.contextOrigins],
        element: el,
        formFields,
      });
      this.audit('policy', { action: action.name, decision: policy.decision, reasons: policy.reasons, destination: policy.destination, values: policy.values });
      const target = el ? `${el.role} "${el.name.slice(0, 80)}"${el.href ? ` -> ${el.href}` : ''}${el.formAction ? ` (form -> ${el.formAction})` : ''}` : String(action.args.url ?? '');
      judge = policy.decision === 'block' ? { verdict: 'block', reason: 'policy blocked; judge not consulted' } : await runJudge(this.deps.judge, this.task, this.history, action, target);
      this.audit('judge', { action: action.name, verdict: judge.verdict, reason: judge.reason, error: judge.error });
      ({ decision, reasons } = combine(policy, judge));
    }

    if (decision === 'block') {
      return { text: `BLOCKED: ${reasons.join('; ')}. Do not retry this action.`, summary: 'blocked' };
    }
    if (decision === 'confirm') {
      const req: ConfirmRequest = {
        id: randomUUID().slice(0, 8),
        kind: 'action',
        action: describeAction(action),
        target: el ? `${el.role} "${el.name.slice(0, 80)}"` : String(action.args.url ?? ''),
        destination: policy.destination,
        values: policy.values,
        reasons,
        judge,
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
      this.recordApproval(policy);
    }
    return this.execute(action);
  }

  private recordApproval(policy: PolicyResult) {
    if (policy.newOrigin) this.approveOrigin(policy.newOrigin);
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
      const text = o.ok ? `${what} ok${o.detail ? ` (${o.detail})` : ''}` : `${what} failed: ${o.detail ?? 'error'}`;
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
        const r = action.name === 'type' ? await driver.type(String(a.ref), text) : await driver.select(String(a.ref), text);
        if (r.ok && text.trim().length >= MIN_MATCH_LENGTH) {
          // Anything we put into a page is now watched by the egress content filter.
          const l = this.taint.labelPlannerText(text, [...this.contextOrigins]);
          this.taint.register(text, l.label === 'trusted' ? 'user-sensitive' : 'untrusted', l.provenance);
        }
        this.audit('action-result', { action: action.name, ok: r.ok, detail: r.detail });
        return { text: r.ok ? `${action.name} ok` : `${action.name} failed: ${r.detail}`, summary: r.ok ? 'ok' : 'failed' };
      }
      case 'extract':
        return this.extract(String(a.query ?? ''), (a.schema ?? {}) as SchemaSpec);
      default:
        return { text: `unsupported action ${action.name}`, summary: 'failed' };
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
      this.audit('reader', { url, query, schema: spec, ok: false, error: (e as Error).message });
      return { text: `extract failed: ${(e as Error).message}`, summary: 'failed' };
    }
    if (r.usedFallback) this.audit('fallback', { role: 'reader' });
    if (!r.ok || !r.data) {
      this.audit('reader', { url, query, schema: spec, ok: false, error: r.error, attempts: r.attempts });
      return { text: `extract failed: ${r.error}`, summary: 'failed' };
    }
    // Reader output is untrusted too: screen its strings before the planner sees them.
    const data = await this.screenValues(r.data, url);
    const tainted = this.taint.wrapReaderOutput(data, url);
    this.audit('reader', { url, query, schema: spec, ok: true, output: data, attempts: r.attempts, taint: tainted.provenance });
    return {
      text: JSON.stringify({ ok: true, label: 'untrusted', source: url, data }),
      summary: `extracted ${JSON.stringify(data).slice(0, 200)}`,
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

function renderElement(e: SnapshotElement, name: string): string {
  let s = `[${e.ref}] ${e.role} "${name}"`;
  if (e.inputType) s += ` type=${e.inputType}`;
  if (e.href) s += ` -> ${e.href.slice(0, 120)}`;
  if (e.isSubmit) s += ' (submits form)';
  if (e.formAction && !e.href) s += ` [form ${e.formMethod ?? 'get'} ${e.formAction.slice(0, 120)}]`;
  return s;
}

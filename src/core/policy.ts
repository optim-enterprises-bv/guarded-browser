// Rule-based data-flow policy. Enforced in code; no LLM can downgrade its decisions.

import type { Decision, FormField, JudgeVerdict, PlannerAction, PolicyResult, SnapshotElement } from './types';
import type { TaintRegistry } from './taint';

export interface PolicyContext {
  currentUrl: string;
  /** origins named in the task, the tab's origin at task start, and user-approved origins */
  allowedOrigins: Set<string>;
  /** only the origins the task named / the user confirmed at task start (never grown by approvals) */
  taskOrigins?: Set<string>;
  taint: TaintRegistry;
  /** origins whose (untrusted) content the planner has seen so far */
  contextOrigins: string[];
  element?: SnapshotElement;
  /** current values of the fields in the element's form (for submit confirmations) */
  formFields?: FormField[];
}

/** Button / link names that always require confirmation (irreversible or outward). */
export const RISKY_NAME =
  /\b(buy|purchase|pay|checkout|check out|order|complete|finali[sz]e|proceed|approve|accept|authori[sz]e|grant|allow|merge|deploy|make public|publish|send|post|delete|remove|erase|sign ?in|log ?in|login|sign ?up|register|subscribe|unsubscribe|transfer|confirm|download|upload|share|submit|invite|book|reserve|donate|save)\b/i;

const SEVERITY: Record<Decision, number> = { allow: 0, confirm: 1, block: 2 };

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Origins the task names with an explicit http(s):// scheme. Bare names ("report.zip", "setup.py",
 * "shop.example.com") are NOT allowlisted; the user can add hosts in the allowlist editor shown at
 * task start.
 */
export function originsInTask(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/\bhttps?:\/\/[^\s"'<>)]+/gi)) {
    const o = originOf(m[0].replace(/[.,;:!?]+$/, ''));
    if (o) out.add(o);
  }
  return [...out];
}

function result(decision: Decision, reasons: string[], extra: Partial<PolicyResult> = {}): PolicyResult {
  return { decision, reasons, values: [], ...extra };
}

function escalate(r: PolicyResult, reason: string, extra: Partial<PolicyResult> = {}): PolicyResult {
  return { ...r, ...extra, decision: SEVERITY[r.decision] >= 1 ? r.decision : 'confirm', reasons: [...r.reasons, reason] };
}

function formValues(ctx: PolicyContext): PolicyResult['values'] {
  return (ctx.formFields ?? [])
    .filter((f) => f.value !== '' && !f.submitter)
    .map((f) => {
      const l = ctx.taint.labelPlannerText(f.value, ctx.contextOrigins);
      const value = f.password ? `${'•'.repeat(f.value.length)} (password)` : f.value;
      return { field: `${f.hidden ? '(hidden) ' : ''}${f.name}`, value, masked: !!f.password, label: l.label, provenance: l.provenance, taintIds: l.taintIds };
    });
}

function checkFormOrigin(r: PolicyResult, el: SnapshotElement, ctx: PolicyContext): PolicyResult {
  const o = el.formAction ? originOf(el.formAction) : null;
  if (o && !ctx.allowedOrigins.has(o)) return { ...r, newOrigin: o, reasons: [...r.reasons, `form sends data to a new origin not mentioned in the task: ${o}`] };
  return r;
}

export function evaluatePolicy(action: PlannerAction, ctx: PolicyContext): PolicyResult {
  const a = action.args;
  switch (action.name) {
    case 'navigate': {
      const url = String(a.url ?? '');
      const origin = originOf(url);
      if (!origin) return result('block', [`refusing non-http(s) or invalid URL: ${url.slice(0, 200)}`]);
      let r = result('allow', ['navigation']);
      r.destination = url;
      if (!ctx.allowedOrigins.has(origin)) {
        r = escalate(r, `navigation to a new origin not mentioned in the task: ${origin}`, { newOrigin: origin });
      }
      const l = ctx.taint.labelPlannerText(url, ctx.contextOrigins);
      // Untrusted URL + the planner has seen content from some OTHER origin = possible cross-origin flow.
      const foreign = ctx.contextOrigins.filter((o) => o !== origin);
      if (l.label === 'untrusted' && foreign.length > 0) {
        r = escalate(r, `URL was not given by the user and leads to a different origin than the pages it read (${foreign.join(', ')}): possible data exfiltration`);
      }
      r.values = [{ field: 'url', value: url, ...l }];
      return r;
    }
    case 'click': {
      const el = ctx.element;
      if (!el) return result('block', [`unknown element ref ${String(a.ref)}`]);
      let r = result('allow', ['click']);
      if (el.isSubmit) {
        r = escalate(r, 'clicking this submits a form (always confirmed)', {
          destination: el.formAction || ctx.currentUrl,
          values: formValues(ctx),
        });
        r = checkFormOrigin(r, el, ctx);
      }
      if (RISKY_NAME.test(el.name)) r = escalate(r, 'control labelled like an irreversible / outward action (always confirmed; label shown below)');
      if (el.inputType === 'file') r = escalate(r, 'file upload control (always confirmed)');
      if (el.href) {
        const o = originOf(el.href);
        if (o && !ctx.allowedOrigins.has(o)) {
          r = escalate(r, `link leads to a new origin not mentioned in the task: ${o}`, { newOrigin: o, destination: el.href });
        }
        if (/\bdownload\b/i.test(el.name) || /\.(exe|msi|dmg|pkg|deb|rpm|sh|bat|zip|apk)(\?|$)/i.test(el.href)) {
          r = escalate(r, 'looks like a file download (always confirmed)', { destination: el.href });
        }
      }
      return r;
    }
    case 'type':
    case 'select': {
      const el = ctx.element;
      if (!el) return result('block', [`unknown element ref ${String(a.ref)}`]);
      const text = String(action.name === 'type' ? a.text ?? '' : a.value ?? '');
      const l = ctx.taint.labelPlannerText(text, ctx.contextOrigins);
      const password = el.inputType === 'password';
      let r = result('allow', [action.name], {
        destination: el.formAction || ctx.currentUrl,
        values: [{ field: el.name.slice(0, 60), value: password ? '•'.repeat(text.length) + ' (password)' : text, masked: password, ...l }],
      });
      if (password) r = escalate(r, 'password field (always confirmed)');
      else if (el.formHasPassword) r = escalate(r, 'field belongs to a login form (always confirmed)');
      if (l.label === 'untrusted') r = escalate(r, 'typing a value that did not come from the user (untrusted data into a form)');
      const sensitive = ctx.taint.sensitiveIn(text);
      const dest = originOf(el.formAction || ctx.currentUrl);
      if (sensitive.length && (!dest || !(ctx.taskOrigins ?? ctx.allowedOrigins).has(dest))) {
        r = escalate(r, `typing ${[...new Set(sensitive.map((v) => v.sensitivity))].join('/')} from your task into a site your task did not name (${dest ?? 'unknown'})`);
      }
      return r;
    }
    case 'submit': {
      const el = ctx.element;
      if (!el) return result('block', [`unknown element ref ${String(a.ref)}`]);
      return checkFormOrigin(
        result('confirm', ['form submission (always confirmed)'], { destination: el.formAction || ctx.currentUrl, values: formValues(ctx) }),
        el,
        ctx,
      );
    }
    case 'scroll':
    case 'extract':
    case 'finish':
      return result('allow', [action.name]);
    default:
      return result('block', [`unknown action ${String((action as PlannerAction).name)}`]);
  }
}

/** Judge can only escalate. A code-required confirm/block is never downgraded. */
export function combine(policy: PolicyResult, judge: JudgeVerdict): { decision: Decision; reasons: string[] } {
  const decision = SEVERITY[judge.verdict] > SEVERITY[policy.decision] ? judge.verdict : policy.decision;
  const reasons = [...policy.reasons];
  if (SEVERITY[judge.verdict] > 0) reasons.push(`judge: ${judge.verdict} (${judge.reason})`);
  return { decision, reasons };
}

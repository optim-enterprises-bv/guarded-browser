// Shared types for the agent core. Nothing in src/core depends on Electron.

/** Where a value came from. Anything not from the user's own task text is untrusted. */
export interface Provenance {
  source: 'user-task' | 'reader' | 'snapshot' | 'planner';
  url?: string;
  timestamp: string;
  note?: string;
}

export type Label = 'trusted' | 'untrusted';

/** A value wrapped with its taint label and provenance chain. */
export interface Tainted<T = unknown> {
  id: string;
  value: T;
  label: Label;
  provenance: Provenance[];
}

export type ActionName =
  | 'navigate' | 'click' | 'type' | 'select' | 'scroll' | 'submit' | 'extract' | 'finish';

export interface PlannerAction {
  name: ActionName;
  args: Record<string, unknown>;
  /** tool_call id when native tool calling was used */
  callId?: string;
}

/** One interactive element in the accessibility-style snapshot. Names are untrusted page data. */
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  /** extra facts computed by our code (not by the page) used by the policy engine */
  tag?: string;
  inputType?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  inForm?: boolean;
  formHasPassword?: boolean;
  isSubmit?: boolean;
  value?: string;
}

export interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

export type Decision = 'allow' | 'confirm' | 'block';

export interface PolicyResult {
  decision: Decision;
  reasons: string[];
  /** set when the action would send data out of the browser */
  destination?: string;
  /** values that would leave, with their taint */
  values: Array<{ field?: string; value: string; label: Label; provenance: Provenance[]; taintIds: string[]; masked?: boolean }>;
  /** origin that the user would be approving (added to the allowlist on approval) */
  newOrigin?: string;
}

export interface JudgeVerdict {
  verdict: Decision;
  reason: string;
  error?: string;
}

export type ConfirmOutcome = 'approve' | 'deny' | 'stop' | 'timeout';

export interface ConfirmRequest {
  id: string;
  kind: 'action' | 'egress' | 'redirect' | 'download' | 'reputation';
  action: string;
  target: string;
  destination?: string;
  values: PolicyResult['values'];
  reasons: string[];
  judge?: JudgeVerdict;
  /** attacker-influenced text, shown quoted and labelled in the dialog */
  pageDerived?: Array<{ label: string; text: string }>;
}

export interface GuardVerdict {
  text: string;
  score: number;
  flagged: boolean;
}

export interface Guard {
  status(): 'ready' | 'loading' | 'unavailable' | 'disabled';
  statusDetail(): string;
  /** returns one verdict per input text (texts are chunked internally) */
  classify(texts: string[]): Promise<GuardVerdict[]>;
}

export const WITHHELD = '[content withheld: possible prompt injection]';

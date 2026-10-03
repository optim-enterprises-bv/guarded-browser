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
  formEnctype?: string;
  inForm?: boolean;
  formHasPassword?: boolean;
  isSubmit?: boolean;
  value?: string;
  /** names and types of the element's form's controls (no values): a recipe's recorded form shape */
  formShape?: Array<{ name: string; type: string }>;
  /** locator fields for recipes (src/core/locator.ts); never rendered for the planner */
  loc?: { landmark?: string; path?: string; cls?: string; id?: string; fieldName?: string; label?: string; href?: string };
}

export interface Snapshot {
  url: string;
  title: string;
  /** the page's first h1 (else h2), for recipe landmarks; never rendered for the planner */
  heading?: string;
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
  kind: 'action' | 'egress' | 'redirect' | 'download' | 'reputation' | 'profile' | 'mcp';
  action: string;
  target: string;
  destination?: string;
  values: PolicyResult['values'];
  reasons: string[];
  judge?: JudgeVerdict;
  /** which tab / pane the request comes from (browser-generated label + the tab's title, quoted) */
  source?: { label: string; title?: string };
  /** attacker-influenced text, shown quoted and labelled in the dialog */
  pageDerived?: Array<{ label: string; text: string }>;
  /**
   * Set when another AI program asked (an MCP client, item 3): the name IT gave in `initialize`, so
   * it is client-chosen text, shown quoted. The client never sees or answers the confirmation.
   */
  client?: string;
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

/** A form control as read by our isolated-world script (raw values; display code masks passwords). */
export interface FormField {
  name: string;
  value: string;
  hidden?: boolean;
  password?: boolean;
  /** a named submit button: only sent when it is the submitter */
  submitter?: boolean;
  /** an <input type=image> submitter: sends `name.x` / `name.y` click coordinates (numbers only) */
  image?: boolean;
}

export const WITHHELD = '[content withheld: possible prompt injection]';

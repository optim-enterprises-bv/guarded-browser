// Taint registry: every value that entered the agent from an untrusted source (reader output)
// or that is sensitive user data the planner handled is registered here. The registry is used
// (1) by the policy engine to label planner-supplied arguments and (2) by the webRequest egress
// layer to find those values inside outgoing URLs / bodies, including simple encodings.

import type { Label, Provenance, Tainted } from './types';

/** Values shorter than this are never matched in outgoing requests (too many false positives). */
export const MIN_MATCH_LENGTH = 6;

export type Sensitivity = 'email' | 'phone' | 'card' | 'secret';

export interface RegisteredValue {
  id: string;
  value: string;
  kind: 'untrusted' | 'user-sensitive';
  provenance: Provenance[];
  /** set for values pre-registered from the task text */
  sensitivity?: Sensitivity;
}

/** Registered task secrets are matched in outgoing requests down to this length (PINs). */
export const MIN_SECRET_MATCH_LENGTH = 4;

/**
 * Sensitive-looking values in the user's task: emails, phone / card numbers, values after a keyword
 * (quoted values are taken whole, punctuation kept), and keyword-less high-entropy tokens.
 */
export function findTaskSecrets(task: string): Array<{ value: string; sensitivity: Sensitivity }> {
  const out: Array<{ value: string; sensitivity: Sensitivity }> = [];
  const add = (value: string, sensitivity: Sensitivity) => {
    const v = value.trim();
    if (v && !out.some((o) => o.value === v)) out.push({ value: v, sensitivity });
  };
  const urls = [...task.matchAll(/\bhttps?:\/\/\S+/gi)].map((m) => m[0]);
  for (const m of task.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) add(m[0], 'email');
  for (const m of task.matchAll(/(?<![\w/:.])\+?\d[\d ().-]{5,}\d(?![\w/])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19) add(m[0], 'card');
    else if (digits.length >= 7 && digits.length <= 15) add(m[0], 'phone');
  }
  const KW = String.raw`\b(?:password|passcode|passphrase|pin|token|api[ _-]?key|secret|otp|cvv|cvc|ssn)\b\s*(?:is|=|:)?\s*`;
  for (const m of task.matchAll(new RegExp(`${KW}(?:"([^"]+)"|'([^']+)'|“([^”]+)”|(\\S{3,}))`, 'gi'))) {
    let v = m[1] ?? m[2] ?? m[3] ?? m[4];
    // an unquoted value at the end of a sentence: keep inner punctuation, drop one final . or ,
    if (m[4] && /[.,]$/.test(v) && v.length > 4) v = v.slice(0, -1);
    add(v, 'secret');
  }
  // keyword-less: tokens that look machine-generated (letters AND digits, 10+ chars, not URL/email)
  for (const m of task.matchAll(/(?<![\w@/.:-])[A-Za-z0-9_\-+/=!$%#*]{10,}(?![\w@])/g)) {
    const t = m[0];
    if (/[A-Za-z]/.test(t) && /\d/.test(t) && !urls.some((u) => u.includes(t)) && !out.some((o) => o.value.includes(t))) add(t, 'secret');
  }
  return out;
}

export interface TextLabel {
  label: Label;
  provenance: Provenance[];
  taintIds: string[];
}

const now = () => new Date().toISOString();

function b64(s: string): string[] {
  const std = Buffer.from(s, 'utf8').toString('base64');
  const noPad = std.replace(/=+$/, '');
  const url = noPad.replace(/\+/g, '-').replace(/\//g, '_');
  return [std, noPad, url];
}

/**
 * Base64 needles for all three byte alignments. For an offset k (value preceded by k unknown bytes)
 * only the 4-char groups made entirely of value bytes are stable, so the needle is the interior of
 * base64(pad_k + value) without the first mixed group and without the last partial group.
 */
function b64Aligned(v: string, min = MIN_MATCH_LENGTH): string[] {
  const out = new Set<string>();
  const bytes = Buffer.from(v, 'utf8');
  for (let k = 0; k < 3; k++) {
    const buf = Buffer.concat([Buffer.alloc(k, 0x41), bytes]);
    const std = buf.toString('base64');
    const firstPure = k === 0 ? 0 : 1; // group index where the value's bytes start alone
    const fullGroups = Math.floor(buf.length / 3);
    const inner = std.slice(firstPure * 4, fullGroups * 4);
    for (const s of [inner, inner.replace(/\+/g, '-').replace(/\//g, '_')]) if (s.length >= Math.max(4, min)) out.add(s);
  }
  for (const s of b64(v)) if (s.length >= min) out.add(s); // exact start + padding forms
  return [...out];
}

/** Lower-case needles (checked against lower-cased haystacks) and case-sensitive base64 needles. */
export function variants(value: string, min = MIN_MATCH_LENGTH): { lower: string[]; exact: string[] } {
  const v = value.trim();
  const lower = new Set<string>([
    v.toLowerCase(),
    encodeURIComponent(v).toLowerCase(),
    encodeURIComponent(v).replace(/%20/g, '+').toLowerCase(),
    encodeURIComponent(encodeURIComponent(v)).toLowerCase(),
  ]);
  // hex of the UTF-8 bytes (either digit case: the haystack is lower-cased), of the value as typed and
  // lower-cased: ?d=6a6f686e40... is as easy for page JS or a planner as base64. The length floor is on
  // the VALUE (hex doubles it; 'USD' must stay unmatched).
  if (v.length >= min) for (const s of [v, v.toLowerCase()]) lower.add(Buffer.from(s, 'utf8').toString('hex'));
  const exact = new Set<string>([...b64Aligned(v, min), ...b64Aligned(v.toLowerCase(), min)]);
  return { lower: [...lower].filter((x) => x.length >= min), exact: [...exact] };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export class TaintRegistry {
  private values = new Map<string, RegisteredValue>();
  private counter = 0;

  constructor(private readonly task = '') {}

  get taskText(): string {
    return this.task;
  }

  all(): RegisteredValue[] {
    return [...this.values.values()];
  }

  get(id: string): RegisteredValue | undefined {
    return this.values.get(id);
  }

  /** Register a value. Returns the existing entry when the same value/kind is already present. */
  register(value: string, kind: RegisteredValue['kind'], provenance: Provenance[]): RegisteredValue {
    const v = String(value).trim();
    for (const e of this.values.values()) if (e.value === v && e.kind === kind) return e;
    const entry = { id: `t${++this.counter}`, value: v, kind, provenance };
    this.values.set(entry.id, entry);
    return entry;
  }

  /** Register emails / phone / card numbers / secrets found in the task as user-sensitive. */
  preRegisterTaskSecrets(): RegisteredValue[] {
    return findTaskSecrets(this.task).map(({ value, sensitivity }) => {
      const e = this.register(value, 'user-sensitive', [{ source: 'user-task', timestamp: now(), note: sensitivity }]);
      e.sensitivity = sensitivity;
      return e;
    });
  }

  /**
   * Task-registered sensitive values contained in a text (used by the policy engine): plain at any
   * length, and URL-encoded / base64 / hex with the same needles the egress matcher uses (from
   * MIN_SECRET_MATCH_LENGTH), so a planner cannot route a secret past the check by encoding it.
   */
  sensitiveIn(text: string): RegisteredValue[] {
    const lower = text.toLowerCase();
    const encoded = new Set(this.matchRequest(text).map((e) => e.id));
    return this.all().filter((e) => e.sensitivity && (lower.includes(e.value.toLowerCase()) || encoded.has(e.id)));
  }

  /** Values that must never be written to the audit log in clear. */
  secretValues(): string[] {
    return this.all().filter((e) => e.sensitivity === 'secret' || e.sensitivity === 'card').map((e) => e.value);
  }

  /** Wrap reader output: every leaf value is untrusted and registered. */
  wrapReaderOutput<T>(data: T, url: string): Tainted<T> {
    const prov: Provenance = { source: 'reader', url, timestamp: now() };
    const walk = (x: unknown) => {
      if (typeof x === 'string' || typeof x === 'number') {
        if (String(x).trim().length > 0) this.register(String(x), 'untrusted', [prov]);
      } else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    };
    walk(data);
    return { id: `r${++this.counter}`, value: data, label: 'untrusted', provenance: [prov] };
  }

  /**
   * Label text the planner wants to type or navigate to.
   * Trusted only if it appears verbatim in the user's task. Everything else was produced by a
   * planner whose context contains untrusted page data, so it is untrusted.
   */
  labelPlannerText(text: string, contextOrigins: string[]): TextLabel {
    const t = String(text).trim();
    if (t.length > 0 && this.task.includes(t)) {
      // user-supplied: trusted. The agent registers it as 'user-sensitive' once it is typed somewhere.
      return { label: 'trusted', provenance: [{ source: 'user-task', timestamp: now() }], taintIds: this.findIn(t).map((m) => m.id) };
    }
    const matches = this.findIn(t);
    const untrusted = matches.filter((m) => m.kind === 'untrusted');
    const provenance: Provenance[] = untrusted.length
      ? untrusted.flatMap((m) => m.provenance)
      : [{ source: 'planner', timestamp: now(), note: `planner-generated; context contains untrusted data from ${contextOrigins.join(', ') || 'no pages yet'}` }];
    return { label: 'untrusted', provenance, taintIds: matches.map((m) => m.id) };
  }

  /** Registered values found in a piece of text (used for planner args), with the same normalisation. */
  findIn(text: string): RegisteredValue[] {
    return this.matchRequest(text);
  }

  /** Registered values found in an outgoing request (URL + body), with normalisation. */
  matchRequest(url: string, body?: string): RegisteredValue[] {
    const raw = [url, body ?? ''].join('\n');
    const lowered = [raw, safeDecode(url), body ? safeDecode(body) : ''].join('\n').toLowerCase();
    const hits: RegisteredValue[] = [];
    for (const e of this.values.values()) {
      const min = e.sensitivity ? MIN_SECRET_MATCH_LENGTH : MIN_MATCH_LENGTH;
      if (e.value.length < min) continue;
      const { lower, exact } = variants(e.value, min);
      if (lower.some((n) => lowered.includes(n)) || exact.some((n) => raw.includes(n))) hits.push(e);
    }
    return hits;
  }
}

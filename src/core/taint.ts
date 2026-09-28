// Taint registry: every value that entered the agent from an untrusted source (reader output)
// or that is sensitive user data the planner handled is registered here. The registry is used
// (1) by the policy engine to label planner-supplied arguments and (2) by the webRequest egress
// layer to find those values inside outgoing URLs / bodies, including simple encodings.

import type { Label, Provenance, Tainted } from './types';

/** Values shorter than this are never matched in outgoing requests (too many false positives). */
export const MIN_MATCH_LENGTH = 6;

export interface RegisteredValue {
  id: string;
  value: string;
  kind: 'untrusted' | 'user-sensitive';
  provenance: Provenance[];
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

/** Lower-case needles (checked against lower-cased haystacks) and case-sensitive base64 needles. */
export function variants(value: string): { lower: string[]; exact: string[] } {
  const v = value.trim();
  const lower = new Set<string>([
    v.toLowerCase(),
    encodeURIComponent(v).toLowerCase(),
    encodeURIComponent(v).replace(/%20/g, '+').toLowerCase(),
    encodeURIComponent(encodeURIComponent(v)).toLowerCase(),
  ]);
  const exact = new Set<string>([...b64(v), ...b64(v.toLowerCase())].filter((x) => x.length >= MIN_MATCH_LENGTH));
  return { lower: [...lower].filter((x) => x.length >= MIN_MATCH_LENGTH), exact: [...exact] };
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
      if (e.value.length < MIN_MATCH_LENGTH) continue;
      const { lower, exact } = variants(e.value);
      if (lower.some((n) => lowered.includes(n)) || exact.some((n) => raw.includes(n))) hits.push(e);
    }
    return hits;
  }
}

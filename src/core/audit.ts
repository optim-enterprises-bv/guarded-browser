// Append-only JSONL audit log, one file per app session, in userData/audit/.

import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type AuditType =
  | 'task-start' | 'task-end' | 'navigation' | 'snapshot' | 'guard' | 'reader' | 'judge' | 'policy'
  | 'confirmation' | 'planner-action' | 'action-result' | 'egress' | 'fallback' | 'error'
  // wave 2: new surfaces that change what the user (or the agent) can see
  | 'page-actions' | 'panel' | 'hibernate' | 'translate' | 'capture' | 'bundle' | 'extensions' | 'session' | 'workspace' | 'stack'
  // AI capabilities item 2: one event per chat reply (sizes, screening and endpoint; never the text)
  | 'chat'
  // item 3: one event per MCP call / refused MCP request, and the phone channel's card lifecycle
  | 'mcp' | 'phone'
  // item 4: one event per triage run / bulk action / reply draft (counts and categories; never mail text)
  | 'triage'
  // item 5: recipe saves / imports / replay steps, and one event per watcher run (typed values or a
  // hash; never page text)
  | 'recipe' | 'replay' | 'watcher';

export interface AuditEvent {
  ts: string;
  seq: number;
  type: AuditType;
  taskId?: string;
  [k: string]: unknown;
}

export class AuditLog {
  readonly file: string;
  private seq = 0;
  private listeners: Array<(e: AuditEvent) => void> = [];
  private redactions: string[] = [];

  constructor(dir: string, sessionId = new Date().toISOString().replace(/[:.]/g, '-')) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // also tighten directories / files created by older versions
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) chmodSync(join(dir, f), 0o600);
    this.file = join(dir, `session-${sessionId}.jsonl`);
    if (!existsSync(this.file)) writeFileSync(this.file, '', { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  /** Values (task passwords, card numbers, ...) replaced by [redacted] in every later event. */
  addRedactions(values: string[]) {
    for (const v of values) if (v.length >= 3 && !this.redactions.includes(v)) this.redactions.push(v);
    this.redactions.sort((a, b) => b.length - a.length);
  }

  private redact(line: string): string {
    let out = line;
    for (const v of this.redactions) {
      const j = JSON.stringify(v).slice(1, -1); // as it appears inside JSON strings
      out = out.split(j).join('[redacted]');
      const enc = encodeURIComponent(v);
      if (enc !== v) out = out.split(enc).join('[redacted]');
    }
    return out;
  }

  onEvent(fn: (e: AuditEvent) => void): void {
    this.listeners.push(fn);
  }

  write(type: AuditType, data: Record<string, unknown> = {}): AuditEvent {
    const e: AuditEvent = { ts: new Date().toISOString(), seq: ++this.seq, type, ...data };
    // appendFileSync with flag 'a': we never rewrite or truncate the file
    const line = this.redact(JSON.stringify(e));
    appendFileSync(this.file, line + '\n', { flag: 'a', mode: 0o600 });
    const out = this.redactions.length ? (JSON.parse(line) as AuditEvent) : e;
    for (const l of this.listeners) l(out);
    return out;
  }

  read(): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEvent);
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

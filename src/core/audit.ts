// Append-only JSONL audit log, one file per app session, in userData/audit/.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type AuditType =
  | 'task-start' | 'task-end' | 'navigation' | 'snapshot' | 'guard' | 'reader' | 'judge' | 'policy'
  | 'confirmation' | 'planner-action' | 'action-result' | 'egress' | 'fallback' | 'error';

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

  constructor(dir: string, sessionId = new Date().toISOString().replace(/[:.]/g, '-')) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `session-${sessionId}.jsonl`);
  }

  onEvent(fn: (e: AuditEvent) => void): void {
    this.listeners.push(fn);
  }

  write(type: AuditType, data: Record<string, unknown> = {}): AuditEvent {
    const e: AuditEvent = { ts: new Date().toISOString(), seq: ++this.seq, type, ...data };
    // appendFileSync with flag 'a': we never rewrite or truncate the file
    appendFileSync(this.file, JSON.stringify(e) + '\n', { flag: 'a' });
    for (const l of this.listeners) l(e);
    return e;
  }

  read(): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEvent);
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

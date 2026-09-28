import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../../src/core/audit';

describe('audit log', () => {
  it('appends JSONL lines with increasing sequence numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-audit-'));
    const log = new AuditLog(dir, 'test');
    const seen: number[] = [];
    log.onEvent((e) => seen.push(e.seq));
    log.write('task-start', { task: 'a' });
    log.write('policy', { decision: 'confirm' });
    const again = new AuditLog(dir, 'test'); // a second writer never truncates
    again.write('task-end', {});
    const lines = readFileSync(log.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['task-start', 'policy', 'task-end']);
    expect(seen).toEqual([1, 2]);
  });
});

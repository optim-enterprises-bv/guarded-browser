// The closed-tab stack. The security-relevant property is what this store CANNOT represent: it
// holds a URL, a title, a position and a timestamp, and there is no field for gate state, the
// agent-tab marker or taint. These tests pin that down, plus the LIFO/bounded/persist behaviour.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClosedTabStore, MAX_CLOSED, reopenable } from '../../src/core/closed-tabs';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-closed-'));
  file = join(dir, 'closed-tabs.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('closed tabs', () => {
  it('reopens LIFO: the most recently closed tab comes back first', () => {
    const s = new ClosedTabStore(file);
    s.push('https://a.test/1', 'A', 0);
    s.push('https://b.test/2', 'B', 1);
    expect(s.peek()?.url).toBe('https://b.test/2');
    expect(s.pop()?.url).toBe('https://b.test/2');
    expect(s.pop()?.url).toBe('https://a.test/1');
    expect(s.pop()).toBeUndefined();
  });

  it('keeps the strip position so a reopened tab lands where it was', () => {
    const s = new ClosedTabStore(file);
    s.push('https://a.test/', 'A', 3);
    expect(s.pop()).toEqual({ url: 'https://a.test/', title: 'A', pos: 3, t: expect.any(Number) });
  });

  it('is bounded: oldest entries fall off, never an unbounded file', () => {
    const s = new ClosedTabStore(file);
    for (let i = 0; i < MAX_CLOSED + 10; i++) s.push(`https://a.test/${i}`, `T${i}`, i);
    expect(s.size).toBe(MAX_CLOSED);
    expect(s.list()).toHaveLength(MAX_CLOSED);
    // the newest survived, the oldest did not
    expect(s.peek()?.url).toBe(`https://a.test/${MAX_CLOSED + 9}`);
    expect(s.list().some((e) => e.url === 'https://a.test/0')).toBe(false);
  });

  it('never records a blank, internal, data: or blob: URL', () => {
    const s = new ClosedTabStore(file);
    for (const u of ['', 'about:blank', 'data:text/html,x', 'blob:https://a.test/x', 'https://guarded-browser.invalid/proceed?t=1', 'not a url', 'file:///etc/passwd']) {
      expect(s.push(u, 'x', 0)).toBe(false);
    }
    expect(s.size).toBe(0);
    // ...and the check is exposed for callers that want to ask first
    expect(reopenable('https://ok.test/')).toBe(true);
  });

  it('persists across a restart as URL + title + position only', () => {
    const s = new ClosedTabStore(file);
    s.push('https://keep.test/page', 'Keep', 2);
    s.flush();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(raw.tabs[0]).sort()).toEqual(['pos', 't', 'title', 'url']);
    // reopen with a fresh store, as a next launch would
    const s2 = new ClosedTabStore(file);
    expect(s2.pop()?.url).toBe('https://keep.test/page');
  });

  it('the on-disk file has no field that could carry gate state', () => {
    const s = new ClosedTabStore(file);
    s.push('https://a.test/', 'A', 0);
    s.flush();
    const text = readFileSync(file, 'utf8');
    for (const forbidden of ['gate', 'guarded', 'agentTab', 'taint', 'origin', 'guardOrigins']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('writes 0600 and ignores a tampered/oversized file instead of trusting it', () => {
    const s = new ClosedTabStore(file);
    s.push('https://a.test/', 'A', 0);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, JSON.stringify({ version: 1, tabs: [{ url: 'https://x.test/', title: 'x', pos: 0, t: 1, gate: 'post-task' }] }));
    const s2 = new ClosedTabStore(file);
    expect(s2.loadError).toBeTruthy(); // strict schema: an extra field is a load error
    expect(s2.size).toBe(0);
  });

  it('cleans control characters and caps a page-supplied title', () => {
    const s = new ClosedTabStore(file);
    s.push('https://a.test/', 'A\n\u0000\u001b[31m'.padEnd(500, 'x'), 0);
    const e = s.pop()!;
    expect(e.title.length).toBeLessThanOrEqual(200);
    expect(e.title).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('clear() empties the stack and the file', () => {
    const s = new ClosedTabStore(file);
    s.push('https://a.test/', 'A', 0);
    s.clear();
    expect(s.size).toBe(0);
    expect(new ClosedTabStore(file).size).toBe(0);
  });
});

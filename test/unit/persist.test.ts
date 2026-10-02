// The shared JSON-store primitive (src/core/persist.ts): atomic 0600 writes, and an unreadable
// file is moved aside rather than replaced by the defaults on the next write.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, atomicWriteFileAsync, loadJson } from '../../src/core/persist';
import { BookmarkStore, BAR_ID } from '../../src/core/bookmarks';
import { loadSettings } from '../../src/core/config';

const Schema = z.object({ version: z.literal(1), items: z.array(z.string()) }).strict();
const fallback = () => ({ version: 1 as const, items: [] as string[] });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-persist-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('atomicWriteFile', () => {
  it('writes mode 0600 and leaves no temp file behind', () => {
    const f = join(dir, 'a.json');
    atomicWriteFile(f, '{"x":1}\n');
    expect(readFileSync(f, 'utf8')).toBe('{"x":1}\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    atomicWriteFile(f, '{"x":2}\n', { mode: 0o600, fsync: true });
    expect(readFileSync(f, 'utf8')).toBe('{"x":2}\n');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('async variant writes 0600 and skips the rename when commit says no', async () => {
    const f = join(dir, 'b.json');
    expect(await atomicWriteFileAsync(f, 'one')).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(await atomicWriteFileAsync(f, 'two', { commit: () => false })).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('one');
    expect(readdirSync(dir)).toEqual(['b.json']);
  });
});

describe('loadJson', () => {
  it('loads a valid file', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(f, JSON.stringify({ version: 1, items: ['a', 'b'] }));
    const r = loadJson(f, Schema, { fallback: fallback() });
    expect(r.loadError).toBeNull();
    expect(r.quarantinedTo).toBeNull();
    expect(r.value.items).toEqual(['a', 'b']);
    expect(existsSync(f)).toBe(true);
  });

  it('a missing file is not an error', () => {
    const r = loadJson(join(dir, 'none.json'), Schema, { fallback: fallback() });
    expect(r).toEqual({ value: fallback(), loadError: null, quarantinedTo: null });
  });

  it('a corrupt file is quarantined, not overwritten', () => {
    const f = join(dir, 'bookmarks.json');
    writeFileSync(f, '{"version":1,"items":["kept"');
    const r = loadJson(f, Schema, { fallback: fallback() });
    expect(r.value).toEqual(fallback());
    expect(r.quarantinedTo).toMatch(/bookmarks\.json\.corrupt-\d{4}-\d\d-\d\dT/);
    expect(r.loadError).toMatch(/^bookmarks\.json was unreadable .* has been kept as bookmarks\.json\.corrupt-/);
    expect(existsSync(f)).toBe(false);
    expect(readFileSync(r.quarantinedTo!, 'utf8')).toBe('{"version":1,"items":["kept"');
    // the next write creates a fresh file; the quarantined bytes are untouched
    atomicWriteFile(f, JSON.stringify(fallback()));
    expect(readFileSync(r.quarantinedTo!, 'utf8')).toBe('{"version":1,"items":["kept"');
  });

  it('a file that parses but fails validation (schema or check) is quarantined too', () => {
    const f = join(dir, 'x.json');
    writeFileSync(f, JSON.stringify({ version: 2, items: [] }));
    expect(loadJson(f, Schema, { fallback: fallback() }).quarantinedTo).toBeTruthy();
    writeFileSync(f, JSON.stringify({ version: 1, items: ['a'] }));
    const r = loadJson(f, Schema, { fallback: fallback(), check: (v) => (v.items.length > 0 ? 'too many' : null) });
    expect(r.loadError).toMatch(/too many/);
    expect(existsSync(f)).toBe(false);
  });

  it('a store keeps the user\'s bookmarks aside when its file is unreadable', () => {
    const f = join(dir, 'bookmarks.json');
    writeFileSync(f, 'not json');
    const s = new BookmarkStore(f);
    expect(s.loadError).toMatch(/kept as bookmarks\.json\.corrupt-/);
    s.addBookmark(BAR_ID, 'new', 'https://new.example/');
    const aside = readdirSync(dir).filter((n) => n.startsWith('bookmarks.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe('not json');
  });

  it('settings: an unreadable file is quarantined and reported only when asked to', () => {
    const f = join(dir, 'settings.json');
    writeFileSync(f, '{oops');
    loadSettings(f); // read-only peek: nothing moves
    expect(existsSync(f)).toBe(true);
    const seen: string[] = [];
    const s = loadSettings(f, { onLoadError: (m) => seen.push(m) });
    expect(s.general.startup).toBe('blank');
    expect(seen[0]).toMatch(/^settings\.json was unreadable/);
    expect(existsSync(f)).toBe(false);
  });
});

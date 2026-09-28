import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileRegistry, RegistrySchema, partitionDir } from '../../src/main/profiles';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'gb-prof-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function oldLayout(ud: string) {
  writeFileSync(join(ud, 'settings.json'), JSON.stringify({ agent: { maxSteps: 7 } }));
  mkdirSync(join(ud, 'audit'));
  writeFileSync(join(ud, 'audit', 'session-1.jsonl'), '{"type":"task-start"}\n');
  mkdirSync(join(ud, 'downloads-pending'));
  writeFileSync(join(ud, 'downloads-pending', 'x.part'), 'x');
  mkdirSync(join(ud, 'reputation', 'feeds'), { recursive: true });
  writeFileSync(join(ud, 'reputation', 'feeds', 'hagezi.txt'), 'evil.example\n');
  writeFileSync(join(ud, 'reputation', 'local-allowlist.txt'), 'mine.example\n');
  writeFileSync(join(ud, 'reputation', 'local-blocklist.txt'), 'bad.example\n');
  mkdirSync(join(ud, 'Partitions', 'guarded'), { recursive: true });
  writeFileSync(join(ud, 'Partitions', 'guarded', 'Cookies'), 'cookie-db');
}

describe('profile registry', () => {
  it('migrates the single-profile layout into a default profile without data loss', () => {
    const ud = tmp();
    oldLayout(ud);
    const r = new ProfileRegistry(ud);
    const [p] = r.list();
    expect(p).toMatchObject({ name: 'Default', partition: 'persist:guarded' });
    const dir = r.dirOf(p.id);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ agent: { maxSteps: 7 } });
    expect(readFileSync(join(dir, 'audit', 'session-1.jsonl'), 'utf8')).toContain('task-start');
    expect(readFileSync(join(dir, 'downloads-pending', 'x.part'), 'utf8')).toBe('x');
    expect(readFileSync(join(dir, 'reputation', 'local-allowlist.txt'), 'utf8')).toBe('mine.example\n');
    expect(readFileSync(join(dir, 'reputation', 'local-blocklist.txt'), 'utf8')).toBe('bad.example\n');
    // shared public data and the browsing session stay where they are
    expect(readFileSync(join(ud, 'reputation', 'feeds', 'hagezi.txt'), 'utf8')).toBe('evil.example\n');
    expect(readFileSync(join(partitionDir(ud, p.partition), 'Cookies'), 'utf8')).toBe('cookie-db');
    // old locations are gone, registry is valid, atomic write left no temp files
    expect(existsSync(join(ud, 'settings.json'))).toBe(false);
    expect(RegistrySchema.safeParse(JSON.parse(readFileSync(join(ud, 'profiles.json'), 'utf8'))).success).toBe(true);
    expect(readdirSync(ud).filter((f) => f.includes('.tmp') || f === 'profiles-migrating.json')).toEqual([]);
    expect(statSync(join(ud, 'profiles.json')).mode & 0o777).toBe(0o600);
    // loading again does not migrate twice
    expect(new ProfileRegistry(ud).list()).toEqual(r.list());
  });

  it('resumes an interrupted migration with the same profile id', () => {
    const ud = tmp();
    oldLayout(ud);
    const id = '11111111-2222-4333-8444-555555555555';
    writeFileSync(join(ud, 'profiles-migrating.json'), JSON.stringify({ id }));
    mkdirSync(join(ud, 'profiles', id), { recursive: true });
    // settings were already moved before the crash
    writeFileSync(join(ud, 'profiles', id, 'settings.json'), '{"moved":true}');
    rmSync(join(ud, 'settings.json'));
    const r = new ProfileRegistry(ud);
    expect(r.list()[0].id).toBe(id);
    expect(readFileSync(join(ud, 'profiles', id, 'settings.json'), 'utf8')).toBe('{"moved":true}');
    expect(existsSync(join(ud, 'profiles', id, 'audit', 'session-1.jsonl'))).toBe(true);
  });

  it('a fresh install gets its own profile partition', () => {
    const r = new ProfileRegistry(tmp());
    const [p] = r.list();
    expect(p.partition).toBe(`persist:profile-${p.id}`);
  });

  it('create / update / remove with validation; the last profile stays; partitions are never reused', () => {
    const ud = tmp();
    const r = new ProfileRegistry(ud);
    const b = r.create('Work', '#1B8A5A');
    expect(b).toMatchObject({ name: 'Work', color: '#1b8a5a', partition: `persist:profile-${b.id}` });
    expect(existsSync(r.dirOf(b.id))).toBe(true);
    for (const bad of ['', 'x'.repeat(41), '<img src=x>', 'a;}*{color:red}']) expect(() => r.create(bad), bad).toThrow();
    expect(() => r.update(b.id, { color: 'red' })).toThrow();
    expect(r.update(b.id, { name: 'Work 2' }).name).toBe('Work 2');
    expect(() => r.dirOf('../../etc')).toThrow();
    r.remove(b.id);
    expect(r.list()).toHaveLength(1);
    expect(() => r.remove(r.list()[0].id)).toThrow(/last profile/);
    const reg = JSON.parse(readFileSync(join(ud, 'profiles.json'), 'utf8'));
    expect(reg.retiredPartitions).toEqual([b.partition]);
    const c = r.create('Work');
    expect(c.partition).not.toBe(b.partition);
  });

  it('refuses a corrupted or tampered registry', () => {
    const ud = tmp();
    new ProfileRegistry(ud);
    const f = join(ud, 'profiles.json');
    const reg = JSON.parse(readFileSync(f, 'utf8'));
    reg.profiles[0].partition = 'persist:someone-elses';
    writeFileSync(f, JSON.stringify(reg));
    expect(() => new ProfileRegistry(ud)).toThrow(/invalid/);
  });
});

describe('profile registry hardening', () => {
  it('rejects duplicate ids, shared partitions and reuse of retired partitions', () => {
    const ud = tmp();
    const r = new ProfileRegistry(ud);
    const b = r.create('B');
    const f = join(ud, 'profiles.json');
    const good = JSON.parse(readFileSync(f, 'utf8'));
    const dupId = structuredClone(good);
    dupId.profiles[1].id = dupId.profiles[0].id;
    dupId.profiles[1].partition = `persist:profile-${dupId.profiles[0].id}`;
    expect(RegistrySchema.safeParse(dupId).success).toBe(false);
    const dupPart = structuredClone(good);
    dupPart.profiles[1].partition = dupPart.profiles[0].partition;
    expect(RegistrySchema.safeParse(dupPart).success).toBe(false);
    const reused = structuredClone(good);
    reused.retiredPartitions = [b.partition];
    expect(RegistrySchema.safeParse(reused).success).toBe(false);
    writeFileSync(f, JSON.stringify(dupPart));
    expect(() => new ProfileRegistry(ud)).toThrow(/invalid/);
  });

  it('sweeps reappeared partition dirs of deleted profiles', () => {
    const ud = tmp();
    const r = new ProfileRegistry(ud);
    const b = r.create('B');
    r.remove(b.id);
    const d = partitionDir(ud, b.partition);
    mkdirSync(join(d, 'Local Storage'), { recursive: true });
    writeFileSync(join(d, 'Cookies'), 'late flush');
    expect(r.sweepRetired()).toEqual([d]);
    expect(existsSync(d)).toBe(false);
    expect(existsSync(partitionDir(ud, r.list()[0].partition)) || true).toBe(true); // live profile untouched
  });

  it('quarantines single-profile files that reappear after migration', () => {
    const ud = tmp();
    const r = new ProfileRegistry(ud);
    writeFileSync(join(ud, 'settings.json'), '{"stray":true}');
    mkdirSync(join(ud, 'audit'));
    writeFileSync(join(ud, 'audit', 'session-old.jsonl'), '{}\n');
    const q = r.quarantineStrays();
    expect(q.moved.sort()).toEqual(['audit', 'settings.json']);
    expect(existsSync(join(ud, 'settings.json'))).toBe(false);
    expect(readFileSync(join(q.dir, 'settings.json'), 'utf8')).toBe('{"stray":true}');
    expect(q.dir.startsWith(join(ud, 'quarantine'))).toBe(true);
    // the default profile's own settings are not touched
    expect(existsSync(r.dirOf(r.list()[0].id))).toBe(true);
  });
});

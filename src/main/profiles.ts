// Profile registry (userData/profiles.json) and the one-time migration from the single-profile
// layout. No Electron imports: unit-tested in test/unit/profiles.test.ts.
//
// Model (Vivaldi / Chromium): one app process; each profile = its own Chromium session partition
// + its own app-state directory userData/profiles/<id>/ + its own window.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../core/persist';

const HEX = /^#[0-9a-f]{6}$/;
const ID = /^[0-9a-f-]{36}$/;

export const ProfileSchema = z
  .object({
    id: z.string().regex(ID),
    name: z.string().regex(/^[\p{L}\p{N} _.'-]{1,40}$/u, 'name: 1-40 letters, digits, space, _ . \' -'),
    color: z.string().regex(HEX, 'colour must be #rrggbb'),
    /** Chromium partition; `persist:profile-<id>` for new profiles, never reused after delete */
    partition: z.string().regex(/^persist:(guarded|profile-[0-9a-f-]{36})$/),
    createdAt: z.string().max(40),
    /**
     * Ephemeral (ticket 29): a first-class profile FLAVOUR, not a bypass. The guard, policy, egress
     * and reputation layers are identical to any other profile — the only differences are that the
     * partition and profile directory are removed when the window closes, history writes are off,
     * and the closed-tab stack is not persisted.
     *
     * Deliberately NOT a `private: true` flag read by the security layers: if any of them could see
     * it, it would become a switch that changes their behaviour, which is exactly the wrong shape.
     */
    ephemeral: z.boolean().optional(),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

export const RegistrySchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(ProfileSchema).min(1).max(100),
    /** partitions ever used (deleted ones stay listed so their names are never reused) */
    retiredPartitions: z.array(z.string().regex(/^persist:(guarded|profile-[0-9a-f-]{36})$/)).max(1000),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ids = r.profiles.map((p) => p.id);
    const parts = r.profiles.map((p) => p.partition);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['profiles'], message: 'duplicate profile id' });
    if (new Set(parts).size !== parts.length) ctx.addIssue({ code: 'custom', path: ['profiles'], message: 'two profiles share a partition' });
    if (parts.some((p) => r.retiredPartitions.includes(p))) ctx.addIssue({ code: 'custom', path: ['retiredPartitions'], message: 'an active profile uses a retired partition' });
  });

export type Registry = z.infer<typeof RegistrySchema>;

export const PROFILE_COLORS = ['#2f5bd3', '#1b8a5a', '#b3261e', '#7c3aed', '#c2410c', '#0e7490', '#a21caf', '#4d5b6b'];

/** Files and directories of the single-profile layout that belong to the user's profile. */
export const MIGRATED_ENTRIES = ['settings.json', 'audit', 'downloads-pending', 'reputation/local-blocklist.txt', 'reputation/local-allowlist.txt'];


/** Partition directory on disk for a `persist:<name>` partition. */
export function partitionDir(userData: string, partition: string): string {
  return join(userData, 'Partitions', partition.replace(/^persist:/, ''));
}

export class ProfileRegistry {
  readonly file: string;
  private reg: Registry;

  constructor(readonly userData: string) {
    this.file = join(userData, 'profiles.json');
    this.reg = this.load();
  }

  dirOf(id: string): string {
    if (!ID.test(id)) throw new Error('bad profile id');
    return join(this.userData, 'profiles', id);
  }

  list(): Profile[] {
    return this.reg.profiles.map((p) => ({ ...p }));
  }

  get(id: string): Profile | undefined {
    const p = this.reg.profiles.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  private save() {
    RegistrySchema.parse(this.reg); // never write an invalid registry
    atomicWriteFile(this.file, JSON.stringify(this.reg, null, 2) + '\n');
  }

  /**
   * Load profiles.json, or on first run create the default profile, migrating the single-profile
   * layout into it (settings, audit logs, downloads staging, local lists; the existing
   * `persist:guarded` partition is kept as the default profile's partition, so no browsing data moves).
   * Idempotent: a crash half-way resumes with the same profile id (profiles-migrating.json).
   */
  private load(): Registry {
    mkdirSync(this.userData, { recursive: true });
    if (existsSync(this.file)) {
      const r = RegistrySchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!r.success) throw new Error(`profiles.json is invalid: ${r.error.issues[0]?.message}`);
      return r.data;
    }
    const pending = join(this.userData, 'profiles-migrating.json');
    let id: string = randomUUID();
    if (existsSync(pending)) {
      const p = JSON.parse(readFileSync(pending, 'utf8')) as { id?: string };
      if (p.id && ID.test(p.id)) id = p.id;
    } else atomicWriteFile(pending, JSON.stringify({ id }));
    const dir = join(this.userData, 'profiles', id);
    mkdirSync(join(dir, 'reputation'), { recursive: true, mode: 0o700 });
    for (const entry of MIGRATED_ENTRIES) {
      const from = join(this.userData, entry);
      const to = join(dir, entry);
      if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    }
    const hadSession = existsSync(partitionDir(this.userData, 'persist:guarded'));
    const reg: Registry = {
      version: 1,
      profiles: [{ id, name: 'Default', color: PROFILE_COLORS[0], partition: hadSession ? 'persist:guarded' : `persist:profile-${id}`, createdAt: new Date().toISOString() }],
      retiredPartitions: [],
    };
    this.reg = reg;
    this.save();
    rmSync(pending, { force: true });
    return reg;
  }

  create(name: string, color?: string, opts: { ephemeral?: boolean } = {}): Profile {
    const id = randomUUID();
    const partition = `persist:profile-${id}`;
    if (this.reg.retiredPartitions.includes(partition)) throw new Error('partition already used');
    const p = ProfileSchema.parse({
      id,
      name: name.trim(),
      color: (color ?? PROFILE_COLORS[this.reg.profiles.length % PROFILE_COLORS.length]).toLowerCase(),
      partition,
      createdAt: new Date().toISOString(),
      ...(opts.ephemeral ? { ephemeral: true } : {}),
    });
    mkdirSync(this.dirOf(id), { recursive: true, mode: 0o700 });
    this.reg.profiles.push(p);
    this.save();
    return { ...p };
  }

  update(id: string, patch: { name?: string; color?: string }): Profile {
    const i = this.reg.profiles.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('no such profile');
    const next = ProfileSchema.parse({
      ...this.reg.profiles[i],
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.color !== undefined ? { color: String(patch.color).toLowerCase() } : {}),
    });
    this.reg.profiles[i] = next;
    this.save();
    return { ...next };
  }

  /** Remove directories of retired (deleted) partitions that reappeared, e.g. a late Chromium flush. */
  sweepRetired(): string[] {
    const removed: string[] = [];
    for (const part of this.reg.retiredPartitions) {
      const d = partitionDir(this.userData, part);
      if (existsSync(d)) {
        rmSync(d, { recursive: true, force: true });
        removed.push(d);
      }
    }
    return removed;
  }

  /**
   * Single-profile files that reappear at the top level after migration (an old build, a restore
   * from backup, ...) are never silently ignored or silently used: they are moved to
   * userData/quarantine/<timestamp>/ and reported.
   */
  quarantineStrays(): { dir: string; moved: string[] } {
    const moved: string[] = [];
    const dir = join(this.userData, 'quarantine', new Date().toISOString().replace(/[:.]/g, '-'));
    for (const entry of MIGRATED_ENTRIES) {
      const from = join(this.userData, entry);
      if (!existsSync(from)) continue;
      const to = join(dir, entry);
      mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
      renameSync(from, to);
      moved.push(entry);
    }
    return { dir, moved };
  }

  /** Remove from the registry (the caller wipes the session and directories first). */
  remove(id: string): Profile {
    if (this.reg.profiles.length <= 1) throw new Error('the last profile cannot be deleted');
    const p = this.reg.profiles.find((x) => x.id === id);
    if (!p) throw new Error('no such profile');
    this.reg.profiles = this.reg.profiles.filter((x) => x.id !== id);
    this.reg.retiredPartitions.push(p.partition);
    this.save();
    return p;
  }
}

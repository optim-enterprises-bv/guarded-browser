// Portable profile bundle (ticket 30): export/import of settings, themes, bookmarks, keybindings,
// saved sessions, workspaces and local reputation as one versioned JSON file.
//
// WHY NOT SYNC (ticket 31): sync needs a server, an identity and a key hierarchy. This gives most of
// the practical benefit — `scp` the file — with no backend and no vendor account, which is the
// product's premise.
//
// A BUNDLE IS UNTRUSTED INPUT. Every rule below exists because the file may come from anywhere:
//  - zod-validate the whole thing; unknown keys are rejected (`.strict()` at every level)
//  - caps on every array and string, so a bundle cannot exhaust memory
//  - **no nicknames, ever.** The bookmarks importer already refuses `SHORTCUTURL`
//    (bookmarks.ts:440-442) because a nickname turns a typed word into a URL — an imported file
//    must not be able to seed one.
//  - **no partition, no cookies, no profile identity.** A bundle moves preferences; it never moves
//    a session, a logged-in cookie jar or storage. Importing cannot make two profiles share storage.
//  - **no gate/taint/agent state of any kind.** There is no field for it and the schema is strict.
//  - import is validated as a WHOLE first; a bundle that fails anywhere changes nothing (no partial
//    application), and the caller can ask for a dry run.

import { z } from 'zod';
import { BookmarkSchema, FolderSchema } from './bookmarks';

export const BUNDLE_KIND = 'guarded-browser.profile-bundle';
export const BUNDLE_VERSION = 1;

export const MAX_BUNDLE_BYTES = 2_000_000;

// settings: a loose but bounded bag — the settings schema lives in config.ts and is the authority
// for what is honoured. Anything not in it is dropped on import rather than trusted.
const SettingsSchema = z.record(z.string().max(64), z.unknown());

export const ProfileBundleSchema = z
  .object({
    kind: z.literal(BUNDLE_KIND),
    version: z.literal(BUNDLE_VERSION),
    exportedAt: z.number().int().nonnegative(),
    /** purely informational; never used to decide where anything lands */
    appVersion: z.string().max(40).optional(),
    settings: SettingsSchema.optional(),
    themes: z
      .object({
        custom: z.array(z.record(z.string().max(64), z.unknown())).max(50),
        activeId: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    bookmarks: z.array(z.union([BookmarkSchema, FolderSchema])).max(10_000).optional(),
    keybindings: z.record(z.string().max(64), z.string().max(64)).optional(),
    savedSessions: z
      .array(
        z
          .object({
            name: z.string().max(80),
            createdAt: z.number().int().nonnegative(),
            tabs: z.array(z.object({ url: z.string().max(2048), title: z.string().max(200) }).strict()).max(50),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    workspaces: z
      .array(
        z
          .object({
            name: z.string().max(40),
            colorIndex: z.number().int().min(0).max(11),
            tabs: z.array(z.object({ url: z.string().max(2048), title: z.string().max(200) }).strict()).max(50),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    reputation: z.record(z.string().max(2048), z.number().max(1_000_000)).optional(),
  })
  .strict();

export type ProfileBundle = z.infer<typeof ProfileBundleSchema>;

/**
 * Build a bundle from the caller's current state. The caller passes only what it wants to export;
 * anything it leaves out is absent from the file rather than empty, so an import can tell "not
 * included" from "explicitly cleared".
 */
export function buildBundle(input: {
  settings?: Record<string, unknown>;
  themes?: { custom: Array<Record<string, unknown>>; activeId?: string };
  bookmarks?: ProfileBundle['bookmarks'];
  keybindings?: Record<string, string>;
  savedSessions?: ProfileBundle['savedSessions'];
  workspaces?: ProfileBundle['workspaces'];
  reputation?: Record<string, number>;
  appVersion?: string;
}): ProfileBundle {
  const b: ProfileBundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    ...(input.appVersion ? { appVersion: input.appVersion.slice(0, 40) } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.bookmarks ? { bookmarks: stripNicknames(input.bookmarks) } : {}),
  };
  if (input.themes) b.themes = { custom: input.themes.custom, ...(input.themes.activeId ? { activeId: input.themes.activeId } : {}) };
  if (input.keybindings) b.keybindings = input.keybindings;
  if (input.savedSessions) b.savedSessions = input.savedSessions;
  if (input.workspaces) b.workspaces = input.workspaces;
  if (input.reputation) b.reputation = input.reputation;
  // validate our own output: if we cannot read what we just wrote, the export is wrong
  const r = ProfileBundleSchema.safeParse(b);
  if (!r.success) throw new Error(`bundle failed its own validation: ${r.error.issues[0]?.message}`);
  return r.data;
}

/** Remove nickname fields from a bookmark tree (the import/export rule, enforced on the way out too). */
export function stripNicknames(nodes: NonNullable<ProfileBundle['bookmarks']>): NonNullable<ProfileBundle['bookmarks']> {
  return nodes.map((n) => {
    const { nickname: _drop, ...rest } = n as Record<string, unknown>;
    if ('children' in n && Array.isArray((n as { children?: unknown[] }).children)) {
      return { ...rest, children: stripNicknames((n as { children: unknown[] }).children as NonNullable<ProfileBundle['bookmarks']>) } as (typeof nodes)[number];
    }
    return rest as (typeof nodes)[number];
  });
}

export type DryRun = {
  ok: boolean;
  error?: string;
  /** what WOULD change, in counts — shown to the user before they commit */
  summary: {
    settings: boolean;
    themes: number;
    bookmarks: number;
    keybindings: number;
    savedSessions: number;
    workspaces: number;
    reputation: number;
  };
};

/**
 * Validate a bundle without applying it. This is the dry-run the UI shows; it never throws and never
 * touches state, so it is safe to call on any string the user pastes.
 */
export function dryRun(text: string): DryRun {
  const empty = { settings: false, themes: 0, bookmarks: 0, keybindings: 0, savedSessions: 0, workspaces: 0, reputation: 0 };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty', summary: empty };
  if (text.length > MAX_BUNDLE_BYTES) return { ok: false, error: `larger than ${MAX_BUNDLE_BYTES} bytes`, summary: empty };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}`, summary: empty };
  }
  const r = ProfileBundleSchema.safeParse(parsed);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.join('.') || '(root)'}: ${i?.message}`, summary: empty };
  }
  const b = r.data;
  return {
    ok: true,
    summary: {
      settings: !!b.settings,
      themes: b.themes?.custom.length ?? 0,
      bookmarks: countNodes(b.bookmarks ?? []),
      keybindings: Object.keys(b.keybindings ?? {}).length,
      savedSessions: b.savedSessions?.length ?? 0,
      workspaces: b.workspaces?.length ?? 0,
      reputation: Object.keys(b.reputation ?? {}).length,
    },
  };
}

const countNodes = (nodes: unknown[]): number =>
  nodes.reduce<number>((n, x) => {
    if (!x || typeof x !== 'object') return n;
    const children = (x as { children?: unknown[] }).children;
    return n + 1 + (Array.isArray(children) ? countNodes(children) : 0);
  }, 0);

/**
 * Parse a bundle for import: validates as a whole and returns the typed value, or an error. Nothing
 * is applied here — the caller decides, which is what makes the dry run honest.
 */
export function parseBundle(text: string): { ok: true; bundle: ProfileBundle } | { ok: false; error: string } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' };
  if (text.length > MAX_BUNDLE_BYTES) return { ok: false, error: `larger than ${MAX_BUNDLE_BYTES} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const r = ProfileBundleSchema.safeParse(parsed);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.join('.') || '(root)'}: ${i?.message}` };
  }
  return { ok: true, bundle: r.data };
}

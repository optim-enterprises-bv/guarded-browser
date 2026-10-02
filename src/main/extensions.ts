// Unpacked extensions (ticket 32). The user's decision: build the narrow loader with a loud warning.
//
// WHAT IS ACTUALLY POSSIBLE (verified against the installed Electron 44.4.5 typings, not memory):
//  - only **unpacked** extensions. No `.crx`, no Chrome Web Store. Electron supports a subset of the
//    extension APIs and Web Store extensions are explicitly out of its scope.
//  - `loadExtension` must be called **on every boot**; extensions are **per session** and are NOT
//    remembered by Chromium. This module therefore keeps its own list of paths and reloads them.
//  - loading requires a **persistent** session (an ephemeral profile from ticket 29 cannot host one,
//    and this module refuses rather than silently failing).
//  - `ses.loadExtension` is **deprecated** as of Electron 43+ in favour of `ses.extensions.loadExtension`.
//    We prefer the new API and fall back to the old one, so this keeps working either way.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const MAX_EXTENSIONS = 20;

/**
 * THE WARNING. Shown in the settings UI next to the list, and returned by the IPC whenever the list
 * is read, so the UI cannot show the control without it. It is deliberately blunt: the honest
 * position is that an extension is not a small feature but a hole in the product's central claim.
 */
export const EXTENSION_WARNING =
  'An extension is arbitrary code running inside this browser. It can read the content of every page you open — including pages the agent never sees — and can make network requests that the policy engine does not know about (the egress filter still checks them). Extensions are OUTSIDE this browser\'s threat model: the post-task gate, taint tracking and the audit log do not constrain them. Only load unpacked extensions you wrote or have read.';

export const ExtensionEntrySchema = z
  .object({
    /** absolute path to the unpacked extension directory */
    path: z.string().min(1).max(4096),
    /** the name from the extension's own manifest, for display; never trusted for anything else */
    name: z.string().max(200),
    enabled: z.boolean(),
  })
  .strict();
export type ExtensionEntry = z.infer<typeof ExtensionEntrySchema>;

const FileSchema = z.object({ version: z.literal(1), entries: z.array(ExtensionEntrySchema).max(MAX_EXTENSIONS) }).strict();

function atomicWrite(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Read an unpacked extension's manifest just enough to describe it. Returns null when the path is
 * not an unpacked extension: the caller should not be able to add a path that will silently do
 * nothing at boot (which would look like "extensions don't work" rather than "that path is wrong").
 */
export function inspectExtension(dir: string): { ok: true; name: string; version: string; manifestVersion: number } | { ok: false; error: string } {
  try {
    if (!dir || !existsSync(dir)) return { ok: false, error: 'no such directory' };
    const st = statSync(dir);
    if (!st.isDirectory()) return { ok: false, error: 'not a directory (an unpacked extension is a folder)' };
    const mf = join(dir, 'manifest.json');
    if (!existsSync(mf)) return { ok: false, error: 'no manifest.json (this is not an unpacked extension)' };
    if (statSync(mf).size > 1024 * 1024) return { ok: false, error: 'manifest.json is implausibly large' };
    const m = JSON.parse(readFileSync(mf, 'utf8')) as Record<string, unknown>;
    if (!m || typeof m !== 'object') return { ok: false, error: 'manifest.json is not an object' };
    if (m.manifest_version !== 2 && m.manifest_version !== 3) return { ok: false, error: 'manifest_version must be 2 or 3' };
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 200) : '(unnamed extension)';
    const version = typeof m.version === 'string' ? m.version.slice(0, 50) : '';
    return { ok: true, name, version, manifestVersion: m.manifest_version };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

export class ExtensionList {
  private entries: ExtensionEntry[] = [];
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const r = FileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (r.success) this.entries = r.data.entries;
      else this.loadError = r.error.issues[0]?.message ?? 'invalid';
    } catch (e) {
      this.loadError = (e as Error).message;
    }
  }

  list(): ExtensionEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Add a path after checking it really is an unpacked extension. */
  add(dir: string): { ok: true; entry: ExtensionEntry } | { ok: false; error: string } {
    if (this.entries.length >= MAX_EXTENSIONS) return { ok: false, error: `at most ${MAX_EXTENSIONS} extensions` };
    if (this.entries.some((e) => e.path === dir)) return { ok: false, error: 'that path is already listed' };
    const i = inspectExtension(dir);
    if (!i.ok) return { ok: false, error: i.error };
    const entry: ExtensionEntry = { path: dir, name: i.name, enabled: true };
    this.entries = [...this.entries, entry];
    this.flush();
    return { ok: true, entry: { ...entry } };
  }

  setEnabled(dir: string, enabled: boolean): boolean {
    const e = this.entries.find((x) => x.path === dir);
    if (!e) return false;
    e.enabled = !!enabled;
    this.flush();
    return true;
  }

  remove(dir: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.path !== dir);
    if (this.entries.length === before) return false;
    this.flush();
    return true;
  }

  enabled(): ExtensionEntry[] {
    return this.entries.filter((e) => e.enabled).map((e) => ({ ...e }));
  }

  flush() {
    atomicWrite(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2) + '\n');
  }
}

/**
 * Load every enabled extension into a session. Called on boot for each profile.
 *
 * A failure to load one extension is reported and does NOT stop the others or the browser: a broken
 * extension path must not be able to prevent the product from starting.
 */
export async function loadExtensions(
  ses: {
    extensions?: { loadExtension: (p: string) => Promise<unknown> };
    loadExtension?: (p: string) => Promise<unknown>;
  },
  entries: ExtensionEntry[],
  opts: { persistentSession: boolean },
): Promise<Array<{ path: string; name: string; ok: boolean; error?: string }>> {
  const out: Array<{ path: string; name: string; ok: boolean; error?: string }> = [];
  if (!entries.length) return out;
  if (!opts.persistentSession) {
    // an ephemeral profile cannot host an extension; say so rather than appearing to load it
    return entries.map((e) => ({ path: e.path, name: e.name, ok: false, error: 'ephemeral profiles cannot load extensions (the session is not persistent)' }));
  }
  const load = ses.extensions?.loadExtension ?? ses.loadExtension;
  if (typeof load !== 'function') {
    return entries.map((e) => ({ path: e.path, name: e.name, ok: false, error: 'this Electron build exposes no loadExtension API' }));
  }
  const use = ses.extensions?.loadExtension ? load.bind(ses.extensions) : (load as (p: string) => Promise<unknown>).bind(ses);
  for (const e of entries) {
    try {
      const i = inspectExtension(e.path);
      if (!i.ok) {
        out.push({ path: e.path, name: e.name, ok: false, error: i.error });
        continue;
      }
      await use(e.path);
      out.push({ path: e.path, name: e.name, ok: true });
    } catch (err) {
      out.push({ path: e.path, name: e.name, ok: false, error: (err as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** The directory a profile keeps its extension list in. */
export function extensionListFile(profileDir: string): string {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  return join(profileDir, 'extensions.json');
}

// The one JSON-store primitive every per-profile file uses (bookmarks, history, settings, zoom, …).
//
// Writes: temp file + rename, mode 0600 by default, so a crash mid-write leaves the previous file
// intact and other local users cannot read the user's browsing data.
//
// Loads: a file that exists but does not parse or validate is RENAMED aside to
// `<file>.corrupt-<ISO timestamp>` before defaults are returned. Without that, the very next write
// of the (empty) defaults would silently replace the user's bookmarks or settings; quarantining
// keeps the original bytes for the user to recover, and `loadError` says where they went.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { z } from 'zod';

export interface AtomicWriteOptions {
  /** file mode of the written file (default 0o600) */
  mode?: number;
  /** fsync the temp file before the rename (default false) */
  fsync?: boolean;
}

/** Synchronous atomic write: `${path}.${pid}.${Date.now()}.tmp`, then rename over `path`. */
export function atomicWriteFile(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: opts.mode ?? 0o600 });
    if (opts.fsync) {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

let asyncSeq = 0;

/**
 * Asynchronous atomic write. `commit` is asked after the temp file is written and before the
 * rename: returning false discards the temp file (used so an older write never replaces a newer
 * file). Resolves to whether the file was replaced.
 */
export async function atomicWriteFileAsync(
  path: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions & { commit?: () => boolean } = {},
): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${Date.now()}-${++asyncSeq}.tmp`;
  try {
    await writeFile(tmp, data, { mode: opts.mode ?? 0o600, flush: !!opts.fsync });
    if (opts.commit && !opts.commit()) {
      await rm(tmp, { force: true });
      return false;
    }
    await rename(tmp, path);
    return true;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export interface LoadJsonOptions<T> {
  /** what to return when the file is missing or unusable */
  fallback: T;
  /** extra validation after the schema: a message when the value must be rejected, else null */
  check?: (value: T) => string | null;
}

export interface LoadJsonResult<T> {
  value: T;
  /**
   * null when the file was missing or loaded fine. Otherwise a one-line, user-facing sentence naming
   * the file and where its contents were kept (or why they could not be moved aside).
   */
  loadError: string | null;
  /** where the unusable file was moved, when it was */
  quarantinedTo: string | null;
}

/** Read and validate a JSON file; quarantine it (never overwrite it) when it is unusable. */
export function loadJson<T>(path: string, schema: z.ZodType<T>, opts: LoadJsonOptions<T>): LoadJsonResult<T> {
  if (!existsSync(path)) return { value: opts.fallback, loadError: null, quarantinedTo: null };
  let reason: string;
  try {
    const r = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (r.success) {
      const bad = opts.check?.(r.data) ?? null;
      if (bad === null) return { value: r.data, loadError: null, quarantinedTo: null };
      reason = bad;
    } else reason = r.error.issues[0]?.message ?? 'invalid';
  } catch (e) {
    reason = (e as Error).message;
  }
  reason = reason.slice(0, 200);
  const name = basename(path);
  const aside = `${path}.corrupt-${new Date().toISOString()}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    return {
      value: opts.fallback,
      loadError: `${name} was unreadable (${reason}) and could not be moved aside (${(e as Error).message}); it was ignored`,
      quarantinedTo: null,
    };
  }
  return { value: opts.fallback, loadError: `${name} was unreadable (${reason}) and has been kept as ${basename(aside)}`, quarantinedTo: aside };
}

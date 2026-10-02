// Saved sessions (ticket 22): named, reusable tab sets the user creates deliberately, distinct from
// ticket 03's automatic "last session".
//
// SECURITY (rule 2): a saved session stores URLs and titles and NOTHING else. Restoring one creates
// NEW tabs, exactly like reopen (02) and restore (03), so a restored tab starts clean. There is no
// field for gate state, the agent-tab marker, taint or origins, and the schema is `.strict()` so a
// hand-edited file carrying one is rejected rather than obeyed.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { restorable } from './session-state';

export const MAX_SESSIONS = 100;
export const MAX_TABS_PER_SESSION = 50;
export const MAX_NAME = 80;
/** alias kept for callers that use the session-state naming */
export const MAX_SESSION_TABS = MAX_TABS_PER_SESSION;

const TabSchema = z
  .object({
    url: z.string().max(2048),
    title: z.string().max(200),
  })
  .strict();

export const SavedSessionSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().min(1).max(MAX_NAME),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    tabs: z.array(TabSchema).max(MAX_TABS_PER_SESSION),
  })
  .strict();
export type SavedSession = z.infer<typeof SavedSessionSchema>;

const FileSchema = z
  .object({
    version: z.literal(1),
    sessions: z.array(SavedSessionSchema).max(MAX_SESSIONS),
  })
  .strict();

export const MAX_SESSION_NAME_LENGTH = MAX_NAME;

/** Strip control characters and collapse whitespace in a user-supplied name. */
export const cleanName = (n: string) =>
  String(n)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);

function atomicWrite(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class SavedSessionStore {
  private data: z.infer<typeof FileSchema> = { version: 1, sessions: [] };
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const r = FileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (r.success) this.data = r.data;
      else this.loadError = r.error.issues[0]?.message ?? 'invalid';
    } catch (e) {
      this.loadError = (e as Error).message;
    }
  }

  list(): SavedSession[] {
    return this.data.sessions.map((s) => ({ ...s }));
  }

  get(id: string): SavedSession | null {
    return this.data.sessions.find((s) => s.id === id) ?? null;
  }

  /**
   * Save the given tabs under a name. Saving an existing name REPLACES that session (a save is
   * "this is what that session is now"), which is what the user expects from a Save button.
   */
  save(name: string, tabs: Array<{ url: string; title: string }>): { ok: true; session: SavedSession } | { ok: false; error: string } {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'a session needs a name' };
    const kept = tabs
      .filter((t) => restorable(t.url))
      .slice(0, MAX_TABS_PER_SESSION)
      .map((t) => ({ url: t.url, title: String(t.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) }));
    if (!kept.length) return { ok: false, error: 'no restorable tabs to save' };
    const now = Date.now();
    const existing = this.data.sessions.find((s) => s.name === clean);
    let session: SavedSession;
    if (existing) {
      session = { ...existing, tabs: kept, updatedAt: now };
      this.data.sessions = this.data.sessions.map((s) => (s.id === existing.id ? session : s));
    } else {
      if (this.data.sessions.length >= MAX_SESSIONS) return { ok: false, error: `at most ${MAX_SESSIONS} saved sessions` };
      session = { id: `s${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, name: clean, createdAt: now, updatedAt: now, tabs: kept };
      this.data.sessions = [...this.data.sessions, session];
    }
    this.flush();
    return { ok: true, session: { ...session } };
  }

  rename(id: string, name: string): boolean {
    const clean = cleanName(name);
    if (!clean) return false;
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s) return false;
    if (this.data.sessions.some((x) => x.id !== id && x.name === clean)) return false;
    s.name = clean;
    s.updatedAt = Date.now();
    this.flush();
    return true;
  }

  remove(id: string): boolean {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.sessions.length === before) return false;
    this.flush();
    return true;
  }

  /** The session's restorable tabs, with non-web URLs dropped (same rule as session restore). */
  restorableTabs(id: string): Array<{ url: string; title: string }> {
    const s = this.get(id);
    if (!s) return [];
    return s.tabs.filter((t) => restorable(t.url)).map((t) => ({ ...t }));
  }

  toJson(): string {
    return JSON.stringify(this.data, null, 2) + '\n';
  }

  /** Import from a JSON string, replacing everything only if it validates. */
  importJson(text: string): { ok: true; count: number } | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(text).slice(0, 5_000_000));
    } catch (e) {
      return { ok: false, error: `not JSON: ${(e as Error).message}` };
    }
    const r = FileSchema.safeParse(parsed);
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    // only restorable tabs survive an import, and the name is cleaned
    const sessions = r.data.sessions
      .map((s) => ({
        ...s,
        name: cleanName(s.name),
        tabs: s.tabs.filter((t) => restorable(t.url)),
      }))
      .filter((s) => s.name && s.tabs.length);
    if (!sessions.length) return { ok: false, error: 'no sessions with restorable tabs' };
    this.data = { version: 1, sessions: sessions.slice(0, MAX_SESSIONS) };
    this.flush();
    return { ok: true, count: sessions.length };
  }

  flush() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
}

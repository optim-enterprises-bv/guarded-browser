// Per-profile browsing history (profiles/<id>/history.json). Visits are private data: nothing in
// the agent (planner / reader / judge) ever reads this module. Titles are page-controlled and are
// stored length-capped and rendered as text only.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';

export const MAX_VISITS = 20_000;
export const MAX_TITLE = 200;
export const MAX_URL = 2048;
/** per origin: at most this many recorded visits per minute; extra ones are coalesced */
export const MAX_VISITS_PER_ORIGIN_PER_MIN = 30;

export type VisitSource = 'user' | 'page' | 'agent';

const VisitSchema = z
  .object({
    url: z.string().max(MAX_URL),
    title: z.string().max(MAX_TITLE),
    t: z.number().int().nonnegative(),
    source: z.enum(['user', 'page', 'agent']),
  })
  .strict();
export type Visit = z.infer<typeof VisitSchema>;

const FileSchema = z
  .object({
    version: z.literal(1),
    clearOnExit: z.boolean(),
    visits: z.array(VisitSchema).max(MAX_VISITS),
  })
  .strict();

/** Only real web pages are recorded: http(s), not the interstitial / internal / data: / blob: pages. */
export function recordable(url: string): boolean {
  if (url.length > MAX_URL) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== 'guarded-browser.invalid';
  } catch {
    return false;
  }
}

export const cleanTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

export interface HistoryEntry {
  url: string;
  title: string;
  lastVisit: number;
  visits: number;
  sources: VisitSource[];
}

export interface DayGroup {
  day: string; // YYYY-MM-DD, local time
  entries: HistoryEntry[];
}

export class HistoryStore {
  private data: z.infer<typeof FileSchema> = { version: 1, clearOnExit: false, visits: [] };
  private timer: NodeJS.Timeout | null = null;
  /** set when the file on disk was invalid and was replaced (reported by the caller) */
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const r = FileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (r.success) this.data = r.data;
        else this.loadError = r.error.issues[0]?.message ?? 'invalid';
        // "clear on exit" must hold after a crash too: clear at load if the last exit did not
        if (this.data.clearOnExit && this.data.visits.length) {
          this.data.visits = [];
          this.flush();
        }
      } catch (e) {
        this.loadError = (e as Error).message;
      }
    }
  }

  get clearOnExit() {
    return this.data.clearOnExit;
  }

  setClearOnExit(on: boolean) {
    this.data.clearOnExit = !!on;
    this.flush();
  }

  private recent = new Map<string, number[]>();

  /**
   * Record one top-level visit. Returns false when the URL is not recordable. A page navigating
   * itself in a loop cannot flood history and evict real entries: beyond
   * MAX_VISITS_PER_ORIGIN_PER_MIN visits per origin and minute, visits are coalesced (not stored).
   */
  record(url: string, title: string, source: VisitSource, t = Date.now()): boolean {
    if (!recordable(url)) return false;
    const origin = new URL(url).origin;
    const times = (this.recent.get(origin) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= MAX_VISITS_PER_ORIGIN_PER_MIN) {
      this.recent.set(origin, times);
      return false;
    }
    times.push(t);
    this.recent.set(origin, times);
    if (this.recent.size > 1000) this.recent.delete(this.recent.keys().next().value!);
    this.data.visits.push({ url, title: cleanTitle(title), t, source });
    if (this.data.visits.length > MAX_VISITS) this.data.visits.splice(0, this.data.visits.length - MAX_VISITS);
    this.save();
    return true;
  }

  /** The page title often arrives after the navigation: update the latest visit of that URL. */
  updateTitle(url: string, title: string) {
    for (let i = this.data.visits.length - 1; i >= 0 && i >= this.data.visits.length - 50; i--) {
      if (this.data.visits[i].url === url) {
        this.data.visits[i].title = cleanTitle(title);
        this.save();
        return;
      }
    }
  }

  visits(): Visit[] {
    return this.data.visits.map((v) => ({ ...v }));
  }

  /** Entries grouped by local day (newest first), optionally filtered by text and source. */
  grouped(query = '', source?: VisitSource, limit = 2000): DayGroup[] {
    const q = query.trim().toLowerCase();
    const days = new Map<string, Map<string, HistoryEntry>>();
    let n = 0;
    for (let i = this.data.visits.length - 1; i >= 0 && n < limit; i--) {
      const v = this.data.visits[i];
      if (source && v.source !== source) continue;
      if (q && !v.url.toLowerCase().includes(q) && !v.title.toLowerCase().includes(q)) continue;
      const d = new Date(v.t);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let m = days.get(day);
      if (!m) days.set(day, (m = new Map()));
      const e = m.get(v.url);
      if (e) {
        e.visits++;
        if (!e.sources.includes(v.source)) e.sources.push(v.source);
        if (!e.title && v.title) e.title = v.title;
      } else {
        m.set(v.url, { url: v.url, title: v.title, lastVisit: v.t, visits: 1, sources: [v.source] });
        n++;
      }
    }
    return [...days.entries()].map(([day, m]) => ({ day, entries: [...m.values()] }));
  }

  /** Best matches for the address bar (by url / title, most visited first). */
  suggest(query: string, max = 5): HistoryEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const by = new Map<string, HistoryEntry>();
    for (const v of this.data.visits) {
      if (!v.url.toLowerCase().includes(q) && !v.title.toLowerCase().includes(q)) continue;
      const e = by.get(v.url);
      if (e) {
        e.visits++;
        e.lastVisit = Math.max(e.lastVisit, v.t);
        if (v.title) e.title = v.title;
      } else by.set(v.url, { url: v.url, title: v.title, lastVisit: v.t, visits: 1, sources: [v.source] });
    }
    return [...by.values()].sort((a, b) => b.visits - a.visits || b.lastVisit - a.lastVisit).slice(0, max);
  }

  deleteUrl(url: string): number {
    const before = this.data.visits.length;
    this.data.visits = this.data.visits.filter((v) => v.url !== url);
    this.flush();
    return before - this.data.visits.length;
  }

  /** Delete visits newer than `sinceMs` ago ('all' = everything). */
  deleteRange(range: 'hour' | 'day' | 'week' | 'all', now = Date.now()): number {
    const span = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, all: Number.POSITIVE_INFINITY }[range];
    const before = this.data.visits.length;
    this.data.visits = this.data.visits.filter((v) => now - v.t > span);
    this.flush();
    return before - this.data.visits.length;
  }

  clear() {
    this.data.visits = [];
    this.flush();
  }

  private writing: Promise<void> = Promise.resolve();
  /** bumped by every write; an older asynchronous write never replaces a newer file */
  private gen = 0;

  /** Debounced, asynchronous atomic write: recording never blocks the main thread on disk I/O. */
  private save() {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const json = JSON.stringify(this.data);
      const mine = ++this.gen;
      const tmp = `${this.file}.tmp-${process.pid}-a${mine}`;
      this.writing = this.writing
        .then(() => writeFile(tmp, json, { mode: 0o600 }))
        .then(() => (mine === this.gen ? rename(tmp, this.file) : rm(tmp, { force: true })))
        .catch(() => undefined);
    }, 2000);
  }

  /** Synchronous atomic write (temp file + rename, 0600): used for deletes and at exit. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.gen++;
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Wait for pending asynchronous writes (tests / shutdown). */
  async settled() {
    await this.writing;
  }
}

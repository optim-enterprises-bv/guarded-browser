// Watchers (AI capabilities item 5): standing READ-ONLY checks — "tell me when this price drops below
// X", "tell me when this page changes". A watcher is a list of URLs to open (a single URL, or the
// navigations of a read-only recipe), one typed extraction on the last page (a number, a hash of an
// element's text, or the element's text) located with a recorded locator, a condition and a schedule.
//
// Read-only by construction: the schema has no field that could hold a click, a typed value or a
// submit, and a recipe with any state-changing step is refused (watcherFromRecipe). Runs never use a
// model. Pure: the runtime (src/main/runtime/watchers.ts) owns timers, sessions and notifications.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocatorSchema, PageExpectSchema, type ElementLocator, type PageExpect } from './locator';
import { atomicWriteFile, loadJson } from './persist';
import { originOf } from './policy';
import { cleanName, isReadOnly, type Recipe } from './recipe';

export const WATCH_LIMITS = { watchers: 50, history: 20, minEveryMinutes: 5, maxEveryMinutes: 7 * 24 * 60, urls: 5, contains: 200, error: 300, maxBackoffMs: 24 * 60 * 60_000 } as const;

const HttpUrlSchema = z
  .string()
  .max(2048)
  .refine((u) => !!originOf(u), 'must be an http(s) URL');

export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('below'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('above'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('changes') }).strict(),
  z.object({ kind: z.literal('contains'), text: z.string().min(1).max(WATCH_LIMITS.contains) }).strict(),
]);
export type WatchCondition = z.infer<typeof ConditionSchema>;

export const WatcherConfigSchema = z
  .object({
    name: z.string().min(1).max(80),
    urls: z.array(HttpUrlSchema).min(1).max(WATCH_LIMITS.urls),
    /** the recipe it was made from, if any (display only: the steps are copied into `urls`) */
    recipeId: z.string().max(64).optional(),
    /** the extraction page's landmarks when it was picked / recorded */
    expect: PageExpectSchema.optional(),
    locator: LocatorSchema,
    kind: z.enum(['number', 'text-hash', 'element-text']),
    condition: ConditionSchema,
    everyMinutes: z.number().int().min(WATCH_LIMITS.minEveryMinutes).max(WATCH_LIMITS.maxEveryMinutes),
    notify: z.object({ desktop: z.boolean(), telegram: z.boolean() }).strict(),
    /** copy this profile's cookies for the watcher's origins into its throwaway session (warned in the UI) */
    useLogin: z.boolean(),
    paused: z.boolean(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if ((w.condition.kind === 'below' || w.condition.kind === 'above') && w.kind !== 'number') ctx.addIssue({ code: 'custom', message: 'below / above need a number extraction' });
    if (w.condition.kind === 'contains' && w.kind !== 'element-text') ctx.addIssue({ code: 'custom', message: '"contains" needs an element-text extraction' });
  });
export type WatcherConfig = z.infer<typeof WatcherConfigSchema>;

export const HistoryEntrySchema = z
  .object({
    at: z.number().int().nonnegative(),
    value: z.union([z.number(), z.string().max(200), z.null()]),
    met: z.boolean(),
    notified: z.boolean(),
    error: z.string().max(WATCH_LIMITS.error).optional(),
    runner: z.string().max(20),
  })
  .strict();
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

const StateSchema = z
  .object({
    nextRunAt: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    lastValue: z.union([z.number(), z.string().max(200), z.null()]),
    lastMet: z.boolean(),
    history: z.array(HistoryEntrySchema).max(WATCH_LIMITS.history),
  })
  .strict();
export type WatcherState = z.infer<typeof StateSchema>;

export const WatcherSchema = z.object({ id: z.string().regex(/^[a-z0-9-]{8,64}$/), config: WatcherConfigSchema, state: StateSchema }).strict();
export type Watcher = z.infer<typeof WatcherSchema>;

/** The origins a run may reach: the URLs' origins (the run's egress allowlist). */
export const watcherOrigins = (c: Pick<WatcherConfig, 'urls'>) => [...new Set(c.urls.map((u) => originOf(u)!).filter(Boolean))];

/** A watcher's URLs from a recipe — refused unless every step only navigates or extracts. */
export function watcherFromRecipe(r: Recipe, extractStep?: number): { ok: true; urls: string[]; locator: ElementLocator; expect: PageExpect; field: string; type: string } | { ok: false; error: string } {
  if (!isReadOnly(r)) return { ok: false, error: 'this recipe changes something (it clicks, types or submits): a watcher may only open pages and read a value' };
  if (r.params.length) return { ok: false, error: 'this recipe has parameters: a watcher cannot ask for values' };
  const extracts = r.steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'extract');
  const pick = extractStep === undefined ? extracts[0] : extracts.find((x) => x.i === extractStep);
  if (!pick || pick.s.kind !== 'extract') return { ok: false, error: 'the recipe reads no value (it has no extract step)' };
  // only the navigations before the chosen extract matter: a watcher opens them in order and reads on the last page
  const urls = r.steps.slice(0, pick.i).flatMap((s) => (s.kind === 'navigate' ? [s.url] : []));
  if (!urls.length) return { ok: false, error: 'the recipe opens no page before reading' };
  return { ok: true, urls: urls.slice(-WATCH_LIMITS.urls), locator: pick.s.locator, expect: pick.s.at, field: pick.s.field, type: pick.s.type };
}

// ------------------------------------------------------------------ conditions

/** Is the condition met by this value (prev = the previous run's value, null on the first run)? */
export function evaluateCondition(c: WatchCondition, value: number | string | null, prev: number | string | null): boolean {
  if (value === null) return false;
  switch (c.kind) {
    case 'below':
      return typeof value === 'number' && value < c.value;
    case 'above':
      return typeof value === 'number' && value > c.value;
    case 'changes':
      return prev !== null && value !== prev;
    case 'contains':
      return typeof value === 'string' && value.toLowerCase().includes(c.text.toLowerCase());
  }
}

/** Notify when the condition becomes met, or stays met with a different value; "changes" every time it changes. */
export function shouldNotify(c: WatchCondition, met: boolean, value: number | string | null, prev: { met: boolean; value: number | string | null }): boolean {
  if (!met) return false;
  if (c.kind === 'changes') return true;
  return !prev.met || prev.value !== value;
}

export function describeCondition(c: WatchCondition): string {
  switch (c.kind) {
    case 'below':
      return `below ${c.value}`;
    case 'above':
      return `above ${c.value}`;
    case 'changes':
      return 'changes';
    case 'contains':
      return `contains “${c.text}”`;
  }
}

/** The notification text. Page TEXT is never put in it: numbers are, text kinds say "changed". */
export function notificationText(w: Pick<Watcher, 'config'>, value: number | string | null): { title: string; body: string } {
  const c = w.config;
  const what = c.kind === 'number' && typeof value === 'number' ? `is now ${value}` : c.condition.kind === 'contains' ? `now contains “${c.condition.text}”` : 'changed';
  const host = (() => {
    try {
      return new URL(c.urls[c.urls.length - 1]).host;
    } catch {
      return '';
    }
  })();
  return { title: `Watcher “${c.name}”`, body: `${host}: the watched value ${what}${c.kind === 'number' && c.condition.kind !== 'changes' ? ` (${describeCondition(c.condition)})` : ''}.` };
}

// ------------------------------------------------------------------ schedule

/** Delay after a failure: the interval doubled per consecutive failure, capped at a day. */
export function backoffMs(everyMinutes: number, failures: number): number {
  return Math.min(everyMinutes * 60_000 * 2 ** Math.min(Math.max(failures, 0), 10), Math.max(WATCH_LIMITS.maxBackoffMs, everyMinutes * 60_000));
}

/** The state after a run. */
export function afterRun(w: Watcher, entry: HistoryEntry, now: number): WatcherState {
  const ok = !entry.error;
  const failures = ok ? 0 : w.state.failures + 1;
  return {
    nextRunAt: now + (ok ? w.config.everyMinutes * 60_000 : backoffMs(w.config.everyMinutes, failures)),
    failures,
    lastValue: ok ? entry.value : w.state.lastValue,
    lastMet: ok ? entry.met : w.state.lastMet,
    history: [...w.state.history, entry].slice(-WATCH_LIMITS.history),
  };
}

export interface SchedulerOptions {
  list(): Watcher[];
  /** null when a run may start, else why not (a task, a pending confirmation, another run) */
  blocker(): string | null;
  run(w: Watcher): Promise<void>;
  now?: () => number;
  tickMs: number;
}

/** One run at a time, only when nothing blocks; due = not paused and nextRunAt reached. */
export class WatcherScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly o: SchedulerOptions) {}

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.o.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.busy;
  }

  due(now = (this.o.now ?? Date.now)()): Watcher[] {
    return this.o
      .list()
      .filter((w) => !w.config.paused && w.state.nextRunAt <= now)
      .sort((a, b) => a.state.nextRunAt - b.state.nextRunAt);
  }

  /** Run the most overdue watcher if nothing blocks. Returns what ran, or why nothing did. */
  async tick(): Promise<{ ran: string } | { waiting: string } | null> {
    if (this.busy) return { waiting: 'a watcher is running' };
    const w = this.due()[0];
    if (!w) return null;
    const b = this.o.blocker();
    if (b) return { waiting: b };
    this.busy = true;
    try {
      await this.o.run(w);
    } finally {
      this.busy = false;
    }
    return { ran: w.id };
  }
}

// ------------------------------------------------------------------ store

const FileSchema = z.object({ version: z.literal(1), watchers: z.array(WatcherSchema).max(WATCH_LIMITS.watchers) }).strict();

export class WatcherStore {
  private data: z.infer<typeof FileSchema> = { version: 1, watchers: [] };
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    const r = loadJson(file, FileSchema, { fallback: this.data });
    this.data = r.value;
    this.loadError = r.loadError;
  }

  private save() {
    atomicWriteFile(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
  }

  list(): Watcher[] {
    return this.data.watchers.map((w) => structuredClone(w));
  }

  get(id: string): Watcher | null {
    const w = this.data.watchers.find((x) => x.id === id);
    return w ? structuredClone(w) : null;
  }

  create(raw: unknown, now = Date.now()): { ok: true; watcher: Watcher } | { ok: false; error: string } {
    const c = WatcherConfigSchema.safeParse(raw && typeof raw === 'object' ? { ...(raw as object), name: cleanName((raw as { name?: unknown }).name) } : raw);
    if (!c.success) return { ok: false, error: c.error.issues.map((i) => `${i.path.join('.') || 'watcher'}: ${i.message}`).join('; ').slice(0, 300) };
    if (this.data.watchers.length >= WATCH_LIMITS.watchers) return { ok: false, error: `at most ${WATCH_LIMITS.watchers} watchers` };
    const w: Watcher = { id: randomUUID(), config: c.data, state: { nextRunAt: now + c.data.everyMinutes * 60_000, failures: 0, lastValue: null, lastMet: false, history: [] } };
    this.data.watchers.push(w);
    this.save();
    return { ok: true, watcher: structuredClone(w) };
  }

  /** Change config fields (paused, name, schedule, condition, notify, useLogin); re-validated whole. */
  update(id: string, patch: Record<string, unknown>): { ok: true; watcher: Watcher } | { ok: false; error: string } {
    const w = this.data.watchers.find((x) => x.id === id);
    if (!w) return { ok: false, error: 'no such watcher' };
    const allowed = ['paused', 'name', 'everyMinutes', 'condition', 'notify', 'useLogin'];
    const next = { ...w.config };
    for (const [k, v] of Object.entries(patch ?? {})) if (allowed.includes(k)) (next as Record<string, unknown>)[k] = k === 'name' ? cleanName(v) : v;
    const c = WatcherConfigSchema.safeParse(next);
    if (!c.success) return { ok: false, error: c.error.issues.map((i) => `${i.path.join('.') || 'watcher'}: ${i.message}`).join('; ').slice(0, 300) };
    const resumed = w.config.paused && !c.data.paused;
    w.config = c.data;
    if (resumed) w.state.failures = 0;
    this.save();
    return { ok: true, watcher: structuredClone(w) };
  }

  remove(id: string): boolean {
    const n = this.data.watchers.length;
    this.data.watchers = this.data.watchers.filter((x) => x.id !== id);
    if (n === this.data.watchers.length) return false;
    this.save();
    return true;
  }

  /** "Run now": due immediately (still only when nothing blocks). */
  runSoon(id: string, now = Date.now()): boolean {
    const w = this.data.watchers.find((x) => x.id === id);
    if (!w) return false;
    w.state.nextRunAt = now;
    this.save();
    return true;
  }

  record(id: string, entry: HistoryEntry, now = Date.now()): Watcher | null {
    const w = this.data.watchers.find((x) => x.id === id);
    if (!w) return null;
    w.state = afterRun(w, HistoryEntrySchema.parse(entry), now);
    this.save();
    return structuredClone(w);
  }
}

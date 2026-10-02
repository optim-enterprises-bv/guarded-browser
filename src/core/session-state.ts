// Session state (profiles/<id>/session.json): which tabs were open, which was active, and the
// split-view arrangement — so a profile can "start where you left off".
//
// SECURITY — this file holds URLs, titles, selection, tiling and one dirty-exit flag, and NOTHING
// ELSE. There is deliberately no field for gate state, the agent-tab marker, origins or taint, so
// a restored tab cannot inherit them: restore constructs NEW tabs (new tab ids, absent from
// TabGuardBook), which is the whole reason this is safe. A restored tab is a fresh document at an
// old URL.
//
// Like history.json this is chrome-side private data: the agent never gets a reference to it.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export const MAX_TABS = 50;
export const MAX_URL = 2048;
export const MAX_TITLE = 200;

const RestoredTabSchema = z
  .object({
    url: z.string().max(MAX_URL),
    title: z.string().max(MAX_TITLE),
  })
  .strict();
export type RestoredTab = z.infer<typeof RestoredTabSchema>;

const FileSchema = z
  .object({
    version: z.literal(1),
    /** written false while running and true on a clean quit: false at load means the last exit crashed */
    clean: z.boolean(),
    activeIndex: z.number().int().nonnegative(),
    tabs: z.array(RestoredTabSchema).max(MAX_TABS),
    /** the tile set (tab indexes + layout + ratios), or null when not tiled */
    tiles: z
      .object({
        indexes: z.array(z.number().int().nonnegative()).min(2).max(4),
        layout: z.enum(['columns', 'rows', 'grid']),
        ratios: z.array(z.number().min(0.05).max(0.95)).max(4),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type SessionState = z.infer<typeof FileSchema>;

/** A restored tab must be a real web page: no about:blank, no internal interstitial, no data:/blob:. */
export function restorable(url: string): boolean {
  if (!url || url.length > MAX_URL) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname !== 'guarded-browser.invalid';
  } catch {
    return false;
  }
}

const cleanTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

/** Same idiom as profiles.ts: 0600, temp file + rename, never a partial write. */
function atomicWrite(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class SessionStore {
  private data: SessionState = { version: 1, clean: true, activeIndex: 0, tabs: [], tiles: null };
  private timer: NodeJS.Timeout | null = null;
  private pending: SessionState | null = null;
  readonly loadError: string | null = null;
  /** true when the last exit did not finish cleanly (the file says clean:false) */
  readonly crashed: boolean = false;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const r = FileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (r.success) {
        this.data = r.data;
        this.crashed = !r.data.clean;
      } else this.loadError = r.error.issues[0]?.message ?? 'invalid';
    } catch (e) {
      this.loadError = (e as Error).message;
    }
  }

  /** What to restore: only restorable URLs, with the indices remapped. */
  restorableTabs(): { tabs: RestoredTab[]; activeIndex: number } {
    const keep: number[] = [];
    const tabs: RestoredTab[] = [];
    this.data.tabs.forEach((t, i) => {
      if (!restorable(t.url)) return;
      keep.push(i);
      tabs.push({ url: t.url, title: cleanTitle(t.title) });
    });
    const remapped = keep.indexOf(this.data.activeIndex);
    return { tabs, activeIndex: remapped >= 0 ? remapped : 0 };
  }

  /** The tile set as indexes into the *returned* array, or null when it no longer fits. */
  restorableTiles(tabs: RestoredTab[]): { ids: number[]; indexes: number[]; layout: 'columns' | 'rows' | 'grid'; ratios: number[] } | null {
    const t = this.data.tiles;
    if (!t) return null;
    const src = this.data.tabs;
    const kept = src.filter((x) => restorable(x.url));
    const map = new Map<number, number>();
    kept.forEach((k, i) => map.set(src.indexOf(k), i));
    const indexes = t.indexes.map((i) => map.get(i)).filter((i): i is number => i !== undefined && i < tabs.length);
    if (indexes.length < 2) return null;
    return { ids: [], indexes, layout: t.layout, ratios: t.ratios.slice(0, indexes.length) };
  }

  /**
   * Save the current session. Called on change (debounced) and on quit. `clean` is false while the
   * app runs, so an unclean exit is detectable at the next launch.
   */
  save(tabs: Array<{ url: string; title: string }>, activeIndex: number, tiles: SessionState['tiles'], clean: boolean) {
    const kept = tabs
      .filter((t) => restorable(t.url))
      .slice(0, MAX_TABS)
      .map((t) => ({ url: t.url, title: cleanTitle(t.title) }));
    this.data = {
      version: 1,
      clean,
      activeIndex: Math.max(0, Math.min(activeIndex, Math.max(0, kept.length - 1))),
      tabs: kept,
      // tiling is only meaningful when every id it names survived the URL filter
      tiles: tiles && kept.length >= 2 ? tiles : null,
    };
    this.flush();
  }

  /** Debounced save (a page title change must not cause a write per keystroke). */
  saveSoon(tabs: Array<{ url: string; title: string }>, activeIndex: number, tiles: SessionState['tiles'], clean: boolean, delayMs = 1000) {
    this.pending = { version: 1, clean, activeIndex, tabs: tabs.map((t) => ({ url: t.url, title: cleanTitle(t.title) })), tiles };
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const p = this.pending;
      this.pending = null;
      if (p) {
        this.data = p;
        this.flush();
      }
    }, delayMs);
    this.timer.unref?.();
  }

  get hasSession() {
    return this.data.tabs.some((t) => restorable(t.url));
  }

  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.data = { version: 1, clean: true, activeIndex: 0, tabs: [], tiles: null };
    this.flush();
  }

  flush() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
}

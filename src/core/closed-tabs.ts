// The closed-tab stack (profiles/<id>/closed-tabs.json). Chrome-side private data: the agent
// (planner / reader / judge) never gets a reference to this module.
//
// SECURITY — this file holds a URL, a title, a position and a timestamp, and NOTHING ELSE.
// Gate state, the agent-tab marker and taint are deliberately not representable here, so a
// reopened tab cannot inherit them: reopening builds a NEW tab (a new tab id), which is absent
// from TabGuardBook and therefore ungated, and whose worker-origin set is empty. A reopened tab
// is a fresh document that happens to sit at an old URL — never a resurrection of the previous
// document's security state.

import { z } from 'zod';
import { atomicWriteFile, loadJson } from './persist';

/** Bounded per profile, newest last. Old entries fall off the bottom. */
export const MAX_CLOSED = 25;
export const MAX_URL = 2048;
export const MAX_TITLE = 200;

const EntrySchema = z
  .object({
    url: z.string().max(MAX_URL),
    title: z.string().max(MAX_TITLE),
    /** 0-based index the tab occupied in the strip when it was closed */
    pos: z.number().int().nonnegative(),
    t: z.number().int().nonnegative(),
  })
  .strict();
export type ClosedTab = z.infer<typeof EntrySchema>;

const FileSchema = z
  .object({
    version: z.literal(1),
    tabs: z.array(EntrySchema).max(MAX_CLOSED),
  })
  .strict();

/**
 * Only real web pages are worth reopening. `about:blank`, the reputation interstitial / proceed
 * page (guarded-browser.invalid) and data:/blob: documents are not: reopening one would give the
 * user a blank tab or a forged internal page they never had.
 */
export function reopenable(url: string): boolean {
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


export class ClosedTabStore {
  private data: z.infer<typeof FileSchema> = { version: 1, tabs: [] };
  /** set when the file on disk was invalid and was ignored (reported by the caller) */
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    const r = loadJson(file, FileSchema, { fallback: this.data });
    this.data = r.value;
    this.loadError = r.loadError;
  }

  /** Record a closed tab. Non-reopenable URLs and `about:blank` are ignored. */
  push(url: string, title: string, pos: number, t = Date.now()): boolean {
    if (!reopenable(url)) return false;
    this.data.tabs.push({ url, title: cleanTitle(title), pos: Math.max(0, Math.round(pos)), t });
    if (this.data.tabs.length > MAX_CLOSED) this.data.tabs.splice(0, this.data.tabs.length - MAX_CLOSED);
    this.flush();
    return true;
  }

  /** The tab Ctrl+Shift+T would reopen, without removing it. */
  peek(): ClosedTab | undefined {
    const e = this.data.tabs.at(-1);
    return e ? { ...e } : undefined;
  }

  /**
   * Take the most recently closed tab off the stack (LIFO, like every browser's reopen).
   * Returns undefined when there is nothing to reopen.
   */
  pop(): ClosedTab | undefined {
    const e = this.data.tabs.pop();
    if (!e) return undefined;
    this.flush();
    return { ...e };
  }

  /** Newest first, for a menu. */
  list(): ClosedTab[] {
    return this.data.tabs.map((e) => ({ ...e })).reverse();
  }

  get size() {
    return this.data.tabs.length;
  }

  clear() {
    this.data.tabs = [];
    this.flush();
  }

  flush() {
    atomicWriteFile(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
}

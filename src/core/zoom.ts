// Per-origin zoom (profiles/<id>/zoom.json). A view property of the chrome, private to the
// profile: the agent never reads it and zoom never changes what a snapshot reports.
//
// Why per-origin: zooming a site should stick for that site and not leak onto the next one. The
// store is keyed on origin, so navigating within an origin keeps the zoom and leaving it resets to
// 100% (Vivaldi's behaviour).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/** Chromium's own limits: outside this, pages become unusable. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const FileSchema = z
  .object({
    version: z.literal(1),
    // origin -> factor. Origins are strings from the browser, never page-supplied HTML.
    origins: z.record(z.string().max(2048), z.number().min(MIN_ZOOM).max(MAX_ZOOM)),
  })
  .strict();

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1));

/** The next step up/down from the current factor, so Ctrl+= walks the same ladder as the menu. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const c = clampZoom(current);
  if (dir === 1) return ZOOM_STEPS.find((s) => s > c + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < c - 1e-6) ?? MIN_ZOOM;
}

function atomicWrite(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class ZoomStore {
  private data: z.infer<typeof FileSchema> = { version: 1, origins: {} };
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

  /** The remembered factor for an origin, or 1 (100%) when none. */
  get(origin: string): number {
    const v = this.data.origins[origin];
    return v === undefined ? 1 : clampZoom(v);
  }

  /** Remember a factor. 1 is stored as "no entry", so the file does not fill with defaults. */
  set(origin: string, factor: number) {
    const f = clampZoom(factor);
    if (f === 1) delete this.data.origins[origin];
    else this.data.origins[origin] = f;
    this.flush();
  }

  clear(origin: string) {
    delete this.data.origins[origin];
    this.flush();
  }

  get size() {
    return Object.keys(this.data.origins).length;
  }

  flush() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
}

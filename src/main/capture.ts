// Screenshot / capture (ticket 26).
//
// GATE CONSTRAINTS, both enforced here rather than in the UI:
//  1. **Capture is chrome-initiated.** A page cannot trigger a capture and cannot read the result —
//     there is no IPC path from a page to this module, and the result is returned only to the chrome
//     window's invoker.
//  2. **Capture must not run while a confirmation dialog is pending.** A capture taken then would
//     photograph the security UI (the confirm sheet names the host and the action) and could be
//     saved or shared by the user without realising what is in the frame. The runtime refuses, and
//     the refusal is explicit rather than a blank image.
//
// The region overlay is chrome, not page: the drag is drawn by the chrome window over the page area,
// and the page never learns that a capture is happening.

import { writeFileSync } from 'node:fs';
import { z } from 'zod';

export type CaptureMode = 'visible' | 'full' | 'region';

export interface CaptureRequest {
  mode: CaptureMode;
  /** device-independent px, relative to the page area, for mode 'region' */
  rect?: { x: number; y: number; width: number; height: number };
}

export const CaptureRequestSchema = z
  .object({
    mode: z.enum(['visible', 'full', 'region']),
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Clamp a requested rect into the page's own bounds, so a capture can never exceed the page. */
export function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(Math.round(rect.x), Math.max(0, bounds.width - 1)));
  const y = Math.max(0, Math.min(Math.round(rect.y), Math.max(0, bounds.height - 1)));
  const width = Math.max(1, Math.min(Math.round(rect.width), bounds.width - x));
  const height = Math.max(1, Math.min(Math.round(rect.height), bounds.height - y));
  return { x, y, width, height };
}

/**
 * The size a full-page capture is allowed to reach. A page can report an enormous scroll height
 * (ad infinitum / attacker-controlled), and capturing it would allocate that much memory, so the
 * height is capped and the capture reports that it was clipped rather than dying.
 */
export const MAX_CAPTURE_HEIGHT = 20_000;
export const MAX_CAPTURE_PIXELS = 40_000_000;

export function clampFullHeight(height: number, width: number): { height: number; clipped: boolean } {
  const byHeight = Math.min(Math.round(height), MAX_CAPTURE_HEIGHT);
  const byPixels = Math.max(1, Math.floor(MAX_CAPTURE_PIXELS / Math.max(1, Math.round(width))));
  const h = Math.max(1, Math.min(byHeight, byPixels));
  return { height: h, clipped: h < Math.round(height) };
}

/** A filename the user will recognise and that is safe on every filesystem. */
export function captureFilename(host: string, at = new Date()): string {
  const safeHost = (host || 'page').replace(/[^\w.-]/g, '_').slice(0, 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${safeHost}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.png`;
}

/**
 * Write a capture to disk. Kept separate from the Electron call so the file behaviour is testable
 * and so the caller decides the path (the chrome asks with a save dialog; tests pass a temp path).
 */
export function writeCapture(file: string, png: Buffer): { ok: true; bytes: number } | { ok: false; error: string } {
  try {
    if (!Buffer.isBuffer(png) || !png.length) return { ok: false, error: 'empty image' };
    writeFileSync(file, png, { mode: 0o644 });
    return { ok: true, bytes: png.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

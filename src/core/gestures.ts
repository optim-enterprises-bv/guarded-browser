// Mouse gestures (ticket 16): right-button-drag sequences mapped to actions from the keybinding
// table. Pure recognizer, so the rules are unit-testable without a browser.
//
// TWO DECISIONS, both security-relevant, both enforced here rather than in the UI:
//
// 1. **Gestures are refused while an agent task runs.** A gesture navigates, closes tabs or opens
//    Quick Commands; during a task those would move the agent's tab out from under the gate and
//    make the security UI describe something that is no longer true. The runtime checks `current`
//    before dispatching, and this module simply will not produce an action for a gesture it is told
//    to suppress.
// 2. **The pointer path is all this sees.** No DOM, no page content, no text. A path is a list of
//    directions; that is the whole input surface. A page cannot synthesise a gesture either, because
//    the recognizer is fed from the main process's own input event, not from page script.

export type Direction = 'left' | 'right' | 'up' | 'down';

export const MAX_PATH_LEN = 8;
/** How far (px) the pointer must travel before a direction is recorded. A right-drag gesture is a
 *  flick of roughly 50-100 px, so 40 px needed a deliberately long drag to register at all; 24 px
 *  keeps a short flick working while still ignoring an accidental nudge. */
export const STEP_PX = 24;

export interface Point {
  x: number;
  y: number;
}

/** One gesture as a path of directions, plus the action it is bound to. */
export interface GestureBinding {
  path: Direction[];
  action: string;
}

export const DEFAULT_GESTURES: GestureBinding[] = [
  { path: ['left'], action: 'nav.back' },
  { path: ['right'], action: 'nav.forward' },
  { path: ['up'], action: 'view.find' },
  { path: ['down'], action: 'tab.reload' },
  { path: ['down', 'right'], action: 'tab.close' },
  { path: ['down', 'left'], action: 'tab.reopen' },
  { path: ['up', 'left'], action: 'tab.prev' },
  { path: ['up', 'right'], action: 'tab.next' },
  { path: ['left', 'up'], action: 'view.print' },
  { path: ['right', 'up'], action: 'tab.new' },
];

/**
 * Build the direction path from a raw pointer trail. Points closer than STEP_PX to the last
 * committed point are ignored, and the axis with the larger delta wins, so a wobbly diagonal
 * records one direction rather than two.
 */
export function pathFrom(points: Point[], stepPx = STEP_PX): Direction[] {
  const out: Direction[] = [];
  if (points.length < 2) return out;
  let last = points[0];
  for (const p of points.slice(1)) {
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (Math.hypot(dx, dy) < stepPx) continue;
    const dir: Direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    // collapse repeats: three flicks right is still "right"
    if (out[out.length - 1] !== dir) out.push(dir);
    last = p;
    if (out.length >= MAX_PATH_LEN) break;
  }
  return out;
}

/** The action bound to a path, or null. Exact match only — a partial path must not fire. */
export function matchGesture(path: Direction[], bindings: GestureBinding[] = DEFAULT_GESTURES): string | null {
  if (!path.length || path.length > MAX_PATH_LEN) return null;
  const key = path.join(',');
  return bindings.find((b) => b.path.join(',') === key)?.action ?? null;
}

/**
 * Resolve a completed gesture. `suppressed` is passed by the caller while an agent task runs;
 * suppression is handled here so every call site cannot forget it.
 */
export function resolveGesture(
  path: Direction[],
  opts: { suppressed: boolean; bindings?: GestureBinding[] } = { suppressed: false },
): { action: string } | { suppressed: true } | { action: null } {
  if (opts.suppressed) return { suppressed: true };
  return { action: matchGesture(path, opts.bindings ?? DEFAULT_GESTURES) };
}

/** Parse a stored path like "down,right" into a Direction[]. */
export function parsePath(s: string): Direction[] | null {
  const parts = String(s)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const ok: Direction[] = ['left', 'right', 'up', 'down'];
  if (!parts.length || parts.length > MAX_PATH_LEN) return null;
  for (const p of parts) if (!ok.includes(p as Direction)) return null;
  return parts as Direction[];
}

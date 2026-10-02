// Tab hibernation (ticket 23) — THE most dangerous ticket in the plan, because discarding a
// webContents destroys the only thing the post-task gate is keyed on.
//
// The gate is keyed on WebContents ids (tab-guard.ts). If a gated tab is discarded, its WebContents
// is destroyed, the gate record has nothing left to attach to, and the guarantee that "a page that
// received an agent POST is cleaned before you use it again" silently disappears. Hibernation is
// therefore not allowed to be a policy question in the UI layer: the decision lives here, as a pure
// function over explicit facts, and the runtime has no path that hibernates without asking it.
//
// NEVER hibernate a tab that is:
//   (a) the agent's own pane         — the agent is driving it right now
//   (b) under the post-task gate     — discarding it drops the gate (the whole point of the rule)
//   (c) audible                      — music/video the user is listening to
//   (d) the active tab               — it is on screen
//   (e) the only tab                 — there would be nothing to show
//   (f) mid-navigation / loading     — a discard during load leaves a blank tab
//   (g) pinned by the caller         — an explicit user pin beats the timer
// Unsaved form state is a judgment call the user opts into (see allowsFormState below): a discard
// loses it, so it is refused by default and only allowed when the setting says so explicitly.


import { z } from 'zod';

export const MIN_IDLE_MS = 60_000;
export const DEFAULT_IDLE_MS = 30 * 60_000;

export interface HibernationFacts {
  tabId: number;
  /** the tab the agent is driving */
  isAgentTab: boolean;
  /** under the post-task gate — the record itself, not a guess */
  isGated: boolean;
  audible: boolean;
  active: boolean;
  /** how many tabs the profile has open */
  tabCount: number;
  /** ms since this tab was last activated (the runtime tracks activation time) */
  idleMs: number;
  /** a load is in flight */
  loading: boolean;
  /** the user pinned this tab */
  pinned: boolean;
  /** the page has form state that would be lost (best-effort, from the tab preload) */
  hasFormState: boolean;
}

export type HibernationDecision =
  | { hibernate: true; reason: string }
  | { hibernate: false; reason: string };

/**
 * Decide whether ONE tab may be discarded. Pure: no Electron, no I/O, no clock — every fact arrives
 * in the argument so the rules are unit-testable and cannot be bypassed by a different caller.
 */
export function decideHibernation(
  f: HibernationFacts,
  opts: { idleMs: number; allowFormState: boolean },
): HibernationDecision {
  if (f.isAgentTab) return { hibernate: false, reason: 'the agent is driving this tab' };
  if (f.isGated) return { hibernate: false, reason: 'the tab is under the post-task gate; discarding it would drop the gate' };
  if (f.audible) return { hibernate: false, reason: 'the tab is playing audio' };
  if (f.active) return { hibernate: false, reason: 'the active tab is on screen' };
  if (f.pinned) return { hibernate: false, reason: 'the tab is pinned' };
  if (f.loading) return { hibernate: false, reason: 'the tab is still loading' };
  if (f.tabCount <= 1) return { hibernate: false, reason: 'it is the only tab' };
  if (f.hasFormState && !opts.allowFormState) return { hibernate: false, reason: 'the tab has unsaved form state' };
  const idle = Math.max(MIN_IDLE_MS, opts.idleMs);
  if (f.idleMs < idle) return { hibernate: false, reason: `idle for less than ${Math.round(idle / 60000)} min` };
  return { hibernate: true, reason: 'inactive and unguarded' };
}

/**
 * Pick the tabs a sweep may discard, ordered oldest-first so a bounded sweep frees the stalest tabs
 * first. The runtime calls this and nothing else — it never decides for itself.
 */
export function planSweep(
  facts: HibernationFacts[],
  opts: { idleMs: number; allowFormState: boolean; maxPerSweep?: number },
): number[] {
  const max = Math.max(1, opts.maxPerSweep ?? 5);
  return facts
    .filter((f) => decideHibernation(f, opts).hibernate)
    .sort((a, b) => b.idleMs - a.idleMs)
    .slice(0, max)
    .map((f) => f.tabId);
}

export const HibernationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    idleMinutes: z.number().int().min(1).max(24 * 60),
    /** opt-in: a discard loses unsaved form state */
    allowFormState: z.boolean(),
    maxPerSweep: z.number().int().min(1).max(50),
  })
  .strict();

export const defaultHibernation = () => ({ enabled: false, idleMinutes: 30, allowFormState: false, maxPerSweep: 5 });

export type HibernationSettings = z.infer<typeof HibernationSettingsSchema>;


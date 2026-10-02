// Per-tab page actions (ticket 27): greyscale, high contrast, hide images, hide backgrounds,
// invert, sepia — plus custom CSS.
//
// SECURITY / AGENT-VISIBILITY (the reason this file is careful):
// a transform changes what the page LOOKS like, and "hide images" in particular changes what the
// agent's snapshot reports. That makes the applied set an agent-visible state, not a private
// preference: runtime.ts records it in the audit log and includes it in the task's system context,
// so the agent is never reasoning about a page the user has visually rewritten without knowing.
//
// The CSS is applied in the page, injected as a stylesheet from the isolated world. The chrome is
// never touched (rule 6): these selectors and filters target the page document only.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export const PAGE_ACTIONS = ['greyscale', 'contrast', 'hideImages', 'hideBackgrounds', 'invert', 'sepia'] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

export const ACTION_LABEL: Record<PageAction, string> = {
  greyscale: 'Greyscale',
  contrast: 'High contrast',
  hideImages: 'Hide images',
  hideBackgrounds: 'Hide backgrounds',
  invert: 'Invert colours',
  sepia: 'Sepia',
};

/** Which actions change what the agent's snapshot sees (surfaced to the agent + audit). */
export const AGENT_VISIBLE_ACTIONS: PageAction[] = ['hideImages'];

export const MAX_CUSTOM_CSS = 20_000;

export const PageActionsSchema = z
  .object({
    /** the toggles in force for this origin */
    on: z.array(z.enum(PAGE_ACTIONS)).max(PAGE_ACTIONS.length),
    /** the user's own CSS for this origin (capped; injected as text, never parsed by us) */
    customCss: z.string().max(MAX_CUSTOM_CSS),
  })
  .strict();
export type PageActions = z.infer<typeof PageActionsSchema>;

export const defaultPageActions = (): PageActions => ({ on: [], customCss: '' });

const cssFor = (a: PageAction): string => {
  switch (a) {
    case 'greyscale':
      return 'html{filter:grayscale(1) !important}';
    case 'contrast':
      return 'html{filter:contrast(1.5) !important}';
    case 'invert':
      return 'html{filter:invert(1) !important}';
    case 'sepia':
      return 'html{filter:sepia(0.8) !important}';
    case 'hideImages':
      // not a filter: the elements are removed from layout so they cannot be mistaken for content
      return 'img,picture,video,svg,canvas{visibility:hidden !important}';
    case 'hideBackgrounds':
      return '*{background-image:none !important}';
  }
};

/**
 * The stylesheet for a set of actions. Returns '' when nothing is applied, so the caller can skip
 * injecting entirely.
 *
 * Custom CSS is appended VERBATIM. That is deliberate and safe in one direction only: it can style
 * the page (the user's own decision about their own view), but it is injected into the page's
 * document, never into chrome, so it cannot restyle the confirmation dialog, the agent frame or any
 * security UI — those live in the chrome window, a different document.
 */
export function pageActionCss(pa: PageActions): string {
  const parts = PAGE_ACTIONS.filter((a) => pa.on.includes(a)).map(cssFor);
  const custom = pa.customCss.trim();
  if (custom) parts.push(custom);
  return parts.join('\n');
}

/** True when this set changes what the agent's snapshot would report. */
export function affectsAgentSnapshot(pa: PageActions): boolean {
  return pa.on.some((a) => AGENT_VISIBLE_ACTIONS.includes(a));
}

/** A short human line for the audit log / agent context, or '' when nothing is applied. */
export function describePageActions(pa: PageActions): string {
  const names = PAGE_ACTIONS.filter((a) => pa.on.includes(a)).map((a) => ACTION_LABEL[a]);
  if (pa.customCss.trim()) names.push('custom CSS');
  return names.join(', ');
}

export const PageActionsFileSchema = z
  .object({
    version: z.literal(1),
    /** origin -> actions */
    origins: z.record(z.string().max(2048), PageActionsSchema),
  })
  .strict();

/**
 * Per-origin store. Atomic, 0600, in the profile directory. A tampered file is rejected as a whole
 * and the store starts empty, rather than honouring the parts that happen to parse.
 */
export class PageActionsStore {
  private data: z.infer<typeof PageActionsFileSchema> = { version: 1, origins: {} };
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const r = PageActionsFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (r.success) this.data = r.data;
      else this.loadError = r.error.issues[0]?.message ?? 'invalid';
    } catch (e) {
      this.loadError = (e as Error).message;
    }
  }

  byOrigin(origin: string): PageActions {
    const a = this.data.origins[origin];
    return a ? { on: [...a.on], customCss: a.customCss } : defaultPageActions();
  }

  set(origin: string, pa: PageActions): PageActions {
    const r = PageActionsSchema.safeParse(pa);
    const clean = r.success ? r.data : defaultPageActions();
    if (!clean.on.length && !clean.customCss.trim()) delete this.data.origins[origin];
    else this.data.origins[origin] = clean;
    this.flush();
    return clean;
  }

  clear(origin: string) {
    delete this.data.origins[origin];
    this.flush();
  }

  origins(): string[] {
    return Object.keys(this.data.origins);
  }

  flush() {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

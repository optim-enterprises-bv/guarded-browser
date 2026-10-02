/**
 * The post-task state-change gate, as a pure book of per-tab security state.
 *
 * Why this is its own module: "is this tab gated?" is asked by the webRequest layer, the popup
 * handler, the task lifecycle, and (soon) reopen, session restore, hibernation and tab stacks.
 * Keeping the bookkeeping here — keyed by tab id, no Electron types, no I/O — means every one of
 * those callers asks the same question and gets the same answer, and the rules are unit-testable
 * without launching a browser.
 *
 * The rules, which the tests pin down:
 *
 *  - A tab becomes gated when an agent task starts driving it, and STAYS gated after the task
 *    ends. It is a post-task gate: the threat is a page waiting for the agent to leave and then
 *    submitting the form itself.
 *  - The gate is lifted only by the user taking the tab back (navigating it themselves) or by the
 *    tab closing. Nothing else lifts it.
 *  - Origins are recorded only while a tab is gated, and they are dropped with the gate. They mean
 *    "origins this tab reached under the gate", not "every origin this tab ever saw" — otherwise a
 *    later, unrelated task would unregister the service workers of a site the user was merely
 *    reading.
 *  - Gate state is never persisted. A reopened or restored tab is a new tab id, absent from this
 *    book, and therefore ungated: reopening a URL must not resurrect the gate.
 *  - Lifting or closing leaves a TOMBSTONE for TOMBSTONE_MS. The gated document's pagehide /
 *    unload handlers run while (or, cross-process, after) the next document commits or the tab
 *    closes, and a sendBeacon / keepalive fetch from there outlives it. Until the tombstone
 *    expires, state-changing requests that may still come from that document are held:
 *    see heldByTomb().
 */

/** How long a lifted / closed gate keeps holding requests from the document it left. */
export const TOMBSTONE_MS = 30_000;

export interface TombInfo {
  /** the tab's WebContents id: what the webRequest layer sees */
  wcId: number;
  /** origin of the gated document being left (it may not be in the gate's origins: a gated page can
   *  move itself after the task, and only the task's navigations are recorded) */
  leaving?: string | null;
  /** origin of the user's newly committed document (absent on close) */
  fresh?: string | null;
  closed?: boolean;
  now?: number;
}

interface Tomb {
  wcId: number;
  origins: Set<string>;
  fresh: string | null;
  closed: boolean;
  until: number;
}

export type Gate = 'none' | 'post-task';

export interface TabGuardState {
  id: number;
  agentTab: boolean;
  gate: Gate;
  /** origins reached while gated (empty unless gate === 'post-task') */
  gateOrigins: string[];
  navSource?: 'user' | 'agent' | 'page';
}

export class TabGuardBook {
  private readonly gates = new Map<number, Set<string>>();
  private tombs: Tomb[] = [];

  /** Start gating a tab (an agent task is taking it over). */
  gate(id: number): void {
    if (!this.gates.has(id)) this.gates.set(id, new Set());
  }

  /** Lift the gate and drop the origins it was tracking (into a tombstone when `tomb` is given). */
  lift(id: number, tomb?: TombInfo): void {
    this.bury(id, tomb);
    this.gates.delete(id);
  }

  /** Forget a closed tab entirely (a gated one leaves a tombstone when `tomb` is given). */
  forget(id: number, tomb?: TombInfo): void {
    this.bury(id, tomb && { ...tomb, closed: true });
    this.gates.delete(id);
  }

  private bury(id: number, t?: TombInfo): void {
    const origins = this.gates.get(id);
    if (!origins || !t) return;
    const all = new Set(origins);
    if (t.leaving) all.add(t.leaving);
    this.tombs.push({ wcId: t.wcId, origins: all, fresh: t.fresh ?? null, closed: !!t.closed, until: (t.now ?? Date.now()) + TOMBSTONE_MS });
  }

  /**
   * Should a state-changing request that no live gate covers still be held? Within TOMBSTONE_MS:
   *  - from the tombstoned tab's WebContents: yes, unless its Referer origin is the user's new
   *    document's (and that origin was not one the gated document had: a same-origin new page
   *    cannot be told apart from the old one, so it waits out the tombstone). The old document can
   *    lower its Referer (no-referrer) but never set another origin's, so this cannot be forged.
   *  - from no live tab (the closed tab's destroyed WebContents may report no id, workers): yes after
   *    a close; after a lift only to an origin the gated tab had.
   */
  heldByTomb(req: { wcId?: number; liveTab: boolean; origin: string | null; referrerOrigin: string | null }, now = Date.now()): boolean {
    this.tombs = this.tombs.filter((t) => t.until > now);
    return this.tombs.some((t) => {
      if (req.wcId === t.wcId) return t.closed || !(req.referrerOrigin && req.referrerOrigin === t.fresh && !t.origins.has(t.fresh));
      if (req.liveTab) return false;
      return t.closed || (!!req.origin && t.origins.has(req.origin));
    });
  }

  isGated(id: number): boolean {
    return this.gates.has(id);
  }

  /** True while any tab is still gated — the worker gate is keyed on this, not on a single tab. */
  anyGated(): boolean {
    return this.gates.size > 0;
  }

  /**
   * Origins reached by currently-gated tabs. Requests that belong to no tab (service workers,
   * shared workers) to one of these origins are gated while any tab is still gated.
   */
  gatedOrigins(): Set<string> {
    const out = new Set<string>();
    for (const origins of this.gates.values()) for (const o of origins) out.add(o);
    return out;
  }

  /** Record an origin, but only while the tab is gated (an ungated tab has nothing to track). */
  addOrigin(id: number, origin: string): void {
    this.gates.get(id)?.add(origin);
  }

  /** Full state for one tab. `agentTab` comes from the caller: only it knows the agent's pane. */
  state(id: number, agentTab: boolean, navSource?: 'user' | 'agent' | 'page'): TabGuardState {
    const origins = this.gates.get(id);
    return { id, agentTab, gate: origins ? 'post-task' : 'none', gateOrigins: origins ? [...origins] : [], navSource };
  }
}

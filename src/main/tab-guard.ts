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
 */

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

  /** Start gating a tab (an agent task is taking it over). */
  gate(id: number): void {
    if (!this.gates.has(id)) this.gates.set(id, new Set());
  }

  /** Lift the gate and drop the origins it was tracking. */
  lift(id: number): void {
    this.gates.delete(id);
  }

  /** Forget a closed tab entirely. */
  forget(id: number): void {
    this.gates.delete(id);
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

// The post-task state-change gate is the browser's central security invariant: a page the agent
// drove must not regain the ability to change state just because the task ended. These tests pin
// the rules down from a pure module so they hold for every caller (webRequest, popups, and the
// reopen/restore/hibernation features that are coming).
import { describe, expect, it } from 'vitest';
import { TabGuardBook } from '../../src/main/tab-guard';

describe('post-task gate', () => {
  it('a tab is ungated until a task takes it, and stays gated after the task ends', () => {
    const g = new TabGuardBook();
    expect(g.isGated(1)).toBe(false);
    expect(g.anyGated()).toBe(false);

    g.gate(1); // task starts driving tab 1
    expect(g.isGated(1)).toBe(true);
    expect(g.anyGated()).toBe(true);

    // the task ending does NOT lift the gate — this is the whole point of a *post*-task gate
    // (there is no "task over" call on the book; only the user or a close can lift it)
    expect(g.isGated(1)).toBe(true);
  });

  it('the user navigating the tab themselves lifts the gate', () => {
    const g = new TabGuardBook();
    g.gate(1);
    g.lift(1);
    expect(g.isGated(1)).toBe(false);
    expect(g.anyGated()).toBe(false);
  });

  it('a reopened or restored tab never inherits the gate', () => {
    const g = new TabGuardBook();
    g.gate(1);
    g.addOrigin(1, 'https://evil.test');

    // reopening a closed tab constructs a NEW tab id; it must be absent from the book entirely
    const reopened = 2;
    expect(g.isGated(reopened)).toBe(false);
    expect(g.state(reopened, false)).toEqual({ id: 2, agentTab: false, gate: 'none', gateOrigins: [], navSource: undefined });

    // ...while the still-gated original keeps its own origins (the union across gated tabs is not
    // what "inherited" means — per-tab state is)
    expect(g.isGated(1)).toBe(true);
    expect(g.state(1, false).gateOrigins).toEqual(['https://evil.test']);
    expect(g.gatedOrigins().has('https://evil.test')).toBe(true);
  });

  it('origins are recorded only while gated, and dropped with the gate', () => {
    const g = new TabGuardBook();
    // a tab the user is merely browsing records nothing
    g.addOrigin(7, 'https://news.test');
    expect(g.gatedOrigins().size).toBe(0);

    g.gate(7);
    g.addOrigin(7, 'https://news.test');
    expect(g.gatedOrigins().has('https://news.test')).toBe(true);

    // lifting the gate drops them: otherwise a later, unrelated task would unregister the
    // service workers of a site the user was only reading
    g.lift(7);
    expect(g.gatedOrigins().size).toBe(0);
  });

  it('the worker gate holds as long as ANY tab is still gated, not just the agent one', () => {
    const g = new TabGuardBook();
    g.gate(1);
    g.gate(2);
    g.addOrigin(1, 'https://a.test');
    g.addOrigin(2, 'https://b.test');

    g.lift(1); // the user takes tab 1 back
    expect(g.anyGated()).toBe(true); // tab 2 keeps the worker gate alive
    expect(g.gatedOrigins().has('https://a.test')).toBe(false);
    expect(g.gatedOrigins().has('https://b.test')).toBe(true);

    g.lift(2);
    expect(g.anyGated()).toBe(false);
    expect(g.gatedOrigins().size).toBe(0);
  });

  it('closing a gated tab forgets it, and the book empties', () => {
    const g = new TabGuardBook();
    g.gate(3);
    g.addOrigin(3, 'https://c.test');
    g.forget(3);
    expect(g.isGated(3)).toBe(false);
    expect(g.anyGated()).toBe(false);
    expect(g.gatedOrigins().size).toBe(0);
  });

  it('state() reports the whole record for one tab', () => {
    const g = new TabGuardBook();
    g.gate(5);
    g.addOrigin(5, 'https://d.test');
    expect(g.state(5, true)).toEqual({ id: 5, agentTab: true, gate: 'post-task', gateOrigins: ['https://d.test'], navSource: undefined });
    expect(g.state(6, false)).toEqual({ id: 6, agentTab: false, gate: 'none', gateOrigins: [], navSource: undefined });
    expect(g.state(5, false, 'agent').navSource).toBe('agent');
  });
});

describe('M2 (round 6): a lifted or closed gate leaves a 30 s tombstone', () => {
  const T0 = 1_000_000;
  const req = (o: Partial<{ wcId: number; liveTab: boolean; origin: string | null; referrerOrigin: string | null }>) => ({ wcId: 7, liveTab: true, origin: 'http://sink.test', referrerOrigin: null, ...o });

  it("the unloading document's beacon after the user's navigation committed is held; the new document's is not", () => {
    const g = new TabGuardBook();
    g.gate(1);
    g.addOrigin(1, 'http://site.test');
    g.lift(1, { wcId: 7, leaving: 'http://site.test', fresh: 'http://news.test', now: T0 });
    expect(g.isGated(1)).toBe(false);
    // old document: Referer is its own origin, or suppressed (no-referrer); never another origin's
    expect(g.heldByTomb(req({ referrerOrigin: 'http://site.test' }), T0 + 100)).toBe(true);
    expect(g.heldByTomb(req({ referrerOrigin: null }), T0 + 100)).toBe(true);
    // the user's new document
    expect(g.heldByTomb(req({ referrerOrigin: 'http://news.test' }), T0 + 100)).toBe(false);
    // another tab is not affected
    expect(g.heldByTomb(req({ wcId: 8 }), T0 + 100)).toBe(false);
    // a worker (no tab) to an origin the gated tab had is; to anything else it is not
    expect(g.heldByTomb(req({ wcId: undefined, liveTab: false, origin: 'http://site.test' }), T0 + 100)).toBe(true);
    expect(g.heldByTomb(req({ wcId: undefined, liveTab: false }), T0 + 100)).toBe(false);
    // and it expires
    expect(g.heldByTomb(req({ referrerOrigin: null }), T0 + 30_001)).toBe(false);
  });

  it('a new document on the same origin as the gated one waits out the tombstone (cannot be told apart)', () => {
    const g = new TabGuardBook();
    g.gate(1);
    g.lift(1, { wcId: 7, leaving: 'http://site.test', fresh: 'http://site.test', now: T0 });
    expect(g.heldByTomb(req({ referrerOrigin: 'http://site.test' }), T0 + 1)).toBe(true);
  });

  it('closing holds everything from the dead WebContents and from no tab for 30 s', () => {
    const g = new TabGuardBook();
    g.gate(1);
    g.forget(1, { wcId: 7, leaving: 'http://site.test', now: T0 });
    expect(g.heldByTomb(req({ referrerOrigin: 'http://elsewhere.test' }), T0 + 1)).toBe(true);
    expect(g.heldByTomb(req({ wcId: undefined, liveTab: false }), T0 + 1)).toBe(true);
    expect(g.heldByTomb(req({ wcId: 9 }), T0 + 1)).toBe(false);
  });

  it('an ungated tab leaves no tombstone', () => {
    const g = new TabGuardBook();
    g.lift(1, { wcId: 7, now: T0 });
    g.forget(2, { wcId: 8, now: T0 });
    expect(g.heldByTomb(req({ wcId: 7 }), T0 + 1)).toBe(false);
    expect(g.heldByTomb(req({ wcId: undefined, liveTab: false }), T0 + 1)).toBe(false);
  });
});

// The IPC surface is gated by THREE separate allowlists, and a channel that is in some but not all
// of them fails in a way that looks like a UI bug rather than a wiring bug:
//
//   1. src/main/preload.ts  INVOKE  — what the chrome renderer may call at all
//   2. src/main/main.ts     RUNTIME_CHANNELS — what ipcMain.handle actually registers
//   3. src/main/main.ts     PROFILE_CHANNELS — the profile-management handlers
//
// A channel missing from (2) throws "No handler registered for ..." at runtime, after the click
// appears to do nothing. Missing from (1) throws "channel not allowed". Ticket 02 hit exactly
// this: the new tab channels were added to (1) and (2) in runtime.ts but not to (2) in main.ts.
// This test reads the three lists out of the source and keeps them in agreement, so the next
// channel cannot be half-wired.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Pull the quoted channel names out of a bracketed list literal, ignoring comments. */
function channelsAfter(text: string, marker: string): Set<string> {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = text.indexOf(text.includes('(') && marker.includes('new Set') ? '(' : '[', at);
  const close = text.indexOf(text.includes('(') && marker.includes('new Set') ? ')' : ']', open);
  const body = text.slice(open, close);
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const preload = src('src/main/preload.ts');
const main = src('src/main/main.ts');

const invoke = channelsAfter(preload, 'const INVOKE');
const events = channelsAfter(preload, 'const EVENTS');
const runtimeChannels = channelsAfter(main, 'const RUNTIME_CHANNELS');
const profileChannels = channelsAfter(main, 'const PROFILE_CHANNELS');

/** Channels registered by runtime.ts, read the same way — these are the handlers that exist. */
const runtimeHandlers = (() => {
  const text = src('src/main/runtime.ts');
  // every `on('channel'` inside registerIpc()
  const start = text.indexOf('function registerIpc()');
  const end = text.indexOf('\nregisterIpc();', start);
  const body = text.slice(start, end < 0 ? undefined : end);
  return new Set([...body.matchAll(/\bon\(\s*'([^']+)'/g)].map((m) => m[1]));
})();

describe('IPC allowlists agree', () => {
  it('NO list repeats a channel — a second ipcMain.handle throws INSIDE whenReady() and the app then exits with no window and no message', () => {
    // This is why the check must be array-based: the Set-based parser above cannot see a duplicate.
    const asList = (text: string, marker: string): string[] => {
      const at = text.indexOf(marker);
      const open = text.indexOf('[', at);
      const close = text.indexOf(']', open);
      return [...text.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    };
    const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
    expect(dupes(asList(main, 'const RUNTIME_CHANNELS')), 'duplicate in main.ts RUNTIME_CHANNELS').toEqual([]);
    expect(dupes(asList(preload, 'const INVOKE')), 'duplicate in preload.ts INVOKE').toEqual([]);
    expect(dupes(asList(preload, 'const EVENTS')), 'duplicate in preload.ts EVENTS').toEqual([]);
  });

  it('parsed all four lists (guards against this test silently matching nothing)', () => {
    expect(invoke.size).toBeGreaterThan(40);
    expect(runtimeChannels.size).toBeGreaterThan(40);
    expect(runtimeHandlers.size).toBeGreaterThan(40);
    expect(events.size).toBeGreaterThan(5);
    expect(profileChannels.size).toBe(5);
  });

  it('every channel the preload allows is actually registered by ipcMain.handle', () => {
    const registered = new Set([...runtimeChannels, ...profileChannels]);
    const unregistered = [...invoke].filter((c) => !registered.has(c)).sort();
    expect(unregistered).toEqual([]);
  });

  it('every registered channel is reachable from the preload (no dead handler)', () => {
    const dead = [...runtimeChannels].filter((c) => !invoke.has(c)).sort();
    expect(dead).toEqual([]);
  });

  it('every runtime handler has a channel in both allowlists', () => {
    const registered = new Set([...runtimeChannels, ...profileChannels]);
    const orphans = [...runtimeHandlers].filter((c) => !registered.has(c)).sort();
    const unreachable = [...runtimeHandlers].filter((c) => !invoke.has(c)).sort();
    expect(orphans).toEqual([]);
    expect(unreachable).toEqual([]);
  });

  it('every application-menu item names an action that exists in the chord table', () => {
    // The menu (ticket 11) and the chord table must not drift: a menu item naming an action that no
    // longer exists is a dead control, and a typo there is invisible until someone clicks it.
    const menu = src('src/main/main.ts');
    const block = menu.slice(menu.indexOf('function buildMenu'), menu.indexOf('Menu.setApplicationMenu'));
    const named = [...block.matchAll(/act\('[^']+',\s*'([^']+)'\)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(8);
    const kb = src('src/core/keybindings.ts');
    const actions = new Set([...kb.slice(kb.indexOf('ALL_ACTIONS')).split('];')[0].matchAll(/'([a-zA-Z.]+)'/g)].map((m) => m[1]));
    expect(actions.size).toBeGreaterThan(20);
    expect(named.filter((a) => !actions.has(a)), 'menu items naming a nonexistent action').toEqual([]);
  });
});

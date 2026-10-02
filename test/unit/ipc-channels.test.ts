// The chrome IPC surface is declared ONCE, in src/shared/ipc.ts: the preload exposes exactly the
// registry and main.ts registers exactly the registry. What can still drift is the registry against
// the handlers that really exist — a registry channel with no handler throws "unknown sender" after
// a click that appears to do nothing, and a handler missing from the registry is unreachable dead
// code. Ticket 02 hit exactly this kind of half-wiring. This test holds the registry and the
// handlers (runtime.ts + src/main/runtime/*.ts `on('…'`, main.ts `ipcMain.handle('…'`) together.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_CHANNELS, INVOKE_CHANNELS, MAIL_CHANNELS, PROFILE_CHANNELS, RUNTIME_CHANNELS } from '../../src/shared/ipc';

const ROOT = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const preload = src('src/main/preload.ts');
const main = src('src/main/main.ts');

/** Every `on('channel'` registration in the runtime (not `x.on('event'` listeners). */
const runtimeHandlerList = (() => {
  const files = ['src/main/runtime.ts'];
  const dir = join(ROOT, 'src/main/runtime');
  if (existsSync(dir)) for (const f of readdirSync(dir).sort()) if (f.endsWith('.ts')) files.push(`src/main/runtime/${f}`);
  return files.flatMap((f) => [...src(f).matchAll(/(?<![.\w])on\(\s*'([^']+)'/g)].map((m) => m[1]));
})();
const runtimeHandlers = new Set(runtimeHandlerList);
/** Channels main.ts handles itself with a literal name (the profile channels). */
const mainHandlers = new Set([...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]));

const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

describe('IPC channel registry', () => {
  it('NO list repeats a channel — a second ipcMain.handle throws INSIDE whenReady() and the app then exits with no window and no message', () => {
    expect(dupes(INVOKE_CHANNELS), 'duplicate invoke channel').toEqual([]);
    expect(dupes(EVENT_CHANNELS), 'duplicate event channel').toEqual([]);
    expect(dupes(runtimeHandlerList), 'a runtime channel registered twice').toEqual([]);
  });

  it('parsed everything (guards against this test silently matching nothing)', () => {
    expect(RUNTIME_CHANNELS.length).toBeGreaterThan(40);
    expect(runtimeHandlers.size).toBeGreaterThan(40);
    expect(EVENT_CHANNELS.length).toBeGreaterThan(5);
    expect(PROFILE_CHANNELS.length).toBe(5);
    expect(INVOKE_CHANNELS.length).toBe(RUNTIME_CHANNELS.length + PROFILE_CHANNELS.length);
  });

  it('the preload and main.ts take their allowlists from the registry, not from copies', () => {
    expect(preload).toMatch(/from '\.\.\/shared\/ipc'/);
    expect(preload).toMatch(/new Set<string>\(INVOKE_CHANNELS\)/);
    expect(preload).toMatch(/new Set<string>\(EVENT_CHANNELS\)/);
    expect(main).toMatch(/for \(const ch of RUNTIME_CHANNELS\)/);
  });

  it('every runtime channel in the registry has an on() handler in the runtime', () => {
    expect(RUNTIME_CHANNELS.filter((c) => !runtimeHandlers.has(c)).sort()).toEqual([]);
  });

  it('every profile channel in the registry has an ipcMain.handle in main.ts', () => {
    expect(PROFILE_CHANNELS.filter((c) => !mainHandlers.has(c)).sort()).toEqual([]);
  });

  it('every handler is in the registry (no unreachable handler)', () => {
    const runtime = new Set<string>(RUNTIME_CHANNELS);
    const profile = new Set<string>(PROFILE_CHANNELS);
    expect([...runtimeHandlers].filter((c) => !runtime.has(c)).sort(), 'runtime handlers missing from RUNTIME_CHANNELS').toEqual([]);
    expect([...mainHandlers].filter((c) => !profile.has(c)).sort(), 'main.ts handlers missing from PROFILE_CHANNELS').toEqual([]);
  });

  it('the mail channels are runtime channels and are never published as events', () => {
    // Mail is a panel in the browser window (ticket 37c): request/response only, so nothing pushes
    // message text at the renderer.
    expect(MAIL_CHANNELS.length).toBeGreaterThan(10);
    const runtime = new Set<string>(RUNTIME_CHANNELS);
    const events = new Set<string>(EVENT_CHANNELS);
    for (const ch of MAIL_CHANNELS) {
      expect(runtime.has(ch)).toBe(true);
      expect(events.has(ch)).toBe(false);
    }
    const mail = new Set<string>(MAIL_CHANNELS);
    for (const ch of EVENT_CHANNELS) expect(mail.has(ch)).toBe(false);
  });

  it('the rail width agrees between panels.ts and styles.css (a drift here moves the page area)', () => {
    // The rail width is the left inset every pane is laid out against: `RAIL_WIDTH` in panels.ts and
    // `--rail` in styles.css must be the same number, or the page area and the rail disagree by a few
    // pixels and every later layout measurement is off by that much.
    const panels = src('src/renderer/panels.ts');
    const css = src('src/renderer/styles.css');
    const fromTs = /export const RAIL_WIDTH = (\d+)/.exec(panels)?.[1];
    const fromCss = /--rail:\s*(\d+)px/.exec(css)?.[1];
    expect(fromTs, 'RAIL_WIDTH in panels.ts').toBeTruthy();
    expect(fromCss, '--rail in styles.css').toBeTruthy();
    expect(fromTs).toBe(fromCss);
    // and it is the MEASURED value, not the old eyeballed one
    expect(Number(fromTs)).toBeGreaterThan(40);
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

// Keyboard chords and named actions for one profile window: the ONE dispatch table (runChord) that
// page keystrokes, the chrome's forwarded keystrokes, gestures, the palette and the menu all reach.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import type { WebContents } from 'electron';
import { saveSettings } from '../../core/config';
import { originOf } from '../../core/policy';
import { stepZoom } from '../../core/zoom';
import { resolveChord, type Chord } from '../../core/chords';
import { toChords, defaultKeybindings } from '../../core/keybindings';
import type { RuntimeDeps } from './deps';

export function createChords(rt: RuntimeDeps) {
const { settingsFile, zoom, sendUI, closeTab, reopenClosed, liftGateOnCommit, printTab } = rt;
/**
 * Dispatch a chord while a page has focus. Every action in src/core/chords.ts lands here, so the
 * keymap has exactly one implementation (ticket 15 will edit the table, not this function).
 */
function installShortcuts(wc: WebContents) {
  wc.on('before-input-event', (e, input) => {
    if (runChord(input)) e.preventDefault();
  });
}

/**
 * Run one chord against this window. Returns true when the keystroke was consumed.
 *
 * `before-input-event` only fires for a focused *page* view, so the chrome UI's own keydown
 * handler calls into the same path through the `chord` IPC channel (see the handler below). One
 * implementation, two entry points: the keymap has a single place to change (ticket 15 edits the
 * table in src/core/chords.ts and nothing else).
 *
 * `e` is the Electron event when available; the IPC path passes null and nothing needs to be
 * prevented (the renderer already called preventDefault on its own event).
 */
function runChord(input: { key: string; control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; type?: string }): boolean {
  const key = input.key.toLowerCase();
  const action = resolveChord(input, chordTable());
  // Ctrl+1..9 selects a tab by index (1..8), Ctrl+9 the last one
  if (!action && (input.control || input.meta) && !input.shift && /^[1-9]$/.test(key)) {
    const list = rt.tabs.list();
    const idx = key === '9' ? list.length - 1 : Number(key) - 1;
    const t = list[idx];
    if (t) rt.tabs.activate(t.id);
    return true;
  }
  if (!action) return false;
  const active = rt.tabs.active();
  switch (action) {
    case 'tab.new':
      // the agent's pane is fixed for the duration of its task
      if (rt.current) return true;
      rt.tabs.create(tabStartUrl()).navSource = 'user';
      break;
    case 'tab.close':
      if (active) closeTab(active.id);
      break;
    case 'tab.reopen':
      reopenClosed();
      break;
    case 'tab.next':
    case 'tab.prev': {
      const id = rt.tabs.nextInMru(action === 'tab.next' ? 1 : -1);
      if (id !== undefined) rt.tabs.activate(id);
      break;
    }
    case 'tab.duplicate':
      rt.tabs.duplicate(active?.id ?? -1);
      break;
    case 'tab.closeOthers':
      if (active) rt.tabs.closeOthers(active.id, !!rt.current);
      break;
    case 'tab.mute':
      if (active) rt.tabs.setAudioMuted(active.id, !active.wc.isAudioMuted());
      sendUI('tabs', rt.tabs.list());
      break;
    case 'tab.reload':
      if (active) {
        active.navSource = 'user';
        active.wc.reload();
      }
      break;
    case 'nav.back':
      if (active && !rt.current) {
        liftGateOnCommit(active);
        active.navSource = 'user';
        active.wc.navigationHistory.goBack();
      }
      break;
    case 'nav.forward':
      if (active && !rt.current) {
        liftGateOnCommit(active);
        active.navSource = 'user';
        active.wc.navigationHistory.goForward();
      }
      break;
    case 'nav.focusAddress':
      sendUI('shortcut', 'focus-address');
      break;
    // ticket 37c: mail is a PANEL in this window, so the action simply tells the chrome to switch to
    // it. One action, so the rail button, the chord and the menu land on the same place.
    case 'mail.open':
      sendUI('shortcut', 'open-mail');
      break;
    case 'view.zoomIn':
    case 'view.zoomOut':
    case 'view.zoomReset': {
      if (!active) break;
      const origin = originOf(active.wc.getURL());
      const factor =
        action === 'view.zoomReset' ? 1 : stepZoom(active.wc.getZoomFactor(), action === 'view.zoomIn' ? 1 : -1);
      active.wc.setZoomFactor(factor);
      if (origin) zoom.set(origin, factor);
      sendUI('zoom', { tab: active.id, factor });
      break;
    }
    case 'view.find':
      sendUI('shortcut', 'find');
      break;
    case 'view.print':
      // chrome-initiated print of the page the user is looking at. A page-initiated window.print()
      // is neutralised in the page's own world in setupTab.
      if (active) void printTab(active);
      break;
    case 'view.fullscreen':
      rt.win.setFullScreen(!rt.win.isFullScreen());
      break;
    case 'library.history':
      sendUI('shortcut', 'history');
      break;
    case 'library.bookmarkPage':
      sendUI('shortcut', 'bookmark-page');
      break;
    case 'library.toggleBar':
      sendUI('shortcut', 'toggle-bar');
      break;
    case 'tiles.tile':
      rt.tabs.tile(undefined, 'columns');
      break;
    case 'tiles.untile':
      rt.tabs.untile();
      break;
    // ---- wave 2 ----
    case 'palette.open':
      sendUI('shortcut', 'palette');
      break;
    case 'panel.history':
      sendUI('shortcut', 'panel:history');
      break;
    case 'panel.bookmarks':
      sendUI('shortcut', 'panel:bookmarks');
      break;
    case 'panel.downloads':
      sendUI('shortcut', 'panel:downloads');
      break;
    case 'panel.sessions':
      sendUI('shortcut', 'panel:sessions');
      break;
    case 'panel.workspaces':
      sendUI('shortcut', 'panel:workspaces');
      break;
    case 'reader.toggle':
      sendUI('shortcut', 'reader');
      break;
    case 'capture.visible':
      sendUI('shortcut', 'capture:visible');
      break;
    case 'capture.full':
      sendUI('shortcut', 'capture:full');
      break;
    case 'capture.clipboard':
      sendUI('shortcut', 'capture:clipboard');
      break;
    case 'session.save':
      sendUI('shortcut', 'session:save');
      break;
    case 'tab.stripToggle': {
      // cycles the strip placement, so the chord is useful without a settings visit
      const order: Array<'top' | 'left' | 'right' | 'bottom'> = ['top', 'left', 'bottom', 'right'];
      const next = order[(order.indexOf(rt.settings.general.tabStrip) + 1) % order.length];
      rt.settings.general.tabStrip = next;
      saveSettings(settingsFile, rt.settings);
      sendUI('tabstrip', { placement: next });
      break;
    }
    case 'view.translate':
      sendUI('shortcut', 'translate');
      break;
    case 'view.xray':
      rt.toggleXray();
      break;
  }
  return true;
}

// The shortcuts above can close several tabs at once; closeTab sends the stack notification.


/**
 * Where a new tab goes. Still `about:blank` by default; ticket 13 introduces the chrome start page
 * and this is the single place that decides, so the agent's snapshot never sees the start page as
 * a page.
 */
function tabStartUrl(): string {
  return 'about:blank';
}

/** The chord table in force: the user's remappings applied over the defaults. */
function chordTable(): Chord[] {
  const custom = toChords(rt.settings.keybindings);
  return custom.length ? custom : resolveChordTable();
}

/** The default table, kept as a function so keybindings.ts stays the single source of defaults. */
function resolveChordTable(): Chord[] {
  return toChords(defaultKeybindings());
}

/**
 * Run an action from the keybinding table by NAME. This is the one entry point for anything that
 * wants to trigger a bound action (a gesture, a Quick Commands row, a menu item), so a gesture can
 * never do something a chord cannot, and vice versa.
 *
 * It is implemented on top of the same switch runChord uses, reached by synthesising the chord that
 * is currently bound to the action — that keeps ONE dispatch table rather than two that can drift.
 */
function runAction(action: string): boolean {
  const c = chordTable().find((x) => x.action === action);
  if (!c) return false;
  return runChord({ key: c.key, control: c.ctrl, shift: c.shift, alt: c.alt, type: 'keyDown' });
}

return { installShortcuts, runChord, runAction, chordTable, tabStartUrl };
}

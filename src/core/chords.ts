/**
 * One table of chrome chords, in one place.
 *
 * Why a table: the chords are dispatched from main's `before-input-event` (a focused WebContentsView
 * does not reliably receive application-menu accelerators), but the same actions are also reachable
 * from the chrome UI and — from ticket 15 — from a user-remappable map. Ticket 15 edits THIS table
 * and nothing else.
 *
 * Every entry is a pure description: no page content is read, no page-supplied string is used as a
 * key, and `pageOnly` marks the chords that a *page* must never be able to trigger (the page sees
 * the keyboard too, so the gate is `before-input-event` on the tab's own WebContents).
 */

export type ChordAction =
  | 'tab.new'
  | 'tab.close'
  | 'tab.reopen'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.duplicate'
  | 'tab.closeOthers'
  | 'tab.mute'
  | 'tab.reload'
  | 'nav.back'
  | 'nav.forward'
  | 'nav.focusAddress'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'view.find'
  | 'view.print'
  | 'view.fullscreen'
  | 'library.history'
  | 'library.bookmarkPage'
  | 'library.toggleBar'
  | 'tiles.tile'
  | 'tiles.untile'
  // ---- wave 2 (tickets 14-33) ----
  | 'palette.open'
  | 'panel.history'
  | 'panel.bookmarks'
  | 'panel.downloads'
  | 'panel.sessions'
  | 'panel.workspaces'
  | 'reader.toggle'
  | 'capture.visible'
  | 'capture.full'
  | 'capture.clipboard'
  | 'session.save'
  | 'workspace.next'
  | 'tab.stripToggle'
  | 'view.translate';

export interface Chord {
  /** lower-case key as reported by Electron's input event ('t', '=', 'f6', 'tab', '1'..'9') */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: ChordAction;
  /** a digit chord: Ctrl+1..8 select a tab, Ctrl+9 the last one */
  digit?: boolean;
}

export const DEFAULT_CHORDS: Chord[] = [
  { key: 't', ctrl: true, action: 'tab.new' },
  { key: 'w', ctrl: true, action: 'tab.close' },
  { key: 't', ctrl: true, shift: true, action: 'tab.reopen' },
  { key: 'tab', ctrl: true, action: 'tab.next' },
  { key: 'tab', ctrl: true, shift: true, action: 'tab.prev' },
  { key: '=', ctrl: true, action: 'view.zoomIn' },
  { key: '+', ctrl: true, action: 'view.zoomIn' },
  { key: '-', ctrl: true, action: 'view.zoomOut' },
  { key: '0', ctrl: true, action: 'view.zoomReset' },
  { key: 'p', ctrl: true, action: 'view.print' },
  { key: 'f', ctrl: true, action: 'view.find' },
  { key: 'r', ctrl: true, action: 'tab.reload' },
  { key: 'f5', action: 'tab.reload' },
  { key: 'h', ctrl: true, action: 'library.history' },
  { key: 'd', ctrl: true, action: 'library.bookmarkPage' },
  { key: 'b', ctrl: true, shift: true, action: 'library.toggleBar' },
  { key: 's', ctrl: true, shift: true, action: 'tiles.tile' },
  { key: 'u', ctrl: true, shift: true, action: 'tiles.untile' },
  { key: 'l', ctrl: true, action: 'nav.focusAddress' },
  { key: 'f6', action: 'nav.focusAddress' },
  { key: 'left', alt: true, action: 'nav.back' },
  { key: 'right', alt: true, action: 'nav.forward' },
  { key: 'f11', action: 'view.fullscreen' },
  { key: 'q', ctrl: true, shift: true, action: 'tab.close' },
  // ---- wave 2 ----
  { key: 'e', ctrl: true, action: 'palette.open' },
  { key: 'f2', action: 'palette.open' },
  { key: 'h', ctrl: true, shift: true, action: 'panel.history' },
  { key: 'b', ctrl: true, action: 'panel.bookmarks' },
  { key: 'j', ctrl: true, shift: true, action: 'panel.downloads' },
  { key: 'r', ctrl: true, alt: true, action: 'reader.toggle' },
  { key: 'c', ctrl: true, shift: true, action: 'capture.visible' },
  { key: 'n', ctrl: true, shift: true, action: 'session.save' },
  { key: 'f9', action: 'tab.stripToggle' },
  { key: 't', ctrl: true, alt: true, action: 'view.translate' },
];

/** Ctrl+1..9: 1..8 select that tab, 9 selects the last one. */
export function digitChord(key: string): boolean {
  return /^[1-9]$/.test(key);
}

/**
 * Resolve an input event to an action. Modifiers must match exactly, so Ctrl+Shift+T never falls
 * through to Ctrl+T. Returns null when nothing matches (the page keeps the keystroke).
 */
export function resolveChord(
  input: { key: string; control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; type?: string },
  chords: Chord[] = DEFAULT_CHORDS,
): ChordAction | null {
  if (input.type !== undefined && input.type !== 'keyDown') return null;
  const ctrl = !!(input.control || input.meta);
  if (!ctrl && !input.alt) {
    // unmodified function keys are allowed (F5, F6, F11)
    if (!/^f\d+$/.test(input.key.toLowerCase())) return null;
  }
  const key = input.key.toLowerCase();
  for (const c of chords) {
    if (c.key !== key) continue;
    if (!!c.ctrl !== ctrl) continue;
    if (!!c.shift !== !!input.shift) continue;
    if (!!c.alt !== !!input.alt) continue;
    return c.action;
  }
  if (ctrl && !input.shift && !input.alt && digitChord(key)) return 'tab.next'; // caller maps the digit
  return null;
}

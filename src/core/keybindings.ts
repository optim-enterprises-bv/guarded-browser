// Remappable keybindings (ticket 15). One validated map action -> chord, which is the single source
// both main (chord dispatch) and the settings UI read. The chord TABLE in chords.ts defines the
// actions and their defaults; this module lets the user change the keys.
//
// Design: a binding is a lowercase-normalised chord string ("ctrl+shift+t", "f5", "alt+left").
// toChords() turns the map back into the Chord[] that resolveChord() already understands, so the
// dispatcher and the keymap cannot drift apart.

import { z } from 'zod';
import { DEFAULT_CHORDS, type Chord, type ChordAction } from './chords';

export const ALL_ACTIONS: ChordAction[] = [
  'tab.new',
  'tab.close',
  'tab.reopen',
  'tab.next',
  'tab.prev',
  'tab.duplicate',
  'tab.closeOthers',
  'tab.mute',
  'tab.reload',
  'nav.back',
  'nav.forward',
  'nav.focusAddress',
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomReset',
  'view.find',
  'view.print',
  'view.fullscreen',
  'library.history',
  'library.bookmarkPage',
  'library.toggleBar',
  'tiles.tile',
  'tiles.untile',
  'palette.open',
  'panel.history',
  'panel.bookmarks',
  'panel.downloads',
  'panel.sessions',
  'panel.workspaces',
  'reader.toggle',
  'capture.visible',
  'capture.full',
  'capture.clipboard',
  'session.save',
  'workspace.next',
  'tab.stripToggle',
  'view.translate',
  'mail.open',
  'view.xray',
  'view.chat',
];

/** Human labels for the settings UI. */
export const ACTION_LABELS: Record<ChordAction, string> = {
  'tab.new': 'New tab',
  'tab.close': 'Close tab',
  'tab.reopen': 'Reopen closed tab',
  'tab.next': 'Next tab',
  'tab.prev': 'Previous tab',
  'tab.duplicate': 'Duplicate tab',
  'tab.closeOthers': 'Close other tabs',
  'tab.mute': 'Mute tab',
  'tab.reload': 'Reload',
  'nav.back': 'Back',
  'nav.forward': 'Forward',
  'nav.focusAddress': 'Focus address bar',
  'view.zoomIn': 'Zoom in',
  'view.zoomOut': 'Zoom out',
  'view.zoomReset': 'Reset zoom',
  'view.find': 'Find in page',
  'view.print': 'Print',
  'view.fullscreen': 'Full screen',
  'library.history': 'History panel',
  'library.bookmarkPage': 'Bookmark this page',
  'library.toggleBar': 'Toggle bookmarks bar',
  'tiles.tile': 'Tile selected tabs',
  'tiles.untile': 'Untile',
  'palette.open': 'Quick Commands',
  'panel.history': 'History panel',
  'panel.bookmarks': 'Bookmarks panel',
  'panel.downloads': 'Downloads panel',
  'panel.sessions': 'Sessions panel',
  'panel.workspaces': 'Workspaces panel',
  'reader.toggle': 'Reader mode',
  'capture.visible': 'Capture visible area',
  'capture.full': 'Capture full page',
  'capture.clipboard': 'Capture to clipboard',
  'session.save': 'Save session…',
  'workspace.next': 'Next workspace',
  'tab.stripToggle': 'Cycle tab strip placement',
  'view.translate': 'Translate page',
  'mail.open': 'Open Mail',
  'view.xray': 'Injection X-ray',
  'view.chat': 'AI chat',
};

// ---------- chord string parsing ----------

const MOD_ORDER = ['ctrl', 'shift', 'alt'] as const;

/** Normalise a chord string; returns null when it is not a usable chord. */
export function parseChord(input: string): { key: string; ctrl: boolean; shift: boolean; alt: boolean } | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const parts = input
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  for (const m of mods) if (!(MOD_ORDER as readonly string[]).includes(m)) return null;
  if (!key) return null;
  // a bare letter must carry a modifier, or it would swallow typing
  const isFn = /^f\d+$/.test(key);
  const isNamed = ['left', 'right', 'up', 'down', 'tab', 'esc', 'escape', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'space'].includes(key);
  if (!mods.size && !isFn && !isNamed) return null;
  return { key, ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt') };
}

/** Canonical display form, mods in a stable order. */
export function formatChord(input: string): string {
  const p = parseChord(input);
  if (!p) return '';
  const mods = MOD_ORDER.filter((m) => p[m]).map((m) => m[0].toUpperCase() + m.slice(1));
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key[0].toUpperCase() + p.key.slice(1);
  return [...mods, key].join('+');
}

const chordKey = (c: { key: string; ctrl: boolean; shift: boolean; alt: boolean }) =>
  `${c.ctrl ? 'C' : ''}${c.shift ? 'S' : ''}${c.alt ? 'A' : ''}:${c.key}`;

/** The default map, derived from the chord table (first chord wins for a repeated action). */
export function defaultBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of DEFAULT_CHORDS) {
    if (out[c.action]) continue;
    const mods = MOD_ORDER.filter((m) => c[m]).map((m) => m[0].toUpperCase() + m.slice(1));
    const key = c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1);
    out[c.action] = [...mods, key].join('+');
  }
  for (const a of ALL_ACTIONS) if (!out[a]) out[a] = '';
  return out;
}

export const KeybindingsSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(z.string().max(64), z.string().max(64)),
  })
  .strict();

export type Keybindings = z.infer<typeof KeybindingsSchema>;

export const defaultKeybindings = (): Keybindings => ({ version: 1, bindings: defaultBindings() });

/**
 * Problems with a map: unknown action names, unparseable chords, and two actions sharing a chord.
 * Returned rather than thrown so the settings UI can show them next to the field.
 */
export function validateBindings(b: Record<string, string>): Array<{ action: string; problem: string }> {
  const problems: Array<{ action: string; problem: string }> = [];
  const seen = new Map<string, string>();
  for (const [action, chord] of Object.entries(b)) {
    if (!ALL_ACTIONS.includes(action as ChordAction)) {
      problems.push({ action, problem: 'unknown action' });
      continue;
    }
    if (!chord) continue; // an unbound action is allowed
    const parsed = parseChord(chord);
    if (!parsed) {
      problems.push({ action, problem: `not a usable chord: ${chord}` });
      continue;
    }
    const k = chordKey(parsed);
    const other = seen.get(k);
    if (other) problems.push({ action, problem: `also bound to ${ACTION_LABELS[other as ChordAction] ?? other}` });
    else seen.set(k, action);
  }
  return problems;
}

/**
 * The map as the Chord[] the dispatcher uses. Unbound actions and invalid chords are dropped, so a
 * broken settings file degrades to "that action has no key" rather than a dead keyboard.
 */
export function toChords(b: Keybindings): Chord[] {
  const out: Chord[] = [];
  for (const [action, chord] of Object.entries(b.bindings)) {
    if (!ALL_ACTIONS.includes(action as ChordAction)) continue;
    const p = parseChord(chord);
    if (!p) continue;
    out.push({ key: p.key, ctrl: p.ctrl || undefined, shift: p.shift || undefined, alt: p.alt || undefined, action: action as ChordAction });
  }
  return out;
}

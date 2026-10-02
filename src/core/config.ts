// Settings file (settings.json in userData). Three model roles, each with an optional cloud fallback.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_FEEDS, type FeedConfig } from './reputation';
import { AppearanceSchema, defaultAppearance, type Appearance } from './theme';
import { SearchSettingsSchema, defaultSearch, type SearchSettings } from './search';
import { KeybindingsSchema, defaultKeybindings, type Keybindings } from './keybindings';
import { HibernationSettingsSchema, defaultHibernation, type HibernationSettings } from './hibernation';
import { TranslateSettingsSchema, defaultTranslate, type TranslateSettings } from '../main/translate';

export interface Endpoint {
  baseURL: string;
  model: string;
  /** name of the environment variable holding the API key (the key itself is never stored) */
  apiKeyEnv?: string;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface RoleConfig {
  primary: Endpoint;
  fallback: Endpoint & { enabled: boolean };
}

export type Role = 'planner' | 'reader' | 'judge';

export interface Settings {
  models: Record<Role, RoleConfig>;
  agent: {
    maxSteps: number;
    taskTimeoutMs: number;
    confirmTimeoutMs: number;
  };
  guard: {
    enabled: boolean;
    model: string;
    threshold: number;
    threads: number;
  };
  egress: {
    /** hosts (host or host:port) always blocked, also during manual browsing */
    denylist: string[];
  };
  reputation: {
    enabled: boolean;
    feeds: FeedConfig[];
    /** optional provider, off by default; the key is read only from this env var */
    safeBrowsing: { enabled: boolean; apiKeyEnv: string };
  };
  /** chrome themes; validated with AppearanceSchema on load and on every save */
  appearance: Appearance;
  /** general browsing behaviour: what a new launch does and how the address bar searches */
  general: {
    /** 'blank' = one blank tab; 'last-session' = restore the previous tab set */
    startup: 'blank' | 'last-session';
    search: SearchSettings;
    /** the left icon rail + panel column (ticket 17) */
    railVisible: boolean;
    /** the bottom status bar (ticket 28) */
    statusBar: boolean;
    /** sidebar web panels (ticket 18): sites pinned into the panel column, with their width. A
     *  panel is a website — it uses the profile session and is gated like a tab — so this is only
     *  the LIST, never any security state. */
    webPanels: Array<{ url: string; title: string }>;
    /** tab strip placement (ticket 21); the shipped default is horizontal at the top */
    tabStrip: 'top' | 'left' | 'right' | 'bottom';
  };
  /** remappable chords (ticket 15), validated by keybindings.ts */
  keybindings: Keybindings;
  /** mouse gestures in pages (ticket 16) */
  gestures: { enabled: boolean };
  /** tab hibernation (ticket 23) — off by default, and never touches a gated tab */
  hibernation: HibernationSettings;
  /** translate (ticket 25) — DISABLED by default: page text leaves the machine when it is used */
  translate: TranslateSettings;
  /** unpacked extensions (ticket 32) — outside the threat model, warned about in the UI */
  extensions: { enabled: boolean };
}

const localEndpoint = (): Endpoint => ({
  baseURL: 'http://127.0.0.1:1234/v1',
  model: 'default',
  extraBody: { enable_thinking: false },
  timeoutMs: 120_000,
});

const disabledFallback = (): RoleConfig['fallback'] => ({
  enabled: false,
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKeyEnv: 'OPENAI_API_KEY',
  timeoutMs: 60_000,
});

export function defaultSettings(): Settings {
  const role = (): RoleConfig => ({ primary: localEndpoint(), fallback: disabledFallback() });
  return {
    models: { planner: role(), reader: role(), judge: role() },
    agent: { maxSteps: 20, taskTimeoutMs: 10 * 60_000, confirmTimeoutMs: 120_000 },
    guard: { enabled: true, model: 'protectai/deberta-v3-base-prompt-injection-v2', threshold: 0.5, threads: 2 },
    egress: { denylist: ['doubleclick.net', 'google-analytics.com', 'googletagmanager.com'] },
    reputation: {
      enabled: true,
      feeds: DEFAULT_FEEDS.map((f) => ({ ...f })),
      safeBrowsing: { enabled: false, apiKeyEnv: 'GOOGLE_SAFE_BROWSING_API_KEY' },
    },
    appearance: defaultAppearance(),
    general: { startup: 'blank', search: defaultSearch(), railVisible: true, statusBar: true, tabStrip: 'top', webPanels: [] },
    keybindings: defaultKeybindings(),
    gestures: { enabled: true },
    hibernation: defaultHibernation(),
    translate: defaultTranslate(),
    extensions: { enabled: true },
  };
}

/** a cap on saved panels: each one is a live WebContents, so the list is bounded */
export const MAX_WEB_PANELS = 12;

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    const s = defaultSettings();
    saveSettings(file, s);
    return s;
  }
  try {
    const s = merge(defaultSettings(), JSON.parse(readFileSync(file, 'utf8')));
    // a hand-edited settings file must not smuggle an invalid theme into the UI
    const a = AppearanceSchema.safeParse(s.appearance);
    s.appearance = a.success ? a.data : defaultAppearance();
    // ...nor an invalid search engine / startup mode
    const g = SearchSettingsSchema.safeParse(s.general?.search);
    const TABSTRIPS = new Set(['top', 'left', 'right', 'bottom']);
    s.general = {
      startup: s.general?.startup === 'last-session' ? 'last-session' : 'blank',
      search: g.success ? g.data : defaultSearch(),
      railVisible: s.general?.railVisible !== false,
      statusBar: s.general?.statusBar !== false,
      tabStrip: TABSTRIPS.has(String(s.general?.tabStrip)) ? (s.general!.tabStrip as 'top') : 'top',
      // A hand-edited or imported settings file must not inject a panel that is not an http(s) site:
      // a panel IS a page in the profile's session, so its URL is validated exactly like a tab's.
      webPanels: Array.isArray(s.general?.webPanels)
        ? (s.general!.webPanels as Array<{ url?: unknown; title?: unknown }>)
            .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
            .slice(0, MAX_WEB_PANELS)
            .map((x) => ({ url: String(x.url).slice(0, 2048), title: String(x.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) }))
        : [],
    };
    // a hand-edited file must not inject an action name or a chord that cannot be parsed
    const kb = KeybindingsSchema.safeParse(s.keybindings);
    s.keybindings = kb.success ? { version: 1, bindings: { ...defaultKeybindings().bindings, ...kb.data.bindings } } : defaultKeybindings();
    const hib = HibernationSettingsSchema.safeParse(s.hibernation);
    s.hibernation = hib.success ? hib.data : defaultHibernation();
    const tr = TranslateSettingsSchema.safeParse(s.translate);
    // a settings file cannot turn translate on by itself: the user must do it in the UI. Anything
    // that fails validation, or arrives enabled without an endpoint, falls back to off.
    s.translate = tr.success ? tr.data : defaultTranslate();
    s.gestures = { enabled: s.gestures?.enabled !== false };
    s.extensions = { enabled: s.extensions?.enabled !== false };
    return s;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(file: string, s: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

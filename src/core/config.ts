// Settings file (settings.json in userData). Four model roles, each with an optional cloud fallback.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, loadJson } from './persist';
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

/**
 * `chat` (AI capabilities item 2) is quarantined like the reader: page text in, text out, no tools.
 * `triage` (item 4) is the same kind of role for mail: ONE message's typed, capped, screened fields in,
 * strict JSON (or a reply draft) out, no tools. It is the only role that ever sees mail text.
 */
export type Role = 'planner' | 'reader' | 'judge' | 'chat' | 'triage';

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
  /** "Allow other AI agents (MCP)" (item 3): OFF by default; the server runs only while this is on */
  mcp: { enabled: boolean };
  /**
   * Phone approvals over Telegram (item 3): OFF by default. `scope` 'mcp' (default) sends only
   * confirmations of MCP tasks; 'all' every agent-task confirmation. The bot token is NOT here: it
   * lives in phone-secret.json (0600) next to this file and never reaches the renderer.
   */
  phone: { enabled: boolean; scope: 'mcp' | 'all'; chatId: string };
  /**
   * Watchers (item 5): which runner opens the watched pages. 'electron' (default) is a hidden
   * offscreen window in a throwaway session; 'external' drives a SEPARATELY INSTALLED headless
   * browser (e.g. Lightpanda) over CDP — never bundled — at `externalPath`, started per run.
   */
  watchers: { runner: 'electron' | 'external'; externalPath: string; flavor: 'lightpanda' | 'chromium'; timeoutSec: number };
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
    models: { planner: role(), reader: role(), judge: role(), chat: role(), triage: role() },
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
    mcp: { enabled: false },
    phone: { enabled: false, scope: 'mcp', chatId: '' },
    watchers: { runner: 'electron', externalPath: '', flavor: 'lightpanda', timeoutSec: 60 },
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

/** Top level of settings.json: an object. Everything inside is validated field by field below. */
const SettingsFileSchema = z.object({}).passthrough();

/**
 * Load a profile's settings. With `onLoadError`, an unreadable file is quarantined (kept as
 * settings.json.corrupt-<time>, see core/persist.ts) and the message is reported; without it the
 * file is only read (main.ts peeks at the first profile's settings before its runtime exists).
 */
export function loadSettings(file: string, opts: { onLoadError?: (message: string) => void } = {}): Settings {
  if (!existsSync(file)) {
    const s = defaultSettings();
    saveSettings(file, s);
    return s;
  }
  try {
    let raw: unknown;
    if (opts.onLoadError) {
      const r = loadJson<unknown>(file, SettingsFileSchema, { fallback: undefined });
      if (r.loadError) {
        opts.onLoadError(r.loadError);
        return defaultSettings();
      }
      raw = r.value;
    } else raw = JSON.parse(readFileSync(file, 'utf8'));
    const s = merge(defaultSettings(), raw);
    s.models.chat = chatRole((raw as { models?: { chat?: unknown } } | undefined)?.models?.chat, s.models.chat, s.models.reader);
    // item 4: a file from before the triage role gets the same treatment (its reader, fallback OFF:
    // sending mail text to a cloud provider is a separate, explicit opt-in)
    s.models.triage = chatRole((raw as { models?: { triage?: unknown } } | undefined)?.models?.triage, s.models.triage, s.models.reader);
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
    // both are opt-in: only an explicit `true` turns them on
    s.mcp = { enabled: s.mcp?.enabled === true };
    s.phone = {
      enabled: s.phone?.enabled === true,
      scope: s.phone?.scope === 'all' ? 'all' : 'mcp',
      chatId: /^\d{1,20}$/.test(String(s.phone?.chatId ?? '')) ? String(s.phone.chatId) : '',
    };
    s.watchers = normalizeWatcherSettings(s.watchers);
    return s;
  } catch {
    return defaultSettings();
  }
}

const isEndpoint = (e: unknown): e is Endpoint =>
  !!e && typeof e === 'object' && typeof (e as Endpoint).baseURL === 'string' && /^https?:\/\//i.test((e as Endpoint).baseURL) && typeof (e as Endpoint).model === 'string';

/**
 * Settings migration for the `chat` role (and, with the same rule, the `triage` role of item 4). A file written before the role existed (no `models.chat`),
 * or one whose chat entry is unusable, gets a copy of that file's READER role — the user's local
 * model — with the cloud fallback OFF: sending page text to a provider for chat is a separate
 * opt-in. A valid chat entry is kept as merged.
 */
export function chatRole(rawChat: unknown, merged: RoleConfig, reader: RoleConfig): RoleConfig {
  const fb = (merged as Partial<RoleConfig> | undefined)?.fallback;
  if (rawChat && typeof rawChat === 'object' && isEndpoint(merged?.primary) && isEndpoint(fb) && typeof fb.enabled === 'boolean') return merged;
  const copy = JSON.parse(JSON.stringify(reader)) as RoleConfig;
  return { primary: copy.primary, fallback: { ...copy.fallback, enabled: false } };
}

/** The watcher runner settings, validated: the external runner only with an absolute path. */
export function normalizeWatcherSettings(w: unknown): Settings['watchers'] {
  const r = (w ?? {}) as Record<string, unknown>;
  const path = typeof r.externalPath === 'string' && r.externalPath.startsWith('/') ? r.externalPath.replace(/[\u0000-\u001f]/g, '').slice(0, 1024) : '';
  const t = Number(r.timeoutSec);
  return {
    runner: r.runner === 'external' && path ? 'external' : 'electron',
    externalPath: path,
    flavor: r.flavor === 'chromium' ? 'chromium' : 'lightpanda',
    timeoutSec: Number.isInteger(t) && t >= 10 && t <= 600 ? t : 60,
  };
}

export function saveSettings(file: string, s: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify(s, null, 2) + '\n');
}

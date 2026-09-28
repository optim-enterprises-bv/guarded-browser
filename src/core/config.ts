// Settings file (settings.json in userData). Three model roles, each with an optional cloud fallback.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_FEEDS, type FeedConfig } from './reputation';
import { AppearanceSchema, defaultAppearance, type Appearance } from './theme';

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
  };
}

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
    return s;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(file: string, s: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

// Watchers for ONE profile (item 5): scheduling, runs, history, notifications, the element picker and
// the runner setting.
//
// A run happens only when no agent task or recipe replay is running and no confirmation is pending
// (and is cancelled if a task starts meanwhile), one at a time. Each run gets:
//   * its own egress proxy instance (core/egress.ts startProxy) in task mode, with this profile's
//     denylist, reputation lists and refused proxy ports, and the watcher's origins as the allowlist;
//   * a throwaway in-memory session (ElectronOffscreenRunner) or a separately installed headless
//     browser started for the run (ExternalCdpRunner), pointed at that proxy;
//   * read-only network rules: GET / HEAD / OPTIONS to the watcher's origins only.
// Nothing a run returns is page text except an element-text watcher's capped value; the audit log
// gets numbers or a hash, never text. Notifications never contain page text.

import { Notification } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { EgressController, hostKey, startProxy } from '../../core/egress';
import { PICKER_JS, textHash, toCandidate, toLocator, toPageInfo, watchTyped, type WatchKind } from '../../core/locator';
import { originOf } from '../../core/policy';
import { TaintRegistry } from '../../core/taint';
import { ExternalCdpRunner, checkBinary, type WatchRunResult, type WatcherRunner } from '../../core/watch-runner';
import {
  WatcherScheduler,
  WatcherStore,
  describeCondition,
  evaluateCondition,
  notificationText,
  shouldNotify,
  watcherFromRecipe,
  watcherOrigins,
  type HistoryEntry,
  type Watcher,
} from '../../core/watcher';
import { normalizeWatcherSettings, saveSettings } from '../../core/config';
import { ElectronOffscreenRunner } from '../offscreen-runner';
import { ISOLATED_WORLD } from '../page-scripts';
import { testEnv } from '../test-hooks';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';
import type { RecipeStore } from '../../core/recipe';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps, recipes: RecipeStore) {
  const store = new WatcherStore(join(rt.profileDir, 'watchers.json'));
  const audit = (detail: Record<string, unknown>) => rt.audit.write('watcher', detail);
  let active: { id: string; abort: AbortController } | null = null;
  const electron = new ElectronOffscreenRunner({ profileSession: () => rt.profileSession(), audit: (d) => audit(d) });

  function runnerState() {
    const w = rt.settings.watchers;
    const check = checkBinary(w.externalPath);
    return {
      runner: w.runner === 'external' && check.ok ? 'external' : 'electron',
      externalPath: w.externalPath,
      flavor: w.flavor,
      timeoutSec: w.timeoutSec,
      externalAvailable: check.ok,
      externalReason: check.ok ? '' : check.reason,
    };
  }
  function pickRunner(w: Watcher): WatcherRunner {
    const s = runnerState();
    // "use my login" needs cookies, which the external runner never gets
    if (s.runner === 'external' && !w.config.useLogin) return new ExternalCdpRunner({ path: s.externalPath, flavor: s.flavor });
    return electron;
  }

  function blocker(): string | null {
    if (rt.current) return 'an agent task or a recipe replay is running';
    if (rt.broker.pendingCount() > 0) return 'a confirmation is pending';
    if (active) return 'another watcher is running';
    return null;
  }

  function view(w: Watcher) {
    return {
      id: w.id,
      name: w.config.name,
      url: w.config.urls[w.config.urls.length - 1],
      urls: w.config.urls,
      origins: watcherOrigins(w.config),
      recipeId: w.config.recipeId ?? null,
      kind: w.config.kind,
      condition: describeCondition(w.config.condition),
      everyMinutes: w.config.everyMinutes,
      notify: w.config.notify,
      useLogin: w.config.useLogin,
      paused: w.config.paused,
      running: active?.id === w.id,
      nextRunAt: w.state.nextRunAt,
      failures: w.state.failures,
      lastValue: w.state.lastValue,
      history: [...w.state.history].reverse(),
    };
  }
  const push = () => rt.sendUI('watchers', { watchers: store.list().map(view), runner: runnerState(), waiting: waiting });
  let waiting: string | null = null;

  function notifyDesktop(title: string, body: string) {
    // TEST ONLY (GUARDED_TEST=1, unpackaged): every notification is also appended to this file
    const file = testEnv('GUARDED_TEST_NOTIFY_FILE');
    if (file) appendFileSync(file, `${JSON.stringify({ title, body, at: Date.now() })}\n`);
    try {
      if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
    } catch {
      /* no notification daemon: the history and the audit line still record it */
    }
  }

  async function runOne(w: Watcher, why: 'schedule' | 'run now') {
    const abort = new AbortController();
    active = { id: w.id, abort };
    push();
    const origins = watcherOrigins(w.config);
    // the run's own proxy: this profile's rules, task mode, the watcher's origins as the allowlist
    const ctl = new EgressController(rt.settings.egress.denylist, (e) => rt.audit.write('egress', { watcher: w.id, ...e }));
    if (rt.settings.reputation.enabled) ctl.reputation = rt.reputation;
    ctl.setRefusedPorts(rt.egress.refusedPortList());
    ctl.startTask(origins, new TaintRegistry(''));
    const proxy = await startProxy(ctl);
    const runner = pickRunner(w);
    const started = Date.now();
    let r: WatchRunResult;
    try {
      r = await runner.run({
        urls: w.config.urls,
        origins,
        locator: w.config.locator,
        kind: w.config.kind,
        expect: w.config.expect,
        proxyUrl: `http://127.0.0.1:${proxy.port}`,
        timeoutMs: rt.settings.watchers.timeoutSec * 1000,
        signal: abort.signal,
        useLogin: w.config.useLogin,
        requestFilter: (method, url) => {
          if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            ctl.auditWebRequest({ host: hostKey(url) ?? '?', method, url: url.slice(0, 300), decision: 'block', reason: 'watchers are read-only: only GET / HEAD / OPTIONS' });
            return 'watchers are read-only';
          }
          const rep = ctl.reputationCheck(url);
          if (rep) {
            ctl.auditReputation(rep, method, url, 'webrequest', 'blocked (watcher run)');
            return `${rep.host} is listed as malicious`;
          }
          const o = originOf(url);
          const key = hostKey(url) ?? '';
          if (!ctl.hostPasses(key)) {
            ctl.decideHost(key, method, url); // audited as a block, like the proxy would
            return `${o ?? key} is not one of this watcher's origins`;
          }
          return null;
        },
      });
    } catch (e) {
      r = { ok: false, error: String((e as Error).message).slice(0, 300), runner: runner.name, session: '?' };
    } finally {
      await proxy.close();
      active = null;
    }
    const prev = { met: w.state.lastMet, value: w.state.lastValue };
    const value = r.ok ? r.value : null;
    const met = r.ok ? evaluateCondition(w.config.condition, value, w.state.history.length ? w.state.lastValue : null) : false;
    const notify = r.ok && shouldNotify(w.config.condition, met, value, prev);
    const entry: HistoryEntry = { at: Date.now(), value, met, notified: notify, runner: r.runner, ...(r.ok ? {} : { error: r.error.slice(0, 300) }) };
    const after = store.record(w.id, entry);
    // the audit line: numbers as they are, text as a hash, never the text
    audit({
      watcher: w.id,
      why,
      runner: r.runner,
      session: r.session,
      ok: r.ok,
      ms: Date.now() - started,
      kind: w.config.kind,
      ...(r.ok ? { value: typeof value === 'number' ? value : w.config.kind === 'text-hash' ? value : textHash(String(value)) } : { error: r.error, divergence: r.ok ? undefined : r.divergence }),
      met,
      notified: notify,
      failures: after?.state.failures ?? 0,
      nextRunAt: after?.state.nextRunAt,
    });
    if (notify && after) {
      const n = notificationText(after, value);
      if (w.config.notify.desktop) notifyDesktop(n.title, n.body);
      if (w.config.notify.telegram) void rt.phoneNotify(`${n.title}: ${n.body}`);
    }
    push();
  }

  const tickMs = Number(testEnv('GUARDED_TEST_WATCH_TICK_MS') ?? 30_000) || 30_000;
  const scheduler = new WatcherScheduler({ list: () => store.list(), blocker, run: (w) => runOne(w, w.state.nextRunAt === 0 ? 'run now' : 'schedule'), tickMs });
  async function tick() {
    const r = await scheduler.tick();
    const next = r && 'waiting' in r && r.waiting !== 'a watcher is running' ? r.waiting : null;
    if (next !== waiting) {
      waiting = next;
      push();
    }
    return r;
  }
  const timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();

  // ------------------------------------------------------------------ chrome IPC

  on('watcher:list', () => ({ watchers: store.list().map(view), runner: runnerState(), waiting }));

  /** the isolated-world picker on the active tab: returns a draft (URL, locator, a sample value) */
  on('watcher:pick', async () => {
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    if (rt.current?.tab === t) return { ok: false, error: 'the agent is using this tab' };
    const url = t.wc.getURL();
    if (!originOf(url)) return { ok: false, error: 'open an http(s) page first' };
    let raw: unknown;
    try {
      raw = await t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: PICKER_JS }]);
    } catch {
      return { ok: false, error: 'the page could not be picked from' };
    }
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'cancelled' };
    const r = raw as { candidate?: unknown; text?: unknown };
    const c = toCandidate({ ...((r.candidate as object) ?? {}), ref: '' });
    if (!c) return { ok: false, error: 'that element cannot be watched' };
    let locator;
    try {
      locator = toLocator(c);
    } catch {
      return { ok: false, error: 'that element cannot be watched' };
    }
    const page = toPageInfo(raw, url);
    const sample = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const guess: WatchKind = watchTyped('number', sample) !== null ? 'number' : 'text-hash';
    return { ok: true, draft: { url: page.url, title: page.title, heading: page.heading, locator, sample, number: watchTyped('number', sample), kind: guess } };
  });

  on('watcher:create', (_e, raw: unknown) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    let config: Record<string, unknown> = { ...d };
    if (typeof d.recipeId === 'string' && d.recipeId) {
      const rec = recipes.get(d.recipeId);
      if (!rec) return { ok: false, error: 'no such recipe' };
      const fr = watcherFromRecipe(rec);
      if (!fr.ok) return fr;
      config = { ...config, urls: fr.urls, locator: fr.locator, expect: fr.expect, recipeId: rec.id };
    }
    const r = store.create({
      name: config.name,
      urls: config.urls,
      ...(config.recipeId ? { recipeId: config.recipeId } : {}),
      ...(config.expect ? { expect: config.expect } : {}),
      locator: config.locator,
      kind: config.kind,
      condition: config.condition,
      everyMinutes: config.everyMinutes,
      notify: config.notify,
      useLogin: config.useLogin === true,
      paused: false,
    });
    if (!r.ok) return r;
    audit({ what: 'created', watcher: r.watcher.id, origins: watcherOrigins(r.watcher.config), kind: r.watcher.config.kind, condition: r.watcher.config.condition.kind, everyMinutes: r.watcher.config.everyMinutes, useLogin: r.watcher.config.useLogin, fromRecipe: !!r.watcher.config.recipeId });
    push();
    return { ok: true, watcher: view(r.watcher) };
  });
  on('watcher:update', (_e, id: unknown, patch: unknown) => {
    const r = store.update(String(id), (patch ?? {}) as Record<string, unknown>);
    if (r.ok) {
      audit({ what: 'updated', watcher: r.watcher.id, paused: r.watcher.config.paused, useLogin: r.watcher.config.useLogin });
      push();
      return { ok: true, watcher: view(r.watcher) };
    }
    return r;
  });
  on('watcher:delete', (_e, id: unknown) => {
    if (active?.id === String(id)) active.abort.abort();
    const ok = store.remove(String(id));
    if (ok) {
      audit({ what: 'deleted', watcher: String(id) });
      push();
    }
    return { ok };
  });
  on('watcher:run-now', async (_e, id: unknown) => {
    if (!store.runSoon(String(id), 0)) return { ok: false, error: 'no such watcher' };
    const b = blocker();
    if (b) {
      waiting = b;
      push();
      return { ok: true, waiting: `${b}: it runs as soon as that ends` };
    }
    await tick();
    return { ok: true };
  });
  on('watcher:runner', () => runnerState());
  on('watcher:runner-set', (_e, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>;
    const next = normalizeWatcherSettings({ ...rt.settings.watchers, ...p });
    if (p.runner === 'external' && !checkBinary(next.externalPath).ok) {
      rt.settings.watchers = { ...next, runner: 'electron' };
      saveSettings(rt.settingsFile, rt.settings);
      push();
      return { ok: false, error: `the external browser cannot be used: ${checkBinary(next.externalPath).ok ? '' : (checkBinary(next.externalPath) as { reason: string }).reason}`, ...runnerState() };
    }
    rt.settings.watchers = next;
    saveSettings(rt.settingsFile, rt.settings);
    audit({ what: 'runner', runner: next.runner, flavor: next.flavor, hasPath: !!next.externalPath });
    push();
    return { ok: true, ...runnerState() };
  });

  return {
    /** an agent task or replay is starting: a running watcher stops now */
    onTaskStart() {
      active?.abort.abort();
    },
    /** a task or a confirmation just ended: a waiting run may go */
    poke() {
      void tick();
    },
    dispose() {
      clearInterval(timer);
      active?.abort.abort();
    },
  };
}

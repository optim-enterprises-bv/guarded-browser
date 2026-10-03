// The default watcher runner (item 5): a hidden, offscreen BrowserWindow in a FRESH in-memory
// partition (no `persist:`; the same throwaway-session rule as an MCP task's tab), behind the run's
// egress proxy. JavaScript on, images off, audio muted, no preload, no permissions, no popups, no
// downloads; destroyed with its session data after the run. Requests are read-only (GET / HEAD /
// OPTIONS) and limited to the watcher's origins (job.requestFilter); a navigation or redirect to any
// other origin ends the run. "Use my login" copies this profile's cookies for the watcher's origins
// INTO the throwaway session — the profile's own session is never used and nothing flows back.

import { BrowserWindow, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { extractJs } from '../core/locator';
import { originOf } from '../core/policy';
import { judgeExtraction, toPageEval, type WatchJob, type WatchRunResult, type WatcherRunner } from '../core/watch-runner';
import { ISOLATED_WORLD } from './page-scripts';

export interface OffscreenRunnerOptions {
  /** this profile's session: only read, and only for "use my login" cookies */
  profileSession: () => Session;
  /** audit lines (never page text) */
  audit: (detail: Record<string, unknown>) => void;
}

export class ElectronOffscreenRunner implements WatcherRunner {
  readonly name = 'electron';

  constructor(private readonly o: OffscreenRunnerOptions) {}

  available() {
    return { ok: true as const };
  }

  async run(job: WatchJob): Promise<WatchRunResult> {
    const partition = `watch-${randomUUID()}`;
    const label = `ephemeral ${partition}${job.useLogin ? ' (with your cookies for these sites)' : ''}`;
    const fail = (error: string, divergence?: string): WatchRunResult => ({ ok: false, error: error.slice(0, 300), ...(divergence ? { divergence } : {}), runner: this.name, session: label });
    const ses = session.fromPartition(partition);
    let win: BrowserWindow | null = null;
    // set from event handlers; read after each await
    const seen = { d: null as { kind: string; detail: string } | null };
    const diverged = () => seen.d as { kind: string; detail: string } | null;
    const diverge = (kind: string, detail: string) => {
      seen.d ??= { kind, detail: detail.slice(0, 200) };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ses.setProxy({ proxyRules: job.proxyUrl.replace(/^http:\/\//, ''), proxyBypassRules: '<-loopback>' });
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
        if (!/^(https?|wss?):/i.test(d.url)) return cb({});
        const why = job.requestFilter?.(d.method, d.url) ?? null;
        if (why) {
          if (d.resourceType === 'mainFrame') diverge('new-origin', why);
          return cb({ cancel: true });
        }
        cb({});
      });
      ses.on('will-download', (e, item) => {
        e.preventDefault();
        item.cancel();
        diverge('download', 'the page started a download');
      });
      ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
      if (job.useLogin) {
        let copied = 0;
        for (const origin of job.origins) {
          for (const c of await this.o.profileSession().cookies.get({ url: origin })) {
            await ses.cookies
              .set({
                url: `${origin}${c.path ?? '/'}`,
                name: c.name,
                value: c.value,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite,
                ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
                ...(c.hostOnly ? {} : { domain: c.domain }),
              })
              .then(() => copied++)
              .catch(() => undefined);
          }
        }
        this.o.audit({ what: 'cookies copied into the run session', count: copied, origins: job.origins });
      }
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          offscreen: true,
          partition,
          images: false,
          javascript: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webgl: false,
          spellcheck: false,
          backgroundThrottling: false,
          autoplayPolicy: 'user-gesture-required',
          devTools: false,
        },
      });
      const wc = win.webContents;
      wc.setAudioMuted(true);
      wc.setWindowOpenHandler(({ url }) => {
        diverge('popup', `the page tried to open ${originOf(url) ?? 'a window'}`);
        return { action: 'deny' };
      });
      const guard = (e: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
        if (!e.isMainFrame) return;
        const o = originOf(e.url);
        if (o && job.origins.includes(o)) return;
        e.preventDefault();
        diverge('new-origin', `the page went to ${o ?? 'a non-web URL'}`);
      };
      wc.on('will-navigate', guard);
      wc.on('will-redirect', guard);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(job.timeoutMs / 1000)} s`)), job.timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => job.signal.addEventListener('abort', () => reject(new Error('cancelled (an agent task started)')), { once: true }));
      deadline.catch(() => undefined);
      aborted.catch(() => undefined);
      if (job.signal.aborted) throw new Error('cancelled (an agent task started)');
      const work = async (): Promise<WatchRunResult> => {
        for (const url of job.urls) {
          try {
            await wc.loadURL(url);
          } catch (e) {
            if (seen.d) break;
            return fail(`could not open ${url}: ${String((e as Error).message).slice(0, 120)}`);
          }
          if (seen.d) break;
        }
        const d1 = diverged();
        if (d1) return fail(d1.detail, d1.kind);
        const raw = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: extractJs(job.locator, true) }]);
        const d2 = diverged();
        if (d2) return fail(d2.detail, d2.kind);
        return judgeExtraction(job, toPageEval(raw), this.name, label);
      };
      return await Promise.race([work(), deadline, aborted]);
    } catch (e) {
      return fail(String((e as Error).message ?? e));
    } finally {
      clearTimeout(timer);
      if (win && !win.isDestroyed()) win.destroy();
      await ses.clearStorageData().catch(() => undefined);
      await ses.clearCache().catch(() => undefined);
      await ses.clearAuthCache().catch(() => undefined);
      await ses.closeAllConnections().catch(() => undefined);
    }
  }
}

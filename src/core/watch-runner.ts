// How a watcher run reaches a page (item 5, "Lightpanda idea 4"): a pluggable WatcherRunner.
//
//   ElectronOffscreenRunner (src/main/offscreen-runner.ts, the default): a hidden offscreen
//     WebContents in a fresh in-memory partition behind a per-run egress proxy.
//   ExternalCdpRunner (here; Node only, no Electron): a SEPARATELY INSTALLED headless browser driven
//     over the Chrome DevTools Protocol — e.g. Lightpanda. It is never bundled, vendored or
//     downloaded by this project (Lightpanda is AGPL-3.0; this repository is Apache-2.0): the user
//     installs it and gives its path. Each run starts it with an explicit HTTP proxy argument pointing
//     at the run's egress proxy, listening on 127.0.0.1 on a random port, with a fresh temporary
//     directory as its home / profile, and kills it afterwards. It gets no cookies. Only the
//     extraction result crosses back: the locator is matched INSIDE that browser (extractJs) and the
//     one matched element's capped text is reduced here to a number, a hash or a capped text.

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { extractJs, landmarksMatch, watchTyped, type ElementLocator, type PageExpect, type WatchKind } from './locator';
import { originOf } from './policy';

export interface WatchJob {
  /** opened in order; the value is read on the last page */
  urls: string[];
  /** the run's allowlist: a page on any other origin ends the run */
  origins: string[];
  locator: ElementLocator;
  kind: WatchKind;
  expect?: PageExpect;
  /** the run's egress proxy (http://127.0.0.1:<port>) */
  proxyUrl: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** copy the profile's cookies for `origins` into the run's session (Electron runner only) */
  useLogin: boolean;
  /** Electron runner: refuse a request (read-only, allowlist, reputation); returns why, or null */
  requestFilter?: (method: string, url: string) => string | null;
}

export type WatchRunResult =
  | { ok: true; value: number | string; runner: string; session: string }
  | { ok: false; error: string; divergence?: string; runner: string; session: string };

export interface WatcherRunner {
  readonly name: string;
  available(): { ok: true } | { ok: false; reason: string };
  run(job: WatchJob): Promise<WatchRunResult>;
}

/** What extractJs returns from the page (re-validated here: it is page-produced data). */
export interface PageEval {
  url: string;
  title: string;
  heading: string;
  count: number;
  text: string;
}

export function toPageEval(raw: unknown): PageEval | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  if (typeof r.count !== 'number' || !Number.isFinite(r.count)) return null;
  return { url: s(r.url, 2048), title: s(r.title, 160), heading: s(r.heading, 160), count: Math.max(0, Math.floor(r.count)), text: s(r.text, 300) };
}

/** The common verdict of both runners on what the page returned. */
export function judgeExtraction(job: WatchJob, ev: PageEval | null, runner: string, session: string): WatchRunResult {
  const fail = (error: string, divergence?: string): WatchRunResult => ({ ok: false, error, ...(divergence ? { divergence } : {}), runner, session });
  if (!ev) return fail('the page returned nothing readable');
  const o = originOf(ev.url);
  if (!o || !job.origins.includes(o)) return fail(`the page ended on ${o ?? 'a non-web page'}, not on the watcher's origins`, 'new-origin');
  if (job.expect) {
    const lm = landmarksMatch(job.expect, ev);
    if (lm) return fail(lm, 'landmark-missing');
  }
  if (ev.count === 0) return fail('the watched element is not on the page (the locator matches 0 elements)', 'locator-none');
  if (ev.count > 1) return fail(`the watched element is ambiguous (the locator matches ${ev.count} elements)`, 'locator-many');
  const value = watchTyped(job.kind, ev.text);
  if (value === null) return fail(`the element's text is not a ${job.kind === 'number' ? 'number' : 'text'}`, 'extract-failed');
  return { ok: true, value, runner, session };
}

// ------------------------------------------------------------------ external CDP runner

export type ExternalFlavor = 'lightpanda' | 'chromium';

/** Is this a usable binary? (absolute path to an executable regular file) */
export function checkBinary(path: string): { ok: true } | { ok: false; reason: string } {
  if (!path) return { ok: false, reason: 'no path set' };
  if (!isAbsolute(path)) return { ok: false, reason: 'the path must be absolute' };
  try {
    if (!statSync(path).isFile()) return { ok: false, reason: 'the path is not a file' };
    accessSync(path, constants.X_OK);
    return { ok: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'no file at that path' : code === 'EACCES' ? 'the file is not executable' : `cannot use it (${code ?? 'error'})` };
  }
}

/**
 * The command line. Lightpanda: `lightpanda serve --host 127.0.0.1 --port <p> --http_proxy <url>`
 * (its README's `serve` flags at the time of writing — confirm with `lightpanda serve --help` for
 * your version). Chromium-compatible: headless with remote debugging on 127.0.0.1 and --proxy-server.
 */
export function externalArgs(flavor: ExternalFlavor, port: number, proxyUrl: string, profileDir: string): string[] {
  if (flavor === 'lightpanda') return ['serve', '--host', '127.0.0.1', '--port', String(port), '--http_proxy', proxyUrl];
  return [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--proxy-server=${proxyUrl}`,
    // loopback goes through the proxy too (the same rule as the profile's own session)
    '--proxy-bypass-list=<-loopback>',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--blink-settings=imagesEnabled=false',
    'about:blank',
  ];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size < 64 * 1024) chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('not JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** A minimal CDP client over Node's built-in WebSocket (flattened sessions). */
export class CdpClient {
  private n = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: Array<(m: { method: string; params?: any; sessionId?: string }) => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      let m: any;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
      } catch {
        return;
      }
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`cdp: ${String(m.error.message ?? 'error').slice(0, 160)}`));
        else p.resolve(m.result ?? {});
      } else if (typeof m.method === 'string') for (const l of this.listeners) l(m);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('cdp: connection closed'));
      this.pending.clear();
    });
  }

  static connect(url: string, timeoutMs: number): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error('cdp: connect timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('cdp: connect failed'));
      });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method: string, sessionId: string | undefined, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners = this.listeners.filter((x) => x !== l);
        reject(new Error(`cdp: no ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      const l = (m: { method: string; params?: any; sessionId?: string }) => {
        if (m.method !== method || (sessionId && m.sessionId !== sessionId)) return;
        clearTimeout(t);
        this.listeners = this.listeners.filter((x) => x !== l);
        resolve(m.params);
      };
      this.listeners.push(l);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

export interface ExternalRunnerOptions {
  path: string;
  flavor: ExternalFlavor;
  /** how long the binary has to start listening */
  startTimeoutMs?: number;
}

export class ExternalCdpRunner implements WatcherRunner {
  readonly name = 'external-cdp';

  constructor(private readonly o: ExternalRunnerOptions) {}

  available() {
    return checkBinary(this.o.path);
  }

  async run(job: WatchJob): Promise<WatchRunResult> {
    const session = 'external (no cookies)';
    const fail = (error: string, divergence?: string): WatchRunResult => ({ ok: false, error, ...(divergence ? { divergence } : {}), runner: this.name, session });
    const a = this.available();
    if (!a.ok) return fail(`external browser: ${a.reason}`);
    if (job.useLogin) return fail('the external runner never gets cookies: "use my login" needs the built-in runner');
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'gb-watch-'));
    let child: ChildProcess | null = null;
    let cdp: CdpClient | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const onAbort = () => kill();
    job.signal.addEventListener('abort', onAbort);
    try {
      child = spawn(this.o.path, externalArgs(this.o.flavor, port, job.proxyUrl, dir), {
        cwd: dir,
        stdio: 'ignore',
        // a fresh, empty home: nothing of the user's profile, and nothing kept after the run
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir, TMPDIR: dir, HTTP_PROXY: job.proxyUrl, HTTPS_PROXY: job.proxyUrl, http_proxy: job.proxyUrl, https_proxy: job.proxyUrl, NO_PROXY: '', no_proxy: '' },
      });
      const exited = new Promise<never>((_, reject) => child!.once('exit', (code) => reject(new Error(`the external browser exited (${code ?? 'signal'})`))));
      exited.catch(() => undefined);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(job.timeoutMs / 1000)} s`)), job.timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => job.signal.addEventListener('abort', () => reject(new Error('cancelled (an agent task started)')), { once: true }));
      aborted.catch(() => undefined);
      if (job.signal.aborted) throw new Error('cancelled (an agent task started)');
      const work = this.drive(job, port, (c) => (cdp = c));
      return await Promise.race([work, exited, deadline, aborted]);
    } catch (e) {
      return fail(String((e as Error).message ?? e).slice(0, 300));
    } finally {
      clearTimeout(timer);
      job.signal.removeEventListener('abort', onAbort);
      (cdp as CdpClient | null)?.close();
      kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async drive(job: WatchJob, port: number, keep: (c: CdpClient) => void): Promise<WatchRunResult> {
    const session = 'external (no cookies)';
    const start = Date.now();
    let ws = '';
    for (;;) {
      try {
        const v = (await getJson(`http://127.0.0.1:${port}/json/version`, 1000)) as { webSocketDebuggerUrl?: unknown };
        ws = typeof v.webSocketDebuggerUrl === 'string' ? v.webSocketDebuggerUrl : '';
        if (ws) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() - start > (this.o.startTimeoutMs ?? 15_000)) throw new Error('the external browser did not start listening for CDP');
      await new Promise((r) => setTimeout(r, 150));
    }
    // only ever talk to the loopback port we chose
    const u = new URL(ws);
    if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || Number(u.port) !== port) throw new Error('the external browser offered a CDP endpoint other than 127.0.0.1:<port>');
    const cdp = await CdpClient.connect(ws, 5000);
    keep(cdp);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const here = async () => {
      const r = await cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId);
      return typeof r.result?.value === 'string' ? r.result.value : '';
    };
    for (const url of job.urls) {
      const loaded = cdp.waitFor('Page.loadEventFired', sessionId, job.timeoutMs);
      loaded.catch(() => undefined);
      const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId);
      if (nav.errorText) return { ok: false, error: `could not open ${url}: ${String(nav.errorText).slice(0, 120)}`, runner: this.name, session };
      await loaded;
      const at = await here();
      const o = originOf(at);
      if (!o || !job.origins.includes(o)) return { ok: false, error: `the page went to ${o ?? 'a non-web page'}, not one of the watcher's origins`, divergence: 'new-origin', runner: this.name, session };
    }
    const r = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: extractJs(job.locator, false), returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { ok: false, error: 'the extraction script failed in the external browser', runner: this.name, session };
    // the process is killed right after (run()'s finally): no Browser.close round trip to race the exit
    return judgeExtraction(job, toPageEval(r.result?.value), this.name, session);
  }
}

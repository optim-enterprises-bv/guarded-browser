// The pluggable watcher runner (item 5, "Lightpanda idea 4"): the ExternalCdpRunner driving a
// separately installed headless browser over CDP. The "browser" here is test/helpers/fake-cdp.mjs —
// a real child process with a minimal WebSocket CDP endpoint — started through a wrapper script, so
// the runner's actual spawn / port / proxy argument / temp-dir / kill path is exercised.
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExternalCdpRunner, checkBinary, externalArgs, judgeExtraction, toPageEval, type WatchJob } from '../../src/core/watch-runner';
import type { ElementLocator } from '../../src/core/locator';

const FAKE = resolve(__dirname, '..', 'helpers', 'fake-cdp.mjs');
const dir = mkdtempSync(join(tmpdir(), 'gb-cdp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LOC: ElementLocator = { role: 'text', name: '', tag: 'p', path: 'div.card>p.price', cls: 'price', label: 'Blue Widget' };
const SITE = 'http://127.0.0.1:9';

function fakeBinary(name: string, extra: string[] = []): { path: string; record: string } {
  const record = join(dir, `${name}.json`);
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" --record "${record}" ${extra.map((x) => `'${x}'`).join(' ')} "$@"\n`);
  chmodSync(path, 0o755);
  return { path, record };
}

const job = (over: Partial<WatchJob> = {}): WatchJob => ({
  urls: [`${SITE}/price.html`],
  origins: [SITE],
  locator: LOC,
  kind: 'number',
  proxyUrl: 'http://127.0.0.1:41234',
  timeoutMs: 10_000,
  signal: new AbortController().signal,
  useLogin: false,
  ...over,
});

const listening = (port: number) =>
  new Promise<boolean>((r) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, () => r(true));
    req.on('error', () => r(false));
  });

describe('ExternalCdpRunner against a fake CDP browser', () => {
  it('starts the binary with an explicit HTTP proxy argument, on 127.0.0.1, with a fresh home; returns only the typed value; kills it afterwards', async () => {
    const b = fakeBinary('ok');
    const r = await new ExternalCdpRunner({ path: b.path, flavor: 'lightpanda' }).run(job());
    expect(r).toEqual({ ok: true, value: 12.5, runner: 'external-cdp', session: 'external (no cookies)' });
    const rec = JSON.parse(readFileSync(b.record, 'utf8'));
    const argv: string[] = rec.argv;
    expect(argv.slice(argv.indexOf('serve'))).toEqual(['serve', '--host', '127.0.0.1', '--port', expect.stringMatching(/^\d+$/), '--http_proxy', 'http://127.0.0.1:41234']);
    // a fresh temp home, deleted after the run; the proxy is in the environment too
    expect(rec.env.HOME).toMatch(/gb-watch-/);
    expect(existsSync(rec.env.HOME)).toBe(false);
    expect(rec.env.HTTP_PROXY).toBe('http://127.0.0.1:41234');
    // the calls the runner made, in order; the extraction ran IN the browser (matchLocator injected)
    const methods = rec.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Page.navigate', 'Runtime.evaluate', 'Runtime.evaluate']);
    const extract = rec.calls.at(-1).params.expression as string;
    expect(extract).toContain('gbMatch');
    expect(extract).toContain('"cls":"price"');
    expect(rec.calls.find((c: { method: string }) => c.method === 'Page.navigate').params.url).toBe(`${SITE}/price.html`);
    // killed: nothing listens on its port any more
    const port = Number(argv[argv.indexOf('--port') + 1]);
    await expect.poll(() => listening(port)).toBe(false);
  });

  it('a Chromium-compatible binary gets --proxy-server, loopback-only remote debugging and its own user-data-dir', () => {
    const a = externalArgs('chromium', 9333, 'http://127.0.0.1:5000', '/tmp/x');
    expect(a).toContain('--remote-debugging-address=127.0.0.1');
    expect(a).toContain('--remote-debugging-port=9333');
    expect(a).toContain('--proxy-server=http://127.0.0.1:5000');
    expect(a).toContain('--proxy-bypass-list=<-loopback>');
    expect(a).toContain('--user-data-dir=/tmp/x');
  });

  it('0 matches, >1 matches and a redirect to another origin are reported as divergences', async () => {
    const none = await new ExternalCdpRunner({ path: fakeBinary('none', ['--count', '0']).path, flavor: 'lightpanda' }).run(job());
    expect(none).toMatchObject({ ok: false, divergence: 'locator-none' });
    const many = await new ExternalCdpRunner({ path: fakeBinary('many', ['--count', '3']).path, flavor: 'lightpanda' }).run(job());
    expect(many).toMatchObject({ ok: false, divergence: 'locator-many' });
    const away = await new ExternalCdpRunner({ path: fakeBinary('away', ['--redirect', 'http://evil.test/x']).path, flavor: 'lightpanda' }).run(job());
    expect(away).toMatchObject({ ok: false, divergence: 'new-origin' });
  });

  it('text kinds: a hash or the capped text, never more', async () => {
    const b = fakeBinary('text', ['--text', 'Version 2.4 released']);
    const h = await new ExternalCdpRunner({ path: b.path, flavor: 'lightpanda' }).run(job({ kind: 'text-hash' }));
    expect(h).toMatchObject({ ok: true, value: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const t = await new ExternalCdpRunner({ path: b.path, flavor: 'lightpanda' }).run(job({ kind: 'element-text' }));
    expect(t).toMatchObject({ ok: true, value: 'Version 2.4 released' });
  });

  it('never gets cookies: "use my login" is refused before anything starts', async () => {
    const b = fakeBinary('login');
    const r = await new ExternalCdpRunner({ path: b.path, flavor: 'lightpanda' }).run(job({ useLogin: true }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('never gets cookies') });
    expect(existsSync(b.record)).toBe(false);
  });

  it('a binary that never listens is killed at the start timeout', async () => {
    const path = join(dir, 'silent.sh');
    const pidFile = join(dir, 'silent.pid');
    writeFileSync(path, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
    chmodSync(path, 0o755);
    const r = await new ExternalCdpRunner({ path, flavor: 'lightpanda', startTimeoutMs: 600 }).run(job());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('did not start listening') });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return 'alive';
      } catch {
        return 'gone';
      }
    }).toBe('gone');
  });

  it('cancelled by its signal (an agent task starting) kills the browser', async () => {
    const ac = new AbortController();
    const path = join(dir, 'slow.sh');
    writeFileSync(path, `#!/bin/sh\nexec sleep 30\n`);
    chmodSync(path, 0o755);
    setTimeout(() => ac.abort(), 200);
    const r = await new ExternalCdpRunner({ path, flavor: 'lightpanda', startTimeoutMs: 20_000 }).run(job({ signal: ac.signal }));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled|exited/) });
  });
});

describe('binary check (the Settings option is greyed out unless this passes)', () => {
  it('absent, relative, a directory, not executable', () => {
    expect(checkBinary('')).toEqual({ ok: false, reason: 'no path set' });
    expect(checkBinary('lightpanda')).toEqual({ ok: false, reason: 'the path must be absolute' });
    expect(checkBinary(join(dir, 'missing'))).toEqual({ ok: false, reason: 'no file at that path' });
    expect(checkBinary(dir)).toEqual({ ok: false, reason: 'the path is not a file' });
    const f = join(dir, 'plain.txt');
    writeFileSync(f, 'x');
    chmodSync(f, 0o644);
    expect(checkBinary(f)).toEqual({ ok: false, reason: 'the file is not executable' });
    expect(checkBinary(fakeBinary('exe').path)).toEqual({ ok: true });
  });
});

describe('judgeExtraction (shared by both runners)', () => {
  const ev = { url: `${SITE}/price.html`, title: 'Price watch', heading: 'Blue Widget', count: 1, text: 'Price: $19.99' };
  it('typed value on one match; page data is re-validated', () => {
    expect(judgeExtraction(job(), toPageEval(ev), 'r', 's')).toMatchObject({ ok: true, value: 19.99 });
    expect(toPageEval({ count: 'x' })).toBeNull();
    expect(toPageEval({ ...ev, text: 'y'.repeat(5000) })!.text).toHaveLength(300);
  });
  it('landmarks recorded when the watcher was made must still be there', () => {
    const r = judgeExtraction(job({ expect: { title: 'Price watch', heading: 'Red Gizmo' } }), toPageEval(ev), 'r', 's');
    expect(r).toMatchObject({ ok: false, divergence: 'landmark-missing' });
  });
  it('a value that is not a number is not invented', () => {
    expect(judgeExtraction(job(), toPageEval({ ...ev, text: 'sold out' }), 'r', 's')).toMatchObject({ ok: false, divergence: 'extract-failed' });
  });
});

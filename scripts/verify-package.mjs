// Verifies the built RPM WITHOUT installing it:
//   rpm2cpio | cpio into .cache-test/rpm-root, start /opt/guarded-browser/guarded-browser normally
//   (no Playwright, so no injected --no-sandbox) under xvfb with a throwaway user-data dir, and check:
//   Default profile created, a local page loaded through the profile's proxy, the guard model loaded
//   from verified files, renderers sandboxed (own user + pid namespaces), clean exit on SIGTERM.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const rpm = process.argv[2] || readdirSync(join(ROOT, 'dist-pkg')).filter((f) => /\.x86_64\.rpm$/.test(f) && !f.includes('offline')).map((f) => join(ROOT, 'dist-pkg', f))[0];
if (!rpm) throw new Error('no RPM in dist-pkg/');
const out = { rpm, checks: {} };
const ok = (name, pass, detail) => {
  out.checks[name] = { pass, ...(detail === undefined ? {} : { detail }) };
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

// 1. extract
const base = join(ROOT, '.cache-test');
mkdirSync(base, { recursive: true });
const rootDir = join(base, 'rpm-root');
rmSync(rootDir, { recursive: true, force: true });
mkdirSync(rootDir);
const x = spawnSync('sh', ['-c', `rpm2cpio "${rpm}" | cpio -idm --quiet`], { cwd: rootDir, stdio: 'inherit' });
ok('rpm2cpio extraction', x.status === 0);
const bin = join(rootDir, 'opt', 'guarded-browser', 'guarded-browser');
ok('binary present', existsSync(bin), bin);
const sandboxHelper = join(rootDir, 'opt', 'guarded-browser', 'chrome-sandbox');
const helperMode = statSync(sandboxHelper).mode & 0o7777;
// extracted as a normal user the setuid bit cannot be kept: Chromium must use user namespaces here
ok('chrome-sandbox helper extracted (setuid only takes effect once rpm installs it root-owned)', existsSync(sandboxHelper), `mode ${helperMode.toString(8)}`);

// 2. fixture page
const hits = [];
const srv = http.createServer((q, r) => {
  hits.push(q.url);
  r.writeHead(200, { 'content-type': 'text/html' }).end('<title>Package check page</title><p>hello from the fixture</p>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}/check`;

// 3. launch normally (sandbox on) under xvfb, Wayland off
const userData = mkdtempSync(join(base, 'verify-ud-'));
const env = { ...process.env, GUARDED_USER_DATA: userData, XDG_DATA_HOME: join(base, 'xdg-data') };
delete env.WAYLAND_DISPLAY;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x920x24', bin, '--ozone-platform=x11', site], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));
child.stdout.on('data', () => undefined);

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fn();
};
const readAudit = () => {
  try {
    const reg = JSON.parse(readFileSync(join(userData, 'profiles.json'), 'utf8'));
    const dir = join(userData, 'profiles', reg.profiles[0].id, 'audit');
    return { reg, events: readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) };
  } catch {
    return null;
  }
};

const loaded = await until(() => hits.includes('/check'), 60_000);
ok('local page requested', !!loaded);
const a = await until(() => {
  const r = readAudit();
  return r && r.events.some((e) => e.type === 'egress' && e.layer === 'proxy' && String(e.url).startsWith(site)) ? r : null;
}, 30_000);
ok('Default profile created', !!a && a.reg.profiles.length === 1 && a.reg.profiles[0].name === 'Default', a?.reg.profiles.map((p) => p.name));
ok('page loaded through the profile proxy (audited)', !!a);
const guard = await until(() => readAudit()?.events.find((e) => e.type === 'guard' && e.what === 'load'), 180_000);
ok('guard model verified and loaded (onnxruntime in the package)', guard?.status === 'ready', guard ? `${guard.status}: ${guard.detail}` : 'no load event');

// 4. sandbox: every descendant of the browser process. Sandboxed children often cannot even be
//    inspected (exe / ns links unreadable); /proc/<pid>/status still shows NSpid (a second number =
//    a nested PID namespace) and Seccomp (2 = seccomp-bpf filter active).
const exe = realpathSync(bin);
const allPids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
const info = (p) => {
  try {
    const status = readFileSync(`/proc/${p}/status`, 'utf8');
    const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
    const ppid = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
    let args = [];
    try {
      args = readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
    } catch {}
    let e = '';
    try {
      e = readlinkSync(`/proc/${p}/exe`);
    } catch {}
    return { pid: p, ppid, args, exe: e, nspid: (/^NSpid:\s*(.*)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/), seccomp: (/^Seccomp:\s*(\d)/m.exec(status) ?? [])[1] };
  } catch {
    return null;
  }
};
const table = allPids.map(info).filter(Boolean);
const browser = table.find((p) => p.exe === exe && !/--type=/.test(p.args.join(' ')));
const tree = new Set([browser.pid]);
for (let changed = true; changed; ) {
  changed = false;
  for (const p of table) if (!tree.has(p.pid) && tree.has(p.ppid)) (tree.add(p.pid), (changed = true));
}
const procs = table.filter((p) => tree.has(p.pid));
// Chromium rewrites child command lines into one space-separated string: match on the joined text
const typeOf = (p) => (p === browser ? 'browser' : /--type=([\w-]+)/.exec(p.args.join(' '))?.[1] ?? '(unreadable)');
const summary = procs.map((p) => ({ pid: p.pid, type: typeOf(p), nspid: p.nspid.join('/'), seccomp: p.seccomp }));
const readable = procs.filter((p) => p.args.join('').length > 0);
ok('no process command line contains --no-sandbox', readable.length > 0 && readable.every((p) => !/(^|\s)--no-sandbox(\s|$)/.test(p.args.join(' '))), `${readable.length} readable of ${procs.length}`);
const nested = procs.filter((p) => p.nspid.length > 1);
const filtered = nested.filter((p) => p.seccomp === '2');
ok(
  'Chromium sandbox active: child processes in nested PID namespaces with seccomp-bpf filters',
  nested.length >= 2 && filtered.length >= 2 && browser.nspid.length === 1 && browser.seccomp === '0',
  summary,
);
const zygote = procs.filter((p) => p.nspid.at(-1) === '1');
ok('namespace sandbox init / zygote (pid 1 inside its namespace) present', zygote.length > 0, zygote.map((z) => z.nspid.join('/')));

// 5. clean exit
process.kill(Number(browser.pid), 'SIGTERM');
const code = await new Promise((r) => child.on('exit', (c) => r(c)));
ok('exits cleanly on SIGTERM', code === 0, `xvfb-run exit code ${code}`);
ok('no crash in stderr', !/FATAL|Segmentation|Trace\/breakpoint/i.test(stderr), stderr.split('\n').filter((l) => /FATAL|ERROR/.test(l)).slice(0, 3).join(' | ') || 'clean');
srv.close();
rmSync(userData, { recursive: true, force: true });
const failed = Object.entries(out.checks).filter(([, v]) => !v.pass);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall package checks passed');
process.exit(failed.length ? 1 : 0);

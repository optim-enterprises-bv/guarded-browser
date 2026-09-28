// Builds the Linux packages into dist-pkg/:
//   1. esbuild bundles (dist/)
//   2. electron-builder: linux-unpacked (+ AppImage)
//   3. rpmbuild: /opt/guarded-browser + /usr/bin symlink + desktop entry + icons, chrome-sandbox 4755
// --offline also bundles the verified guard model into resources/models (large).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-pkg');
const offline = process.argv.includes('--offline');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, env = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('node', ['scripts/make-icons.mjs']);
run('node', ['scripts/build.mjs']);
// keep it lean: electron-builder only packs, no native rebuild (N-API modules), one target at a time
run('npx', ['electron-builder', '--linux', ...(offline ? ['dir'] : ['dir', 'AppImage']), '--x64', '--publish', 'never'], { USE_HARD_LINKS: 'false' });

const unpacked = join(OUT, 'linux-unpacked');
if (offline) {
  // bundle the guard model (copied from the verified dev / user cache; verified again at runtime)
  const { GUARD_MODEL } = await import(join(ROOT, 'dist', 'model-spec.mjs')).catch(() => ({ GUARD_MODEL: null }));
  const id = GUARD_MODEL?.id ?? 'protectai/deberta-v3-base-prompt-injection-v2';
  const candidates = [join(homedir(), '.local', 'share', 'guarded-browser', 'models'), join(homedir(), '.cache', 'guarded-browser', 'models'), join(ROOT, '.cache-test', 'models')];
  const src = candidates.find((c) => existsSync(join(c, id, 'onnx', 'model.onnx')));
  if (!src) throw new Error('no local copy of the guard model to bundle');
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']) {
    mkdirSync(join(unpacked, 'resources', 'models', id, f, '..'), { recursive: true });
    copyFileSync(join(src, id, f), join(unpacked, 'resources', 'models', id, f));
  }
}

// file list for rpm: every directory and file under /opt/guarded-browser; chrome-sandbox setuid root
const lines = ['%dir "/opt/guarded-browser"'];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const dest = `/opt/guarded-browser/${relative(unpacked, p)}`;
    if (statSync(p).isDirectory()) {
      lines.push(`%dir "${dest}"`);
      walk(p);
    } else if (dest === '/opt/guarded-browser/chrome-sandbox') lines.push(`%attr(4755, root, root) "${dest}"`);
    else lines.push(`"${dest}"`);
  }
};
walk(unpacked);
const filelist = join(OUT, 'rpm-files.txt');
writeFileSync(filelist, lines.join('\n') + '\n');

const top = join(OUT, 'rpmbuild');
rmSync(top, { recursive: true, force: true });
for (const d of ['BUILD', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS', 'BUILDROOT']) mkdirSync(join(top, d), { recursive: true });
run('rpmbuild', [
  '-bb', join(ROOT, 'packaging', 'guarded-browser.spec'),
  '--define', `_topdir ${top}`,
  '--define', `gb_version ${pkg.version}`,
  '--define', `gb_src ${unpacked}`,
  '--define', `gb_desktop ${join(ROOT, 'packaging', 'guarded-browser.desktop')}`,
  '--define', `gb_icons ${join(ROOT, 'build', 'icons')}`,
  '--define', `gb_filelist ${filelist}`,
  '--define', '_smp_mflags -j2',
]);
const rpms = readdirSync(join(top, 'RPMS', 'x86_64')).filter((f) => f.endsWith('.rpm'));
for (const r of rpms) {
  const name = offline ? r.replace('.x86_64.rpm', '.offline.x86_64.rpm') : r;
  copyFileSync(join(top, 'RPMS', 'x86_64', r), join(OUT, name));
  console.log(`RPM: ${join(OUT, name)} (${(statSync(join(OUT, name)).size / 1024 / 1024).toFixed(1)} MB)`);
}

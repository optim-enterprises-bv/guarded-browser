// Runs the Playwright Electron tests. Uses xvfb-run when available so no window appears on the
// user's desktop and it works headless; falls back to $DISPLAY / $WAYLAND_DISPLAY.
import { spawnSync } from 'node:child_process';

const args = ['playwright', 'test', ...process.argv.slice(2)];
const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
let r;
if (hasXvfb) {
  r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'npx', ...args], { stdio: 'inherit' });
} else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
  console.warn('xvfb-run not found: running e2e tests on the current display');
  r = spawnSync('npx', args, { stdio: 'inherit' });
} else {
  console.error('No display and no xvfb-run: install xorg-x11-server-Xvfb (Fedora) / xvfb (Debian) to run the e2e tests.');
  process.exit(1);
}
process.exit(r.status ?? 1);

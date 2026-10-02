// Bundles main process, UI preload and renderer with esbuild. Type checking is `npm run typecheck`.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'es2023' };
const external = ['electron', '@huggingface/transformers', 'onnxruntime-node'];

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/feed-worker.ts'], outfile: 'dist/main/feed-worker.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/import-worker.ts'], outfile: 'dist/main/import-worker.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/tab-preload.ts'], outfile: 'dist/main/tab-preload.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' });
// Mail (ticket 37c) is a PANEL inside this same renderer bundle (`src/renderer/mail-panel.ts` is
// imported by renderer.ts), so there is no separate mail window, preload or CSS to build.
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');

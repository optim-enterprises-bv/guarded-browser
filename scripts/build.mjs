// Bundles main process, UI preload and renderer with esbuild. Type checking is `npm run typecheck`.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

// start from an empty dist/ so a renamed or deleted entry point cannot leave a stale bundle behind
rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'es2023' };
const external = ['electron', '@huggingface/transformers', 'onnxruntime-node'];

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/feed-worker.ts'], outfile: 'dist/main/feed-worker.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/import-worker.ts'], outfile: 'dist/main/import-worker.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/tab-preload.ts'], outfile: 'dist/main/tab-preload.js', platform: 'node', format: 'cjs', external });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', platform: 'node', format: 'cjs', external });
// the MCP stdio launcher (item 3): plain Node, run by `claude mcp add` / Hermes with the browser's
// Electron as Node (ELECTRON_RUN_AS_NODE=1) or with `node`; it never loads Electron
await build({ ...common, entryPoints: ['src/mcp-stdio.ts'], outfile: 'dist/mcp-stdio.js', platform: 'node', format: 'cjs' });
await build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' });
// Mail (ticket 37c) is a PANEL inside this same renderer bundle (`src/renderer/mail-panel.ts` is
// imported by renderer.ts), so there is no separate mail window, preload or CSS to build.
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');

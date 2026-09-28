// Bundles scripts/smoke-local.ts with esbuild and runs it with node.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['scripts/smoke-local.ts'], outfile: 'dist/smoke-local.js', bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning', external: ['@huggingface/transformers'] });
process.exit(spawnSync(process.execPath, ['dist/smoke-local.js'], { stdio: 'inherit' }).status ?? 1);

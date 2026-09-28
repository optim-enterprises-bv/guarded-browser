// The guard model is not shipped in the package. On first run its files are copied from a local
// source (the dev cache, or an offline bundle) or downloaded from Hugging Face at a PINNED revision,
// and every file is verified against a PINNED sha256 before the model is ever loaded. A mismatch
// leaves the guard in its degraded "guard unavailable" state.

import { createHash } from 'node:crypto';
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ModelFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ModelSpec {
  id: string;
  revision: string;
  files: ModelFile[];
}

/** protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0) at a fixed revision. */
export const GUARD_MODEL: ModelSpec = {
  id: 'protectai/deberta-v3-base-prompt-injection-v2',
  revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
  files: [
    { path: 'config.json', sha256: '05079f4735092040b780d459027afab413faa6eeb66a548571a58832304b60bb', size: 994 },
    { path: 'tokenizer.json', sha256: 'f0a66ad0d735d8dca9ecac4ff50fcdef4bb6adbadd2941a926844844d2c2059b', size: 8656744 },
    { path: 'tokenizer_config.json', sha256: '557b3d33d3f41b81ad769244e506549e98a1857d41dd58160aacd4d98d710b5a', size: 1284 },
    { path: 'onnx/model.onnx', sha256: 'f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c', size: 738563188 },
  ],
};

export type ModelProgress = { phase: 'verifying' | 'copying' | 'downloading'; done: number; total: number; file: string };

export interface EnsureOptions {
  /** directory that will hold <id>/<files> (the transformers.js "local model path") */
  root: string;
  /** other roots with the same layout to copy verified files from (dev cache, offline bundle) */
  sources?: string[];
  /** base URL for downloads; the file URL is `${base}/${id}/resolve/${revision}/${path}` */
  downloadBase?: string | null;
  onProgress?: (p: ModelProgress) => void;
  fetchImpl?: typeof fetch;
}

async function sha256File(file: string, onBytes?: (n: number) => void): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (c: Buffer | string) => {
        const b = typeof c === 'string' ? Buffer.from(c) : c;
        h.update(b);
        onBytes?.(b.length);
      })
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

interface Stamp {
  [path: string]: { size: number; mtimeMs: number; sha256: string };
}

/**
 * Make sure every file of `spec` is present under root/<id> with the pinned checksum.
 * Returns the root on success. Never throws: failures come back as { ok: false, error }.
 */
export async function ensureModel(spec: ModelSpec, o: EnsureOptions): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const dir = join(o.root, spec.id);
  const stampFile = join(dir, '.verified.json');
  let stamp: Stamp = {};
  try {
    stamp = existsSync(stampFile) ? (JSON.parse(readFileSync(stampFile, 'utf8')) as Stamp) : {};
  } catch {
    stamp = {};
  }
  const total = spec.files.reduce((a, f) => a + f.size, 0);
  let done = 0;
  const progress = (phase: ModelProgress['phase'], file: string, n = 0) => {
    done += n;
    o.onProgress?.({ phase, done: Math.min(done, total), total, file });
  };

  const verified = async (file: string, f: ModelFile, phase: ModelProgress['phase']): Promise<boolean> => {
    if (!existsSync(file)) return false;
    const st = statSync(file);
    if (st.size !== f.size) return false;
    const s = stamp[f.path];
    if (s && s.size === st.size && s.mtimeMs === st.mtimeMs && s.sha256 === f.sha256 && file.startsWith(dir)) {
      progress(phase, f.path, f.size); // unchanged since it was last verified
      return true;
    }
    const got = await sha256File(file, (n) => progress(phase, f.path, n));
    return got === f.sha256;
  };

  try {
    for (const f of spec.files) {
      const target = join(dir, f.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (!(await verified(target, f, 'verifying'))) {
        rmSync(target, { force: true });
        let ok = false;
        // 1. copy from a local source (reflink on btrfs: instant), verify the copy
        for (const src of o.sources ?? []) {
          const from = join(src, spec.id, f.path);
          if (!existsSync(from) || statSync(from).size !== f.size) continue;
          const tmp = `${target}.part`;
          copyFileSync(from, tmp, constants.COPYFILE_FICLONE);
          progress('copying', f.path, 0);
          if (await verified(tmp, f, 'copying')) {
            renameSync(tmp, target);
            ok = true;
            break;
          }
          rmSync(tmp, { force: true });
        }
        // 2. download at the pinned revision, hashing while streaming, with an exact size limit
        if (!ok && o.downloadBase) {
          const url = `${o.downloadBase.replace(/\/$/, '')}/${spec.id}/resolve/${spec.revision}/${f.path}`;
          const res = await (o.fetchImpl ?? fetch)(url, { redirect: 'follow' });
          if (!res.ok || !res.body) return { ok: false, error: `download of ${f.path} failed: HTTP ${res.status}` };
          const tmp = `${target}.part`;
          const out = createWriteStream(tmp, { mode: 0o600 });
          const h = createHash('sha256');
          let size = 0;
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done: end, value } = await reader.read();
              if (end) break;
              size += value.byteLength;
              if (size > f.size) {
                await reader.cancel();
                throw new Error(`${f.path} is larger than expected`);
              }
              h.update(value);
              if (!out.write(value)) await new Promise((r) => out.once('drain', r));
              progress('downloading', f.path, value.byteLength);
            }
          } finally {
            await new Promise((r) => out.end(r));
          }
          if (size !== f.size || h.digest('hex') !== f.sha256) {
            rmSync(tmp, { force: true });
            return { ok: false, error: `checksum mismatch for ${f.path}: refusing to load the guard model` };
          }
          renameSync(tmp, target);
          ok = true;
        }
        if (!ok) return { ok: false, error: `guard model file ${f.path} is missing or does not match its pinned checksum` };
      }
      const st = statSync(target);
      stamp[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256 };
    }
    writeFileSync(stampFile, JSON.stringify(stamp, null, 2));
    return { ok: true, root: o.root };
  } catch (e) {
    return { ok: false, error: `guard model: ${(e as Error).message.slice(0, 200)}` };
  }
}

import { afterAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { GUARD_MODEL, ensureModel, type ModelSpec } from '../../src/main/model-store';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'gb-model-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const A = Buffer.from('{"model":"config"}');
const B = Buffer.alloc(300_000, 7);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const spec: ModelSpec = {
  id: 'org/tiny-model',
  revision: 'abc123',
  files: [
    { path: 'config.json', sha256: sha(A), size: A.length },
    { path: 'onnx/model.onnx', sha256: sha(B), size: B.length },
  ],
};
function put(root: string, files: Record<string, Buffer>) {
  for (const [p, b] of Object.entries(files)) {
    mkdirSync(join(root, spec.id, p, '..'), { recursive: true });
    writeFileSync(join(root, spec.id, p), b);
  }
}

describe('guard model store', () => {
  it('pins the real model: revision + sha256 of every file', () => {
    expect(GUARD_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(GUARD_MODEL.files.map((f) => f.path)).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']);
    for (const f of GUARD_MODEL.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('copies from a local source and verifies; later runs trust the stamp', async () => {
    const src = tmp();
    const root = tmp();
    put(src, { 'config.json': A, 'onnx/model.onnx': B });
    const phases: string[] = [];
    expect(await ensureModel(spec, { root, sources: [src], onProgress: (p) => phases.push(p.phase) })).toEqual({ ok: true, root });
    expect(readFileSync(join(root, spec.id, 'onnx/model.onnx')).equals(B)).toBe(true);
    expect(phases).toContain('copying');
    expect(existsSync(join(root, spec.id, '.verified.json'))).toBe(true);
    expect(await ensureModel(spec, { root })).toEqual({ ok: true, root }); // no source needed any more
  });

  it('refuses a local copy whose checksum does not match; a tampered installed file is re-fetched or refused', async () => {
    const src = tmp();
    const root = tmp();
    const evil = Buffer.alloc(B.length, 9);
    put(src, { 'config.json': A, 'onnx/model.onnx': evil });
    const r = await ensureModel(spec, { root, sources: [src] });
    expect(r.ok).toBe(false);
    expect(existsSync(join(root, spec.id, 'onnx/model.onnx'))).toBe(false);
    // good install, then tamper with it (same size, new mtime): detected and refused
    const good = tmp();
    put(good, { 'config.json': A, 'onnx/model.onnx': B });
    expect((await ensureModel(spec, { root, sources: [good] })).ok).toBe(true);
    writeFileSync(join(root, spec.id, 'onnx/model.onnx'), evil);
    const again = await ensureModel(spec, { root });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/does not match its pinned checksum/);
  });

  it('downloads at the pinned revision with progress, and rejects wrong or oversized content', async () => {
    let body: Record<string, Buffer> = { 'config.json': A, 'onnx/model.onnx': B };
    const seen: string[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      const m = /^\/org\/tiny-model\/resolve\/abc123\/(.+)$/.exec(req.url ?? '');
      const b = m ? body[m[1]] : undefined;
      if (!b) return res.writeHead(404).end();
      res.writeHead(200).end(b);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const root = tmp();
    const progress: number[] = [];
    const ok = await ensureModel(spec, { root, downloadBase: base, onProgress: (p) => progress.push(p.done / p.total) });
    expect(ok.ok).toBe(true);
    expect(seen).toEqual(['/org/tiny-model/resolve/abc123/config.json', '/org/tiny-model/resolve/abc123/onnx/model.onnx']);
    expect(progress.at(-1)).toBe(1);
    // wrong content
    body = { 'config.json': Buffer.from('{"model":"CONFIG"}'), 'onnx/model.onnx': B };
    const bad = await ensureModel(spec, { root: tmp(), downloadBase: base });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/checksum mismatch/);
    // oversized content is cut off
    body = { 'config.json': Buffer.concat([A, Buffer.alloc(1000)]), 'onnx/model.onnx': B };
    const big = await ensureModel(spec, { root: tmp(), downloadBase: base });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/larger than expected/);
    srv.close();
  });
});

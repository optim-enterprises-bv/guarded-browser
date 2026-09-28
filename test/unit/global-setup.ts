// Removes the temp profiles / audit dirs the unit tests create (gb-*), once the run is over.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let started = 0;

export function setup() {
  started = Date.now();
}

export function teardown() {
  for (const name of readdirSync(tmpdir())) {
    if (!/^gb-(agent|audit|rep|hard|smoke|prof)-/.test(name)) continue;
    const p = join(tmpdir(), name);
    try {
      if (statSync(p).birthtimeMs >= started - 1000) rmSync(p, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

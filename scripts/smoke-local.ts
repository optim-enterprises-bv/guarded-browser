// One tiny real task against the local OpenAI-compatible server (default http://127.0.0.1:1234/v1).
// Skips (exit 0) if the server does not answer. Uses an in-memory page, so no browser is needed,
// and caps the task at 4 steps: a handful of small requests, not a load test.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTask } from '../src/core/agent';
import { AuditLog } from '../src/core/audit';
import { defaultSettings } from '../src/core/config';
import { NullGuard } from '../src/core/guard';
import { LlmClient } from '../src/core/llm';
import { FakeDriver } from '../test/helpers/fake-driver';

const base = process.env.GUARDED_SMOKE_URL ?? 'http://127.0.0.1:1234/v1';

async function main() {
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.log(`smoke:local SKIPPED: ${base} is not responding (${(e as Error).message})`);
    return;
  }
  const SITE = 'http://shop.example';
  const driver = new FakeDriver({
    [`${SITE}/shop.html`]: {
      title: 'Acme Gadgets',
      text: 'Acme Gadgets. Blue Widget - Price: $19.99 USD. Red Gizmo - Price: $42.50 USD. Free shipping over $50.',
      elements: [{ ref: 'e1', role: 'button', name: 'Add to cart' }],
    },
  });
  driver.url = `${SITE}/shop.html`;
  const s = defaultSettings();
  for (const role of ['planner', 'reader', 'judge'] as const) s.models[role].primary.baseURL = base;
  s.agent.maxSteps = 4;
  const audit = new AuditLog(mkdtempSync(join(tmpdir(), 'gb-smoke-')), 'smoke');
  const confirmations: string[] = [];
  const started = Date.now();
  const r = await new AgentTask('What is the price of the Blue Widget on this page?', {
    planner: new LlmClient('planner', () => s.models.planner),
    reader: new LlmClient('reader', () => s.models.reader),
    judge: new LlmClient('judge', () => s.models.judge),
    guard: new NullGuard('smoke test: guard not loaded'),
    driver,
    audit,
    confirm: async (req) => {
      confirmations.push(req.action);
      return 'deny';
    },
    settings: () => s.agent,
  }).run();
  const events = audit.read();
  console.log(JSON.stringify({
    status: r.status,
    answer: r.answer,
    steps: r.steps,
    seconds: Math.round((Date.now() - started) / 1000),
    plannerActions: events.filter((e) => e.type === 'planner-action').map((e) => `${e.action}${e.native ? '' : ' (json-fallback)'}`),
    reader: events.filter((e) => e.type === 'reader').map((e) => (e.ok ? e.output : e.error)),
    judge: events.filter((e) => e.type === 'judge').map((e) => `${e.verdict}: ${e.reason}`),
    confirmations,
    auditFile: audit.file,
  }, null, 2));
  const ok = r.status === 'finished' && /19\.99/.test(r.answer ?? '');
  console.log(ok ? 'smoke:local PASS' : 'smoke:local FAIL (see above)');
  process.exitCode = ok ? 0 : 1;
}

void main();

// Mock OpenAI-compatible server for tests. Each role (planner / reader / judge / chat / triage / draft, detected from
// the system prompt) is driven by a script, so tests can make a model "compromised" on purpose and
// check that the code-level defences still hold. A request with `stream: true` gets a text reply as
// server-sent events (`chat.completion.chunk` deltas, then `data: [DONE]`), like a real server.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockRole = 'planner' | 'reader' | 'judge' | 'chat' | 'triage' | 'draft' | 'unknown';

export interface MockCall {
  role: MockRole;
  body: Record<string, unknown>;
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>;
  /** index of this call among calls for the same role */
  n: number;
  /** concatenated text of every message (for scripted "compromised" behaviour) */
  transcript: string;
  /** a streamed reply whose client went away before the last event (Stop pressed) */
  aborted?: boolean;
  /** a streamed reply that was sent to the end */
  completed?: boolean;
}

export type MockReply = (
  | { tool: string; args: Record<string, unknown> }
  | { json: unknown }
  | { content: string }
  | { status: number }
) & {
  /** hold the HTTP reply this long, so a test can observe state WHILE the model is thinking */
  delayMs?: number;
  /** streamed replies: the text in these pieces (default: word by word) ... */
  chunks?: string[];
  /** ... with this pause between two events */
  chunkDelayMs?: number;
};

export type Responder = (call: MockCall) => MockReply;

export interface MockLlm {
  url: string;
  calls: MockCall[];
  script(role: MockRole, r: Responder): void;
  reset(): void;
  close(): Promise<void>;
}

/** Replies in order; after the list is exhausted keeps repeating the last one. */
export function sequence(...steps: Array<MockReply | Responder>): Responder {
  return (call) => {
    const s = steps[Math.min(call.n, steps.length - 1)];
    return typeof s === 'function' ? s(call) : s;
  };
}

function roleOf(messages: MockCall['messages']): MockRole {
  const sys = messages.find((m) => m.role === 'system')?.content ?? '';
  if (sys.includes('You are the PLANNER')) return 'planner';
  if (sys.includes('You are the READER')) return 'reader';
  if (sys.includes('You are the JUDGE')) return 'judge';
  if (sys.includes('You are the CHAT assistant')) return 'chat';
  if (sys.includes('You are the TRIAGE extractor')) return 'triage';
  if (sys.includes('You are the REPLY DRAFTER')) return 'draft';
  return 'unknown';
}

const defaults: Record<MockRole, Responder> = {
  planner: () => ({ tool: 'finish', args: { answer: 'mock: nothing to do' } }),
  reader: () => ({ json: {} }),
  judge: () => ({ json: { verdict: 'allow', reason: 'mock judge: serves the task' } }),
  chat: () => ({ content: 'mock chat reply' }),
  triage: () => ({ json: { category: 'other', needsReply: false, dueDate: null, amount: null, label: 'mock triage', confidence: 0.5 } }),
  draft: () => ({ content: 'mock reply draft' }),
  unknown: () => ({ content: 'mock' }),
};

export async function startMockLlm(): Promise<MockLlm> {
  let scripts: Record<MockRole, Responder> = { ...defaults };
  const calls: MockCall[] = [];
  let toolCounter = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'default' }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const messages = body.messages ?? [];
      const role = roleOf(messages);
      const call: MockCall = {
        role,
        body,
        messages,
        n: calls.filter((c) => c.role === role).length,
        transcript: messages.map((m: { content: string | null }) => m.content ?? '').join('\n'),
      };
      calls.push(call);
      let reply: MockReply;
      try {
        reply = scripts[role](call);
      } catch (e) {
        reply = { content: `mock script error: ${(e as Error).message}` };
      }
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if ('status' in reply) {
        res.writeHead(reply.status).end('mock error');
        return;
      }
      if (body.stream === true && 'content' in reply) {
        // server-sent events, one delta per piece; a client that disconnects ends the stream
        const pieces = reply.chunks ?? (reply.content.match(/\S+\s*/g) ?? ['']);
        let gone = false;
        res.on('close', () => {
          gone = true;
          if (!call.completed) call.aborted = true;
        });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const event = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(event({ role: 'assistant', content: '' }, null));
        for (const p of pieces) {
          if (gone) return;
          if (reply.chunkDelayMs) await new Promise((r) => setTimeout(r, reply.chunkDelayMs));
          if (gone) return;
          res.write(event({ content: p }, null));
        }
        res.write(event({}, 'stop'));
        call.completed = true;
        res.end('data: [DONE]\n\n');
        return;
      }
      let message: Record<string, unknown>;
      if ('tool' in reply) {
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call_${++toolCounter}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
        };
      } else if ('json' in reply) {
        message = { role: 'assistant', content: JSON.stringify(reply.json) };
      } else {
        message = { role: 'assistant', content: reply.content };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
    });
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    script(role, r) {
      scripts[role] = r;
    },
    reset() {
      scripts = { ...defaults };
      calls.length = 0;
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/**
 * The latest reader result the planner received. Numbers/booleans are values; strings come back as
 * their handle text (e.g. "{{$r1.currency}}"), exactly what a real planner could reference.
 */
export function lastExtracted(call: MockCall): Record<string, unknown> | null {
  for (let i = call.messages.length - 1; i >= 0; i--) {
    const c = call.messages[i].content ?? '';
    const start = c.indexOf('{"ok":true,"label":"untrusted"');
    if (start < 0) continue;
    const j = JSON.parse(c.slice(start)) as { data: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(j.data).map(([k, v]) => [k, v && typeof v === 'object' && 'handle' in (v as object) ? String((v as { handle: string }).handle).replace('[i]', '') : v]),
    );
  }
  return null;
}

/** Find the ref of the first snapshot element whose line matches a pattern. */
export function refFor(call: MockCall, pattern: RegExp): string {
  for (let i = call.messages.length - 1; i >= 0; i--) {
    for (const line of (call.messages[i].content ?? '').split('\n')) {
      const m = /^\[(e\d+)\]/.exec(line);
      if (m && pattern.test(line)) return m[1];
    }
  }
  throw new Error(`no element matching ${pattern} in planner transcript`);
}

// Minimal OpenAI-compatible chat client with an optional fallback endpoint.
// The fallback is only used when the primary is unreachable, times out or returns 5xx.

import type { Endpoint, RoleConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  responseFormatJson?: boolean;
  maxTokens?: number;
}

export interface ChatResult {
  message: ChatMessage;
  usedFallback: boolean;
  endpoint: string;
}

export class RetryableError extends Error {}

export type FallbackListener = (role: string, active: boolean, reason: string) => void;

async function callEndpoint(ep: Endpoint, req: ChatRequest): Promise<ChatMessage> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ep.apiKeyEnv) {
    const key = process.env[ep.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const body: Record<string, unknown> = {
    model: ep.model,
    messages: req.messages,
    temperature: 0,
    max_tokens: req.maxTokens ?? 1024,
    ...(ep.extraBody ?? {}),
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = 'auto';
  }
  let res: Response;
  try {
    res = await fetch(`${ep.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ep.timeoutMs ?? 120_000),
    });
  } catch (e) {
    throw new RetryableError(`endpoint unreachable (${ep.baseURL}): ${(e as Error).message}`);
  }
  if (res.status >= 500) throw new RetryableError(`endpoint ${ep.baseURL} returned ${res.status}`);
  if (!res.ok) throw new Error(`endpoint ${ep.baseURL} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error('endpoint returned no choices');
  return msg;
}

export class LlmClient {
  constructor(
    private readonly role: string,
    private readonly cfg: () => RoleConfig,
    private readonly onFallback?: FallbackListener,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { primary, fallback } = this.cfg();
    try {
      const message = await callEndpoint(primary, req);
      this.onFallback?.(this.role, false, '');
      return { message, usedFallback: false, endpoint: primary.baseURL };
    } catch (e) {
      if (!(e instanceof RetryableError) || !fallback.enabled) throw e;
      if (fallback.apiKeyEnv && !process.env[fallback.apiKeyEnv]) {
        throw new Error(`${(e as Error).message}; fallback enabled but env var ${fallback.apiKeyEnv} is not set`);
      }
      this.onFallback?.(this.role, true, (e as Error).message);
      const message = await callEndpoint(fallback, req);
      return { message, usedFallback: true, endpoint: fallback.baseURL };
    }
  }
}

// ------------------------------------------------------------------ streaming (chat role)

export interface StreamRequest {
  messages: ChatMessage[];
  maxTokens?: number;
}

export interface StreamResult {
  text: string;
  usedFallback: boolean;
  endpoint: string;
}

/** The user pressed Stop (or the conversation was cleared / its tab closed). */
export class StreamAbortedError extends Error {
  constructor(readonly partial: string) {
    super('stopped');
  }
}

/**
 * The body of a STREAMING request. This path serves the quarantined chat role, so it never carries
 * tools: `tools` / `tool_choice` / `functions` are removed even if a hand-edited extraBody adds them,
 * and every message is reduced to role + text.
 */
export function streamBody(ep: Endpoint, req: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ep.model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content ?? '' })),
    temperature: 0.3,
    max_tokens: req.maxTokens ?? 1024,
    ...(ep.extraBody ?? {}),
    stream: true,
  };
  for (const k of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls']) delete body[k];
  return body;
}

/**
 * Parse server-sent events from an OpenAI-compatible stream. Complete lines are consumed; an
 * incomplete last line comes back as `rest` for the next read.
 */
export function parseSse(buffer: string): { deltas: string[]; done: boolean; rest: string; errors: string[] } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  const deltas: string[] = [];
  const errors: string[] = [];
  let done = false;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') {
      done = true;
      break;
    }
    try {
      const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>; error?: { message?: unknown } };
      if (j.error) errors.push(String(j.error.message ?? 'stream error').slice(0, 300));
      const c = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
      if (typeof c === 'string' && c) deltas.push(c);
    } catch {
      /* a malformed event is skipped, not fatal */
    }
  }
  return { deltas, done, rest, errors };
}

async function streamEndpoint(ep: Endpoint, req: StreamRequest, onDelta: (d: string) => void, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (ep.apiKeyEnv) {
    const key = process.env[ep.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const timeoutMs = ep.timeoutMs ?? 120_000;
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // idle timeout: until the response starts, and then between two reads of the stream
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
  };
  const onAbort = () => ctl.abort();
  if (signal?.aborted) throw new StreamAbortedError('');
  signal?.addEventListener('abort', onAbort);
  let text = '';
  try {
    arm();
    let res: Response;
    try {
      res = await fetch(`${ep.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(streamBody(ep, req)), signal: ctl.signal });
    } catch (e) {
      if (signal?.aborted) throw new StreamAbortedError('');
      throw new RetryableError(timedOut ? `endpoint ${ep.baseURL} did not answer within ${Math.round(timeoutMs / 1000)} s` : `endpoint unreachable (${ep.baseURL}): ${(e as Error).message}`);
    }
    if (res.status >= 500) throw new RetryableError(`endpoint ${ep.baseURL} returned ${res.status}`);
    if (!res.ok) throw new Error(`endpoint ${ep.baseURL} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    // a server that ignores `stream: true` answers with one JSON body
    if (/application\/json/i.test(res.headers.get('content-type') ?? '')) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const c = json.choices?.[0]?.message?.content;
      if (typeof c !== 'string') throw new Error('endpoint returned no reply');
      text = c;
      onDelta(c);
      return text;
    }
    if (!res.body) throw new Error('endpoint returned an empty response');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const p = parseSse(buf);
        buf = p.rest;
        for (const d of p.deltas) {
          text += d;
          onDelta(d);
        }
        if (p.errors.length) throw new Error(`the model reported an error: ${p.errors[0]}`);
        if (p.done) break;
      }
    } catch (e) {
      if (signal?.aborted) throw new StreamAbortedError(text);
      if (timedOut) throw new Error(`the model stopped sending (no data for ${Math.round(timeoutMs / 1000)} s)`);
      throw e;
    } finally {
      reader.cancel().catch(() => undefined);
    }
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export class StreamingLlmClient {
  constructor(
    private readonly role: string,
    private readonly cfg: () => RoleConfig,
    private readonly onFallback?: FallbackListener,
  ) {}

  /** Stream a reply. The fallback is used only when the primary fails BEFORE it starts answering. */
  async stream(req: StreamRequest, onDelta: (d: string) => void, signal?: AbortSignal): Promise<StreamResult> {
    const { primary, fallback } = this.cfg();
    try {
      const text = await streamEndpoint(primary, req, onDelta, signal);
      this.onFallback?.(this.role, false, '');
      return { text, usedFallback: false, endpoint: primary.baseURL };
    } catch (e) {
      if (!(e instanceof RetryableError) || !fallback.enabled) throw e;
      if (fallback.apiKeyEnv && !process.env[fallback.apiKeyEnv]) {
        throw new Error(`${(e as Error).message}; fallback enabled but env var ${fallback.apiKeyEnv} is not set`);
      }
      this.onFallback?.(this.role, true, (e as Error).message);
      const text = await streamEndpoint(fallback, req, onDelta, signal);
      return { text, usedFallback: true, endpoint: fallback.baseURL };
    }
  }
}

/** Extract the first JSON object from a model reply (tolerates code fences and <think> blocks). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in reply');
}

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

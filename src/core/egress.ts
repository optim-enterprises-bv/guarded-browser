// Egress filtering, independent of the agent/policy code.
//
// Layer 1 (host): an in-process forward proxy on 127.0.0.1:<ephemeral>. The guarded session is
// routed through it (loopback included). Plain HTTP requests are checked on the full URL; HTTPS
// CONNECT is checked on host:port only. No TLS interception, no custom CA.
//   - manual browsing: log-only, plus a small denylist
//   - agent task running: host allowlist (task hosts + tab origin + hosts the user approved)
//
// Layer 2 (content): checkRequest() is called from session.webRequest.onBeforeRequest with the
// full URL and upload body; it finds taint-registry values (with URL-encoding / base64 / case
// normalisation) that are not covered by a flow the user confirmed.
//
// Host keys are "hostname:port" (default port filled in), so 127.0.0.1:4001 and 127.0.0.1:4002
// are different hosts.

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { RegisteredValue, TaintRegistry } from './taint';
import type { ReputationChecker, ReputationHit } from './reputation';
import type { FormField } from './types';

export interface ApprovedRequest {
  method: string;
  url: string;
  /** the form fields shown in the dialog plus, if a named submit button was clicked, that one pair */
  fields: FormField[];
  /** the form's encoding; the request must use it (checked on the body and on the Content-Type header) */
  enctype?: string;
}

const norm = (v: string) => v.replace(/\r\n/g, '\n');
const URLENC = /^[A-Za-z0-9*\-._+%]*=[A-Za-z0-9*\-._+%]*(?:&[A-Za-z0-9*\-._+%]*=[A-Za-z0-9*\-._+%]*)*$/;
const PART = /^Content-Disposition: form-data; name="([^"\r\n]*)"(?:; filename="[^"\r\n]*")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*)\r\n$/;

/** Strict urlencoded parse (the exact form Chromium produces). null = anything else. */
export function parseUrlencoded(body: string): Array<[string, string]> | null {
  if (body === '') return [];
  if (!URLENC.test(body)) return null;
  try {
    return body.split('&').map((p) => {
      const i = p.indexOf('=');
      const dec = (x: string) => decodeURIComponent(x.replace(/\+/g, ' '));
      return [dec(p.slice(0, i)), dec(p.slice(i + 1))] as [string, string];
    });
  } catch {
    return null;
  }
}

/**
 * Strict multipart parse: empty preamble, every part exactly `Content-Disposition: form-data;
 * name="..."` (+ optional filename / Content-Type), CRLF line ends, closing delimiter, no epilogue.
 * Any part or byte that does not parse makes the whole body unparseable (null => mismatch).
 */
export function parseMultipart(body: string): { pairs: Array<[string, string]>; boundary: string } | null {
  const m = /^--([A-Za-z0-9'()+_,\-./:=?]{1,70})\r\n/.exec(body);
  if (!m) return null;
  const delim = `--${m[1]}`;
  const close = `${delim}--\r\n`;
  if (!body.endsWith(close)) return null;
  const parts = body.slice(0, body.length - close.length).split(`${delim}\r\n`);
  if (parts[0] !== '' || parts.length < 2) return null;
  const pairs: Array<[string, string]> = [];
  for (const part of parts.slice(1)) {
    const p = PART.exec(part);
    if (!p || p[2].includes(delim)) return null;
    pairs.push([p[1], p[2]]);
  }
  return { pairs, boundary: m[1] };
}

/** Parse a form body for display / matching. With an enctype, only that encoding is accepted. */
export function parseBody(body: string, enctype?: string): Array<[string, string]> | null {
  const e = (enctype ?? '').toLowerCase();
  if (e === 'multipart/form-data') return parseMultipart(body)?.pairs ?? null;
  if (e === 'application/x-www-form-urlencoded') return parseUrlencoded(body);
  if (e) return null; // text/plain and anything else: never auto-matched
  if (body.startsWith('--')) return parseMultipart(body)?.pairs ?? null;
  return parseUrlencoded(body);
}

/**
 * Same keys and values (order-insensitive, multiset). The only extra pair allowed is the clicked
 * submit button recorded at approval time (and shown in the dialog), at most once.
 */
export function fieldsMatch(expected: FormField[], actual: Array<[string, string]>): boolean {
  const rest = actual.map(([k, v]) => `${k}\u0000${norm(v)}`);
  for (const f of expected.filter((x) => !x.submitter)) {
    const i = rest.indexOf(`${f.name}\u0000${norm(f.value)}`);
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  const subs = expected.filter((x) => x.submitter);
  if (rest.length === 0) return true;
  if (subs.length !== 1) return false;
  const sub = subs[0];
  if (sub.image) {
    // an image button sends exactly name.x and name.y, both non-negative integers
    const pre = sub.name ? `${sub.name}.` : '';
    const keys = rest.map((r) => r.split('\u0000'));
    return (
      keys.length === 2 &&
      keys.every(([, v]) => /^\d{1,5}$/.test(v)) &&
      keys.map(([k]) => k).sort().join('|') === [`${pre}x`, `${pre}y`].join('|')
    );
  }
  return rest.length === 1 && rest[0] === `${sub.name}\u0000${norm(sub.value)}`;
}

export type EgressMode = 'manual' | 'agent';

export interface EgressAuditEntry {
  layer: 'proxy' | 'webrequest' | 'reputation';
  decision: 'allow' | 'block' | 'confirm-requested' | 'log';
  host: string;
  method: string;
  url?: string;
  reason: string;
  taintIds?: string[];
  feed?: string;
  matched?: string;
}

export function hostKey(input: string): string | null {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `http://${input}`);
    const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80');
    return `${u.hostname.toLowerCase().replace(/^\[|\]$/g, '')}:${port}`;
  } catch {
    return null;
  }
}

export class EgressController {
  mode: EgressMode = 'manual';
  private allow = new Set<string>();
  private blocked = new Map<string, number>();
  private confirmedFlows = new Set<string>();
  taint: TaintRegistry | null = null;
  reputation: ReputationChecker | null = null;
  /** hosts the user chose to visit despite a reputation listing (manual browsing only) */
  private reputationOverrides = new Set<string>();
  private listeners: Array<() => void> = [];

  constructor(
    private denylist: string[],
    private readonly audit: (e: EgressAuditEntry) => void,
  ) {}

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  setDenylist(d: string[]) {
    this.denylist = d;
  }

  startTask(seedHosts: string[], taint: TaintRegistry) {
    this.mode = 'agent';
    this.allow = new Set(seedHosts.map((h) => hostKey(h)).filter((h): h is string => !!h));
    this.blocked.clear();
    this.confirmedFlows.clear();
    this.approvals = [];
    this.taint = taint;
    this.changed();
  }

  endTask() {
    this.mode = 'manual';
    this.allow.clear();
    this.blocked.clear();
    this.confirmedFlows.clear();
    this.approvals = [];
    this.taint = null;
    this.changed();
  }

  allowHost(hostOrUrl: string) {
    const k = hostKey(hostOrUrl);
    if (!k) return;
    this.allow.add(k);
    this.blocked.delete(k);
    this.changed();
  }

  allowedHosts(): string[] {
    return [...this.allow];
  }

  blockedHosts(): Array<{ host: string; count: number }> {
    return [...this.blocked.entries()].map(([host, count]) => ({ host, count }));
  }

  private denied(key: string): boolean {
    const [host] = key.split(':');
    return this.denylist.some((d) => {
      const dk = d.toLowerCase();
      if (dk.includes(':')) return key === dk;
      return host === dk || host.endsWith(`.${dk}`);
    });
  }

  /**
   * Reputation verdict for a host. User overrides only count during manual browsing:
   * nothing the agent does can get past a reputation listing.
   */
  reputationCheck(hostOrUrl: string): ReputationHit | null {
    const hit = this.reputation?.check(hostOrUrl);
    if (!hit?.listed) return null;
    if (this.mode === 'manual' && this.reputationOverrides.has(hit.host)) return null;
    return hit;
  }

  overrideReputation(host: string) {
    this.reputationOverrides.add(host);
  }

  auditReputation(hit: ReputationHit, method: string, url: string | undefined, layer: 'proxy' | 'webrequest', action: string) {
    this.audit({ layer: 'reputation', decision: 'block', host: hit.host, method, url: url?.slice(0, 500), reason: `${action}: listed as malicious by ${hit.feed} (matched ${hit.matched}) [via ${layer}]`, feed: hit.feed, matched: hit.matched });
  }

  /** Would the proxy let this host through right now? (no side effects, no audit) */
  hostPasses(key: string): boolean {
    if (this.reputationCheck(key.slice(0, key.lastIndexOf(':')))) return false;
    if (this.denied(key)) return false;
    return this.mode === 'manual' || this.allow.has(key);
  }

  /** Host-level decision used by the proxy. */
  decideHost(key: string, method: string, url?: string): boolean {
    let ok: boolean;
    let reason: string;
    const rep = this.reputationCheck(key.slice(0, key.lastIndexOf(':')));
    if (rep) {
      this.auditReputation(rep, method, url, 'proxy', 'blocked');
      return false;
    }
    if (this.denied(key)) {
      ok = false;
      reason = 'host on denylist';
    } else if (this.mode === 'manual') {
      ok = true;
      reason = 'manual browsing (log-only)';
    } else if (this.allow.has(key)) {
      ok = true;
      reason = 'host on task allowlist';
    } else {
      ok = false;
      reason = 'agent task running: host not on task allowlist';
    }
    if (!ok && this.mode === 'agent') {
      this.blocked.set(key, (this.blocked.get(key) ?? 0) + 1);
      this.changed();
    }
    this.audit({ layer: 'proxy', decision: ok ? (this.mode === 'manual' ? 'log' : 'allow') : 'block', host: key, method, url: url?.slice(0, 500), reason });
    return ok;
  }

  private approvals: ApprovedRequest[] = [];

  /**
   * A request the user confirmed at the action layer (a form submission): method + URL + the exact
   * field set shown in the dialog. Valid only while that action runs (see clearApprovals).
   */
  approveRequest(a: ApprovedRequest) {
    this.approvals.push({ ...a, url: a.url.split('#')[0] });
  }

  /** Called when the approved action completes: unconsumed approvals must not linger. */
  clearApprovals() {
    this.approvals = [];
  }

  /**
   * Does a state-changing request match a one-shot approval? 'match' consumes it. 'mismatch' means an
   * approval exists for this method + URL but the body differs (re-confirm with the real body).
   */
  matchApproval(method: string, url: string, body: string): { result: 'match' | 'mismatch' | 'none'; enctype?: string; boundary?: string } {
    const u = url.split('#')[0];
    const cands = this.approvals.filter((a) => a.method === method.toUpperCase() && a.url === u);
    if (!cands.length) return { result: 'none' };
    for (const a of cands) {
      const enctype = (a.enctype || 'application/x-www-form-urlencoded').toLowerCase();
      const pairs = parseBody(body, enctype);
      if (pairs && fieldsMatch(a.fields, pairs)) {
        this.approvals.splice(this.approvals.indexOf(a), 1);
        return { result: 'match', enctype, boundary: enctype === 'multipart/form-data' ? parseMultipart(body)?.boundary : undefined };
      }
    }
    return { result: 'mismatch' };
  }

  /** Mark registry values as approved for sending to a host (after a user confirmation). */
  confirmFlow(taintIds: string[], destination: string) {
    const k = hostKey(destination);
    if (!k) return;
    for (const id of taintIds) this.confirmedFlows.add(`${id}|${k}`);
  }

  /** Registry values found in text (used to turn a confirmation into confirmed flows). */
  idsIn(text: string): string[] {
    return this.taint ? this.taint.matchRequest(text).map((v) => v.id) : [];
  }

  /**
   * Content-level check for one request. Returns the registry values that would leave to this host
   * without a confirmed flow. In manual mode matches are only logged.
   */
  checkRequest(url: string, method: string, body?: string): { unconfirmed: RegisteredValue[]; host: string } {
    const host = hostKey(url) ?? '?';
    if (!this.taint) return { unconfirmed: [], host };
    const hits = this.taint.matchRequest(url, body);
    const unconfirmed = hits.filter((v) => !this.confirmedFlows.has(`${v.id}|${host}`));
    if (hits.length) {
      this.audit({
        layer: 'webrequest',
        decision: unconfirmed.length === 0 ? 'allow' : this.mode === 'agent' ? 'confirm-requested' : 'log',
        host,
        method,
        url: url.slice(0, 500),
        reason: unconfirmed.length === 0 ? 'tainted values covered by a confirmed flow' : 'request carries tainted values',
        taintIds: hits.map((h) => h.id),
      });
    }
    return { unconfirmed: this.mode === 'agent' ? unconfirmed : [], host };
  }

  auditWebRequest(e: Omit<EgressAuditEntry, 'layer'>) {
    this.audit({ layer: 'webrequest', ...e });
  }
}

export interface ProxyHandle {
  port: number;
  close(): Promise<void>;
}

/** Start the forward proxy on 127.0.0.1 with an ephemeral port. */
export function startProxy(ctl: EgressController): Promise<ProxyHandle> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const key = hostKey(url);
    if (!key || !/^http:\/\//i.test(url)) {
      res.writeHead(400).end('guarded-browser proxy: absolute http URL required');
      return;
    }
    if (!ctl.decideHost(key, req.method ?? 'GET', url)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`guarded-browser: blocked host ${key}`);
      return;
    }
    const u = new URL(url);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers, autoSelectFamily: true } as http.RequestOptions,
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502).end(`guarded-browser proxy: upstream error ${e.message}`);
      else res.destroy();
    });
    req.pipe(up);
  });

  const tunnel = (client: net.Socket, key: string, head: Buffer, preface?: string) => {
    const [host, port] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
    const upstream = net.connect({ host, port, autoSelectFamily: true });
    upstream.on('connect', () => {
      if (preface) upstream.write(preface);
      else client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  };

  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    const key = hostKey(req.url ?? '');
    if (!key || !ctl.decideHost(key, 'CONNECT')) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    tunnel(client, key, head);
  });

  // plain-http websocket upgrades
  server.on('upgrade', (req, client: net.Socket, head: Buffer) => {
    const url = req.url ?? '';
    const key = hostKey(url);
    if (!key || !ctl.decideHost(key, 'UPGRADE', url)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const u = new URL(url);
    const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    tunnel(client, key, head, lines.join('\r\n') + '\r\n\r\n');
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

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
import type { ReputationDb, ReputationHit } from './reputation';

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
  reputation: ReputationDb | null = null;
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
    this.approvedSubmissions = [];
    this.taint = taint;
    this.changed();
  }

  endTask() {
    this.mode = 'manual';
    this.allow.clear();
    this.blocked.clear();
    this.confirmedFlows.clear();
    this.approvedSubmissions = [];
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

  private approvedSubmissions: Array<{ url: string; until: number }> = [];

  /** A form submission the user confirmed at the action layer: one matching POST may pass. */
  approveSubmission(url: string) {
    this.approvedSubmissions.push({ url: url.split('#')[0], until: Date.now() + 30_000 });
  }

  /**
   * Is a state-changing top-level request (POST/PUT/PATCH/DELETE navigation, i.e. a form submission)
   * covered by a confirmed submission? Consumes the approval. Independent of snapshot heuristics.
   */
  consumeSubmission(url: string): boolean {
    const now = Date.now();
    this.approvedSubmissions = this.approvedSubmissions.filter((a) => a.until > now);
    const i = this.approvedSubmissions.findIndex((a) => a.url === url.split('#')[0]);
    if (i < 0) return false;
    this.approvedSubmissions.splice(i, 1);
    return true;
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

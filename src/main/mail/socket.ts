// The real IMAP socket (ticket 36b) — the ONLY place mail opens a connection.
//
// `src/core/mail/imap.ts` takes a `SocketFactory` so the protocol is testable without a network; this
// module is the production implementation of that seam, and it is deliberately the only file in the
// mail program that touches `node:tls`/`node:net`.
//
// Decisions, made explicit because they are the security posture of the mail channel:
//  * **Certificate verification is ON and there is no switch to turn it off.** A mail client that
//    accepts any certificate can be MITM'd into handing over a password, and there is no UI setting
//    that would make that acceptable.
//  * **The socket is NOT the browser's session proxy.** Mail cannot go through the profile's egress
//    proxy: that path is loopback-bound, task-gated and per-profile, and mail must keep working while
//    an agent task runs (the mail channel is refused during a task at the CALLER, by policy, not by
//    the proxy). This is audited rather than silent — see `SocketAudit`.
//  * **Implicit TLS only, today.** STARTTLS needs the client to upgrade mid-session; rather than
//    half-implement it, an account that asks for it is refused with a clear reason at validation time
//    (`accounts.ts` refuses 'starttls' with an explicit message). Declared unsupported beats a
//    connection that mysteriously fails.
//  * TLS 1.2 is the floor, SNI is set, and there is a connect timeout so an unresponsive host cannot
//    hold an account slot open.

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { ImapSocket, SocketFactory, SocketOpts } from '../../core/mail/imap';

export const CONNECT_TIMEOUT_MS = 20_000;
export const MIN_TLS_VERSION = 'TLSv1.2';
/** no mail socket is allowed to buffer more than this before the client reads it */
export const MAX_SOCKET_BUFFER = 8 * 1024 * 1024;

export interface SocketAuditEvent {
  kind: 'open' | 'close' | 'error' | 'refused';
  host: string;
  port: number;
  tls: SocketOpts['tls'];
  /** the negotiated protocol/cipher, when there is one (never the certificate's contents) */
  detail?: string;
}

export interface SocketFactoryOptions {
  /** called on open / close / error so the audit log can record every mail connection */
  audit?: (e: SocketAuditEvent) => void;
  timeoutMs?: number;
  /** test seam: replace the TLS connector (a test can supply a socket without a certificate) */
  connectImpl?: typeof tlsConnect;
}

/**
 * Build the production `SocketFactory`. `createSocket()` resolves once the TLS handshake is complete,
 * so a certificate failure is reported as a connection failure (step 'tls' in the taxonomy) rather
 * than as a mysterious auth error later.
 */
export function makeSocketFactory(opts: SocketFactoryOptions = {}): SocketFactory {
  const timeout = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const connectTls = opts.connectImpl ?? tlsConnect;
  return async ({ host, port, tls }: SocketOpts): Promise<ImapSocket> => {
    if (tls !== 'implicit') {
      // Explicit rather than a silent plaintext login: see the module comment.
      opts.audit?.({ kind: 'refused', host, port, tls, detail: 'only implicit TLS is supported in this build' });
      throw new Error(`TLS mode "${tls}" is not supported in this build: only an implicit TLS mail server (port 993/995) can be opened. STARTTLS is not implemented rather than half-implemented.`);
    }
    const sock = await openTls(connectTls, host, port, timeout);
    opts.audit?.({
      kind: 'open',
      host,
      port,
      tls,
      detail: `${sock.getProtocol?.() ?? '?'}/${sock.getCipher?.()?.name ?? '?'}`,
    });

    let dataCb: ((c: string) => void) | null = null;
    let closeCb: ((e?: Error) => void) | null = null;
    let closed = false;
    const pending: string[] = [];

    const flush = () => {
      if (!dataCb) return;
      for (const c of pending.splice(0)) dataCb(c);
    };
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      if (dataCb) dataCb(chunk);
      else if (pending.join('').length < MAX_SOCKET_BUFFER) pending.push(chunk);
    });
    sock.on('error', (e: Error) => {
      const wasClosed = closed;
      closed = true;
      opts.audit?.({ kind: 'error', host, port, tls, detail: e.message.slice(0, 120) });
      if (!wasClosed) closeCb?.(e);
    });
    sock.on('close', () => {
      const wasClosed = closed;
      closed = true;
      opts.audit?.({ kind: 'close', host, port, tls });
      if (!wasClosed) closeCb?.(new Error('the connection was closed by the server'));
    });

    return {
      write: (d: string) => {
        if (closed) return;
        // never let a stalled peer buffer unbounded mail text in the process
        if (sock.writableLength > MAX_SOCKET_BUFFER) {
          sock.destroy(new Error('mail socket buffer exceeded'));
          return;
        }
        sock.write(d);
      },
      onData: (cb) => {
        dataCb = cb;
        flush();
      },
      onClose: (cb) => {
        closeCb = cb;
      },
      end: () => {
        closed = true;
        try {
          sock.end();
        } catch {
          sock.destroy();
        }
      },
    };
  };
}

function openTls(connectTls: typeof tlsConnect, host: string, port: number, timeoutMs: number): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const sock = connectTls({
      host,
      port,
      // SNI: without it a shared host serves the wrong certificate and verification fails confusingly
      servername: host,
      // NEVER relaxed: an unverified certificate can be presented by anyone in the path
      rejectUnauthorized: true,
      minVersion: MIN_TLS_VERSION,
    });
    const timer = setTimeout(() => {
      done(() => {
        sock.destroy();
        reject(new Error(`mail connection to ${host}:${port} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      done(() => resolve(sock));
    });
    sock.once('error', (e: Error) => {
      clearTimeout(timer);
      done(() => reject(e));
    });
  });
}

/**
 * A plain TCP connect, used ONLY to report the right failure step: a host that refuses the port must
 * read as "the server did not accept a connection", not as a TLS handshake problem.
 */
export function probeTcpReachable(host: string, port: number, timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const sock: Socket = netConnect({ host, port });
    const t = setTimeout(() => finish({ ok: false, error: 'timed out' }), timeoutMs);
    sock.once('connect', () => finish({ ok: true }));
    sock.once('error', (e: Error) => finish({ ok: false, error: e.message }));
  });
}

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
//  * **IMAP: implicit TLS only, today.** An IMAP account that asks for STARTTLS is refused with a clear
//    reason (the importer skips it). **SMTP (ticket 38): implicit TLS (465) or a STRICT STARTTLS
//    (587)** — `makeSmtpSocketFactory` below. The upgrade is `tls.connect({ socket })` with the same
//    verification as an implicit connection; the protocol rules around it (STARTTLS must be offered,
//    capabilities discarded, injection detected) live in src/core/mail/smtp.ts. Plaintext is refused
//    by both factories.
//  * TLS 1.2 is the floor, SNI is set, and there is a connect timeout so an unresponsive host cannot
//    hold an account slot open.

import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { ImapSocket, SocketFactory, SocketOpts } from '../../core/mail/imap';
import type { SmtpSocket, SmtpSocketFactory, SmtpSocketOpts } from '../../core/mail/smtp';

export const CONNECT_TIMEOUT_MS = 20_000;
export const MIN_TLS_VERSION = 'TLSv1.2';
/** no mail socket is allowed to buffer more than this before the client reads it */
export const MAX_SOCKET_BUFFER = 8 * 1024 * 1024;

export interface SocketAuditEvent {
  kind: 'open' | 'close' | 'error' | 'refused' | 'starttls';
  host: string;
  port: number;
  tls: SocketOpts['tls'];
  /** which protocol the socket is for (absent = imap, the original factory) */
  protocol?: 'imap' | 'smtp';
  /** the negotiated protocol/cipher, when there is one (never the certificate's contents) */
  detail?: string;
}

export interface SocketFactoryOptions {
  /** called on open / close / error so the audit log can record every mail connection */
  audit?: (e: SocketAuditEvent) => void;
  timeoutMs?: number;
  /** test seam: replace the TLS connector (a test can supply a socket without a certificate) */
  connectImpl?: typeof tlsConnect;
  /**
   * TEST ONLY: an extra trusted CA (PEM) for LOOPBACK hosts, so a test can run a real TLS server with
   * a throwaway self-signed certificate. Verification stays ON (`rejectUnauthorized: true`): this adds
   * a trust anchor, it never disables the check, and it is ignored for any non-loopback host. The
   * runtime passes it only from `testEnv('GUARDED_TEST_MAIL_CA')` (GUARDED_TEST=1, unpackaged build).
   */
  testCa?: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The TLS options every mail connection uses. One place, so IMAP, SMTP and STARTTLS cannot differ. */
export function tlsOptions(host: string, opts: SocketFactoryOptions): ConnectionOptions {
  return {
    // SNI: without it a shared host serves the wrong certificate (an IP literal is not a valid SNI
    // name; the certificate is still checked against the IP)
    ...(isIP(host) ? {} : { servername: host }),
    // NEVER relaxed: an unverified certificate can be presented by anyone in the path
    rejectUnauthorized: true,
    minVersion: MIN_TLS_VERSION,
    ...(opts.testCa && LOOPBACK.has(host.toLowerCase()) ? { ca: [opts.testCa] } : {}),
  };
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
    const sock = await openTls(connectTls, host, port, timeout, opts);
    opts.audit?.({
      kind: 'open',
      host,
      port,
      tls,
      detail: `${sock.getProtocol?.() ?? '?'}/${sock.getCipher?.()?.name ?? '?'}`,
    });

    let dataCb: ((c: Buffer) => void) | null = null;
    let closeCb: ((e?: Error) => void) | null = null;
    let closed = false;
    const pending: Buffer[] = [];
    let pendingBytes = 0;

    const flush = () => {
      if (!dataCb) return;
      pendingBytes = 0;
      for (const c of pending.splice(0)) dataCb(c);
    };
    // NO setEncoding: IMAP literal sizes are octet counts, so the parser must see bytes. A UTF-8
    // decoded stream turns `{N}` into a character count and desyncs on the first non-ASCII literal.
    sock.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (dataCb) dataCb(buf);
      else if (pendingBytes < MAX_SOCKET_BUFFER) {
        pending.push(buf);
        pendingBytes += buf.length;
      }
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

function openTls(connectTls: typeof tlsConnect, host: string, port: number, timeoutMs: number, opts: SocketFactoryOptions): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // verification is ON in tlsOptions (rejectUnauthorized: true, NEVER relaxed)
    const sock = connectTls({ host, port, ...tlsOptions(host, opts) });
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

// ---------------------------------------------------------------- SMTP (ticket 38)

function openPlain(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const sock = netConnect({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`mail connection to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(sock);
    });
    sock.once('error', (e: Error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * The production SMTP socket: implicit TLS from the first byte (465), or a plaintext connection that
 * can ONLY be used to reach STARTTLS (587) and is then upgraded in place with the same verification
 * as an implicit connection. Plaintext 'none' and port 25 are refused here as well as in smtp.ts.
 */
export function makeSmtpSocketFactory(opts: SocketFactoryOptions = {}): SmtpSocketFactory {
  const timeout = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const connectTls = opts.connectImpl ?? tlsConnect;
  return async ({ host, port, tls }: SmtpSocketOpts): Promise<SmtpSocket> => {
    const audit = (e: Omit<SocketAuditEvent, 'host' | 'port' | 'tls' | 'protocol'>) => opts.audit?.({ ...e, host, port, tls, protocol: 'smtp' });
    if (tls !== 'implicit' && tls !== 'starttls') {
      audit({ kind: 'refused', detail: 'plaintext SMTP is refused' });
      throw new Error('plaintext SMTP is refused: use implicit TLS (465) or STARTTLS (587)');
    }
    if (port === 25) {
      audit({ kind: 'refused', detail: 'port 25 is relay, not submission' });
      throw new Error('port 25 is server-to-server relay, not submission: use 465 or 587');
    }
    let sock: Socket | TLSSocket = tls === 'implicit' ? await openTls(connectTls, host, port, timeout, opts) : await openPlain(host, port, timeout);
    let secure = tls === 'implicit';
    const describe = (t: TLSSocket) => `${t.getProtocol?.() ?? '?'}/${t.getCipher?.()?.name ?? '?'}`;
    audit({ kind: 'open', detail: secure ? describe(sock as TLSSocket) : 'plaintext until STARTTLS' });

    let dataCb: ((c: Buffer) => void) | null = null;
    let closeCb: ((e?: Error) => void) | null = null;
    let closed = false;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (dataCb) dataCb(buf);
      else if (pendingBytes < MAX_SOCKET_BUFFER) {
        pending.push(buf);
        pendingBytes += buf.length;
      }
    };
    const onError = (e: Error) => {
      const was = closed;
      closed = true;
      audit({ kind: 'error', detail: e.message.slice(0, 120) });
      if (!was) closeCb?.(e);
    };
    const onClose = () => {
      const was = closed;
      closed = true;
      audit({ kind: 'close' });
      if (!was) closeCb?.(new Error('the connection was closed by the server'));
    };
    const attach = (s: Socket) => {
      s.on('data', onData);
      s.on('error', onError);
      s.on('close', onClose);
    };
    const detach = (s: Socket) => {
      s.removeListener('data', onData);
      s.removeListener('error', onError);
      s.removeListener('close', onClose);
    };
    attach(sock);

    return {
      get secure() {
        return secure;
      },
      write: (d: Buffer | string) => {
        if (closed) return;
        if (sock.writableLength > MAX_SOCKET_BUFFER) {
          sock.destroy(new Error('mail socket buffer exceeded'));
          return;
        }
        sock.write(d);
      },
      onData: (cb) => {
        dataCb = cb;
        for (const c of pending.splice(0)) cb(c);
        pendingBytes = 0;
      },
      onClose: (cb) => {
        closeCb = cb;
      },
      startTls: () =>
        new Promise<void>((resolve, reject) => {
          if (secure || closed) {
            reject(new Error(secure ? 'the connection is already encrypted' : 'the connection is closed'));
            return;
          }
          const plain = sock as Socket;
          detach(plain);
          // From here until the handshake completes, a plaintext byte can only be an injection.
          // (Once tls.connect owns the socket, such bytes break the handshake instead.)
          let injected = false;
          const onPlain = () => {
            injected = true;
            plain.destroy(new Error('STARTTLS injection: plaintext data during the TLS upgrade'));
          };
          plain.on('data', onPlain);
          // `host` explicitly: the certificate identity check must not depend on the socket's own record
          const t = connectTls({ socket: plain, host, ...tlsOptions(host, opts) });
          const timer = setTimeout(() => {
            t.destroy();
            reject(new Error(`the STARTTLS handshake with ${host}:${port} timed out`));
          }, timeout);
          t.once('secureConnect', () => {
            clearTimeout(timer);
            plain.removeListener('data', onPlain);
            if (injected) {
              t.destroy();
              reject(new Error('STARTTLS injection: plaintext data during the TLS upgrade'));
              return;
            }
            sock = t;
            secure = true;
            attach(t);
            audit({ kind: 'starttls', detail: describe(t) });
            resolve();
          });
          t.once('error', (e: Error) => {
            clearTimeout(timer);
            closed = true;
            audit({ kind: 'error', detail: `STARTTLS: ${e.message.slice(0, 120)}` });
            reject(e);
          });
        }),
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

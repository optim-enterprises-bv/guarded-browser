// Fake SMTP submission server for tests (ticket 38).
//
// Two ways to drive it, sharing ONE protocol engine:
//   * `server.socket()` — an in-memory `SmtpSocket` for unit tests (no port, no TLS: `startTls()` flips
//     a flag), the same idea as FakeImapServer.socket();
//   * `server.listen({ key, cert, implicit })` — a real TCP server on 127.0.0.1 with a REAL TLS
//     upgrade, for the STARTTLS test and the e2e spec.
//
// It is STRICT where a real server is, and records what a test needs to assert on:
//   * AUTH before TLS is refused (530) and recorded as a violation; MAIL before AUTH is refused;
//   * after STARTTLS every session state is reset, and EHLO is required again;
//   * DATA is read as BYTES; a line beginning with a single "." (an un-stuffed dot) or a bare CR/LF is
//     a violation; the stored message is the de-stuffed bytes;
//   * it can play the ATTACKER: inject bytes after "220 ready to start TLS" (STARTTLS injection), not
//     advertise STARTTLS, reject recipients, answer 4xx/5xx, hang (timeout), advertise a SIZE.

import { createServer as netServer, type Server, type Socket } from 'node:net';
import { createServer as tlsServer, createSecureContext, TLSSocket } from 'node:tls';
import type { SmtpSocket } from '../../src/core/mail/smtp';

export interface FakeSmtpOptions {
  user?: string;
  password?: string;
  /** advertise STARTTLS on the plaintext connection (default true) */
  starttls?: boolean;
  /** advertise AUTH before TLS too (a misconfigured server; the client must still not use it) */
  authBeforeTls?: boolean;
  /** AUTH mechanisms advertised over TLS */
  mechanisms?: string[];
  /** advertise SIZE n (0 = no SIZE) */
  size?: number;
  /** address (lowercase) -> full reply line for RCPT, e.g. '550 5.1.1 no such user' */
  rejectRcpt?: Record<string, string>;
  /** the reply to the final dot */
  dataReply?: string;
  /** the reply to MAIL FROM */
  mailReply?: string;
  /** bytes appended to "220 ready to start TLS" in the SAME write (a STARTTLS injection) */
  injectAfterStartTls?: string;
  /** real socket: bytes written in plaintext in a SEPARATE packet after "220 ready", before the upgrade */
  injectLater?: string;
  /** accept the message (record it) and drop the connection without answering the final dot */
  dropAfterData?: boolean;
  /** in-memory only: bytes emitted WHILE the upgrade is in progress (before startTls resolves) */
  injectDuringUpgrade?: string;
  /** never answer at this step */
  hang?: 'greeting' | 'ehlo' | 'auth' | 'mail' | 'rcpt' | 'data-end';
  /** the greeting line (default a 220) */
  greeting?: string;
}

export interface Received {
  from: string;
  to: string[];
  /** the message as the server stores it (de-stuffed, CRLF) */
  data: Buffer;
  /** the DATA bytes exactly as they arrived, up to (excluding) the terminating dot line */
  wire: Buffer;
  /** whether the session was encrypted when the message was accepted */
  secure: boolean;
}

interface Transport {
  write(b: Buffer | string): void;
  close(): void;
  upgrade(): Promise<void>;
  secure: boolean;
}

export class FakeSmtpServer {
  readonly log: string[] = [];
  readonly violations: string[] = [];
  readonly received: Received[] = [];
  readonly auths: Array<{ mech: string; user: string; secret: string; secure: boolean }> = [];
  /** every connection's EHLO count, for "EHLO again after STARTTLS" */
  readonly ehlos: Array<{ secure: boolean }> = [];
  connections = 0;

  constructor(readonly opts: FakeSmtpOptions = {}) {}

  get transcript(): string {
    return this.log.join('');
  }

  /** A fresh in-memory connection (unit tests). */
  socket(opts: { implicit?: boolean } = {}): SmtpSocket {
    let dataCb: ((c: Buffer) => void) | null = null;
    let closeCb: ((e?: Error) => void) | null = null;
    let closed = false;
    const early: Buffer[] = [];
    const t: Transport = {
      secure: !!opts.implicit,
      write: (b) => {
        if (closed) return;
        const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
        if (dataCb) dataCb(buf);
        else early.push(buf);
      },
      close: () => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => closeCb?.());
      },
      upgrade: async () => undefined,
    };
    const feed = this.session(t);
    const self = this;
    return {
      get secure() {
        return t.secure;
      },
      write: (d) => {
        if (closed) return;
        feed(typeof d === 'string' ? Buffer.from(d, 'utf8') : d);
      },
      onData: (cb) => {
        dataCb = cb;
        for (const b of early.splice(0)) cb(b);
      },
      onClose: (cb) => {
        closeCb = cb;
      },
      startTls: async () => {
        if (self.opts.injectDuringUpgrade) dataCb?.(Buffer.from(self.opts.injectDuringUpgrade, 'latin1'));
        await Promise.resolve();
        t.secure = true;
      },
      end: () => {
        closed = true;
      },
    };
  }

  /** A real server on 127.0.0.1. `implicit` = TLS from the first byte (465); else STARTTLS (587). */
  async listen(o: { key: string; cert: string; implicit?: boolean }): Promise<{ port: number; close(): Promise<void> }> {
    const ctx = createSecureContext({ key: o.key, cert: o.cert });
    const sockets = new Set<Socket>();
    const onRaw = (raw: Socket, secure: boolean) => {
      sockets.add(raw);
      raw.on('close', () => sockets.delete(raw));
      raw.on('error', () => undefined);
      let cur: Socket = raw;
      let feed: (b: Buffer) => void = () => undefined;
      const onData = (b: Buffer) => feed(b);
      const t: Transport = {
        secure,
        write: (b) => {
          if (!cur.destroyed) cur.write(b);
        },
        close: () => cur.end(),
        upgrade: () =>
          new Promise<void>((resolve) => {
            cur.removeListener('data', onData);
            const tl = new TLSSocket(cur, { isServer: true, secureContext: ctx });
            tl.on('error', () => undefined);
            tl.once('secure', () => {
              t.secure = true;
              resolve();
            });
            tl.on('data', onData);
            sockets.add(tl);
            cur = tl;
          }),
      };
      feed = this.session(t);
      cur.on('data', onData);
    };
    const server: Server = o.implicit ? tlsServer({ key: o.key, cert: o.cert }, (s) => onRaw(s, true)) : netServer((s) => onRaw(s, false));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return {
      port,
      close: async () => {
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(() => r(undefined)));
      },
    };
  }

  // ------------------------------------------------------------ the protocol engine

  private session(t: Transport): (b: Buffer) => void {
    this.connections++;
    const o = this.opts;
    let buf: Buffer = Buffer.alloc(0);
    let ehlo = false;
    let authed = false;
    let from: string | null = null;
    let rcpts: string[] = [];
    let inData = false;
    let dataBytes: Buffer[] = [];
    let sasl: { mech: 'LOGIN'; step: 'user' | 'pass'; user: string } | { mech: 'XOAUTH2-ERR' } | null = null;
    let upgrading = false;
    const reply = (s: string) => t.write(`${s}\r\n`);

    if (o.hang !== 'greeting') queueMicrotask(() => reply(o.greeting ?? '220 fake.example ESMTP ready'));

    const caps = (): string[] => {
      const c = ['fake.example greets you'];
      if (o.size) c.push(`SIZE ${o.size}`);
      c.push('8BITMIME');
      if (!t.secure && o.starttls !== false) c.push('STARTTLS');
      if (t.secure || o.authBeforeTls) c.push(`AUTH ${(o.mechanisms ?? ['PLAIN', 'LOGIN']).join(' ')}`);
      return c;
    };

    const finishData = () => {
      const wire = Buffer.concat(dataBytes);
      // check the wire form: CRLF only, and every leading dot stuffed
      const lines: Buffer[] = [];
      let start = 0;
      for (let i = 0; i < wire.length; i++) {
        if (wire[i] === 0x0a) {
          if (i === 0 || wire[i - 1] !== 0x0d) this.violations.push('bare LF in DATA');
          lines.push(wire.subarray(start, i - 1 >= start ? i - 1 : start));
          start = i + 1;
        } else if (wire[i] === 0x0d && wire[i + 1] !== 0x0a) this.violations.push('bare CR in DATA');
      }
      const out: Buffer[] = [];
      for (const l of lines) {
        if (l[0] === 0x2e) {
          if (l[1] !== 0x2e) this.violations.push('a line starts with an un-stuffed dot');
          out.push(l.subarray(1));
        } else out.push(l);
      }
      const data = Buffer.concat(out.flatMap((l) => [l, Buffer.from('\r\n')]));
      this.received.push({ from: from ?? '', to: [...rcpts], data, wire, secure: t.secure });
      from = null;
      rcpts = [];
      if (o.dropAfterData) return t.close();
      if (o.hang === 'data-end') return;
      reply(o.dataReply ?? '250 2.0.0 queued as FAKE1');
    };

    const line = (l: string) => {
      this.log.push(`${l}\r\n`);
      if (sasl) {
        const s = sasl;
        sasl = null;
        if (s.mech === 'XOAUTH2-ERR') return reply('535 5.7.8 Username and Password not accepted');
        const dec = Buffer.from(l, 'base64').toString('utf8');
        if (s.step === 'user') {
          sasl = { mech: 'LOGIN', step: 'pass', user: dec };
          return reply('334 UGFzc3dvcmQ6');
        }
        return checkAuth('LOGIN', s.user, dec);
      }
      const [verbRaw = '', ...rest] = l.split(' ');
      const verb = verbRaw.toUpperCase();
      const arg = rest.join(' ');
      switch (verb) {
        case 'EHLO':
        case 'HELO': {
          if (o.hang === 'ehlo') return;
          ehlo = true;
          this.ehlos.push({ secure: t.secure });
          const c = caps();
          return t.write(c.map((x, i) => `250${i === c.length - 1 ? ' ' : '-'}${x}\r\n`).join(''));
        }
        case 'STARTTLS': {
          if (t.secure) return reply('503 5.5.1 already in TLS');
          if (o.starttls === false) return reply('502 5.5.1 STARTTLS not offered');
          upgrading = true;
          if (o.injectLater) {
            t.write('220 2.0.0 Ready to start TLS\r\n');
            setTimeout(() => {
              t.write(o.injectLater ?? '');
              void t.upgrade();
            }, 50);
            return;
          }
          t.write(`220 2.0.0 Ready to start TLS\r\n${o.injectAfterStartTls ?? ''}`);
          // everything learned in plaintext is forgotten (RFC 3207 4.2)
          ehlo = false;
          authed = false;
          from = null;
          rcpts = [];
          void t.upgrade().then(() => {
            upgrading = false;
          });
          return;
        }
        case 'AUTH': {
          if (!ehlo) return reply('503 5.5.1 EHLO first');
          if (!t.secure) {
            this.violations.push('AUTH before TLS');
            return reply('530 5.7.0 Must issue a STARTTLS command first');
          }
          if (o.hang === 'auth') return;
          const [mech = '', initial] = arg.split(' ');
          const M = mech.toUpperCase();
          if (!(o.mechanisms ?? ['PLAIN', 'LOGIN']).includes(M)) return reply('504 5.5.4 mechanism not supported');
          if (M === 'PLAIN') {
            const dec = Buffer.from(initial ?? '', 'base64').toString('utf8');
            const [, user = '', pass = ''] = dec.split('\u0000');
            return checkAuth('PLAIN', user, pass);
          }
          if (M === 'LOGIN') {
            sasl = { mech: 'LOGIN', step: 'user', user: '' };
            return reply('334 VXNlcm5hbWU6');
          }
          if (M === 'XOAUTH2') {
            const dec = Buffer.from(initial ?? '', 'base64').toString('utf8');
            const m = /^user=([^\u0001]*)\u0001auth=Bearer ([^\u0001]*)\u0001\u0001$/.exec(dec);
            if (!m) return reply('501 5.5.2 malformed XOAUTH2');
            this.auths.push({ mech: 'XOAUTH2', user: m[1], secret: m[2], secure: t.secure });
            if (o.password && m[2] !== o.password) {
              sasl = { mech: 'XOAUTH2-ERR' };
              return reply(`334 ${Buffer.from('{"status":"401"}').toString('base64')}`);
            }
            authed = true;
            return reply('235 2.7.0 Accepted');
          }
          return reply('504 5.5.4 mechanism not supported');
        }
        case 'MAIL': {
          if (!t.secure) this.violations.push('MAIL before TLS');
          if (!authed) return reply('530 5.7.0 Authentication required');
          if (o.hang === 'mail') return;
          const m = /^FROM:<([^>]*)>(?:\s+SIZE=(\d+))?/i.exec(arg);
          if (!m) return reply('501 5.5.4 syntax');
          if (o.size && m[2] && Number(m[2]) > o.size) return reply('552 5.3.4 message too big');
          if (o.mailReply) return reply(o.mailReply);
          from = m[1];
          rcpts = [];
          return reply('250 2.1.0 OK');
        }
        case 'RCPT': {
          if (from === null) return reply('503 5.5.1 MAIL first');
          if (o.hang === 'rcpt') return;
          const m = /^TO:<([^>]*)>$/i.exec(arg);
          if (!m) return reply('501 5.5.4 syntax');
          const rej = o.rejectRcpt?.[m[1].toLowerCase()];
          if (rej) return reply(rej);
          rcpts.push(m[1]);
          return reply('250 2.1.5 OK');
        }
        case 'DATA': {
          if (from === null || !rcpts.length) return reply('503 5.5.1 RCPT first');
          inData = true;
          dataBytes = [];
          return reply('354 End data with <CR><LF>.<CR><LF>');
        }
        case 'RSET':
          from = null;
          rcpts = [];
          return reply('250 2.0.0 OK');
        case 'NOOP':
          return reply('250 2.0.0 OK');
        case 'QUIT':
          reply('221 2.0.0 Bye');
          return t.close();
        default:
          return reply('500 5.5.2 unknown command');
      }
    };

    const checkAuth = (mech: string, user: string, pass: string) => {
      this.auths.push({ mech, user, secret: pass, secure: t.secure });
      if ((o.user && user !== o.user) || (o.password && pass !== o.password)) return reply('535 5.7.8 Authentication credentials invalid');
      authed = true;
      return reply('235 2.7.0 Authentication successful');
    };

    return (chunk: Buffer) => {
      if (upgrading) {
        // a client that keeps talking in plaintext after STARTTLS is broken (or is not the client)
        this.violations.push('plaintext data during the TLS upgrade');
        return;
      }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          const atStart = buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === '.\r\n' && dataBytes.length === 0;
          if (atStart) {
            buf = buf.subarray(3);
            inData = false;
            finishData();
            continue;
          }
          if (end < 0) {
            // keep the last 4 bytes: the terminator may be split across chunks
            if (buf.length > 4) {
              dataBytes.push(buf.subarray(0, buf.length - 4));
              buf = buf.subarray(buf.length - 4);
            }
            return;
          }
          dataBytes.push(buf.subarray(0, end + 2));
          buf = buf.subarray(end + 5);
          inData = false;
          finishData();
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const l = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        line(l);
        if (upgrading) {
          if (buf.length) this.violations.push('plaintext data pipelined behind STARTTLS');
          buf = Buffer.alloc(0);
          return;
        }
      }
    };
  }
}

// SMTP submission client (ticket 38). The socket is injected, exactly like imap.ts, so the protocol
// is unit-testable against test/helpers/fake-smtp.ts with no network; the production socket (implicit
// TLS and the STARTTLS upgrade) is src/main/mail/socket.ts.
//
// The security posture, as code rather than as a promise:
//  * TLS ALWAYS. 'implicit' (465) is TLS from the first byte. 'starttls' (587) is STRICT: EHLO, the
//    server MUST advertise STARTTLS (otherwise the send is refused — there is no plaintext fallback),
//    the upgrade verifies the certificate (socket.ts), every pre-TLS capability is DISCARDED, EHLO is
//    sent again, and only then is AUTH offered. Plaintext (tls 'none') and port 25 are refused.
//  * STARTTLS INJECTION is detected: any byte the server sends after its "220 ready to start TLS"
//    line and before the handshake completes was injected by someone in the path (the bytes would be
//    read as a reply to a command sent INSIDE the tunnel). The send fails.
//  * AUTH is never sent on a socket that is not secure; the check is in `auth()` itself, so no
//    ordering mistake elsewhere can send a password in the clear.
//  * BYTES, not characters: the message is a Buffer, the size compared with SIZE is its byte length,
//    and dot-stuffing / CRLF normalisation walk the bytes.
//  * Every step has a timeout; a timeout ends the connection.
//  * A rejected recipient aborts the WHOLE send (RSET) and is reported per recipient: delivering to
//    some recipients and not others is a surprise the user did not ask for.

import { sanitizeDetail } from './imap';

export const SMTP_TIMEOUT_MS = 30_000;
export const SMTP_DATA_TIMEOUT_MS = 120_000;
export const MAX_REPLY_LINE = 4_096;
export const MAX_REPLY_LINES = 200;
/** our own ceiling, whatever the server's SIZE says (25 MB of attachments, base64-encoded, plus the text) */
export const SMTP_MAX_BYTES = 36 * 1024 * 1024;
/** the EHLO argument: an address literal, so the client does not announce the machine's hostname */
export const EHLO_NAME = '[127.0.0.1]';

export type SmtpTls = 'implicit' | 'starttls';

export interface SmtpSocket {
  write(data: Buffer | string): void;
  /** raw BYTES */
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (err?: Error) => void): void;
  /** STARTTLS: upgrade this connection in place. Resolves once the (verified) handshake is done. */
  startTls(): Promise<void>;
  /** true for an implicit-TLS socket, and after startTls() resolved */
  readonly secure: boolean;
  end(): void;
}

export interface SmtpSocketOpts {
  host: string;
  port: number;
  tls: SmtpTls;
}

export type SmtpSocketFactory = (opts: SmtpSocketOpts) => Promise<SmtpSocket>;

export type SmtpAuth = { kind: 'password'; username: string; password: string } | { kind: 'xoauth2'; username: string; token: string };

export interface SmtpSendOptions {
  host: string;
  port: number;
  tls: string;
  auth: SmtpAuth;
  from: string;
  to: string[];
  /** the complete RFC 5322 message */
  data: Buffer;
  timeoutMs?: number;
  dataTimeoutMs?: number;
  /** checked between steps: a send in flight is abandoned (before the final dot) when this is set */
  signal?: { aborted: boolean };
}

export type SmtpStage = 'refused' | 'connect' | 'greeting' | 'ehlo' | 'starttls' | 'auth' | 'size' | 'mail' | 'rcpt' | 'data' | 'done';

export interface SmtpResult {
  ok: boolean;
  stage: SmtpStage;
  error?: string;
  /** a later attempt may succeed (network trouble, 4xx); false for refusals and 5xx */
  transient: boolean;
  accepted: string[];
  rejected: Array<{ address: string; code: number; message: string }>;
  /** the final reply code the server gave (0 when none) */
  code: number;
}

export interface SmtpReply {
  code: number;
  lines: string[];
}

class SmtpError extends Error {
  constructor(
    message: string,
    readonly stage: SmtpStage,
    readonly transient: boolean,
    readonly code = 0,
  ) {
    super(message);
  }
}

/** Collects reply lines from the byte stream; strict about shape and size. */
class ReplyReader {
  private buf: Buffer = Buffer.alloc(0);
  private lines: string[] = [];
  private ready: SmtpReply[] = [];
  private waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: Error | null = null;
  /** set while a STARTTLS upgrade is in progress: ANY byte is an injection */
  upgrading = false;

  feed(chunk: Buffer) {
    if (this.failure) return;
    if (this.upgrading) {
      this.fail(new SmtpError('the server sent data between "ready to start TLS" and the TLS handshake (a STARTTLS injection attempt); refusing to continue', 'starttls', false));
      return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) break;
      const end = nl > 0 && this.buf[nl - 1] === 0x0d ? nl - 1 : nl;
      const line = this.buf.subarray(0, end).toString('latin1');
      this.buf = this.buf.subarray(nl + 1);
      if (line.length > MAX_REPLY_LINE) return this.fail(new SmtpError('the server sent an over-long reply line', 'connect', false));
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) return this.fail(new SmtpError(`the server sent a malformed reply: ${sanitizeDetail(line).slice(0, 80)}`, 'connect', false));
      this.lines.push(m[3]);
      if (this.lines.length > MAX_REPLY_LINES) return this.fail(new SmtpError('the server sent too many reply lines', 'connect', false));
      if (m[2] !== '-') {
        const reply = { code: Number(m[1]), lines: this.lines };
        this.lines = [];
        this.deliver(reply);
      }
    }
    if (this.buf.length > MAX_REPLY_LINE) this.fail(new SmtpError('the server sent an over-long reply line', 'connect', false));
  }

  /** the error that ended this reader, if any (an injection recorded during the upgrade, a close) */
  get failed(): Error | null {
    return this.failure;
  }

  /** bytes or replies the client has received but not consumed */
  get pending(): number {
    return this.buf.length + this.ready.length + this.lines.length;
  }

  private deliver(r: SmtpReply) {
    const w = this.waiter;
    if (w) {
      clearTimeout(w.timer);
      this.waiter = null;
      w.resolve(r);
    } else {
      this.ready.push(r);
    }
  }

  fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    const w = this.waiter;
    if (w) {
      clearTimeout(w.timer);
      this.waiter = null;
      w.reject(e);
    }
  }

  next(timeoutMs: number, stage: SmtpStage): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    const r = this.ready.shift();
    if (r) return Promise.resolve(r);
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const e = new SmtpError(`the server did not answer (${stage}) within ${Math.round(timeoutMs / 1000)}s`, stage, true);
        this.fail(e);
        reject(e);
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }
}

/** CRLF-normalise and dot-stuff a message, over its BYTES, and append the end-of-data marker. */
export function prepareData(msg: Buffer): Buffer {
  const out: number[] = [];
  let lineStart = true;
  for (let i = 0; i < msg.length; i++) {
    const b = msg[i];
    if (b === 0x0d) {
      // CR: a CRLF pair or a lone CR both become one CRLF
      out.push(0x0d, 0x0a);
      if (msg[i + 1] === 0x0a) i++;
      lineStart = true;
      continue;
    }
    if (b === 0x0a) {
      out.push(0x0d, 0x0a);
      lineStart = true;
      continue;
    }
    if (lineStart && b === 0x2e) out.push(0x2e); // a leading dot is doubled (RFC 5321 4.5.2)
    out.push(b);
    lineStart = false;
  }
  if (!lineStart) out.push(0x0d, 0x0a);
  out.push(0x2e, 0x0d, 0x0a);
  return Buffer.from(out);
}

/** An envelope address may contain nothing that could end the command or the path. */
function envelopeAddressOk(a: string): boolean {
  return /^[\x21-\x7e]{1,254}$/.test(a) && !/[<>()\[\]\\,;:"]/.test(a) && a.indexOf('@') > 0 && a.indexOf('@') === a.lastIndexOf('@');
}

class Session {
  readonly reader = new ReplyReader();
  caps = new Map<string, string>();
  private closed = false;

  constructor(
    readonly socket: SmtpSocket,
    private readonly timeoutMs: number,
    private readonly signal?: { aborted: boolean },
  ) {
    socket.onData((c) => this.reader.feed(c));
    socket.onClose((err) => {
      this.closed = true;
      this.reader.fail(new SmtpError(`the connection closed${err ? `: ${sanitizeDetail(err.message)}` : ''}`, 'connect', true));
    });
  }

  checkAbort(stage: SmtpStage) {
    if (this.signal?.aborted) throw new SmtpError('the send was cancelled (an agent task started); it stays in the Outbox', stage, false);
  }

  async cmd(line: string, stage: SmtpStage, timeoutMs = this.timeoutMs): Promise<SmtpReply> {
    this.checkAbort(stage);
    if (this.closed) throw new SmtpError('the connection is closed', stage, true);
    this.socket.write(`${line}\r\n`);
    return this.reader.next(timeoutMs, stage);
  }

  async ehlo(): Promise<void> {
    const r = await this.cmd(`EHLO ${EHLO_NAME}`, 'ehlo');
    if (r.code !== 250) throw replyError('the server refused EHLO', r, 'ehlo');
    // capabilities from THIS reply only; whatever was known before is gone
    this.caps = new Map();
    for (const l of r.lines.slice(1)) {
      const [k, ...rest] = l.trim().split(/\s+/);
      if (k) this.caps.set(k.toUpperCase(), rest.join(' ').toUpperCase());
    }
  }

  close() {
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

function replyError(what: string, r: SmtpReply, stage: SmtpStage): SmtpError {
  const text = sanitizeDetail(r.lines.join(' ')).slice(0, 160);
  return new SmtpError(`${what} (${r.code}${text ? ` ${text}` : ''})`, stage, r.code >= 400 && r.code < 500, r.code);
}

async function auth(s: Session, a: SmtpAuth): Promise<void> {
  // THE invariant, enforced where the password is written: no credential on a socket that is not TLS
  if (!s.socket.secure) throw new SmtpError('refusing to authenticate on a connection that is not encrypted', 'auth', false);
  const mechs = new Set((s.caps.get('AUTH') ?? '').split(/\s+/).filter(Boolean));
  const b64 = (x: string) => Buffer.from(x, 'utf8').toString('base64');
  let r: SmtpReply;
  if (a.kind === 'xoauth2') {
    if (!mechs.has('XOAUTH2')) throw new SmtpError('the server does not offer XOAUTH2 for this OAuth account', 'auth', false);
    r = await s.cmd(`AUTH XOAUTH2 ${b64(`user=${a.username}\u0001auth=Bearer ${a.token}\u0001\u0001`)}`, 'auth');
    // a 334 carries the error as a base64 JSON challenge; the client answers with an empty line
    if (r.code === 334) r = await s.cmd('', 'auth');
  } else if (mechs.has('PLAIN')) {
    r = await s.cmd(`AUTH PLAIN ${b64(`\u0000${a.username}\u0000${a.password}`)}`, 'auth');
  } else if (mechs.has('LOGIN')) {
    r = await s.cmd('AUTH LOGIN', 'auth');
    if (r.code === 334) r = await s.cmd(b64(a.username), 'auth');
    if (r.code === 334) r = await s.cmd(b64(a.password), 'auth');
  } else {
    throw new SmtpError(mechs.size ? `the server offers no password login this client supports (${[...mechs].join(' ').slice(0, 60)})` : 'the server offers no login over TLS', 'auth', false);
  }
  if (r.code !== 235) throw replyError('the server rejected the login (check the username and the password / app password)', r, 'auth');
}

/**
 * Send one message. Never throws: every failure is a result with the stage it happened at, so the
 * outbox can record it and the UI can say what went wrong.
 */
export async function smtpSend(o: SmtpSendOptions, makeSocket: SmtpSocketFactory): Promise<SmtpResult> {
  const base = { accepted: [] as string[], rejected: [] as SmtpResult['rejected'] };
  const refuse = (error: string): SmtpResult => ({ ok: false, stage: 'refused', error, transient: false, code: 0, ...base });
  if (o.tls !== 'implicit' && o.tls !== 'starttls') return refuse('plaintext SMTP is refused: set the SMTP security to implicit TLS (465) or STARTTLS (587)');
  if (o.port === 25) return refuse('port 25 is server-to-server relay, not submission: use 465 (implicit TLS) or 587 (STARTTLS)');
  if (!envelopeAddressOk(o.from)) return refuse('the sender address cannot be used in an SMTP envelope');
  if (!o.to.length) return refuse('no recipients');
  for (const r of o.to) if (!envelopeAddressOk(r)) return refuse('a recipient address cannot be used in an SMTP envelope');
  if (o.data.length > SMTP_MAX_BYTES) return refuse(`the message is larger than ${SMTP_MAX_BYTES / 1048576} MB`);

  const timeout = o.timeoutMs ?? SMTP_TIMEOUT_MS;
  let socket: SmtpSocket;
  try {
    socket = await makeSocket({ host: o.host, port: o.port, tls: o.tls });
  } catch (e) {
    return { ok: false, stage: 'connect', error: `could not reach ${o.host}:${o.port}: ${sanitizeDetail((e as Error).message)}`, transient: true, code: 0, ...base };
  }
  const s = new Session(socket, timeout, o.signal);
  const accepted: string[] = [];
  const rejected: SmtpResult['rejected'] = [];
  try {
    const greet = await s.reader.next(timeout, 'greeting');
    if (greet.code !== 220) throw replyError('the server refused the connection', greet, 'greeting');
    await s.ehlo();

    if (o.tls === 'starttls' && !socket.secure) {
      if (!s.caps.has('STARTTLS')) {
        throw new SmtpError('the server does not offer STARTTLS; refusing to send (there is no plaintext fallback)', 'starttls', false);
      }
      const r = await s.cmd('STARTTLS', 'starttls');
      if (r.code !== 220) throw replyError('the server refused STARTTLS', r, 'starttls');
      // anything already buffered behind the 220 arrived in plaintext and would be read as a reply
      // to a command sent inside the tunnel
      if (s.reader.pending) {
        throw new SmtpError('the server sent data after "ready to start TLS" (a STARTTLS injection attempt); refusing to continue', 'starttls', false);
      }
      s.reader.upgrading = true;
      try {
        await socket.startTls();
      } catch (e) {
        if (e instanceof SmtpError) throw e;
        throw new SmtpError(`the TLS upgrade failed: ${sanitizeDetail((e as Error).message)}`, 'starttls', false);
      }
      s.reader.upgrading = false;
      // bytes that arrived DURING the upgrade were recorded as an injection: stop before EHLO
      if (s.reader.failed) throw s.reader.failed;
      s.caps = new Map(); // every pre-TLS capability is discarded
      await s.ehlo();
    }
    if (!socket.secure) throw new SmtpError('the connection is not encrypted; refusing to send', 'starttls', false);

    await auth(s, o.auth);

    const size = Number(s.caps.get('SIZE') ?? 0);
    if (size > 0 && o.data.length > size) {
      throw new SmtpError(`the message is ${o.data.length} bytes and the server accepts at most ${size}`, 'size', false);
    }

    const mail = await s.cmd(`MAIL FROM:<${o.from}>${s.caps.has('SIZE') ? ` SIZE=${o.data.length}` : ''}`, 'mail');
    if (mail.code !== 250) throw replyError('the server refused the sender', mail, 'mail');
    for (const rcpt of o.to) {
      const r = await s.cmd(`RCPT TO:<${rcpt}>`, 'rcpt');
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
      else rejected.push({ address: rcpt, code: r.code, message: sanitizeDetail(r.lines.join(' ')).slice(0, 160) });
    }
    if (rejected.length) {
      // nothing is delivered when any recipient is refused: reset the transaction and say who
      await s.cmd('RSET', 'rcpt').catch(() => undefined);
      const transient = rejected.every((x) => x.code >= 400 && x.code < 500);
      throw new SmtpError(`${rejected.length} recipient(s) refused: ${rejected.map((x) => `${x.address} (${x.code})`).join(', ').slice(0, 300)}`, 'rcpt', transient, rejected[0].code);
    }
    const data = await s.cmd('DATA', 'data');
    if (data.code !== 354) throw replyError('the server refused DATA', data, 'data');
    s.checkAbort('data');
    socket.write(prepareData(o.data));
    let done: SmtpReply;
    try {
      done = await s.reader.next(o.dataTimeoutMs ?? SMTP_DATA_TIMEOUT_MS, 'data');
    } catch (e) {
      // The final dot is on the wire: the server may already have accepted the message. A timeout or
      // a dropped connection here is NOT safe to retry automatically (that is how a message is
      // delivered twice); only the user's Retry may send it again.
      throw new SmtpError(`no answer after the message was transmitted (${sanitizeDetail((e as Error).message)}): it may or may not have been delivered; press Retry to send it again`, 'data', false);
    }
    if (done.code !== 250) throw replyError('the server did not accept the message', done, 'data');
    // QUIT is a courtesy: the message is already accepted, so its answer cannot fail the send
    await s.cmd('QUIT', 'done', 5_000).catch(() => undefined);
    s.close();
    return { ok: true, stage: 'done', transient: false, accepted, rejected, code: done.code };
  } catch (e) {
    s.close();
    const err = e instanceof SmtpError ? e : new SmtpError(sanitizeDetail((e as Error).message), 'connect', true);
    return { ok: false, stage: err.stage, error: err.message, transient: err.transient, accepted: [], rejected, code: err.code };
  }
}

// Ticket 36b — the real mail socket factory.
//
// The socket is a security boundary, so the tests here are about what it REFUSES as much as what it
// does: an unverified certificate has no switch, a non-implicit TLS mode is rejected with a reason
// rather than silently sent in the clear, an unresponsive host cannot hold the account forever, a
// stalled peer cannot buffer unbounded mail, and every connection is audited.
//
// The TLS connector is injected, so none of this needs a certificate, a port or a network.

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeSocketFactory, CONNECT_TIMEOUT_MS, MAX_SOCKET_BUFFER, type SocketAuditEvent } from '../../src/main/mail/socket';
import { ImapClient } from '../../src/core/mail/imap';
import type { TLSSocket } from 'node:tls';

/** A fake TLSSocket: emits what the test tells it to, records what was written. */
class FakeTls extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  encoding: string | null = null;
  writableLength = 0;
  constructor(
    private readonly opts: { failWith?: Error; neverConnects?: boolean; protocol?: string; cipher?: string },
  ) {
    super();
    queueMicrotask(() => {
      if (this.opts.failWith) this.emit('error', this.opts.failWith);
      else if (!this.opts.neverConnects) this.emit('secureConnect');
    });
  }
  setEncoding(e: string) {
    this.encoding = e;
  }
  write(d: string) {
    this.written.push(d);
    return true;
  }
  end() {
    this.destroyed = true;
    this.emit('close');
  }
  destroy(e?: Error) {
    this.destroyed = true;
    if (e) this.emit('error', e);
    this.emit('close');
  }
  getProtocol() {
    return this.opts.protocol ?? 'TLSv1.3';
  }
  getCipher() {
    return { name: this.opts.cipher ?? 'TLS_AES_256_GCM_SHA384' };
  }
  /** push data TO the client */
  send(data: string) {
    this.emit('data', data);
  }
}

const factoryFor = (fake: FakeTls, audit: SocketAuditEvent[] = [], opts: Record<string, unknown> = {}) =>
  makeSocketFactory({ audit: (e) => audit.push(e), connectImpl: (() => fake as unknown as TLSSocket) as never, ...opts });

describe('mail socket (36b) — what it refuses', () => {
  it('refuses a non-implicit TLS mode with a reason instead of sending a password in the clear', async () => {
    const audit: SocketAuditEvent[] = [];
    const f = factoryFor(new FakeTls({}), audit);
    await expect(f({ host: 'h.example', port: 143, tls: 'starttls' })).rejects.toThrow(/only an implicit TLS/i);
    expect(audit[0].kind).toBe('refused');
  });

  it('propagates a certificate/verification failure as a connection failure', async () => {
    const f = factoryFor(new FakeTls({ failWith: new Error('unable to verify the first certificate') }));
    await expect(f({ host: 'h.example', port: 993, tls: 'implicit' })).rejects.toThrow(/unable to verify/);
  });

  it('times out a host that accepts the connection and then says nothing', async () => {
    const f = factoryFor(new FakeTls({ neverConnects: true }), [], { timeoutMs: 40 });
    await expect(f({ host: 'h.example', port: 993, tls: 'implicit' })).rejects.toThrow(/timed out/);
    expect(CONNECT_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it('there is no option to disable certificate verification', () => {
    // the source of the TLS connect call is the authority here: verification is hard-coded on and
    // there is no parameter that could be threaded through to turn it off
    const src = readFileSync(join(process.cwd(), 'src/main/mail/socket.ts'), 'utf8');
    expect(src).toContain('rejectUnauthorized: true');
    expect(src).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(src).toMatch(/NEVER relaxed/);
  });
});

describe('mail socket (36b) — what it does', () => {
  it('opens, audits with the negotiated protocol, and carries data both ways', async () => {
    const audit: SocketAuditEvent[] = [];
    const fake = new FakeTls({});
    const sock = await factoryFor(fake, audit)({ host: 'imap.example', port: 993, tls: 'implicit' });
    expect(audit[0].kind).toBe('open');
    expect(audit[0].detail).toContain('TLSv1.3');
    const got: string[] = [];
    sock.onData((c) => got.push(c.toString('utf8')));
    fake.send('* OK ready\r\n');
    expect(got).toEqual(['* OK ready\r\n']);
    sock.write('A1 CAPABILITY\r\n');
    expect(fake.written).toEqual(['A1 CAPABILITY\r\n']);
  });

  it('buffers data that arrives BEFORE the reader attaches (a real race in a fast handshake)', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'h.example', port: 993, tls: 'implicit' });
    fake.send('* OK early\r\n');
    const got: string[] = [];
    sock.onData((c) => got.push(c.toString('utf8')));
    expect(got).toEqual(['* OK early\r\n']);
  });

  it('delivers BYTES, never a decoded string: a UTF-8 character split across two TLS records survives', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'h.example', port: 993, tls: 'implicit' });
    const got: Buffer[] = [];
    sock.onData((c) => got.push(c));
    const bytes = Buffer.from('* 1 FETCH (BODY[] {5}\r\ncafé)\r\n', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte é
    fake.emit('data', bytes.subarray(0, cut));
    fake.emit('data', bytes.subarray(cut));
    // setEncoding would have made `{5}` a character count; the stream must stay raw
    expect(fake.encoding).toBeNull();
    expect(got.every((c) => Buffer.isBuffer(c))).toBe(true);
    expect(Buffer.concat(got).equals(bytes)).toBe(true);
  });

  it('reports a server-side close as a close, not as silence', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'h.example', port: 993, tls: 'implicit' });
    let err: Error | undefined;
    sock.onClose((e) => {
      err = e;
    });
    fake.emit('close');
    expect(err?.message).toContain('closed by the server');
  });

  it('passes a socket ERROR through with its message (so TLS problems are diagnosable)', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'h.example', port: 993, tls: 'implicit' });
    let err: Error | undefined;
    sock.onClose((e) => {
      err = e;
    });
    fake.emit('error', new Error('read ECONNRESET'));
    expect(err?.message).toBe('read ECONNRESET');
  });

  it('destroys a socket whose peer has stalled with a full buffer instead of growing without bound', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'h.example', port: 993, tls: 'implicit' });
    fake.writableLength = MAX_SOCKET_BUFFER + 1;
    sock.write('x');
    expect(fake.destroyed).toBe(true);
    expect(MAX_SOCKET_BUFFER).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('a write after close is a no-op, not an exception thrown into a caller', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'h.example', port: 993, tls: 'implicit' });
    sock.end();
    expect(() => sock.write('A1 LOGOUT\r\n')).not.toThrow();
  });

  it('drives a real ImapClient end to end (the seam the sync engine uses)', async () => {
    const fake = new FakeTls({});
    const sock = await factoryFor(fake)({ host: 'imap.example', port: 993, tls: 'implicit' });
    const client = new ImapClient(sock, 2000);
    const greeting = client.greeting();
    fake.send('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
    await greeting;
    const caps = client.capability();
    // the client wrote the command; answer it
    expect(fake.written[0]).toContain('CAPABILITY');
    const tag = fake.written[0].split(' ')[0];
    fake.send('* CAPABILITY IMAP4rev1 UIDPLUS\r\n');
    fake.send(`${tag} OK done\r\n`);
    expect(await caps).toEqual(['IMAP4REV1', 'UIDPLUS']);
  });
});

// Ticket 38 — the SMTP client (src/core/mail/smtp.ts) against the strict fake server
// (test/helpers/fake-smtp.ts), and the production STARTTLS upgrade (src/main/mail/socket.ts) against a
// REAL local TLS server with a throwaway self-signed certificate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { smtpSend, prepareData, EHLO_NAME, type SmtpSendOptions, type SmtpSocketFactory } from '../../src/core/mail/smtp';
import { makeSmtpSocketFactory, type SocketAuditEvent } from '../../src/main/mail/socket';
import { FakeSmtpServer, type FakeSmtpOptions } from '../helpers/fake-smtp';
import { makeTestCert, type TestCert } from '../helpers/mail-tls';

const MSG = Buffer.from('From: ada@example.com\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nHello\r\n', 'utf8');

const opts = (o: Partial<SmtpSendOptions> = {}): SmtpSendOptions => ({
  host: 'smtp.example.com',
  port: 587,
  tls: 'starttls',
  auth: { kind: 'password', username: 'ada', password: 'pw' },
  from: 'ada@example.com',
  to: ['bob@example.com'],
  data: MSG,
  timeoutMs: 2_000,
  ...o,
});

/** an in-memory factory: implicit TLS for 465, STARTTLS-able plaintext otherwise */
const memory = (server: FakeSmtpServer): SmtpSocketFactory => async ({ tls }) => server.socket({ implicit: tls === 'implicit' });

const send = (fake: FakeSmtpOptions, o: Partial<SmtpSendOptions> = {}) => {
  const server = new FakeSmtpServer({ user: 'ada', password: 'pw', ...fake });
  return smtpSend(opts(o), memory(server)).then((r) => ({ r, server }));
};

describe('smtp (38) — STARTTLS is strict', () => {
  it('EHLO, STARTTLS, discard the old capabilities, EHLO again, and only THEN authenticate', async () => {
    const { r, server } = await send({});
    expect(r).toMatchObject({ ok: true, stage: 'done', accepted: ['bob@example.com'] });
    const t = server.transcript;
    const at = (s: string) => t.indexOf(s);
    expect(at('STARTTLS')).toBeGreaterThan(at(`EHLO ${EHLO_NAME}`));
    expect(at('AUTH PLAIN')).toBeGreaterThan(at('STARTTLS'));
    expect(t.match(/^EHLO /gm)).toHaveLength(2);
    expect(server.ehlos).toEqual([{ secure: false }, { secure: true }]);
    expect(server.auths).toEqual([{ mech: 'PLAIN', user: 'ada', secret: 'pw', secure: true }]);
    expect(server.received[0]).toMatchObject({ from: 'ada@example.com', to: ['bob@example.com'], secure: true });
    expect(server.violations).toEqual([]);
    expect(t).toMatch(/QUIT\r\n$/);
  });

  it('a server that does not offer STARTTLS is REFUSED — nothing is sent, no fallback to plaintext', async () => {
    const { r, server } = await send({ starttls: false, authBeforeTls: true });
    expect(r).toMatchObject({ ok: false, stage: 'starttls', transient: false });
    expect(r.error).toMatch(/does not offer STARTTLS.*no plaintext fallback/);
    expect(server.auths).toEqual([]);
    expect(server.transcript).not.toMatch(/AUTH|MAIL FROM/);
  });

  it('AUTH advertised BEFORE TLS is ignored: the pre-TLS capabilities are discarded', async () => {
    // a misconfigured server offers AUTH in plaintext too; the client must not take it up
    const { r, server } = await send({ authBeforeTls: true });
    expect(r.ok).toBe(true);
    expect(server.violations).not.toContain('AUTH before TLS');
    expect(server.auths[0].secure).toBe(true);
  });

  it('STARTTLS INJECTION: bytes after "220 ready" in the same read are refused before the upgrade', async () => {
    const { r, server } = await send({ injectAfterStartTls: '250-fake.example\r\n250 AUTH PLAIN\r\n' });
    expect(r).toMatchObject({ ok: false, stage: 'starttls', transient: false });
    expect(r.error).toMatch(/STARTTLS injection/);
    expect(server.auths).toEqual([]);
    expect(server.received).toEqual([]);
  });

  it('STARTTLS INJECTION: bytes that arrive DURING the upgrade are refused too', async () => {
    const { r, server } = await send({ injectDuringUpgrade: '235 2.7.0 fake success\r\n' });
    expect(r).toMatchObject({ ok: false, stage: 'starttls' });
    expect(r.error).toMatch(/STARTTLS injection/);
    expect(server.auths).toEqual([]);
  });

  it('plaintext ("none") and port 25 are refused before any connection', async () => {
    let dialled = 0;
    const factory: SmtpSocketFactory = async () => {
      dialled++;
      throw new Error('should not be called');
    };
    const none = await smtpSend(opts({ tls: 'none' }), factory);
    expect(none).toMatchObject({ ok: false, stage: 'refused' });
    expect(none.error).toMatch(/plaintext SMTP is refused/);
    const p25 = await smtpSend(opts({ port: 25 }), factory);
    expect(p25.error).toMatch(/port 25/);
    expect(dialled).toBe(0);
  });

  it('implicit TLS (465): no STARTTLS, one EHLO, then AUTH', async () => {
    const { r, server } = await send({}, { tls: 'implicit', port: 465 });
    expect(r.ok).toBe(true);
    expect(server.transcript).not.toContain('STARTTLS');
    expect(server.ehlos).toEqual([{ secure: true }]);
  });
});

describe('smtp (38) — authentication', () => {
  it('PLAIN is preferred; LOGIN is used when PLAIN is not offered', async () => {
    const plain = await send({ mechanisms: ['LOGIN', 'PLAIN'] });
    expect(plain.server.auths[0].mech).toBe('PLAIN');
    const login = await send({ mechanisms: ['LOGIN'] });
    expect(login.r.ok).toBe(true);
    expect(login.server.auths[0]).toMatchObject({ mech: 'LOGIN', user: 'ada', secret: 'pw' });
  });

  it('XOAUTH2 for an OAuth account; a refused token is a failed send at the auth stage', async () => {
    const ok = await send({ mechanisms: ['XOAUTH2'], password: 'tok' }, { auth: { kind: 'xoauth2', username: 'ada@example.com', token: 'tok' } });
    expect(ok.r.ok).toBe(true);
    expect(ok.server.auths[0]).toMatchObject({ mech: 'XOAUTH2', user: 'ada@example.com', secret: 'tok' });
    const bad = await send({ mechanisms: ['XOAUTH2'], password: 'tok' }, { auth: { kind: 'xoauth2', username: 'ada@example.com', token: 'stale' } });
    expect(bad.r).toMatchObject({ ok: false, stage: 'auth', code: 535 });
  });

  it('wrong credentials: 535, permanent, nothing sent', async () => {
    const { r, server } = await send({}, { auth: { kind: 'password', username: 'ada', password: 'wrong' } });
    expect(r).toMatchObject({ ok: false, stage: 'auth', transient: false, code: 535 });
    expect(server.received).toEqual([]);
  });

  it('a non-ASCII password is sent as UTF-8 bytes in base64', async () => {
    const { r, server } = await send({ password: 'pässwörd' }, { auth: { kind: 'password', username: 'ada', password: 'pässwörd' } });
    expect(r.ok).toBe(true);
    expect(server.auths[0].secret).toBe('pässwörd');
  });
});

describe('smtp (38) — envelope, DATA and limits', () => {
  it('one RCPT per recipient; the envelope is what the server records', async () => {
    const { r, server } = await send({}, { to: ['bob@example.com', 'carol@example.org', 'sam@hidden.example'] });
    expect(r.accepted).toEqual(['bob@example.com', 'carol@example.org', 'sam@hidden.example']);
    expect(server.transcript.match(/^RCPT TO:</gm)).toHaveLength(3);
    expect(server.received[0].to).toEqual(['bob@example.com', 'carol@example.org', 'sam@hidden.example']);
  });

  it('a rejected recipient is reported per recipient and NOTHING is delivered (RSET)', async () => {
    const { r, server } = await send({ rejectRcpt: { 'nobody@example.com': '550 5.1.1 <nobody@example.com> no such user' } }, { to: ['bob@example.com', 'nobody@example.com'] });
    expect(r).toMatchObject({ ok: false, stage: 'rcpt', transient: false });
    expect(r.rejected).toEqual([{ address: 'nobody@example.com', code: 550, message: '5.1.1 <nobody@example.com> no such user' }]);
    expect(server.transcript).toContain('RSET');
    expect(server.transcript).not.toContain('DATA');
    expect(server.received).toEqual([]);
    // a 4xx rejection is transient (a retry may work)
    const soft = await send({ rejectRcpt: { 'bob@example.com': '450 4.2.1 mailbox busy' } });
    expect(soft.r).toMatchObject({ ok: false, stage: 'rcpt', transient: true });
  });

  it('DOT-STUFFING and CRLF normalisation, on bytes: the server receives exactly the message', async () => {
    const body = Buffer.from('Subject: dots\r\n\r\n.starts with a dot\n..two dots\r\nlone CR\rend\n.\nü after\r\n', 'utf8');
    const { r, server } = await send({}, { data: body });
    expect(r.ok).toBe(true);
    expect(server.violations).toEqual([]);
    expect(server.received[0].data.toString('utf8')).toBe('Subject: dots\r\n\r\n.starts with a dot\r\n..two dots\r\nlone CR\r\nend\r\n.\r\nü after\r\n');
    // the wire carried the stuffed form
    expect(server.received[0].wire.toString('utf8')).toContain('\r\n..starts with a dot\r\n...two dots\r\n');
    expect(server.received[0].wire.toString('utf8')).toContain('\r\n..\r\n');
  });

  it('prepareData: a message without a final line break still ends with CRLF.CRLF', () => {
    expect(prepareData(Buffer.from('a\r\n.b')).toString()).toBe('a\r\n..b\r\n.\r\n');
    expect(prepareData(Buffer.from('')).toString()).toBe('.\r\n');
  });

  it('SIZE: the BYTE length is compared with the server limit before MAIL, and declared in MAIL FROM', async () => {
    // 10 'é' = 10 characters but 20 bytes: a char count would pass a 15-byte limit
    const data = Buffer.from(`Subject: x\r\n\r\n${'é'.repeat(10)}\r\n`, 'utf8');
    const big = await send({ size: data.length - 1 }, { data });
    expect(big.r).toMatchObject({ ok: false, stage: 'size', transient: false });
    expect(big.server.transcript).not.toContain('MAIL FROM');
    const fits = await send({ size: data.length }, { data });
    expect(fits.r.ok).toBe(true);
    expect(fits.server.transcript).toContain(`MAIL FROM:<ada@example.com> SIZE=${data.length}`);
  });

  it('4xx at the end of DATA is transient, 5xx permanent', async () => {
    const soft = await send({ dataReply: '451 4.3.0 try again later' });
    expect(soft.r).toMatchObject({ ok: false, stage: 'data', transient: true, code: 451 });
    const hard = await send({ dataReply: '554 5.7.1 rejected as spam' });
    expect(hard.r).toMatchObject({ ok: false, stage: 'data', transient: false, code: 554 });
    expect(hard.r.error).toContain('rejected as spam');
  });

  it('every step times out (greeting, EHLO, AUTH, RCPT, end of DATA); before the dot it is transient', async () => {
    // (data-end is the exception: see the next test)
    for (const hang of ['greeting', 'ehlo', 'auth', 'rcpt'] as const) {
      const t0 = Date.now();
      const { r } = await send({ hang }, { timeoutMs: 80, dataTimeoutMs: 80 });
      expect(r.ok, hang).toBe(false);
      expect(r.transient, hang).toBe(true);
      expect(r.error, hang).toMatch(/did not answer/);
      expect(Date.now() - t0).toBeLessThan(1_500);
    }
  });

  it('NO AUTOMATIC RETRY once the final dot is on the wire: a dropped connection there "may or may not" have delivered', async () => {
    const { r, server } = await send({ dropAfterData: true });
    expect(server.received).toHaveLength(1); // the server HAS the message
    expect(r).toMatchObject({ ok: false, stage: 'data', transient: false });
    expect(r.error).toMatch(/may or may not have been delivered/);
    const slow = await send({ hang: 'data-end' }, { dataTimeoutMs: 60 });
    expect(slow.r).toMatchObject({ ok: false, stage: 'data', transient: false });
  });

  it('an envelope address that could break the command is refused locally', async () => {
    for (const bad of ['bob@example.com>\r\nRCPT TO:<eve@x.example', 'bob <bob@example.com>', 'no-at-sign']) {
      const { r, server } = await send({}, { to: [bad] });
      expect(r).toMatchObject({ ok: false, stage: 'refused' });
      expect(server.connections).toBe(0);
    }
  });

  it('a send abandoned mid-way (a task started) stops before DATA and is not transient', async () => {
    const signal = { aborted: false };
    const server = new FakeSmtpServer({ user: 'ada', password: 'pw' });
    const factory: SmtpSocketFactory = async (o) => {
      const s = server.socket({ implicit: o.tls === 'implicit' });
      return {
        get secure() {
          return s.secure;
        },
        // the "task" starts while MAIL FROM is on the wire
        write: (d: Buffer | string) => {
          if (String(d).startsWith('MAIL FROM')) signal.aborted = true;
          s.write(d);
        },
        onData: s.onData,
        onClose: s.onClose,
        startTls: s.startTls,
        end: s.end,
      };
    };
    const r = await smtpSend(opts({ signal }), factory);
    expect(r).toMatchObject({ ok: false, transient: false });
    expect(r.error).toMatch(/cancelled/);
    expect(server.received).toEqual([]);
  });
});

describe('smtp (38) — the production socket: a REAL STARTTLS upgrade and certificate verification', () => {
  let cert: TestCert;
  let fake: FakeSmtpServer;
  let srv: { port: number; close(): Promise<void> };
  let implicitFake: FakeSmtpServer;
  let implicitSrv: { port: number; close(): Promise<void> };

  beforeAll(async () => {
    cert = makeTestCert();
    fake = new FakeSmtpServer({ user: 'ada', password: 'pw' });
    srv = await fake.listen({ key: cert.key, cert: cert.cert });
    implicitFake = new FakeSmtpServer({ user: 'ada', password: 'pw' });
    implicitSrv = await implicitFake.listen({ key: cert.key, cert: cert.cert, implicit: true });
  });
  afterAll(async () => {
    await srv.close();
    await implicitSrv.close();
  });

  it('STARTTLS on 127.0.0.1: upgraded with TLS ≥ 1.2, verified against the test CA, audited', async () => {
    const audit: SocketAuditEvent[] = [];
    const factory = makeSmtpSocketFactory({ testCa: cert.cert, audit: (e) => audit.push(e) });
    const r = await smtpSend(opts({ host: '127.0.0.1', port: srv.port }), factory);
    expect(r).toMatchObject({ ok: true, stage: 'done' });
    expect(fake.received.at(-1)).toMatchObject({ from: 'ada@example.com', to: ['bob@example.com'], secure: true });
    expect(fake.auths.at(-1)).toMatchObject({ mech: 'PLAIN', secure: true });
    expect(fake.violations).toEqual([]);
    expect(audit.map((e) => e.kind)).toEqual(expect.arrayContaining(['open', 'starttls']));
    const up = audit.find((e) => e.kind === 'starttls')!;
    expect(up.protocol).toBe('smtp');
    expect(up.detail).toMatch(/^TLSv1\.[23]\//);
    expect(audit.find((e) => e.kind === 'open')!.detail).toBe('plaintext until STARTTLS');
  });

  it('implicit TLS on 127.0.0.1 with the test CA', async () => {
    const r = await smtpSend(opts({ host: '127.0.0.1', port: implicitSrv.port, tls: 'implicit' }), makeSmtpSocketFactory({ testCa: cert.cert }));
    expect(r.ok).toBe(true);
    expect(implicitFake.received.at(-1)?.secure).toBe(true);
  });

  it('WITHOUT the CA the self-signed certificate is rejected: verification is on, nothing is authenticated', async () => {
    const before = fake.auths.length;
    const r = await smtpSend(opts({ host: '127.0.0.1', port: srv.port }), makeSmtpSocketFactory());
    expect(r).toMatchObject({ ok: false, stage: 'starttls' });
    expect(r.error).toMatch(/certificate|self.signed/i);
    expect(fake.auths.length).toBe(before);
    const imp = await smtpSend(opts({ host: '127.0.0.1', port: implicitSrv.port, tls: 'implicit' }), makeSmtpSocketFactory());
    expect(imp).toMatchObject({ ok: false, stage: 'connect' });
  });

  it('the test CA is honoured for LOOPBACK only, and the source never disables verification', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/mail/socket.ts'), 'utf8');
    expect(src).toContain('rejectUnauthorized: true');
    expect(src).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(src).toMatch(/opts\.testCa && LOOPBACK\.has\(host\.toLowerCase\(\)\)/);
    // the STARTTLS upgrade uses the same options as an implicit connection
    expect(src).toMatch(/connectTls\(\{ socket: plain, host, \.\.\.tlsOptions\(host, opts\) \}\)/);
  });

  it('STARTTLS INJECTION on a real socket: plaintext sent in a separate packet after "220 ready" fails the send', async () => {
    const evil = new FakeSmtpServer({ user: 'ada', password: 'pw', injectLater: '250 AUTH PLAIN\r\n' });
    const es = await evil.listen({ key: cert.key, cert: cert.cert });
    try {
      const r = await smtpSend(opts({ host: '127.0.0.1', port: es.port }), makeSmtpSocketFactory({ testCa: cert.cert, timeoutMs: 3_000 }));
      expect(r).toMatchObject({ ok: false, stage: 'starttls', transient: false });
      expect(evil.auths).toEqual([]);
      expect(evil.received).toEqual([]);
    } finally {
      await es.close();
    }
  });

  it('the production factory refuses plaintext and port 25 itself, and audits the refusal', async () => {
    const audit: SocketAuditEvent[] = [];
    const f = makeSmtpSocketFactory({ audit: (e) => audit.push(e) });
    await expect(f({ host: '127.0.0.1', port: srv.port, tls: 'none' as never })).rejects.toThrow(/plaintext SMTP is refused/);
    await expect(f({ host: '127.0.0.1', port: 25, tls: 'starttls' })).rejects.toThrow(/port 25/);
    expect(audit.map((e) => e.kind)).toEqual(['refused', 'refused']);
  });
});

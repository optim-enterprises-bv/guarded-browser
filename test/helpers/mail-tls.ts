// Real-TLS plumbing for the mail tests (ticket 38): a throwaway self-signed certificate for 127.0.0.1,
// generated per run with the system's `openssl`, and a TLS listener that puts the in-memory
// FakeImapServer behind a real socket.
//
// The certificate is trusted ONLY by handing its PEM to the socket factory's test-only `testCa`
// option (or, in the e2e, GUARDED_TEST_MAIL_CA under GUARDED_TEST=1). Production verification is never
// relaxed: a test that omits the CA sees the handshake fail, and one test asserts exactly that.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import type { FakeImapServer } from './fake-imap';

export interface TestCert {
  key: string;
  cert: string;
  /** where the certificate PEM is on disk (for GUARDED_TEST_MAIL_CA) */
  certPath: string;
}

export function makeTestCert(): TestCert {
  const dir = mkdtempSync(join(tmpdir(), 'gb-mail-cert-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=guarded-browser mail test', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), certPath };
}

/**
 * Serve `server` (the in-memory fake IMAP) over implicit TLS on 127.0.0.1. One client connection is
 * bridged to one `server.socket()`; the fake keeps its folders across connections.
 */
export async function listenImapTls(server: FakeImapServer, tls: { key: string; cert: string }): Promise<{ port: number; close(): Promise<void> }> {
  const open = new Set<TLSSocket>();
  const srv = createServer({ key: tls.key, cert: tls.cert }, (conn) => {
    open.add(conn);
    conn.on('close', () => open.delete(conn));
    conn.on('error', () => undefined);
    const s = server.socket();
    s.onData((b) => {
      if (!conn.destroyed) conn.write(b);
    });
    s.onClose(() => conn.end());
    conn.on('data', (b: Buffer) => s.write(b.toString('utf8')));
    conn.on('end', () => s.end());
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as { port: number }).port,
    close: async () => {
      for (const c of open) c.destroy();
      await new Promise((r) => srv.close(() => r(undefined)));
    },
  };
}

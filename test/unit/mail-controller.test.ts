// The per-profile mail controller (ticket 37c): the task gate on every network action, dropping open
// connections when a task starts, and the himalaya import of an account with no inline password.
//
// The controller is real (a sqlite file and a passphrase secret store in a temp dir); the IMAP server is
// the fake one, injected through the controller's `makeSocket` seam, so nothing touches a network.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MailController } from '../../src/main/mail/controller';
import type { ImapSocket } from '../../src/core/mail/imap';
import { FakeImapServer } from '../helpers/fake-imap';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gb-mailctl-'));

const setup = () => {
  let running = false;
  let ended = 0;
  const server = new FakeImapServer({ user: 'me', password: 'pw' });
  const ctl = new MailController({
    profileDir: tmp(),
    canConnect: () => (running ? { ok: false, reason: 'an agent task is running' } : { ok: true }),
    audit: () => undefined,
    sendUnread: () => undefined,
    makeSocket: async (): Promise<ImapSocket> => {
      const sock = server.socket();
      return { ...sock, end: () => { ended++; sock.end(); } };
    },
  });
  return { ctl, server, setRunning: (v: boolean) => (running = v), ended: () => ended };
};

const account = {
  id: 'work',
  name: 'Work',
  address: 'me@example.com',
  kind: 'imap',
  host: 'imap.example.com',
  port: 993,
  tls: 'implicit',
  username: 'me',
  authKind: 'password',
  sentFolder: 'Sent',
  trashFolder: 'Trash',
  junkFolder: 'Junk',
  archiveFolder: 'Archive',
};

describe('mail controller — the task gate covers every network action', () => {
  it('flags, move and opening an unfetched message are refused during a task, and nothing reaches the server', async () => {
    const { ctl, server, setRunning } = setup();
    expect(ctl.unlock('correct horse battery').ok).toBe(true);
    expect((await ctl.saveAccount(account, { password: 'pw' })).ok).toBe(true);
    expect((await ctl.sync('work')).ok).toBe(true);
    const ids = ctl.list({ accountId: 'work', folder: 'INBOX' }).rows.map((r) => (r as { id: number }).id);
    expect(ids.length).toBeGreaterThan(0);

    setRunning(true);
    const before = server.transcript;
    const flags = await ctl.setFlags([ids[0]], { flagged: true });
    expect(flags.ok).toBe(false);
    expect('error' in flags && flags.error).toContain('agent task');
    const move = await ctl.move([ids[0]], 'Sent');
    expect(move.ok).toBe(false);
    expect('error' in move && move.error).toContain('agent task');
    const open = await ctl.message(ids[0]);
    expect(open.ok).toBe(false);
    expect(server.transcript).toBe(before);
  });

  it('disconnectAll drops a connection opened before the task; the next sync reconnects', async () => {
    const { ctl, server, ended } = setup();
    ctl.unlock('correct horse battery');
    await ctl.saveAccount(account, { password: 'pw' });
    expect((await ctl.sync('work')).ok).toBe(true);
    expect(ended()).toBe(0);
    ctl.disconnectAll();
    expect(ended()).toBe(1);
    expect((await ctl.sync('work')).ok).toBe(true);
    expect(server.transcript.match(/ LOGIN /g)).toHaveLength(2);
  });

  it('state() carries a per-account unread NUMBER for the account chip', async () => {
    const { ctl } = setup();
    ctl.unlock('correct horse battery');
    await ctl.saveAccount(account, { password: 'pw' });
    await ctl.sync('work');
    const st = ctl.state();
    const row = st.accounts.find((a) => a.id === 'work') as { unread?: unknown } | undefined;
    expect(typeof row?.unread).toBe('number');
    expect(row?.unread).toBe(st.unread); // one account: its count is the total
    expect(row?.unread).toBeGreaterThan(0);
  });
});

describe('mail controller — himalaya import', () => {
  it('an account using password.cmd is still imported, with "no password imported" instead of a failure', () => {
    const { ctl } = setup();
    ctl.unlock('correct horse battery');
    const dir = tmp();
    const file = join(dir, 'config.toml');
    writeFileSync(
      file,
      [
        '[accounts.withpw]',
        'email = "a@example.com"',
        'imap.server = "imaps://imap.example.com:993"',
        'imap.sasl.plain.password.raw = "fixture-password"',
        '',
        '[accounts.withcmd]',
        'email = "b@example.com"',
        'imap.server = "imaps://imap.example.com:993"',
        'imap.sasl.plain.password.cmd = "pass show mail/b"',
        '',
      ].join('\n'),
    );
    const r = ctl.importApply(file, []);
    expect(r.ok).toBe(true);
    if (!('added' in r)) throw new Error('import refused');
    expect(r.failed).toEqual([]);
    expect(r.added).toBe(2);
    expect(r.notes).toEqual([{ id: 'withcmd', note: 'no password imported' }]);
    expect(ctl.state().accounts.map((a) => a.id).sort()).toEqual(['withcmd', 'withpw']);
  });
});

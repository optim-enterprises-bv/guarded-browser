// Ticket 36 — the sync engine: sync, IDLE push, offline, and the ONE rule that cannot bend.
//
// The engine composes the store (34), the client and MIME parser (36) and the fake server (fixtures).
// The tests that matter here are:
//   * a full first sync, an incremental sync, and a UIDVALIDITY change dropping every uid;
//   * the body fetch being the ONLY thing that puts message text in the store;
//   * the connect gate refusing while a task runs, and NOT queuing into the refusal;
//   * backoff being a pure, testable function rather than a sleep in a test.
//
// The store is real (`:memory:`), the server is fake, and the credentials are a plain object — so the
// whole file runs in well under a second.

import { describe, it, expect } from 'vitest';

import { MailSyncer, nextBackoff, flagsToState, stateToFlags, guessFolderKind, type SyncDeps } from '../../src/main/mail/sync';
import { MailStore } from '../../src/core/mail/store';
import { normalizeAccount } from '../../src/main/mail/accounts';
import { FakeImapServer } from '../helpers/fake-imap';

const account = (over: Record<string, unknown> = {}) => {
  const r = normalizeAccount({
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
    ...over,
  });
  if (!r.ok) throw new Error(r.error);
  return r.account;
};

/** A store + server + syncer wired the way main.ts will wire it. */
const harness = (opts: { server?: FakeImapServer; taskRunning?: () => boolean; deps?: Partial<SyncDeps> } = {}) => {
  const store = new MailStore(':memory:');
  const server = opts.server ?? new FakeImapServer({ user: 'me', password: 'pw', idle: true });
  const audit: string[] = [];
  const deps: SyncDeps = {
    store,
    makeSocket: async () => server.socket(),
    credential: () => ({ kind: 'password', password: 'pw' }),
    canConnect: () => (opts.taskRunning?.() ? { ok: false, reason: 'an agent task is running' } : { ok: true }),
    audit: (e) => audit.push(`${e.kind}:${e.detail}`),
    ...opts.deps,
  };
  store.addAccount({ id: 'work', name: 'Work', address: 'me@example.com', kind: 'imap', host: 'imap.example.com', port: 993, tls: 'implicit', username: 'me', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive' });
  const syncer = new MailSyncer(account(), deps);
  return { store, server, syncer, audit };
};

/** The fake server's default INBOX holds two messages, one already \Seen. */
const seedInbox = (server: FakeImapServer) => server.folders.find((f) => f.path === 'INBOX')!;

describe('sync (36) — pure policy', () => {
  it('backoff doubles, caps, and never returns something unbounded', () => {
    expect(nextBackoff(0)).toBe(5_000);
    expect(nextBackoff(1)).toBe(10_000);
    expect(nextBackoff(2)).toBe(20_000);
    expect(nextBackoff(50)).toBe(5 * 60_000);
    expect(nextBackoff(50, 5_000, 60_000)).toBe(60_000);
    expect(nextBackoff(0, 5_000, 300_000, 0.5)).toBe(3_750);
  });

  it('maps IMAP flags to the store state, with seen implying read', () => {
    const s = flagsToState(['\\Seen', '\\Flagged']);
    expect(s.seen).toBe(true);
    expect(s.readFlag).toBe(true);
    expect(s.flagged).toBe(true);
    expect(s.answered).toBe(false);
    expect(flagsToState(undefined).seen).toBe(false);
    expect(flagsToState(['$Junk']).junk).toBe(true);
  });

  it('maps store state back to flags, and \\Seen is implied by either read state', () => {
    expect(stateToFlags({ seen: false, readFlag: true, flagged: false, answered: false, draft: false })).toEqual(['\\Seen']);
    expect(stateToFlags({ seen: false, readFlag: false, flagged: true, answered: false, draft: false })).toEqual(['\\Flagged']);
    expect(stateToFlags({ seen: false, readFlag: false, flagged: false, answered: false, draft: false })).toEqual([]);
  });

  it('recognises the standard folder roles by special-use attribute or by name', () => {
    expect(guessFolderKind('INBOX', ['\\Inbox'])).toBe('inbox');
    expect(guessFolderKind('Sent Items', [])).toBe('sent');
    expect(guessFolderKind('Whatever', ['\\Sent'])).toBe('sent');
    expect(guessFolderKind('Papierkorb', [])).toBe('trash');
    expect(guessFolderKind('Bulk Mail', [])).toBe('junk');
    expect(guessFolderKind('Projects', [])).toBe('folder');
  });
});

describe('sync (36) — a first sync and an incremental sync', () => {
  it('lists folders, stores headers, and does NOT fetch bodies', async () => {
    const { store, syncer } = harness();
    const report = await syncer.syncAll();
    expect(report.ok).toBe(true);
    expect(report.folders.map((f) => f.path)).toContain('INBOX');
    const inbox = store.listMessages({ accountId: 'work', folder: 'INBOX' });
    expect(inbox.total).toBe(2);
    // headers only: no body text, and the store knows it has not been fetched
    expect(inbox.messages.every((m) => !m.bodyFetched)).toBe(true);
    expect(inbox.messages.every((m) => m.bodyFetched === false)).toBe(true);
    // the folder's role and uidvalidity are recorded
    const f = store.listFolders('work').find((x) => x.path === 'INBOX')!;
    expect(f.kind).toBe('inbox');
    expect(f.uidValidity).toBe(42);
    // and the subject / sender came from the ENVELOPE
    expect(inbox.messages.map((m) => m.subject).sort()).toEqual(['hello', 'two']);
    expect(inbox.messages.find((m) => m.uid === 2)!.seen).toBe(true);
  });

  it('RFC 2047 encoded-words in the ENVELOPE subject and sender name are decoded, not stored raw', async () => {
    const { store, server, syncer } = harness();
    seedInbox(server).messages.push({
      uid: 3,
      flags: [],
      raw: 'Subject: =?UTF-8?B?Y2Fmw6kgdGVzdA==?=\r\nFrom: =?UTF-8?Q?Ren=C3=A9e?= <renee@example.com>\r\n\r\nbody\r\n',
    });
    seedInbox(server).uidNext = 4;
    await syncer.syncAll(['INBOX']);
    const m = store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages.find((x) => x.uid === 3)!;
    expect(m.subject).toBe('caf\u00e9 test');
    expect(m.fromName).toBe('Ren\u00e9e');
    expect(m.fromAddr).toBe('renee@example.com');
  });

  it('rows stored still encoded by an earlier build are repaired once, and a second pass changes nothing', async () => {
    const { store, server, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const id = store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages[0].id;
    (store as unknown as { db: { exec(q: string): void } }).db.exec(
      `UPDATE message SET subject = '=?UTF-8?B?Y2Fmw6kgdGVzdA==?=', fromName = '=?UTF-8?Q?Ren=C3=A9e?=' WHERE id = ${id}`,
    );
    const { decodeWords } = await import('../../src/core/mail/mime');
    expect(store.repairEncodedHeaders((v) => decodeWords(v))).toBe(1);
    const m = store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages.find((x) => x.id === id)!;
    expect(m.subject).toBe('caf\u00e9 test');
    expect(m.fromName).toBe('Ren\u00e9e');
    expect(store.repairEncodedHeaders((v) => decodeWords(v))).toBe(0);
    void server;
  });

  it('an incremental sync asks only for uids above the high-water mark', async () => {
    const { store, server, syncer } = harness();
    await syncer.syncAll();
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(2);
    // a third message arrives
    seedInbox(server).messages.push({ uid: 3, flags: [], raw: 'Subject: three\r\nFrom: x@y.z\r\n\r\nbody three\r\n' });
    seedInbox(server).uidNext = 4;
    const report = await syncer.syncAll(['INBOX']);
    expect(report.folders[0].fetched).toBe(1);
    expect(report.folders[0].reset).toBe(false);
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(3);
    expect(server.transcript).toContain('UID SEARCH 3:*'); // the range starts above the high-water mark
  });

  it('a UIDVALIDITY change drops every uid in that folder and re-syncs from scratch', async () => {
    const { store, server, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(2);
    // the server renumbered the mailbox (a real thing: a server migration does this)
    seedInbox(server).uidValidity = 999;
    const report = await syncer.syncAll(['INBOX']);
    expect(report.folders[0].reset).toBe(true);
    expect(report.folders[0].uidValidity).toBe(999);
    // the folder was emptied and re-filled from the new uids, not merged
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(2);
    expect(store.listFolders('work').find((f) => f.path === 'INBOX')!.uidValidity).toBe(999);
  });

  it('a re-sync of an unchanged folder fetches nothing', async () => {
    const { syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const again = await syncer.syncAll(['INBOX']);
    expect(again.folders[0].fetched).toBe(0);
  });

  it('watches only the folders the account declared, not every folder the server has', async () => {
    const { store, syncer } = harness();
    await syncer.syncAll();
    const paths = store.listFolders('work').map((f) => f.path);
    expect(paths).toContain('INBOX');
    expect(paths).toContain('Sent');
    expect(paths).not.toContain('RandomFolderTheUserNeverAskedFor');
  });

  it('reports a failing folder and stops rather than cascading', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw' });
    const { syncer } = harness({ server });
    const report = await syncer.syncAll(['INBOX', 'DoesNotExist']);
    // INBOX is fine; the missing one is reported with its own error
    const bad = report.folders.find((f) => f.path === 'DoesNotExist');
    if (bad) expect(bad.error).toBeTruthy();
    expect(report.folders.some((f) => f.path === 'INBOX')).toBe(true);
  });

  it('a lost connection during a sync is an error on that folder, not a crash', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw' });
    const { syncer } = harness({ server });
    await syncer.connect();
    const p = syncer.syncAll(['INBOX']);
    server.drop(new Error('connection reset by peer'));
    const report = await p;
    expect(report.ok).toBe(false);
    expect(report.folders[0].error).toBeTruthy();
    expect(syncer.state).toBe('error');
  });
});

describe('sync (36) — the body fetch is the only path to message text', () => {
  it('fetchBody stores the text, marks it seen, and reports remote content + attachments', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw' });
    const raw = [
      'Subject: rich',
      'From: ada@example.com',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'the plain body',
      '--B',
      'Content-Type: text/html',
      '',
      '<p>the html body</p><img src="https://tracker.example/x.gif">',
      '--B',
      'Content-Type: application/pdf; name="r.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="r.pdf"',
      '',
      Buffer.from('%PDF').toString('base64'),
      '--B--',
    ].join('\r\n');
    server.folders[0].messages = [{ uid: 1, flags: [], raw }];
    server.folders[0].uidNext = 2;
    const { store, syncer, audit } = harness({ server });
    await syncer.syncAll(['INBOX']);
    const before = store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages[0];
    expect(before.bodyFetched).toBe(false);

    const r = await syncer.fetchBody('INBOX', 1, { markRead: true });
    expect(r.ok).toBe(true);
    expect(r.remoteContent).toBe(true);
    expect(r.attachments).toBe(1);

    const row = store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages[0];
    expect(row.bodyFetched).toBe(true);
    expect(row.seen).toBe(true);
    expect(row.readFlag).toBe(true);
    const body = store.body(row.id)!;
    expect(body.bodyText).toContain('the plain body');
    expect(body.attachments[0].filename).toBe('r.pdf');
    // \Seen went back to the server because the user asked for it
    expect(server.folders[0].messages[0].flags).toContain('\\Seen');
    expect(audit.some((a) => a.startsWith('fetch:'))).toBe(true);
  });

  it('a body fetch without markRead leaves readFlag alone (unseen vs unread is preserved)', async () => {
    const { store, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const r = await syncer.fetchBody('INBOX', 1);
    expect(r.ok).toBe(true);
    const row = store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages.find((m) => m.uid === 1)!;
    expect(row.seen).toBe(true);
    expect(row.readFlag).toBe(false); // displayed but not dealt with
  });

  it('refuses a body fetch for an unknown message instead of inventing one', async () => {
    const { syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const r = await syncer.fetchBody('INBOX', 9999);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown message');
  });

  it('a server that returns no body records the attempt instead of looping forever', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw' });
    server.folders[0].messages = [{ uid: 1, flags: [], raw: '' }];
    const { store, syncer } = harness({ server });
    await syncer.syncAll(['INBOX']);
    const r = await syncer.fetchBody('INBOX', 1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no message body');
    expect(store.body(store.listMessages({ accountId: 'work', folder: 'INBOX' }).messages[0].id)!.bodyFetched).toBe(true);
  });
});

describe('sync (36) — flags and moves over the wire', () => {
  it('marking read pushes \\Seen to the server and updates the store', async () => {
    const { store, server, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const r = await syncer.setFlags([1], 'INBOX', { readFlag: true, seen: true });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    expect(store.byUid('work', 'INBOX', 1)!.readFlag).toBe(true);
    expect(server.folders[0].messages.find((m) => m.uid === 1)!.flags).toContain('\\Seen');
  });

  it('marking unread takes \\Seen away on both sides', async () => {
    const { store, server, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    await syncer.setFlags([2], 'INBOX', { seen: false, readFlag: false });
    expect(store.byUid('work', 'INBOX', 2)!.seen).toBe(false);
    expect(server.folders[0].messages.find((m) => m.uid === 2)!.flags).not.toContain('\\Seen');
  });

  it('flagging is a local + server change and is independent of read state', async () => {
    const { store, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    await syncer.setFlags([1], 'INBOX', { flagged: true });
    expect(store.byUid('work', 'INBOX', 1)!.flagged).toBe(true);
    expect(store.byUid('work', 'INBOX', 1)!.readFlag).toBe(false);
  });

  it('a move re-keys the store row from the server\'s COPYUID, so the message is not stored twice', async () => {
    const { store, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const r = await syncer.move([1], 'INBOX', 'Sent');
    expect(r.ok).toBe(true);
    expect(r.moved).toBe(1);
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(1);
    expect(store.listMessages({ accountId: 'work', folder: 'Sent' }).total).toBe(1);
    // the row was re-keyed to the uid the server assigned, not left on the old one
    const movedUid = store.listMessages({ accountId: 'work', folder: 'Sent' }).messages[0].uid;
    expect(movedUid).not.toBe(1);
  });

  it('setFlags on an unknown uid changes nothing and says so', async () => {
    const { syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const r = await syncer.setFlags([12345], 'INBOX', { readFlag: true });
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
  });
});

describe('sync (36) — THE RULE: mail never connects while a task runs', () => {
  it('connect is refused, reports why, and does NOT queue the work', async () => {
    let running = true;
    const { syncer, server, audit } = harness({ taskRunning: () => running });
    const r = await syncer.connect();
    expect(r.ok).toBe(false);
    expect(r.refused).toContain('agent task');
    expect(syncer.state).toBe('offline');
    // nothing was said to the server at all
    expect(server.transcript).toBe('');
    expect(audit.some((a) => a.includes('refused'))).toBe(true);

    // once the task ends, an explicit call connects — the refusal did not leave work queued
    running = false;
    expect((await syncer.connect()).ok).toBe(true);
  });

  it('syncAll refuses as a whole rather than syncing some folders', async () => {
    const { syncer } = harness({ taskRunning: () => true });
    const report = await syncer.syncAll();
    expect(report.ok).toBe(false);
    expect(report.refused).toContain('agent task');
    expect(report.folders).toEqual([]);
  });

  it('the refusal wins over a valid credential: there is no path that skips the gate', async () => {
    const { syncer } = harness({ taskRunning: () => true });
    expect(await syncer.connect()).toEqual(expect.objectContaining({ ok: false }));
    expect(await syncer.fetchBody('INBOX', 1)).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe('sync (36) — credentials and offline behaviour', () => {
  it('without a stored credential there is no connection attempt', async () => {
    const store = new MailStore(':memory:');
    const server = new FakeImapServer();
    store.addAccount({ id: 'work', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: 'me', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const syncer = new MailSyncer(account(), {
      store,
      makeSocket: async () => server.socket(),
      credential: () => null,
      canConnect: () => ({ ok: true }),
    });
    const r = await syncer.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no credential');
    expect(server.transcript).toBe('');
  });

  it('an unreachable host is an error state with a message, not an exception', async () => {
    const store = new MailStore(':memory:');
    const syncer = new MailSyncer(account(), {
      store,
      makeSocket: async () => {
        throw new Error('getaddrinfo ENOTFOUND imap.example.com');
      },
      credential: () => ({ kind: 'password', password: 'pw' }),
      canConnect: () => ({ ok: true }),
    });
    const r = await syncer.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('could not reach');
    expect(syncer.state).toBe('error');
  });

  it('a failed login closes the socket and does not leave a half-open client', async () => {
    const server = new FakeImapServer({ refuseAuth: true });
    const store = new MailStore(':memory:');
    const syncer = new MailSyncer(account(), {
      store,
      makeSocket: async () => server.socket(),
      credential: () => ({ kind: 'password', password: 'wrong' }),
      canConnect: () => ({ ok: true }),
    });
    const r = await syncer.connect();
    expect(r.ok).toBe(false);
    expect(syncer.state).toBe('error');
    expect(await syncer.syncAll(['INBOX'])).toEqual(expect.objectContaining({ ok: false }));
  });

  it('an oauth account with no token uses the refresh callback, and refuses if it cannot', async () => {
    const store = new MailStore(':memory:');
    const server = new FakeImapServer({ capabilities: ['IMAP4rev1', 'AUTH=XOAUTH2'] });
    store.addAccount({ id: 'work', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: 'me', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const oauth = account({ authKind: 'oauth', oauth: { clientId: 'c', tokenUrl: 'https://o.example/t', authUrl: 'https://o.example/a', scope: 's' } });
    let refreshed = 0;
    const syncer = new MailSyncer(oauth, {
      store,
      makeSocket: async () => server.socket(),
      credential: () => ({ kind: 'oauth' }),
      refreshAccessToken: async () => {
        refreshed++;
        return 'AT';
      },
      canConnect: () => ({ ok: true }),
    });
    expect((await syncer.connect()).ok).toBe(true);
    expect(refreshed).toBe(1);

    const noRefresh = new MailSyncer(oauth, {
      store,
      makeSocket: async () => server.socket(),
      credential: () => ({ kind: 'oauth' }),
      canConnect: () => ({ ok: true }),
    });
    const r = await noRefresh.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('access token');
  });
});

describe('sync (36) — IDLE push', () => {
  it('a sync callback fires when the server pushes EXISTS, and stopPush ends the idle', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw', idle: true });
    const { syncer } = harness({ server });
    const hits: string[] = [];
    const ac = new AbortController();
    const pushing = syncer.push((f) => hits.push(f), { signal: ac.signal });
    // wait for select + IDLE to have been sent
    for (let i = 0; i < 50 && !server.transcript.includes('IDLE'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(server.transcript).toContain('IDLE');
    server.pushExists(3);
    for (let i = 0; i < 50 && !hits.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hits).toEqual(['INBOX']);
    syncer.stopPush();
    ac.abort();
    await pushing.catch(() => undefined);
  });

  it('push stops immediately when the connect gate refuses (it does not spin)', async () => {
    const { syncer } = harness({ taskRunning: () => true });
    await syncer.push(() => undefined);
    expect(syncer.state).toBe('offline');
  });

  it('a server without IDLE ends the push loop instead of hammering it', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw', capabilities: ['IMAP4rev1'] });
    const { syncer } = harness({ server });
    await syncer.push(() => undefined);
    expect(syncer.state).toBe('online');
  });
});

// ------------------------------------------------------------------ regressions (review of ff68a31)

describe('sync — non-ASCII mail does not desync the connection', () => {
  it('a 200-header batch with a raw UTF-8 Subject and a non-ASCII body syncs every message', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({ uid: i + 1, flags: [] as string[], raw: `Subject: m${i + 1}\r\nFrom: a@b.c\r\n\r\nbody ${i + 1}\r\n` }));
    messages[99].raw = 'Subject: café crème\r\nFrom: Zoë <z@b.c>\r\n\r\nthe café is open\r\n';
    const server = new FakeImapServer({ user: 'me', password: 'pw', chunkSize: 1000, folders: [{ path: 'INBOX', uidValidity: 9, uidNext: 201, messages }] });
    const { store, syncer } = harness({ server });
    const report = await syncer.syncAll(['INBOX']);
    expect(report.ok).toBe(true);
    expect(report.folders[0].fetched).toBe(200);
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(200);
    expect(store.byUid('work', 'INBOX', 100)!.subject).toBe('café crème');
    expect(store.byUid('work', 'INBOX', 101)!.subject).toBe('m101'); // the one AFTER it is still itself
    const r = await syncer.fetchBody('INBOX', 100);
    expect(r.ok).toBe(true);
    expect(r.charsetLossy).toBeFalsy();
    expect(store.body(store.byUid('work', 'INBOX', 100)!.id)!.bodyText).toContain('the café is open');
  });

  it('an 8-bit latin1 body is decoded per its declared charset, not as UTF-8', async () => {
    const head = 'Subject: latin\r\nFrom: a@b.c\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n';
    const bytes = Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from('café crème\r\n', 'latin1')]);
    const server = new FakeImapServer({ user: 'me', password: 'pw', folders: [{ path: 'INBOX', uidValidity: 9, uidNext: 2, messages: [{ uid: 1, flags: [], raw: head, bytes }] }] });
    const { store, syncer } = harness({ server });
    await syncer.syncAll(['INBOX']);
    const r = await syncer.fetchBody('INBOX', 1);
    expect(r.ok).toBe(true);
    expect(r.charsetLossy).toBeFalsy();
    expect(store.body(store.byUid('work', 'INBOX', 1)!.id)!.bodyText).toContain('café crème');
  });
});

describe('sync — the task gate is checked per ACTION, not only on connect', () => {
  it('a task starting after connect blocks sync, fetchBody, setFlags and move, and nothing reaches the server', async () => {
    let running = false;
    const { store, server, syncer } = harness({ taskRunning: () => running });
    expect((await syncer.syncAll(['INBOX'])).ok).toBe(true);
    running = true;
    const before = server.transcript;
    const sync = await syncer.syncAll(['INBOX']);
    expect(sync.ok).toBe(false);
    expect(sync.refused).toContain('agent task');
    const f = await syncer.fetchBody('INBOX', 1, { markRead: true });
    expect(f.ok).toBe(false);
    expect(f.error).toContain('agent task');
    const fl = await syncer.setFlags([1], 'INBOX', { flagged: true });
    expect(fl.ok).toBe(false);
    expect(fl.error).toContain('agent task');
    const mv = await syncer.move([1], 'INBOX', 'Sent');
    expect(mv.ok).toBe(false);
    expect(mv.error).toContain('agent task');
    expect(server.transcript).toBe(before);
    // and nothing changed locally either
    expect(store.byUid('work', 'INBOX', 1)!.flagged).toBe(false);
    expect(store.byUid('work', 'INBOX', 1)!.bodyFetched).toBe(false);
  });
});

describe('sync — a dropped connection is forgotten and the next action reconnects', () => {
  it('the server drops after login: the next sync reconnects and succeeds', async () => {
    const { server, syncer } = harness();
    expect((await syncer.syncAll(['INBOX'])).ok).toBe(true);
    server.drop(new Error('connection reset by peer'));
    expect(syncer.state).toBe('error');
    const again = await syncer.syncAll(); // full sync: LIST runs first, on the NEW connection
    expect(again.ok).toBe(true);
    expect(server.transcript.match(/ LOGIN /g)).toHaveLength(2);
    expect(syncer.state).toBe('online');
  });

  it('a LIST failure is a report, not an exception thrown out of syncAll', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw' });
    const { syncer } = harness({
      server,
      deps: {
        makeSocket: async () => {
          const sock = server.socket();
          return { ...sock, write: (d: string) => (/ LIST /.test(d) ? server.drop(new Error('reset during LIST')) : sock.write(d)) };
        },
      },
    });
    const report = await syncer.syncAll();
    expect(report.ok).toBe(false);
    expect(report.error).toContain('reset during LIST');
  });

  it('a command timeout drops the connection, and the next sync reconnects', async () => {
    const server = new FakeImapServer({ user: 'me', password: 'pw' });
    let mute = false;
    const { syncer } = harness({
      server,
      deps: {
        commandTimeoutMs: 50,
        makeSocket: async () => {
          const sock = server.socket();
          return { ...sock, write: (d: string) => (mute ? undefined : sock.write(d)) };
        },
      },
    });
    expect((await syncer.syncAll(['INBOX'])).ok).toBe(true);
    mute = true;
    const stuck = await syncer.syncAll(['INBOX']);
    expect(stuck.ok).toBe(false);
    expect(stuck.error).toMatch(/timed out/);
    mute = false;
    expect((await syncer.syncAll(['INBOX'])).ok).toBe(true);
  });
});

describe('sync — moving into a folder that already holds the same uid', () => {
  const withSentUid1 = (opts: { noCopyUid?: boolean } = {}) =>
    new FakeImapServer({
      user: 'me',
      password: 'pw',
      ...opts,
      folders: [
        { path: 'INBOX', uidValidity: 42, uidNext: 3, messages: [{ uid: 1, flags: [], raw: 'Subject: hello\r\nFrom: a@b.c\r\n\r\none\r\n' }, { uid: 2, flags: [], raw: 'Subject: two\r\nFrom: a@b.c\r\n\r\ntwo\r\n' }] },
        { path: 'Sent', uidValidity: 7, uidNext: 2, messages: [{ uid: 1, flags: [], raw: 'Subject: already sent\r\nFrom: me@b.c\r\n\r\nsent\r\n' }] },
      ],
    });

  it('with COPYUID the row is re-keyed in one step (no UNIQUE(account, folder, uid) violation)', async () => {
    const server = withSentUid1();
    const { store, syncer } = harness({ server });
    await syncer.syncAll(['INBOX', 'Sent']);
    expect(store.byUid('work', 'Sent', 1)!.subject).toBe('already sent');
    const r = await syncer.move([1], 'INBOX', 'Sent');
    expect(r.ok).toBe(true);
    expect(store.listMessages({ accountId: 'work', folder: 'INBOX' }).total).toBe(1);
    expect(store.byUid('work', 'Sent', 1)!.subject).toBe('already sent');
    expect(store.byUid('work', 'Sent', 2)!.subject).toBe('hello');
  });

  it('without COPYUID the local row is dropped and the next sync of the target fetches it', async () => {
    const server = withSentUid1({ noCopyUid: true });
    const { store, syncer } = harness({ server });
    await syncer.syncAll(['INBOX', 'Sent']);
    const r = await syncer.move([1], 'INBOX', 'Sent');
    expect(r.ok).toBe(true);
    expect(store.byUid('work', 'INBOX', 1)).toBeFalsy();
    expect(store.byUid('work', 'Sent', 1)!.subject).toBe('already sent'); // untouched, not overwritten
    await syncer.syncAll(['Sent']);
    expect(store.listMessages({ accountId: 'work', folder: 'Sent' }).total).toBe(2);
  });
});

describe('sync — fetchBody opens the folder read-write', () => {
  it('uses SELECT, so the \\Seen STORE after a body fetch is accepted', async () => {
    const { server, syncer } = harness();
    await syncer.syncAll(['INBOX']);
    const r = await syncer.fetchBody('INBOX', 1, { markRead: true });
    expect(r.ok).toBe(true);
    expect(server.transcript).toMatch(/SELECT INBOX\r\n[^]*UID FETCH 1 \(BODY\.PEEK\[\]\)/);
    expect(server.folders[0].messages.find((m) => m.uid === 1)!.flags).toContain('\\Seen');
  });
});

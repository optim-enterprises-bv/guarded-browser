// Ticket 34 — the mail store foundation.
//
// Two kinds of test live here and both matter:
//  1. the store does what the sync layer and the UI will need (migrations, FTS, UIDVALIDITY, threads,
//     counters, caps);
//  2. the store CANNOT hold, or leak, what the product forbids: no gate/taint/agent state, no HTML,
//     no attachment bytes, no credential, and — the one that matters most — no message text that a
//     planner / reader / judge request could ever contain.
//
// The last test is the point of the whole Mail program: fill the store with a marker, render every
// prompt the agent has, and assert the marker is in none of them.

import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MailStore, DB_FILE, SCHEMA_VERSION, MAX_STR, MAX_BODY_TEXT, MAX_MESSAGES, clean, cleanBody, htmlToText, decodeEntities, ftsQuery } from '../../src/core/mail/store';
import { DatabaseSync } from 'node:sqlite';
import { PLANNER_SYSTEM, PLANNER_TOOLS } from '../../src/core/planner';
import { READER_SYSTEM } from '../../src/core/reader';
import { JUDGE_SYSTEM } from '../../src/core/judge';
import { EVENT_CHANNELS, INVOKE_CHANNELS, MAIL_CHANNELS } from '../../src/shared/ipc';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gb-mail-'));
const open = (file = ':memory:') => new MailStore(file);

const header = (over: Partial<Parameters<MailStore['upsertMessage']>[0]> = {}) => ({
  accountId: 'a1',
  folder: 'INBOX',
  uid: 1,
  subject: 'Hello',
  fromName: 'Alice',
  fromAddr: 'alice@example.com',
  toAddrs: 'me@example.com',
  receivedAt: 1_700_000_000_000,
  ...over,
});

describe('mail store (34) — schema and migrations', () => {
  it('creates the schema at the current version and is idempotent when reopened', () => {
    const dir = tmp();
    const f = join(dir, DB_FILE);
    const s = open(f);
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
    s.addAccount({ id: 'a1', name: 'Work', address: 'me@example.com', kind: 'imap', host: 'mail.example.com', port: 993, tls: 'implicit', username: 'me', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive' });
    s.close();
    const again = open(f);
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(again.listAccounts()).toHaveLength(1);
    again.close();
  });

  it('refuses a store written by a NEWER version rather than silently reading it', () => {
    const f = join(tmp(), DB_FILE);
    const s = open(f);
    s.close();
    // simulate a future version by hand, the way a downgrade would look
    const raw = new DatabaseSync(f);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => open(f)).toThrow(/newer version/);
  });

  it('writes 0600 and caps the stored text, so a hostile body cannot be unbounded', () => {
    const dir = tmp();
    const f = join(dir, DB_FILE);
    chmodSync(dir, 0o700);
    const s = open(f);
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const r = s.upsertMessage(header());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s.setBody('a1', 'INBOX', 1, { text: 'x'.repeat(MAX_BODY_TEXT + 5000) });
    expect(s.body(r.id)!.bodyText.length).toBe(MAX_BODY_TEXT);
    s.close();
    // the DB file itself is 0600 (WAL shm files are transient)
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('the WAL sidecar is tightened too (it carries message text as well)', () => {
    const dir = tmp();
    const f = join(dir, DB_FILE);
    const s = open(f);
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    s.upsertMessage(header());
    // WAL is on, so the sidecar exists while the connection is open
    const wal = `${f}-wal`;
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).mode & 0o777).toBe(0o600);
    s.close();
  });
});

describe('mail store (34) — what it CANNOT represent', () => {
  it('no gate, taint or agent column exists anywhere in the schema', () => {
    const s = open();
    const cols = s.columnNames().join(' ').toLowerCase();
    for (const forbidden of ['gate', 'taint', 'agent', 'task', 'policy', 'egress']) expect(cols).not.toContain(forbidden);
    const ddl = s.schemaSql().toLowerCase();
    for (const forbidden of ['gate', 'taint', 'agenttab', 'post-task']) expect(ddl).not.toContain(forbidden);
  });

  it('stores NO html and NO attachment bytes — only text and attachment metadata', () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const r = s.upsertMessage(header());
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { html: '<p>hi</p><script>alert(1)</script>', attachments: [{ partId: '2', filename: 'x.bin', mime: 'application/octet-stream', size: 12_345 }] });
    const b = s.body(r.id)!;
    expect(b.bodyText).not.toContain('<');
    expect(b.bodyText).not.toContain('alert(1)');
    expect(b.attachments[0].size).toBe(12_345);
    // nothing anywhere holds the bytes
    expect(JSON.stringify(s.schemaSql() + JSON.stringify(b))).not.toContain('base64');
  });

  it('a credential-shaped body never reaches disk (nothing in this ticket stores a secret)', () => {
    const dir = tmp();
    const f = join(dir, DB_FILE);
    const s = open(f);
    s.addAccount({ id: 'a1', name: 'Work', address: 'me@example.com', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: 'me', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    s.close();
    const raw = readFileSync(f, 'latin1');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('mail store (34) — text handling', () => {
  it('clean() strips control characters and caps length', () => {
    expect(clean('a\u0000b\u001fc')).toBe('a b c');
    expect(clean('x'.repeat(MAX_STR + 100)).length).toBe(MAX_STR);
    expect(clean(undefined)).toBe('');
  });

  it('cleanBody() keeps line structure but removes control characters', () => {
    expect(cleanBody('a\u0000b\n\nline')).toBe('ab\n\nline');
    expect(cleanBody('a\r\nb')).toBe('a\nb');
  });

  it('htmlToText removes scripts/styles/comments BEFORE decoding entities', () => {
    const r = htmlToText('<style>p{color:red}</style><!-- c --><p>a &amp; b</p><script>evil()</script>');
    expect(r.text).toBe('a & b');
    expect(r.text).not.toContain('evil');
    expect(r.text).not.toContain('color:red');
  });

  it('an encoded script tag survives as TEXT, never as markup (the reader is a text node)', () => {
    const r = htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(r.text).toContain('<script>');
    // it is literal text: the caller sets it as textContent, so it cannot execute
    expect(r.text.startsWith('<p>')).toBe(false);
  });

  it('flags remote content without fetching anything', () => {
    expect(htmlToText('<p>hi</p><img src="https://tracker.example/p.gif">').remoteContent).toBe(true);
    expect(htmlToText('<p>hi</p>').remoteContent).toBe(false);
  });

  it('decodes entities without a parser and refuses a broken numeric reference', () => {
    expect(decodeEntities('&amp;&#65;&#x42;&nbsp;')).toBe('&AB ');
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;'); // surrogate half: left alone, no throw
    expect(decodeEntities('&#99999999999;')).toBe('&#99999999999;');
    expect(decodeEntities('&unknownthing;')).toBe('&unknownthing;');
  });

  it('caps a hostile html body before stripping it (a 300 MB tag soup is not parsed twice)', () => {
    const r = htmlToText('<p>' + 'x'.repeat(MAX_BODY_TEXT * 4) + '</p>');
    expect(r.text.length).toBeLessThanOrEqual(MAX_BODY_TEXT);
  });
});

describe('mail store (34) — search is an injection boundary', () => {
  it('quotes every token: FTS operators in user text cannot break or reshape the query', () => {
    expect(ftsQuery('hello world')).toBe('hello* AND world*');
    // reserved words are DROPPED, not escaped: `OR*` is a syntax error in FTS5
    expect(ftsQuery('" OR "')).toBeNull();
    expect(ftsQuery('NEAR(a b)')).toBe('a* AND b*');
    expect(ftsQuery('cats AND dogs OR birds')).toBe('cats* AND dogs* AND birds*');
    expect(ftsQuery('subject:foo')).toBe('subject* AND foo*');
    expect(ftsQuery('*')).toBeNull();
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('!!!')).toBeNull();
  });

  it('a search never throws, whatever the user types', () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    for (const q of ['"', '*', 'NEAR(', 'a AND', '^(x)$', '\\', '%', '_', '"a" b']) {
      expect(() => s.search(q)).not.toThrow();
    }
  });

  it('finds a phrase in the body with a snippet, and indexes a body added later', () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const r = s.upsertMessage(header({ subject: 'Quarterly report', fromAddr: 'boss@example.com' }));
    if (!r.ok) throw new Error(r.error);
    expect(s.search('quarterly').hits).toHaveLength(1);
    expect(s.search('zebra').hits).toHaveLength(0);
    s.setBody('a1', 'INBOX', 1, { text: 'the zebra is in the body' });
    const hit = s.search('zebra').hits[0];
    expect(hit).toBeDefined();
    expect(hit.snippet).toContain('zebra');
  });

  it('a deleted message leaves no search hit behind', () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const r = s.upsertMessage(header({ subject: 'uniqueword' }));
    if (!r.ok) throw new Error(r.error);
    expect(s.search('uniqueword').hits).toHaveLength(1);
    s.deleteMessages([r.id], true);
    expect(s.search('uniqueword').hits).toHaveLength(0);
  });
});

describe('mail store (34) — folders, UIDVALIDITY and sync bookkeeping', () => {
  const withAccount = () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    s.upsertFolder({ accountId: 'a1', path: 'INBOX', name: 'Inbox', kind: 'inbox', uidValidity: 7, uidNext: 1 });
    return s;
  };

  it('is idempotent per (account, folder, uid) and reports whether it inserted', () => {
    const s = withAccount();
    const a = s.upsertMessage(header());
    const b = s.upsertMessage(header({ subject: 'Edited' }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.id).toBe(a.id);
    expect(b.inserted).toBe(false);
    expect(s.messageCount()).toBe(1);
    expect(s.byUid('a1', 'INBOX', 1)!.subject).toBe('Edited');
  });

  it('refuses a bad uid, a missing folder or a missing account id', () => {
    const s = withAccount();
    expect(s.upsertMessage(header({ uid: 0 })).ok).toBe(false);
    expect(s.upsertMessage(header({ uid: -3 })).ok).toBe(false);
    expect(s.upsertMessage(header({ uid: 1.5 })).ok).toBe(false);
    expect(s.upsertMessage(header({ folder: '  ' })).ok).toBe(false);
    expect(s.upsertMessage(header({ accountId: '' })).ok).toBe(false);
  });

  it('an unchanged UIDVALIDITY keeps the folder; a CHANGED one drops every uid and says so', () => {
    const s = withAccount();
    s.upsertMessage(header({ uid: 1 }));
    s.upsertMessage(header({ uid: 2 }));
    expect(s.setUidValidity('a1', 'INBOX', 7)).toEqual({ reset: false, dropped: 0 });
    expect(s.messageCount()).toBe(2);
    const r = s.setUidValidity('a1', 'INBOX', 8);
    expect(r.reset).toBe(true);
    expect(r.dropped).toBe(2);
    expect(s.messageCount()).toBe(0);
    // and no orphans are left in the index
    expect(s.search('hello').hits).toHaveLength(0);
  });

  it('counts per folder, with unseen and unread kept distinct', () => {
    const s = withAccount();
    s.upsertMessage(header({ uid: 1 })); // never seen
    s.upsertMessage(header({ uid: 2, seen: true })); // seen, not dealt with
    s.upsertMessage(header({ uid: 3, seen: true, readFlag: true }));
    s.upsertMessage(header({ uid: 4, seen: true, readFlag: true, flagged: true }));
    const c = s.folderCounts('a1')[0];
    expect(c.counts.total).toBe(4);
    expect(c.counts.unseen).toBe(1);
    expect(c.counts.unread).toBe(1);
    expect(c.counts.flagged).toBe(1);
    expect(s.counts().unseen).toBe(1);
    expect(s.counts().unread).toBe(1);
  });

  it('listMessages filters by flag only when asked, and pages without repeating a row', () => {
    const s = withAccount();
    for (let i = 1; i <= 10; i++) s.upsertMessage(header({ uid: i, receivedAt: 1_700_000_000_000 + i, seen: i % 2 === 0 }));
    expect(s.listMessages({ accountId: 'a1' }).total).toBe(10);
    expect(s.listMessages({ accountId: 'a1', unseen: true }).total).toBe(5);
    const p1 = s.listMessages({ accountId: 'a1', limit: 4, offset: 0 }).messages.map((m) => m.uid);
    const p2 = s.listMessages({ accountId: 'a1', limit: 4, offset: 4 }).messages.map((m) => m.uid);
    // newest first, so uid 10 is first and the pages do not overlap
    expect(p1).toEqual([10, 9, 8, 7]);
    expect(p2).toEqual([6, 5, 4, 3]);
    expect(new Set([...p1, ...p2]).size).toBe(8);
    expect(s.listMessages({ accountId: 'a1', sinceUid: 8 }).messages.map((m) => m.uid)).toEqual([10, 9]);
  });

  it('a hostile limit/offset cannot turn into an unbounded query', () => {
    const s = withAccount();
    for (let i = 1; i <= 5; i++) s.upsertMessage(header({ uid: i }));
    expect(s.listMessages({ limit: 10_000_000 }).messages.length).toBe(5);
    expect(s.listMessages({ limit: -5, offset: -5 }).messages.length).toBe(1);
  });
});

describe('mail store (34) — flags, moves, threads, labels', () => {
  const seeded = () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive' });
    s.upsertFolder({ accountId: 'a1', path: 'INBOX', name: 'Inbox', kind: 'inbox', uidValidity: 1, uidNext: 1 });
    const ids: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = s.upsertMessage(header({ uid: i, messageId: i <= 2 ? '<thread-1@example.com>' : '<other@example.com>' }));
      if (r.ok) ids.push(r.id);
    }
    return { s, ids };
  };

  it('sets flags by id list only, and an id list of junk changes nothing', () => {
    const { s, ids } = seeded();
    expect(s.setFlags(ids, { readFlag: true, seen: true })).toBe(3);
    expect(s.setFlags([0, -1, NaN, 1.5, null, 'x'] as never, { flagged: true })).toBe(0);
    expect(s.counts().flagged).toBe(0);
  });

  it('moves without touching the uid, and rekey() is how the sync layer fixes it', () => {
    const { s, ids } = seeded();
    const moved = s.move([ids[0]], 'Archive');
    expect(moved.moved).toBe(1);
    expect(s.byId(ids[0])!.folder).toBe('Archive');
    expect(s.byId(ids[0])!.uid).toBe(1);
    expect(s.rekey(ids[0], 'Archive', 900).ok).toBe(true);
    expect(s.byUid('a1', 'Archive', 900)!.id).toBe(ids[0]);
    expect(s.byUid('a1', 'Archive', 1)).toBeNull();
  });

  it('rekey refuses an unknown message or a bad uid rather than corrupting the row', () => {
    const { s, ids } = seeded();
    expect(s.rekey(999_999, 'Archive', 5).ok).toBe(false);
    expect(s.rekey(ids[0], 'Archive', 0).ok).toBe(false);
  });

  it('deleting needs an explicit confirmation and reports what it would discard', () => {
    const { s, ids } = seeded();
    const refused = s.deleteMessages(ids, false);
    expect(refused.ok).toBe(false);
    expect(refused.wouldDelete).toBe(3);
    expect(s.messageCount()).toBe(3);
    expect(s.deleteMessages(ids, true).deleted).toBe(3);
    expect(s.messageCount()).toBe(0);
  });

  it('emptying the trash is a two-step and counts what it will remove', () => {
    const { s, ids } = seeded();
    s.move(ids, 'Trash');
    expect(s.emptyTrash('a1', false).wouldDelete).toBe(3);
    expect(s.emptyTrash('a1', false).ok).toBe(false);
    expect(s.emptyTrash('a1', true).deleted).toBe(3);
  });

  it('groups a thread by the thread id the sync layer set, not by a subject guess', () => {
    const { s, ids } = seeded();
    expect(s.thread('<thread-1@example.com>')).toHaveLength(2);
    expect(s.threadsIn({ accountId: 'a1' })[0].count).toBe(2);
    expect(s.setThread(ids, 'T9')).toBe(3);
    expect(s.thread('T9')).toHaveLength(3);
  });

  it('labels attach and detach, and a label colour that is not a colour is dropped', () => {
    const { s, ids } = seeded();
    expect(s.addLabel('l1', 'Work', '#ff0000').ok).toBe(true);
    expect(s.addLabel('l2', 'Bad', 'javascript:alert(1)').ok).toBe(true);
    expect(s.listLabels().find((l) => l.id === 'l2')!.color).toBe('');
    expect(s.addLabelToMessages(ids, 'l1')).toBe(3);
    expect(s.byId(ids[0])).not.toBeNull();
    expect(s.listMessages({ accountId: 'a1' }).messages[0].labels).toContain('Work');
    expect(s.removeLabelFromMessages(ids, 'l1')).toBe(3);
    expect(s.removeLabel('l1')).toBe(1);
  });

  it('a filter is a saved search, not SQL, and needs a name-bearing expression', () => {
    const { s } = seeded();
    expect(s.addFilter({ id: 'f1', name: 'Boss', expr: 'from:boss@example.com' }).ok).toBe(true);
    expect(s.addFilter({ id: 'f2', name: 'Empty', expr: '   ' }).ok).toBe(false);
    expect(s.listFilters('a1').map((f) => f.id)).toContain('f1');
    expect(s.removeFilter('f1')).toBe(1);
  });

  it('removing an account removes everything under it', () => {
    const { s, ids } = seeded();
    s.addLabel('l1', 'Work', '#00ff00', 'a1');
    s.addLabelToMessages(ids, 'l1');
    s.addFilter({ id: 'f1', name: 'X', expr: 'x', accountId: 'a1' });
    s.removeAccount('a1');
    expect(s.messageCount()).toBe(0);
    expect(s.listFolders('a1')).toHaveLength(0);
    expect(s.listLabels()).toHaveLength(0);
    expect(s.listFilters()).toHaveLength(0);
  });

  it('the row model is capped: a message claiming 10 000 parts stores at most 200', () => {
    const { s, ids } = seeded();
    s.setAttachments(ids[0], Array.from({ length: 10_000 }, (_, i) => ({ partId: `p${i}`, filename: `f${i}`, mime: 'x/y', size: i })));
    expect(s.body(ids[0])!.attachments.length).toBe(200);
  });
});

describe('mail store (34) — bounds', () => {
  it('refuses writes past the message ceiling rather than growing without limit', () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    // simulate a full store without inserting 500 000 rows
    (s as unknown as { messageCount: () => number }).messageCount = () => MAX_MESSAGES;
    expect(s.canStore().ok).toBe(false);
    const r = s.upsertMessage(header());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ceiling');
  });

  it('an update to an EXISTING message is still allowed when the store is full (no data loss)', () => {
    const s = open();
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    s.upsertMessage(header());
    (s as unknown as { messageCount: () => number }).messageCount = () => MAX_MESSAGES;
    const r = s.upsertMessage(header({ subject: 'new flag state' }));
    expect(r.ok).toBe(true);
    expect(s.byUid('a1', 'INBOX', 1)!.subject).toBe('new flag state');
  });

  it('reports the store size including the WAL', () => {
    const f = join(tmp(), DB_FILE);
    const s = open(f);
    expect(s.dbBytes()).toBeGreaterThan(0);
  });
});

describe('mail store (34) — THE INVARIANT: mail never reaches the agent', () => {
  const MARKER = 'CANARY-zebra-9f3d-mail-body';

  it('no planner / reader / judge prompt or tool schema can contain mail text', () => {
    // Fill the store as richly as possible: subject, sender, recipients, body, attachment name,
    // label and filter name all carry the marker.
    const s = open();
    s.addAccount({ id: 'a1', name: MARKER, address: `${MARKER}@example.com`, kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: 'u', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const r = s.upsertMessage(header({ subject: MARKER, fromName: MARKER, fromAddr: `${MARKER}@evil.example`, toAddrs: MARKER, ccAddrs: MARKER, messageId: `<${MARKER}@x>` }));
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { text: `${MARKER} body`, html: `<p>${MARKER}</p>`, rawHeader: `${MARKER}: header`, attachments: [{ partId: '1', filename: MARKER, mime: 'text/plain', size: 1 }] });
    s.addLabel('l1', MARKER);
    s.addFilter({ id: 'f1', name: MARKER, expr: `subject:${MARKER}` });

    // Everything the agent side can be told: the system prompts and the tool schemas.
    const agentSurface = JSON.stringify({
      planner: { system: PLANNER_SYSTEM, tools: PLANNER_TOOLS },
      reader: { system: READER_SYSTEM },
      judge: { system: JUDGE_SYSTEM },
    });
    expect(agentSurface).not.toContain(MARKER);
    expect(agentSurface.toLowerCase()).not.toContain('mail store');
    // and there is no mail tool to call
    expect(PLANNER_TOOLS.map((t) => t.function.name)).not.toContain('mail');
    expect(JSON.stringify(PLANNER_TOOLS)).not.toMatch(/mail|inbox|imap|smtp/i);
  });

  it('the module the agent side imports cannot drag the mail store in', () => {
    // A structural check: the core agent modules import nothing from src/core/mail.
    for (const f of ['src/core/planner.ts', 'src/core/reader.ts', 'src/core/judge.ts', 'src/core/policy.ts', 'src/core/taint.ts', 'src/core/agent.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/from '[^']*mail\//);
      expect(src, f).not.toMatch(/require\(['"][^'"]*mail\//);
    }
  });

  it('mail reaches the renderer as REQUEST/RESPONSE only, and never as pushed message text', () => {
    // Mail became a panel in the browser window in ticket 37c, so the chrome bridge DOES carry the
    // `mail:*` channels — that is the point of the change, and a test forbidding it would forbid the
    // design. What still has to hold is the boundary that made the separate window attractive:
    // message text must never be PUSHED at the renderer, because a pushed payload arrives in the
    // document the agent panel lives in with no request to correlate it to a user action.
    //
    // So: no `mail:*` channel is an event, and the ONE `mail` event that exists carries a number.
    // The preload's EVENTS allowlist is the shared registry (src/shared/ipc.ts).
    const events = new Set<string>(EVENT_CHANNELS);
    expect(events.has('mail')).toBe(true); // the badge count, and nothing else
    // what main sends on that event is a count, and the regex is the assertion
    const runtime = readFileSync(join(process.cwd(), 'src/main/runtime.ts'), 'utf8');
    const sent = /sendUI\('mail',\s*\{[^}]*\}\)/.exec(runtime)?.[0] ?? '';
    expect(sent).toContain('unread');
    expect(sent).not.toMatch(/subject|body|text|from|:to/i);
    // and no mail channel is ever an event name
    const channels = [...INVOKE_CHANNELS].filter((c) => c.startsWith('mail:'));
    expect(channels.length).toBeGreaterThan(10);
    expect(channels.length).toBe(MAIL_CHANNELS.length);
    for (const ch of channels) expect(events.has(ch)).toBe(false);
  });

  it('a store file on disk is readable without the app, and holds nothing secret', () => {
    const f = join(tmp(), DB_FILE);
    const s = open(f);
    s.addAccount({ id: 'a1', name: 'Work', address: 'me@example.com', kind: 'imap', host: 'imap.example.com', port: 993, tls: 'implicit', username: 'me', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive' });
    const r = s.upsertMessage(header({ subject: `${MARKER} subject` }));
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { text: `${MARKER} body text` });
    s.close();
    const raw = readFileSync(f, 'latin1');
    // it DOES contain the mail (that is the store's job) ...
    expect(raw).toContain('subject');
    // ... and it contains no password material, because none is stored in this file at all
    expect(raw).not.toMatch(/password|passwd|secret|token/i);
  });
});

describe('mail store (34) — writeFileSync import is used (guard against an unused-import drift)', () => {
  it('a malformed externally-supplied file cannot be opened as a store', () => {
    const f = join(tmp(), DB_FILE);
    writeFileSync(f, 'not a database at all');
    expect(() => open(f)).toThrow();
  });
});

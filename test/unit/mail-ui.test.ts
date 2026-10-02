// Ticket 37 — the mail UI model: the rules the window has no business holding itself.
//
// The interesting failures here are all RULES, not pixels:
//   * a search box must not be able to reach FTS5 as syntax (it is user input that becomes SQL);
//   * "Show Junk: off" must EXCLUDE junk from the list, not merely not-request it (otherwise turning
//     junk off still shows junk from the folder you are looking at);
//   * threading must use the stored thread id, not a subject guess;
//   * the two counters the screenshot shows (new mail, then total) must both exist and mean what
//     Vivaldi means by unseen vs unread;
//   * and the wording of the remote-content banner is user-visible, so it is asserted here.

import { describe, it, expect } from 'vitest';

import {
  parseMailSearch,
  buildFts,
  fallbackSearch,
  buildFolderTree,
  groupThreads,
  listRowFrom,
  previewText,
  displayName,
  relativeTime,
  readingHeader,
  externalContentNotice,
  badgeCount,
  badgeLabel,
  filterToQuery,
  hiddenFolders,
  DEFAULT_VIEW,
  VIEW_TOGGLES,
  MESSAGE_ACTIONS,
  MAIL_SEARCH_PLACEHOLDER,
  COMPOSE_PLACEHOLDER,
  LOAD_EXTERNAL_LABEL,
  INCLUDE_QUOTED_LABEL,
  UNREAD_BADGE_MAX,
  type ViewFilter,
} from '../../src/core/mail/ui';
import { MailStore } from '../../src/core/mail/store';
import { normalizeAccount } from '../../src/main/mail/accounts';

// ------------------------------------------------------------------ search

describe('mail search (37) — user input never reaches FTS5 as syntax', () => {
  it('parses the screenshot/documentation fields', () => {
    const p = parseMailSearch('from:boss@example.com subject:report');
    expect(p.terms).toEqual([
      { field: 'from', value: 'boss@example.com' },
      { field: 'subject', value: 'report' },
    ]);
    expect(p.advanced).toBe(true);
    expect(p.fts).toContain('fromAddr');
    expect(p.fts).toContain('subject');
  });

  it('treats capitalised AND / OR / NOT as operators (and lower-case ones as words)', () => {
    expect(parseMailSearch('cats OR dogs').operators).toEqual(['or']);
    // one operator per JOIN: three words make two joins
    expect(parseMailSearch('cats or dogs').operators).toEqual(['and', 'and']);
    expect(parseMailSearch('cats OR dogs').operators).toEqual(['or']);
    expect(parseMailSearch('cats AND dogs').operators).toEqual(['and']);
    expect(parseMailSearch('cats NOT dogs').operators).toContain('not');
    expect(parseMailSearch('cats AND dogs').operators).toEqual(['and']);
  });

  it('emits prefix terms and drops every character that could be FTS syntax', () => {
    const p = parseMailSearch('he"llo* NEAR(x) ^a');
    expect(p.fts).not.toContain('"');
    expect(p.fts).not.toContain('^');
    // NEAR survives only as a literal word to match, never as the NEAR operator
    expect(p.fts).not.toMatch(/NEAR\s*\(/);
  });

  it('an empty or punctuation-only query produces no expression at all', () => {
    expect(parseMailSearch('').fts).toBeNull();
    expect(parseMailSearch('   ').fts).toBeNull();
    expect(parseMailSearch('***').fts).toBeNull();
    expect(parseMailSearch('!!! ...').fts).toBeNull();
  });

  it('a query that would start with NOT is refused rather than emitting an invalid expression', () => {
    expect(buildFts([{ field: 'any', value: 'x' }], ['not'])).toBeNull();
    expect(parseMailSearch('NOT x').fts).toBeNull();
  });

  it('caps the number of terms so a huge paste cannot become a huge query', () => {
    const many = Array.from({ length: 100 }, (_, i) => `t${i}`).join(' ');
    const p = parseMailSearch(many);
    expect(p.terms.length).toBeLessThanOrEqual(12);
    // ...and the cap is on the TERMS, while the expression still only mentions the kept ones
    expect((p.fts ?? '').split('*').length - 1).toBeLessThanOrEqual(12);
  });

  it('every operator/term combination produces a string that the store ACCEPTS', () => {
    const s = new MailStore(':memory:');
    s.addAccount({ id: 'a1', name: '', address: '', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' });
    const r = s.upsertMessage({ accountId: 'a1', folder: 'INBOX', uid: 1, subject: 'quarterly report', fromAddr: 'boss@example.com' });
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { text: 'the zebra appendix' });
    const queries = [
      'report',
      'from:boss',
      'subject:quarterly',
      'body:zebra',
      'report OR zebra',
      'quarterly AND report',
      'report NOT zebra',
      '"', '*', 'NEAR(', '^(x)$', '\\', '%',
      'from: subject: body: body:body:',
      'a'.repeat(500),
    ];
    for (const q of queries) {
      const p = parseMailSearch(q);
      // the parser's expression, and any fallback, must both run without throwing
      expect(() => (p.fts ? s.search(p.fts) : undefined), q).not.toThrow();
      expect(() => (fallbackSearch(q) ? s.search(q) : undefined), q).not.toThrow();
    }
    // and the real one finds the message
    const hit = s.searchExpr(parseMailSearch('from:boss').fts);
    expect(hit.hits.length).toBeGreaterThan(0);
    // and a from: search does NOT lose its column filter (the trap `search()` would have hit)
    expect(s.searchExpr(parseMailSearch('from:nobody').fts).hits).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ filters

describe('mail view filters (37) — hiding a category EXCLUDES it', () => {
  it('default view matches the reference screenshot (junk and trash folded away)', () => {
    expect(DEFAULT_VIEW.showJunk).toBe(false);
    expect(DEFAULT_VIEW.showTrash).toBe(false);
    expect(DEFAULT_VIEW.showArchive).toBe(true);
    expect(DEFAULT_VIEW.read).toBe('all');
  });

  it('the toggle list is the six the reference UI shows, in that order', () => {
    expect(VIEW_TOGGLES.map((t) => t.label)).toEqual([
      'Show Custom Folders',
      'Show Mailing Lists',
      'Show Feeds',
      'Show Junk',
      'Show Archive',
      'Show Trashed Items',
    ]);
  });

  it('junk off becomes an explicit junk=false, not an absent flag', () => {
    expect(filterToQuery(DEFAULT_VIEW).junk).toBe(false);
    expect(filterToQuery({ ...DEFAULT_VIEW, showJunk: true }).junk).toBeUndefined();
  });

  it('the read-state rows map to the store flags', () => {
    expect(filterToQuery({ ...DEFAULT_VIEW, read: 'unseen' }).unseen).toBe(true);
    expect(filterToQuery({ ...DEFAULT_VIEW, read: 'unread' }).unread).toBe(true);
    expect(filterToQuery({ ...DEFAULT_VIEW, read: 'all' }).unseen).toBeUndefined();
  });

  it('hidden folders are computed from the FOLDER ROLE, so a renamed Trash is still hidden', () => {
    const folders = [
      { accountId: 'a1', path: 'INBOX', name: 'Inbox', kind: 'inbox' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false },
      { accountId: 'a1', path: 'Papierkorb', name: 'Papierkorb', kind: 'trash' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false },
      { accountId: 'a1', path: 'Junk', name: 'Junk', kind: 'junk' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false },
    ];
    const h = hiddenFolders({ ...DEFAULT_VIEW, showJunk: false, showTrash: false }, folders);
    expect(h.has('Papierkorb')).toBe(true);
    expect(h.has('Junk')).toBe(true);
    expect(h.has('INBOX')).toBe(false);
  });
});

// ------------------------------------------------------------------ the tree

describe('mail tree (37) — sections, counters, and no dropped folder', () => {
  const folders = [
    { accountId: 'a1', path: 'INBOX', name: 'Inbox', kind: 'inbox' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false },
    { accountId: 'a1', path: 'Sent', name: 'Sent', kind: 'sent' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false },
    { accountId: 'a1', path: 'Projects', name: 'Projects', kind: 'folder' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false },
  ];
  const counts = [
    { folder: 'INBOX', kind: 'inbox' as const, counts: { total: 20, unseen: 4, unread: 3, flagged: 1, drafts: 0, junk: 0 } },
    { folder: 'Sent', kind: 'sent' as const, counts: { total: 5, unseen: 0, unread: 0, flagged: 0, drafts: 0, junk: 0 } },
    { folder: 'Projects', kind: 'folder' as const, counts: { total: 2, unseen: 1, unread: 0, flagged: 0, drafts: 0, junk: 0 } },
  ];

  it('builds the sections the reference panel shows, in order', () => {
    const tree = buildFolderTree(folders, counts);
    expect(tree.map((s) => s.id)).toEqual(['all-messages', 'custom-folders', 'mailing-lists', 'filters', 'flags', 'labels', 'feeds']);
    expect(tree.map((s) => s.label)).toEqual(['All Messages', 'Custom Folders', 'Mailing Lists', 'Filters', 'Flags', 'Labels', 'Feeds']);
  });

  it('All Messages carries the role rows in the reference order, with the Received total', () => {
    const all = buildFolderTree(folders, counts)[0];
    // the reference panel's own wording is "Unread" for the read-state row under All Messages
    expect(all.rows.map((r) => r.label)).toEqual(['Unread', 'Received', 'Sent', 'Drafts', 'Outbox', 'Spam', 'Trash', 'Archive']);
    const received = all.rows.find((r) => r.label === 'Received')!;
    expect(received.counts.total).toBe(20);
  });

  it('the Unread row shows the two numbers the reference shows, and they mean different things', () => {
    // The screenshot's chip is two numbers (e.g. "4 20") on the row: the count of mail needing
    // attention, then the count of everything the row covers. unseen and readFlag are separate
    // columns in the store precisely so both can be right at once.
    const all = buildFolderTree(folders, counts)[0];
    const unread = all.rows.find((r) => r.view === 'unread')!;
    expect(unread.counts.unseen).toBe(3); // 3 in INBOX: displayed but not dealt with
    // total = every message in the folders the row covers (INBOX 20 + Projects 2), not only unread ones
    expect(unread.counts.total).toBe(22);
    // only ONE read-state row exists; the other rows are folders (Received carries view 'all')
    expect(all.rows.filter((r) => r.view && r.view !== 'all').map((r) => r.label)).toEqual(['Unread']);
  });

  it('a folder the user created is a custom folder and is never dropped', () => {
    const tree = buildFolderTree(folders, counts);
    const custom = tree.find((s) => s.id === 'custom-folders')!;
    expect(custom.rows.map((r) => r.label)).toEqual(['Projects']);
  });

  it('role rows sum across folders with the same role (two Sent folders is one row)', () => {
    const two = [...folders, { accountId: 'a1', path: 'Sent Items', name: 'Sent Items', kind: 'sent' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false }];
    const c2 = [...counts, { folder: 'Sent Items', kind: 'sent' as const, counts: { total: 7, unseen: 0, unread: 0, flagged: 0, drafts: 0, junk: 0 } }];
    const all = buildFolderTree(two, c2)[0];
    expect(all.rows.filter((r) => r.label === 'Sent')).toHaveLength(1);
    expect(all.rows.find((r) => r.label === 'Sent')!.counts.total).toBe(12);
  });

  it('labels and saved filters become rows in their own sections', () => {
    const tree = buildFolderTree(folders, counts, [{ id: 'l1', name: 'Work' }], [{ id: 'f1', name: 'From boss' }]);
    expect(tree.find((s) => s.id === 'labels')!.rows.map((r) => r.id)).toEqual(['label:l1']);
    expect(tree.find((s) => s.id === 'filters')!.rows.map((r) => r.id)).toEqual(['filter:f1']);
  });

  it('a hidden role is marked, not silently removed (the UI greys it instead of lying about it)', () => {
    const withTrash = [...folders, { accountId: 'a1', path: 'Trash', name: 'Trash', kind: 'trash' as const, uidValidity: 1, uidNext: 1, subscribed: true, hidden: false }];
    const all = buildFolderTree(withTrash, counts, [], [], { ...DEFAULT_VIEW, showTrash: false })[0];
    const trash = all.rows.find((r) => r.label === 'Trash')!;
    expect(trash.hidden).toBe(true);
  });
});

// ------------------------------------------------------------------ list rows

describe('mail list (37) — threading and row shape', () => {
  const row = (over: Partial<Record<string, unknown>>) => ({
    id: 1,
    accountId: 'a1',
    folder: 'INBOX',
    uid: 1,
    messageId: '',
    subject: 's',
    fromName: '',
    fromAddr: 'a@b.c',
    toAddrs: '',
    ccAddrs: '',
    replyTo: '',
    sentAt: 0,
    receivedAt: 1000,
    size: 0,
    seen: false,
    readFlag: false,
    flagged: false,
    answered: false,
    draft: false,
    junk: false,
    remoteContent: false,
    hasAttachments: false,
    bodyFetched: false,
    source: 'mail' as const,
    labels: [],
    ...over,
  });

  it('groups by the thread id the sync layer set (never by subject)', () => {
    const rows = [
      row({ id: 1, messageId: 'a@x', receivedAt: 1 }),
      row({ id: 2, messageId: 'b@x', receivedAt: 2 }),
      row({ id: 3, messageId: 'b@x', receivedAt: 3 }),
    ] as never[];
    const groups = groupThreads(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].rows).toHaveLength(2);
    // the newest member of a thread heads it
    expect(groups[0].head.id).toBe(3);
  });

  it('two different conversations with the same subject are two rows', () => {
    const rows = [row({ id: 1, messageId: 'a@x' }), row({ id: 2, messageId: 'b@x' }), row({ id: 3, messageId: 'c@x' })] as never[];
    expect(groupThreads(rows)).toHaveLength(3);
    expect(rows.every((r) => (r as { subject: string }).subject === 's')).toBe(true);
  });

  it('a row shows the display name, falls back to the address, and says nothing is there', () => {
    expect(displayName('Ada', 'ada@x')).toBe('Ada');
    expect(displayName('', 'ada@x')).toBe('ada@x');
    expect(displayName('', '')).toBe('(unknown sender)');
    const r = listRowFrom(row({ subject: '', fromName: '', fromAddr: 'ada@x' }) as never);
    expect(r.subject).toBe('(no subject)');
    expect(r.from).toBe('ada@x');
  });

  it('unread means NOT dealt with, so a message that was opened but not actioned stays bold', () => {
    expect(listRowFrom(row({ seen: true, readFlag: false }) as never).unread).toBe(true);
    expect(listRowFrom(row({ seen: true, readFlag: true }) as never).unread).toBe(false);
  });

  it('a preview is one collapsed line and never markup', () => {
    expect(previewText('a\n\n  b\tc')).toBe('a b c');
    expect(previewText('x'.repeat(300)).length).toBe(90);
    expect(previewText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>'); // text, set as text
  });

  it('times read Today / Yesterday / a date, in local time', () => {
    const now = new Date(2026, 9, 2, 12, 0, 0).getTime(); // 2 Oct 2026, local
    const todayAt = new Date(2026, 9, 2, 2, 51, 0).getTime();
    const yesterday = new Date(2026, 9, 1, 21, 8, 0).getTime();
    const older = new Date(2026, 7, 14, 9, 0, 0).getTime();
    expect(relativeTime(todayAt, now)).toMatch(/^Today /);
    expect(relativeTime(yesterday, now)).toMatch(/^Yesterday /);
    expect(relativeTime(older, now)).toMatch(/14 Aug/);
    expect(relativeTime(0, now)).toBe('');
    // a server with a clock well in the future produces a plain date, not "Today" or a negative age
    expect(relativeTime(now + 6 * 86_400_000, now)).toBeTruthy();
    expect(relativeTime(now + 6 * 86_400_000, now)).not.toMatch(/Today|Yesterday/);
  });

  it('the reading header carries From/To and only adds Cc/Reply-To when they exist', () => {
    expect(readingHeader(row({ fromName: 'Ada', fromAddr: 'ada@x', toAddrs: 'me@x' }) as never).map((h) => h.label)).toEqual(['From', 'To', 'Date']);
    expect(readingHeader(row({ ccAddrs: 'c@x', replyTo: 'r@x' }) as never).map((h) => h.label)).toEqual(['From', 'To', 'Cc', 'Reply-To', 'Date']);
  });
});

// ------------------------------------------------------------------ wording + badges

describe('mail UI strings and badges (37)', () => {
  it('the remote-content notice is the reference wording, and empty when there is nothing to say', () => {
    expect(externalContentNotice(true)).toBe('This message was prevented from loading external content.');
    expect(externalContentNotice(false)).toBe('');
    expect(LOAD_EXTERNAL_LABEL).toBe('Load External Content');
  });

  it('the other user-visible strings match the reference screenshot', () => {
    expect(MAIL_SEARCH_PLACEHOLDER).toBe('Mail Search');
    expect(COMPOSE_PLACEHOLDER).toBe('Write a quick reply here');
    expect(INCLUDE_QUOTED_LABEL).toBe('Include Quoted Text');
  });

  it('the message toolbar is the reference order', () => {
    expect(MESSAGE_ACTIONS.map((a) => a.label)).toEqual(['Reply', 'Reply to All', 'Forward', 'Flag', 'Label', 'Mark Unread', 'Archive', 'Move to Folder', 'Delete']);
  });

  it('the rail badge sums unseen + unread across accounts and caps', () => {
    expect(badgeCount([{ unseen: 4, unread: 3 }, { unseen: 0, unread: 0 }])).toBe(7);
    expect(badgeCount([])).toBe(0);
    expect(badgeCount([{ unseen: 500, unread: 500 }])).toBe(UNREAD_BADGE_MAX);
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(4)).toBe('4');
    expect(badgeLabel(500)).toBe('99+');
  });
});

describe('mail UI model (37) — the window cannot smuggle mail into the agent', () => {
  it('ui.ts imports nothing from the agent side and nothing that fetches', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'src/core/mail/ui.ts'), 'utf8') as string;
    for (const forbidden of ['llm', 'planner', 'reader.ts', 'judge', 'taint', 'policy', 'net', 'http', 'electron']) {
      expect(src.toLowerCase()).not.toContain(`from '${forbidden}`);
    }
    // the only import is the store, whose types carry no gate state
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./store']);
  });

  it('a mail row model cannot represent gate, taint or task state', () => {
    const r = listRowFrom({
      id: 1, accountId: 'a', folder: 'INBOX', uid: 1, messageId: '', subject: 's', fromName: '', fromAddr: 'a@b',
      toAddrs: '', ccAddrs: '', replyTo: '', sentAt: 0, receivedAt: 1, size: 0, seen: false, readFlag: false,
      flagged: false, answered: false, draft: false, junk: false, remoteContent: false, hasAttachments: false,
      bodyFetched: false, source: 'mail', labels: [],
    } as never);
    const json = JSON.stringify(r).toLowerCase();
    for (const forbidden of ['gate', 'taint', 'agent']) expect(json).not.toContain(forbidden);
  });
});

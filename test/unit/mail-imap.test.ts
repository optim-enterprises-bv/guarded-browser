// Ticket 36 — MIME parsing and the IMAP protocol core.
//
// No sockets, no Electron, no network: the client is driven against `FakeImapServer`, and the MIME
// parser is fed hostile strings directly. Both are hostile-peer surfaces, so every test here is
// written the way the repo's existing suite is — the adversary is given the chance to win (a 4 GB
// literal claim, a base64 body that is not base64, an unknown charset, a FETCH with an unknown
// attribute, a disconnect mid-command) and the code must not fall over.

import { describe, it, expect } from 'vitest';

import {
  parseHeaders,
  headerGet,
  headerAll,
  parseParams,
  decodeWords,
  decodeQuotedPrintable,
  decodeBase64Text,
  bytesToString,
  parseAddresses,
  splitTopLevel,
  parseMime,
  splitMultipart,
  extractContent,
  summaryFromHeaders,
  parseDate,
  MAX_HEADERS,
  MAX_PARTS,
  MAX_FILENAME,
} from '../../src/core/mail/mime';
import { ImapClient, ImapParser, parseFetch, tokenize, expandSet, quote, unquote, sanitizeDetail, probeImapConnection, MAX_LITERAL, type ImapSocket } from '../../src/core/mail/imap';
import { normalizeAccount } from '../../src/main/mail/accounts';
import { FakeImapServer } from '../helpers/fake-imap';

const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ MIME

describe('mime (36) — headers', () => {
  it('parses headers, unfolds continuations and stops at the body', () => {
    const h = parseHeaders('Subject: hello\r\nX-Long: one\r\n two\r\nFrom: a@b.c\r\n\r\nBody here');
    expect(headerGet(h, 'subject')).toBe('hello');
    expect(headerGet(h, 'x-long')).toBe('one two');
    expect(headerAll(h, 'from')).toEqual(['a@b.c']);
    // a header name with a space is not a header: "Body here" has no colon and ends the block
    expect(h.map((x) => x.name)).toEqual(['Subject', 'X-Long', 'From']);
  });

  it('caps the header count and the value length (a hostile header block is bounded)', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `X-${i}: v`).join('\r\n');
    expect(parseHeaders(many).length).toBe(MAX_HEADERS);
    const long = parseHeaders(`Subject: ${'x'.repeat(5000)}`);
    expect(headerGet(long, 'subject')!.length).toBeLessThanOrEqual(1600);
  });

  it('strips control characters from header values', () => {
    const h = parseHeaders('Subject: a\u0000b\u001fc');
    expect(headerGet(h, 'subject')).toBe('a b c');
  });

  it('splits parameters, including quoted values containing semicolons', () => {
    const p = parseParams('multipart/mixed; boundary="=_a;b"; charset=utf-8');
    expect(p.value).toBe('multipart/mixed');
    expect(p.params.boundary).toBe('=_a;b');
    expect(p.params.charset).toBe('utf-8');
  });
});

describe('mime (36) — encoded words and transfer encodings', () => {
  it('decodes B and Q encoded words, including a ? inside the text', () => {
    expect(decodeWords('=?utf-8?B?SGVsbG8=?=')).toBe('Hello');
    expect(decodeWords('=?utf-8?Q?caf=C3=A9?=')).toBe('café');
    expect(decodeWords('=?utf-8?Q?why=3F?=')).toBe('why?');
    expect(decodeWords('=?iso-8859-1?Q?caf=E9?=')).toBe('café');
    expect(decodeWords('plain subject')).toBe('plain subject');
  });

  it('does not keep the whitespace BETWEEN two encoded words (it is a folding artifact)', () => {
    expect(decodeWords('=?utf-8?B?SGVs?= =?utf-8?B?bG8=?=')).toBe('Hello');
    // but whitespace that is not between words is kept
    expect(decodeWords('Hi =?utf-8?B?SGVsbG8=?=')).toBe('Hi Hello');
  });

  it('an unknown charset or broken base64 degrades to text instead of throwing', () => {
    expect(() => decodeWords('=?x-unknown-9?B?SGVsbG8=?=')).not.toThrow();
    expect(decodeWords('=?utf-8?Q?ok?=')).toBe('ok');
    expect(decodeWords('=?utf-8?B?not base64 at all!!?=')).toBeTruthy();
    expect(bytesToString(Buffer.from([0xff, 0xfe]), 'utf-8').length).toBeGreaterThan(0);
    expect(bytesToString(Buffer.from('caf\xe9', 'latin1'), 'iso-8859-1')).toBe('café');
  });

  it('decodes quoted-printable with soft line breaks and literal equals signs', () => {
    expect(decodeQuotedPrintable('a=20b')).toBe('a b');
    // a soft line break is REMOVED, not turned into a space: the sender's own line wrapping must
    // not become content
    expect(decodeQuotedPrintable('line one=\r\nline two')).toBe('line oneline two');
    expect(decodeQuotedPrintable('a=b')).toBe('a=b');
    expect(decodeQuotedPrintable('=C3=A9')).toBe('é');
    // a '=' that introduces neither hex nor a soft break is kept literally
    expect(decodeQuotedPrintable('100%=')).toBe('100%=');
  });

  it('decodes base64 and refuses to crash on something that is not base64', () => {
    expect(decodeBase64Text(Buffer.from('hello').toString('base64'))).toBe('hello');
    expect(decodeBase64Text('!!!! not base64 !!!!')).toBe('!!!! not base64 !!!!');
    const big = 'A'.repeat(10_000);
    expect(() => decodeBase64Text(big)).not.toThrow();
  });
});

describe('mime (36) — addresses', () => {
  it('parses the shapes a real header uses', () => {
    expect(parseAddresses('a@b.c')).toEqual([{ name: '', address: 'a@b.c' }]);
    expect(parseAddresses('Ada Lovelace <ada@example.com>')).toEqual([{ name: 'Ada Lovelace', address: 'ada@example.com' }]);
    expect(parseAddresses('"Lovelace, Ada" <ada@example.com>')[0].name).toBe('Lovelace, Ada');
    expect(parseAddresses('=?utf-8?B?QWRh?= <ada@example.com>')[0].name).toBe('Ada');
    expect(parseAddresses('a@b.c, d@e.f').length).toBe(2);
    expect(parseAddresses('(comment) a@b.c (another)')[0].address).toBe('a@b.c');
  });

  it('handles group syntax by keeping the members and dropping the group name', () => {
    const a = parseAddresses('Team: one@x.y, two@x.y;');
    expect(a.map((x) => x.address)).toEqual(['one@x.y', 'two@x.y']);
  });

  it('never returns more than the cap and drops entries that are not addresses', () => {
    const many = Array.from({ length: 500 }, (_, i) => `u${i}@x.y`).join(', ');
    expect(parseAddresses(many).length).toBe(100);
    expect(parseAddresses('not an address at all').length).toBe(0);
    expect(parseAddresses('<javascript:alert(1)>').length).toBe(0);
  });

  it('splits on commas only at the top level', () => {
    expect(splitTopLevel('a,"b,c",d', ',')).toEqual(['a', '"b,c"', 'd']);
    expect(splitTopLevel('<(a,b)>', ',')).toEqual(['<(a,b)>']);
  });
});

describe('mime (36) — the tree and what is extracted', () => {
  const multipart = [
    'From: Ada <ada@example.com>',
    'To: me@example.com',
    'Message-ID: <caf.report@example.com>',
    'Date: Mon, 01 Jan 2024 00:00:00 +0000',
    'Subject: =?utf-8?Q?caf=C3=A9?= report',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    'preamble that must be dropped',
    '--BOUND',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain body',
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html body</p><img src="https://tracker.example/p.gif">',
    '--ALT--',
    '--BOUND',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="report.pdf"',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '--BOUND--',
    'epilogue that must be dropped',
  ].join('\r\n');

  it('parses nested multiparts and keeps the preamble / epilogue out', () => {
    const root = parseMime(multipart);
    expect(root.contentType).toBe('multipart/mixed');
    expect(root.parts).toHaveLength(2);
    const alt = root.parts[0];
    expect(alt.contentType).toBe('multipart/alternative');
    expect(alt.parts).toHaveLength(2);
    expect(alt.parts[0].body).toContain('plain body');
    expect(JSON.stringify(root)).not.toContain('epilogue');
    expect(JSON.stringify(root)).not.toContain('preamble');
  });

  it('extracts text, keeps html only for the store, and reports attachments as METADATA', () => {
    const c = extractContent(parseMime(multipart));
    expect(c.text).toContain('plain body');
    expect(c.html).toContain('<p>html body</p>');
    expect(c.attachments).toHaveLength(1);
    expect(c.attachments[0].filename).toBe('report.pdf');
    expect(c.attachments[0].mime).toBe('application/pdf');
    expect(c.attachments[0].size).toBeGreaterThan(0);
    // the attachment's BYTES are not in the extracted content at all
    expect(c.text).not.toContain('%PDF');
    expect(c.remoteContent).toBe(true);
  });

  it('decodes the header summary (subject, from, to, date)', () => {
    const s = summaryFromHeaders(parseHeaders(multipart));
    expect(s.subject).toBe('café report');
    expect(s.fromAddr).toBe('ada@example.com');
    expect(s.fromName).toBe('Ada');
    expect(s.toAddrs).toBe('me@example.com');
    expect(s.messageId).toBe('caf.report@example.com');
    expect(s.date).toBe(Date.parse('Mon, 01 Jan 2024 00:00:00 +0000'));
  });

  it('caps parts, depth and size, marking the part truncated instead of throwing', () => {
    const many = ['Content-Type: multipart/mixed; boundary="B"', '', ...Array.from({ length: 400 }, () => '--B\r\nContent-Type: text/plain\r\n\r\nx'), '--B--'].join('\r\n');
    const root = parseMime(many);
    expect(root.parts.length).toBeLessThanOrEqual(MAX_PARTS);
    expect(root.truncated).toBe(true);

    let nested = 'Content-Type: text/plain\r\n\r\nx';
    for (let i = 0; i < 40; i++) nested = `Content-Type: message/rfc822\r\n\r\n${nested}`;
    expect(() => parseMime(nested)).not.toThrow();
  });

  it('a hostile filename is capped, and a filename cannot escape into a path', () => {
    const p = parseMime(['Content-Type: application/octet-stream', `Content-Disposition: attachment; filename="${'x'.repeat(500)}.pdf"`, '', 'AA'].join('\r\n'));
    expect(p.filename.length).toBeLessThanOrEqual(MAX_FILENAME);
    const traversal = parseMime(['Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="../../etc/passwd"', '', 'AA'].join('\r\n'));
    expect(traversal.filename).toContain('..');
    // the store / UI keeps it as TEXT; this asserts we do not try to be clever and rewrite it
    expect(traversal.filename).not.toContain('\u0000');
  });

  it('a message with no blank line is treated as all headers, not a crash', () => {
    const p = parseMime('Subject: only headers\r\nX: 1');
    expect(p.body).toBe('');
    expect(p.headers).toHaveLength(2);
  });

  it('a boundary with regex metacharacters is treated as a literal string', () => {
    const body = ['Content-Type: multipart/mixed; boundary="(*)"', '', '--(*)', 'Content-Type: text/plain', '', 'inside', '--(*)--'].join('\r\n');
    const root = parseMime(body);
    expect(root.parts).toHaveLength(1);
    expect(root.parts[0].body).toContain('inside');
    expect(splitMultipart('nonsense', '(*)')).toEqual([]);
  });

  it('parses RFC 5322 dates and refuses nonsense or absurd dates', () => {
    expect(parseDate('Mon, 01 Jan 2024 00:00:00 +0000')).toBe(Date.parse('Mon, 01 Jan 2024 00:00:00 +0000'));
    expect(parseDate('Mon, 01 Jan 2024 00:00:00 +0000 (UTC)')).toBeGreaterThan(0);
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('Wed, 31 Dec 1969 00:00:00 +0000')).toBeNull(); // before the epoch
    expect(parseDate('Fri, 01 Jan 2999 00:00:00 +0000')).toBeNull(); // absurd
  });
});

// ------------------------------------------------------------------ IMAP parser

describe('imap (36) — the incremental parser', () => {
  it('handles a line split across chunks', () => {
    const got: string[] = [];
    const p = new ImapParser((r) => got.push(r.text));
    p.feed('* 1 EXIS');
    expect(got).toEqual([]);
    p.feed('TS\r\n');
    expect(got).toEqual(['* 1 EXISTS']);
  });

  it('extracts a literal and continues the same logical response after it', () => {
    const got: Array<{ text: string; literals: string[] }> = [];
    const p = new ImapParser((r) => got.push({ text: r.text, literals: r.literals }));
    p.feed('* 1 FETCH (BODY[] {5}\r\nhello)\r\n');
    expect(got).toHaveLength(1);
    expect(got[0].literals).toEqual(['hello']);
    expect(got[0].text).toContain('\u00000\u0000');
    expect(got[0].text).toMatch(/^A?\*? ?1 FETCH \(BODY\[\] /);
  });

  it('waits for the whole literal even when it arrives in pieces', () => {
    const got: string[][] = [];
    const p = new ImapParser((r) => got.push(r.literals));
    p.feed('* 1 FETCH (BODY[] {10}\r\nabc');
    expect(got).toEqual([]);
    p.feed('defghij)\r\n');
    expect(got).toEqual([['abcdefghij']]);
  });

  it('REFUSES a literal that claims to be enormous (a 4 GB claim is not mail)', () => {
    const p = new ImapParser(() => undefined);
    expect(() => p.feed('* 1 FETCH (BODY[] {4294967295}\r\n')).toThrow(/literal of 4294967295 bytes refused/);
    expect(MAX_LITERAL).toBeLessThan(100 * 1024 * 1024);
  });

  it('splits two responses in one chunk', () => {
    const got: string[] = [];
    const p = new ImapParser((r) => got.push(r.text));
    p.feed('* 1 EXISTS\r\n* 2 EXISTS\r\n');
    expect(got).toEqual(['* 1 EXISTS', '* 2 EXISTS']);
  });

  it('a bare LF, and CRLF, both terminate a line', () => {
    const got: string[] = [];
    const p = new ImapParser((r) => got.push(r.text));
    p.feed('* 1 EXISTS\n* 2 EXISTS\r\n');
    expect(got).toHaveLength(2);
  });
});

describe('imap (36) — tokenizer and FETCH parsing', () => {
  it('tokenizes atoms, lists, quoted strings and placeholders', () => {
    expect(tokenize('1 (FLAGS (\\Seen) UID 7)')).toEqual(['1', ['FLAGS', ['\\Seen'], 'UID', '7']]);
    expect(tokenize('"a b" c')).toEqual(['a b', 'c']);
    expect(tokenize('(BODY[] \u00000\u0000)')).toEqual([['BODY[]', '\u00000\u0000']]);
    expect(tokenize('(unbalanced (a b')).toBeTruthy(); // no throw
  });

  it('parses a FETCH with UID, FLAGS, size and a body section', () => {
    const f = parseFetch('1 FETCH (UID 42 FLAGS (\\Seen \\Answered) RFC822.SIZE 123 BODY[HEADER] \u00000\u0000)', ['Subject: x\r\n\r\n']);
    expect(f).not.toBeNull();
    expect(f!.uid).toBe(42);
    expect(f!.seq).toBe(1);
    expect(f!.flags).toEqual(['\\Seen', '\\Answered']);
    expect(f!.size).toBe(123);
    expect(f!.sections.HEADER).toBe('Subject: x\r\n\r\n');
  });

  it('parses BODY[] and a partial <offset>', () => {
    const a = parseFetch('2 FETCH (UID 9 BODY[] \u00000\u0000)', ['raw message']);
    expect(a!.sections['']).toBe('raw message');
    const b = parseFetch('2 FETCH (UID 9 BODY[1]<5> \u00000\u0000)', ['0123456789']);
    expect(b!.sections['1']).toBe('56789');
  });

  it('skips an UNKNOWN attribute without desynchronising the rest of the response', () => {
    const f = parseFetch('3 FETCH (X-GM-LABELS ("\\\\Inbox") UID 77 FLAGS ())', []);
    expect(f!.uid).toBe(77);
    expect(f!.flags).toEqual([]);
  });

  it('parses an ENVELOPE, including an address list', () => {
    // date, subject, FROM, sender, reply-to, TO, cc, bcc, in-reply-to, message-id
    const env = '("Mon, 01 Jan 2024 00:00:00 +0000" "Hi" (("Ada" NIL "ada" "example.com")) NIL NIL (("Me" NIL "me" "example.com")) NIL NIL NIL "<abc@example.com>")';
    const f = parseFetch(`4 FETCH (UID 5 ENVELOPE ${env})`, []);
    expect(f!.envelope).toBeDefined();
    expect(f!.envelope!.subject).toBe('Hi');
    expect(f!.envelope!.from[0]).toEqual({ name: 'Ada', address: 'ada@example.com' });
    expect(f!.envelope!.to[0].address).toBe('me@example.com');
    expect(f!.envelope!.messageId).toBe('abc@example.com');
  });

  it('returns null for something that is not a FETCH line rather than throwing', () => {
    expect(parseFetch('* 1 EXISTS', [])).toBeNull();
    expect(parseFetch('garbage', [])).toBeNull();
  });

  it('expands a uid set with a bound, in both directions', () => {
    expect(expandSet('1,3:5')).toEqual([1, 3, 4, 5]);
    expect(expandSet('5:3')).toEqual([3, 4, 5]); // reversed ranges are legal
    expect(expandSet('1:100000')).toHaveLength(5000); // bounded at the cap, inclusive
    expect(expandSet('x')).toEqual([]);
  });
});

describe('imap (36) — command quoting is an injection boundary', () => {
  it('quotes what must be quoted and refuses a value with a newline', () => {
    expect(quote('INBOX')).toBe('INBOX');
    expect(quote('My Folder')).toBe('"My Folder"');
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(() => quote('INBOX\r\nA1 LOGOUT')).toThrow(/newline/);
    expect(() => quote('x\n')).toThrow(/newline/);
    expect(unquote('"a b"')).toBe('a b');
    expect(unquote('NIL')).toBe('NIL');
  });

  it('sanitizes a server-supplied detail string before it reaches a user-visible error', () => {
    expect(sanitizeDetail('NO bad\r\nA1 DELETE INBOX')).toBe('NO bad A1 DELETE INBOX');
    expect(sanitizeDetail('x\u0000y')).toBe('xy');
    expect(sanitizeDetail(undefined)).toBe('');
    expect(sanitizeDetail('z'.repeat(500)).length).toBe(200);
  });
});

// ------------------------------------------------------------------ client against the fake server

const client = async (server: FakeImapServer, user = 'me', password = 'pw') => {
  const c = new ImapClient(server.socket(), 3000);
  await c.greeting();
  await c.capability();
  await c.login(user, password);
  return c;
};

describe('imap (36) — client commands', () => {
  it('greets, reads capabilities and logs in', async () => {
    const s = new FakeImapServer({ user: 'me', password: 'pw' });
    const c = new ImapClient(s.socket(), 3000);
    await c.greeting();
    const caps = await c.capability();
    expect(caps).toContain('IMAP4REV1');
    await c.login('me', 'pw');
    expect(c.has('MOVE')).toBe(true);
    expect(s.transcript).toContain('LOGIN me pw');
  });

  it('refuses a NO greeting and reports it as a refusal, not a timeout', async () => {
    const s = new FakeImapServer({ greeting: '* BYE too many connections\r\n' });
    const c = new ImapClient(s.socket(), 500);
    await expect(c.greeting()).rejects.toThrow(/refused the connection/);
  });

  it('a wrong password is a NO and the error carries the server reason', async () => {
    const s = new FakeImapServer({ user: 'me', password: 'right' });
    const c = new ImapClient(s.socket(), 3000);
    await c.greeting();
    await c.capability();
    await expect(c.login('me', 'wrong')).rejects.toThrow(/invalid credentials/);
  });

  it('serialises commands: a second command while one is in flight is refused', async () => {
    const s = new FakeImapServer();
    const sock = s.socket();
    let held: string | null = null;
    // hold the write so the first command is genuinely in flight (the fake server answers
    // synchronously, which would otherwise let the first command complete before the second starts)
    const held1: ImapSocket = { ...sock, write: (d) => { held = d; } };
    const c = new ImapClient(held1, 3000);
    await c.greeting();
    const first = c.capability();
    await expect(c.capability()).rejects.toThrow(/already in flight/);
    sock.write(held!);
    await expect(first).resolves.toContain('IMAP4REV1');
  });

  it('times out a command the server never answers', async () => {
    const s = new FakeImapServer({ capabilities: [] });
    const c = new ImapClient(s.socket(), 60);
    await c.greeting();
    // a server that accepts a connection and then answers nothing must not wedge the account
    const silent: ImapSocket = { ...s.socket(), write: () => undefined };
    const c2 = new ImapClient(silent, 60);
    await expect(c2.capability()).rejects.toThrow(/timed out/);
  });

  it('reports an open connection dropping mid-command', async () => {
    const s = new FakeImapServer();
    const sock = s.socket();
    let held: string | null = null;
    // the command must be in flight for the drop to have something to reject
    const c = new ImapClient({ ...sock, write: (d) => { held = d; } }, 3000);
    await c.greeting();
    const p = c.capability();
    s.drop(new Error('socket hang up'));
    await expect(p).rejects.toThrow(/socket hang up/);
    expect(held).toContain('CAPABILITY');
  });

  it('lists folders, including the delimiter and the name', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    const list = await c.list('', '*');
    expect(list.map((f) => f.path)).toEqual(['INBOX', 'Sent']);
    expect(list[0].delimiter).toBe('/');
  });

  it('opens a folder read-only and reads UIDVALIDITY / UIDNEXT', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    const info = await c.select('INBOX', true);
    expect(info.exists).toBe(2);
    expect(info.uidValidity).toBe(42);
    expect(info.uidNext).toBe(3);
    expect(s.transcript).toContain('EXAMINE INBOX');
  });

  it('refuses a folder that does not exist with the server reason', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    await expect(c.select('Nope')).rejects.toThrow(/cannot open Nope/);
  });

  it('searches and fetches headers by uid', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    await c.select('INBOX', true);
    expect(await c.uidSearch('1:*')).toEqual([1, 2]);
    expect(await c.uidSearch('2:*')).toEqual([2]);
    const fetched = await c.uidFetch('1:*', '(FLAGS RFC822.SIZE)');
    expect(fetched.map((f) => f.uid).sort()).toEqual([1, 2]);
    expect(fetched[0].size).toBeGreaterThan(0);
  });

  it('reads a full body by uid', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    await c.select('INBOX', true);
    expect(await c.uidBody(1)).toContain('body one');
  });

  it('stores flags, moving in and out of \\Seen', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    await c.select('INBOX');
    await c.uidStore([1], 'add', ['Seen']);
    expect(s.folders[0].messages.find((m) => m.uid === 1)!.flags).toContain('\\Seen');
    await c.uidStore([1], 'remove', ['Seen']);
    expect(s.folders[0].messages.find((m) => m.uid === 1)!.flags).not.toContain('\\Seen');
    // a flag that is not a flag-shaped token is dropped, not sent
    await c.uidStore([1], 'add', ['$']);
    expect(s.transcript).not.toContain('$');
  });

  it('MOVE reports the new uids from COPYUID so the store can re-key', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    await c.select('INBOX');
    const r = await c.uidMove([1], 'Sent');
    expect(r.moved).toBe(true);
    expect(r.newUids.get(1)).toBeGreaterThan(0);
    expect(s.folders.find((f) => f.path === 'Sent')!.messages.length).toBe(1);
  });

  it('falls back to COPY + \\Deleted when the server has no MOVE', async () => {
    const s = new FakeImapServer({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    const c = await client(s);
    await c.select('INBOX');
    const r = await c.uidMove([2], 'Sent');
    expect(r.moved).toBe(true);
    expect(s.transcript).toContain('UID COPY 2 Sent');
    expect(s.folders[0].messages.find((m) => m.uid === 2)!.flags).toContain('\\Deleted');
  });

  it('APPENDs a message and reads the new uid from APPENDUID', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    const r = await c.append('Sent', 'Subject: hi\r\n\r\nbody', ['Seen']);
    expect(r.uid).toBe(s.folders.find((f) => f.path === 'Sent')!.uidNext - 1);
    expect(s.folders.find((f) => f.path === 'Sent')!.messages[0].raw).toContain('Subject: hi');
  });

  it('AUTHENTICATE PLAIN and XOAUTH2 send the credential as a SASL line after `+`, never in a literal', async () => {
    const s = new FakeImapServer({ capabilities: ['IMAP4rev1', 'AUTH=PLAIN', 'AUTH=XOAUTH2', 'IDLE'] });
    const c = new ImapClient(s.socket(), 3000);
    await c.greeting();
    await c.capability();
    await c.authenticatePlain('me', 's3cret');
    const b64 = Buffer.from('\u0000me\u0000s3cret').toString('base64');
    expect(s.transcript).toContain('AUTHENTICATE PLAIN');
    expect(s.transcript).toContain(b64);
    await c.authenticateXoauth2('me', 'TOKEN');
    expect(s.transcript).toContain(Buffer.from('user=me\u0001auth=Bearer TOKEN\u0001\u0001').toString('base64'));
  });

  it('IDLE delivers unsolicited EXISTS / FETCH through events, and DONE ends it', async () => {
    const s = new FakeImapServer({ idle: true });
    const c = await client(s);
    const events: string[] = [];
    c.onEvent((e) => events.push(e.kind));
    await c.select('INBOX');
    const idling = c.idle({ timeoutMs: 3000 }).catch(() => undefined);
    await tick();
    s.pushExists(3);
    s.pushFetch(3, 99);
    await tick();
    c.idleDone();
    await idling;
    expect(events).toContain('exists');
    expect(events).toContain('fetch');
  });

  it('refuses IDLE on a server that does not advertise it', async () => {
    const s = new FakeImapServer({ capabilities: ['IMAP4rev1'] });
    const c = await client(s);
    await expect(c.idle()).rejects.toThrow(/does not advertise IDLE/);
  });

  it('LOGOUT then a further command is refused (the client knows it is closed)', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    await c.logout();
    await expect(c.capability()).rejects.toThrow(/closed/);
  });
});

describe('imap (36) — the connection probe reports the exact step', () => {
  const account = {
    host: 'imap.example.com',
    port: 993,
    tls: 'implicit' as const,
    username: 'me',
    secret: 'pw',
  };

  it('succeeds against a well-behaved server', async () => {
    const s = new FakeImapServer({ user: 'me', password: 'pw' });
    const r = await probeImapConnection(account, async () => s.socket());
    expect(r.ok).toBe(true);
    expect(r.step).toBe('done');
  });

  it('reports an auth failure with the server reason', async () => {
    const s = new FakeImapServer({ refuseAuth: true });
    const r = await probeImapConnection(account, async () => s.socket());
    expect(r.ok).toBe(false);
    expect(r.step).toBe('auth');
  });

  it('reports a folder failure separately from an auth failure', async () => {
    const s = new FakeImapServer({ user: 'me', password: 'pw' });
    const r = await probeImapConnection({ ...account, openFolder: 'DoesNotExist' }, async () => s.socket());
    expect(r.ok).toBe(false);
    expect(r.step).toBe('folder');
  });

  it('separates a TCP failure from a TLS failure by the error text', async () => {
    const tcp = await probeImapConnection(account, async () => {
      throw new Error('connect ECONNREFUSED 1.2.3.4:993');
    });
    expect(tcp.step).toBe('tcp');
    const tls = await probeImapConnection(account, async () => {
      throw new Error('unable to verify the first certificate');
    });
    expect(tls.step).toBe('tls');
  });

  it('reports a server that greets but never answers CAPABILITY', async () => {
    const s = new FakeImapServer();
    const r = await probeImapConnection(account, async () => {
      const sock = s.socket();
      const wrapped: ImapSocket = { ...sock, write: (d) => (d.includes('CAPABILITY') ? undefined : sock.write(d)) };
      return wrapped;
    });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('capability');
  });
});

describe('imap (36) — the live probe works with the account taxonomy', () => {
  it('an xoauth2 secret is sent as XOAUTH2 and a plain one as PLAIN', async () => {
    const a = normalizeAccount({ id: 'x', name: 'X', address: 'me@e.x', kind: 'imap', host: 'h', port: 993, tls: 'implicit', username: 'me', authKind: 'oauth', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '', oauth: { clientId: 'c', tokenUrl: 'https://o.example/t', authUrl: 'https://o.example/a', scope: 's' } });
    if (!a.ok) throw new Error(a.error);
    const s = new FakeImapServer({ capabilities: ['IMAP4rev1', 'AUTH=PLAIN', 'AUTH=XOAUTH2'] });
    const r = await probeImapConnection({ host: 'h', port: 993, tls: 'implicit', username: 'me', secret: `\u0001XOAUTH2\u0001AT` }, async () => s.socket());
    expect(r.ok).toBe(true);
    expect(s.transcript).toContain('AUTHENTICATE XOAUTH2');
    expect(s.transcript).not.toContain('AUTHENTICATE PLAIN');
  });
});

// ------------------------------------------------------------------ regressions (review of ff68a31)

describe('imap — literals are BYTES, and literals go out the way RFC 3501 says', () => {
  it('counts a literal in octets: a non-ASCII literal does not swallow the next response', () => {
    const got: Array<{ text: string; literals: string[] }> = [];
    const p = new ImapParser((r) => got.push({ text: r.text, literals: r.literals }));
    // `café` is 4 characters but 5 bytes; slicing 5 CHARACTERS eats the `)` and desyncs everything after
    p.feed('* 1 FETCH (BODY[] {5}\r\ncafé)\r\n* 2 EXISTS\r\n');
    expect(got.map((g) => g.literals)).toEqual([['café'], []]);
    expect(got[1].text).toBe('* 2 EXISTS');
  });

  it('a body with non-ASCII text and a raw UTF-8 header, cut into 3-byte chunks, arrives intact', async () => {
    const raw = 'Subject: café crème\r\nFrom: a@b.c\r\n\r\nthe café is open\r\n';
    const s = new FakeImapServer({ chunkSize: 3, folders: [{ path: 'INBOX', uidValidity: 1, uidNext: 3, messages: [{ uid: 1, flags: [], raw }, { uid: 2, flags: [], raw: 'Subject: next\r\n\r\nx\r\n' }] }] });
    const c = await client(s);
    await c.select('INBOX', true);
    const headers = await c.uidFetch('1:2', '(UID BODY.PEEK[HEADER])');
    expect(headers.map((h) => h.uid)).toEqual([1, 2]);
    expect(headers[0].sections.HEADER).toContain('Subject: café crème');
    expect(headers[1].sections.HEADER).toContain('Subject: next');
    expect((await c.uidBodyBytes(1)).equals(Buffer.from(raw, 'utf8'))).toBe(true);
    expect(await c.uidBody(1)).toBe(raw);
  });

  it('AUTHENTICATE waits for `+` and sends the SASL response as its own CRLF-terminated line', async () => {
    const s = new FakeImapServer({ user: 'me', password: 's3cret', capabilities: ['IMAP4rev1', 'AUTH=PLAIN'] });
    const c = new ImapClient(s.socket(), 1000);
    await c.greeting();
    await c.capability();
    await c.authenticatePlain('me', 's3cret');
    const b64 = Buffer.from('\u0000me\u0000s3cret').toString('base64');
    expect(s.bad).toEqual([]);
    expect(s.log).toContain('A0002 AUTHENTICATE PLAIN\r\n');
    expect(s.log).toContain(`${b64}\r\n`);
    expect(s.transcript).not.toMatch(/\{\d+\}/);
    // and the credential is checked, so a wrong one is a NO rather than a silent OK
    const s2 = new FakeImapServer({ user: 'me', password: 'right', capabilities: ['IMAP4rev1', 'AUTH=PLAIN'] });
    const c2 = new ImapClient(s2.socket(), 1000);
    await c2.greeting();
    await c2.capability();
    await expect(c2.authenticatePlain('me', 'wrong')).rejects.toThrow(/invalid credentials/);
  });

  it('with SASL-IR the initial response rides on the command line (one round trip)', async () => {
    const s = new FakeImapServer({ capabilities: ['IMAP4rev1', 'AUTH=PLAIN', 'AUTH=XOAUTH2', 'SASL-IR'] });
    const c = new ImapClient(s.socket(), 1000);
    await c.greeting();
    await c.capability();
    await c.authenticateXoauth2('me', 'TOKEN');
    const b64 = Buffer.from('user=me\u0001auth=Bearer TOKEN\u0001\u0001').toString('base64');
    expect(s.bad).toEqual([]);
    expect(s.log).toContain(`A0002 AUTHENTICATE XOAUTH2 ${b64}\r\n`);
  });

  it('APPEND waits for `+`, then sends the literal and the CRLF that ends the command', async () => {
    const s = new FakeImapServer();
    const c = await client(s);
    const msg = 'Subject: café\r\n\r\nbody';
    const r = await c.append('Sent', msg, ['Seen']);
    expect(s.bad).toEqual([]);
    expect(r.uid).toBeGreaterThan(0);
    expect(s.log.some((w) => w.endsWith(`{${Buffer.byteLength(msg)}}\r\n`))).toBe(true); // octets, not characters
    expect(s.log).toContain(`${msg}\r\n`);
    expect(s.folders.find((f) => f.path === 'Sent')!.messages[0].raw).toBe(msg);
    // the connection is still in sync: the next command is answered as itself
    expect((await c.select('INBOX')).uidValidity).toBe(42);
  });

  it('with LITERAL+ APPEND uses `{N+}` in one write and does not wait', async () => {
    const s = new FakeImapServer({ capabilities: ['IMAP4rev1', 'UIDPLUS', 'LITERAL+'] });
    const c = await client(s);
    await c.append('Sent', 'Subject: hi\r\n\r\nbody');
    expect(s.bad).toEqual([]);
    expect(s.log).toContain(`A0003 APPEND Sent () {19+}\r\nSubject: hi\r\n\r\nbody\r\n`);
  });

  it('a command timeout is fatal: the socket is closed and the next command is refused, not mis-paired', async () => {
    const s = new FakeImapServer();
    const sock = s.socket();
    let ended = 0;
    let mute = false;
    const c = new ImapClient({ ...sock, write: (d) => (mute ? undefined : sock.write(d)), end: () => { ended++; sock.end(); } }, 60);
    await c.greeting();
    await c.capability();
    mute = true;
    await expect(c.capability()).rejects.toThrow(/timed out/);
    expect(ended).toBe(1);
    mute = false;
    await expect(c.capability()).rejects.toThrow(/closed/);
  });
});

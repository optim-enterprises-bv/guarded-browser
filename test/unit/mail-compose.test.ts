// Ticket 38 — message building (src/core/mail/compose.ts). Pure, so every header rule is asserted on
// the exact bytes, and the output is read back with the SAME decoders the client uses for received
// mail (mime.ts), which is what proves the encodings round-trip.

import { describe, it, expect } from 'vitest';
import {
  buildMessage,
  parseAddressList,
  validateAddress,
  encodedWords,
  encodeQuotedPrintable,
  subjectHeader,
  headerAddress,
  formatDate,
  replySubject,
  forwardSubject,
  quoteOriginal,
  forwardBlock,
  buildReferences,
  replyRecipients,
  formatAddressForInput,
  recipientDomains,
  normalizeMessageId,
  MAX_RECIPIENTS,
} from '../../src/core/mail/compose';
import { decodeWords, decodeQuotedPrintable, parseHeaders, headerGet, parseAddresses } from '../../src/core/mail/mime';

const FROM = { name: 'Ada Lovelace', address: 'ada@example.com' };
const DATE = new Date(Date.UTC(2026, 9, 2, 12, 0, 0));
const build = (o: Partial<Parameters<typeof buildMessage>[0]> = {}) => {
  const r = buildMessage({ from: FROM, to: 'bob@example.com', subject: 'Hello', body: 'Hi Bob', date: DATE, random: () => 'RANDOM', ...o });
  if (!r.ok) throw new Error(r.error);
  return r;
};
const headersOf = (raw: string) => parseHeaders(raw.slice(0, raw.indexOf('\r\n\r\n') + 2));
const bodyOf = (raw: string) => raw.slice(raw.indexOf('\r\n\r\n') + 4);

describe('compose (38) — address parsing is strict and linear', () => {
  it('parses names, quoted names with commas, bare addresses, and ; as a separator', () => {
    const r = parseAddressList('Bob Smith <bob@example.com>, "Lovelace, Ada" <ada@example.org>; carol@example.net,', 'To');
    expect(r).toEqual({
      ok: true,
      list: [
        { name: 'Bob Smith', address: 'bob@example.com' },
        { name: 'Lovelace, Ada', address: 'ada@example.org' },
        { name: '', address: 'carol@example.net' },
      ],
    });
    expect(parseAddressList('', 'To')).toEqual({ ok: true, list: [] });
  });

  it('refuses invalid addresses with a message that quotes them', () => {
    for (const [input, re] of [
      ['bob', /needs exactly one @/],
      ['bob@@example.com', /exactly one @/],
      ['bob@localhost', /needs a dot/],
      ['.bob@example.com', /misplaced dot/],
      ['bo..b@example.com', /misplaced dot/],
      ['bob@exa_mple.com', /not a valid domain/],
      ['bob smith@example.com', /put a name before/],
      ['Bob <bob@example.com> extra', /nothing may follow/],
      ['Bob <bob@example.com', /unterminated "<"/],
      ['Bob" <bob@example.com>', /quoted name/],
      ['"Bob <bob@example.com>', /unterminated quoted name/],
      ['jörg@example.com', /non-ASCII/],
      ['bob@123.456', /not a valid domain/],
    ] as const) {
      const r = parseAddressList(input, 'To');
      expect(r.ok, input).toBe(false);
      expect(!r.ok && r.error, input).toMatch(re);
      expect(!r.ok && r.error, input).toMatch(/^To: /);
    }
    expect(validateAddress('x'.repeat(65) + '@example.com')).toMatch(/too long/);
  });

  it('a CR or LF anywhere in an address field is REFUSED, not stripped', () => {
    for (const evil of ['bob@example.com\r\nBcc: eve@example.com', 'Bob\n <bob@example.com>', 'bob@example.com\r']) {
      const r = parseAddressList(evil, 'Cc');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/^Cc: line breaks are not allowed/);
    }
  });

  it('is linear: a hostile 8 000-character field is answered fast', () => {
    const t0 = performance.now();
    parseAddressList('"'.repeat(3999) + '<'.repeat(4000), 'To');
    parseAddressList(`${'a.'.repeat(3990)}@example.com`, 'To');
    parseAddressList('a,'.repeat(3999), 'To');
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('caps the recipient count', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`).join(', ');
    expect(parseAddressList(many, 'To').ok).toBe(false);
  });

  it('formatAddressForInput is the inverse of the parser', () => {
    for (const a of [{ name: 'Bob', address: 'bob@example.com' }, { name: 'Lovelace, Ada', address: 'a@example.com' }, { name: 'Say "hi"', address: 's@example.com' }, { name: '', address: 'x@example.com' }, { name: 'Bob <the builder>', address: 'b@example.com' }]) {
      const r = parseAddressList(formatAddressForInput(a), 'To');
      expect(r).toEqual({ ok: true, list: [a] });
    }
  });
});

describe('compose (38) — headers', () => {
  it('builds the RFC 5322 header set in order, 7-bit, CRLF', () => {
    const m = build({ cc: 'Carol <carol@example.org>' });
    const head = m.raw.slice(0, m.raw.indexOf('\r\n\r\n'));
    const names = head.split('\r\n').filter((l) => !/^\s/.test(l)).map((l) => l.split(':')[0]);
    expect(names).toEqual(['Date', 'From', 'To', 'Cc', 'Subject', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
    expect(head).toContain('From: Ada Lovelace <ada@example.com>');
    expect(head).toContain('To: bob@example.com');
    expect(head).toContain('Cc: Carol <carol@example.org>');
    expect(head).toContain('Subject: Hello');
    expect(head).toContain('MIME-Version: 1.0');
    expect(head).toContain('Content-Type: text/plain; charset=utf-8');
    expect(head).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(m.raw).toMatch(/^[\x00-\x7f]*$/);
    expect(m.raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(m.bytes).toBe(Buffer.byteLength(m.raw));
  });

  it('Message-ID is random at the From domain; Date is RFC 5322', () => {
    const m = build();
    expect(m.messageId).toMatch(/^<[a-z0-9]+\.RANDOM@example\.com>$/);
    const real = buildMessage({ from: FROM, to: 'b@example.com', subject: 's', body: 'b' });
    const again = buildMessage({ from: FROM, to: 'b@example.com', subject: 's', body: 'b' });
    if (!real.ok || !again.ok) throw new Error('build');
    expect(real.messageId).not.toBe(again.messageId);
    expect(real.messageId).toMatch(/@example\.com>$/);
    expect(formatDate(DATE)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 2026 \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    expect(Date.parse(formatDate(DATE))).toBe(DATE.getTime());
  });

  it('BCC IS ENVELOPE ONLY: the recipients are delivered to, and no header names them', () => {
    const m = build({ to: 'bob@example.com', bcc: 'Secret Sam <sam@hidden.example>, eve@hidden.example' });
    expect(m.envelope.to).toEqual(['bob@example.com', 'sam@hidden.example', 'eve@hidden.example']);
    expect(m.raw).not.toMatch(/^Bcc:/im);
    expect(m.raw).not.toContain('hidden.example');
    expect(m.raw).not.toContain('Secret Sam');
    // a Bcc-only message gets the standard empty group, not a missing To
    const only = build({ to: '', bcc: 'sam@hidden.example' });
    expect(only.raw).toContain('To: undisclosed-recipients:;');
    expect(only.raw).not.toContain('hidden.example');
  });

  it('the envelope is deduplicated case-insensitively; no recipient at all is refused', () => {
    const m = build({ to: 'Bob <bob@example.com>', cc: 'BOB@example.com', bcc: 'bob@example.com' });
    expect(m.envelope.to).toEqual(['bob@example.com']);
    const none = buildMessage({ from: FROM, to: '', subject: 'x', body: 'y' });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toMatch(/at least one recipient/);
  });

  it('non-ASCII subjects and names become RFC 2047 encoded-words that decode back exactly, folded', () => {
    const subject = 'Grüße aus Köln — ein sehr langer Betreff mit Umlauten, Emoji 🎉 und noch mehr Text dahinter';
    const m = build({ subject, to: 'Jörg Müller <joerg@example.de>', from: { name: 'Zoë Ålund', address: 'zoe@example.com' } });
    const head = m.raw.slice(0, m.raw.indexOf('\r\n\r\n'));
    for (const l of head.split('\r\n')) expect(l.length, l).toBeLessThanOrEqual(78);
    const h = headersOf(m.raw);
    expect(decodeWords(headerGet(h, 'subject') ?? '', 900)).toBe(subject);
    expect(parseAddresses(headerGet(h, 'to') ?? '')).toEqual([{ name: 'Jörg Müller', address: 'joerg@example.de' }]);
    expect(parseAddresses(headerGet(h, 'from') ?? '')).toEqual([{ name: 'Zoë Ålund', address: 'zoe@example.com' }]);
    // never a split UTF-8 sequence inside one word
    for (const w of encodedWords('🎉'.repeat(40))) {
      const b64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1];
      expect(Buffer.from(b64, 'base64').toString('utf8')).not.toContain('�');
      expect(w.length).toBeLessThanOrEqual(75);
    }
  });

  it('a long ASCII subject is folded at spaces and unfolds to the original', () => {
    const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const h = subjectHeader(subject);
    expect(h.split('\r\n').length).toBeGreaterThan(1);
    for (const l of h.split('\r\n')) expect(l.length).toBeLessThanOrEqual(78);
    expect(h.replace(/\r\n /g, ' ')).toBe(`Subject: ${subject}`);
    // an ASCII subject that LOOKS like an encoded word is encoded, so it is not decoded on arrival
    expect(subjectHeader('=?UTF-8?B?aGk=?=')).toMatch(/^Subject: =\?UTF-8\?B\?/);
    expect(decodeWords(subjectHeader('=?UTF-8?B?aGk=?=').slice(9), 100)).toBe('=?UTF-8?B?aGk=?=');
  });

  it('display names with specials are quoted, plain ones are bare', () => {
    expect(headerAddress({ name: 'Bob', address: 'b@example.com' })).toBe('Bob <b@example.com>');
    expect(headerAddress({ name: 'Smith, Bob', address: 'b@example.com' })).toBe('"Smith, Bob" <b@example.com>');
    expect(headerAddress({ name: 'Say "hi"', address: 'b@example.com' })).toBe('"Say \\"hi\\"" <b@example.com>');
  });

  it('HEADER INJECTION: CR/LF in the subject, a name or an address is refused with the field named', () => {
    const subj = buildMessage({ from: FROM, to: 'bob@example.com', subject: 'hi\r\nBcc: eve@example.com', body: 'x' });
    expect(subj.ok).toBe(false);
    expect(!subj.ok && subj.error).toMatch(/^Subject: line breaks are not allowed/);
    const name = buildMessage({ from: { name: 'Ada\nBcc: eve@example.com', address: 'ada@example.com' }, to: 'bob@example.com', subject: 's', body: 'x' });
    expect(name.ok).toBe(false);
    expect(!name.ok && name.error).toMatch(/From name: line breaks/);
    const to = buildMessage({ from: FROM, to: 'bob@example.com\r\nX-Evil: 1', subject: 's', body: 'x' });
    expect(!to.ok && to.error).toMatch(/^To: line breaks/);
    const ctl = buildMessage({ from: FROM, to: 'bob@example.com', subject: 'a\u0000b', body: 'x' });
    expect(!ctl.ok && ctl.error).toMatch(/control characters/);
  });

  it('threading headers: In-Reply-To and References, normalised and trimmed', () => {
    const refs = buildReferences('<a@x.example> <b@x.example>\r\n <c@x.example>', 'd@x.example');
    expect(refs).toEqual(['<a@x.example>', '<b@x.example>', '<c@x.example>', '<d@x.example>']);
    const m = build({ inReplyTo: 'd@x.example', references: refs });
    const h = headersOf(m.raw);
    expect(headerGet(h, 'in-reply-to')).toBe('<d@x.example>');
    expect((headerGet(h, 'references') ?? '').split(/\s+/)).toEqual(refs);
    // a long chain keeps the first id and the most recent ones
    const long = buildReferences(Array.from({ length: 40 }, (_, i) => `<m${i}@x.example>`).join(' '), '<last@x.example>');
    expect(long).toHaveLength(20);
    expect(long[0]).toBe('<m0@x.example>');
    expect(long.at(-1)).toBe('<last@x.example>');
    // a value that could break the header is dropped, never written
    expect(normalizeMessageId('a b@x')).toBeNull();
    expect(normalizeMessageId('<a@x>\r\nBcc: e@x')).toBeNull();
    expect(build({ inReplyTo: 'evil\r\nBcc: e@x.example' }).raw).not.toContain('In-Reply-To');
  });
});

describe('compose (38) — the body', () => {
  it('quoted-printable over UTF-8 BYTES: decodes back exactly, lines ≤ 76, trailing space kept', () => {
    const body = `Hello Bob,\nnon-ASCII: Grüße — 東京 🎉\n= signs = here\ntrailing space \n${'x'.repeat(300)}\n.leading dot line\n`;
    const qp = encodeQuotedPrintable(body);
    for (const l of qp.split('\r\n')) expect(l.length, l).toBeLessThanOrEqual(76);
    expect(qp).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(qp).toContain('space=20');
    // (the client's own decoder normalises line ends to \n, as it does for received mail)
    expect(decodeQuotedPrintable(qp, 1_000_000)).toBe(body);
    // the multi-byte sequences are encoded byte by byte (2 bytes for ü, 4 for 🎉)
    expect(qp).toContain('Gr=C3=BC=C3=9Fe');
    expect(qp).toContain('=F0=9F=8E=89');
  });

  it('a message body round-trips through buildMessage', () => {
    const m = build({ body: 'line one\r\nline two ü\rline three' });
    expect(bodyOf(m.raw)).toBe('line one\r\nline two =C3=BC\r\nline three\r\n');
    expect(decodeQuotedPrintable(bodyOf(m.raw), 10_000)).toBe('line one\nline two ü\nline three\n');
  });
});

describe('compose (38) — replies and forwards', () => {
  it('Re: and Fwd: are added once, never stacked', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('Aw: Hallo')).toBe('Aw: Hallo');
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('FW: Hello')).toBe('FW: Hello');
    expect(forwardSubject('Re: Hello')).toBe('Fwd: Re: Hello');
  });

  it('quoting: an attribution line and "> " on every line', () => {
    expect(quoteOriginal('one\n\ntwo\n', { date: 'Thu, 01 Oct 2026', from: 'Bob <bob@example.com>' })).toBe('On Thu, 01 Oct 2026, Bob <bob@example.com> wrote:\n> one\n>\n> two');
    const f = forwardBlock('body', { date: 'D', from: 'F', to: 'T', subject: 'S' });
    expect(f).toBe('---------- Forwarded message ----------\nFrom: F\nDate: D\nSubject: S\nTo: T\n\nbody');
  });

  it('reply goes to Reply-To else From; reply-all adds To/Cc minus me and duplicates', () => {
    const orig = { fromName: 'Bob', fromAddr: 'bob@example.com', replyTo: '', toAddrs: 'me@example.com, carol@example.com', ccAddrs: 'dave@example.com, BOB@example.com' };
    expect(replyRecipients(orig, 'me@example.com', false)).toEqual({ to: [{ name: 'Bob', address: 'bob@example.com' }], cc: [] });
    expect(replyRecipients(orig, 'ME@example.com', true)).toEqual({
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [
        { name: '', address: 'carol@example.com' },
        { name: '', address: 'dave@example.com' },
      ],
    });
    expect(replyRecipients({ ...orig, replyTo: 'list@example.com' }, 'me@example.com', false).to).toEqual([{ name: '', address: 'list@example.com' }]);
  });

  it('the audit summary is domains, not addresses', () => {
    expect(recipientDomains(['a@Example.com', 'b@example.com', 'c@other.example'])).toEqual(['example.com', 'other.example']);
  });
});

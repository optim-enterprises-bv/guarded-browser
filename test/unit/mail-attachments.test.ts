// Ticket 41 — attachments: receiving (BODYSTRUCTURE, explicit-click download, inline cid: images),
// sending (Attach…, private draft copies, multipart/mixed, forward), and the isolation rules.
//
// The BODYSTRUCTURE strings below are written VERBATIM in the shapes Dovecot, Gmail and Apache James
// return, from the RFC 3501 grammar (section 7.4.2 / 9): body-type-mpart has NO space between its
// bodies, body-ext-1part is md5 / dsp / lang / loc, a message/rfc822 part carries envelope + body +
// lines, and RFC 2231 continuations arrive as the raw parameter names. They are fed through the real
// incremental parser (ImapParser) and parseFetch, exactly as a socket would deliver them.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ImapParser, parseFetch, type ImapResponse } from '../../src/core/mail/imap';
import {
  parseBodyStructure,
  planParts,
  allParts,
  decodeTransfer,
  decodeQuotedPrintableBytes,
  sanitizeFilename,
  attachmentName,
  mimeForFilename,
  sniffImage,
  referencedCids,
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSE_ATTACHMENT_BYTES,
  type BodyPart,
} from '../../src/core/mail/attachments';
import { fileRisk, DownloadList } from '../../src/core/downloads';
import { assembleParams, parseMime } from '../../src/core/mail/mime';
import { buildMessage, filenameParams, base64Lines, asciiFallbackName } from '../../src/core/mail/compose';
import { inlineCidImages } from '../../src/core/mail/html';
import { MailStore } from '../../src/core/mail/store';
import { MailController, OUTBOX_DIR } from '../../src/main/mail/controller';
import { PLANNER_TOOLS } from '../../src/core/planner';
import { MAIL_CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc';
import { FakeImapServer, fakeBodyStructure, fakeParseEntity, fakeSectionOf } from '../helpers/fake-imap';
import { FakeSmtpServer } from '../helpers/fake-smtp';
import { PDF_BYTES, PNG_BYTES, attachmentsMessage, cidMessage, receivedParts, b64 } from '../helpers/mail-fixtures';

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

/** Feed a raw server line through the incremental parser and parse its FETCH, as the client does. */
function fetchOf(wire: string | Buffer) {
  const got: ImapResponse[] = [];
  const p = new ImapParser((r) => got.push(r));
  p.feed(typeof wire === 'string' ? Buffer.from(wire, 'utf8') : wire);
  expect(got).toHaveLength(1);
  const f = parseFetch(got[0].text, got[0].literals, got[0].literalBytes);
  expect(f).not.toBeNull();
  return f!;
}

const structureOf = (wire: string | Buffer) => parseBodyStructure(fetchOf(wire).bodyStructure);
const leaf = (root: BodyPart, section: string) => allParts(root).find((p) => p.section === section)!;

// ---------------------------------------------------------------- BODYSTRUCTURE, verbatim

describe('BODYSTRUCTURE (41) — real server shapes, parsed from the wire', () => {
  it('Dovecot: multipart/alternative nested in multipart/mixed, a PDF and an image attachment', () => {
    const root = structureOf(
      '* 12 FETCH (UID 4012 BODYSTRUCTURE ((("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 1340 28 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 5826 104 NIL NIL NIL NIL) "alternative" ("boundary" "000000000000a1b2c3") NIL NIL NIL)("application" "pdf" ("name" "Q3 report.pdf") NIL NIL "base64" 117458 NIL ("attachment" ("filename" "Q3 report.pdf" "size" "85800")) NIL NIL)("image" "png" ("name" "chart.png") "<chart.1@example.com>" "Sales chart" "base64" 21340 NIL ("inline" ("filename" "chart.png")) NIL NIL) "mixed" ("boundary" "000000000000d4e5f6") NIL NIL NIL))\r\n',
    )!;
    expect(root.type).toBe('multipart');
    expect(root.subtype).toBe('mixed');
    expect(root.section).toBe('');
    expect(root.params.boundary).toBe('000000000000d4e5f6');
    expect(allParts(root).map((p) => `${p.section}:${p.type}/${p.subtype}`)).toEqual([':multipart/mixed', '1:multipart/alternative', '1.1:text/plain', '1.2:text/html', '2:application/pdf', '3:image/png']);
    const pdf = leaf(root, '2');
    expect(pdf).toMatchObject({ encoding: 'base64', size: 117458, disposition: 'attachment', filename: 'Q3 report.pdf' });
    expect(pdf.dispositionParams.size).toBe('85800');
    const png = leaf(root, '3');
    expect(png).toMatchObject({ id: 'chart.1@example.com', description: 'Sales chart', disposition: 'inline', filename: 'chart.png' });
    expect(leaf(root, '1.1').params.charset).toBe('utf-8');
    const plan = planParts(root);
    expect(plan.text.map((p) => p.section)).toEqual(['1.1', '1.2']);
    expect(plan.attachments.map((p) => p.section)).toEqual(['2', '3']);
  });

  it('Gmail: upper-case atoms, "BASE64", a two-element body-ext-mpart (dsp, lang)', () => {
    const root = structureOf(
      '* 3 FETCH (X-GM-THRID 1780000000000000001 UID 77 BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 42 2 NIL NIL NIL)("APPLICATION" "OCTET-STREAM" ("NAME" "data.bin") NIL NIL "BASE64" 344 NIL ("ATTACHMENT" ("FILENAME" "data.bin")) NIL) "MIXED" ("BOUNDARY" "0000000000001234abcd") NIL NIL))\r\n',
    )!;
    expect(root.subtype).toBe('mixed');
    expect(leaf(root, '1')).toMatchObject({ type: 'text', subtype: 'plain', encoding: '7bit', size: 42, params: { charset: 'UTF-8' } });
    expect(leaf(root, '2')).toMatchObject({ type: 'application', subtype: 'octet-stream', encoding: 'base64', size: 344, disposition: 'attachment', filename: 'data.bin' });
  });

  it('Apache James: a single-part message is section 1; NIL params and NIL disposition', () => {
    const root = structureOf('* 1 FETCH (UID 9 BODYSTRUCTURE ("application" "octet-stream" NIL NIL NIL "base64" 10 NIL NIL NIL NIL))\r\n')!;
    expect(root).toMatchObject({ section: '1', type: 'application', subtype: 'octet-stream', disposition: '', filename: '', params: {}, id: '' });
    expect(planParts(root).attachments.map((p) => p.section)).toEqual(['1']);
    const text = structureOf('* 2 FETCH (UID 10 BODYSTRUCTURE ("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 25 1 NIL NIL NIL NIL))\r\n')!;
    expect(text.section).toBe('1');
    expect(planParts(text).text.map((p) => p.section)).toEqual(['1']);
  });

  it('a message/rfc822 part: envelope + body + lines; ONE attachment, its inner parts numbered under it', () => {
    const root = structureOf(
      '* 5 FETCH (UID 31 BODYSTRUCTURE (("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 20 1 NIL NIL NIL NIL)("message" "rfc822" ("name" "fwd.eml") NIL NIL "7bit" 640 ("Thu, 01 Oct 2026 10:00:00 +0000" "Original subject" (("Bob" NIL "bob" "example.org")) (("Bob" NIL "bob" "example.org")) (("Bob" NIL "bob" "example.org")) ((NIL NIL "ada" "example.com")) NIL NIL NIL "<orig@example.org>") (("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 12 1 NIL NIL NIL NIL)("application" "pdf" ("name" "inner.pdf") NIL NIL "base64" 100 NIL ("attachment" ("filename" "inner.pdf")) NIL NIL) "mixed" ("boundary" "inner") NIL NIL NIL) 22 NIL ("attachment" ("filename" "fwd.eml")) NIL NIL) "mixed" ("boundary" "outer") NIL NIL NIL))\r\n',
    )!;
    const msg = leaf(root, '2');
    expect(msg).toMatchObject({ type: 'message', subtype: 'rfc822', size: 640, disposition: 'attachment', filename: 'fwd.eml' });
    expect(msg.message?.type).toBe('multipart');
    expect(allParts(root).map((p) => p.section)).toEqual(['', '1', '2', '2', '2.1', '2.2']);
    const plan = planParts(root);
    // the inner text and the inner PDF are NOT this message's text / attachments: the .eml is one file
    expect(plan.text.map((p) => p.section)).toEqual(['1']);
    expect(plan.attachments.map((p) => p.section)).toEqual(['2']);
  });

  it('section numbering follows the RFC 3501 6.4.5 example exactly (4.2.2.1 and all)', () => {
    const tp = '("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 10 1 NIL NIL NIL NIL)';
    const oct = '("application" "octet-stream" NIL NIL NIL "base64" 10 NIL NIL NIL NIL)';
    const env = '(NIL "inner" NIL NIL NIL NIL NIL NIL NIL NIL)';
    const msg3 = `("message" "rfc822" NIL NIL NIL "7bit" 300 ${env} (${tp}${oct} "mixed" ("boundary" "m3") NIL NIL NIL) 9 NIL NIL NIL NIL)`;
    const rich = '("text" "richtext" ("charset" "us-ascii") NIL NIL "7bit" 10 1 NIL NIL NIL NIL)';
    const msg42 = `("message" "rfc822" NIL NIL NIL "7bit" 300 ${env} (${tp}(${tp}${rich} "alternative" ("boundary" "a") NIL NIL NIL) "mixed" ("boundary" "m42") NIL NIL NIL) 9 NIL NIL NIL NIL)`;
    const gif = '("image" "gif" NIL NIL NIL "base64" 10 NIL NIL NIL NIL)';
    const root = structureOf(`* 1 FETCH (UID 1 BODYSTRUCTURE (${tp}${oct}${msg3}(${gif}${msg42} "mixed" ("boundary" "m4") NIL NIL NIL) "mixed" ("boundary" "top") NIL NIL NIL))\r\n`)!;
    const seen = allParts(root)
      .filter((p) => p.type !== 'multipart' || p.section)
      .map((p) => `${p.section} ${p.type}/${p.subtype}`);
    expect(seen).toEqual([
      '1 text/plain',
      '2 application/octet-stream',
      '3 message/rfc822',
      '3 multipart/mixed', // the attached message's body: its own TEXT, addressed as 3
      '3.1 text/plain',
      '3.2 application/octet-stream',
      '4 multipart/mixed',
      '4.1 image/gif',
      '4.2 message/rfc822',
      '4.2 multipart/mixed',
      '4.2.1 text/plain',
      '4.2.2 multipart/alternative',
      '4.2.2.1 text/plain',
      '4.2.2.2 text/richtext',
    ]);
  });

  it('RFC 2231: filename*0* / filename*1* continuations (a UTF-8 sequence split across them) and name*', () => {
    const root = structureOf(
      `* 7 FETCH (UID 70 BODYSTRUCTURE (("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 5 1 NIL NIL NIL NIL)("application" "pdf" ("name*" "utf-8''%E2%82%AC%20rates.pdf") NIL NIL "base64" 1000 NIL ("attachment" ("filename*0*" "utf-8'en'%E2%82" "filename*1*" "%AC%20rates%20for%20Q3%20%E2%80%94%20" "filename*2" "final.pdf")) NIL NIL) "mixed" ("boundary" "b") NIL NIL NIL))\r\n`,
    )!;
    expect(leaf(root, '2').filename).toBe('€ rates for Q3 — final.pdf');
    expect(leaf(root, '2').params.name).toBe('€ rates.pdf');
    // latin1 charset in the extended value, and the extended form wins over a plain one
    expect(assembleParams({ 'filename*': "iso-8859-1''r%E9sum%E9.pdf", filename: 'resume.pdf' }).filename).toBe('résumé.pdf');
    // out-of-order segments are joined by index
    expect(assembleParams({ 'name*1': 'B', 'name*0': 'A', 'name*2': 'C' }).name).toBe('ABC');
  });

  it('RFC 2047 in a quoted parameter (what Outlook and Gmail send) and a filename sent as a LITERAL with raw UTF-8', () => {
    const r1 = structureOf('* 8 FETCH (UID 80 BODYSTRUCTURE ("APPLICATION" "PDF" ("NAME" "=?UTF-8?B?w5xiZXJzaWNodC5wZGY=?=") NIL NIL "BASE64" 400 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?B?w5xiZXJzaWNodC5wZGY=?=")) NIL))\r\n')!;
    expect(r1.filename).toBe('Übersicht.pdf');
    const name = Buffer.from('résumé.pdf', 'utf8');
    const wire = Buffer.concat([
      Buffer.from(`* 9 FETCH (UID 90 BODYSTRUCTURE ("application" "pdf" NIL NIL NIL "base64" 400 NIL ("attachment" ("filename" {${name.length}}\r\n`, 'latin1'),
      name,
      Buffer.from(')) NIL NIL))\r\n', 'latin1'),
    ]);
    expect(structureOf(wire)!.filename).toBe('résumé.pdf');
  });

  it('a hostile or malformed structure returns null (the caller falls back) and never throws', () => {
    expect(parseBodyStructure(undefined)).toBeNull();
    expect(parseBodyStructure('NIL')).toBeNull();
    expect(parseBodyStructure([])).toBeNull();
    expect(parseBodyStructure(['text'])).toBeNull();
    // 200 levels of multipart: bounded, no stack overflow
    let deep = '("text" "plain" NIL NIL NIL "7bit" 1 1 NIL NIL NIL NIL)';
    for (let i = 0; i < 200; i++) deep = `(${deep} "mixed" NIL NIL NIL NIL)`;
    expect(() => structureOf(`* 1 FETCH (UID 1 BODYSTRUCTURE ${deep})\r\n`)).not.toThrow();
    // 5 000 parts claimed: capped
    const many = Array.from({ length: 5000 }, () => '("text" "plain" NIL NIL NIL "7bit" 1 1 NIL NIL NIL NIL)').join('');
    const r = structureOf(`* 1 FETCH (UID 1 BODYSTRUCTURE (${many} "mixed" NIL NIL NIL NIL))\r\n`);
    expect(allParts(r!).length).toBeLessThanOrEqual(300);
  });
});

describe('the fake IMAP server speaks RFC 3501 BODYSTRUCTURE (so sync tests take the real-server path)', () => {
  it('emits the exact Dovecot layout for a known message', () => {
    const raw = ['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=utf-8', '', 'hello', '--B', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERg==', '--B--', ''].join('\r\n');
    expect(fakeBodyStructure(fakeParseEntity(raw))).toBe(
      '(("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 5 0 NIL NIL NIL NIL)("application" "pdf" ("name" "a.pdf") NIL NIL "base64" 8 NIL ("attachment" ("filename" "a.pdf")) NIL NIL) "mixed" ("boundary" "B") NIL NIL NIL)',
    );
    expect(fakeSectionOf(Buffer.from(raw), '2')!.toString()).toBe('JVBERg==');
    expect(fakeSectionOf(Buffer.from(raw), '2.MIME')!.toString()).toContain('Content-Type: application/pdf');
    expect(fakeSectionOf(Buffer.from(raw), '9')).toBeNull();
    // what the real client makes of it
    const root = structureOf(`* 1 FETCH (UID 1 BODYSTRUCTURE ${fakeBodyStructure(fakeParseEntity(raw))})\r\n`)!;
    expect(planParts(root).attachments[0]).toMatchObject({ section: '2', filename: 'a.pdf', size: 8 });
  });

  it('an 8-bit parameter goes out as a literal, and the default content type is text/plain; us-ascii', () => {
    const raw = Buffer.from('Content-Type: application/pdf; name="r\u00e9sum\u00e9.pdf"\r\n\r\nx', 'utf8').toString('latin1');
    expect(fakeBodyStructure(fakeParseEntity(raw))).toMatch(/\("name" \{12\}\r\nr/);
    expect(fakeBodyStructure(fakeParseEntity('Subject: x\r\n\r\nbody\r\n'))).toBe('("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 6 1 NIL NIL NIL NIL)');
  });
});

// ---------------------------------------------------------------- bytes

describe('transfer decoding (41) — BYTES in, bytes out', () => {
  it('base64 in 76-column CRLF lines: every byte value 0..255 survives', () => {
    const data = Buffer.concat([ALL_BYTES, ALL_BYTES.reverse(), ALL_BYTES]);
    expect(decodeTransfer('base64', Buffer.from(b64(data))).equals(data)).toBe(true);
    expect(decodeTransfer('BASE64', Buffer.from(base64Lines(data))).equals(data)).toBe(true);
    // junk outside the alphabet and a missing final CRLF are tolerated
    expect(decodeTransfer('base64', Buffer.from(` ${data.toString('base64')}\t\r\n`)).equals(data)).toBe(true);
  });

  it('quoted-printable over bytes: =XX for every byte, soft breaks, transport whitespace dropped', () => {
    const data = Buffer.from(ALL_BYTES);
    let qp = '';
    let line = '';
    for (const b of data) {
      const tok = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (line.length + tok.length > 75) {
        qp += `${line}=\r\n`;
        line = '';
      }
      line += tok;
    }
    qp += line;
    expect(decodeQuotedPrintableBytes(Buffer.from(qp)).equals(data)).toBe(true);
    expect(decodeTransfer('quoted-printable', Buffer.from('a=3Db=\r\nc  \r\nd =\nend=')).toString('latin1')).toBe('a=bc\r\nd end');
    expect(decodeTransfer('quoted-printable', Buffer.from('lone = sign')).toString()).toBe('lone = sign');
  });

  it('7bit / 8bit / binary / unknown are passed through unchanged', () => {
    for (const enc of ['7bit', '8bit', 'binary', 'x-uuencode', '']) expect(decodeTransfer(enc, ALL_BYTES).equals(ALL_BYTES)).toBe(true);
  });

  it('image sniffing is by magic number, and only png / jpeg / gif / webp count', () => {
    expect(sniffImage(PNG_BYTES)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.4'))).toBeNull();
  });
});

// ---------------------------------------------------------------- names

describe('file names (41) — attacker-chosen, so sanitized before they are shown or saved', () => {
  it('bidi overrides, control and zero-width characters are removed (U+202E shows "fdp.exe" as "exe.pdf")', () => {
    const evil = 'invoice\u202Efdp.exe';
    const s = sanitizeFilename(evil);
    expect(s).toBe('invoicefdp.exe');
    expect(fileRisk(s).executable).toBe(true);
    expect(sanitizeFilename('a\u0000b\u0007c\u200Bd\u2066e\uFEFF.txt')).toBe('abcde.txt');
    expect(sanitizeFilename('line\r\nbreak.txt')).toBe('line break.txt');
  });

  it('paths of every platform become one name; leading dots and trailing dots/spaces go', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.dll')).toBe('C__Windows_System32_evil.dll');
    expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    expect(sanitizeFilename('report.pdf. . .')).toBe('report.pdf');
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('...')).toBe('attachment');
  });

  it('reserved Windows device names are prefixed', () => {
    for (const n of ['CON', 'con.txt', 'Nul.pdf', 'com1.doc', 'LPT9.txt', 'aux.tar.gz']) expect(sanitizeFilename(n)).toBe(`_${n}`);
    expect(sanitizeFilename('console.txt')).toBe('console.txt');
  });

  it('length is capped with the extension kept', () => {
    const s = sanitizeFilename(`${'x'.repeat(500)}.pdf`);
    expect([...s].length).toBeLessThanOrEqual(120);
    expect(s.endsWith('.pdf')).toBe(true);
  });

  it('double extensions and executable / script types are flagged; ordinary documents are not', () => {
    const d = fileRisk('invoice.pdf.exe');
    expect(d).toMatchObject({ executable: true, doubleExtension: true });
    expect(d.warning).toMatch(/disguised.*\.pdf.*\.exe/);
    for (const n of ['setup.msi', 'run.sh', 'macro.docm', 'x.js', 'x.vbs', 'x.ps1', 'x.lnk', 'x.desktop', 'x.AppImage', 'disk.iso']) expect(fileRisk(n).executable, n).toBe(true);
    expect(fileRisk('data.bin', 'application/x-msdownload').executable).toBe(true);
    expect(fileRisk('report.pdf', 'application/pdf')).toEqual({ executable: false, doubleExtension: false, warning: '' });
    expect(fileRisk('photos.jpg.zip').doubleExtension).toBe(false);
  });

  it('an unnamed part gets a name from its type; the type map defaults to octet-stream', () => {
    expect(attachmentName('', 'image/png')).toBe('attachment.png');
    expect(attachmentName('', 'message/rfc822')).toBe('message.eml');
    expect(attachmentName('', 'application/x-unknown')).toBe('attachment');
    expect(mimeForFilename('a.PDF')).toBe('application/pdf');
    expect(mimeForFilename('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeForFilename('a.weird')).toBe('application/octet-stream');
  });

  it('the downloads list carries the same warning for a page download and a mail attachment', () => {
    const list = new DownloadList();
    list.addFile({ filename: 'invoice.pdf.exe', host: 'mail attachment', path: '/tmp/x', bytes: 3 });
    expect(list.list()[0]).toMatchObject({ state: 'completed', warning: expect.stringMatching(/disguised/) });
  });
});

// ---------------------------------------------------------------- compose

const FROM = { name: 'Ada', address: 'ada@example.com' };

describe('compose (41) — multipart/mixed with base64 attachments', () => {
  it('text first, each file base64 in 76-column lines, the bytes round-trip, names from the extension map', () => {
    const r = buildMessage({ from: FROM, to: 'bob@example.org', subject: 'files', body: 'see attached', attachments: [{ filename: 'all.bin', data: ALL_BYTES }, { filename: 'report.pdf', data: PDF_BYTES }], random: () => 'fixedrandom' });
    if (!r.ok) throw new Error(r.error);
    expect(r.raw).toMatch(/^Content-Type: multipart\/mixed;\r\n boundary="=_gb_fixedrandom"$/m);
    const parts = receivedParts(r.raw);
    expect(parts.map((p) => p.contentType)).toEqual(['text/plain', 'application/octet-stream', 'application/pdf']);
    expect(parts[1].bytes.equals(ALL_BYTES)).toBe(true);
    expect(parts[2].bytes.equals(PDF_BYTES)).toBe(true);
    expect(parts[2].headers).toMatch(/Content-Disposition: attachment; filename="report.pdf"/);
    // every line of the message is short (base64 at 76) and 7-bit
    for (const line of r.raw.split('\r\n')) expect(line.length, line.slice(0, 40)).toBeLessThanOrEqual(78);
    expect(/^[\x00-\x7f]*$/.test(r.raw)).toBe(true);
    // and the app's own MIME parser reads it back the same way
    const tree = parseMime(Buffer.from(r.raw));
    expect(tree.parts.map((p) => p.filename)).toEqual(['', 'all.bin', 'report.pdf']);
  });

  it('a non-ASCII name: ASCII fallback + RFC 2231 filename*, continued (never splitting %XX) when long', () => {
    expect(filenameParams('report.pdf', 'filename')).toEqual(['filename="report.pdf"']);
    expect(filenameParams('Übersicht.pdf', 'filename')).toEqual(['filename="Ubersicht.pdf"', "filename*=utf-8''%C3%9Cbersicht.pdf"]);
    const long = `${'Größenübersicht für das Quartal — '.repeat(3)}.pdf`;
    const params = filenameParams(sanitizeFilename(long), 'filename');
    expect(params[0]).toMatch(/^filename="[\x20-\x7e]+"$/);
    expect(params.slice(1).every((p, i) => p.startsWith(`filename*${i}*=`))).toBe(true);
    for (const p of params.slice(1)) expect(p.split('=').slice(1).join('=')).not.toMatch(/%[0-9A-F]?$/);
    const r = buildMessage({ from: FROM, to: 'bob@example.org', subject: 's', body: 'b', attachments: [{ filename: long, data: Buffer.from('x') }] });
    if (!r.ok) throw new Error(r.error);
    // an independent reader and the app's own parser both get the original name back
    expect(receivedParts(r.raw)[1].filename).toBe(sanitizeFilename(long));
    expect(parseMime(Buffer.from(r.raw)).parts[1].filename).toBe(sanitizeFilename(long));
    expect(asciiFallbackName('naïve "quote".txt')).toBe('naive _quote_.txt');
  });

  it('the attachment total is capped at 25 MB (bytes, not characters)', () => {
    const big = Buffer.alloc(MAX_COMPOSE_ATTACHMENT_BYTES + 1);
    const r = buildMessage({ from: FROM, to: 'bob@example.org', subject: 's', body: 'b', attachments: [{ filename: 'big.bin', data: big }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/limit is 25 MB/);
    const ok = buildMessage({ from: FROM, to: 'bob@example.org', subject: 's', body: 'b', attachments: [{ filename: 'fits.bin', data: Buffer.alloc(MAX_COMPOSE_ATTACHMENT_BYTES - 1024) }] });
    expect(ok.ok).toBe(true);
  });

  it('a message without attachments is still the plain text/plain one', () => {
    const r = buildMessage({ from: FROM, to: 'bob@example.org', subject: 's', body: 'b' });
    if (!r.ok) throw new Error(r.error);
    expect(r.raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(r.raw).not.toContain('multipart');
  });
});

describe('inline cid: images (41) — rewritten to data: URLs in the SANITIZED document only', () => {
  it('replaces a known cid with its data: image; leaves unknown cids; refuses anything that is not a raster data: URL', () => {
    const png = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const html = '<img src="cid:logo@shop.example"><img src="cid:missing@x"><td background="cid:LOGO@shop.example"></td>';
    const out = inlineCidImages(html, new Map([['logo@shop.example', png]]));
    expect(out).toContain(`<img src="${png}">`);
    expect(out).toContain('src="cid:missing@x"');
    expect(out).toContain(`background="${png}"`);
    expect(inlineCidImages('<img src="cid:a">', new Map([['a', 'https://evil.example/x.png']]))).toBe('<img src="cid:a">');
    expect(inlineCidImages('<img src="cid:a">', new Map([['a', 'data:image/svg+xml;base64,PHN2Zz4=']]))).toBe('<img src="cid:a">');
    expect(inlineCidImages('<img src="cid:a">', new Map([['a', 'data:image/png;base64,AAA" onerror="x']]))).toBe('<img src="cid:a">');
    expect([...referencedCids('<img src="cid:Logo%40Shop.example"><x style="background:url(cid:b)">')]).toEqual(['logo@shop.example', 'b']);
  });
});

// ---------------------------------------------------------------- the controller against the fake servers

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gb-mailatt-'));
const account = { id: 'work', name: 'Ada Lovelace', address: 'ada@example.com', kind: 'imap', host: 'imap.example.com', port: 993, tls: 'implicit', username: 'ada', authKind: 'password', sentFolder: 'Sent', trashFolder: 'Trash', junkFolder: 'Junk', archiveFolder: 'Archive', smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: 'starttls' };

function setup(o: { dir?: string; pick?: () => string[]; confirm?: boolean } = {}) {
  let gate: string | null = null;
  const audits: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  const saved: Array<{ name: string; mime: string; bytes: Buffer; path: string }> = [];
  const confirms: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  const imap = new FakeImapServer({
    user: 'ada',
    password: 'pw',
    folders: [
      { path: 'INBOX', uidValidity: 42, uidNext: 4, messages: [{ uid: 1, flags: [], raw: attachmentsMessage() }, { uid: 2, flags: [], raw: cidMessage() }, { uid: 3, flags: [], raw: 'From: a@example.org\r\nSubject: plain\r\n\r\nno attachments\r\n' }] },
      { path: 'Sent', uidValidity: 7, uidNext: 100, messages: [] },
    ],
  });
  const smtp = new FakeSmtpServer({ user: 'ada', password: 'pw' });
  const dir = o.dir ?? tmp();
  const downloads = join(dir, 'Downloads');
  let picks = o.pick ?? (() => []);
  const ctl = new MailController({
    profileDir: dir,
    canConnect: () => (gate ? { ok: false, reason: gate } : { ok: true }),
    audit: (kind, detail) => audits.push({ kind, detail }),
    sendUnread: () => undefined,
    makeSocket: async () => imap.socket(),
    makeSmtpSocket: async ({ tls }) => smtp.socket({ implicit: tls === 'implicit' }),
    retryBaseMs: 60_000,
    smtpTimeoutMs: 1_000,
    saveDownload: ({ name, mime, bytes }) => {
      const path = join(downloads, `${saved.length}-${name}`);
      saved.push({ name, mime, bytes: Buffer.from(bytes), path });
      return { ok: true, path };
    },
    confirmOpen: async (q) => {
      confirms.push(q);
      return o.confirm ?? false;
    },
    openPath: async (p) => {
      opened.push(p);
      return '';
    },
    pickFiles: async () => picks(),
  });
  return { ctl, imap, smtp, audits, saved, confirms, opened, dir, setGate: (r: string | null) => (gate = r), setPick: (f: () => string[]) => (picks = f) };
}

type S = ReturnType<typeof setup>;
async function ready(s: S) {
  expect(s.ctl.unlock('correct horse battery').ok).toBe(true);
  expect((await s.ctl.saveAccount(account, { password: 'pw' })).ok).toBe(true);
  expect((await s.ctl.sync('work')).ok).toBe(true);
}
const idOf = (s: S, uid: number) => (s.ctl as unknown as { db(): MailStore }).db().byUid('work', 'INBOX', uid)!.id;
const store = (s: S) => (s.ctl as unknown as { db(): MailStore }).db();

describe('receiving (41) — the list comes from BODYSTRUCTURE, the bytes only from a click', () => {
  it('opening a message lists the PDF and the PNG (sections, types, sizes) and fetches NEITHER', async () => {
    const s = setup();
    await ready(s);
    const m = await s.ctl.message(idOf(s, 1));
    if (!m.ok) throw new Error(m.error);
    expect(m.text).toContain('Please find the report attached.');
    expect(m.hasHtml).toBe(true);
    expect(m.attachments).toEqual([
      { partId: '2', name: 'report.pdf', mime: 'application/pdf', size: expect.any(Number), warning: '', executable: false },
      { partId: '3', name: 'chart.png', mime: 'image/png', size: expect.any(Number), warning: '', executable: false },
    ]);
    expect(Math.abs(m.attachments[0].size - PDF_BYTES.length)).toBeLessThan(8);
    // the transcript: a BODYSTRUCTURE, then HEADER + the two text sections — no part 2, no part 3, no BODY[]
    expect(s.imap.sectionFetches.filter((f) => f.uid === 1).map((f) => f.section)).toEqual(['HEADER', 'HEADER', '1.1', '1.2']);
    expect(s.imap.transcript).not.toMatch(/BODY\.PEEK\[(2|3|)\]/);
    expect(store(s).byId(idOf(s, 1))!.hasAttachments).toBe(true);
  });

  it('Download: UID FETCH n BODY.PEEK[section], decoded as bytes, handed to the download path, audited without content', async () => {
    const s = setup();
    await ready(s);
    const id = idOf(s, 1);
    await s.ctl.message(id);
    const r = await s.ctl.downloadAttachment(id, '2');
    expect(r).toMatchObject({ ok: true, name: 'report.pdf', bytes: PDF_BYTES.length });
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].bytes.equals(PDF_BYTES)).toBe(true);
    expect(s.saved[0].mime).toBe('application/pdf');
    expect(s.imap.transcript).toMatch(/EXAMINE INBOX\r\nA\d+ UID FETCH 1 \(BODY\.PEEK\[2\]\)\r\n/);
    const ev = s.audits.find((a) => a.detail.action === 'attachment-download')!.detail;
    expect(ev).toEqual({ action: 'attachment-download', account: 'work', message: id, part: '2', bytes: PDF_BYTES.length, mime: 'application/pdf', name: 'report.pdf', result: 'saved' });
    expect(JSON.stringify(s.audits)).not.toContain(PDF_BYTES.toString('base64').slice(0, 40));
    // a second part, and a part that does not exist
    expect((await s.ctl.downloadAttachment(id, '3')).ok).toBe(true);
    expect(s.saved[1].bytes.equals(PNG_BYTES)).toBe(true);
    expect(await s.ctl.downloadAttachment(id, '9')).toMatchObject({ ok: false, error: expect.stringMatching(/no such attachment/) });
  });

  it('a download during an agent task is REFUSED with the reason, and nothing reaches the server', async () => {
    const s = setup();
    await ready(s);
    const id = idOf(s, 1);
    await s.ctl.message(id);
    s.setGate('an agent task is running');
    const before = s.imap.transcript;
    const r = await s.ctl.downloadAttachment(id, '2');
    expect(r).toMatchObject({ ok: false, refused: true, error: 'attachments are not downloaded while an agent task is running' });
    expect(s.imap.transcript).toBe(before);
    expect(s.saved).toHaveLength(0);
    expect(s.audits.find((a) => a.detail.action === 'attachment-download')!.detail.result).toBe('refused');
  });

  it('a part declared larger than 50 MB is refused BEFORE it is fetched', async () => {
    const s = setup();
    await ready(s);
    const id = idOf(s, 1);
    await s.ctl.message(id);
    const atts = store(s).body(id)!.attachments.map((a) => (a.partId === '2' ? { ...a, size: MAX_ATTACHMENT_BYTES + 1 } : a));
    store(s).setAttachments(id, atts);
    const before = s.imap.transcript;
    const r = await s.ctl.downloadAttachment(id, '2');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/larger than 50 MB are not downloaded/);
    expect(s.imap.transcript).toBe(before);
  });

  it('Open: never without main\'s confirmation; the dialog names file and type; executables are flagged; refused during a task', async () => {
    const s = setup({ confirm: false });
    await ready(s);
    const id = idOf(s, 1);
    await s.ctl.message(id);
    expect(await s.ctl.openAttachment(id, '2')).toMatchObject({ ok: false, cancelled: true });
    expect(s.confirms[0]).toEqual({ name: '0-report.pdf', mime: 'application/pdf', warning: '', executable: false });
    expect(s.opened).toEqual([]);
    // an executable disguised as a document
    const atts = store(s).body(id)!.attachments.map((a) => (a.partId === '3' ? { ...a, filename: 'invoice.pdf.exe', mime: 'application/octet-stream' } : a));
    store(s).setAttachments(id, atts);
    const m = await s.ctl.message(id);
    if (!m.ok) throw new Error('open');
    expect(m.attachments[1]).toMatchObject({ name: 'invoice.pdf.exe', executable: true, warning: expect.stringMatching(/disguised/) });
    await s.ctl.openAttachment(id, '3');
    expect(s.confirms.at(-1)).toMatchObject({ executable: true, warning: expect.stringMatching(/disguised/) });
    s.setGate('an agent task is running');
    expect(await s.ctl.openAttachment(id, '2')).toMatchObject({ ok: false, refused: true });
    expect(s.confirms).toHaveLength(2);

    const yes = setup({ confirm: true });
    await ready(yes);
    const id2 = idOf(yes, 1);
    await yes.ctl.message(id2);
    expect((await yes.ctl.openAttachment(id2, '2')).ok).toBe(true);
    expect(yes.opened).toEqual([yes.saved[0].path]);
    expect(yes.audits.find((a) => a.detail.action === 'attachment-open')!.detail).toMatchObject({ result: 'confirmed', name: '0-report.pdf' });
  });

  it('inline cid: images: not listed; fetched (gated) as sniffed data: URLs; an SVG cid never becomes an image', async () => {
    const s = setup();
    await ready(s);
    const id = idOf(s, 2);
    const m = await s.ctl.message(id);
    if (!m.ok) throw new Error('open');
    // the PNG is inline (referenced by cid:) — the SVG is not a renderable image, so it is listed
    expect(m.attachments.map((a) => a.mime)).toEqual(['image/svg+xml']);
    expect(store(s).body(id)!.attachments.find((a) => a.mime === 'image/png')).toMatchObject({ inline: true, contentId: 'logo@shop.example' });
    expect(s.imap.sectionFetches.filter((f) => f.uid === 2).map((f) => f.section)).toEqual(['HEADER', 'HEADER', '1']);

    s.setGate('an agent task is running');
    const before = s.imap.transcript;
    expect((await s.ctl.inlineImages(id)).size).toBe(0);
    expect(s.imap.transcript).toBe(before);
    s.setGate(null);
    const imgs = await s.ctl.inlineImages(id);
    expect([...imgs.keys()]).toEqual(['logo@shop.example']);
    expect(imgs.get('logo@shop.example')).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);
    // cached: a redisplay fetches nothing
    const after = s.imap.transcript;
    await s.ctl.inlineImages(id);
    expect(s.imap.transcript).toBe(after);
  });
});

describe('sending (41) — Attach… copies into the draft\'s private directory; the copies are what is sent', () => {
  const draft = (o: Record<string, unknown> = {}) => ({ accountId: 'work', mode: 'new', to: 'bob@example.org', cc: '', bcc: '', subject: 'with a file', body: 'see attached', ...o });

  it('the file is copied (dir 0700, file 0600); editing the original afterwards does not change what is sent; sending removes the copy', async () => {
    const src = join(tmp(), 'numbers.bin');
    writeFileSync(src, ALL_BYTES);
    const s = setup({ pick: () => [src] });
    await ready(s);
    const r = await s.ctl.attachPick(draft());
    expect(r).toMatchObject({ ok: true, attachments: [{ name: 'numbers.bin', size: 256, mime: 'application/octet-stream', warning: '' }] });
    const dir = join(s.dir, OUTBOX_DIR, r.draftId!);
    expect(statSync(join(s.dir, OUTBOX_DIR)).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
    // the original changes after it was attached
    writeFileSync(src, Buffer.from('CHANGED'));
    const sent = await s.ctl.send(draft({ draftId: r.draftId }));
    expect(sent).toMatchObject({ ok: true });
    const parts = receivedParts(s.smtp.received[0].data.toString('latin1'));
    expect(parts.map((p) => p.filename)).toEqual(['', 'numbers.bin']);
    expect(parts[1].bytes.equals(ALL_BYTES)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(s.audits.find((a) => a.detail.action === 'attachment-add')!.detail).toEqual({ action: 'attachment-add', files: 1, bytes: 256, refused: 0 });
  });

  it('a Send refused during a task queues the COMPLETE message in the Outbox (attachment included); after a restart Retry sends the same bytes', async () => {
    const src = join(tmp(), 'table.csv');
    writeFileSync(src, 'a,b\r\n1,2\r\n');
    const a = setup({ pick: () => [src] });
    await ready(a);
    const r = await a.ctl.attachPick(draft({ subject: 'queued with a file' }));
    a.setGate('an agent task is running');
    const q = await a.ctl.send(draft({ draftId: r.draftId, subject: 'queued with a file' }));
    expect(q).toMatchObject({ ok: false, queued: true });
    expect(a.smtp.connections).toBe(0);
    // the Outbox holds the built message, so the draft and its private copy are gone
    expect(existsSync(join(a.dir, OUTBOX_DIR, r.draftId!))).toBe(false);
    writeFileSync(src, 'changed after queueing');
    a.ctl.dispose();

    const b = setup({ dir: a.dir });
    expect(b.ctl.unlock('correct horse battery').ok).toBe(true);
    expect((await b.ctl.retry(q.outboxId)).ok).toBe(true);
    const parts = receivedParts(b.smtp.received[0].data.toString('latin1'));
    expect(parts[1]).toMatchObject({ filename: 'table.csv', contentType: 'text/csv' });
    expect(parts[1].bytes.toString()).toBe('a,b\r\n1,2\r\n');
  });

  it('a restart keeps the attachment; Remove deletes the copy; Discard deletes the directory', async () => {
    const src = join(tmp(), 'plan.pdf');
    writeFileSync(src, PDF_BYTES);
    const a = setup({ pick: () => [src] });
    await ready(a);
    const r = await a.ctl.attachPick(draft({ subject: 'kept' }));
    a.ctl.dispose();

    const b = setup({ dir: a.dir, pick: () => [src] });
    expect(b.ctl.unlock('correct horse battery').ok).toBe(true);
    const got = b.ctl.draftGet(r.draftId);
    if (!got.ok) throw new Error('draft');
    expect(got.attachments.map((x) => x.name)).toEqual(['plan.pdf']);
    const second = await b.ctl.attachPick(draft({ draftId: r.draftId, subject: 'kept' }));
    expect(second.attachments).toHaveLength(2);
    const rm = b.ctl.attachRemove(r.draftId, second.attachments![1].id);
    expect(rm).toMatchObject({ ok: true, attachments: [{ name: 'plan.pdf' }] });
    expect(readdirSync(join(b.dir, OUTBOX_DIR, r.draftId!))).toHaveLength(1);
    // ids that are not this draft's attachment (or not ids at all) touch nothing
    expect(b.ctl.attachRemove('../../etc', 'x').ok).toBe(false);
    expect(b.ctl.attachRemove(r.draftId, '../plan').ok).toBe(false);
    b.ctl.draftDelete(r.draftId);
    expect(existsSync(join(b.dir, OUTBOX_DIR, r.draftId!))).toBe(false);
  });

  it('the 25 MB total is enforced at attach time; a directory or a missing file is refused; the renderer cannot name a path', async () => {
    const d = tmp();
    const big = join(d, 'big.bin');
    writeFileSync(big, Buffer.alloc(MAX_COMPOSE_ATTACHMENT_BYTES + 1));
    const s = setup({ pick: () => [big, d, join(d, 'missing.txt')] });
    await ready(s);
    // a `path` field in what the renderer sends is simply not read
    const r = await s.ctl.attachPick({ ...draft(), path: '/etc/passwd', files: ['/etc/passwd'] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/would take the attachments over 25 MB/);
    expect(r.error).toMatch(/not a regular file/);
    expect(r.error).toMatch(/could not be read/);
    expect(r.attachments).toEqual([]);
  });

  it('Forward carries the original\'s attachments, fetched at SEND time through the gate; unticked, it carries none', async () => {
    const s = setup();
    await ready(s);
    const id = idOf(s, 1);
    await s.ctl.message(id);
    const init = s.ctl.composeInit('forward', id);
    if (!init.ok) throw new Error('init');
    expect(init.originalAttachments.map((a) => a.name)).toEqual(['report.pdf', 'chart.png']);
    const before = s.imap.sectionFetches.length;

    // during a task: refused, NOT queued, and no IMAP traffic
    s.setGate('an agent task is running');
    const t0 = s.imap.transcript;
    const refused = await s.ctl.send({ ...init, to: 'carol@example.net' });
    expect(refused).toMatchObject({ ok: false, refused: expect.stringMatching(/agent task/) });
    expect(s.ctl.outbox().items).toHaveLength(0);
    expect(s.imap.transcript).toBe(t0);
    s.setGate(null);

    const sent = await s.ctl.send({ ...init, to: 'carol@example.net' });
    expect(sent).toMatchObject({ ok: true });
    expect(s.imap.sectionFetches.slice(before).filter((f) => f.uid === 1).map((f) => f.section)).toEqual(['2', '3']);
    const parts = receivedParts(s.smtp.received[0].data.toString('latin1'));
    expect(parts.map((p) => p.filename)).toEqual(['', 'report.pdf', 'chart.png']);
    expect(parts[1].bytes.equals(PDF_BYTES)).toBe(true);
    expect(parts[2].bytes.equals(PNG_BYTES)).toBe(true);

    const without = await s.ctl.send({ ...init, to: 'carol@example.net', forwardAttachments: false });
    expect(without.ok).toBe(true);
    expect(s.smtp.received[1].data.toString('latin1')).not.toContain('multipart/mixed');
  });
});

// ---------------------------------------------------------------- isolation

const ROOT = join(__dirname, '..', '..');

function importsOf(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
    const base = resolve(dirname(join(ROOT, file)), m[1]);
    for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(cand)) {
        out.push(cand.slice(ROOT.length + 1));
        break;
      }
    }
  }
  return out;
}

describe('isolation (41) — attachments never reach a model or the agent\'s tools; a tab cannot call the channels', () => {
  it('the agent side reaches neither the attachment code nor the downloads list, transitively', () => {
    const agentSide = ['src/core/agent.ts', 'src/core/planner.ts', 'src/core/reader.ts', 'src/core/judge.ts', 'src/core/policy.ts', 'src/core/taint.ts', 'src/core/llm.ts', 'src/main/tabs.ts', 'src/main/tab-preload.ts', 'src/main/tab-guard.ts', 'src/main/page-scripts.ts'];
    const seen = new Set<string>();
    const stack = [...agentSide];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      stack.push(...importsOf(f));
    }
    expect(seen.size).toBeGreaterThan(agentSide.length);
    for (const f of ['src/core/mail/attachments.ts', 'src/core/downloads.ts', 'src/main/mail/controller.ts', 'src/main/mail/html-view.ts']) expect(seen.has(f), f).toBe(false);
  });

  it('no planner tool or prompt can name an attachment, a download or a file', () => {
    expect(JSON.stringify(PLANNER_TOOLS)).not.toMatch(/attach|download|mail/i);
  });

  it('the new channels are mail channels (sender-resolved, request/response) registered only on the chrome table', () => {
    const fresh = ['mail:attachment-download', 'mail:attachment-open', 'mail:attach-pick', 'mail:attach-remove'];
    for (const ch of fresh) {
      expect(MAIL_CHANNELS as readonly string[]).toContain(ch);
      expect(EVENT_CHANNELS as readonly string[]).not.toContain(ch);
    }
    const runtimeDir = join(ROOT, 'src/main/runtime');
    for (const ch of fresh) {
      const registering = readdirSync(runtimeDir).filter((f) => readFileSync(join(runtimeDir, f), 'utf8').includes(`on('${ch}'`));
      expect(registering, ch).toEqual(['ipc-mail.ts']);
    }
    const tabPreload = readFileSync(join(ROOT, 'src/main/tab-preload.ts'), 'utf8');
    expect(tabPreload).not.toMatch(/mail:|attach|download/);
  });

  it('the renderer never supplies a file path or bytes for an attachment: Attach is a request for MAIN\'s dialog', () => {
    const panel = readFileSync(join(ROOT, 'src/renderer/mail-panel.ts'), 'utf8');
    const call = /invoke\('mail:attach-pick',\s*(.*?)\);/.exec(panel)?.[1] ?? '';
    expect(call.trim()).toBe('composeFields()');
    expect(panel).not.toMatch(/FileReader|\.files\b|dataTransfer|webkitRelativePath|type="file"/);
    expect(readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8')).not.toMatch(/type="file"/);
    // and main's handler takes the compose fields only
    const ipc = readFileSync(join(ROOT, 'src/main/runtime/ipc-mail.ts'), 'utf8');
    expect(ipc).toMatch(/on\('mail:attach-pick', \(_e, draft: unknown\) => mailCtrl\(\)\.attachPick\(draft\)\)/);
  });

  it('the dialog test seam is a test hook: honoured only with GUARDED_TEST=1 in an unpackaged build', () => {
    const hooks = readFileSync(join(ROOT, 'src/main/test-hooks.ts'), 'utf8');
    expect(hooks).toMatch(/TEST_MODE = process\.env\.GUARDED_TEST === '1' && !app\.isPackaged/);
    expect(hooks).toContain("'GUARDED_TEST_ATTACH_FILE'");
    const rt = readFileSync(join(ROOT, 'src/main/runtime.ts'), 'utf8');
    expect(rt).toContain("testEnv('GUARDED_TEST_ATTACH_FILE')");
    expect(rt).not.toMatch(/process\.env\.GUARDED_TEST_ATTACH_FILE/);
  });
});

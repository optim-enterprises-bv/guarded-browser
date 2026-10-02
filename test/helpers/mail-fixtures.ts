// Messages with attachments for the ticket-41 tests (unit and e2e), and an INDEPENDENT reader for what
// the fake SMTP server received: it does not use src/core/mail (a reader that shares the writer's code
// would agree with the writer's bugs).

import { solidPng } from './png';

/** a "PDF" whose body holds every byte value 0..255, so any char-vs-byte mistake changes it */
export const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('\n%%EOF\n')]);
/** a solid green 16x16 PNG */
export const PNG_BYTES = solidPng(0, 200, 0);

/** base64 in 76-character lines, as a real mailer writes it */
export const b64 = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n');

/** text + html (multipart/alternative) inside multipart/mixed, then a PDF and a PNG attachment */
export function attachmentsMessage(opts: { messageId?: string; subject?: string } = {}): string {
  return [
    'From: Bob <bob@example.org>',
    'To: ada@example.com',
    `Subject: ${opts.subject ?? 'Report and chart'}`,
    `Message-ID: <${opts.messageId ?? 'att-1@example.org'}>`,
    'Date: Thu, 01 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer-b"',
    '',
    'This is a multi-part message in MIME format.',
    '--outer-b',
    'Content-Type: multipart/alternative; boundary="alt-b"',
    '',
    '--alt-b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find the report attached.',
    '--alt-b',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Please find the <b>report</b> attached.</p>',
    '--alt-b--',
    '',
    '--outer-b',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF_BYTES),
    '--outer-b',
    'Content-Type: image/png; name="chart.png"',
    'Content-Disposition: attachment; filename="chart.png"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PNG_BYTES),
    '--outer-b--',
    '',
  ].join('\r\n');
}

/** an HTML body showing a cid: image (multipart/related), plus an SVG the HTML also references */
export function cidMessage(): string {
  return [
    'From: Shop <news@shop.example>',
    'To: ada@example.com',
    'Subject: Inline logo',
    'Message-ID: <cid-1@shop.example>',
    'Date: Thu, 01 Oct 2026 11:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="rel-b"; type="text/html"',
    '',
    '--rel-b',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>Logo below</p><img src="cid:logo@shop.example" width="240" height="240"><img src="cid:vector@shop.example"></body></html>',
    '--rel-b',
    'Content-Type: image/png',
    'Content-ID: <logo@shop.example>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PNG_BYTES),
    '--rel-b',
    'Content-Type: image/svg+xml',
    'Content-ID: <vector@shop.example>',
    'Content-Disposition: inline',
    '',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '--rel-b--',
    '',
  ].join('\r\n');
}

export interface ReceivedPart {
  headers: string;
  /** the Content-Disposition filename, RFC 2231 continuations joined and %-decoded as UTF-8 */
  filename: string;
  contentType: string;
  /** the decoded body (base64 only; anything else is returned as its bytes) */
  bytes: Buffer;
}

/** Split a received message's top-level multipart and decode each part. Independent of src/. */
export function receivedParts(raw: string): ReceivedPart[] {
  const sep = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, sep).replace(/\r\n[ \t]+/g, ' ');
  const boundary = /boundary="([^"]+)"/i.exec(head)?.[1];
  if (!boundary) return [];
  const body = raw.slice(sep + 4);
  const chunks = body.split(`--${boundary}`).slice(1);
  const out: ReceivedPart[] = [];
  for (const c of chunks) {
    if (c.startsWith('--')) break;
    const part = c.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const i = part.indexOf('\r\n\r\n');
    const headers = part.slice(0, i).replace(/\r\n[ \t]+/g, ' ');
    const content = part.slice(i + 4);
    const segs = [...headers.matchAll(/filename\*(\d+)\*?=([^;\s]+)/gi)].sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[2]);
    const single = /filename\*=([^;\s]+)/i.exec(headers)?.[1];
    const plain = /filename="([^"]*)"/i.exec(headers)?.[1] ?? '';
    const ext = segs.length ? segs.join('') : single;
    const filename = ext ? decodeURIComponent(ext.replace(/^utf-8''/i, '')) : plain;
    const contentType = /content-type:\s*([^;\s]+)/i.exec(headers)?.[1]?.toLowerCase() ?? '';
    const bytes = /content-transfer-encoding:\s*base64/i.test(headers) ? Buffer.from(content.replace(/\s+/g, ''), 'base64') : Buffer.from(content, 'latin1');
    out.push({ headers, filename, contentType, bytes });
  }
  return out;
}

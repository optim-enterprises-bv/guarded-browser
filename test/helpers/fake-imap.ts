// Fake IMAP server for tests (ticket 36's fixtures).
//
// The mail program is tested WITHOUT a network: this object owns the socket side of an ImapClient, so
// a test can drive a scripted server (or, in ticket 37's e2e, the real client) with no port, no TLS
// and no DNS. It is deliberately dumb — it answers the commands the client sends, with literals
// split across chunks when the test asks for it, which is what makes the incremental parser's
// boundary handling testable.
//
// It also acts as an ATTACKER: `literalOf()` lets a test have the server claim a 4 GB literal, send a
// malformed FETCH, or drop the connection mid-command, because a mail server is an untrusted peer.

import type { ImapSocket } from '../../src/core/mail/imap';

export interface FakeFolder {
  path: string;
  uidValidity: number;
  uidNext: number;
  /** `bytes`, when set, is what the server sends instead of `raw` as UTF-8 (e.g. a latin1 body) */
  messages: Array<{ uid: number; flags: string[]; raw: string; bytes?: Buffer }>;
}

export interface FakeServerOptions {
  greeting?: string;
  capabilities?: string[];
  user?: string;
  password?: string;
  folders?: FakeFolder[];
  /** return NO on LOGIN / AUTHENTICATE regardless of the credentials */
  refuseAuth?: boolean;
  /** advertise IDLE and send unsolicited EXISTS when `pushExists()` is called */
  idle?: boolean;
  /** split every server write into chunks of this many BYTES (a UTF-8 character can be cut in two) */
  chunkSize?: number;
  /** emit a BYE right after the greeting */
  byeAfterGreeting?: boolean;
  /** answer MOVE / COPY without the UIDPLUS COPYUID code */
  noCopyUid?: boolean;
}

export class FakeImapServer {
  readonly log: string[] = [];
  private dataCb: ((c: Buffer) => void) | null = null;
  private closeCb: ((e?: Error) => void) | null = null;
  private closed = false;
  private idle = false;
  private idleTag: string | null = null;
  readonly folders: FakeFolder[];
  literals = 0;
  /** the folder the last SELECT / EXAMINE opened; a fetch answers from here */
  selected: FakeFolder | null = null;
  /** true when the folder was opened with EXAMINE: a real server refuses STORE / MOVE / EXPUNGE then */
  selectedReadOnly = false;
  /** set by tests: the next `{N}` literal is announced with this size instead of the real one */
  lieAboutLiteralSize: number | null = null;
  /** every BAD the server sent (a protocol violation by the client), for a test to assert is empty */
  readonly bad: string[] = [];
  /** the literals and SASL responses the client sent, decoded */
  readonly received: string[] = [];
  /** every BODY[section] the server answered, in order ('' = the whole message, 'HEADER', '2', '1.2' ...) */
  readonly sectionFetches: Array<{ uid: number; section: string }> = [];
  /** how many FETCH responses carried a BODYSTRUCTURE */
  structureFetches = 0;

  constructor(private readonly opts: FakeServerOptions = {}) {
    this.folders = opts.folders ?? [
      {
        path: 'INBOX',
        uidValidity: 42,
        uidNext: 3,
        messages: [
          { uid: 1, flags: [], raw: 'Subject: hello\r\nFrom: a@b.c\r\n\r\nbody one\r\n' },
          { uid: 2, flags: ['\\Seen'], raw: 'Subject: two\r\nFrom: d@e.f\r\n\r\nbody two\r\n' },
        ],
      },
      { path: 'Sent', uidValidity: 7, uidNext: 100, messages: [] },
    ];
  }

  /** The SocketFactory the real client uses: `new ImapClient(server.socket(), 5000)`. */
  socket(): ImapSocket {
    const self = this;
    let greeted = false;
    // a dropped connection is per-connection: a real server keeps accepting new ones
    this.closed = false;
    this.inbuf = Buffer.alloc(0);
    this.state = { kind: 'line', prefix: '', literal: null };
    return {
      write: (d: string) => self.receive(d),
      onData: (cb) => {
        this.dataCb = cb;
        // a real server greets on connect, so the fake one does too (once per socket)
        if (!greeted) {
          greeted = true;
          const greeting =
            this.opts.greeting ??
            `* OK [CAPABILITY ${(this.opts.capabilities ?? ['IMAP4rev1', 'UIDPLUS', 'MOVE', ...(this.opts.idle ? ['IDLE'] : [])]).join(' ')}] Fake IMAP ready\r\n`;
          queueMicrotask(() => {
            this.push(greeting);
            if (this.opts.byeAfterGreeting) setTimeout(() => this.push('* BYE going away\r\n'), 0);
          });
        }
      },
      onClose: (cb) => {
        this.closeCb = cb;
      },
      end: () => this.drop(),
    };
  }

  /** Push raw text (or bytes) to the client (used by tests to inject malformed data). */
  push(text: string | Buffer) {
    if (this.closed) return;
    const b = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
    const n = this.opts.chunkSize ?? 0;
    if (n > 0) for (let i = 0; i < b.length; i += n) this.dataCb?.(b.subarray(i, i + n));
    else this.dataCb?.(b);
  }

  /** Simulate the server dropping the connection. */
  drop(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.(err);
  }

  /** Unsolicited EXISTS, the IDLE push a user actually sees as "new mail". */
  pushExists(n: number) {
    this.push(`* ${n} EXISTS\r\n`);
  }

  pushFetch(seq: number, uid: number) {
    this.push(`* ${seq} FETCH (UID ${uid} FLAGS (\\Seen))\r\n`);
  }

  // ------------------------------------------------------------ command handling

  // The command reader is a byte stream, and it is STRICT about RFC 3501 literals, because a real
  // server is: a `{N}` (synchronizing) literal may only be sent after the server's `+` continuation,
  // `{N+}` only when LITERAL+ is advertised, and the command line must END (CRLF) after the literal.
  // An earlier fake accepted `TAG CMD {N}\r\n<literal>` in one write with no CRLF — the shape that
  // hangs AUTHENTICATE and APPEND on Dovecot/Gmail — so the client shipped with exactly that bug.
  private inbuf: Buffer = Buffer.alloc(0);
  private state:
    | { kind: 'line'; prefix: string; literal: string | null; afterLiteral?: boolean }
    | { kind: 'literal'; prefix: string; size: number }
    | { kind: 'sasl'; tag: string; mech: string } = { kind: 'line', prefix: '', literal: null };
  private processing = false;

  private receive(chunk: string) {
    this.log.push(chunk);
    this.inbuf = Buffer.concat([this.inbuf, Buffer.from(chunk, 'utf8')]);
    // re-entrancy: a `+` we push makes the client write synchronously; the loop below picks it up
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.closed && this.step());
    } finally {
      this.processing = false;
    }
  }

  private caps(): string[] {
    return this.opts.capabilities ?? ['IMAP4rev1', 'UIDPLUS', 'MOVE', ...(this.opts.idle ? ['IDLE'] : [])];
  }

  private reject(tag: string, why: string) {
    this.bad.push(why);
    this.inbuf = Buffer.alloc(0);
    this.state = { kind: 'line', prefix: '', literal: null };
    this.push(`${tag} BAD ${why}\r\n`);
  }

  /** consume one unit (a line, a literal, a SASL response); false when more bytes are needed */
  private step(): boolean {
    const st = this.state;
    if (st.kind === 'literal') {
      if (this.inbuf.length < st.size) return false;
      const lit = this.inbuf.subarray(0, st.size).toString('utf8');
      this.inbuf = this.inbuf.subarray(st.size);
      this.received.push(lit);
      this.state = { kind: 'line', prefix: st.prefix, literal: lit, afterLiteral: true };
      return true;
    }
    if (st.kind === 'line' && st.afterLiteral) {
      if (!this.inbuf.length) return false;
      // after a literal the command line continues: CRLF ends it, SP starts another argument; anything
      // else (typically the NEXT command's tag) means the client never terminated the line
      const c = this.inbuf[0];
      if (c !== 0x0d && c !== 0x20) {
        this.reject(st.prefix.split(' ')[0] || '*', 'the command line was not terminated with CRLF after the literal');
        return true;
      }
      this.state = { ...st, afterLiteral: false };
    }
    const nl = this.inbuf.indexOf('\r\n');
    if (nl < 0) return false;
    const line = this.inbuf.subarray(0, nl).toString('utf8');
    this.inbuf = this.inbuf.subarray(nl + 2);

    if (st.kind === 'sasl') {
      this.state = { kind: 'line', prefix: '', literal: null };
      this.received.push(line);
      this.finishAuth(st.tag, st.mech, line);
      return true;
    }
    const full = st.prefix + line;
    const m = /\{(\d+)(\+?)\}$/.exec(line);
    if (m) {
      const tag = full.split(' ')[0] || '*';
      const size = Number(m[1]);
      const prefix = full.slice(0, full.length - m[0].length);
      if (m[2] === '+') {
        if (!this.caps().includes('LITERAL+')) {
          this.reject(tag, 'non-synchronizing literal without LITERAL+');
          return true;
        }
      } else {
        // the client must WAIT for the continuation: bytes already queued behind `{N}` were sent early
        if (this.inbuf.length) {
          this.reject(tag, 'literal data sent before the continuation request');
          return true;
        }
      }
      this.state = { kind: 'literal', prefix, size };
      if (m[2] !== '+') this.push('+ Ready for literal data\r\n');
      return true;
    }
    const literal = st.kind === 'line' ? st.literal : null;
    this.state = { kind: 'line', prefix: '', literal: null };
    if (!full) return true;
    this.handle(full, literal ?? '', '');
    return true;
  }

  private finishAuth(tag: string, mech: string, b64: string) {
    if (b64 === '*') return this.no(tag, 'AUTHENTICATE cancelled'); // RFC 3501 cancellation
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return this.reject(tag, 'the SASL response is not base64');
    if (this.opts.refuseAuth) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
    const dec = Buffer.from(b64, 'base64').toString('utf8');
    if (mech === 'PLAIN') {
      const [, user, pass] = dec.split('\u0000');
      if (this.opts.user && user !== this.opts.user) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      if (this.opts.password && pass !== this.opts.password) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
    } else if (this.opts.user && !dec.startsWith(`user=${this.opts.user}\u0001`)) {
      return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
    }
    return this.ok(tag, 'AUTHENTICATE completed');
  }

  private handle(line: string, literal: string, rest: string) {
    // DONE is the one command with NO tag (it ends an IDLE); splitting a tag off it first left
    // `cmd === ''` and the fake server silently never answered, so an idle() sat until its timeout
    if (line.trim().toUpperCase() === 'DONE') {
      this.idle = false;
      const t = this.idleTag ?? '*';
      this.idleTag = null;
      return this.ok(t, 'IDLE terminated');
    }
    const tag = line.split(/\s+/)[0] ?? '*';
    const cmd = line.slice(tag.length).trim();
    const upper = cmd.toUpperCase();
    const caps = this.caps();

    if (upper.startsWith('CAPABILITY')) return this.ok(tag, 'CAPABILITY completed', [`* CAPABILITY ${caps.join(' ')}\r\n`]);
    if (upper.startsWith('LOGIN')) {
      if (this.opts.refuseAuth) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      if (this.opts.user && !cmd.includes(this.opts.user)) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      if (this.opts.password && !cmd.includes(this.opts.password)) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      return this.ok(tag, 'LOGIN completed');
    }
    if (upper.startsWith('AUTHENTICATE')) {
      // RFC 3501: the SASL response is a base64 LINE after `+`, never a literal; an initial response
      // on the command line is only legal with SASL-IR (RFC 4959)
      if (literal) return this.reject(tag, 'AUTHENTICATE does not take a literal');
      const [, mech = '', initial] = cmd.split(/\s+/);
      const MECH = mech.toUpperCase();
      if (!caps.includes(`AUTH=${MECH}`)) return this.no(tag, `unsupported mechanism ${MECH}`);
      if (initial !== undefined) {
        if (!caps.includes('SASL-IR')) return this.reject(tag, 'initial response without SASL-IR');
        this.received.push(initial);
        return this.finishAuth(tag, MECH, initial === '=' ? '' : initial);
      }
      this.state = { kind: 'sasl', tag, mech: MECH };
      this.push('+ \r\n');
      return;
    }
    if (upper.startsWith('LIST')) {
      const lines = this.folders.map((f) => `* LIST (\\HasNoChildren) "/" "${f.path}"\r\n`);
      return this.ok(tag, 'LIST completed', lines);
    }
    if (upper.startsWith('SELECT') || upper.startsWith('EXAMINE')) {
      const path = /"([^"]*)"|(\S+)$/.exec(cmd)?.[1] ?? cmd.split(/\s+/).pop() ?? 'INBOX';
      const f = this.folders.find((x) => x.path === path);
      if (!f) return this.no(tag, `[NONEXISTENT] mailbox ${path}`);
      this.selected = f;
      this.selectedReadOnly = upper.startsWith('EXAMINE');
      const lines = [
        `* ${f.messages.length} EXISTS\r\n`,
        `* 0 RECENT\r\n`,
        `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n`,
        `* OK [UIDVALIDITY ${f.uidValidity}]\r\n`,
        `* OK [UIDNEXT ${f.uidNext}]\r\n`,
        `* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)]\r\n`,
      ];
      return this.ok(tag, `${upper.startsWith('EXAMINE') ? 'EXAMINE' : 'SELECT'} completed`, lines);
    }
    if (upper.startsWith('UID SEARCH')) {
      const f = this.selected ?? this.folders.find((x) => x.messages.length) ?? this.folders[0];
      // honour the range: a server that ignores it makes an incremental sync fetch everything
      const range = cmd.split(/\s+/).pop() ?? '1:*';
      const lo = /^(\d+):/.exec(range);
      const from = lo ? Number(lo[1]) : 1;
      const uids = f.messages.map((m) => m.uid).filter((u) => u >= from);
      return this.ok(tag, 'SEARCH completed', [`* SEARCH ${uids.join(' ')}\r\n`]);
    }
    if (upper.startsWith('UID FETCH')) return this.uidFetch(tag, cmd);
    if (this.selectedReadOnly && /^(UID STORE|UID MOVE|EXPUNGE)/.test(upper)) return this.no(tag, '[READ-ONLY] the mailbox was opened with EXAMINE');
    if (upper.startsWith('UID STORE')) {
      const flags = /\(([^)]*)\)/.exec(cmd)?.[1] ?? '';
      this.uidStore(cmd, flags, upper.includes('+FLAGS') ? 'add' : upper.includes('-FLAGS') ? 'remove' : 'set');
      return this.ok(tag, 'STORE completed');
    }
    if (upper.startsWith('UID MOVE') || upper.startsWith('UID COPY')) {
      const parts = cmd.split(/\s+/);
      const uids = parts[2];
      const target = parts.slice(3).join(' ').replace(/"/g, '');
      const f = this.folders.find((x) => x.path === target);
      const moved = (uids?.split(',').map(Number) ?? []).filter((n) => Number.isInteger(n) && n > 0);
      if (f) {
        for (const u of moved) {
          f.messages.push({ uid: f.uidNext++, flags: [], raw: `Subject: moved ${u}\r\n\r\n` });
        }
      }
      const newUids = moved.map((_, i) => (f?.uidNext ?? 1) - moved.length + i).join(',');
      const detail = this.opts.noCopyUid ? '' : `[COPYUID 42 ${uids} ${newUids}]`;
      if (upper.startsWith('UID MOVE')) {
        // remove from the source
        for (const folder of this.folders) folder.messages = folder.messages.filter((m) => !moved.includes(m.uid) || folder.path === target);
        return this.ok(tag, `MOVE completed ${detail}`);
      }
      return this.ok(tag, `COPY completed ${detail}`);
    }
    if (upper.startsWith('EXPUNGE')) return this.ok(tag, 'EXPUNGE completed');
    if (upper.startsWith('APPEND')) {
      const f = this.folders.find((x) => x.path === (cmd.split(/\s+/)[1] ?? '').replace(/"/g, ''));
      const uid = f ? f.uidNext++ : null;
      if (f) f.messages.push({ uid: uid!, flags: [], raw: literal });
      return uid ? this.ok(tag, `APPEND completed [APPENDUID 42 ${uid}]`) : this.ok(tag, 'APPEND completed');
    }
    if (upper.startsWith('IDLE')) {
      this.idle = true;
      this.idleTag = tag;
      this.push('+ idling\r\n');
      return;
    }
    if (upper.startsWith('LOGOUT')) {
      this.push(`* BYE logging out\r\n`);
      const t = tag;
      this.ok(t, 'LOGOUT completed');
      setTimeout(() => this.drop(), 0);
      return;
    }
    if (upper === 'DONE') {
      this.idle = false;
      const t = this.idleTag ?? tag;
      this.idleTag = null;
      return this.ok(t, 'IDLE terminated');
    }
    return this.no(tag, `unknown command: ${cmd.split(/\s+/)[0]}`);
  }

  private uidFetch(tag: string, cmd: string) {
    // the SELECTED folder, not the first non-empty one: answering a fetch from another folder is how
    // a sync silently stores the wrong messages
    const folder = this.selected ?? this.folders.find((f) => f.messages.length) ?? this.folders[0];
    const range = cmd.split(/\s+/)[2] ?? '1:*';
    const what = cmd.slice(cmd.indexOf(range) + range.length).trim();
    const uids = range.split(',').flatMap((p) => {
      const r = /^(\d+):(\*|\d+)$/.exec(p.trim());
      if (!r) return [Number(p)];
      const lo = Number(r[1]);
      const hi = r[2] === '*' ? Number.MAX_SAFE_INTEGER : Number(r[2]);
      return folder.messages.filter((m) => m.uid >= lo && m.uid <= hi).map((m) => m.uid);
    });
    // every BODY[...] / BODY.PEEK[...] item the client asked for, in order (RFC 3501 fetch-att)
    const sections = [...what.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi)].map((m) => ({ section: m[1].toUpperCase(), from: m[2] ? Number(m[2]) : null, len: m[3] ? Number(m[3]) : null }));
    if (/\bRFC822\b(?!\.)/i.test(what)) sections.push({ section: '', from: null, len: null });
    const lines: Array<string | Buffer> = [];
    let seq = 0;
    for (const m of folder.messages) {
      seq++;
      if (!uids.includes(m.uid)) continue;
      const bytes = m.bytes ?? Buffer.from(m.raw, 'utf8');
      const date = /^Date:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? 'Mon, 01 Jan 2024 00:00:00 +0000';
      // a real server always sends INTERNALDATE; without it the store's sort order is the test's clock
      const attrs = [`UID ${m.uid}`, `FLAGS (${m.flags.join(' ')})`, `RFC822.SIZE ${bytes.length}`, `INTERNALDATE "${date}"`];
      if (/ENVELOPE/i.test(what)) {
        const subject = /^Subject:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? '';
        const fromRaw = /^From:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? '';
        // RFC 3501: ENVELOPE has TEN fields (date subject from sender reply-to to cc bcc in-reply-to
        // message-id). An earlier version sent nine, the client rightly refused it, and every sync test
        // silently fell back to the HEADER path, so the envelope path real servers use went untested.
        // "Name <a@b>" or a bare address; the name goes into the ENVELOPE as sent (encoded-words and
        // all), exactly like a real server, which does not decode RFC 2047
        const angle = /^(.*?)\s*<([^>]*)>\s*$/.exec(fromRaw);
        const fromName = angle ? angle[1].replace(/^"|"$/g, '') : '';
        const from = angle ? angle[2] : fromRaw;
        // the message's own Message-ID, as a real server returns it (invented only when the raw has none)
        const msgId = /^Message-ID:\s*(<[^>\r\n]*>)/im.exec(m.raw)?.[1] ?? `<${subject.replace(/\s+/g, '.')}@example.com>`;
        attrs.push(`ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "${subject}" (("${fromName}" NIL "${from.split('@')[0]}" "${from.split('@')[1] ?? ''}")) NIL NIL NIL NIL NIL NIL "${msgId}")`);
      }
      const chunks: Buffer[] = [Buffer.from(`* ${seq} FETCH (${attrs.join(' ')}`, 'utf8')];
      if (/\bBODYSTRUCTURE\b/i.test(what)) {
        this.structureFetches++;
        chunks.push(Buffer.from(` BODYSTRUCTURE ${bodyStructure(parseEntity(bytes.toString('latin1')))}`, 'latin1'));
      }
      let first = true;
      for (const sec of sections) {
        let payload: Buffer | null = sectionOf(bytes, sec.section);
        if (payload && sec.from !== null) payload = payload.subarray(sec.from, sec.len !== null ? sec.from + sec.len : undefined);
        this.sectionFetches.push({ uid: m.uid, section: sec.section });
        const key = `BODY[${sec.section}]${sec.from !== null ? `<${sec.from}>` : ''}`;
        if (payload === null) {
          chunks.push(Buffer.from(` ${key} NIL`, 'latin1'));
          continue;
        }
        // BYTES: `{N}` is an octet count, so a non-ASCII message announces more than its JS length
        const size = first && this.lieAboutLiteralSize !== null ? this.lieAboutLiteralSize : payload.length;
        first = false;
        chunks.push(Buffer.from(` ${key} {${size}}\r\n`, 'latin1'), payload);
        this.literals++;
      }
      chunks.push(Buffer.from(')\r\n'));
      lines.push(Buffer.concat(chunks));
    }
    this.ok(tag, 'FETCH completed', lines);
  }

  private uidStore(cmd: string, flags: string, mode: 'add' | 'remove' | 'set') {
    const uids = (cmd.split(/\s+/)[2] ?? '').split(',').map(Number);
    const list = flags.split(/\s+/).filter(Boolean);
    for (const f of this.folders) {
      for (const m of f.messages) {
        if (!uids.includes(m.uid)) continue;
        if (mode === 'set') m.flags = [...list];
        else if (mode === 'add') m.flags = [...new Set([...m.flags, ...list])];
        else m.flags = m.flags.filter((x) => !list.includes(x));
      }
    }
  }

  private ok(tag: string, detail: string, extra: Array<string | Buffer> = []) {
    this.push(Buffer.concat([...extra.map((x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : x)), Buffer.from(`${tag} OK ${detail}\r\n`, 'utf8')]));
  }

  private no(tag: string, detail: string) {
    this.push(`${tag} NO ${detail}\r\n`);
  }

  /** Everything the client sent, as one string — what a test asserts command syntax against. */
  get transcript(): string {
    return this.log.join('');
  }
}

// ---------------------------------------------------------------- MIME, as a SERVER sees it
//
// An independent, deliberately small MIME splitter (it does NOT reuse src/core/mail/mime.ts: a fake
// that shares the client's parser would agree with the client's bugs). Everything works on a latin1
// view of the message BYTES, so offsets and sizes are octets and 8-bit content survives untouched.

interface Entity {
  /** the header block, without the blank line that ends it */
  head: string;
  /** everything after the blank line */
  body: string;
  headers: Array<[string, string]>;
  type: string;
  subtype: string;
  /** Content-Type parameters in the order and spelling the header has them (RFC 2231 names kept as-is) */
  params: Array<[string, string]>;
  children: Entity[];
  /** the embedded message of a message/rfc822 part */
  message: Entity | null;
}

function splitHead(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw.replace(/\r?\n$/, ''), body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function headerList(head: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += ` ${line.trim()}`;
    else {
      const i = line.indexOf(':');
      if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    }
  }
  return out;
}

const hget = (h: Array<[string, string]>, k: string) => h.find(([n]) => n === k)?.[1];

/** `type/sub; a=b; c="d;e"` -> value + ordered params, quotes removed, `\` escapes undone */
function headerParams(v: string): { value: string; params: Array<[string, string]> } {
  const parts: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q && c === '\\') {
      cur += c + (v[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') q = !q;
    if (c === ';' && !q) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  const params: Array<[string, string]> = [];
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    params.push([p.slice(0, eq).trim(), val]);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

function parseEntity(raw: string, defaultType = 'text/plain', depth = 0): Entity {
  const { head, body } = splitHead(raw);
  const headers = headerList(head);
  const ctRaw = hget(headers, 'content-type');
  const ct = ctRaw ? headerParams(ctRaw) : { value: defaultType, params: defaultType === 'text/plain' ? ([['charset', 'us-ascii']] as Array<[string, string]>) : [] };
  const [type, subtype] = ct.value.includes('/') ? ct.value.split('/', 2) : ['text', 'plain'];
  const e: Entity = { head, body, headers, type, subtype, params: ct.params, children: [], message: null };
  if (depth > 20) return e;
  if (type === 'multipart') {
    const boundary = ct.params.find(([k]) => k.toLowerCase() === 'boundary')?.[1] ?? '';
    // RFC 2046: the CRLF before a delimiter belongs to the delimiter, not to the part
    const delim = new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
    const marks = [...body.matchAll(delim)];
    for (let i = 0; i + 1 < marks.length && !marks[i][1]; i++) {
      const start = marks[i].index! + marks[i][0].length;
      const end = marks[i + 1].index!;
      e.children.push(parseEntity(body.slice(start, end), subtype === 'digest' ? 'message/rfc822' : 'text/plain', depth + 1));
    }
  } else if (type === 'message' && (subtype === 'rfc822' || subtype === 'global')) {
    e.message = parseEntity(body, 'text/plain', depth + 1);
  }
  return e;
}

/** An IMAP string: quoted when it can be, a literal when it holds CR / LF / 8-bit bytes, NIL for none. */
function istr(v: string | undefined | null): string {
  if (v === undefined || v === null) return 'NIL';
  if (/[\r\n\x00\x80-\xff]/.test(v)) return `{${Buffer.byteLength(v, 'latin1')}}\r\n${v}`;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function plist(params: Array<[string, string]>): string {
  return params.length ? `(${params.map(([k, v]) => `${istr(k)} ${istr(v)}`).join(' ')})` : 'NIL';
}

function addrList(v: string | undefined): string {
  if (!v) return 'NIL';
  const out: string[] = [];
  for (const a of v.split(',')) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(a) ?? [a, '', a.trim()];
    const [mbox, host] = String(m[2]).split('@');
    out.push(`(${m[1] ? istr(m[1]) : 'NIL'} NIL ${istr(mbox)} ${istr(host ?? '')})`);
  }
  return `(${out.join('')})`;
}

function envelope(e: Entity): string {
  const h = (k: string) => hget(e.headers, k);
  const from = addrList(h('from'));
  return `(${istr(h('date'))} ${istr(h('subject'))} ${from} ${h('sender') ? addrList(h('sender')) : from} ${h('reply-to') ? addrList(h('reply-to')) : from} ${addrList(h('to'))} ${addrList(h('cc'))} ${addrList(h('bcc'))} ${istr(h('in-reply-to'))} ${istr(h('message-id'))})`;
}

/** body-fld-dsp, body-fld-lang, body-fld-loc: Dovecot sends all three (NIL when absent) */
function extTail(e: Entity): string {
  const d = hget(e.headers, 'content-disposition');
  const dsp = d ? (() => {
    const p = headerParams(d);
    return `(${istr(p.value)} ${plist(p.params)})`;
  })() : 'NIL';
  return `${dsp} NIL NIL`;
}

/** RFC 3501 section 7.4.2 BODYSTRUCTURE, extension data included, as Dovecot lays it out. */
function bodyStructure(e: Entity): string {
  if (e.type === 'multipart') {
    // body-type-mpart = 1*body SP media-subtype [SP body-ext-mpart]: NO space between the parts
    return `(${e.children.map(bodyStructure).join('')} ${istr(e.subtype)} ${plist(e.params)} ${extTail(e)})`;
  }
  const enc = (hget(e.headers, 'content-transfer-encoding') ?? '7bit').toLowerCase();
  const id = hget(e.headers, 'content-id');
  const desc = hget(e.headers, 'content-description');
  const fields = `${istr(e.type)} ${istr(e.subtype)} ${plist(e.params)} ${istr(id)} ${istr(desc)} ${istr(enc)} ${Buffer.byteLength(e.body, 'latin1')}`;
  const lines = (e.body.match(/\n/g) ?? []).length;
  if (e.type === 'text') return `(${fields} ${lines} NIL ${extTail(e)})`;
  if (e.message) return `(${fields} ${envelope(e.message)} ${bodyStructure(e.message)} ${lines} NIL ${extTail(e)})`;
  return `(${fields} NIL ${extTail(e)})`;
}

/** BODY[section] per RFC 3501 6.4.5: '', HEADER, TEXT, n.n.n, n.MIME, n.HEADER, n.TEXT. Null = no such part. */
function sectionOf(bytes: Buffer, spec: string): Buffer | null {
  const raw = bytes.toString('latin1');
  const out = (s: string) => Buffer.from(s, 'latin1');
  if (spec === '') return Buffer.from(bytes);
  const root = parseEntity(raw);
  if (spec === 'HEADER') return out(`${root.head}\r\n\r\n`);
  if (spec === 'TEXT') return out(root.body);
  const toks = spec.split('.');
  let cur: Entity | null = null;
  let ctx: Entity = root;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d+$/.test(t)) {
      if (cur) {
        // a further number addresses INSIDE the current part: a multipart's children, or an attached
        // message's own parts
        if (cur.message) ctx = cur.message;
        else if (cur.type === 'multipart') ctx = cur;
        else return null;
      }
      const n = Number(t);
      if (ctx.type === 'multipart') cur = ctx.children[n - 1] ?? null;
      else cur = n === 1 ? ctx : null;
      if (!cur) return null;
      continue;
    }
    if (!cur || i !== toks.length - 1) return null;
    if (t === 'MIME') return out(`${cur.head}\r\n\r\n`);
    if (t === 'HEADER' && cur.message) return out(`${cur.message.head}\r\n\r\n`);
    if (t === 'TEXT' && cur.message) return out(cur.message.body);
    return null;
  }
  return cur ? out(cur.body) : null;
}

export { bodyStructure as fakeBodyStructure, parseEntity as fakeParseEntity, sectionOf as fakeSectionOf };

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
    const lines: Array<string | Buffer> = [];
    let seq = 0;
    for (const m of folder.messages) {
      seq++;
      if (!uids.includes(m.uid)) continue;
      const wantsBody = /BODY(\.PEEK)?\[\]|RFC822/i.test(what);
      const wantsHeader = /BODY(\.PEEK)?\[HEADER/i.test(what);
      const date = /^Date:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? 'Mon, 01 Jan 2024 00:00:00 +0000';
      // a real server always sends INTERNALDATE; without it the store's sort order is the test's clock
      const attrs = [`UID ${m.uid}`, `FLAGS (${m.flags.join(' ')})`, `RFC822.SIZE ${m.bytes?.length ?? Buffer.byteLength(m.raw)}`, `INTERNALDATE "${date}"`];
      if (/ENVELOPE/i.test(what)) {
        const subject = /^Subject:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? '';
        const from = /^From:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? '';
        attrs.push(`ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "${subject}" (("" NIL "${from.split('@')[0]}" "${from.split('@')[1] ?? ''}")) NIL NIL NIL NIL NIL "<${subject.replace(/\s+/g, '.')}@example.com>")`);
      }
      if (wantsBody || wantsHeader) {
        // BYTES: `{N}` is an octet count, so a non-ASCII message announces more than its JS length
        const payload = wantsHeader ? Buffer.from(m.raw.split(/\r?\n\r?\n/)[0] + '\r\n', 'utf8') : (m.bytes ?? Buffer.from(m.raw, 'utf8'));
        const size = this.lieAboutLiteralSize ?? payload.length;
        const section = wantsBody && !wantsHeader ? 'BODY[]' : 'BODY[HEADER]';
        lines.push(Buffer.concat([Buffer.from(`* ${seq} FETCH (${attrs.join(' ')} ${section} {${size}}\r\n`, 'utf8'), payload, Buffer.from(')\r\n')]));
        this.literals++;
        continue;
      }
      lines.push(`* ${seq} FETCH (${attrs.join(' ')})\r\n`);
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

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
  messages: Array<{ uid: number; flags: string[]; raw: string }>;
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
  /** split every server write into chunks of this many characters */
  chunkSize?: number;
  /** emit a BYE right after the greeting */
  byeAfterGreeting?: boolean;
}

export class FakeImapServer {
  readonly log: string[] = [];
  private dataCb: ((c: string) => void) | null = null;
  private closeCb: ((e?: Error) => void) | null = null;
  private closed = false;
  private idle = false;
  private idleTag: string | null = null;
  readonly folders: FakeFolder[];
  literals = 0;
  /** the folder the last SELECT / EXAMINE opened; a fetch answers from here */
  selected: FakeFolder | null = null;
  /** set by tests: the next `{N}` literal is announced with this size instead of the real one */
  lieAboutLiteralSize: number | null = null;

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

  /** Push raw text to the client (used by tests to inject malformed data). */
  push(text: string) {
    if (this.closed) return;
    this.dataCb?.(text);
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

  private receive(chunk: string) {
    this.log.push(chunk);
    // The client writes the command, the `{N}` announcement and the literal in ONE write, so the
    // literal must be split off the same buffer. (An earlier draft expected the literal in a SECOND
    // write, which is what a `{N}`-then-bytes client does — and which cost three timeouts here.)
    const pending = this.sawLiteral;
    this.sawLiteral = null;
    if (pending) {
      const literal = chunk.slice(0, pending.size);
      this.handle(pending.cmd, literal, chunk.slice(pending.size));
      return;
    }
    // the common case: `TAG CMD {N}\r\n` and the N literal bytes in the SAME write
    const nl = chunk.indexOf('\r\n');
    if (nl >= 0) {
      const first = chunk.slice(0, nl);
      const m = /\{(\d+)\}$/.exec(first);
      if (m) {
        const cmd = first.slice(0, m.index).trim();
        const size = Number(m[1]);
        const start = nl + 2;
        this.handle(cmd, chunk.slice(start, start + size), chunk.slice(start + size));
        return;
      }
    }
    for (const line of chunk.split('\r\n')) {
      if (!line) continue;
      const m = /\{(\d+)\}$/.exec(line);
      if (m) {
        this.sawLiteral = { cmd: line.slice(0, m.index).trim(), size: Number(m[1]) };
        continue;
      }
      this.handle(line, '', '');
    }
  }

  private sawLiteral: { cmd: string; size: number } | null = null;

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
    const caps = this.opts.capabilities ?? ['IMAP4rev1', 'UIDPLUS', 'MOVE', ...(this.opts.idle ? ['IDLE'] : [])];

    if (upper.startsWith('CAPABILITY')) return this.ok(tag, 'CAPABILITY completed', [`* CAPABILITY ${caps.join(' ')}\r\n`]);
    if (upper.startsWith('LOGIN')) {
      if (this.opts.refuseAuth) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      if (this.opts.user && !cmd.includes(this.opts.user)) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      if (this.opts.password && !cmd.includes(this.opts.password)) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      return this.ok(tag, 'LOGIN completed');
    }
    if (upper.startsWith('AUTHENTICATE')) {
      if (this.opts.refuseAuth) return this.no(tag, '[AUTHENTICATIONFAILED] invalid credentials');
      if (literal) this.push(''); // consume; a real server would decode it
      return this.ok(tag, 'AUTHENTICATE completed');
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
      const detail = `[COPYUID 42 ${uids} ${newUids}]`;
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
    const lines: string[] = [];
    let seq = 0;
    for (const m of folder.messages) {
      seq++;
      if (!uids.includes(m.uid)) continue;
      const wantsBody = /BODY(\.PEEK)?\[\]|RFC822/i.test(what);
      const wantsHeader = /BODY(\.PEEK)?\[HEADER/i.test(what);
      const date = /^Date:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? 'Mon, 01 Jan 2024 00:00:00 +0000';
      // a real server always sends INTERNALDATE; without it the store's sort order is the test's clock
      const attrs = [`UID ${m.uid}`, `FLAGS (${m.flags.join(' ')})`, `RFC822.SIZE ${Buffer.byteLength(m.raw)}`, `INTERNALDATE "${date}"`];
      if (/ENVELOPE/i.test(what)) {
        const subject = /^Subject:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? '';
        const from = /^From:\s*(.*)$/im.exec(m.raw)?.[1]?.trim() ?? '';
        attrs.push(`ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "${subject}" (("" NIL "${from.split('@')[0]}" "${from.split('@')[1] ?? ''}")) NIL NIL NIL NIL NIL "<${subject.replace(/\s+/g, '.')}@example.com>")`);
      }
      if (wantsBody || wantsHeader) {
        const payload = wantsHeader ? m.raw.split(/\r?\n\r?\n/)[0] + '\r\n' : m.raw;
        const size = this.lieAboutLiteralSize ?? Buffer.byteLength(payload);
        const section = wantsBody && !wantsHeader ? 'BODY[]' : 'BODY[HEADER]';
        lines.push(`* ${seq} FETCH (${attrs.join(' ')} ${section} {${size}}\r\n${payload})\r\n`);
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

  private ok(tag: string, detail: string, extra: string[] = []) {
    this.push(extra.join('') + `${tag} OK ${detail}\r\n`);
  }

  private no(tag: string, detail: string) {
    this.push(`${tag} NO ${detail}\r\n`);
  }

  /** Everything the client sent, as one string — what a test asserts command syntax against. */
  get transcript(): string {
    return this.log.join('');
  }
}

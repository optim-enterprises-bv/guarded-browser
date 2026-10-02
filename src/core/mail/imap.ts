// IMAP client core (ticket 36) — protocol, not transport.
//
// The socket is INJECTED. That is what makes this testable in milliseconds against a canned server
// instead of against a network, and it is also what keeps the security decision visible: this module
// never opens anything itself, so the caller (main) is where "which socket, and is a task running"
// is decided. Nothing here reads a file, spawns a process, or touches Electron.
//
// Threat model, since a mail server is an untrusted peer like any other:
//  * every literal is capped (a server claiming a 4 GB literal is refused, not buffered);
//  * every command has a timeout (a server that accepts a connection and then says nothing must not
//    wedge the account forever);
//  * the parser never `eval`s, never builds a regex from server text, and caps nesting depth;
//  * a failure returns a step from `classifyImapFailure`'s taxonomy rather than a raw exception, so
//    the UI can say which of DNS/TCP/TLS/greeting/auth/folder is wrong.
//
// Deliberately NOT here: OAuth token exchange (accounts.ts), the store (store.ts), MIME parsing
// (mime.ts), and IDLE-driven sync policy (the sync state machine that calls `idle()`).

import { classifyImapFailure, type ImapStep, type ProbeResult, type MailAccount } from '../../main/mail/accounts';

/** the largest literal we will accept from a server (a 4 GB `{4294967295}` claim is not mail) */
export const MAX_LITERAL = 16 * 1024 * 1024;
/** cap on the number of untagged lines in one response, so a hostile server cannot loop us */
export const MAX_RESPONSE_LINES = 20_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 29 * 60_000;
/** IDLE restarts every 29 minutes, as RFC 2177 recommends (servers may drop at 30) */
export const IDLE_RESTART_MS = 25 * 60_000;

export interface ImapSocket {
  write(data: string): void;
  /** raw BYTES: literal sizes are octet counts, so the transport must not decode them into characters */
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (err?: Error) => void): void;
  end(): void;
}

export interface SocketOpts {
  host: string;
  port: number;
  /** 'implicit' = TLS from the first byte (993), 'starttls' = plaintext then upgrade (143/587) */
  tls: MailAccount['tls'];
}

export type SocketFactory = (opts: SocketOpts) => Promise<ImapSocket>;

export type ImapValue = string | ImapValue[];

export interface ImapResponse {
  /** the full text with literal placeholders (`\u0000i\u0000`) inlined */
  text: string;
  /** each literal decoded as UTF-8 (for envelopes, headers, quoted text) */
  literals: string[];
  /** the same literals as the exact bytes the server sent, for a caller that decodes per charset */
  literalBytes?: Buffer[];
  /**
   * One entry per untagged response, EACH WITH ITS OWN literals. A batched FETCH returns several
   * responses that all contain `\u00000\u0000`; resolving them against one shared literal array
   * silently returns the first message's body for every message (that bug cost a debugging pass).
   */
  responses?: Array<{ text: string; literals: string[]; literalBytes?: Buffer[] }>;
  /** the tag, for a tagged response */
  tag?: string;
  /** OK / NO / BAD for a tagged response */
  status?: 'OK' | 'NO' | 'BAD';
  /** the rest of a tagged response, e.g. `[READ-WRITE] SELECT completed` */
  detail?: string;
  /** for an untagged response: the leading data item, e.g. `1 FETCH (...)` */
  untagged?: string;
}

// ---------------------------------------------------------------- incremental parser

/**
 * Incremental IMAP response parser.
 *
 * A response is one or more lines; a line ending in `{N}` is followed by exactly N bytes of literal
 * data and then the response CONTINUES on the same logical line. Literals are extracted into an
 * array and replaced by a `\0i\0` placeholder, so the caller sees one text with indexable literals
 * (re-scanning the raw buffer per lookup would be O(n^2) on a big message).
 */
export class ImapParser {
  /** BYTES, not characters: a `{N}` literal size counts octets, and a decoded string cannot be sliced by it */
  private buf: Buffer = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private queued = 0;
  /** extraction is not retried until at least this many bytes are buffered (a big literal is not re-scanned per chunk) */
  private need = 0;
  private feeding = false;
  /** thrown-by-callback is not caught here: the caller's handler decides what to do */
  constructor(private readonly onResponse: (r: ImapResponse) => void) {}

  feed(chunk: Buffer | string) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (b.length) {
      this.chunks.push(b);
      this.queued += b.length;
    }
    // re-entrant feed (a response handler that writes, and the peer answers synchronously): the outer
    // loop below picks the new bytes up
    if (this.feeding) return;
    this.feeding = true;
    try {
      for (;;) {
        if (this.chunks.length) {
          if (this.buf.length + this.queued < this.need) return;
          this.buf = Buffer.concat([this.buf, ...this.chunks]);
          this.chunks = [];
          this.queued = 0;
        }
        const r = this.extract();
        if (!r) {
          if (!this.chunks.length) return;
          continue;
        }
        this.need = 0;
        this.buf = this.buf.subarray(r.consumed);
        this.onResponse(r);
      }
    } finally {
      this.feeding = false;
    }
  }

  /** true when bytes are pending (an incomplete line). Used by tests and by the reconnect logic. */
  get pending(): number {
    return this.buf.length + this.queued;
  }

  private extract(): ({ text: string; literals: string[]; literalBytes: Buffer[]; consumed: number } & ImapResponse) | null {
    let i = 0;
    const literals: string[] = [];
    const literalBytes: Buffer[] = [];
    let text = '';
    let lines = 0;
    for (;;) {
      const nl = this.buf.indexOf(0x0a, i);
      if (nl < 0) {
        this.need = this.buf.length + 1; // incomplete line: wait for more
        return null;
      }
      if (++lines > MAX_RESPONSE_LINES) throw new Error('imap: response too long');
      const line = this.buf.subarray(i, nl + 1);
      i = nl + 1;
      // the `{N}` marker is ASCII, so matching it on a latin1 view of the bytes is exact
      const m = /\{(\d+)\}\r?\n$/.exec(line.toString('latin1'));
      if (m) {
        const n = Number(m[1]);
        if (!Number.isInteger(n) || n < 0) return null;
        if (n > MAX_LITERAL) throw new Error(`imap: literal of ${n} bytes refused (cap ${MAX_LITERAL})`);
        if (this.buf.length < i + n) {
          this.need = i + n; // wait for the literal
          return null;
        }
        const lit = Buffer.from(this.buf.subarray(i, i + n));
        literalBytes.push(lit);
        literals.push(lit.toString('utf8'));
        text += `${line.subarray(0, line.length - m[0].length).toString('utf8')}\u0000${literals.length - 1}\u0000`;
        i += n;
        continue;
      }
      text += line.toString('utf8');
      return { text: text.replace(/[\r\n]+$/, ''), literals, literalBytes, consumed: i };
    }
  }
}

// ---------------------------------------------------------------- value tokenizer

/**
 * Tokenize an IMAP response fragment: atoms, quoted strings, NIL, numbers, parenthesized lists and
 * literal placeholders. Returns [] rather than throwing on anything malformed.
 */
export function tokenize(text: string, depth = 0): ImapValue[] {
  const out: ImapValue[] = [];
  if (depth > 32) return out;
  let i = 0;
  const s = String(text ?? '');
  const skipSpace = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  while (i < s.length) {
    skipSpace();
    if (i >= s.length) break;
    const c = s[i];
    if (c === '(') {
      // find the matching ')' at this depth, then recurse on the inside
      let d = 0;
      let j = i;
      let inStr = false;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === '\\' && inStr) {
          j++;
          continue;
        }
        if (ch === '"') inStr = !inStr;
        else if (!inStr && ch === '(') d++;
        else if (!inStr && ch === ')') {
          d--;
          if (d === 0) break;
        }
      }
      if (j >= s.length) {
        // unbalanced: take the rest as a list (a malformed server response is not a crash)
        out.push(tokenize(s.slice(i + 1), depth + 1));
        break;
      }
      out.push(tokenize(s.slice(i + 1, j), depth + 1));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < s.length; j++) {
        if (s[j] === '\\') {
          v += s[j + 1] ?? '';
          j++;
          continue;
        }
        if (s[j] === '"') break;
        // every ordinary character is part of the string — an earlier draft only handled the
        // escape and the closing quote, so EVERY quoted token came back empty (which the
        // ENVELOPE and FETCH tests caught immediately)
        v += s[j];
      }
      out.push(v);
      i = j + 1;
      continue;
    }
    if (c === '\u0000') {
      const end = s.indexOf('\u0000', i + 1);
      if (end < 0) break;
      out.push(s.slice(i, end + 1)); // the placeholder itself; the caller indexes `literals`
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !' \t()"'.includes(s[j]) && s[j] !== '\u0000') j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * A literal placeholder is a plain boolean test, NOT a type predicate: `isPlaceholder(x)` typed as
 * `x is string` makes the negative branch of `!isPlaceholder(x)` narrow to `never`, which is how this
 * cost a compile error inside the FETCH parser.
 */
export const isPlaceholder = (v: ImapValue): boolean => typeof v === 'string' && v.startsWith('\u0000') && v.endsWith('\u0000');
/** Resolve a token to its literal when it is a placeholder, else the token itself. */
export const literalAt = (v: ImapValue, literals: string[]): string => (isPlaceholder(v) ? (literals[Number(v.slice(1, -1))] ?? '') : typeof v === 'string' ? v : '');

/** `\Seen \Answered` -> ['\\Seen', '\\Answered'] */
export const asFlags = (v: ImapValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// ---------------------------------------------------------------- FETCH parsing

export interface FetchResult {
  uid: number;
  seq?: number;
  flags?: string[];
  size?: number;
  internalDate?: number;
  /** section name (e.g. `HEADER`, `TEXT`, `1.2`) -> decoded text; '' when the server said NIL */
  sections: Record<string, string>;
  /** the same sections as raw bytes, when they arrived as literals (a body is decoded per charset by mime.ts) */
  sectionBytes: Record<string, Buffer>;
  /** the Gmail/Thunderbird-style thread id, when the server offers one */
  threadId?: string;
  envelope?: Envelope;
}

export interface Envelope {
  subject: string;
  from: Array<{ name: string; address: string }>;
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  messageId: string;
  date: string;
}

/**
 * Parse `* n FETCH (...)` into a result. Section keys lose their `[]` (FETCH (BODY[HEADER] {12})),
 * and `BODY[]` becomes the key `''`-less `BODY` — the caller asks for what it requested.
 */
export function parseFetch(untagged: string, literals: string[], literalBytes: Buffer[] = []): FetchResult | null {
  const m = /^\*?\s*(\d+)\s+FETCH\s+\(([\s\S]*)\)\s*$/i.exec(untagged.trim());
  if (!m) return null;
  const seq = Number(m[1]);
  const toks = tokenize(m[2]);
  const out: FetchResult = { uid: 0, seq, sections: {}, sectionBytes: {} };
  for (let i = 0; i < toks.length; i++) {
    const key = toks[i];
    if (typeof key !== 'string' || isPlaceholder(key)) continue;
    const val = toks[i + 1];
    const KEY = key.toUpperCase();
    if (KEY === 'UID') {
      out.uid = Number(val) || 0;
      i++;
      continue;
    }
    if (KEY === 'FLAGS') {
      out.flags = asFlags(val);
      i++;
      continue;
    }
    if (KEY === 'RFC822.SIZE') {
      out.size = Number(val) || 0;
      i++;
      continue;
    }
    if (KEY === 'INTERNALDATE') {
      const t = Date.parse(String(val ?? ''));
      if (Number.isFinite(t)) out.internalDate = t;
      i++;
      continue;
    }
    if (KEY === 'X-GM-THRID' || KEY === 'X-GM-MSGID') {
      if (KEY === 'X-GM-THRID') out.threadId = String(val ?? '');
      i++;
      continue;
    }
    if (KEY === 'ENVELOPE') {
      out.envelope = parseEnvelope(val);
      i++;
      continue;
    }
    if (KEY.startsWith('BODY')) {
      // BODY[HEADER], BODY[TEXT], BODY.PEEK[1.2], BODY[2]<0.1024>
      const section = /^BODY(?:\.PEEK)?\[([^\]]*)\]/i.exec(key);
      const partial = /<(\d+)>/.exec(key);
      if (section) {
        let name = section[1];
        // BODY[HEADER.FIELDS (FROM TO)] arrives as its own nested list token; join it back
        if (Array.isArray(toks[i + 1]) && /\bHEADER\.FIELDS$/i.test(name)) name += ` (${(toks[i + 1] as ImapValue[]).map(String).join(' ')})`;
        const value = literalAt(val, literals);
        out.sections[name.toUpperCase()] = partial ? value.slice(Number(partial[1])) : value;
        const bytes = isPlaceholder(val) ? literalBytes[Number((val as string).slice(1, -1))] : undefined;
        if (bytes) out.sectionBytes[name.toUpperCase()] = partial ? bytes.subarray(Number(partial[1])) : bytes;
        if (Array.isArray(toks[i + 1]) && /\bHEADER\.FIELDS$/i.test(name)) i++;
        i++;
        continue;
      }
    }
    // an unknown attribute: skip its value, so the loop does not desynchronise
    if (val !== undefined) i++;
  }
  return out;
}

function parseEnvelope(v: ImapValue | undefined): Envelope | undefined {
  if (!Array.isArray(v) || v.length < 10) return undefined;
  const str = (x: ImapValue | undefined) => (typeof x === 'string' ? x : '');
  const addrs = (x: ImapValue | undefined): Array<{ name: string; address: string }> => {
    if (!Array.isArray(x)) return [];
    return x
      .filter(Array.isArray)
      .map((a) => {
        const parts = a as ImapValue[];
        // an unquoted NIL is a NULL field, not the four letters "NIL" — the tokenizer cannot tell
        // the two apart, so the rule is applied here, where NIL is meaningful
        const val = (x: ImapValue | undefined) => {
          const s = str(x);
          return s.toUpperCase() === 'NIL' ? '' : s;
        };
        const name = [val(parts[0]), val(parts[1])].filter(Boolean).join(' ');
        const host = val(parts[3]);
        const mailbox = val(parts[2]);
        return { name, address: mailbox && host ? `${mailbox}@${host}` : '' };
      })
      .filter((a) => a.address || a.name)
      .slice(0, 100);
  };
  // RFC 3501 ENVELOPE order: (date subject from sender reply-to to cc bcc in-reply-to message-id).
  // `from` is index 2 and `to` is index 5 — reading 3/5 (sender/reply-to) returns NIL on every real
  // server, which is exactly what the envelope test caught.
  return {
    subject: str(v[1]),
    from: addrs(v[2]),
    to: addrs(v[5]),
    cc: addrs(v[6]),
    messageId: str(v[9]).replace(/^<|>$/g, ''),
    date: str(v[0]),
  };
}

// ---------------------------------------------------------------- request/response

interface Pending {
  tag: string;
  cmd: string;
  untagged: ImapResponse[];
  responses: Array<{ text: string; literals: string[]; literalBytes?: Buffer[] }>;
  literals: string[];
  /** what to write on each `+` continuation, in order (a literal, or a SASL response) */
  cont: string[];
  resolve: (r: ImapResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ClientEvent {
  kind: 'exists' | 'expunge' | 'fetch' | 'flags' | 'bye' | 'other';
  text: string;
}

/**
 * One IMAP connection. Not reusable after `logout()` / a socket close; the sync layer owns
 * reconnection so that backoff, state and the UI's "offline" indicator live in one place.
 */
export class ImapClient {
  private readonly parser: ImapParser;
  private pending: Pending | null = null;
  private tagN = 0;
  private capabilities = new Set<string>();
  private readonly listeners = new Set<(e: ClientEvent) => void>();
  /** set by the greeting; the client refuses to send commands after a BYE */
  private closed = false;
  private idleMode = false;
  /** the connection is gone (socket closed or a command timed out); `bye` has been emitted */
  private ended = false;
  private idleResolve: (() => void) | null = null;

  constructor(
    private readonly socket: ImapSocket,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.parser = new ImapParser((r) => this.onResponse(r));
    this.socket.onData((c) => this.parser.feed(c));
    // pass the error THROUGH: without it a dropped socket is reported as a bare "connection closed"
    // and the actual reason (TLS error, reset, timeout) is lost to the user
    this.socket.onClose((err) => this.onClosed(err));
  }

  get serverCapabilities(): string[] {
    return [...this.capabilities].sort();
  }

  has(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  onEvent(fn: (e: ClientEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ClientEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private onClosed(err?: Error) {
    this.closed = true;
    // once per connection: a timeout closes the socket itself, and the socket then reports the close
    if (this.ended) return;
    this.ended = true;
    const p = this.pending;
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      this.pending = null;
      p.reject(err ?? new Error('imap: connection closed'));
    }
    this.idleResolve?.();
    this.idleResolve = null;
    this.emit({ kind: 'bye', text: err?.message ?? 'connection closed' });
  }

  private onResponse(r: ImapResponse) {
    if (r.text.startsWith('+')) {
      // a continuation request: the server is ready for a literal or a SASL response
      const p = this.pending;
      if (p && p.cont.length) {
        this.socket.write(p.cont.shift()!);
        return;
      }
      // IDLE
      if (this.idleMode) this.idleAccepted = true;
      this.idleResolve?.();
      this.idleResolve = null;
      return;
    }
    if (r.text.startsWith('*')) {
      const body = r.text.slice(1).trim();
      if (!this.pending && this.greetingResolve) {
        // the greeting: no command is in flight, and a one-shot listener is waiting for it
        this.greetingResolve(r.text);
        return;
      }
      const upper = body.toUpperCase();
      if (this.idleMode) {
        const kind = upper.includes('EXISTS')
          ? 'exists'
          : upper.includes('EXPUNGE')
            ? 'expunge'
            : upper.includes('FETCH')
              ? 'fetch'
              : upper.includes('BYE')
                ? 'bye'
                : 'other';
        this.emit({ kind: kind as ClientEvent['kind'], text: body });
        if (kind !== 'other') return;
      }
      const p = this.pending;
      if (p) {
        // the FULL response text, `*` included: every consumer (LIST / SEARCH / SELECT / FETCH)
        // matches on the wire form, and dropping the `*` here silently broke SEARCH and SELECT
        r.untagged = r.text;
        p.untagged.push(r);
        p.responses.push({ text: r.text, literals: r.literals, literalBytes: r.literalBytes });
        p.literals.push(...r.literals);
      }
      return;
    }
    const tm = /^(\S+)\s+(OK|NO|BAD)\b\s*([\s\S]*)$/i.exec(r.text);
    if (!tm) return;
    const p = this.pending;
    if (!p || tm[1] !== p.tag) return; // a response for a tag we no longer own: ignored
    if (p.timer) clearTimeout(p.timer);
    this.pending = null;
    r.tag = tm[1];
    r.status = tm[2].toUpperCase() as 'OK' | 'NO' | 'BAD';
    r.detail = tm[3];
    r.literals = [...p.literals, ...r.literals];
    r.responses = p.responses;
    p.resolve({ ...r, untagged: p.untagged.map((u) => u.text).join('\n') } as ImapResponse & { untagged: string });
  }

  /**
   * Run one tagged command and collect its untagged responses.
   *
   * `literal`: RFC 3501 synchronizing literal — `TAG CMD {N}\r\n`, WAIT for the server's `+`, then the
   * N bytes and the CRLF that ends the command line. With LITERAL+ (RFC 7888) the `{N+}` form is sent
   * in one write. `continuation`: what to send after the first `+` with no literal (a SASL response).
   */
  private command(cmd: string, opts: { literal?: string; continuation?: string[]; timeoutMs?: number } = {}): Promise<ImapResponse> {
    if (this.closed) return Promise.reject(new Error('imap: the connection is closed'));
    if (this.pending) return Promise.reject(new Error('imap: a command is already in flight (commands are serialised by design)'));
    const tag = `A${String(++this.tagN).padStart(4, '0')}`;
    return new Promise<ImapResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.tag === tag) {
          // a timeout leaves the connection in an unknown state (a late answer would be read as the
          // reply to the NEXT command), so it is fatal: the socket is closed and the caller reconnects
          this.onClosed(new Error(`imap: ${cmd.split(' ')[0]} timed out after ${opts.timeoutMs ?? this.timeoutMs}ms`));
          this.close();
        }
      }, opts.timeoutMs ?? this.timeoutMs);
      let body: string;
      const cont: string[] = [...(opts.continuation ?? [])];
      if (opts.literal === undefined) {
        body = `${tag} ${cmd}\r\n`;
      } else {
        // the literal is announced on the SAME line as the command; the command line then ends AFTER it
        const n = Buffer.byteLength(opts.literal, 'utf8');
        if (this.has('LITERAL+') || (this.has('LITERAL-') && n <= 4096)) {
          body = `${tag} ${cmd} {${n}+}\r\n${opts.literal}\r\n`;
        } else {
          body = `${tag} ${cmd} {${n}}\r\n`;
          cont.unshift(`${opts.literal}\r\n`);
        }
      }
      this.pending = { tag, cmd, untagged: [], responses: [], literals: [], cont, resolve, reject, timer };
      try {
        this.socket.write(body);
      } catch (e) {
        clearTimeout(timer);
        this.pending = null;
        reject(e as Error);
      }
    });
  }

  async greeting(timeoutMs = this.timeoutMs): Promise<ImapResponse> {
    // The greeting is an UNTAGGED line that arrives before any command is in flight, so it is
    // captured by a one-shot listener rather than by the command router (which only attributes
    // untagged lines to a pending command). A `NO`/`BYE` greeting is a refusal, not a greeting.
    return new Promise<ImapResponse>((resolve, reject) => {
      const t = setTimeout(() => {
        this.greetingResolve = null;
        reject(new Error('imap: no greeting'));
      }, timeoutMs);
      this.greetingResolve = (text: string) => {
        clearTimeout(t);
        this.greetingResolve = null;
        if (/^\*\s*(BYE|NO)\b/i.test(text)) {
          reject(new Error(`imap: the server refused the connection: ${sanitizeDetail(text)}`));
          return;
        }
        resolve({ text, literals: [], untagged: text.replace(/^\*\s*/, '') });
      };
    });
  }
  private greetingResolve: ((text: string) => void) | null = null;

  async capability(): Promise<string[]> {
    const r = await this.command('CAPABILITY', { timeoutMs: 15_000 });
    const caps = new Set<string>();
    for (const u of (r.untagged ?? '').split('\n')) {
      const m = /^\*\s*CAPABILITY\s+(.*)$/i.exec(u.trim());
      if (m) for (const c of m[1].trim().split(/\s+/)) if (c) caps.add(c.toUpperCase());
    }
    const detail = /\[CAPABILITY\s+([^\]]+)\]/i.exec(r.detail ?? '');
    if (detail) for (const c of detail[1].trim().split(/\s+/)) if (c) caps.add(c.toUpperCase());
    for (const c of caps) this.capabilities.add(c);
    return [...caps].sort();
  }

  /**
   * LOGIN with a password. Refused when the server offers LOGINDISABLED, because continuing would
   * send the credential in the clear over a session that explicitly says it must not.
   */
  async login(username: string, password: string): Promise<void> {
    if (this.capabilities.has('LOGINDISABLED') && !this.capabilities.has('AUTH=PLAIN')) {
      throw new Error('imap: the server has LOGINDISABLED and offers no PLAIN auth');
    }
    const r = await this.command(`LOGIN ${quote(username)} ${quote(password)}`);
    if (r.status !== 'OK') throw new Error(`imap: login refused: ${sanitizeDetail(r.detail)}`);
    if (this.capabilities.has('LOGINDISABLED')) throw new Error('imap: the server answered LOGIN despite LOGINDISABLED; refusing to continue');
  }

  /** AUTHENTICATE PLAIN (base64 of NUL user NUL pass) — preferred over LOGIN when advertised. */
  async authenticatePlain(username: string, password: string): Promise<void> {
    const blob = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64');
    const r = await this.authenticate('PLAIN', blob);
    if (r.status !== 'OK') throw new Error(`imap: PLAIN auth refused: ${sanitizeDetail(r.detail)}`);
  }

  /** Gmail's XOAUTH2: `user=<u>\x01auth=Bearer <token>\x01\x01`. */
  async authenticateXoauth2(username: string, accessToken: string): Promise<void> {
    const blob = Buffer.from(`user=${username}\u0001auth=Bearer ${accessToken}\u0001\u0001`, 'utf8').toString('base64');
    const r = await this.authenticate('XOAUTH2', blob);
    if (r.status !== 'OK') throw new Error(`imap: XOAUTH2 refused: ${sanitizeDetail(r.detail)}`);
  }

  /**
   * RFC 3501 AUTHENTICATE: the SASL response is a base64 LINE, never a literal. With SASL-IR (RFC 4959)
   * it rides on the command line; otherwise the client waits for `+` and sends it. A second `+` (an
   * XOAUTH2 error challenge) is answered with an empty line, which makes the server send its tagged NO.
   */
  private authenticate(mech: string, b64: string): Promise<ImapResponse> {
    if (this.has('SASL-IR')) return this.command(`AUTHENTICATE ${mech} ${b64}`, { continuation: ['\r\n'] });
    return this.command(`AUTHENTICATE ${mech}`, { continuation: [`${b64}\r\n`, '\r\n'] });
  }

  async list(reference = '', pattern = '*'): Promise<Array<{ path: string; name: string; delimiter: string; flags: string[] }>> {
    const r = await this.command(`LIST ${quote(reference)} ${quote(pattern)}`);
    const out: Array<{ path: string; name: string; delimiter: string; flags: string[] }> = [];
    for (const line of (r.untagged ?? '').split('\n')) {
      const m = /^\*\s*LIST\s+\(([^)]*)\)\s+("(?:[^"\\]|\\.)*"|NIL)\s+(.*)$/i.exec(line.trim());
      if (!m) continue;
      const flags = m[1].trim().split(/\s+/).filter(Boolean);
      const delim = /^NIL$/i.test(m[2]) ? '' : unquote(m[2]);
      const name = unquote(m[3].trim());
      out.push({ path: name, name: name.split(delim || '/').pop() ?? name, delimiter: delim, flags });
      if (out.length >= 1000) break;
    }
    return out;
  }

  /** SELECT (writable) / EXAMINE (read-only). The UIDVALIDITY is what makes a uid meaningful. */
  async select(path: string, readonly = false): Promise<SelectInfo> {
    const r = await this.command(`${readonly ? 'EXAMINE' : 'SELECT'} ${quote(path)}`);
    if (r.status !== 'OK') throw new Error(`imap: cannot open ${path}: ${sanitizeDetail(r.detail)}`);
    const info: SelectInfo = { path, exists: 0, uidValidity: 0, uidNext: 0, readOnly: readonly, flags: [], permanentFlags: [], highestModSeq: 0 };
    const all = r.untagged ?? '';
    for (const line of all.split('\n')) {
      const t = line.trim();
      const ex = /^\*\s*(\d+)\s+EXISTS$/i.exec(t);
      if (ex) info.exists = Number(ex[1]);
      const uv = /\[UIDVALIDITY\s+(\d+)\]/i.exec(t);
      if (uv) info.uidValidity = Number(uv[1]);
      const un = /\[UIDNEXT\s+(\d+)\]/i.exec(t);
      if (un) info.uidNext = Number(un[1]);
      const hm = /\[HIGHESTMODSEQ\s+(\d+)\]/i.exec(t);
      if (hm) info.highestModSeq = Number(hm[1]);
      const fl = /^\*\s*FLAGS\s+\(([^)]*)\)/i.exec(t);
      if (fl) info.flags = fl[1].trim().split(/\s+/).filter(Boolean);
      const pf = /\[PERMANENTFLAGS\s+\(([^)]*)\)\]/i.exec(t);
      if (pf) info.permanentFlags = pf[1].trim().split(/\s+/).filter(Boolean);
      const rd = /\[READ-ONLY\]/i.test(t) || /\[READ-WRITE\]/i.test(t) ? /\[READ-ONLY\]/i.test(t) : null;
      if (rd !== null) info.readOnly = rd;
    }
    if (r.detail && /\[READ-ONLY\]/i.test(r.detail)) info.readOnly = true;
    return info;
  }

  /**
   * UIDs in a range. `1:*` is only used when the caller really means "all" (a first sync).
   *
   * The range IS the search key: `UID SEARCH 3:*` is the RFC 3501 form (a bare sequence set is a valid
   * search key, and under UID SEARCH the numbers are uids). `UID SEARCH ALL 3:*` — an earlier draft —
   * is not valid syntax, and a strict server answers BAD.
   */
  async uidSearch(range: string, criteria?: string): Promise<number[]> {
    const r = await this.command(criteria ? `UID SEARCH ${criteria} ${range}` : `UID SEARCH ${range}`);
    const uids: number[] = [];
    for (const line of (r.untagged ?? '').split('\n')) {
      const m = /^\*\s*SEARCH\s*([\d\s]*)$/i.exec(line.trim());
      if (m) for (const x of m[1].trim().split(/\s+/)) if (x) uids.push(Number(x));
    }
    return uids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 100_000);
  }

  /** FETCH by uid range. `what` is caller-chosen and never server-derived. */
  async uidFetch(range: string, what: string): Promise<FetchResult[]> {
    const r = await this.command(`UID FETCH ${range} ${what}`);
    const out: FetchResult[] = [];
    // each response is parsed against ITS OWN literals (see ImapResponse.responses)
    for (const res of r.responses ?? []) {
      const f = parseFetch(res.text, res.literals, res.literalBytes);
      if (f && f.uid > 0) out.push(f);
    }
    return out;
  }

  /** One message's full text by uid. Returns '' when the server answers NIL. */
  async uidBody(uid: number): Promise<string> {
    const r = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    for (const res of r.responses ?? []) {
      const f = parseFetch(res.text, res.literals);
      if (f && f.uid === uid) return f.sections[''] ?? '';
    }
    return '';
  }

  /**
   * One message's full text by uid as the server's BYTES, so mime.ts can decode each part per its
   * declared charset (an 8-bit latin1 body is not UTF-8). Empty when the server answers NIL.
   */
  async uidBodyBytes(uid: number): Promise<Buffer> {
    const r = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    for (const res of r.responses ?? []) {
      const f = parseFetch(res.text, res.literals, res.literalBytes);
      if (f && f.uid === uid) return f.sectionBytes[''] ?? Buffer.from(f.sections[''] ?? '', 'utf8');
    }
    return Buffer.alloc(0);
  }

  /**
   * STORE flags. The `+FLAGS.SILENT` / `-FLAGS.SILENT` form is used so the server does not echo
   * every message back; `seen` is the one place where the \Seen flag round-trips.
   */
  async uidStore(uids: number[], mode: 'add' | 'remove' | 'set', flags: string[]): Promise<void> {
    if (!uids.length || !flags.length) return;
    const safe = flags.filter((f) => /^\\?[A-Za-z-]{1,32}$/.test(f)).map((f) => (f.startsWith('\\') ? f : `\\${f}`));
    if (!safe.length) return;
    const range = uids.join(',');
    const r = await this.command(`UID STORE ${range} ${mode === 'add' ? '+' : mode === 'remove' ? '-' : ''}FLAGS.SILENT (${safe.join(' ')})`);
    if (r.status !== 'OK') throw new Error(`imap: STORE refused: ${sanitizeDetail(r.detail)}`);
  }

  /**
   * MOVE when the server supports it (atomic, and it returns the new uids via COPYUID), else
   * COPY+STORE. The caller gets the new uids so the store can `rekey` instead of duplicating.
   */
  async uidMove(uids: number[], folder: string): Promise<{ moved: boolean; newUids: Map<number, number> }> {
    const newUids = new Map<number, number>();
    if (!uids.length) return { moved: false, newUids };
    const range = uids.join(',');
    if (this.has('MOVE')) {
      const r = await this.command(`UID MOVE ${range} ${quote(folder)}`);
      if (r.status !== 'OK') throw new Error(`imap: MOVE refused: ${sanitizeDetail(r.detail)}`);
      readCopyUid(`${r.untagged ?? ''} ${r.detail ?? ''}`, newUids);
      return { moved: true, newUids };
    }
    const c = await this.command(`UID COPY ${range} ${quote(folder)}`);
    if (c.status !== 'OK') throw new Error(`imap: COPY refused: ${sanitizeDetail(c.detail)}`);
    readCopyUid(`${c.untagged ?? ''} ${c.detail ?? ''}`, newUids);
    // only mark \Deleted when the copy really happened; an expunge is the caller's decision
    await this.uidStore(uids, 'add', ['Deleted']);
    return { moved: true, newUids };
  }

  async expunge(): Promise<void> {
    const r = await this.command('EXPUNGE');
    if (r.status !== 'OK') throw new Error(`imap: EXPUNGE refused: ${sanitizeDetail(r.detail)}`);
  }

  /** APPEND one message. Returns the new uid when the server reports it (APPENDUID). */
  async append(folder: string, message: string, flags: string[] = []): Promise<{ uid: number | null }> {
    const safe = flags.filter((f) => /^\\?[A-Za-z-]{1,32}$/.test(f)).map((f) => (f.startsWith('\\') ? f : `\\${f}`));
    const r = await this.command(`APPEND ${quote(folder)} (${safe.join(' ')})`, { literal: message, timeoutMs: 120_000 });
    if (r.status !== 'OK') throw new Error(`imap: APPEND refused: ${sanitizeDetail(r.detail)}`);
    const m = /\[APPENDUID\s+\d+\s+(\d+)\]/i.exec(`${r.detail ?? ''} ${r.untagged ?? ''}`);
    return { uid: m ? Number(m[1]) : null };
  }

  /**
   * IDLE until `stop()` is called or the timeout fires. Untagged EXISTS / FETCH / EXPUNGE arrive
   * through `onEvent`. Resolving means "the server or we closed the idle", never "it broke".
   */
  async idle(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.has('IDLE')) throw new Error('imap: the server does not advertise IDLE');
    const done = new Promise<void>((resolve) => {
      this.idleResolve = resolve;
    });
    // these two must be set BEFORE the write: the `+ idling` continuation can arrive during the
    // synchronous write, and the handler checks both (see idleDone)
    this.idleMode = true;
    this.idleAccepted = false;
    let cmd: Promise<ImapResponse>;
    try {
      cmd = this.command('IDLE', { timeoutMs: opts.timeoutMs ?? IDLE_TIMEOUT_MS });
    } catch (e) {
      this.idleMode = false;
      throw e as Error;
    }
    // the continuation `+ idling` resolves idleResolve, which releases `done`
    await Promise.race([done, cmd.then(() => undefined)]);
    if (this.closed) throw new Error('imap: the connection closed while idling');
    await cmd;
  }

  /** true once the server has sent the `+ idling` continuation for the current IDLE. */
  private idleAccepted = false;

  /**
   * Leave IDLE (the caller awaits the outstanding `idle()` after this).
   *
   * DONE is only sent when the server actually accepted the IDLE: sending it before the continuation
   * makes the server answer a tag that no command owns, and the pending IDLE then sits until its
   * 25-minute timeout. (Found by a test that stopped the push loop before IDLE had been accepted.)
   */
  idleDone(): void {
    if (!this.closed && this.idleAccepted) this.socket.write('DONE\r\n');
    this.idleMode = false;
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT', { timeoutMs: 10_000 });
    } catch {
      /* a server that does not answer LOGOUT is still going to be closed */
    }
    this.closed = true;
  }

  close(): void {
    // settle anything in flight NOW (an IDLE, a pending command): a transport that has been ended by
    // us does not report its own close, and a caller awaiting it would otherwise wait for a timeout
    this.onClosed(new Error('imap: the connection was closed'));
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

export interface SelectInfo {
  path: string;
  exists: number;
  uidValidity: number;
  uidNext: number;
  readOnly: boolean;
  flags: string[];
  permanentFlags: string[];
  highestModSeq: number;
}

/** COPYUID 1 100,101,102 200,201,202 -> {100:200, 101:201, 102:202} */
function readCopyUid(text: string, into: Map<number, number>) {
  const m = /\[COPYUID\s+\d+\s+([\d,:]+)\s+([\d,:]+)\]/i.exec(text);
  if (!m) return;
  const a = expandSet(m[1]);
  const b = expandSet(m[2]);
  for (let i = 0; i < Math.min(a.length, b.length); i++) into.set(a[i], b[i]);
}

/** `100,101:103` -> [100,101,102,103]. Bounded, because a server can send a huge range. */
export function expandSet(s: string, max = 5000): number[] {
  const out: number[] = [];
  for (const part of String(s ?? '').split(',')) {
    const r = /^(\d+):(\d+)$/.exec(part.trim());
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.min(Math.max(a, b), lo + max);
      for (let i = lo; i <= hi; i++) out.push(i);
      continue;
    }
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) out.push(n);
    if (out.length > max) break;
  }
  return out.slice(0, max);
}

/** Sanitize a server-supplied detail string for an error message: text only, capped, no newlines. */
export function sanitizeDetail(s: string | undefined): string {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 200)
    .trim();
}

/** Quote a mailbox name / username per RFC 3501, refusing what cannot be represented. */
export function quote(s: string): string {
  const v = String(s ?? '');
  if (/[\r\n]/.test(v)) throw new Error('imap: refusing a value with a newline (it would inject a command)');
  if (!v) return '""';
  if (/^[A-Za-z0-9._-]+$/.test(v) && !/^\d+$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function unquote(s: string): string {
  const v = String(s ?? '').trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v;
}

// ---------------------------------------------------------------- the connection probe (ticket 35's live half)

/**
 * The live "Test account" probe. Dial, TLS, greeting, capability, auth, open the inbox — reporting
 * the FIRST failing step with the taxonomy from accounts.ts, so the UI can tell the user what to fix.
 */
export async function probeImapConnection(
  opts: { host: string; port: number; tls: MailAccount['tls']; username: string; secret: string; openFolder?: string },
  makeSocket: SocketFactory,
): Promise<ProbeResult> {
  let socket: ImapSocket;
  try {
    socket = await makeSocket({ host: opts.host, port: opts.port, tls: opts.tls });
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    const stage: ImapStep = /tls|certificate|handshake|ssl/.test(msg) ? 'tls' : 'tcp';
    return classifyImapFailure(stage, '');
  }
  const client = new ImapClient(socket, 20_000);
  try {
    await client.greeting(20_000);
  } catch {
    client.close();
    return classifyImapFailure('greeting');
  }
  try {
    await client.capability();
  } catch {
    client.close();
    return classifyImapFailure('capability');
  }
  try {
    if (opts.secret.startsWith('\u0001XOAUTH2\u0001')) await client.authenticateXoauth2(opts.username, opts.secret.slice(9));
    else if (client.has('AUTH=PLAIN')) await client.authenticatePlain(opts.username, opts.secret);
    else await client.login(opts.username, opts.secret);
  } catch (e) {
    client.close();
    return classifyImapFailure('auth', sanitizeDetail((e as Error).message));
  }
  try {
    await client.list('', '*');
    await client.select(opts.openFolder ?? 'INBOX', true);
  } catch (e) {
    client.close();
    return classifyImapFailure('folder', sanitizeDetail((e as Error).message));
  }
  await client.logout();
  client.close();
  return { ok: true, step: 'done', message: `connected to ${opts.host}:${opts.port} and opened the mailbox` };
}

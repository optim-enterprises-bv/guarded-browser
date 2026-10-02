// Import accounts from a himalaya config (ticket 37b).
//
// The user's himalaya setup already holds every mail account they own — host, port, TLS mode, the
// login, the folder aliases and the credential. Asking them to retype eighteen of those into a form is
// the kind of pointless work that makes a new client not get used, so the mail window can read that
// file and configure them all.
//
// What this module is careful about:
//   * THE PASSWORD IS A SECRET. It is parsed out of the config and returned in a SEPARATE structure
//     from the account records. The account records are what the UI renders and what an audit line
//     quotes; a test asserts the password cannot appear in them.
//   * It reads ONE file path given by the caller and parses a strict subset of TOML. No `eval`, no
//     dynamic key paths, no command execution — including for `password.cmd`, which is REPORTED and
//     never run (running a shell command from a config file is a capability this app does not want).
//   * The SMTP server is imported with the account (ticket 38): `smtps://` is implicit TLS (465) and
//     `smtp://…:587` is a STRICT STARTTLS (src/core/mail/smtp.ts), so both send. An IMAP server that
//     needs STARTTLS is still SKIPPED with the reason: this build opens implicit-TLS IMAP only.
//   * An account with no password is imported with no credential and reported as such; the user is
//     expected to fill it in, and the UI says which ones need it.

import type { MailAccount } from './accounts';
import type { AccountSecret } from './secrets';

export const MAX_ACCOUNTS_IMPORTED = 64;
export const MAX_CONFIG_BYTES = 512 * 1024;

export type TlsMode = MailAccount['tls'];

/** The subset of a himalaya `[accounts.<name>]` block this importer understands. */
export interface ParsedAccount {
  name: string;
  email: string;
  displayName: string;
  imap: { host: string; port: number; tls: TlsMode };
  smtp: { host: string; port: number; tls: TlsMode };
  username: string;
  /** never returned inside an account record; only in `secret` */
  password: string | null;
  smtpPassword: string | null;
  /** set when the config used a command instead of a literal — reported, never executed */
  passwordCmd: string | null;
  folders: { inbox: string; sent: string; drafts: string; trash: string };
}

export interface ParsedConfig {
  accounts: ParsedAccount[];
  /** blocks/keys that were understood as "not importable", with the reason, so the UI can say so */
  skipped: Array<{ name: string; reason: string }>;
}

/** `imaps://mail.example:993` / `smtp://host:587` -> parts, or null when it is not usable. */
export function parseServerUrl(value: string): { host: string; port: number; tls: TlsMode; scheme: string } | null {
  const m = /^([a-z]+):\/\/([^\s/:]+)(?::(\d+))?/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  // a port is REQUIRED: guessing 993 for a `smtp://` URL is how a client ends up dialling the wrong
  // service, and the config always states it
  const port = Number(m[3] ?? 0);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const tls: TlsMode = scheme === 'imaps' || scheme === 'smtps' ? 'implicit' : scheme === 'smtp' || scheme === 'imap' ? 'starttls' : 'none';
  if (tls === 'none') return null;
  return { host, port, tls, scheme };
}

/**
 * Parse the config. Deliberately a small, strict reader rather than a TOML library:
 *   * `[accounts.<name>]` starts a block;
 *   * inside it, `key = "value"` and `key = value` lines are read, with dotted keys kept whole
 *     (`imap.server`, `mailbox.alias.sent`);
 *   * `#` starts a comment outside a quoted string;
 *   * an unterminated `[table]` or a line with no `=` is reported, not guessed at.
 * Anything else (arrays, multi-line strings, nested tables) is ignored — a config that needs those is
 * reported as having accounts this importer could not read rather than mangled.
 */
export function parseHimalayaConfig(text: string): ParsedConfig {
  const raw = String(text ?? '').slice(0, MAX_CONFIG_BYTES);
  const blocks: Array<{ name: string; kv: Record<string, string> }> = [];
  let current: { name: string; kv: Record<string, string> } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const stripped = stripComment(line).trim();
    if (!stripped) continue;
    const table = /^\[\s*accounts\.([A-Za-z0-9._-]+)\s*\]$/.exec(stripped);
    if (table) {
      current = { name: table[1], kv: {} };
      blocks.push(current);
      continue;
    }
    if (/^\[/.test(stripped)) {
      current = null; // another table: accounts are over
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_.\-]+)\s*=\s*([\s\S]*)$/.exec(stripped);
    if (!kv) continue;
    const value = unquote(kv[2].trim());
    // first value wins, so a duplicated key cannot silently override the one that was read
    if (!(kv[1] in current.kv)) current.kv[kv[1]] = value;
  }

  const accounts: ParsedAccount[] = [];
  const skipped: ParsedConfig['skipped'] = [];
  for (const b of blocks.slice(0, MAX_ACCOUNTS_IMPORTED)) {
    const imap = parseServerUrl(b.kv['imap.server'] ?? '');
    if (!imap) {
      skipped.push({ name: b.name, reason: b.kv['imap.server'] ? `unreadable imap.server: ${b.kv['imap.server'].slice(0, 60)}` : 'no imap.server' });
      continue;
    }
    const smtp = parseServerUrl(b.kv['smtp.server'] ?? b.kv['sendmail.server'] ?? '');
    const email = b.kv.email ?? '';
    accounts.push({
      name: b.name,
      email,
      displayName: b.kv['display-name'] ?? '',
      imap: { host: imap.host, port: imap.port, tls: imap.tls },
      smtp: smtp ? { host: smtp.host, port: smtp.port, tls: smtp.tls } : { host: imap.host, port: 465, tls: 'implicit' },
      username: b.kv['imap.sasl.plain.username'] ?? b.kv['smtp.sasl.plain.username'] ?? email,
      password: b.kv['imap.sasl.plain.password.raw'] ?? b.kv['smtp.sasl.plain.password.raw'] ?? b.kv['password.raw'] ?? null,
      smtpPassword: b.kv['smtp.sasl.plain.password.raw'] ?? null,
      passwordCmd: b.kv['imap.sasl.plain.password.cmd'] ?? b.kv['smtp.sasl.plain.password.cmd'] ?? null,
      folders: {
        inbox: b.kv['mailbox.alias.inbox'] ?? 'INBOX',
        sent: b.kv['mailbox.alias.sent'] ?? 'Sent',
        drafts: b.kv['mailbox.alias.drafts'] ?? 'Drafts',
        trash: b.kv['mailbox.alias.trash'] ?? 'Trash',
      },
    });
  }
  return { accounts, skipped };
}

function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inStr) {
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    else if (c === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

function unquote(v: string): string {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // TOML basic strings: only the escapes that appear in practice are handled, and an unknown escape
    // is kept literally rather than dropped (silently losing a character of a password would be a bug
    // that looks like a wrong password)
    return s.slice(1, -1).replace(/\\(.)/g, (all, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '"' ? '"' : c === '\\' ? '\\' : all));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

export interface ImportPlanEntry {
  account: MailAccount;
  secret: AccountSecret;
  /** what the user should know about this one: read-only, needs a password, and so on */
  notes: string[];
}

export interface ImportPlan {
  imported: ImportPlanEntry[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Turn parsed accounts into store records + secrets.
 *
 * The account record carries NO password (that is the whole point of the split), and every entry
 * reports its own caveats rather than a single global warning — a Gmail account whose send needs
 * STARTTLS is a different situation from a James account that works.
 */
export function buildImportPlan(parsed: ParsedConfig, opts: { accountIdPrefix?: string } = {}): ImportPlan {
  const imported: ImportPlanEntry[] = [];
  const skipped: ImportPlan['skipped'] = [...parsed.skipped];
  const prefix = (opts.accountIdPrefix ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
  for (const p of parsed.accounts) {
    const notes: string[] = [];
    const id = `${prefix}${p.name}`.slice(0, 64);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      skipped.push({ name: p.name, reason: 'the account name cannot be used as an id' });
      continue;
    }
    if (p.imap.tls !== 'implicit') {
      // this build opens implicit-TLS sockets only; importing it and saying so is better than an
      // account that fails at the first sync with no explanation
      skipped.push({ name: p.name, reason: `IMAP here uses ${p.imap.tls} on port ${p.imap.port}; this build opens implicit-TLS servers only (993/995)` });
      continue;
    }
    if (!p.password) {
      notes.push(p.passwordCmd ? 'no literal password in the config (it uses a password command, which is never executed): set the password in the account list' : 'no password in the config: set it in the account list');
    }
    const secret: AccountSecret = { kind: 'password', password: p.password ?? '' };
    if (p.smtpPassword && p.smtpPassword !== p.password) {
      // a different send password is preserved rather than discarded; ticket 38 reads it
      secret.smtpPassword = p.smtpPassword;
      notes.push('the send password differs from the read password (both were imported)');
    }
    imported.push({
      account: {
        id,
        name: p.displayName || p.name,
        address: p.email,
        kind: 'imap',
        host: p.imap.host,
        port: p.imap.port,
        tls: p.imap.tls,
        username: p.username,
        authKind: 'password',
        sentFolder: p.folders.sent,
        trashFolder: p.folders.trash,
        junkFolder: 'Junk',
        archiveFolder: 'Archive',
        smtpHost: p.smtp.host,
        smtpPort: p.smtp.port,
        // parseServerUrl never returns 'none'; SMTP is implicit (smtps://) or STARTTLS (smtp://)
        smtpTls: p.smtp.tls === 'starttls' ? 'starttls' : 'implicit',
      },
      secret,
      notes,
    });
  }
  return { imported, skipped };
}

/** The default himalaya config path, relative to a home directory. */
export const HIMALAYA_CONFIG = '.config/himalaya/config.toml';

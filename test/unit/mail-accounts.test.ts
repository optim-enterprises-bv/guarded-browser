// Ticket 35 — account records and the secret store.
//
// The security properties under test here are the ones a mail client gets wrong:
//   * a secret is never readable from the file it lives in without the key;
//   * a wrong passphrase fails CLOSED (no plaintext fallback, no "empty store" pretence);
//   * 'os' mode refuses to exist when Electron's backend is `basic_text` (a hardcoded key is not a
//     keyring, and saying otherwise would make the user's choice meaningless);
//   * the OAuth flow is PKCE with a state check, and the token request never leaks the code or the
//     secret through an error string;
//   * an account record cannot carry a password, and a plaintext login is refused unless the user
//     deliberately chose a plaintext socket.

import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SecretStore, SECRETS_FILE, KDF, KDF_LIMITS, CHECK_PLAINTEXT, plaintextWarning, keychainBackend, canUseMode, safeKdfParams, deriveKey, MAX_SECRET_BYTES } from '../../src/main/mail/secrets';
import { MailAccountSchema, normalizeAccount, foldersToWatch, makePkce, buildAuthUrl, parseCallback, exchangeCode, refreshAccessToken, testAccount, classifyImapFailure, TOKEN_URL_RE, PRESETS } from '../../src/main/mail/accounts';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gb-mailsec-'));
const PASS = 'correct horse battery staple';

// ------------------------------------------------------------------ the store

describe('secret store (35) — modes and honesty about the keyring', () => {
  it('a fresh passphrase store needs a passphrase to read anything back', () => {
    const f = join(tmp(), SECRETS_FILE);
    const o = SecretStore.open(f, { mode: 'passphrase' });
    if (!o.ok) throw new Error(o.error);
    const s = o.store;
    expect(s.locked).toBe(true);
    expect(s.set('a1', { kind: 'password', password: 'hunter2' }).ok).toBe(false);
    expect(s.initPassphrase('short').ok).toBe(false);
    expect(s.initPassphrase(PASS).ok).toBe(true);
    expect(s.locked).toBe(false);
    expect(s.set('a1', { kind: 'password', password: 'hunter2' }).ok).toBe(true);
    expect(s.get('a1')!.password).toBe('hunter2');
  });

  it('the file on disk holds NEITHER the password NOR the passphrase', () => {
    const f = join(tmp(), SECRETS_FILE);
    const o = SecretStore.open(f, { mode: 'passphrase' });
    if (!o.ok) throw new Error(o.error);
    o.store.initPassphrase(PASS);
    o.store.set('a1', { kind: 'password', password: 'hunter2' });
    const raw = readFileSync(f, 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain(PASS);
    expect(raw).toContain('"mode":"passphrase"');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('reopening without unlocking gives locked, not an empty-looking store', () => {
    const f = join(tmp(), SECRETS_FILE);
    const a = SecretStore.open(f, { mode: 'passphrase' });
    if (!a.ok) throw new Error(a.error);
    a.store.initPassphrase(PASS);
    a.store.set('a1', { kind: 'password', password: 'p' });
    const b = SecretStore.open(f, { mode: 'passphrase' });
    if (!b.ok) throw new Error(b.error);
    expect(b.store.locked).toBe(true);
    expect(b.store.get('a1')).toBeNull(); // cannot read it, and does not pretend it is absent-and-fine
    expect(b.store.accountIds).toEqual(['a1']); // but it knows the account exists
  });

  it('the right passphrase unlocks and the wrong one fails closed', () => {
    const f = join(tmp(), SECRETS_FILE);
    const a = SecretStore.open(f, { mode: 'passphrase' });
    if (!a.ok) throw new Error(a.error);
    a.store.initPassphrase(PASS);
    a.store.set('a1', { kind: 'password', password: 'p' });
    const b = SecretStore.open(f, { mode: 'passphrase' });
    if (!b.ok) throw new Error(b.error);
    const bad = b.store.unlock('not the passphrase');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('wrong master passphrase');
    expect(b.store.locked).toBe(true);
    expect(b.store.get('a1')).toBeNull();
    expect(b.store.unlock(PASS).ok).toBe(true);
    expect(b.store.get('a1')!.password).toBe('p');
  });

  it('a tampered ciphertext is refused, not returned as garbage', () => {
    const f = join(tmp(), SECRETS_FILE);
    const a = SecretStore.open(f, { mode: 'passphrase' });
    if (!a.ok) throw new Error(a.error);
    a.store.initPassphrase(PASS);
    a.store.set('a1', { kind: 'password', password: 'p' });
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    const ct = Buffer.from(raw.secrets.a1.ct, 'base64');
    ct[0] ^= 0xff;
    raw.secrets.a1.ct = ct.toString('base64');
    writeFileSync(f, JSON.stringify(raw));
    const b = SecretStore.open(f, { mode: 'passphrase' });
    if (!b.ok) throw new Error(b.error);
    expect(b.store.unlock(PASS).ok).toBe(true);
    expect(b.store.get('a1')).toBeNull(); // AEAD tag check failed
  });

  it('re-keying re-encrypts every secret under the new passphrase', () => {
    const dir = tmp();
    const f = join(dir, SECRETS_FILE);
    const a = SecretStore.open(f, { mode: 'passphrase' });
    if (!a.ok) throw new Error(a.error);
    a.store.initPassphrase(PASS);
    a.store.set('a1', { kind: 'password', password: 'one' });
    a.store.set('a2', { kind: 'oauth', refreshToken: 'rt' });
    const r = a.store.rekey(PASS, 'a different master passphrase');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reencrypted).toBe(2);
    const b = SecretStore.open(f, { mode: 'passphrase' });
    if (!b.ok) throw new Error(b.error);
    expect(b.store.unlock(PASS).ok).toBe(false);
    expect(b.store.unlock('a different master passphrase').ok).toBe(true);
    expect(b.store.get('a1')!.password).toBe('one');
    expect(b.store.get('a2')!.refreshToken).toBe('rt');
  });

  it('a KDF whose parameters are hostile is bounded, and a wrong parameter set is refused', () => {
    const f = join(tmp(), SECRETS_FILE);
    const a = SecretStore.open(f, { mode: 'passphrase' });
    if (!a.ok) throw new Error(a.error);
    a.store.initPassphrase(PASS);
    a.store.set('a1', { kind: 'password', password: 'p' });
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    // an attacker-supplied N of 2^30 would hang the app for hours if it were used unchecked
    raw.kdf.N = 1 << 30;
    writeFileSync(f, JSON.stringify(raw));
    const b = SecretStore.open(f, { mode: 'passphrase' });
    if (!b.ok) throw new Error(b.error);
    const r = b.store.unlock(PASS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('key-derivation parameters');
    expect(safeKdfParams({ algo: 'scrypt', N: KDF_LIMITS.N * 2, r: 8, p: 1, salt: 'AAAA' + 'A'.repeat(12) })).toBeNull();
    expect(safeKdfParams({ algo: 'pbkdf2', N: 16384, r: 8, p: 1, salt: 'AAAA' + 'A'.repeat(12) })).toBeNull();
    expect(safeKdfParams({ algo: 'scrypt', N: 16384, r: 8, p: 1, salt: 'AAAA' })).toBeNull(); // salt too short
  });

  it('plaintext mode is explicit, warned about, and still readable', () => {
    const f = join(tmp(), SECRETS_FILE);
    const o = SecretStore.open(f, { mode: 'plaintext' });
    if (!o.ok) throw new Error(o.error);
    const s = o.store;
    expect(s.isPlaintext).toBe(true);
    expect(s.locked).toBe(false);
    expect(s.set('a1', { kind: 'password', password: 'hunter2' }).ok).toBe(true);
    expect(s.get('a1')!.password).toBe('hunter2');
    expect(readFileSync(f, 'utf8')).toContain('"mode":"plaintext"');
    expect(plaintextWarning()).toContain('PLAINTEXT');
    // and the file is still 0600
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('os mode refuses on this box, because Electron reports basic_text (a hardcoded key)', () => {
    const backend = keychainBackend({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' });
    expect(backend.available).toBe(false);
    const r = canUseMode('os', backend);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('basic_text');
    const o = SecretStore.open(join(tmp(), SECRETS_FILE), { mode: 'os', safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
    expect(o.ok).toBe(false);
  });

  it('os mode works when a real keyring is reported, and the data key is what gets wrapped', () => {
    const f = join(tmp(), SECRETS_FILE);
    const fake = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (s: string) => Buffer.from(`WRAP:${s}`),
      decryptString: (b: Buffer) => b.toString().replace(/^WRAP:/, ''),
    };
    const o = SecretStore.open(f, { mode: 'os', safeStorage: fake });
    if (!o.ok) throw new Error(o.error);
    o.store.set('a1', { kind: 'password', password: 'hunter2' });
    expect(o.store.get('a1')!.password).toBe('hunter2');
    const raw = readFileSync(f, 'utf8');
    expect(raw).not.toContain('hunter2'); // the data key did the work, not safeStorage per-secret
    const b = SecretStore.open(f, { mode: 'os', safeStorage: fake });
    if (!b.ok) throw new Error(b.error);
    expect(b.store.unlock('', fake).ok).toBe(true);
    expect(b.store.get('a1')!.password).toBe('hunter2');
  });

  it('describe() cannot leak a secret and is what diagnostics use', () => {
    const o = SecretStore.open(join(tmp(), SECRETS_FILE), { mode: 'passphrase' });
    if (!o.ok) throw new Error(o.error);
    o.store.initPassphrase(PASS);
    o.store.set('a1', { kind: 'password', password: 'hunter2' });
    const d = JSON.stringify(o.store.describe());
    expect(d).not.toContain('hunter2');
    expect(d).toContain('"mode":"passphrase"');
  });

  it('refuses a secret that is too large and an oauth secret with no refresh token', () => {
    const o = SecretStore.open(join(tmp(), SECRETS_FILE), { mode: 'plaintext' });
    if (!o.ok) throw new Error(o.error);
    expect(o.store.set('a1', { kind: 'password', password: 'x'.repeat(MAX_SECRET_BYTES + 10) }).ok).toBe(false);
    expect(o.store.set('a1', { kind: 'oauth', refreshToken: '' }).ok).toBe(false);
    expect(o.store.set('', { kind: 'password', password: 'x' }).ok).toBe(false);
  });

  it('removing an account removes exactly its secret', () => {
    const o = SecretStore.open(join(tmp(), SECRETS_FILE), { mode: 'plaintext' });
    if (!o.ok) throw new Error(o.error);
    o.store.set('a1', { kind: 'password', password: 'a' });
    o.store.set('a2', { kind: 'password', password: 'b' });
    expect(o.store.remove('a1')).toEqual({ removed: true });
    expect(o.store.remove('a1')).toEqual({ removed: false });
    expect(o.store.get('a1')).toBeNull();
    expect(o.store.get('a2')!.password).toBe('b');
  });

  it('a corrupt secrets file does not become a silent empty store', () => {
    const f = join(tmp(), SECRETS_FILE);
    writeFileSync(f, 'garbage');
    const o = SecretStore.open(f, { mode: 'passphrase' });
    if (!o.ok) throw new Error(o.error);
    expect(o.store.loadError).toBeTruthy();
  });

  it('derives a key of the declared length from the declared parameters', () => {
    const salt = Buffer.alloc(24, 7);
    const k = deriveKey('pw', { N: KDF.N, r: KDF.r, p: KDF.p, salt });
    expect(k.length).toBe(KDF.keylen);
    expect(deriveKey('pw', { N: KDF.N, r: KDF.r, p: KDF.p, salt }).equals(k)).toBe(true);
    expect(deriveKey('pw2', { N: KDF.N, r: KDF.r, p: KDF.p, salt }).equals(k)).toBe(false);
    expect(CHECK_PLAINTEXT).toContain('guarded-browser');
  });
});

// ------------------------------------------------------------------ accounts

const account = (over: Record<string, unknown> = {}) => ({
  id: 'work',
  name: 'Work',
  address: 'me@example.com',
  kind: 'imap',
  host: 'imap.example.com',
  port: 993,
  tls: 'implicit',
  username: 'me',
  authKind: 'password',
  sentFolder: 'Sent',
  trashFolder: 'Trash',
  junkFolder: 'Junk',
  archiveFolder: 'Archive',
  ...over,
});

describe('accounts (35) — validation refuses what cannot work', () => {
  it('accepts a well-formed IMAP account and refuses unknown keys (a settings file cannot add fields)', () => {
    expect(normalizeAccount(account()).ok).toBe(true);
    expect(normalizeAccount({ ...account(), password: 'hunter2' }).ok).toBe(false);
    expect(MailAccountSchema.safeParse({ ...account(), skipGate: true }).success).toBe(false);
  });

  it('fills the default port for the account kind but never guesses a host', () => {
    const a = normalizeAccount(account({ port: 0 }));
    if (!a.ok) throw new Error(a.error);
    expect(a.account.port).toBe(993);
    expect(normalizeAccount(account({ host: '' })).ok).toBe(false);
    expect(normalizeAccount(account({ host: 'imap.example.com/../x' })).ok).toBe(false);
    expect(normalizeAccount(account({ host: 'user@host' })).ok).toBe(false);
  });

  it('refuses a plaintext password login but allows a deliberate plaintext socket with an app password', () => {
    expect(normalizeAccount(account({ tls: 'none' })).ok).toBe(false);
    expect(normalizeAccount(account({ tls: 'starttls', port: 143 })).ok).toBe(true);
    expect(normalizeAccount(account({ tls: 'none', authKind: 'app-password' })).ok).toBe(true);
  });

  it('an OAuth account needs a client id and https endpoints', () => {
    const oauth = { clientId: 'cid', tokenUrl: 'https://oauth.example/token', authUrl: 'https://oauth.example/auth', scope: 'mail' };
    expect(normalizeAccount(account({ authKind: 'oauth', oauth })).ok).toBe(true);
    expect(normalizeAccount(account({ authKind: 'oauth', oauth: { ...oauth, clientId: '' } })).ok).toBe(false);
    expect(normalizeAccount(account({ authKind: 'oauth', oauth: { ...oauth, tokenUrl: 'http://evil.example/token' } })).ok).toBe(false);
    expect(normalizeAccount(account({ authKind: 'oauth', oauth: { ...oauth, authUrl: 'javascript:alert(1)' } })).ok).toBe(false);
    // OAuth against POP3 is refused rather than silently attempted
    expect(normalizeAccount(account({ kind: 'pop3', authKind: 'oauth', oauth })).ok).toBe(false);
  });

  it('the account record cannot carry a secret field of any name', () => {
    for (const k of ['password', 'token', 'refreshToken', 'secret', 'appPassword']) {
      expect(MailAccountSchema.safeParse({ ...account(), [k]: 'x' }).success).toBe(false);
    }
  });

  it('watches the folders the account declared, without duplicates', () => {
    const a = normalizeAccount(account({ sentFolder: 'INBOX' }));
    if (!a.ok) throw new Error(a.error);
    expect(foldersToWatch(a.account)).toEqual(['INBOX', 'Trash', 'Junk', 'Archive']);
  });

  it('the provider presets are all valid accounts once a host is given', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const r = normalizeAccount({ id: 'x', address: 'a@b.c', username: 'u', host: 'h.example', ...preset });
      expect(r.ok, name).toBe(true);
    }
  });
});

describe('accounts (35) — OAuth PKCE', () => {
  const oauthAccount = () => {
    const r = normalizeAccount(account({ authKind: 'oauth', oauth: { clientId: 'cid', tokenUrl: 'https://oauth.example/token', authUrl: 'https://oauth.example/auth', scope: 'mail' } }));
    if (!r.ok) throw new Error(r.error);
    return r.account;
  };

  it('builds an authorize URL with S256 and a state, and refuses a non-loopback redirect', () => {
    const a = oauthAccount();
    const pkce = makePkce();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    const r = buildAuthUrl(a, pkce, 'http://127.0.0.1:45999/cb');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = new URL(r.url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(u.searchParams.get('state')).toBe(pkce.state);
    expect(buildAuthUrl(a, pkce, 'https://evil.example/cb').ok).toBe(false);
  });

  it('the callback is refused on a state mismatch, an error, or no code', () => {
    const { state } = makePkce();
    expect(parseCallback(`http://127.0.0.1:1/cb?code=x&state=${state}`, { state }).ok).toBe(true);
    expect(parseCallback('http://127.0.0.1:1/cb?code=x&state=other', { state }).ok).toBe(false);
    expect(parseCallback(`http://127.0.0.1:1/cb?error=access_denied&state=${state}`, { state }).ok).toBe(false);
    expect(parseCallback(`http://127.0.0.1:1/cb?state=${state}`, { state }).ok).toBe(false);
    expect(parseCallback('not a url', { state }).ok).toBe(false);
  });

  it('exchanges the code and REQUIRES a refresh token (offline access was actually granted)', async () => {
    const a = oauthAccount();
    const withRefresh = async () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), { status: 200 });
    const r = await exchangeCode(a, { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: withRefresh as unknown as typeof fetch, now: 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refreshToken).toBe('rt');
      expect(r.expiresAt).toBe(61_000);
    }
    const noRefresh = async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    const r2 = await exchangeCode(a, { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: noRefresh as unknown as typeof fetch });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('refresh token');
  });

  it('a failing token endpoint produces a STATIC error that cannot contain the code or the secret', async () => {
    const a = oauthAccount();
    const boom = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443 for code=SECRETCODE client_secret=SECRETSECRET');
    };
    const r = await exchangeCode(a, { code: 'SECRETCODE', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', clientSecret: 'SECRETSECRET', fetchImpl: boom as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('SECRETCODE');
      expect(r.error).not.toContain('SECRETSECRET');
    }
    const http500 = async () => new Response('nope', { status: 500 });
    const r2 = await exchangeCode(a, { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: http500 as unknown as typeof fetch });
    expect(r2.ok).toBe(false);
    const malformed = async () => new Response('not json', { status: 200 });
    expect((await exchangeCode(a, { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: malformed as unknown as typeof fetch })).ok).toBe(false);
  });

  it('a refresh that omits a new refresh token keeps the old one (RFC 6749)', async () => {
    const a = oauthAccount();
    const onlyAccess = async () => new Response(JSON.stringify({ access_token: 'at2', expires_in: 10 }), { status: 200 });
    const r = await refreshAccessToken(a, 'old-rt', { fetchImpl: onlyAccess as unknown as typeof fetch, now: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refreshToken).toBe('old-rt');
      expect(r.accessToken).toBe('at2');
    }
  });

  it('refuses an http token endpoint even if an account record somehow held one', async () => {
    const bad = { ...oauthAccount(), oauth: { ...oauthAccount().oauth!, tokenUrl: 'http://evil.example/token' } };
    const r = await exchangeCode(bad, { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(TOKEN_URL_RE.test('http://x/y')).toBe(false);
  });
});

describe('accounts (35) — "test account" reports the exact failing step', () => {
  const a = () => {
    const r = normalizeAccount(account());
    if (!r.ok) throw new Error(r.error);
    return r.account;
  };

  it('names DNS, TCP/TLS, greeting, auth and folder distinctly', () => {
    expect(classifyImapFailure('dns').message).toContain('resolved');
    expect(classifyImapFailure('auth', 'NO invalid credentials').message).toContain('invalid credentials');
    expect(classifyImapFailure('tls').message).toContain('TLS');
    expect(classifyImapFailure('folder').step).toBe('folder');
    expect(classifyImapFailure('auth').ok).toBe(false);
  });

  it('stops at DNS before dialling anything', async () => {
    const r = await testAccount(a(), { kind: 'password', password: 'p' }, { resolve: async () => false, probeImap: async () => ({ ok: true, step: 'done', message: 'should not run' }) });
    expect(r.step).toBe('dns');
  });

  it('reports a missing secret as an auth problem, not a connection problem', async () => {
    const r = await testAccount(a(), null, { probeImap: async () => ({ ok: true, step: 'done', message: '' }) });
    expect(r.step).toBe('auth');
    expect(r.message).toContain('no password');
  });

  it('an oauth account with no token yet says so', async () => {
    const r = normalizeAccount(account({ authKind: 'oauth', oauth: { clientId: 'c', tokenUrl: 'https://o.example/t', authUrl: 'https://o.example/a', scope: 's' } }));
    if (!r.ok) throw new Error(r.error);
    const t = await testAccount(r.account, null, {});
    expect(t.message).toContain('access token');
  });

  it('passes an XOAUTH2 string for an oauth account and the raw password otherwise', async () => {
    const seen: string[] = [];
    const probe = async (o: { secret: string }) => {
      seen.push(o.secret);
      return { ok: true, step: 'done' as const, message: '' };
    };
    const pw = a();
    const r1 = normalizeAccount(account({ authKind: 'oauth', oauth: { clientId: 'c', tokenUrl: 'https://o.example/t', authUrl: 'https://o.example/a', scope: 's' } }));
    if (!r1.ok) throw new Error(r1.error);
    await testAccount(pw, { kind: 'password', password: 'hunter2' }, { probeImap: probe });
    await testAccount(r1.account, { kind: 'oauth', accessToken: 'AT' }, { probeImap: probe, resolve: async () => true });
    expect(seen[0]).toBe('hunter2');
    expect(seen[1]).toContain('XOAUTH2');
    expect(seen[1]).toContain('AT');
  });

  it('a local account has nothing to connect to and says so', async () => {
    const r = normalizeAccount({ ...account(), kind: 'local', host: '', tls: 'none' });
    if (!r.ok) throw new Error(r.error);
    const t = await testAccount(r.account, null, {});
    expect(t.ok).toBe(true);
    expect(t.message).toContain('no server');
  });
});

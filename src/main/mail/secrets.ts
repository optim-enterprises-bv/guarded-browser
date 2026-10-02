// Mail account secrets (ticket 35) — the ONE place a mail password or OAuth refresh token lives.
//
// Probed on this box before writing a line of it: `electron.safeStorage` reports
// `isEncryptionAvailable() === false` with backend `basic_text`, i.e. Chromium's hardcoded fallback
// key. Calling that "encrypted with the OS keyring" would be a lie, and a lie about secret storage
// is worse than plaintext, because it stops the user from making an informed choice.
//
// So the default mode is a PASSPHRASE:
//   scrypt (Node core — argon2 would mean a native addon, which this product does not ship)
//   -> 32-byte key -> AES-256-GCM per secret, fresh 12-byte nonce, auth tag stored.
// The derived key lives in memory for the session only. Nothing derives from `device_id`, nothing is
// hidden, and the file says which mode it is in, so a user can tell by looking.
//
// Modes, chosen explicitly by the user, never by cleverness:
//   'passphrase' — default. No OS keyring needed; the UI says "unlocked for this session".
//   'os'         — only allowed when Electron reports a REAL backend (gnome_libsecret / kwallet*).
//   'plaintext'  — the user says they know. Stored as base64 with a warning, like most Linux clients
//                  that have no keyring. The file carries `"mode": "plaintext"` so it is visible.
//
// What this module must never do:
//   * hand a secret to a renderer, a page, a log or an error message (every error string is static);
//   * let a hostile secrets file DoS the app (KDF parameters are read from the file, so they are
//     bounded before use);
//   * silently downgrade — unlocking a passphrase store with no passphrase fails, it does not fall
//     back to plaintext.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SECRETS_FILE = 'mail-secrets.json';
export const SECRETS_VERSION = 1;
/** scrypt cost: 128*N*r = 16 MiB and ~60 ms on this box — slow enough to matter, fast enough to use */
export const KDF = { algo: 'scrypt' as const, N: 16_384, r: 8, p: 1, keylen: 32 };
/** bounds applied to parameters read from a file (a hostile file must not be able to hang the app) */
export const KDF_LIMITS = { N: 1 << 20, r: 32, p: 16 };
export const CHECK_PLAINTEXT = 'guarded-browser-mail-secrets-v1';
export const MAX_SECRET_BYTES = 8 * 1024;

export type SecretMode = 'passphrase' | 'os' | 'plaintext';
export type SecretKind = 'password' | 'oauth';

export interface AccountSecret {
  kind: SecretKind;
  /** password / app-password. Never logged, never returned to a renderer. */
  password?: string;
  /**
   * A separate SEND password, when the account has one (an SMTP relay with different credentials, or a
   * provider whose app password is per-service). Read only by the send path (ticket 38); when absent,
   * `password` is used for both.
   */
  smtpPassword?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}

/** an operation with a payload */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
/** an operation that succeeds or explains itself; no payload (an empty object type would be a lie) */
export type Plain = { ok: true } | { ok: false; error: string };

interface Blob {
  iv: string;
  ct: string;
  tag: string;
}

interface SecretsFile {
  version: number;
  mode: SecretMode;
  kdf?: { algo: string; N: number; r: number; p: number; salt: string };
  /** 'os' mode: the data key, encrypted by safeStorage. Only written when Electron reports a REAL backend. */
  osKey?: string;
  check?: Blob;
  secrets: Record<string, Blob>;
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => Buffer.from(String(s ?? ''), 'base64');

function isBlob(x: unknown): x is Blob {
  const b = x as Blob;
  // `tag` may be empty ONLY in plaintext mode (base64 with no AEAD); length checks happen at decrypt
  return !!b && typeof b.iv === 'string' && typeof b.ct === 'string' && typeof b.tag === 'string' && b.iv.length > 0 && b.ct.length > 0;
}

/** Bounded, non-throwing read of the KDF parameters a file claims to use. */
export function safeKdfParams(k: SecretsFile['kdf']): { N: number; r: number; p: number; salt: Buffer } | null {
  if (!k || k.algo !== 'scrypt') return null;
  const N = Number(k.N);
  const r = Number(k.r);
  const p = Number(k.p);
  if (!Number.isInteger(N) || N < 1024 || N > KDF_LIMITS.N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > KDF_LIMITS.r) return null;
  if (!Number.isInteger(p) || p < 1 || p > KDF_LIMITS.p) return null;
  const salt = unb64(k.salt);
  if (salt.length < 16 || salt.length > 64) return null;
  return { N, r, p, salt };
}

export function deriveKey(passphrase: string, kdf: { N: number; r: number; p: number; salt: Buffer }): Buffer {
  return scryptSync(Buffer.from(String(passphrase ?? ''), 'utf8'), kdf.salt, KDF.keylen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: Math.max(64 * 1024 * 1024, 256 * kdf.N * kdf.r + 32 * 1024 * 1024),
  });
}

/** What Electron's safeStorage is actually backed by, so the UI can be honest about 'os' mode. */
export function keychainBackend(safeStorage?: {
  isEncryptionAvailable?: () => boolean;
  getSelectedStorageBackend?: () => string;
}): { available: boolean; backend: string } {
  try {
    const available = !!safeStorage?.isEncryptionAvailable?.();
    const backend = String(safeStorage?.getSelectedStorageBackend?.() ?? 'unknown');
    // 'basic_text' is Chromium's hardcoded fallback: NOT a keyring, and not user-specific.
    return { available: available && backend !== 'basic_text', backend };
  } catch {
    return { available: false, backend: 'unavailable' };
  }
}

export function canUseMode(mode: SecretMode, backend: { available: boolean; backend: string }): Plain {
  if (mode === 'os' && !backend.available) {
    return {
      ok: false,
      error: `the operating system keyring is not available (Electron reports "${backend.backend}"), so secrets cannot be protected by it — choose a master passphrase or an explicit plaintext store`,
    };
  }
  return { ok: true };
}

export function plaintextWarning(): string {
  return 'PLAINTEXT MODE: mail passwords are stored in a file readable by anyone who can read your home directory. No keyring is available on this system, so the alternatives are a master passphrase (recommended) or this.';
}

/**
 * A secret store for ONE profile. Construct with `open()`, then `unlock()` for passphrase mode.
 * `get()` is the only way out and it is called by the connection code only.
 */
export class SecretStore {
  private data: SecretsFile;
  private key: Buffer | null = null;
  /** set when the file on disk was invalid and has been replaced (the caller reports it) */
  readonly loadError: string | null = null;

  private constructor(
    private readonly file: string,
    data: SecretsFile,
  ) {
    this.data = data;
  }

  static open(
    file: string,
    opts: { mode: SecretMode; safeStorage?: { isEncryptionAvailable?: () => boolean; getSelectedStorageBackend?: () => string; encryptString?: (s: string) => Buffer; decryptString?: (b: Buffer) => string } } = { mode: 'passphrase' },
  ): Result<{ store: SecretStore }> {
    if (opts.mode === 'os') {
      const r = canUseMode('os', keychainBackend(opts.safeStorage));
      if (!r.ok) return r;
    }
    // Existing AND non-empty decides "there is something to read". (An earlier draft touched the file
    // to fix its mode first, which made every fresh store look like an empty existing one — the store
    // then came back LOCKED with no key, and every `set` failed with a confusing error.)
    const hasContent = file !== ':memory:' && existsSync(file) && statSync(file).size > 0;
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
      try {
        // 0600 BEFORE any content: SQLite's umask lesson from ticket 34, applied here on purpose
        if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
        chmodSync(file, 0o600);
      } catch {
        /* the read below reports the real problem */
      }
    }
    if (hasContent) {
      let parsed: SecretsFile | null = null;
      let loadError: string | null = null;
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as SecretsFile;
        if (raw && typeof raw === 'object' && raw.version === SECRETS_VERSION && (raw.mode === 'passphrase' || raw.mode === 'os' || raw.mode === 'plaintext')) {
          parsed = { version: raw.version, mode: raw.mode, kdf: raw.kdf, check: raw.check, osKey: raw.osKey, secrets: {} };
          for (const [k, v] of Object.entries(raw.secrets ?? {})) if (isBlob(v)) parsed.secrets[k] = v;
        } else {
          loadError = 'unsupported or invalid secrets file';
        }
      } catch (e) {
        loadError = (e as Error).message;
      }
      if (parsed) {
        const s = new SecretStore(file, parsed);
        // loadError is readonly-assigned in the constructor path below
        (s as unknown as { loadError: string | null }).loadError = loadError;
        return { ok: true, store: s };
      }
      // A corrupt file is NOT overwritten silently: the caller decides (and says so in the UI),
      // but a store that cannot be read must not look like an empty one either.
      const fresh = new SecretStore(file, blank(opts.mode));
      (fresh as unknown as { loadError: string | null }).loadError = loadError ?? 'unreadable';
      return { ok: true, store: fresh };
    }
    const s = new SecretStore(file, blank(opts.mode));
    if (opts.mode === 'os') {
      const k = s.initOsKey(opts.safeStorage);
      if (!k.ok) return k;
    }
    s.save();
    return { ok: true, store: s };
  }

  /**
   * 'os' mode: a random data key, wrapped by safeStorage. This indirection is deliberate — the
   * wrapped key is what safeStorage protects, so a future keyring backend does not require re-sealing
   * every message-account secret.
   */
  private initOsKey(safeStorage?: { encryptString?: (s: string) => Buffer }): Plain {
    if (this.data.mode !== 'os') return { ok: false, error: 'not a keyring-backed store' };
    if (!safeStorage?.encryptString) return { ok: false, error: 'the operating system keyring cannot encrypt: unavailable in this session' };
    try {
      const dataKey = randomBytes(32);
      this.data.osKey = b64(safeStorage.encryptString(b64(dataKey)));
      this.key = dataKey;
      this.data.check = seal(dataKey, CHECK_PLAINTEXT);
      this.save();
      return { ok: true };
    } catch {
      return { ok: false, error: 'the operating system keyring refused to encrypt the mail key' };
    }
  }

  get mode(): SecretMode {
    return this.data.mode;
  }

  get isPlaintext(): boolean {
    return this.data.mode === 'plaintext';
  }

  /** passphrase / os modes need the key before any secret can be read or written */
  get locked(): boolean {
    return this.data.mode !== 'plaintext' && this.key === null;
  }

  get accountIds(): string[] {
    return Object.keys(this.data.secrets).sort();
  }

  hasCheck(): boolean {
    return !!this.data.check;
  }

  /**
   * Unlock (passphrase mode). The correctness of the passphrase is proven by decrypting the check
   * record, so a wrong passphrase is a precise error here instead of an auth failure at the server.
   */
  unlock(passphrase: string, safeStorage?: { decryptString?: (b: Buffer) => string }): Plain {
    // plaintext needs no key; 'os' mode needs the keyring, NOT a passphrase (an earlier draft demanded
    // a passphrase for os mode too, which made a keyring-backed store impossible to open)
    if (this.data.mode === 'plaintext') return { ok: true };
    if (this.data.mode === 'os') {
      const key = this.osKey(safeStorage);
      if (!key) return { ok: false, error: 'the operating system keyring could not be read' };
      this.key = key;
      return { ok: true };
    }
    if (typeof passphrase !== 'string' || !passphrase) return { ok: false, error: 'a master passphrase is required' };
    const kdf = safeKdfParams(this.data.kdf);
    if (!kdf) return { ok: false, error: 'the secrets file has invalid key-derivation parameters' };
    const key = deriveKey(passphrase, kdf);
    if (this.data.check) {
      const out = open(key, this.data.check);
      const want = Buffer.from(CHECK_PLAINTEXT);
      const got = out === null ? Buffer.alloc(0) : Buffer.from(out);
      // timingSafeEqual throws on a length mismatch, so the length is compared first
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        this.key = null;
        return { ok: false, error: 'wrong master passphrase' };
      }
    } else {
      // no check record yet: this IS the check (and it is recorded below)
      this.data.check = seal(key, CHECK_PLAINTEXT);
    }
    this.key = key;
    this.save();
    return { ok: true };
  }

  /** Create the master key for a fresh passphrase store (no-op if already unlocked). */
  initPassphrase(passphrase: string): Plain {
    if (this.data.mode === 'plaintext') return { ok: false, error: 'this store is in plaintext mode' };
    if (typeof passphrase !== 'string' || passphrase.length < 8) return { ok: false, error: 'choose a master passphrase of at least 8 characters (it protects every mail password)' };
    this.data.mode = 'passphrase';
    this.data.kdf = { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: b64(randomBytes(24)) };
    this.key = deriveKey(passphrase, { N: KDF.N, r: KDF.r, p: KDF.p, salt: unb64(this.data.kdf.salt) });
    this.data.check = seal(this.key, CHECK_PLAINTEXT);
    this.data.secrets = {};
    this.save();
    return { ok: true };
  }

  /** Replace the master passphrase, re-encrypting every stored secret under the new key. */
  rekey(currentPassphrase: string, nextPassphrase: string): Result<{ reencrypted: number }> {
    if (this.data.mode === 'plaintext') return { ok: false, error: 'this store is in plaintext mode' };
    const opened = this.unlock(currentPassphrase);
    if (!opened.ok) return { ok: false, error: opened.error };
    const all: Record<string, Blob> = { ...this.data.secrets };
    const plain: Record<string, AccountSecret> = {};
    for (const [id, blob] of Object.entries(all)) {
      const s = this.readBlob(blob);
      if (!s) return { ok: false, error: 'a stored secret could not be decrypted; refusing to re-key a broken store' };
      plain[id] = s;
    }
    if (typeof nextPassphrase !== 'string' || nextPassphrase.length < 8) return { ok: false, error: 'choose a master passphrase of at least 8 characters' };
    this.data.kdf = { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: b64(randomBytes(24)) };
    this.key = deriveKey(nextPassphrase, { N: KDF.N, r: KDF.r, p: KDF.p, salt: unb64(this.data.kdf.salt) });
    this.data.check = seal(this.key, CHECK_PLAINTEXT);
    this.data.secrets = {};
    for (const [id, s] of Object.entries(plain)) this.write(id, s);
    this.save();
    return { ok: true, reencrypted: Object.keys(plain).length };
  }

  set(accountId: string, secret: AccountSecret): Plain {
    const id = String(accountId ?? '').trim().slice(0, 64);
    if (!id) return { ok: false, error: 'account id required' };
    const kind: SecretKind = secret.kind === 'oauth' ? 'oauth' : 'password';
    const payload: AccountSecret = { kind };
    if (kind === 'password' && typeof secret.smtpPassword === 'string' && secret.smtpPassword) payload.smtpPassword = secret.smtpPassword;
    if (kind === 'oauth') {
      if (typeof secret.refreshToken !== 'string' || !secret.refreshToken) return { ok: false, error: 'an OAuth account needs a refresh token' };
      payload.refreshToken = secret.refreshToken;
      if (secret.accessToken) payload.accessToken = secret.accessToken;
      if (typeof secret.expiresAt === 'number') payload.expiresAt = secret.expiresAt;
    } else {
      if (typeof secret.password !== 'string' || !secret.password) return { ok: false, error: 'a password is required' };
      payload.password = secret.password;
    }
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > MAX_SECRET_BYTES) return { ok: false, error: 'secret is too large' };
    if (this.locked) return { ok: false, error: 'the mail secret store is locked' };
    this.write(id, payload);
    this.save();
    return { ok: true };
  }

  /** The only reader. Called by the connection code; never by a renderer or an IPC reply. */
  get(accountId: string): AccountSecret | null {
    const id = String(accountId ?? '').trim().slice(0, 64);
    const blob = id ? this.data.secrets[id] : undefined;
    if (!blob) return null;
    return this.readBlob(blob);
  }

  remove(accountId: string): { removed: boolean } {
    const id = String(accountId ?? '').trim().slice(0, 64);
    const had = !!this.data.secrets[id];
    if (had) {
      delete this.data.secrets[id];
      this.save();
    }
    return { removed: had };
  }

  clear() {
    this.data.secrets = {};
    this.save();
  }

  /**
   * Switch this store to plaintext, at the user's explicit request.
   *
   * This rewrites every stored secret as base64 in a 0600 file. It exists because on a machine with no
   * keyring (see `keychainBackend`) the honest alternatives are a master passphrase or plaintext —
   * and refusing to offer the second is what drives users to store credentials in a text file next to
   * the app. It is audited and warned about, never automatic.
   */
  makePlaintext(): Plain {
    const current = Object.entries(this.data.secrets);
    const plain: Record<string, string> = {};
    for (const [id] of current) {
      const s = this.readBlob(this.data.secrets[id]);
      if (!s) return { ok: false, error: 'a stored secret could not be decrypted; refusing to rewrite the store' };
      plain[id] = JSON.stringify(s);
    }
    this.data.mode = 'plaintext';
    delete this.data.kdf;
    delete this.data.check;
    delete this.data.osKey;
    this.key = null;
    this.data.secrets = {};
    for (const [id, json] of Object.entries(plain)) {
      this.data.secrets[id] = { iv: b64(randomBytes(12)), ct: b64(Buffer.from(json, 'utf8')), tag: '' };
    }
    this.save();
    return { ok: true };
  }

  /** Redaction for diagnostics: it is impossible to get a secret out of this by accident. */
  describe(): { mode: SecretMode; locked: boolean; accounts: number } {
    return { mode: this.data.mode, locked: this.locked, accounts: Object.keys(this.data.secrets).length };
  }

  private osKey(safeStorage?: { decryptString?: (b: Buffer) => string }): Buffer | null {
    const keyB64 = this.data.osKey;
    if (!keyB64 || !safeStorage?.decryptString) return null;
    try {
      const k = Buffer.from(safeStorage.decryptString(unb64(keyB64)), 'base64');
      return k.length === 32 ? k : null;
    } catch {
      return null;
    }
  }

  private write(id: string, payload: AccountSecret) {
    const json = JSON.stringify(payload);
    if (this.data.mode === 'plaintext') {
      this.data.secrets[id] = { iv: b64(randomBytes(12)), ct: b64(Buffer.from(json, 'utf8')), tag: '' };
      return;
    }
    if (!this.key) throw new Error('secret store is locked');
    this.data.secrets[id] = seal(this.key, json);
  }

  private readBlob(blob: Blob): AccountSecret | null {
    if (this.data.mode === 'plaintext') {
      try {
        return JSON.parse(unb64(blob.ct).toString('utf8')) as AccountSecret;
      } catch {
        return null;
      }
    }
    if (!this.key) return null;
    const out = open(this.key, blob);
    if (out === null) return null;
    try {
      const s = JSON.parse(out) as AccountSecret;
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  private save() {
    if (this.file === ':memory:') return;
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function blank(mode: SecretMode): SecretsFile {
  return { version: SECRETS_VERSION, mode, secrets: {} };
}

/** AES-256-GCM. A fresh nonce per record; the tag is stored with it. */
function seal(key: Buffer, plaintext: string): Blob {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

/** Returns null on ANY failure (wrong key, tampered ciphertext, bad base64) — never throws. */
function open_(key: Buffer, blob: Blob): string | null {
  try {
    const iv = unb64(blob.iv);
    const tag = unb64(blob.tag);
    if (iv.length !== 12 || tag.length !== 16) return null;
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(unb64(blob.ct)), d.final()]);
    return out.toString('utf8');
  } catch {
    return null;
  }
}

// `open` is a name used twice above (the static factory and the decryption helper); alias the helper
// so the factory keeps the readable name callers use.
const open = open_;

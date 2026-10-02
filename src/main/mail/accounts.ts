// Mail account records and their validation (ticket 35).
//
// An account record is NOT a secret: host, port, TLS mode, login name, folder mappings and the auth
// KIND live in settings; the password / refresh token lives in the secret store
// (`./secrets.ts`). Keeping the split physical is what makes it possible to say, and test, that a
// settings export or a profile bundle (ticket 30) cannot carry a credential.
//
// OAuth (Gmail / Outlook / Fastmail) is authorization-code + PKCE with a loopback redirect:
//   * the code verifier is generated here, S256-challenged, and never leaves the process;
//   * the authorization code is exchanged for tokens by the MAIN process, not by a page;
//   * the refresh token goes straight into the secret store, never into the browser's cookie jar;
//   * `state` is compared, so a callback for another request is refused.
// The token endpoint is called with an injected `fetchImpl` so the flow is unit-testable against a
// fixture server without a network.

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const MAX_ACCOUNT_NAME = 64;
export const MAX_HOST = 255;
export const MAX_USERNAME = 320;
export const MAX_FOLDERS = 8;
/** every OAuth provider in scope uses https; a cleartext token endpoint would leak the refresh token */
export const TOKEN_URL_RE = /^https:\/\//i;

export const TlsModeSchema = z.enum(['implicit', 'starttls', 'none']);
export const AccountKindSchema = z.enum(['imap', 'pop3', 'local']);
export const AuthKindSchema = z.enum(['password', 'app-password', 'oauth']);

export const MailAccountSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().max(MAX_ACCOUNT_NAME),
    address: z.string().max(320),
    kind: AccountKindSchema,
    host: z.string().max(MAX_HOST),
    port: z.number().int().min(0).max(65535),
    tls: TlsModeSchema,
    username: z.string().max(MAX_USERNAME),
    authKind: AuthKindSchema,
    sentFolder: z.string().max(255),
    trashFolder: z.string().max(255),
    junkFolder: z.string().max(255),
    archiveFolder: z.string().max(255),
    /** OAuth only: where the tokens come from. The client secret is optional (public clients). */
    oauth: z
      .object({
        clientId: z.string().max(256),
        /** NOT a secret for a public client; stored here only when the user pastes one */
        clientSecretPresent: z.boolean(),
        tokenUrl: z.string().max(2048),
        authUrl: z.string().max(2048),
        scope: z.string().max(512),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MailAccount = z.infer<typeof MailAccountSchema>;

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const DEFAULT_PORTS: Record<string, number> = { imap: 993, pop3: 995, smtp: 587 };

/**
 * Every key an account record may carry. `normalizeAccount` builds its candidate field by field, so an
 * unknown key cannot reach the strict schema — which is why the refusal also runs against the raw
 * input. Both checks exist: a typed caller (and an imported bundle) goes through the schema, a
 * hand-edited settings file goes through this function.
 */
export const ACCOUNT_KEYS = new Set([
  'id',
  'name',
  'address',
  'kind',
  'host',
  'port',
  'tls',
  'username',
  'authKind',
  'sentFolder',
  'trashFolder',
  'junkFolder',
  'archiveFolder',
  'oauth',
  'clientSecret',
]);

export function accountUnknownKeys(input: unknown): string[] {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(src)) if (!ACCOUNT_KEYS.has(k)) out.push(k);
  return out;
}

/**
 * Fill in what the user should not have to type, and refuse what cannot work. Never guesses a host.
 */
export function normalizeAccount(input: unknown): Result<{ account: MailAccount }> {
  const src = (input ?? {}) as Record<string, unknown>;
  const kind = String(src.kind ?? 'imap') as MailAccount['kind'];
  const tls = String(src.tls ?? (kind === 'local' ? 'none' : 'implicit')) as MailAccount['tls'];
  const authKind = String(src.authKind ?? 'password') as MailAccount['authKind'];
  const port = Number(src.port) || DEFAULT_PORTS[kind] || 993;
  const candidate = {
    id: String(src.id ?? '').trim(),
    name: String(src.name ?? '').trim().slice(0, MAX_ACCOUNT_NAME),
    address: String(src.address ?? '').trim().slice(0, 320),
    kind,
    host: String(src.host ?? '').trim().slice(0, MAX_HOST),
    port,
    tls,
    username: String(src.username ?? '').trim().slice(0, MAX_USERNAME),
    authKind,
    sentFolder: String(src.sentFolder ?? '').trim().slice(0, 255),
    trashFolder: String(src.trashFolder ?? '').trim().slice(0, 255),
    junkFolder: String(src.junkFolder ?? '').trim().slice(0, 255),
    archiveFolder: String(src.archiveFolder ?? '').trim().slice(0, 255),
    ...(src.oauth && typeof src.oauth === 'object'
      ? {
          oauth: {
            clientId: String((src.oauth as Record<string, unknown>).clientId ?? '').trim().slice(0, 256),
            // a client secret is never KEPT here; only the fact that the user supplied one, so the
            // token exchange knows whether to send it (the value goes to the secret store)
            clientSecretPresent: !!(src.oauth as Record<string, unknown>).clientSecret,
            tokenUrl: String((src.oauth as Record<string, unknown>).tokenUrl ?? '').trim().slice(0, 2048),
            authUrl: String((src.oauth as Record<string, unknown>).authUrl ?? '').trim().slice(0, 2048),
            scope: String((src.oauth as Record<string, unknown>).scope ?? '').trim().slice(0, 512),
          },
        }
      : {}),
  };
  const parsed = MailAccountSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: `invalid account: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  const a = parsed.data;

  const unknown = accountUnknownKeys(src);
  if (unknown.length) return { ok: false, error: `unknown account field(s): ${unknown.slice(0, 4).join(', ')}` };
  if (!a.id) return { ok: false, error: 'an account needs an id' };
  if (a.kind !== 'local' && !a.host) return { ok: false, error: 'a mail server host is required' };
  if (a.kind !== 'local' && /[\s/@\\]/.test(a.host)) return { ok: false, error: 'the host must be a bare hostname or IP address' };
  if (a.authKind === 'oauth') {
    if (a.kind === 'local' || a.kind === 'pop3') return { ok: false, error: 'OAuth is only supported for IMAP accounts in this version' };
    if (!a.oauth?.clientId) return { ok: false, error: 'an OAuth account needs a client id' };
    if (!TOKEN_URL_RE.test(a.oauth.tokenUrl)) return { ok: false, error: 'the OAuth token endpoint must be https' };
    if (!TOKEN_URL_RE.test(a.oauth.authUrl)) return { ok: false, error: 'the OAuth authorization endpoint must be https' };
  }
  // A plaintext credential over a plaintext socket is a decision the user may make on a LAN; it is
  // never implied by leaving the field empty.
  if (a.kind !== 'local' && a.tls === 'none' && a.authKind === 'password') {
    return { ok: false, error: 'refusing a plaintext password login: set TLS (implicit or STARTTLS), or choose app-password on a server you trust, explicitly' };
  }
  return { ok: true, account: a };
}

/** Where a new message goes when a filter has no explicit target, and what the sync layer watches. */
export function foldersToWatch(a: MailAccount): string[] {
  const want = ['INBOX', a.sentFolder, a.trashFolder, a.junkFolder, a.archiveFolder].map((f) => f.trim()).filter(Boolean);
  return [...new Set(want)].slice(0, MAX_FOLDERS + 1);
}

// ---------------------------------------------------------------- OAuth (PKCE)

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** RFC 7636 S256. The verifier is 43 chars of base64url, which is inside the specified range. */
export function makePkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: randomBytes(16).toString('base64url') };
}

export function buildAuthUrl(a: MailAccount, pkce: Pkce, redirectUri: string): Result<{ url: string }> {
  if (a.authKind !== 'oauth' || !a.oauth) return { ok: false, error: 'not an OAuth account' };
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(redirectUri)) return { ok: false, error: 'the OAuth redirect must be a loopback http URL' };
  let u: URL;
  try {
    u = new URL(a.oauth.authUrl);
  } catch {
    return { ok: false, error: 'invalid authorization endpoint' };
  }
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', a.oauth.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', a.oauth.scope || 'https://mail.google.com/');
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', pkce.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return { ok: true, url: u.toString() };
}

/** Parse a loopback callback. The state MUST match the request that started the flow. */
export function parseCallback(url: string, expect: { state: string }): Result<{ code: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'invalid callback URL' };
  }
  const err = u.searchParams.get('error');
  if (err) return { ok: false, error: `the provider refused the authorization: ${err.replace(/[^\w -]/g, '').slice(0, 80)}` };
  const state = u.searchParams.get('state') ?? '';
  if (!expect.state || state !== expect.state) return { ok: false, error: 'the OAuth callback did not match this authorization request (state mismatch)' };
  const code = u.searchParams.get('code') ?? '';
  if (!code) return { ok: false, error: 'the OAuth callback carried no authorization code' };
  return { ok: true, code };
}

export interface TokenResponse {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

/** Exchange the code for tokens. Called from main with an injected fetch; never from a page. */
export async function exchangeCode(
  a: MailAccount,
  opts: { code: string; verifier: string; redirectUri: string; clientSecret?: string; fetchImpl: typeof fetch; now?: number },
): Promise<Result<TokenResponse>> {
  if (a.authKind !== 'oauth' || !a.oauth) return { ok: false, error: 'not an OAuth account' };
  if (!TOKEN_URL_RE.test(a.oauth.tokenUrl)) return { ok: false, error: 'the OAuth token endpoint must be https' };
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: a.oauth.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  const r = await postToken(a.oauth.tokenUrl, body, opts.fetchImpl);
  if (!r.ok) return r;
  const tok = r.tokens;
  if (!tok.refresh_token) {
    return { ok: false, error: 'the provider did not return a refresh token (offline access was not granted)' };
  }
  return { ok: true, refreshToken: tok.refresh_token, accessToken: tok.access_token ?? '', expiresAt: (opts.now ?? Date.now()) + (tok.expires_in ?? 3600) * 1000 };
}

export async function refreshAccessToken(
  a: MailAccount,
  refreshToken: string,
  opts: { clientSecret?: string; fetchImpl: typeof fetch; now?: number },
): Promise<Result<TokenResponse>> {
  if (!a.oauth) return { ok: false, error: 'not an OAuth account' };
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: a.oauth.clientId });
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  const r = await postToken(a.oauth.tokenUrl, body, opts.fetchImpl);
  if (!r.ok) return r;
  // RFC 6749: a refresh response MAY omit a new refresh token; keep the old one then.
  return { ok: true, refreshToken: r.tokens.refresh_token || refreshToken, accessToken: r.tokens.access_token ?? '', expiresAt: (opts.now ?? Date.now()) + (r.tokens.expires_in ?? 3600) * 1000 };
}

interface RawTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(tokenUrl: string, body: URLSearchParams, fetchImpl: typeof fetch): Promise<Result<{ tokens: RawTokens }>> {
  let res: Response;
  try {
    res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // the error string is static: a fetch failure message can contain the request, and the body has
    // the code and the client secret in it
    return { ok: false, error: 'could not reach the OAuth token endpoint' };
  }
  if (!res.ok) return { ok: false, error: `the OAuth token endpoint refused the request (HTTP ${res.status})` };
  let json: RawTokens;
  try {
    json = (await res.json()) as RawTokens;
  } catch {
    return { ok: false, error: 'the OAuth token endpoint returned a malformed response' };
  }
  if (json.error) return { ok: false, error: `the OAuth token endpoint returned ${String(json.error).slice(0, 60)}` };
  return { ok: true, tokens: json };
}

// ---------------------------------------------------------------- connection test

export type ImapStep = 'dns' | 'tcp' | 'tls' | 'greeting' | 'capability' | 'auth' | 'folder';

export const STEP_MESSAGE: Record<ImapStep, string> = {
  dns: 'the host name could not be resolved',
  tcp: 'the server did not accept a connection on this port',
  tls: 'the TLS handshake failed (check the TLS mode and the certificate)',
  greeting: 'the server did not send an IMAP greeting',
  capability: 'the server did not answer CAPABILITY',
  auth: 'the server rejected the login (check the username and the password / app password)',
  folder: 'the login worked but the mailbox could not be listed',
};

export interface ProbeResult {
  ok: boolean;
  step: ImapStep | 'done';
  message: string;
}

/**
 * Turn a raw failure into a precise step. Kept pure so the taxonomy can be tested without a socket,
 * and so the UI can tell the user which of six things is wrong instead of "login failed".
 */
export function classifyImapFailure(stage: ImapStep, detail = ''): ProbeResult {
  const extra = detail.startsWith('NO') || detail.startsWith('BAD') ? ` (server said: ${detail.slice(0, 120)})` : '';
  return { ok: false, step: stage, message: `${STEP_MESSAGE[stage]}${extra}` };
}

/** What the account test needs from the network layer (ticket 36 implements it). */
export interface ImapProbe {
  (opts: { host: string; port: number; tls: MailAccount['tls']; username: string; secret: string }): Promise<ProbeResult>;
}

export interface TestDeps {
  probeImap?: ImapProbe;
  /** resolve a hostname; injected so tests need no DNS */
  resolve?: (host: string) => Promise<boolean>;
}

/**
 * "Test account": resolve, then dial and authenticate, reporting the FIRST failing step.
 * A `local` account has nothing to test and says so rather than pretending to have connected.
 */
export async function testAccount(a: MailAccount, secret: { kind: 'password'; password: string } | { kind: 'oauth'; accessToken: string } | null, deps: TestDeps): Promise<ProbeResult> {
  if (a.kind === 'local') return { ok: true, step: 'done', message: 'this account has no server; messages are imported from files' };
  if (a.authKind === 'oauth') {
    if (!secret || secret.kind !== 'oauth' || !secret.accessToken) {
      return { ok: false, step: 'auth', message: 'the OAuth account has no access token yet — finish the sign-in first' };
    }
  } else if (!secret || secret.kind !== 'password' || !secret.password) {
    return { ok: false, step: 'auth', message: 'no password is stored for this account' };
  }

  if (deps.resolve) {
    let resolved = false;
    try {
      resolved = await deps.resolve(a.host);
    } catch {
      resolved = false;
    }
    if (!resolved) return classifyImapFailure('dns');
  }
  if (!deps.probeImap) return { ok: false, step: 'tcp', message: 'the mail connection layer is not available in this build' };
  const cred = a.authKind === 'oauth' ? `\u0001XOAUTH2\u0001${(secret as { accessToken: string }).accessToken}` : (secret as { password: string }).password;
  return deps.probeImap({ host: a.host, port: a.port, tls: a.tls, username: a.username, secret: cred });
}

/** Defaults the settings UI offers per provider; the user can override every field. */
export const PRESETS: Record<string, Partial<MailAccount>> = {
  imap: { kind: 'imap', port: 993, tls: 'implicit', authKind: 'password' },
  'imap-starttls': { kind: 'imap', port: 143, tls: 'starttls', authKind: 'password' },
  pop3: { kind: 'pop3', port: 995, tls: 'implicit', authKind: 'password' },
  local: { kind: 'local', port: 0, tls: 'none', authKind: 'password' },
};

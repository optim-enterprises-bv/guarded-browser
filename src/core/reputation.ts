// Host reputation from keyless public threat feeds, cached locally.
//
// - feeds are downloaded to <dir>/feeds/<name>.txt (atomic rename; the last good copy is kept when a
//   download fails or looks corrupt), refreshed when older than 24 h
// - matching: exact host and every parent domain, after normalisation (lowercase, trailing dot,
//   port stripped, IDNA -> punycode)
// - a user-editable local blocklist and allowlist; the allowlist wins
// - these feeds target phishing / malware; they are not AI-injection specific

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';

export type FeedFormat = 'domains' | 'hosts' | 'urls';

export interface FeedConfig {
  name: string;
  url: string;
  format: FeedFormat;
  enabled: boolean;
}

export interface FeedStatus {
  name: string;
  url: string;
  enabled: boolean;
  entries: number;
  fetchedAt?: string;
  ageHours?: number;
  lastError?: string;
  failures: number;
  source: 'cache' | 'network' | 'none';
}

export interface ReputationHit {
  listed: boolean;
  host: string;
  feed?: string;
  matched?: string;
  allowlisted?: boolean;
}

export const REFRESH_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: 'hagezi-tif-medium', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt', format: 'domains', enabled: true },
  { name: 'phishing-database-active', url: 'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt', format: 'domains', enabled: true },
  { name: 'openphish-community', url: 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt', format: 'urls', enabled: true },
  { name: 'urlhaus-hostfile', url: 'https://urlhaus.abuse.ch/downloads/hostfile/', format: 'hosts', enabled: true },
];

/** Normalise a host (or host:port, or URL) for matching. Returns '' if it is not a host. */
export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  if (!h) return '';
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname;
    } catch {
      return '';
    }
  }
  if (h.startsWith('[')) return h.replace(/^\[|\].*$/g, ''); // IPv6 literal
  h = h.replace(/:\d+$/, '').replace(/\.+$/, '').replace(/^\*\./, '').replace(/^\.+/, '');
  if (/[^\x00-\x7f]/.test(h)) h = domainToASCII(h);
  return /^[a-z0-9_.-]+$/.test(h) ? h : '';
}

/** Parse one feed. Comments (#, !) and blank lines are ignored. */
export function parseFeed(text: string, format: FeedFormat): string[] {
  const out: string[] = [];
  const plain = /^[a-z0-9_][a-z0-9_.-]*$/;
  // manual line loop instead of split(): the big feeds have ~1M lines and split() doubles the garbage
  for (let start = 0; start < text.length; ) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const raw = text.slice(start, end);
    start = end + 1;
    // fast path: most domain-feed lines are already normalised
    if (format === 'domains' && plain.test(raw)) {
      out.push(raw);
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let host = '';
    if (format === 'domains') host = line.split(/\s+/)[0];
    else if (format === 'hosts') host = line.split(/\s+/)[1] ?? '';
    else host = line.includes('://') ? line : '';
    const n = normalizeHost(host);
    // hosts files map their own loopback names; never list those
    if (format === 'hosts' && /^(localhost|localhost\.localdomain|broadcasthost|local|0\.0\.0\.0|127\.0\.0\.1|ip6-.*)$/.test(n)) continue;
    if (n) out.push(n);
  }
  return out;
}

/** Candidate keys for a host: itself and every parent domain (a.b.example.com -> b.example.com, example.com, com). */
export function parents(host: string): string[] {
  const out = [host];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return out;
  let i = host.indexOf('.');
  while (i >= 0) {
    out.push(host.slice(i + 1));
    i = host.indexOf('.', i + 1);
  }
  return out;
}

/**
 * Compact, immutable host set: one sorted newline-joined string plus an offset table, looked up by
 * binary search. ~25 bytes/host instead of ~65 for a Set<string>; the feeds have >1M hosts.
 */
export class HostSet {
  private constructor(
    private readonly data: string,
    private readonly offs: Uint32Array,
  ) {}

  /** Builds the set; sorts and dedupes `hosts` in place (no extra copies: feeds are large). */
  static from(hosts: string[]): HostSet {
    hosts.sort();
    let w = 0;
    for (let i = 0; i < hosts.length; i++) if (w === 0 || hosts[i] !== hosts[w - 1]) hosts[w++] = hosts[i];
    hosts.length = w;
    const sorted = hosts;
    const offs = new Uint32Array(sorted.length + 1);
    let pos = 0;
    sorted.forEach((h, i) => {
      offs[i] = pos;
      pos += h.length + 1;
    });
    offs[sorted.length] = pos;
    // flatten: a fresh one-byte string that does not retain the downloaded text
    return new HostSet(sorted.join('\n') + '\n', offs);
  }

  /** Rebuild from parts produced elsewhere (a worker thread). */
  static fromParts(data: string, offs: Uint32Array): HostSet {
    return new HostSet(data, offs);
  }

  parts(): { data: string; offs: Uint32Array } {
    return { data: this.data, offs: this.offs };
  }

  get size(): number {
    return this.offs.length - 1;
  }

  has(host: string): boolean {
    let lo = 0;
    let hi = this.offs.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.data.slice(this.offs[mid], this.offs[mid + 1] - 1);
      if (v === host) return true;
      if (v < host) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
}

export type Fetcher = (url: string) => Promise<{ status: number; text: string }>;

/** Parses a cached feed file into a HostSet. The app runs this in a worker thread (see
 *  src/main/feed-worker.ts) so parse garbage never lands in the main process heap. */
export type FeedBuilder = (file: string, format: FeedFormat) => Promise<{ set: HostSet; count: number }>;

export const inProcessBuilder: FeedBuilder = async (file, format) => {
  const hosts = parseFeed(readFileSync(file, 'utf8'), format);
  const count = hosts.length;
  return { set: HostSet.from(hosts), count };
};

const defaultFetcher: Fetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'guarded-browser/0.1 (feed update)' } });
  return { status: r.status, text: await r.text() };
};

export class ReputationDb {
  private sets = new Map<string, HostSet>();
  private statuses = new Map<string, FeedStatus>();
  private localBlock = new Set<string>();
  private localAllow = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<() => void> = [];
  readonly feedDir: string;
  readonly localBlockFile: string;
  readonly localAllowFile: string;

  constructor(
    dir: string,
    private feeds: FeedConfig[],
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly builder: FeedBuilder = inProcessBuilder,
  ) {
    this.feedDir = join(dir, 'feeds');
    mkdirSync(this.feedDir, { recursive: true });
    this.localBlockFile = join(dir, 'local-blocklist.txt');
    this.localAllowFile = join(dir, 'local-allowlist.txt');
    if (!existsSync(this.localBlockFile)) writeFileSync(this.localBlockFile, '# One host per line. Parent domains match subdomains. Blocked in manual and agent mode.\n');
    if (!existsSync(this.localAllowFile)) writeFileSync(this.localAllowFile, '# One host per line. The allowlist wins over every feed and the local blocklist.\n');
    for (const f of feeds) this.statuses.set(f.name, { name: f.name, url: f.url, enabled: f.enabled, entries: 0, failures: 0, source: 'none' });
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  setFeeds(feeds: FeedConfig[]) {
    this.feeds = feeds;
    for (const name of [...this.sets.keys()]) if (!feeds.some((f) => f.name === name && f.enabled)) this.sets.delete(name);
    for (const f of feeds) {
      const s = this.statuses.get(f.name);
      this.statuses.set(f.name, { ...(s ?? { entries: 0, failures: 0, source: 'none' as const }), name: f.name, url: f.url, enabled: f.enabled });
    }
    for (const name of [...this.statuses.keys()]) if (!feeds.some((f) => f.name === name)) this.statuses.delete(name);
    this.changed();
  }

  private cacheFile(name: string) {
    return join(this.feedDir, `${name.replace(/[^\w.-]/g, '_')}.txt`);
  }

  reloadLocalLists() {
    const read = (f: string) => new Set(existsSync(f) ? parseFeed(readFileSync(f, 'utf8'), 'domains') : []);
    this.localBlock = read(this.localBlockFile);
    this.localAllow = read(this.localAllowFile);
    this.changed();
  }

  /** Load every enabled feed from the local cache (no network). */
  async loadCache() {
    this.reloadLocalLists();
    for (const f of this.feeds) {
      if (!f.enabled) continue;
      const file = this.cacheFile(f.name);
      if (!existsSync(file)) continue;
      const st = this.statuses.get(f.name)!;
      try {
        const { set, count } = await this.builder(file, f.format);
        this.sets.set(f.name, set);
        Object.assign(st, { entries: count, fetchedAt: statSync(file).mtime.toISOString(), source: 'cache' });
      } catch (e) {
        st.lastError = `cache unreadable: ${(e as Error).message.slice(0, 200)}`;
      }
    }
    this.updateAges();
    this.changed();
  }

  private updateAges() {
    for (const f of this.feeds) {
      const file = this.cacheFile(f.name);
      const st = this.statuses.get(f.name);
      if (st && existsSync(file)) st.ageHours = Math.round(((Date.now() - statSync(file).mtimeMs) / 3_600_000) * 10) / 10;
    }
  }

  private isStale(f: FeedConfig): boolean {
    const file = this.cacheFile(f.name);
    return !existsSync(file) || Date.now() - statSync(file).mtimeMs > REFRESH_MS;
  }

  /** Download one feed; on any failure keep the previous cache and the loaded set. */
  async updateFeed(f: FeedConfig): Promise<boolean> {
    const st = this.statuses.get(f.name)!;
    try {
      const r = await this.fetcher(f.url);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      if (/<html[\s>]/i.test(r.text.slice(0, 2000))) throw new Error('response looks like HTML, not a feed');
      const file = this.cacheFile(f.name);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, r.text);
      let built: { set: HostSet; count: number };
      try {
        built = await this.builder(tmp, f.format);
        if (built.count === 0) throw new Error('feed parsed to 0 entries');
        const prev = this.sets.get(f.name)?.size ?? 0;
        if (prev > 1000 && built.set.size < prev * 0.1) throw new Error(`feed shrank from ${prev} to ${built.set.size} entries; treating as corrupt`);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      renameSync(tmp, file); // atomic replace; the previous copy stays until this point
      this.sets.set(f.name, built.set);
      Object.assign(st, { entries: built.count, fetchedAt: new Date().toISOString(), ageHours: 0, source: 'network', lastError: undefined });
      this.changed();
      return true;
    } catch (e) {
      st.failures++;
      st.lastError = `${new Date().toISOString()}: ${(e as Error).message.slice(0, 200)}`;
      this.changed();
      return false;
    }
  }

  /** Refresh stale feeds (or all with force). Sequential to keep memory flat. */
  async refresh(force = false): Promise<void> {
    for (const f of this.feeds) {
      if (f.enabled && (force || this.isStale(f))) await this.updateFeed(f);
    }
    this.updateAges();
    this.changed();
  }

  /** Non-blocking start: cache now, network in the background, then every 24 h. */
  start() {
    void this.loadCache().then(() => this.refresh());
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  check(hostOrUrl: string): ReputationHit {
    const host = normalizeHost(hostOrUrl);
    if (!host) return { listed: false, host };
    const keys = parents(host);
    for (const k of keys) if (this.localAllow.has(k)) return { listed: false, host, allowlisted: true, matched: k };
    for (const k of keys) if (this.localBlock.has(k)) return { listed: true, host, feed: 'local-blocklist', matched: k };
    for (const [name, set] of this.sets) {
      for (const k of keys) if (set.has(k)) return { listed: true, host, feed: name, matched: k };
    }
    return { listed: false, host };
  }

  status(): FeedStatus[] {
    this.updateAges();
    return [...this.statuses.values()];
  }

  totalEntries(): number {
    let n = 0;
    for (const s of this.sets.values()) n += s.size;
    return n + this.localBlock.size;
  }
}

/** Optional Google Safe Browsing v4 lookup (disabled by default; key only from an env var). */
export async function safeBrowsingLookup(url: string, apiKey: string, endpoint = 'https://safebrowsing.googleapis.com/v4/threatMatches:find'): Promise<string | null> {
  const r = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      client: { clientId: 'guarded-browser', clientVersion: '0.1.0' },
      threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: [{ url }],
      },
    }),
  });
  if (!r.ok) throw new Error(`safe browsing HTTP ${r.status}`);
  const j = (await r.json()) as { matches?: Array<{ threatType: string }> };
  return j.matches?.length ? j.matches.map((m) => m.threatType).join(',') : null;
}

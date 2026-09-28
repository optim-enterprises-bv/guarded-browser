// Reputation feeds: parsing, normalisation, parent-domain matching, allowlist precedence,
// cache-keeping on failed/corrupt downloads, and enforcement in the proxy path. No network.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReputationDb, normalizeHost, parents, parseFeed, safeBrowsingLookup, type FeedConfig, type Fetcher } from '../../src/core/reputation';
import { EgressController, startProxy, type EgressAuditEntry, type ProxyHandle } from '../../src/core/egress';
import { TaintRegistry } from '../../src/core/taint';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';

const feed = (name: string, format: FeedConfig['format'] = 'domains'): FeedConfig => ({ name, url: `http://feeds.test/${name}`, format, enabled: true });

describe('normalisation and parsing', () => {
  it('normalises case, trailing dot, port, wildcard and IDNA', () => {
    expect(normalizeHost('Evil.Example.COM.')).toBe('evil.example.com');
    expect(normalizeHost('evil.example.com:8443')).toBe('evil.example.com');
    expect(normalizeHost('https://Sub.Evil.example/path?q=1')).toBe('sub.evil.example');
    expect(normalizeHost('*.evil.example')).toBe('evil.example');
    expect(normalizeHost('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHost('not a host')).toBe('');
  });
  it('parses domains, hosts-file and URL feeds', () => {
    expect(parseFeed('# c\nA.example\n\nb.example # x\n', 'domains')).toEqual(['a.example', 'b.example']);
    expect(parseFeed('127.0.0.1 localhost\n127.0.0.1\tbad.example\n0.0.0.0 worse.example', 'hosts')).toEqual(['bad.example', 'worse.example']);
    expect(parseFeed('https://phish.example/login\nhttp://x.example:8080/a\ngarbage', 'urls')).toEqual(['phish.example', 'x.example']);
  });
  it('lists every parent domain', () => {
    expect(parents('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com', 'com']);
    expect(parents('10.0.0.1')).toEqual(['10.0.0.1']);
  });
});

describe('reputation db', () => {
  function db(fetcher: Fetcher, feeds = [feed('f1')]) {
    const dir = mkdtempSync(join(tmpdir(), 'gb-rep-'));
    return new ReputationDb(dir, feeds, fetcher);
  }

  it('(c) matches parent domains', async () => {
    const r = db(async () => ({ status: 200, text: 'evil.example\n' }));
    await r.refresh(true);
    expect(r.check('evil.example')).toMatchObject({ listed: true, feed: 'f1', matched: 'evil.example' });
    expect(r.check('deep.sub.evil.example')).toMatchObject({ listed: true, feed: 'f1', matched: 'evil.example' });
    expect(r.check('EVIL.example.:443')).toMatchObject({ listed: true });
    expect(r.check('notevil.example').listed).toBe(false);
    expect(r.check('example').listed).toBe(false);
  });

  it('(d) the local allowlist overrides feeds and the local blocklist', async () => {
    const r = db(async () => ({ status: 200, text: 'evil.example\nshared-host.example\n' }));
    await r.refresh(true);
    appendFileSync(r.localAllowFile, 'good.shared-host.example\n');
    appendFileSync(r.localBlockFile, 'mine.example\n');
    r.reloadLocalLists();
    expect(r.check('good.shared-host.example')).toMatchObject({ listed: false, allowlisted: true });
    expect(r.check('other.shared-host.example').listed).toBe(true);
    expect(r.check('x.mine.example')).toMatchObject({ listed: true, feed: 'local-blocklist' });
    appendFileSync(r.localAllowFile, 'mine.example\n');
    r.reloadLocalLists();
    expect(r.check('x.mine.example').listed).toBe(false);
  });

  it('(e) a failed or corrupt download keeps the previous cache', async () => {
    let reply = { status: 200, text: 'evil.example\n' + Array.from({ length: 2000 }, (_, i) => `h${i}.example`).join('\n') };
    const r = db(async () => reply);
    expect(await r.updateFeed(feed('f1'))).toBe(true);
    const cacheFile = join(r.feedDir, 'f1.txt');
    const good = readFileSync(cacheFile, 'utf8');
    for (const bad of [
      { status: 500, text: 'oops' },
      { status: 200, text: '<!doctype html><html><body>rate limited</body></html>' },
      { status: 200, text: '# nothing here\n' },
      { status: 200, text: 'only-one.example\n' }, // shrank by >90%
    ]) {
      reply = bad;
      expect(await r.updateFeed(feed('f1'))).toBe(false);
      expect(readFileSync(cacheFile, 'utf8')).toBe(good);
      expect(r.check('evil.example').listed).toBe(true);
    }
    const st = r.status()[0];
    expect(st.failures).toBe(4);
    expect(st.entries).toBe(2001);
    expect(st.lastError).toMatch(/shrank/);
    // network error
    const r2 = db(async () => {
      throw new Error('ECONNREFUSED');
    });
    writeFileSync(join(r2.feedDir, 'f1.txt'), 'cached.example\n');
    await r2.loadCache();
    await r2.refresh(true);
    expect(r2.check('cached.example')).toMatchObject({ listed: true });
    expect(r2.status()[0]).toMatchObject({ source: 'cache', failures: 1 });
  });

  it('refresh only downloads stale feeds', async () => {
    let calls = 0;
    const r = db(async () => {
      calls++;
      return { status: 200, text: 'a.example\n' };
    });
    await r.refresh();
    await r.refresh();
    expect(calls).toBe(1);
  });

  it('keeps memory reasonable for large feeds (500k entries)', async () => {
    const big = Array.from({ length: 500_000 }, (_, i) => `host-${i}.example-domain-${i % 997}.com`).join('\n');
    const r = db(async () => ({ status: 200, text: big }));
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    await r.refresh(true);
    const mb = (process.memoryUsage().heapUsed - before) / 1e6;
    expect(r.totalEntries()).toBe(500_000);
    expect(r.check('x.host-4242.example-domain-254.com').listed).toBe(true);
    console.log(`reputation: 500k entries -> ~${mb.toFixed(0)} MB heap`);
    expect(mb).toBeLessThan(150);
  });
});

describe('reputation in the egress proxy path', () => {
  let fx: FixtureServers;
  let proxy: ProxyHandle;
  const log: EgressAuditEntry[] = [];
  const ctl = new EgressController([], (e) => log.push(e));

  beforeAll(async () => {
    fx = await startFixtureServers();
    proxy = await startProxy(ctl);
    const r = new ReputationDb(mkdtempSync(join(tmpdir(), 'gb-rep-')), [feed('fixture-feed')], async () => ({ status: 200, text: 'localhost\n' }));
    await r.refresh(true);
    ctl.reputation = r;
  });
  afterAll(async () => {
    await proxy.close();
    await fx.close();
  });

  const get = (url: string) =>
    new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: new URL(url).host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });

  it('(b) blocks listed hosts in manual browsing and audits the feed name', async () => {
    ctl.endTask();
    expect(await get(`${fx.attacker}/pixel.gif`)).toBe(403);
    expect(await get(`${fx.site}/shop.html`)).toBe(200);
    expect(fx.attackerHits).toHaveLength(0);
    expect(log.find((e) => e.layer === 'reputation')).toMatchObject({ decision: 'block', feed: 'fixture-feed', matched: 'localhost' });
  });

  it('(a) the agent can never override: even an allowlisted listed host stays blocked in agent mode', async () => {
    ctl.overrideReputation('localhost'); // the user proceeded once while browsing manually
    expect(await get(`${fx.attacker}/manual-ok`)).toBe(200);
    ctl.startTask([fx.site, fx.attacker], new TaintRegistry('t'));
    ctl.allowHost(fx.attacker);
    expect(await get(`${fx.attacker}/agent`)).toBe(403);
    expect(fx.attackerHits.map((h) => h.url)).toEqual(['/manual-ok']);
    ctl.endTask();
  });
});

describe('google safe browsing (optional, disabled by default)', () => {
  it('parses matches from a v4-compatible endpoint', async () => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const url = JSON.parse(b).threatInfo.threatEntries[0].url as string;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(url.includes('bad') ? { matches: [{ threatType: 'SOCIAL_ENGINEERING' }] } : {}));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const ep = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v4/threatMatches:find`;
    expect(await safeBrowsingLookup('http://bad.example/', 'k', ep)).toBe('SOCIAL_ENGINEERING');
    expect(await safeBrowsingLookup('http://good.example/', 'k', ep)).toBeNull();
    srv.close();
  });
});

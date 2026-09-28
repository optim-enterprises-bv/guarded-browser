import { describe, expect, it } from 'vitest';
import { MIN_MATCH_LENGTH, TaintRegistry, variants } from '../../src/core/taint';

const prov = [{ source: 'reader' as const, url: 'http://site', timestamp: 't' }];

describe('taint registry', () => {
  it('finds registered values in plain, url-encoded, base64 and mixed-case forms', () => {
    const t = new TaintRegistry('task');
    const v = t.register('Alice Smith <alice@example.com>', 'untrusted', prov);
    const enc = encodeURIComponent(v.value);
    const b64 = Buffer.from(v.value).toString('base64');
    expect(t.matchRequest(`http://x/?q=${enc}`).map((e) => e.id)).toEqual([v.id]);
    expect(t.matchRequest(`http://x/?q=${enc.replace(/%20/g, '+')}`)).toHaveLength(1);
    expect(t.matchRequest(`http://x/?q=${b64.replace(/=+$/, '')}`)).toHaveLength(1);
    expect(t.matchRequest('http://x/', `data=${v.value.toUpperCase()}`)).toHaveLength(1);
    expect(t.matchRequest(`http://x/?q=${encodeURIComponent(enc)}`)).toHaveLength(1);
    expect(t.matchRequest('http://x/?q=nothing-here')).toHaveLength(0);
  });

  it('ignores values shorter than the minimum length', () => {
    const t = new TaintRegistry('');
    t.register('USD', 'untrusted', prov);
    expect(t.matchRequest('http://x/?currency=USD')).toHaveLength(0);
    expect(variants('abc').lower).toHaveLength(0);
    expect(MIN_MATCH_LENGTH).toBeGreaterThanOrEqual(6);
  });

  it('labels planner text: trusted only when verbatim in the task', () => {
    const t = new TaintRegistry('Fill the form with name Bob Jones and email bob@example.com');
    expect(t.labelPlannerText('bob@example.com', []).label).toBe('trusted');
    expect(t.labelPlannerText('attacker@evil.example', ['http://site']).label).toBe('untrusted');
    t.register('WINTER-SALE-7731', 'untrusted', prov);
    const l = t.labelPlannerText('code WINTER-SALE-7731', []);
    expect(l.label).toBe('untrusted');
    expect(l.provenance[0].source).toBe('reader');
    expect(l.taintIds).toHaveLength(1);
  });

  it('wraps reader output as untrusted with provenance and registers leaves', () => {
    const t = new TaintRegistry('');
    const w = t.wrapReaderOutput({ price: 19.99, name: 'Blue Widget', tags: ['alpha-tag'] }, 'http://site/p');
    expect(w.label).toBe('untrusted');
    expect(w.provenance[0]).toMatchObject({ source: 'reader', url: 'http://site/p' });
    expect(t.all().map((e) => e.value).sort()).toEqual(['19.99', 'Blue Widget', 'alpha-tag']);
  });
});

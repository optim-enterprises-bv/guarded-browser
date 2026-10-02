// M1 (round 6): confirmation ids are assigned by the broker. Callers used `${prefix}${Date.now()}`,
// so two requests in the same millisecond shared an id: the broker's map kept the second resolver,
// the renderer kept the first card, and answering the card resolved the request that was never shown.
import { describe, expect, it, vi } from 'vitest';
import { ConfirmBroker } from '../../src/main/confirm';
import type { ConfirmRequest } from '../../src/core/types';

const req = (id: string, action: string): ConfirmRequest => ({ id, kind: 'action', action, target: 't', values: [], reasons: [] });

describe('M1: ConfirmBroker ids', () => {
  it('two requests with the same caller id (same ms) get distinct ids and resolve independently', async () => {
    const sent: Array<{ ch: string; p: { id: string; action?: string } }> = [];
    const b = new ConfirmBroker((ch, p) => sent.push({ ch, p: p as { id: string } }), () => 60_000);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const first = b.request(req(`r${Date.now().toString(36)}`, 'first'));
    const second = b.request(req(`r${Date.now().toString(36)}`, 'second'));
    now.mockRestore();
    const shown = sent.filter((s) => s.ch === 'confirm:request').map((s) => s.p);
    expect(shown).toHaveLength(2);
    expect(shown[0].id).not.toBe(shown[1].id);
    expect(shown.every((s) => s.id.startsWith('r'))).toBe(true); // prefix letter kept
    expect(b.pendingCount()).toBe(2);
    // answering the FIRST card the renderer showed resolves the first request only
    b.answer(shown[0].id, 'approve');
    await expect(first).resolves.toBe('approve');
    expect(b.pendingCount()).toBe(1);
    expect(b.list()[0].action).toBe('second');
    b.answer(shown[1].id, 'deny');
    await expect(second).resolves.toBe('deny');
  });

  it('a caller-chosen id cannot address a pending request', async () => {
    const b = new ConfirmBroker(() => undefined, () => 60_000);
    const p = b.request(req('rfixed', 'x'));
    b.answer('rfixed', 'approve'); // the id the caller (or a guesser) knew is not the broker's
    expect(b.pendingCount()).toBe(1);
    b.denyAll();
    await expect(p).resolves.toBe('deny');
  });
});

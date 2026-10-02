// Human confirmation broker: shows requests in the agent panel and waits for Approve / Deny / Stop.
// Default-deny: no answer within the timeout resolves to 'timeout', which callers treat as deny.

import { randomUUID } from 'node:crypto';
import type { ConfirmOutcome, ConfirmRequest } from '../core/types';

interface Pending {
  req: ConfirmRequest;
  resolve: (o: ConfirmOutcome) => void;
  timer: NodeJS.Timeout;
}

export class ConfirmBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly timeoutMs: () => number,
  ) {}

  request(caller: ConfirmRequest): Promise<ConfirmOutcome> {
    // The broker owns the id. Callers built theirs from Date.now(), so two requests in the same ms
    // collided: the map kept the second resolver while the renderer kept (and answered) the first
    // card, i.e. an Approve on one dialog resolved a different, never-shown request. Only the
    // caller's prefix letter survives (it says which subsystem asked; nothing parses it).
    const req: ConfirmRequest = { ...caller, id: `${/^[a-z]/i.test(caller.id) ? caller.id[0] : 'c'}${randomUUID()}` };
    return new Promise((resolve) => {
      const ms = this.timeoutMs();
      const timer = setTimeout(() => this.answer(req.id, 'timeout'), ms);
      this.pending.set(req.id, { req, resolve, timer });
      this.send('confirm:request', { ...req, timeoutMs: ms, expiresAt: Date.now() + ms });
    });
  }

  /** How many confirmations are open. Used to refuse a capture that would photograph the security
   *  UI (ticket 26). Read-only: it grants no capability. */
  pendingCount(): number {
    return this.pending.size;
  }

  answer(id: string, outcome: ConfirmOutcome) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.send('confirm:clear', { id, outcome });
    p.resolve(outcome);
  }

  /** Deny everything still open (task stopped / ended). */
  denyAll(outcome: ConfirmOutcome = 'deny') {
    for (const id of [...this.pending.keys()]) this.answer(id, outcome);
  }

  list(): ConfirmRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }
}

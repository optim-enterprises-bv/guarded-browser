// Human confirmation broker: shows requests in the agent panel and waits for Approve / Deny / Stop.
// Default-deny: no answer within the timeout resolves to 'timeout', which callers treat as deny.

import { randomUUID } from 'node:crypto';
import type { ConfirmOutcome, ConfirmRequest } from '../core/types';

interface Pending {
  req: ConfirmRequest;
  resolve: (o: ConfirmOutcome) => void;
  timer: NodeJS.Timeout;
}

/** Second displays of a confirmation (the phone, item 3). They show; the broker decides. */
export interface ConfirmObserver {
  onRequest(req: ConfirmRequest, expiresAt: number): void;
  onResolve(id: string, outcome: ConfirmOutcome): void;
}

export class ConfirmBroker {
  private pending = new Map<string, Pending>();
  private observer: ConfirmObserver | null = null;
  /** stamps every request before it is shown (the runtime adds the MCP client of a running MCP task) */
  decorate: (req: ConfirmRequest) => ConfirmRequest = (r) => r;

  constructor(
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly timeoutMs: () => number,
  ) {}

  request(caller: ConfirmRequest): Promise<ConfirmOutcome> {
    // The broker owns the id. Callers built theirs from Date.now(), so two requests in the same ms
    // collided: the map kept the second resolver while the renderer kept (and answered) the first
    // card, i.e. an Approve on one dialog resolved a different, never-shown request. Only the
    // caller's prefix letter survives (it says which subsystem asked; nothing parses it).
    const req: ConfirmRequest = this.decorate({ ...caller, id: `${/^[a-z]/i.test(caller.id) ? caller.id[0] : 'c'}${randomUUID()}` });
    return new Promise((resolve) => {
      const ms = this.timeoutMs();
      const timer = setTimeout(() => this.answer(req.id, 'timeout'), ms);
      this.pending.set(req.id, { req, resolve, timer });
      const expiresAt = Date.now() + ms;
      this.send('confirm:request', { ...req, timeoutMs: ms, expiresAt });
      try {
        this.observer?.onRequest(req, expiresAt);
      } catch {
        /* a second display failing never affects the confirmation itself */
      }
    });
  }

  /** attach the phone hub (one observer; null detaches) */
  observe(o: ConfirmObserver | null) {
    this.observer = o;
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** How many confirmations are open. Used to refuse a capture that would photograph the security
   *  UI (ticket 26). Read-only: it grants no capability. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** First answer wins: returns false when the id is not (or no longer) pending. */
  answer(id: string, outcome: ConfirmOutcome): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.send('confirm:clear', { id, outcome });
    try {
      this.observer?.onResolve(id, outcome);
    } catch {
      /* see request() */
    }
    p.resolve(outcome);
    return true;
  }

  /** Deny everything still open (task stopped / ended). */
  denyAll(outcome: ConfirmOutcome = 'deny') {
    for (const id of [...this.pending.keys()]) this.answer(id, outcome);
  }

  list(): ConfirmRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }
}

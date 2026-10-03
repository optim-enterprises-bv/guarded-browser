// Phone approvals (item 3): a confirmation can be answered on screen OR on a second device. The
// broker stays the one owner of every pending confirmation: a channel only DISPLAYS a request and
// hands back an answer for an id the broker still has pending. First answer wins (the broker drops
// the id on the first answer, so a second one finds nothing); the other side is then cleared — the
// screen by the broker's `confirm:clear`, the phone card by `resolved()`. Pure; no Electron.

import type { ConfirmOutcome, ConfirmRequest } from './types';

export type AnsweredVia = 'screen' | 'phone' | 'expired';

export interface ApprovalChannel {
  readonly name: string;
  /** show a pending confirmation (exactly what the dialog shows); answers come back via the hub */
  post(req: ConfirmRequest, expiresAt: number): void;
  /** the confirmation was answered somewhere, or expired: update / clear the card */
  resolved(id: string, outcome: ConfirmOutcome, via: AnsweredVia): void;
  /** stop all network activity (settings changed, window closed) */
  close(): void;
}

/** What the hub needs of the broker. `answer` returns false when the id is not pending (anymore). */
export interface BrokerPort {
  answer(id: string, outcome: ConfirmOutcome): boolean;
  isPending(id: string): boolean;
}

export class ApprovalHub {
  private channel: ApprovalChannel | null = null;
  /** ids posted to the current channel */
  private posted = new Set<string>();
  /** ids answered through a channel, so the card can say "approved on the phone" */
  private viaPhone = new Set<string>();

  constructor(
    private readonly broker: BrokerPort,
    /** should THIS request go to the phone? (phone enabled, scope: MCP tasks only / all agent tasks) */
    private readonly eligible: (req: ConfirmRequest) => boolean,
  ) {}

  /** replace the channel (null = phone approvals off); the old one is closed */
  setChannel(ch: ApprovalChannel | null) {
    this.channel?.close();
    this.channel = ch;
    this.posted.clear();
  }

  get active(): boolean {
    return !!this.channel;
  }

  /** broker hook: a confirmation was raised */
  onRequest(req: ConfirmRequest, expiresAt: number) {
    if (!this.channel || !this.eligible(req)) return;
    this.posted.add(req.id);
    this.channel.post(req, expiresAt);
  }

  /** broker hook: a confirmation was answered (anywhere) or timed out */
  onResolve(id: string, outcome: ConfirmOutcome) {
    const phone = this.viaPhone.delete(id);
    if (!this.posted.delete(id)) return;
    this.channel?.resolved(id, outcome, outcome === 'timeout' ? 'expired' : phone ? 'phone' : 'screen');
  }

  /**
   * An answer from a channel. Accepted only for an id this hub posted AND the broker still has
   * pending; anything else (stale, unknown, already answered on screen) is ignored. Returns whether
   * the answer took effect.
   */
  fromChannel(id: string, outcome: 'approve' | 'deny'): boolean {
    if (!this.posted.has(id) || !this.broker.isPending(id)) return false;
    this.viaPhone.add(id);
    const ok = this.broker.answer(id, outcome);
    if (!ok) this.viaPhone.delete(id);
    return ok;
  }
}

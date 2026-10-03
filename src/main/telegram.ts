// Phone approvals over the Telegram Bot API (item 3), with the browser's OWN bot (never a bot another
// program polls: Telegram allows one getUpdates poller per token, and a second one would cut the
// first off). Node only — no Electron — so it is unit-tested against a fake Bot API server.
//
// Network: api.telegram.org only, through Node's https with normal certificate verification. This is
// deliberately NOT the profile's egress proxy, which exists for PAGE traffic; it is the one documented
// exception (README, "Phone approvals"). Nothing a page or a model wrote decides where it connects.
//
// What a card accepts:
//   * callbacks from the configured chat id only (and from that same user: a private chat), and
//   * only for a confirmation this channel posted, with the message id it was posted as, while the
//     broker still has it pending — a stale, unknown or already-answered id does nothing.
// Polling runs only while a card is pending, with an offset, so old updates are consumed once.

import http from 'node:http';
import https from 'node:https';
import type { AnsweredVia, ApprovalChannel } from '../core/approval';
import { phoneCard } from '../core/confirm-text';
import type { ConfirmOutcome, ConfirmRequest } from '../core/types';

export const TELEGRAM_API = 'https://api.telegram.org';
export const BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const CHAT_ID_RE = /^\d{1,20}$/;

export interface TelegramOptions {
  token: string;
  chatId: string;
  /** TEST ONLY override (a loopback fake); production is always TELEGRAM_API */
  apiBase?: string;
  /** an answer from the phone; returns whether it took effect */
  onAnswer(id: string, outcome: 'approve' | 'deny'): boolean;
  /** is this confirmation still pending at the broker? */
  isPending(id: string): boolean;
  /** audit lines (never the token) */
  audit?(detail: Record<string, unknown>): void;
  /** long-poll seconds (Telegram allows up to 50) */
  pollSeconds?: number;
}

interface Card {
  messageId?: number;
  text: string;
  /** resolved before sendMessage returned: edit as soon as the message id is known */
  pendingFooter?: string;
}

const CALLBACK_RE = /^gb:(a|d):([A-Za-z][0-9a-f-]{36})$/;

export class TelegramChannel implements ApprovalChannel {
  readonly name = 'telegram';
  private cards = new Map<string, Card>();
  private offset = 0;
  private polling = false;
  private closed = false;
  private inflight = new Set<http.ClientRequest>();
  private readonly base: string;

  constructor(private readonly o: TelegramOptions) {
    this.base = o.apiBase ?? TELEGRAM_API;
  }

  /** POST a Bot API method; resolves `result` or throws a message that never contains the token */
  async call<T = unknown>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const url = new URL(`${this.base}/bot${this.o.token}/${method}`);
    const data = Buffer.from(JSON.stringify(body));
    const mod = url.protocol === 'https:' ? https : http;
    const text = await new Promise<string>((resolve, reject) => {
      const req = mod.request(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(data.length) }, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= 1024 * 1024) chunks.push(c);
          });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', () => reject(new Error(`telegram ${method}: response failed`)));
        },
      );
      this.inflight.add(req);
      req.on('close', () => this.inflight.delete(req));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        const code = (e as NodeJS.ErrnoException).code;
        reject(new Error(`telegram ${method}: ${code ?? (e.message === 'timeout' ? 'timeout' : 'network error')}`));
      });
      req.end(data);
    });
    let j: { ok?: boolean; result?: T; description?: string; error_code?: number };
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`telegram ${method}: not a Bot API reply`);
    }
    if (!j.ok) {
      const err = new Error(`telegram ${method}: ${String(j.description ?? 'error').slice(0, 160)}`) as Error & { code?: number };
      err.code = j.error_code;
      throw err;
    }
    return j.result as T;
  }

  /** The Settings "send test message" button. */
  async sendTest(profileName: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.call('sendMessage', { chat_id: this.o.chatId, text: `Guarded Browser: test message from profile “${profileName}”. Confirmations will appear here with Approve / Deny buttons.` });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  post(req: ConfirmRequest, expiresAt: number) {
    if (this.closed) return;
    const card = phoneCard(req, expiresAt);
    const c: Card = { text: card.text };
    this.cards.set(req.id, c);
    const markup = card.answerable
      ? { inline_keyboard: [[{ text: 'Approve', callback_data: `gb:a:${req.id}` }, { text: 'Deny', callback_data: `gb:d:${req.id}` }]] }
      : undefined;
    void this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.o.chatId,
      text: card.text,
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {}),
    })
      .then((m) => {
        c.messageId = m.message_id;
        this.o.audit?.({ what: 'card sent', confirmation: req.id, answerable: card.answerable });
        if (c.pendingFooter !== undefined) this.finish(req.id, c, c.pendingFooter);
      })
      .catch((e) => {
        this.cards.delete(req.id);
        this.o.audit?.({ what: 'card not sent', confirmation: req.id, error: (e as Error).message });
      });
    this.ensurePolling();
  }

  resolved(id: string, outcome: ConfirmOutcome, via: AnsweredVia) {
    const c = this.cards.get(id);
    if (!c) return;
    const word = outcome === 'approve' ? 'APPROVED' : outcome === 'timeout' ? 'EXPIRED (denied)' : outcome === 'stop' ? 'DENIED (task stopped)' : 'DENIED';
    const where = via === 'phone' ? 'on the phone' : via === 'screen' ? 'on screen' : 'no answer in time';
    const footer = `\n\n— ${word} (${where})`;
    if (c.messageId === undefined) {
      c.pendingFooter = footer;
      return;
    }
    this.finish(id, c, footer);
  }

  private finish(id: string, c: Card, footer: string) {
    this.cards.delete(id);
    // no reply_markup: the edit removes the buttons
    void this.call('editMessageText', { chat_id: this.o.chatId, message_id: c.messageId, text: (c.text + footer).slice(0, 4096), link_preview_options: { is_disabled: true } }).catch((e) =>
      this.o.audit?.({ what: 'card not updated', confirmation: id, error: (e as Error).message }),
    );
  }

  close() {
    this.closed = true;
    this.cards.clear();
    for (const r of this.inflight) r.destroy();
    this.inflight.clear();
  }

  /** pending cards (tests) */
  get pendingCards(): number {
    return this.cards.size;
  }

  private ensurePolling() {
    if (this.polling || this.closed) return;
    this.polling = true;
    void this.pollLoop().finally(() => {
      this.polling = false;
    });
  }

  private async pollLoop() {
    const secs = this.o.pollSeconds ?? 25;
    while (!this.closed && this.cards.size > 0) {
      try {
        const updates = await this.call<Array<Record<string, unknown>>>('getUpdates', { offset: this.offset, timeout: secs, allowed_updates: ['callback_query'] }, (secs + 10) * 1000);
        for (const u of Array.isArray(updates) ? updates : []) {
          const uid = Number(u.update_id);
          if (Number.isFinite(uid) && uid >= this.offset) this.offset = uid + 1;
          if (u.callback_query) await this.onCallback(u.callback_query as CallbackQuery);
        }
      } catch (e) {
        if (this.closed) return;
        const conflict = (e as { code?: number }).code === 409;
        this.o.audit?.({ what: 'poll failed', error: conflict ? 'another program is polling this bot: give the browser its own bot' : (e as Error).message });
        await new Promise((r) => setTimeout(r, conflict ? 10_000 : 3_000));
      }
    }
    // Telegram only forgets updates once a later getUpdates carries the new offset: confirm what was
    // handled now, or the next poller (this channel later, or a new one) gets the same presses again
    if (!this.closed && this.offset > 0) await this.call('getUpdates', { offset: this.offset, timeout: 0, limit: 1, allowed_updates: ['callback_query'] }).catch(() => undefined);
  }

  private async onCallback(cq: CallbackQuery) {
    const chat = cq.message?.chat?.id;
    // only the configured private chat, pressed by that same user; anything else is not ours to touch
    if (String(chat) !== this.o.chatId || String(cq.from?.id) !== this.o.chatId) {
      this.o.audit?.({ what: 'callback ignored', reason: 'not from the configured chat' });
      return;
    }
    const m = CALLBACK_RE.exec(String(cq.data ?? ''));
    const id = m?.[2];
    const c = id ? this.cards.get(id) : undefined;
    let note = 'This confirmation is no longer pending.';
    if (m && id && c && c.messageId === cq.message?.message_id && this.o.isPending(id)) {
      const outcome = m[1] === 'a' ? 'approve' : 'deny';
      const took = this.o.onAnswer(id, outcome);
      if (took) note = outcome === 'approve' ? 'Approved.' : 'Denied.';
      this.o.audit?.({ what: 'callback', confirmation: id, outcome, accepted: took });
    } else {
      this.o.audit?.({ what: 'callback ignored', reason: 'stale or unknown confirmation' });
    }
    await this.call('answerCallbackQuery', { callback_query_id: String(cq.id ?? ''), text: note }).catch(() => undefined);
  }
}

interface CallbackQuery {
  id?: string;
  from?: { id?: number };
  data?: string;
  message?: { message_id?: number; chat?: { id?: number } };
}

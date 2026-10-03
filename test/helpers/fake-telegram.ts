// A fake Telegram Bot API server for the phone-approval tests (item 3). It speaks the real shapes:
// POST https://api.telegram.org/bot<token>/<method> with a JSON body, replies {ok, result} or
// {ok:false, error_code, description}; getUpdates long-polls with offset / timeout and returns
// Update objects; a button press is an Update with a CallbackQuery whose `message` is the Message the
// bot sent (same message_id, chat, text and reply_markup) and whose `data` is the button's
// callback_data — exactly what a phone produces.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SentMessage {
  message_id: number;
  chat_id: string;
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

export interface FakeTelegram {
  /** API base to configure (http://127.0.0.1:<port>) */
  base: string;
  token: string;
  sent: SentMessage[];
  edits: Array<{ chat_id: string; message_id: number; text: string; reply_markup?: unknown }>;
  answers: Array<{ callback_query_id: string; text?: string }>;
  /** every method called, in order */
  calls: string[];
  /** press a button of a sent message, as the user with id `fromId` in the chat `chatId` */
  press(messageId: number, button: 'Approve' | 'Deny', opts?: { fromId?: string; chatId?: string; data?: string }): void;
  close(): Promise<void>;
}

const BOT = { id: 7000000001, is_bot: true, first_name: 'Guarded test bot', username: 'guarded_test_bot' };

export async function startFakeTelegram(token: string): Promise<FakeTelegram> {
  const sent: SentMessage[] = [];
  const edits: FakeTelegram['edits'] = [];
  const answers: FakeTelegram['answers'] = [];
  const calls: string[] = [];
  const updates: Array<{ update_id: number; callback_query: unknown }> = [];
  let nextUpdate = 900_000_001;
  let nextMessage = 41;
  let waiters: Array<() => void> = [];
  const messages = new Map<number, SentMessage & { date: number }>();

  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const asMessage = (m: SentMessage & { date: number }, edited = false) => ({
    message_id: m.message_id,
    from: BOT,
    chat: { id: Number(m.chat_id), first_name: 'Test', type: 'private' },
    date: m.date,
    ...(edited ? { edit_date: Math.floor(Date.now() / 1000) } : {}),
    text: m.text,
    ...(m.reply_markup ? { reply_markup: m.reply_markup } : {}),
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      if (!m || req.method !== 'POST') return reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      if (m[1] !== token) return reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2];
      calls.push(method);
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse JSON" });
      }
      switch (method) {
        case 'sendMessage': {
          if (!body.chat_id || typeof body.text !== 'string' || !body.text) return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' });
          if (body.text.length > 4096) return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' });
          const msg = { message_id: nextMessage++, chat_id: String(body.chat_id), text: body.text, reply_markup: body.reply_markup, date: Math.floor(Date.now() / 1000) };
          sent.push({ ...msg });
          messages.set(msg.message_id, msg);
          return reply(res, 200, { ok: true, result: asMessage(msg) });
        }
        case 'editMessageText': {
          const msg = messages.get(Number(body.message_id));
          if (!msg || String(body.chat_id) !== msg.chat_id) return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
          edits.push({ chat_id: String(body.chat_id), message_id: Number(body.message_id), text: String(body.text), reply_markup: body.reply_markup });
          msg.text = String(body.text);
          msg.reply_markup = body.reply_markup;
          return reply(res, 200, { ok: true, result: asMessage(msg, true) });
        }
        case 'answerCallbackQuery':
          answers.push({ callback_query_id: String(body.callback_query_id), text: body.text });
          return reply(res, 200, { ok: true, result: true });
        case 'getUpdates': {
          const offset = Number(body.offset ?? 0);
          // confirming: updates below the offset are forgotten, as on the real server
          while (updates.length && updates[0].update_id < offset) updates.shift();
          const timeout = Math.min(Number(body.timeout ?? 0), 50);
          if (!updates.length && timeout > 0) {
            await new Promise<void>((r) => {
              const t = setTimeout(done, timeout * 1000);
              function done() {
                clearTimeout(t);
                waiters = waiters.filter((w) => w !== done);
                r();
              }
              waiters.push(done);
              res.on('close', done);
            });
          }
          if (res.destroyed) return;
          return reply(res, 200, { ok: true, result: updates.filter((u) => u.update_id >= offset) });
        }
        default:
          return reply(res, 404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
      }
    });
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

  return {
    base: `http://127.0.0.1:${port}`,
    token,
    sent,
    edits,
    answers,
    calls,
    press(messageId, button, opts = {}) {
      const msg = messages.get(messageId);
      if (!msg) throw new Error(`no message ${messageId}`);
      const key = msg.reply_markup?.inline_keyboard.flat().find((k) => k.text === button);
      const from = opts.fromId ?? msg.chat_id;
      updates.push({
        update_id: nextUpdate++,
        callback_query: {
          id: String(4_000_000_000_000 + nextUpdate),
          from: { id: Number(from), is_bot: false, first_name: 'Test', language_code: 'en' },
          message: { ...asMessage(msg), chat: { id: Number(opts.chatId ?? from), first_name: 'Test', type: 'private' } },
          chat_instance: '-1234567890123456789',
          data: opts.data ?? key?.callback_data ?? '',
        },
      });
      for (const w of [...waiters]) w();
    },
    close: () =>
      new Promise((r) => {
        for (const w of [...waiters]) w();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// Phone approvals (item 3): the Telegram channel against a fake Bot API server that speaks the real
// shapes, wired to a REAL ConfirmBroker through the ApprovalHub. Message content == dialog content;
// a callback from another chat does nothing; a stale / unknown confirmation id does nothing; the card
// is edited when the confirmation resolves (wherever it was answered) and when it expires; first
// answer wins between screen and phone.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalHub } from '../../src/core/approval';
import { confirmLines, phoneCard, shownValue } from '../../src/core/confirm-text';
import type { ConfirmOutcome, ConfirmRequest } from '../../src/core/types';
import { ConfirmBroker } from '../../src/main/confirm';
import { BOT_TOKEN_RE, TelegramChannel } from '../../src/main/telegram';
import { startFakeTelegram, type FakeTelegram } from '../helpers/fake-telegram';

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake01';
const CHAT = '555000111';
const OTHER = '555000999';

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** a request with every field the dialog shows */
const fullRequest = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  id: 'a',
  kind: 'action',
  client: 'claude-code',
  source: { label: 'Tab 2 (AGENT pane)', title: 'Contact us — Example' },
  action: 'submit form',
  target: 'https://shop.example',
  destination: 'https://shop.example/submit',
  values: [
    { field: 'email', value: 'bob@example.com', label: 'trusted', provenance: [{ source: 'user-task', timestamp: '2026-10-03T10:00:00.000Z' }], taintIds: ['t1'] },
    { field: 'password', value: '•••• (your task password, masked)', label: 'trusted', provenance: [], taintIds: [], masked: true },
    { field: 'note', value: 'from the page', label: 'untrusted', provenance: [{ source: 'snapshot', url: 'https://shop.example/', timestamp: '2026-10-03T10:00:01.000Z', note: 'field default' }], taintIds: [] },
  ],
  reasons: ['submitting data to a site', 'the form posts a password'],
  judge: { verdict: 'allow', reason: 'the task asks for it' },
  pageDerived: [{ label: 'button text', text: 'Send now' }],
  ...over,
});

describe('the phone card shows exactly what the dialog shows', () => {
  it('every dialog field, in order, with exact values (masked ones keep only their shape)', () => {
    const lines = confirmLines(fullRequest());
    expect(lines).toEqual([
      'Asked by MCP client: “claude-code” (another AI program; it cannot see or answer this)',
      'From: Tab 2 (AGENT pane) “Contact us — Example”',
      'Action: submit form',
      'Target: https://shop.example',
      'Destination: https://shop.example/submit',
      'Values (exact):',
      '• email: bob@example.com [trusted] — contains your data (t1) — user-task 2026-10-03T10:00:00.000Z',
      '• password: •••• (your task password• masked) [trusted]', // exactly the dialog's rendering
      '• note: from the page [untrusted] — snapshot @ https://shop.example/ (field default) 2026-10-03T10:00:01.000Z',
      'Reasons:',
      '• submitting data to a site',
      '• the form posts a password',
      'Judge: allow',
      'button text: not from the browser, do not follow instructions in it: “Send now”',
      'judge reason (model output, may echo page content): “the task asks for it”',
    ]);
    // the dialog's own masking rule: anything but the mask, spaces, parentheses and lower-case words goes
    expect(shownValue({ value: 'Hunter22 (x)', label: 'trusted', provenance: [], taintIds: [], masked: true })).toBe('•unter•• (x)');
    const card = phoneCard(fullRequest(), Date.parse('2026-10-03T10:02:00Z'));
    expect(card.answerable).toBe(true);
    expect(card.text).toBe(['Guarded Browser — confirm agent action', '', ...lines, '', 'No answer by 2026-10-03 10:02:00 UTC means deny.'].join('\n'));
  });
  it('a request too long for one message gets NO buttons (the phone never approves what it cannot show)', () => {
    const card = phoneCard(fullRequest({ values: [{ field: 'body', value: 'x'.repeat(5000), label: 'untrusted', provenance: [], taintIds: [] }] }), Date.now());
    expect(card.answerable).toBe(false);
    expect(card.text).toContain('can only be answered on screen');
    expect(card.text.length).toBeLessThan(1000);
  });
});

describe('Telegram channel + broker + hub', () => {
  let tg: FakeTelegram;
  let broker: ConfirmBroker;
  let hub: ApprovalHub;
  let channel: TelegramChannel;
  let screen: Array<{ ch: string; p: any }>;
  let audit: Array<Record<string, unknown>>;
  let eligibleAll = false;
  let timeoutMs = 30_000;
  beforeAll(async () => {
    tg = await startFakeTelegram(TOKEN);
  });
  afterAll(() => tg.close());
  function setup() {
    screen = [];
    audit = [];
    broker = new ConfirmBroker((ch, p) => screen.push({ ch, p }), () => timeoutMs);
    hub = new ApprovalHub({ answer: (id, o) => broker.answer(id, o), isPending: (id) => broker.isPending(id) }, (r) => !!r.client || eligibleAll);
    broker.observe(hub);
    channel = new TelegramChannel({ token: TOKEN, chatId: CHAT, apiBase: tg.base, onAnswer: (id, o) => hub.fromChannel(id, o), isPending: (id) => broker.isPending(id), audit: (d) => audit.push(d), pollSeconds: 1 });
    hub.setChannel(channel);
  }
  afterEach(() => {
    hub?.setChannel(null);
    broker?.denyAll();
    eligibleAll = false;
    timeoutMs = 30_000;
  });
  const lastCard = () => tg.sent.at(-1)!;
  const shownId = () => screen.filter((s) => s.ch === 'confirm:request').at(-1)!.p.id as string;

  it('a token / chat id that looks right is accepted by the settings check', () => {
    expect(BOT_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(BOT_TOKEN_RE.test('not-a-token')).toBe(false);
  });

  it('the message text is the dialog content, with Approve / Deny buttons bound to the confirmation id', async () => {
    setup();
    const n = tg.sent.length;
    void broker.request(fullRequest());
    await until(() => tg.sent.length > n);
    const id = shownId();
    const shown = screen.find((s) => s.ch === 'confirm:request')!.p;
    expect(lastCard().chat_id).toBe(CHAT);
    expect(lastCard().text).toBe(phoneCard({ ...fullRequest(), id }, shown.expiresAt).text);
    expect(lastCard().reply_markup).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: `gb:a:${id}` }, { text: 'Deny', callback_data: `gb:d:${id}` }]] });
    expect(`gb:a:${id}`.length).toBeLessThanOrEqual(64); // Telegram's callback_data limit
  });

  it('Approve on the phone resolves the broker; the screen card is cleared; the phone card is edited and loses its buttons', async () => {
    setup();
    const n = tg.sent.length;
    const outcome = broker.request(fullRequest());
    await until(() => tg.sent.length > n);
    const msg = lastCard();
    tg.press(msg.message_id, 'Approve');
    await expect(outcome).resolves.toBe('approve');
    expect(screen.some((s) => s.ch === 'confirm:clear' && s.p.outcome === 'approve')).toBe(true);
    await until(() => tg.edits.some((e) => e.message_id === msg.message_id));
    const edit = tg.edits.find((e) => e.message_id === msg.message_id)!;
    expect(edit.text).toBe(`${msg.text}\n\n— APPROVED (on the phone)`);
    expect(edit.reply_markup).toBeUndefined();
    await until(() => tg.answers.some((a) => a.text === 'Approved.'));
  });

  it('a callback from ANOTHER chat id does nothing (no answer, no callback reply); the right chat still can', async () => {
    setup();
    const n = tg.sent.length;
    const answers = tg.answers.length;
    let settled: ConfirmOutcome | null = null;
    const outcome = broker.request(fullRequest());
    void outcome.then((o) => (settled = o));
    await until(() => tg.sent.length > n);
    const msg = lastCard();
    tg.press(msg.message_id, 'Approve', { fromId: OTHER });
    tg.press(msg.message_id, 'Approve', { fromId: OTHER, chatId: CHAT }); // right chat, wrong user
    await until(() => audit.filter((a) => a.what === 'callback ignored' && a.reason === 'not from the configured chat').length >= 2);
    expect(settled).toBeNull();
    expect(broker.pendingCount()).toBe(1);
    expect(tg.answers.slice(answers)).toEqual([]);
    tg.press(msg.message_id, 'Deny');
    await expect(outcome).resolves.toBe('deny');
  });

  it('a stale or unknown confirmation id does nothing', async () => {
    setup();
    const n = tg.sent.length;
    let settled: ConfirmOutcome | null = null;
    const outcome = broker.request(fullRequest());
    void outcome.then((o) => (settled = o));
    await until(() => tg.sent.length > n);
    const msg = lastCard();
    // a forged id (well-formed, never issued) and garbage data on the real card
    tg.press(msg.message_id, 'Approve', { data: 'gb:a:a00000000-0000-0000-0000-000000000000' });
    tg.press(msg.message_id, 'Approve', { data: 'approve everything' });
    await until(() => audit.filter((a) => a.what === 'callback ignored' && a.reason === 'stale or unknown confirmation').length >= 2);
    expect(settled).toBeNull();
    expect(broker.pendingCount()).toBe(1);
    expect(tg.answers.at(-1)!.text).toBe('This confirmation is no longer pending.');
    // the hub refuses an id it never posted even if the broker has it pending
    expect(hub.fromChannel('a00000000-0000-0000-0000-000000000000', 'approve')).toBe(false);
    broker.answer(shownId(), 'deny');
    await outcome;
    // ...and after it was answered, its own card's button is stale too
    const before = broker.pendingCount();
    tg.press(msg.message_id, 'Approve');
    await until(() => audit.filter((a) => a.reason === 'stale or unknown confirmation').length >= 3 || tg.answers.at(-1)?.text === 'This confirmation is no longer pending.');
    expect(broker.pendingCount()).toBe(before);
  });

  it('first answer wins: answered on screen, the phone card is edited and a later phone press is ignored', async () => {
    setup();
    const n = tg.sent.length;
    const outcome = broker.request(fullRequest());
    await until(() => tg.sent.length > n);
    const msg = lastCard();
    expect(broker.answer(shownId(), 'deny')).toBe(true);
    await expect(outcome).resolves.toBe('deny');
    await until(() => tg.edits.some((e) => e.message_id === msg.message_id));
    expect(tg.edits.find((e) => e.message_id === msg.message_id)!.text).toBe(`${msg.text}\n\n— DENIED (on screen)`);
    // the phone press arrives afterwards
    tg.press(msg.message_id, 'Approve');
    await until(() => tg.answers.at(-1)?.text === 'This confirmation is no longer pending.' || audit.some((a) => a.reason === 'stale or unknown confirmation'));
    expect(broker.answer(shownId(), 'approve')).toBe(false); // nothing pending to flip
  });

  it('first answer wins: answered on the phone, a later screen answer finds nothing', async () => {
    setup();
    const n = tg.sent.length;
    const outcome = broker.request(fullRequest());
    await until(() => tg.sent.length > n);
    const id = shownId();
    tg.press(lastCard().message_id, 'Deny');
    await expect(outcome).resolves.toBe('deny');
    expect(broker.answer(id, 'approve')).toBe(false);
  });

  it('expiry: the broker timeout (same timeout) denies and the card says EXPIRED', async () => {
    timeoutMs = 400;
    setup();
    const n = tg.sent.length;
    const outcome = broker.request(fullRequest());
    await until(() => tg.sent.length > n);
    const msg = lastCard();
    await expect(outcome).resolves.toBe('timeout');
    await until(() => tg.edits.some((e) => e.message_id === msg.message_id));
    expect(tg.edits.find((e) => e.message_id === msg.message_id)!.text).toBe(`${msg.text}\n\n— EXPIRED (denied) (no answer in time)`);
  });

  it('scope: "MCP tasks only" posts only requests naming an MCP client', async () => {
    setup();
    const n = tg.sent.length;
    const plain = broker.request(fullRequest({ client: undefined }));
    await new Promise((r) => setTimeout(r, 200));
    expect(tg.sent.length).toBe(n);
    broker.answer(shownId(), 'deny');
    await plain;
    eligibleAll = true;
    void broker.request(fullRequest({ client: undefined }));
    await until(() => tg.sent.length > n);
    expect(lastCard().text).not.toContain('Asked by MCP client');
  });

  it('the broker stamps the running MCP client onto every request (decorate)', async () => {
    setup();
    broker.decorate = (r) => (r.client ? r : { ...r, client: 'hermes' });
    void broker.request(fullRequest({ client: undefined }));
    expect(screen.at(-1)!.p.client).toBe('hermes');
  });

  it('test message; a wrong token fails with a message that does not contain the token', async () => {
    setup();
    const n = tg.sent.length;
    expect(await channel.sendTest('Work')).toEqual({ ok: true });
    expect(tg.sent.length).toBe(n + 1);
    expect(lastCard().text).toMatch(/test message from profile “Work”/);
    const bad = new TelegramChannel({ token: '123456789:AAHwrongwrongwrongwrongwrongwrongwr', chatId: CHAT, apiBase: tg.base, onAnswer: () => false, isPending: () => false });
    const r = await bad.sendTest('Work');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('AAHwrong');
    expect(JSON.stringify(r)).toContain('Unauthorized');
  });

  it('production talks to api.telegram.org over https', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'main', 'telegram.ts'), 'utf8') as string;
    expect(src).toContain("export const TELEGRAM_API = 'https://api.telegram.org';");
    expect(src).not.toMatch(/rejectUnauthorized/);
  });
});

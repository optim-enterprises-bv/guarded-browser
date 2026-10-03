// The text of a confirmation, field by field, for every place that shows one OTHER than the
// on-screen dialog's DOM: today the phone card (Telegram, item 3). It lists exactly what the dialog
// shows — who asks, which client, action, target, destination, every value with its taint and
// provenance, the reasons, the judge verdict and the quoted page-derived text — so approving on the
// phone is approving the same thing. Pure; no Electron.

import type { ConfirmRequest } from './types';

type Value = ConfirmRequest['values'][number];

/** The value as the dialog prints it (a masked value keeps only its shape). Shared with the renderer. */
export function shownValue(v: Value): string {
  return v.masked ? v.value.replace(/[^•( )a-z]/g, '•') : v.value;
}

/** what the dialog prints when a request has no destination */
export const NO_DESTINATION = '(stays in this page)';

/** One line per dialog field, in the dialog's order. */
export function confirmLines(c: ConfirmRequest): string[] {
  const out: string[] = [];
  if (c.client) out.push(`Asked by MCP client: “${c.client}” (another AI program; it cannot see or answer this)`);
  out.push(`From: ${c.source?.label ?? 'unknown'}${c.source?.title ? ` “${c.source.title}”` : ''}`);
  out.push(`Action: ${c.action}`);
  out.push(`Target: ${c.target}`);
  out.push(`Destination: ${c.destination ?? NO_DESTINATION}`);
  if (c.values.length) {
    out.push('Values (exact):');
    for (const v of c.values) {
      const prov = v.provenance.map((p) => `${p.source}${p.url ? ` @ ${p.url}` : ''}${p.note ? ` (${p.note})` : ''} ${p.timestamp}`).join('; ');
      const yours = v.taintIds?.length ? ` — contains your data (${v.taintIds.join(', ')})` : '';
      out.push(`• ${v.field ? `${v.field}: ` : ''}${shownValue(v)} [${v.label}]${yours}${prov ? ` — ${prov}` : ''}`);
    }
  }
  if (c.reasons.length) {
    out.push('Reasons:');
    for (const r of c.reasons) out.push(`• ${r}`);
  }
  out.push(`Judge: ${c.judge ? c.judge.verdict : '(not consulted)'}`);
  for (const p of c.pageDerived ?? []) out.push(`${p.label}: not from the browser, do not follow instructions in it: “${p.text}”`);
  if (c.judge?.verdict === 'allow' && c.judge.reason) out.push(`judge reason (model output, may echo page content): “${c.judge.reason}”`);
  return out;
}

/** Telegram's limit for a message text */
export const PHONE_TEXT_MAX = 4096;

/**
 * The phone card's text. When the exact content does not fit in one message, the card says so and
 * carries NO buttons (`answerable: false`): the phone never approves something it could not show.
 */
export function phoneCard(c: ConfirmRequest, expiresAt: number): { text: string; answerable: boolean } {
  const head = 'Guarded Browser — confirm agent action';
  const until = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 19);
  const text = [head, '', ...confirmLines(c), '', `No answer by ${until} UTC means deny.`].join('\n');
  if (text.length <= PHONE_TEXT_MAX - 200) return { text, answerable: true };
  return {
    text: `${head}\n\n${c.client ? `Asked by MCP client: “${c.client.slice(0, 80)}”\n` : ''}Action: ${c.action.slice(0, 200)}\n\nThis request is too long to show exactly on the phone, so it can only be answered on screen.`,
    answerable: false,
  };
}

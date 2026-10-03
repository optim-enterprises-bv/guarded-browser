// Injection X-ray panel (AI capabilities item 1): the chrome side of the per-tab report.
//
// Everything page-derived here (fragment text, URLs, hosts, form actions) is inserted with
// textContent — never innerHTML — so a hostile page cannot render markup in the chrome. Reason chips
// use fixed labels. The panel only ever ASKS main (toggle / re-scan / reveal); it sends nothing to a
// page and nothing off the machine.

import { REASON_LABELS, type HiddenReason } from '../core/xray-labels';

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

interface Fragment { id: number; kind: 'hidden' | 'visible'; reasons: HiddenReason[]; text: string; tag: string; anchor: number; score: number | null; flagged: boolean }
interface Host { host: string; count: number; listedBy: string | null; blocked: boolean; formTarget: boolean }
interface Form { action: string; method: string; actionOrigin: string | null; offSite: boolean; password: boolean; card: boolean; sensitiveOffSite: boolean; listedBy: string | null; fields: number; anchor: number }
interface Report {
  tabId: number;
  url: string;
  fragments: Fragment[];
  hosts: Host[];
  forms: Form[];
  guard: { state: 'scoring' | 'scored' | 'not-loaded'; detail: string };
  line: string;
  truncated: boolean;
  overlay: { boxes: number };
}

export function initXray(gb: Bridge, activeTab: () => number | null) {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const k of kids) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };
  /** the last report per tab id (null = X-ray off for that tab) */
  const reports = new Map<number, Report | null>();
  let note = '';

  function render() {
    const id = activeTab();
    const r = id === null ? null : reports.get(id) ?? null;
    const btn = $('btn-xray');
    btn.setAttribute('aria-pressed', r ? 'true' : 'false');
    btn.classList.toggle('on', !!r);
    $('xray').classList.toggle('hidden', !r && !note);
    $('xray-note').textContent = note;
    $('xray-note').classList.toggle('hidden', !note);
    for (const part of ['xray-body']) $(part).classList.toggle('hidden', !r);
    if (!r) return;
    $('xray-url').textContent = r.url;
    $('xray-summary').textContent = r.line;
    const g = $('xray-guard');
    g.dataset.state = r.guard.state;
    g.textContent =
      r.guard.state === 'scored' ? `Guard: scored (${r.guard.detail})` : r.guard.state === 'scoring' ? 'Guard: scoring the page text…' : `Guard not loaded — no injection scores (${r.guard.detail})`;

    const frags = $('xray-fragments');
    frags.replaceChildren();
    $('xray-n-frag').textContent = String(r.fragments.length);
    if (!r.fragments.length) frags.append(el('p', { class: 'muted small' }, 'No hidden text found.'));
    for (const f of r.fragments) {
      const chips = el('span', { class: 'xray-chips' });
      if (f.flagged) chips.append(el('span', { class: 'xray-chip inj', 'data-testid': 'xray-flag' }, `injection ${(f.score ?? 0).toFixed(2)}`));
      if (f.kind === 'visible') chips.append(el('span', { class: 'xray-chip' }, 'visible text'));
      for (const reason of f.reasons) chips.append(el('span', { class: 'xray-chip', 'data-testid': 'xray-reason' }, REASON_LABELS[reason] ?? 'hidden'));
      if (f.score !== null && !f.flagged) chips.append(el('span', { class: 'xray-chip muted' }, `guard ${f.score.toFixed(2)}`));
      const reveal = el('button', { class: 'xray-reveal', 'data-testid': 'xray-reveal', title: 'Scroll the page to this spot and outline it' }, 'Reveal in page');
      reveal.onclick = () => void gb.invoke('xray:reveal', f.anchor);
      // TEXT ONLY: the fragment is page text
      const text = el('div', { class: 'xray-text', 'data-testid': 'xray-text' });
      text.textContent = f.text;
      frags.append(
        el('div', { class: `xray-row${f.flagged ? ' inj' : ''}`, 'data-testid': 'xray-fragment', 'data-reason': f.reasons[0] ?? 'visible', 'data-reasons': f.reasons.join(' '), 'data-flagged': String(f.flagged) },
          el('div', { class: 'xray-row-head' }, chips, el('span', { class: 'muted small' }, `<${f.tag}>`), reveal), text),
      );
    }

    const hosts = $('xray-hosts');
    hosts.replaceChildren();
    if (!r.hosts.length) hosts.append(el('p', { class: 'muted small' }, 'This page has contacted no third-party host.'));
    for (const h of r.hosts) {
      const verdict = h.listedBy ? `listed by ${h.listedBy}${h.blocked ? ' (blocked)' : ''}` : 'not listed';
      const row = el('div', { class: `xray-row xray-host${h.listedBy ? ' bad' : ''}`, 'data-testid': 'xray-host', 'data-host': h.host, 'data-listed': String(!!h.listedBy) });
      const name = el('code', {});
      name.textContent = h.host;
      row.append(name, el('span', { class: 'muted small' }, ` ${h.count} request${h.count === 1 ? '' : 's'} · `), el('span', { class: h.listedBy ? 'xray-bad' : 'muted small', 'data-testid': 'xray-host-verdict' }, verdict));
      if (h.formTarget) row.append(el('span', { class: 'xray-chip inj' }, 'a form sends here'));
      hosts.append(row);
    }

    const forms = $('xray-forms');
    forms.replaceChildren();
    if (!r.forms.length) forms.append(el('p', { class: 'muted small' }, 'No forms on this page.'));
    for (const f of r.forms) {
      const row = el('div', { class: `xray-row${f.offSite ? ' bad' : ''}`, 'data-testid': 'xray-form', 'data-offsite': String(f.offSite), 'data-sensitive-offsite': String(f.sensitiveOffSite) });
      const action = el('code', {});
      action.textContent = `${f.method.toUpperCase()} ${f.actionOrigin ?? f.action}`;
      row.append(action);
      if (f.offSite) row.append(el('span', { class: 'xray-chip inj' }, 'sends off-site'));
      if (f.password) row.append(el('span', { class: 'xray-chip' }, 'password field'));
      if (f.card) row.append(el('span', { class: 'xray-chip' }, 'card field'));
      if (f.sensitiveOffSite) row.append(el('span', { class: 'xray-chip inj' }, 'sensitive data to another site'));
      if (f.listedBy) row.append(el('span', { class: 'xray-bad' }, ` target listed by ${f.listedBy}`));
      const reveal = el('button', { class: 'xray-reveal', 'data-testid': 'xray-form-reveal' }, 'Reveal');
      reveal.onclick = () => void gb.invoke('xray:reveal', f.anchor);
      row.append(reveal);
      forms.append(row);
    }
    $('xray-truncated').classList.toggle('hidden', !r.truncated);
  }

  async function toggle() {
    note = '';
    const r = await gb.invoke('xray:toggle').catch((e) => ({ ok: false, error: String(e) }));
    if (!r?.ok) note = `X-ray: ${r?.error ?? 'failed'}`;
    render();
  }

  $('btn-xray').onclick = () => void toggle();
  $('xray-close').onclick = () => {
    note = '';
    void gb.invoke('xray:clear');
    render();
  };
  $('xray-rescan').onclick = async () => {
    note = '';
    const r = await gb.invoke('xray:scan').catch((e) => ({ ok: false, error: String(e) }));
    if (!r?.ok) note = `X-ray: ${r?.error ?? 'failed'}`;
    render();
  };
  // main pushes every change: a scan, the guard's scores arriving, a clear on navigation
  gb.on('xray', (p: { tabId: number; report: Report | null }) => {
    if (!p || typeof p.tabId !== 'number') return;
    if (p.report) reports.set(p.tabId, p.report);
    else reports.delete(p.tabId);
    if (p.tabId === activeTab()) note = '';
    render();
  });

  return {
    /** the active tab may have changed: show its report (or hide the panel) */
    tabsChanged() {
      render();
    },
  };
}

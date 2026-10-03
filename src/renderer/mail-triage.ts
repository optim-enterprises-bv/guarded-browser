// The triage view of the mail panel (AI capabilities item 4).
//
// DOM + the `mail:triage-*` bridge only. The rules (what the model sees, strict validation, filters,
// sorting, totals, the plan/approve protocol) live in main (src/main/mail/triage.ts) and core
// (src/core/mail/triage.ts) and are unit-tested there.
//
// SECURITY: every value shown here — subject, sender, the model's label, a category name — reaches the
// DOM through `textContent` (`el()` below); a class name is only ever built from the FIXED category
// list main returns, after checking it against that list. Nothing in this file acts on a model's
// output: a bulk action is planned from what the USER picked (a category or ticked rows), main
// answers with the exact list, the list is shown, and only Approve applies it. Draft reply opens the
// compose form; the user's Send is the only thing that sends.

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
}
type AnyRec = Record<string, any>;

export interface TriageHooks {
  /** the account and folder selected in the mail panel */
  selection(): { accountId: string; folder: string; accounts: Array<{ id: string; label: string }> };
  /** open the compose form with these fields (a saved local draft) */
  openCompose(fields: AnyRec): Promise<void>;
  /** the mail panel's tree + list, after something changed on the server */
  refresh(): Promise<void>;
  status(msg: string): void;
}

let gb: Bridge;
let hooks: TriageHooks;
let filter = 'all';
let categories: string[] = [];
let lastState: AnyRec | null = null;
let pollTimer = 0;
const selected = new Set<number>();
let pendingToken = '';
let draftFor = 0;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // text, always
  return n;
}

/** A category chip; the class comes from the FIXED list, never from a free string. */
function chip(category: string): HTMLElement {
  const known = categories.includes(category) ? category : 'other';
  const c = el('span', `cat cat-${known}`, known);
  c.dataset.testid = 'triage-category';
  c.dataset.category = known;
  return c;
}

const fmtAmount = (a: AnyRec | null) => {
  if (!a || typeof a.value !== 'number') return '';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: String(a.currency) }).format(a.value);
  } catch {
    return `${a.value} ${String(a.currency)}`;
  }
};

// ---------------------------------------------------------------- open / close

export function openTriage() {
  const sel = hooks.selection();
  const acct = $<HTMLSelectElement>('t-account');
  acct.replaceChildren();
  const all = el('option', undefined, 'All accounts');
  all.value = 'all';
  acct.append(all);
  for (const a of sel.accounts) {
    const o = el('option', undefined, a.label);
    o.value = a.id;
    acct.append(o);
  }
  acct.value = sel.accountId || 'all';
  $('m-triage').classList.remove('hidden');
  void refresh();
}

function closeTriage() {
  $('m-triage').classList.add('hidden');
  $('m-triage-confirm').classList.add('hidden');
  $('m-triage-draft').classList.add('hidden');
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = 0;
}

// ---------------------------------------------------------------- state -> DOM

async function refresh() {
  const st: AnyRec = await gb.invoke('mail:triage-state', filter);
  lastState = st;
  categories = Array.isArray(st.categories) ? st.categories.map(String) : categories;
  render(st);
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = 0;
  if (st.running && !$('m-triage').classList.contains('hidden')) pollTimer = window.setTimeout(() => void refresh(), 300);
}

function render(st: AnyRec) {
  ($('t-run') as HTMLButtonElement).disabled = !!st.running;
  ($('t-stop') as HTMLButtonElement).disabled = !st.running;
  const p = st.progress;
  const prog = $('t-progress');
  prog.dataset.running = st.running ? 'true' : 'false';
  if (!p) prog.textContent = 'Not run yet.';
  else {
    const parts = [`${p.done}/${p.total} message(s)`];
    if (p.cached) parts.push(`${p.cached} from cache`);
    if (p.guardDrops) parts.push(`${p.guardDrops} suspicious line(s) removed by the injection filter`);
    if (p.invalid) parts.push(`${p.invalid} answer(s) were not valid and count as "other"`);
    if (!p.screened) parts.push('NOT screened: the injection filter is not loaded');
    if (st.running) parts.unshift('Running…');
    else if (st.stopped) parts.push(`stopped: ${st.stopped}`);
    if (st.error) parts.push(`error: ${st.error}`);
    prog.textContent = parts.join(' · ');
  }
  const notice = $('t-notice');
  notice.textContent = st.fallbackNotice ?? '';
  notice.classList.toggle('hidden', !st.fallbackNotice);

  for (const b of $('t-filters').querySelectorAll<HTMLButtonElement>('button[data-filter]')) b.classList.toggle('active', b.dataset.filter === st.filter);

  // totals per category (over the whole run); a click filters by that category
  const totals = $('t-totals');
  totals.replaceChildren();
  for (const c of categories) {
    const n = Number(st.totals?.[c] ?? 0);
    const t = el('span', `t-total${n ? '' : ' zero'}`);
    t.dataset.testid = 'triage-total';
    t.dataset.category = c;
    t.append(chip(c), el('span', 'muted small', ` ${n}`));
    t.onclick = () => {
      filter = `category:${c}`;
      void refresh();
    };
    totals.append(t);
  }

  // the bulk scope: the ticked rows, or a whole category of the run
  const scope = $<HTMLSelectElement>('t-scope');
  const prev = scope.value;
  scope.replaceChildren();
  const selOpt = el('option', undefined, `the selected messages (${selected.size})`);
  selOpt.value = 'selection';
  scope.append(selOpt);
  for (const c of categories) {
    const n = Number(st.totals?.[c] ?? 0);
    if (!n) continue;
    const o = el('option', undefined, `every "${c}" message (${n})`);
    o.value = `category:${c}`;
    scope.append(o);
  }
  if ([...scope.options].some((o) => o.value === prev)) scope.value = prev;

  const body = $('t-rows');
  body.replaceChildren();
  const rows: AnyRec[] = Array.isArray(st.rows) ? st.rows : [];
  // a selection only ever names rows shown in this view (a filter change keeps the visible ones)
  const ids = new Set(rows.map((r) => Number(r.id)));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  selOpt.textContent = `the selected messages (${selected.size})`;
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'muted small', st.count ? 'No messages match this filter.' : 'Run triage to sort messages here.');
    td.colSpan = 9;
    tr.append(td);
    body.append(tr);
  }
  for (const r of rows) {
    const tr = el('tr', r.valid ? '' : 't-invalid');
    tr.dataset.testid = 'triage-row';
    tr.dataset.messageId = String(r.id);
    tr.dataset.category = String(r.facts?.category ?? 'other');
    const cbCell = el('td');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.testid = 'triage-select';
    cb.checked = selected.has(Number(r.id));
    cb.onchange = () => {
      if (cb.checked) selected.add(Number(r.id));
      else selected.delete(Number(r.id));
      selOpt.textContent = `the selected messages (${selected.size})`;
    };
    cbCell.append(cb);
    const catCell = el('td');
    catCell.append(chip(String(r.facts?.category ?? 'other')));
    const due = el('td', 't-num', r.facts?.dueDate ?? '');
    due.dataset.testid = 'triage-due';
    const amount = el('td', 't-num', fmtAmount(r.facts?.amount ?? null));
    amount.dataset.testid = 'triage-amount';
    const reply = el('td', undefined, r.facts?.needsReply ? 'yes' : '');
    reply.dataset.testid = 'triage-needs-reply';
    const label = el('td', 't-label', String(r.facts?.label ?? ''));
    label.dataset.testid = 'triage-label';
    const from = el('td', 't-from', String(r.from ?? ''));
    from.title = String(r.from ?? '');
    const subject = el('td', 't-subject', String(r.subject ?? ''));
    subject.dataset.testid = 'triage-subject';
    subject.title = String(r.subject ?? '');
    const act = el('td');
    const d = el('button', 'link', 'Draft reply');
    d.dataset.testid = 'triage-draft';
    d.onclick = () => openDraft(Number(r.id), String(r.subject ?? ''), String(r.from ?? ''));
    act.append(d);
    tr.append(cbCell, catCell, due, amount, reply, label, from, subject, act);
    body.append(tr);
  }
}

// ---------------------------------------------------------------- run / stop

async function run() {
  const sel = hooks.selection();
  const kind = $<HTMLSelectElement>('t-range').value;
  const range = kind === 'days' ? { kind, days: Number($<HTMLInputElement>('t-days').value) } : kind === 'folder' ? { kind, folder: sel.folder } : { kind: 'unread' };
  const r = await gb.invoke('mail:triage-run', { accountId: $<HTMLSelectElement>('t-account').value, range, max: Number($<HTMLInputElement>('t-max').value) });
  $('t-msg').textContent = r?.ok ? '' : `Not run: ${r?.refused ?? r?.error ?? 'refused'}`;
  if (r?.ok) {
    selected.clear();
    filter = 'all';
  }
  await refresh();
}

// ---------------------------------------------------------------- plan -> confirm -> apply

async function plan() {
  const action = $<HTMLSelectElement>('t-action').value;
  const scope = $<HTMLSelectElement>('t-scope').value;
  const target = $<HTMLInputElement>('t-target').value;
  const spec: AnyRec = { action, ...(action === 'move' || action === 'label' ? { target } : {}) };
  if (scope.startsWith('category:')) spec.category = scope.slice(9);
  else spec.ids = [...selected];
  const r = await gb.invoke('mail:triage-plan', spec);
  if (!r?.ok) {
    $('t-msg').textContent = r?.error ?? 'could not plan that';
    return;
  }
  pendingToken = String(r.token);
  const verb = r.action === 'archive' ? 'Archive' : r.action === 'move' ? `Move to "${r.target}"` : r.action === 'flag' ? 'Flag' : `Label "${r.target}"`;
  $('t-c-title').textContent = `${verb}: ${r.items.length} message(s)?`;
  const list = $('t-c-list');
  list.replaceChildren();
  for (const it of r.items) {
    const li = el('li');
    li.dataset.testid = 'triage-confirm-item';
    li.dataset.messageId = String(it.id);
    const subj = el('strong', undefined, String(it.subject));
    subj.dataset.testid = 'triage-confirm-subject';
    const who = el('span', 'muted', ` — ${String(it.from)}`);
    who.dataset.testid = 'triage-confirm-from';
    li.append(subj, who);
    list.append(li);
  }
  $('m-triage-confirm').classList.remove('hidden');
}

async function answer(approve: boolean) {
  const token = pendingToken;
  pendingToken = '';
  $('m-triage-confirm').classList.add('hidden');
  const r = await gb.invoke('mail:triage-apply', token, approve);
  $('t-msg').textContent = r?.denied ? 'Nothing was changed.' : r?.ok ? `Done: ${r.applied} message(s) changed.` : `Not done: ${r?.refused ?? r?.error ?? 'failed'}`;
  if (!r?.denied) {
    selected.clear();
    await hooks.refresh();
  }
  await refresh();
}

// ---------------------------------------------------------------- draft reply

function openDraft(id: number, subject: string, from: string) {
  draftFor = id;
  $('t-d-about').textContent = `Reply to "${subject}" from ${from}.`;
  $<HTMLInputElement>('t-d-instruction').value = '';
  $('t-d-msg').textContent = '';
  $('m-triage-draft').classList.remove('hidden');
  $<HTMLInputElement>('t-d-instruction').focus();
}

async function writeDraft() {
  const go = $<HTMLButtonElement>('t-d-go');
  if (go.disabled || !draftFor) return;
  go.disabled = true;
  $('t-d-msg').textContent = 'writing…';
  try {
    const r = await gb.invoke('mail:triage-draft', draftFor, $<HTMLInputElement>('t-d-instruction').value);
    if (!r?.ok) {
      $('t-d-msg').textContent = r?.refused ?? r?.error ?? 'could not write a draft';
      return;
    }
    closeTriage();
    await hooks.openCompose(r.draft);
    hooks.status('A draft reply is open in compose. Edit it; nothing is sent until you press Send.');
  } finally {
    go.disabled = false;
  }
}

// ---------------------------------------------------------------- wiring

export function initTriage(bridge: Bridge, h: TriageHooks) {
  gb = bridge;
  hooks = h;
  $('m-triage-btn').onclick = () => openTriage();
  $('t-close').onclick = () => closeTriage();
  $('t-run').onclick = () => void run();
  $('t-stop').onclick = async () => {
    await gb.invoke('mail:triage-stop');
    await refresh();
  };
  $('t-range').onchange = () => $('t-days-label').classList.toggle('hidden', $<HTMLSelectElement>('t-range').value !== 'days');
  $('t-filters').onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button[data-filter]') as HTMLButtonElement | null;
    if (!b) return;
    filter = String(b.dataset.filter);
    void refresh();
  };
  $('t-action').onchange = () => {
    const a = $<HTMLSelectElement>('t-action').value;
    const t = $<HTMLInputElement>('t-target');
    t.classList.toggle('hidden', a !== 'move' && a !== 'label');
    t.placeholder = a === 'label' ? 'label name' : 'folder';
  };
  $('t-all').onchange = () => {
    const on = $<HTMLInputElement>('t-all').checked;
    for (const r of (lastState?.rows ?? []) as AnyRec[]) {
      if (on) selected.add(Number(r.id));
      else selected.delete(Number(r.id));
    }
    if (lastState) render(lastState);
  };
  $('t-plan').onclick = () => void plan();
  $('t-c-approve').onclick = () => void answer(true);
  $('t-c-deny').onclick = () => void answer(false);
  $('t-d-go').onclick = () => void writeDraft();
  $('t-d-cancel').onclick = () => $('m-triage-draft').classList.add('hidden');
  $<HTMLInputElement>('t-d-instruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void writeDraft();
  });
}

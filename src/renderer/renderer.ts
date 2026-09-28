// Browser chrome + agent panel. Plain DOM; all page content shown here is inserted as text.

import type { Settings } from '../core/config';
import type { ConfirmRequest } from '../core/types';
import { initAppearance } from './appearance';
import { initLibrary } from './library';

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}
declare global {
  interface Window {
    gb: Bridge;
  }
}

const gb = window.gb;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

// ---------- tabs & navigation ----------
interface TabInfo { id: number; title: string; url: string; loading: boolean; active: boolean; guardFlags: number; canGoBack: boolean; canGoForward: boolean; pane: number | null; selected: boolean; agent: boolean }
let lastTabs: TabInfo[] = [];

function renderTabs(list: TabInfo[]) {
  lastTabs = list;
  const box = $('tabs');
  box.replaceChildren();
  for (const t of list) {
    const x = el('button', { class: 'x', title: 'Close tab' }, '×');
    x.onclick = (ev) => {
      ev.stopPropagation();
      void gb.invoke('tabs:close', t.id);
    };
    const tab = el('div', { class: `tab${t.active ? ' active' : ''}${t.selected ? ' selected' : ''}`, 'data-testid': 'tab', 'data-tab-id': String(t.id), title: t.url },
      ...(t.agent ? [el('span', { class: 'lock-agent-chip', title: 'the agent is operating this tab' }, 'AGENT')] : []),
      ...(t.guardFlags ? [el('span', { class: 'lock-flag', title: 'content withheld by the guard' }, '!')] : []),
      ...(t.pane ? [el('span', { class: 'pnum' }, `[${t.pane}]`)] : []),
      el('span', { class: 'title' }, `${t.loading ? '… ' : ''}${t.title}`), x);
    // Ctrl/Cmd+click selects tabs for tiling; plain click activates
    tab.onclick = (ev) => {
      if (ev.ctrlKey || ev.metaKey) void gb.invoke('tabs:select', t.id);
      else void gb.invoke('tabs:activate', t.id);
    };
    tab.oncontextmenu = (ev) => {
      ev.preventDefault();
      showTabMenu(t, ev.clientX, ev.clientY);
    };
    box.append(tab);
  }
  const active = list.find((t) => t.active);
  if (active) {
    const addr = $<HTMLInputElement>('address');
    if (document.activeElement !== addr) addr.value = active.url === 'about:blank' ? '' : active.url;
    library?.tabsChanged(active.url);
    $<HTMLButtonElement>('back').disabled = !active.canGoBack;
    $<HTMLButtonElement>('forward').disabled = !active.canGoForward;
    const badge = $('guard-badge');
    badge.textContent = `Possible prompt injection: ${active.guardFlags} item(s) withheld`;
    badge.classList.toggle('hidden', !active.guardFlags);
  }
}

$('newtab').onclick = () => void gb.invoke('tabs:new');
$('back').onclick = () => void gb.invoke('nav:back');
$('forward').onclick = () => void gb.invoke('nav:forward');
$('reload').onclick = () => void gb.invoke('nav:reload');
$<HTMLInputElement>('address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    void gb.invoke('nav:go', (e.target as HTMLInputElement).value);
    (e.target as HTMLInputElement).blur();
  }
});

// ---------- split view ----------
interface Rect { x: number; y: number; width: number; height: number }
interface Geometry {
  mode: 'single' | 'tiled';
  layout: string | null;
  dragging: boolean;
  panes: Array<{ tabId: number; pane: number | null; outer: Rect; active: boolean; agent: boolean; chrome: boolean }>;
  dividers: Array<{ key: string; orientation: 'vertical' | 'horizontal'; rect: Rect }>;
  notice?: string;
}
let geometry: Geometry | null = null;
let dragKey: string | null = null;

const place = (e: HTMLElement, r: Rect) => Object.assign(e.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });

function renderPanes(g: Geometry) {
  geometry = g;
  const box = $('panes');
  box.replaceChildren();
  $('untile').toggleAttribute('disabled', g.mode !== 'tiled');
  $('tile-notice').textContent = g.notice ?? '';
  $('tile-notice').classList.toggle('hidden', !g.notice);
  if (g.layout) $<HTMLSelectElement>('tile-layout').value = g.layout;
  for (const p of g.panes) {
    const t = lastTabs.find((x) => x.id === p.tabId);
    if (g.dragging) {
      const ghost = el('div', { class: 'ghost' }, t?.title ?? '');
      place(ghost, p.outer);
      box.append(ghost);
      continue;
    }
    if (!p.chrome) continue;
    // Frame and header are browser chrome around the page view: a page cannot draw or fake them.
    const frame = el('div', { class: `pane${p.active ? ' active' : ''}${p.agent ? ' lock-agent-frame' : ''}`, 'data-testid': p.agent ? 'agent-pane' : 'pane', 'data-tab-id': String(p.tabId) });
    // the page title is page text: it is quoted and labelled, and non-agent headers use a fixed grey
    // style, so a title reading "AGENT ACTIVE" never looks like the real (black / yellow) agent header
    const head = el('div', { class: `phead ${p.agent ? 'lock-agent-head' : 'lock-pane-head'}` },
      ...(p.agent ? [el('span', { class: 'lock-agent-badge', 'data-testid': 'agent-active-badge' }, 'AGENT ACTIVE')] : []),
      ...(p.pane ? [el('span', { class: 'pnum' }, `pane ${p.pane}`)] : []),
      el('span', { class: 'ptitle', 'data-testid': 'pane-title' }, `page title: \u201c${(t?.title ?? '').slice(0, 120)}\u201d`));
    head.onclick = () => void gb.invoke('tabs:activate', p.tabId);
    frame.append(head);
    place(frame, p.outer);
    box.append(frame);
  }
  for (const d of g.dividers) {
    const div = el('div', { class: `divider ${d.orientation}${dragKey === d.key ? ' dragging' : ''}`, 'data-testid': 'divider', 'data-key': d.key });
    place(div, d.rect);
    div.onpointerdown = (ev) => {
      ev.preventDefault();
      dragKey = d.key;
      void gb.invoke('tiles:drag', 'start');
      const move = (m: PointerEvent) => void gb.invoke('tiles:drag', 'move', d.key, d.orientation === 'vertical' ? m.clientX : m.clientY);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        dragKey = null;
        void gb.invoke('tiles:drag', 'end');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    box.append(div);
  }
}

function showTabMenu(t: TabInfo, x: number, y: number) {
  const menu = $('tab-menu');
  const item = (label: string, fn: () => void) => {
    const b = el('button', { role: 'menuitem' }, label);
    b.onclick = () => {
      menu.classList.add('hidden');
      fn();
    };
    return b;
  };
  const selected = lastTabs.filter((x) => x.selected).map((x) => x.id);
  const ids = [...new Set([t.id, ...selected])];
  menu.replaceChildren(
    item(t.selected ? 'Deselect for split view' : 'Select for split view', () => void gb.invoke('tabs:select', t.id)),
    item('Tile side by side', () => void gb.invoke('tiles:tile', ids.length >= 2 ? ids : undefined, 'columns')),
    item('Tile stacked', () => void gb.invoke('tiles:tile', ids.length >= 2 ? ids : undefined, 'rows')),
    item('Tile as grid', () => void gb.invoke('tiles:tile', ids.length >= 2 ? ids : undefined, 'grid')),
    item('Untile', () => void gb.invoke('tiles:untile')),
  );
  Object.assign(menu.style, { left: `${x}px`, top: `${y}px` });
  menu.classList.remove('hidden');
}
document.addEventListener('click', (e) => {
  if (!$('tab-menu').contains(e.target as Node)) $('tab-menu').classList.add('hidden');
});
$('tile').onclick = () => void gb.invoke('tiles:tile', undefined, $<HTMLSelectElement>('tile-layout').value);
$('untile').onclick = () => void gb.invoke('tiles:untile');
$<HTMLSelectElement>('tile-layout').onchange = () => {
  if (geometry?.mode === 'tiled') void gb.invoke('tiles:layout', $<HTMLSelectElement>('tile-layout').value);
};
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void gb.invoke('tiles:tile', undefined, $<HTMLSelectElement>('tile-layout').value);
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    void gb.invoke('tiles:untile');
  }
});
gb.on('geometry', renderPanes);

// ---------- status chips ----------
function renderState(s: any) {
  if (s.profile) {
    myProfile = s.profile;
    renderProfileButton();
  }
  renderTabs(s.tabs);
  const g = $('chip-guard');
  g.textContent =
    s.guard.status === 'ready' ? 'guard: on' : s.guard.status === 'loading' ? (/^guard model /.test(s.guard.detail) ? s.guard.detail : 'guard: loading') : 'guard unavailable';
  g.title = s.guard.detail;
  g.className = `lock-chip ${s.guard.status === 'ready' ? 'lock-chip-ok' : s.guard.status === 'loading' ? 'lock-chip-loading' : 'lock-chip-bad'}`;
  renderEgress(s.egress);
  renderFallback(s.fallback);
  renderReputation(s.reputation);
  $('banner-policy').classList.toggle('hidden', !s.policyDisabled);
  setRunning(!!s.task);
  for (const c of s.confirmations ?? []) queueConfirm(c);
}

function renderEgress(e: { mode: string; allowed: string[]; blocked: Array<{ host: string; count: number }> }) {
  const chip = $('chip-egress');
  chip.textContent = e.mode === 'agent' ? `egress: allowlist (${e.allowed.length})` : 'egress: log-only';
  chip.title = e.mode === 'agent' ? `allowed hosts: ${e.allowed.join(', ')}` : 'manual browsing: requests are logged, denylist enforced';
  chip.className = `chip ${e.mode === 'agent' ? 'agent' : ''}`;
  const box = $('blocked');
  box.replaceChildren();
  for (const b of e.blocked) {
    const btn = el('button', { 'data-testid': 'allow-host' }, 'Allow for this task');
    btn.onclick = () => void gb.invoke('egress:allow', b.host);
    box.append(el('div', { class: 'item', 'data-testid': 'blocked-host' }, el('code', {}, `blocked host ${b.host} (${b.count} request${b.count === 1 ? '' : 's'})`), btn));
  }
  box.classList.toggle('hidden', e.blocked.length === 0);
}

function renderReputation(r: any) {
  if (!r) return;
  const chip = $('chip-rep');
  const failing = r.feeds.filter((f: any) => f.enabled && f.lastError).length;
  chip.textContent = r.enabled ? `reputation: ${r.total.toLocaleString()} hosts${failing ? `, ${failing} feed error(s)` : ''}` : 'reputation: off';
  chip.className = `chip ${!r.enabled || r.total === 0 ? 'bad' : failing ? '' : 'ok'}`;
  chip.title = r.feeds.map((f: any) => `${f.name}: ${f.entries} entries, age ${f.ageHours ?? '-'} h, failures ${f.failures}${f.lastError ? ` (${f.lastError})` : ''}`).join('\n');
  const table = $('rep-table');
  table.replaceChildren(el('tr', {}, el('th', {}, 'feed'), el('th', {}, 'entries'), el('th', {}, 'age (h)'), el('th', {}, 'source'), el('th', {}, 'failures / last error')));
  for (const f of r.feeds) {
    table.append(el('tr', {}, el('td', { title: f.url }, `${f.name}${f.enabled ? '' : ' (disabled)'}`), el('td', {}, String(f.entries)), el('td', {}, String(f.ageHours ?? '-')), el('td', {}, f.source), el('td', { class: 'small' }, `${f.failures}${f.lastError ? `: ${f.lastError}` : ''}`)));
  }
  $('rep-files').textContent = `Local lists (one host per line, allowlist wins): ${r.localBlockFile} , ${r.localAllowFile}. Google Safe Browsing: ${r.safeBrowsing ? 'enabled' : 'disabled'}.`;
}

$('rep-refresh').onclick = async () => {
  $('rep-refresh').setAttribute('disabled', '');
  try {
    renderReputation(await gb.invoke('reputation:refresh'));
  } finally {
    $('rep-refresh').removeAttribute('disabled');
  }
};

function renderFallback(f: Record<string, string>) {
  const roles = Object.keys(f);
  const b = $('banner-fallback');
  b.textContent = roles.length ? `CLOUD FALLBACK ACTIVE for ${roles.join(', ')}: local model unreachable.` : '';
  b.title = Object.values(f).join('\n');
  b.classList.toggle('hidden', roles.length === 0);
}

// ---------- task ----------
function setRunning(running: boolean) {
  $<HTMLButtonElement>('run').disabled = running;
  $<HTMLButtonElement>('stop').disabled = !running;
  if (!running && $('status').textContent?.startsWith('running')) $('status').textContent = 'idle';
}

// Run -> show the seed allowlist for editing -> Start
$('run').onclick = async () => {
  const text = $<HTMLTextAreaElement>('task').value.trim();
  if (!text) return;
  const origins: string[] = await gb.invoke('agent:preview', text);
  $<HTMLTextAreaElement>('pf-origins').value = origins.join('\n');
  $('preflight').classList.remove('hidden');
  $<HTMLButtonElement>('run').disabled = true;
};
$('pf-cancel').onclick = () => {
  $('preflight').classList.add('hidden');
  $<HTMLButtonElement>('run').disabled = false;
};
$('pf-start').onclick = async () => {
  const text = $<HTMLTextAreaElement>('task').value.trim();
  const origins = $<HTMLTextAreaElement>('pf-origins').value.split('\n').map((x) => x.trim()).filter(Boolean);
  $('preflight').classList.add('hidden');
  $('answer').classList.add('hidden');
  $('status').removeAttribute('data-status');
  $('timeline').replaceChildren();
  try {
    await gb.invoke('agent:start', text, origins);
    setRunning(true);
    $('status').textContent = 'running';
  } catch (e) {
    $('status').textContent = String(e);
    $<HTMLButtonElement>('run').disabled = false;
  }
};
$('stop').onclick = () => void gb.invoke('agent:stop');

gb.on('agent:update', (u) => {
  $('status').textContent = `running: ${u.status}${u.step ? ` (step ${u.step})` : ''}`;
});
gb.on('agent:done', (r) => {
  setRunning(false);
  $('status').textContent = `task ${r.status}`;
  $('status').setAttribute('data-status', r.status);
  const a = $('answer');
  a.textContent = r.answer ? `Answer (from the agent; based on untrusted page data):\n${r.answer}` : `Task ended: ${r.status}`;
  a.classList.remove('hidden');
});

// ---------- confirmation modal ----------
const confirmQueue: Array<ConfirmRequest & { expiresAt?: number }> = [];
let timerHandle: number | undefined;
let shownId = '';

function queueConfirm(c: ConfirmRequest & { expiresAt?: number }) {
  if (!confirmQueue.some((q) => q.id === c.id)) confirmQueue.push(c);
  showConfirm();
}

function showConfirm() {
  const c = confirmQueue[0];
  const box = $('confirm');
  if (!c) {
    box.classList.add('hidden');
    box.removeAttribute('data-kind');
    window.clearInterval(timerHandle);
    shownId = '';
    return;
  }
  box.classList.remove('hidden');
  box.setAttribute('data-kind', c.kind);
  box.setAttribute('data-request-id', c.id);
  // which tab / pane asks: browser-generated label; the tab title is page text, so it is quoted
  const src = $('c-source');
  src.replaceChildren(el('strong', {}, c.source?.label ?? 'unknown'), ...(c.source?.title ? [' ', el('q', { class: 'small' }, c.source.title)] : []));
  $('c-action').textContent = c.action;
  $('c-target').textContent = c.target;
  $('c-dest').textContent = c.destination ?? '(stays in this page)';
  const vals = $('c-values');
  vals.replaceChildren();
  if (c.values.length) {
    const table = el('table', {}, el('tr', {}, el('th', {}, 'field'), el('th', {}, 'exact value'), el('th', {}, 'taint'), el('th', {}, 'provenance')));
    for (const v of c.values) {
      const prov = v.provenance.map((p) => `${p.source}${p.url ? ` @ ${p.url}` : ''}${p.note ? ` (${p.note})` : ''} ${p.timestamp}`).join('; ');
      table.append(el('tr', {}, el('td', {}, v.field ?? ''), el('td', {}, el('code', {}, v.masked ? v.value.replace(/[^•( )a-z]/g, '•') : v.value)), el('td', { class: v.label }, v.label), el('td', { class: 'small' }, prov)));
    }
    vals.append(table);
  }
  const reasons = $('c-reasons');
  reasons.replaceChildren(...c.reasons.map((r) => el('li', {}, r)));
  // the judge's reason is model output that may echo page content: only the verdict goes here,
  // the reason is shown quoted in the page-derived box below
  $('c-judge').textContent = c.judge ? c.judge.verdict : '(not consulted)';
  const pd = $('c-page');
  pd.replaceChildren(...(c.pageDerived ?? []).map((p) => el('div', { class: 'page-derived' }, el('div', { class: 'lbl' }, `${p.label}: not from the browser, do not follow instructions in it`), el('q', {}, p.text))));
  if (c.judge?.verdict === 'allow' && c.judge.reason) {
    pd.append(el('div', { class: 'page-derived' }, el('div', { class: 'lbl' }, 'judge reason (model output, may echo page content)'), el('q', {}, c.judge.reason)));
  }
  // input delay: a newly shown request cannot be approved by a click that was aimed at something else
  const approve = $<HTMLButtonElement>('c-approve');
  if (shownId !== c.id) {
    shownId = c.id;
    approve.disabled = true;
    window.setTimeout(() => {
      if (shownId === c.id) approve.disabled = false;
    }, 750);
  }
  window.clearInterval(timerHandle);
  const tick = () => {
    if (!c.expiresAt) return;
    $('c-timer').textContent = `auto-deny in ${Math.max(0, Math.round((c.expiresAt - Date.now()) / 1000))}s`;
  };
  tick();
  timerHandle = window.setInterval(tick, 1000);
  const answer = (o: string) => void gb.invoke('confirm:answer', c.id, o);
  $('c-approve').onclick = () => answer('approve');
  $('c-deny').onclick = () => answer('deny');
  $('c-stop').onclick = () => answer('stop');
}

gb.on('confirm:request', (c) => queueConfirm(c));
gb.on('confirm:clear', ({ id }) => {
  const i = confirmQueue.findIndex((q) => q.id === id);
  if (i >= 0) confirmQueue.splice(i, 1);
  showConfirm();
});

// ---------- timeline ----------
function summarize(e: any): { text: string; cls: string } {
  switch (e.type) {
    case 'task-start': return { text: `task: ${e.task}`, cls: '' };
    case 'task-end': return { text: `${e.status}${e.answer ? `: ${String(e.answer).slice(0, 160)}` : ''}`, cls: e.status === 'finished' ? '' : 'deny' };
    case 'planner-action': return { text: `${e.action} ${JSON.stringify(e.args).slice(0, 160)}`, cls: '' };
    case 'policy': return { text: `${e.decision}: ${(e.reasons ?? []).join('; ')}`, cls: e.decision };
    case 'judge': return { text: `${e.verdict}: ${e.reason}`, cls: e.verdict };
    case 'confirmation': return { text: `${e.outcome}: ${e.action}${e.destination ? ` -> ${e.destination}` : ''}`, cls: e.outcome === 'approve' ? '' : 'deny' };
    case 'guard': return { text: `${e.what}: ${e.flagged ?? 0} flagged, max score ${typeof e.maxScore === 'number' ? e.maxScore.toFixed(3) : '-'} (${e.status ?? ''})`, cls: e.flagged ? 'confirm' : '' };
    case 'reader': return { text: e.ok ? `${e.query} -> ${JSON.stringify(e.output).slice(0, 160)} [untrusted]` : `failed: ${e.error}`, cls: e.ok ? '' : 'deny' };
    case 'snapshot': return { text: `${e.url} (${e.elements} elements, #${e.hash})`, cls: '' };
    case 'navigation': return { text: `${e.by ?? ''} ${e.url}${e.blocked ? ' (blocked)' : ''}`, cls: e.blocked ? 'block' : '' };
    case 'egress': if (e.layer === 'reputation') return { text: `REPUTATION ${e.decision} ${e.host}: ${e.reason}`, cls: e.decision === 'block' ? 'block' : '' };
      return { text: `${e.layer} ${e.decision} ${e.method} ${e.host}: ${e.reason}${e.taintIds ? ` [${e.taintIds.join(',')}]` : ''}`, cls: e.decision === 'block' ? 'block' : '' };
    case 'action-result': return { text: `${e.action} ${e.ok ? 'ok' : `failed ${e.detail ?? ''}`}`, cls: e.ok ? '' : 'deny' };
    default: return { text: JSON.stringify(e).slice(0, 200), cls: '' };
  }
}

function addTimeline(e: any) {
  // routine proxy traffic would drown the timeline; it is all still in the JSONL file
  if (e.type === 'egress' && (e.decision === 'log' || (e.layer === 'proxy' && e.decision === 'allow' && e.method !== '-'))) return;
  const s = summarize(e);
  const li = el('li', { class: s.cls, 'data-type': e.type }, el('span', { class: 't' }, e.type), s.text);
  const ol = $('timeline');
  ol.prepend(li);
  while (ol.children.length > 300) ol.lastChild?.remove();
}

gb.on('audit', addTimeline);

// ---------- settings ----------
let current: Settings | null = null;

function field(label: string, path: string, value: unknown, type = 'text') {
  const input = el('input', { 'data-path': path, type }) as HTMLInputElement;
  if (type === 'checkbox') input.checked = !!value;
  else input.value = typeof value === 'object' ? JSON.stringify(value ?? {}) : String(value ?? '');
  return el('label', {}, label, input);
}

async function openSettings() {
  current = await gb.invoke('settings:get');
  const s = current!;
  const form = $('settings-form');
  form.replaceChildren();
  for (const role of ['planner', 'reader', 'judge'] as const) {
    const r = s.models[role];
    form.append(el('fieldset', {}, el('legend', {}, role),
      field('baseURL', `models.${role}.primary.baseURL`, r.primary.baseURL),
      field('model', `models.${role}.primary.model`, r.primary.model),
      field('apiKeyEnv', `models.${role}.primary.apiKeyEnv`, r.primary.apiKeyEnv ?? ''),
      field('extraBody (JSON)', `models.${role}.primary.extraBody`, r.primary.extraBody ?? {}),
      field('cloud fallback', `models.${role}.fallback.enabled`, r.fallback.enabled, 'checkbox'),
      field('fallback baseURL', `models.${role}.fallback.baseURL`, r.fallback.baseURL),
      field('fallback model', `models.${role}.fallback.model`, r.fallback.model),
      field('fallback key env', `models.${role}.fallback.apiKeyEnv`, r.fallback.apiKeyEnv ?? ''),
    ));
  }
  form.append(el('fieldset', {}, el('legend', {}, 'agent'),
    field('max steps', 'agent.maxSteps', s.agent.maxSteps, 'number'),
    field('task timeout ms', 'agent.taskTimeoutMs', s.agent.taskTimeoutMs, 'number'),
    field('confirm timeout ms', 'agent.confirmTimeoutMs', s.agent.confirmTimeoutMs, 'number')));
  form.append(el('fieldset', { 'data-testid': 'guard-settings' }, el('legend', {}, 'guard \u2014 applies to ALL profiles (restart to apply)'),
    field('enabled', 'guard.enabled', s.guard.enabled, 'checkbox'),
    field('threshold', 'guard.threshold', s.guard.threshold, 'number'),
    field('CPU threads', 'guard.threads', s.guard.threads, 'number')));
  form.append(el('fieldset', {}, el('legend', {}, 'egress'),
    field('denylist (comma)', 'egress.denylist', s.egress.denylist.join(', '))));
  form.append(el('fieldset', {}, el('legend', {}, 'reputation'),
    field('enabled', 'reputation.enabled', s.reputation.enabled, 'checkbox'),
    field('feeds (JSON) \u2014 applies to ALL profiles', 'reputation.feeds', s.reputation.feeds),
    field('Safe Browsing', 'reputation.safeBrowsing.enabled', s.reputation.safeBrowsing.enabled, 'checkbox'),
    field('SB key env var', 'reputation.safeBrowsing.apiKeyEnv', s.reputation.safeBrowsing.apiKeyEnv)));
  $('s-msg').textContent = '';
  $('settings').classList.remove('hidden');
}

function setPath(obj: any, path: string, value: unknown) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p];
  o[parts.at(-1)!] = value;
}

$('open-settings').onclick = () => void openSettings();
$('s-close').onclick = () => {
  $('settings').classList.add('hidden');
  appearanceUi.closePreview();
};
$('s-save').onclick = async () => {
  if (!current) return;
  const s = structuredClone(current);
  try {
    for (const input of $('settings-form').querySelectorAll<HTMLInputElement>('input[data-path]')) {
      const path = input.dataset.path!;
      let v: unknown = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'number') v = Number(input.value);
      if (path.endsWith('extraBody')) v = input.value.trim() ? JSON.parse(input.value) : {};
      if (path === 'reputation.feeds') v = JSON.parse(input.value);
      if (path === 'egress.denylist') v = input.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (path.endsWith('apiKeyEnv') && v === '') v = undefined;
      setPath(s, path, v);
    }
    await gb.invoke('settings:save', s);
    current = s;
    $('s-msg').textContent = 'saved';
  } catch (e) {
    $('s-msg').textContent = `not saved: ${(e as Error).message}`;
  }
};

// ---------- profiles ----------
interface ProfileInfo { id: string; name: string; color: string; open: boolean }
let myProfile: { id: string; name: string; color: string } | null = null;

function avatar(p: { name: string; color: string }) {
  const a = el('span', { class: 'avatar' }, (p.name.trim()[0] ?? '?').toUpperCase());
  a.style.background = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#888888';
  return a;
}

function renderProfileButton() {
  if (!myProfile) return;
  const av = $('profile-avatar');
  av.textContent = (myProfile.name.trim()[0] ?? '?').toUpperCase();
  av.style.background = /^#[0-9a-f]{6}$/i.test(myProfile.color) ? myProfile.color : '#888888';
  $('profile-name').textContent = myProfile.name;
  $('profile-btn').setAttribute('data-profile-id', myProfile.id);
}

function renderProfiles(list: ProfileInfo[]) {
  const box = $('profile-list');
  box.replaceChildren();
  for (const p of list) {
    const name = el('input', { value: p.name, maxlength: '40', 'data-testid': 'profile-name-input' }) as HTMLInputElement;
    const color = el('input', { type: 'color', value: p.color, 'data-testid': 'profile-color-input' }) as HTMLInputElement;
    const save = el('button', { 'data-testid': 'profile-save' }, 'Save');
    save.onclick = async () => {
      const r = await gb.invoke('profiles:update', p.id, { name: name.value, color: color.value });
      $('pr-msg').textContent = r.ok ? 'saved' : r.error;
    };
    const open = el('button', { 'data-testid': 'profile-open' }, p.id === myProfile?.id ? 'This window' : p.open ? 'Show window' : 'Open in new window');
    open.onclick = () => void gb.invoke('profiles:open', p.id);
    const del = el('button', { class: 'danger', 'data-testid': 'profile-delete' }, 'Delete');
    del.onclick = async () => {
      const r = await gb.invoke('profiles:delete', p.id);
      $('pr-msg').textContent = r?.ok ? 'deleted' : r?.error ?? '';
    };
    box.append(el('div', { class: 'profile-row', 'data-testid': 'profile-row', 'data-profile-id': p.id }, avatar(p), name, color, el('span', { class: 'actions-inline' }, save, open, del)));
  }
}

async function openProfiles() {
  renderProfiles(await gb.invoke('profiles:list'));
  $('profiles').classList.remove('hidden');
}
$('profile-btn').onclick = () => void openProfiles();
$('pr-close').onclick = () => $('profiles').classList.add('hidden');
$('pn-create').onclick = async () => {
  const r = await gb.invoke('profiles:create', $<HTMLInputElement>('pn-name').value, $<HTMLInputElement>('pn-color').value);
  $('pr-msg').textContent = r.ok ? 'created' : r.error;
  if (r.ok) $<HTMLInputElement>('pn-name').value = '';
};
gb.on('profiles', (list: ProfileInfo[]) => {
  if (!$('profiles').classList.contains('hidden')) renderProfiles(list);
});
gb.on('profiles:show-manager', () => void openProfiles());

// ---------- boot ----------
const appearanceUi = initAppearance(gb);
void appearanceUi.load();
const library = initLibrary(gb);
void library.load();
gb.on('state', renderState);
gb.on('tabs', (l: TabInfo[]) => {
  renderTabs(l);
  if (geometry) renderPanes(geometry);
});
gb.on('egress', renderEgress);
gb.on('fallback', renderFallback);
gb.on('reputation', renderReputation);
void gb.invoke('state:get').then(renderState);
void gb.invoke('audit:recent').then((events: any[]) => events.forEach(addTimeline));

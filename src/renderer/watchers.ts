// Watchers (item 5), the chrome side: create from the current page (an isolated-world picker in the
// page returns a locator), or from a read-only recipe; list, pause / resume, run now, history, delete;
// and the runner setting (the external CDP option is greyed out until its binary exists). Values in
// the history can be page text: inserted as TEXT only.

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

interface HistoryRow {
  at: number;
  value: number | string | null;
  met: boolean;
  notified: boolean;
  error?: string;
  runner: string;
}
interface WatcherView {
  id: string;
  name: string;
  url: string;
  origins: string[];
  recipeId: string | null;
  kind: string;
  condition: string;
  everyMinutes: number;
  useLogin: boolean;
  paused: boolean;
  running: boolean;
  nextRunAt: number;
  failures: number;
  lastValue: number | string | null;
  history: HistoryRow[];
}
interface RunnerView {
  runner: 'electron' | 'external';
  externalPath: string;
  flavor: string;
  externalAvailable: boolean;
  externalReason: string;
}
interface State {
  watchers: WatcherView[];
  runner: RunnerView;
  waiting: string | null;
}

export function initWatchers(gb: Bridge) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const k of kids) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };
  const button = (label: string, testid: string, fn: () => void, cls = '') => {
    const b = el('button', { 'data-testid': testid, ...(cls ? { class: cls } : {}) }, label) as HTMLButtonElement;
    b.onclick = fn;
    return b;
  };
  const msg = (t: string) => ($('watch-msg').textContent = t);
  let draft: { url?: string; recipeId?: string; locator?: unknown; expect?: unknown } | null = null;
  const hist = new Set<string>();
  let state: State = { watchers: [], runner: { runner: 'electron', externalPath: '', flavor: 'lightpanda', externalAvailable: false, externalReason: 'no path set' }, waiting: null };

  // ---------------------------------------------------------------- create

  function showForm(target: string, name: string, kind: string, condValue: string) {
    $('watch-target').textContent = target;
    $<HTMLInputElement>('watch-name').value = name.slice(0, 80);
    $<HTMLSelectElement>('watch-kind').value = kind;
    $<HTMLSelectElement>('watch-cond').value = kind === 'number' ? 'below' : 'changes';
    $<HTMLInputElement>('watch-cond-value').value = condValue;
    syncCond();
    $('watch-form').classList.remove('hidden');
  }
  function syncCond() {
    const c = $<HTMLSelectElement>('watch-cond').value;
    $('watch-cond-value').classList.toggle('hidden', c === 'changes');
  }
  $('watch-cond').onchange = syncCond;
  $('watch-login').onchange = () => $('watch-login-warn').classList.toggle('hidden', !$<HTMLInputElement>('watch-login').checked);
  $('watch-pick').onclick = async () => {
    msg('Click the value on the page (Esc cancels)…');
    const r = await gb.invoke('watcher:pick');
    if (!r?.ok) return msg(r?.error === 'cancelled' ? 'Picking cancelled.' : `Cannot watch that: ${r?.error ?? 'failed'}`);
    msg('');
    draft = { url: r.draft.url, locator: r.draft.locator, expect: { title: r.draft.title, heading: r.draft.heading } };
    const sample = r.draft.sample ? `“${String(r.draft.sample).slice(0, 80)}”` : '(empty)';
    showForm(`Watching ${sample} on ${r.draft.url}`, r.draft.heading || r.draft.title || 'Watcher', r.draft.kind, r.draft.number !== null && r.draft.number !== undefined ? String(r.draft.number) : '');
  };
  $('watch-cancel').onclick = () => {
    draft = null;
    $('watch-form').classList.add('hidden');
  };
  $('watch-create').onclick = async () => {
    if (!draft) return;
    const kind = $<HTMLSelectElement>('watch-kind').value;
    const c = $<HTMLSelectElement>('watch-cond').value;
    const v = $<HTMLInputElement>('watch-cond-value').value.trim();
    const condition = c === 'changes' ? { kind: 'changes' } : c === 'contains' ? { kind: 'contains', text: v } : { kind: c, value: Number(v) };
    const res = await gb.invoke('watcher:create', {
      name: $<HTMLInputElement>('watch-name').value,
      ...(draft.recipeId ? { recipeId: draft.recipeId } : { urls: [draft.url], locator: draft.locator, expect: draft.expect }),
      kind,
      condition,
      everyMinutes: Number($<HTMLInputElement>('watch-every').value),
      notify: { desktop: $<HTMLInputElement>('watch-desktop').checked, telegram: $<HTMLInputElement>('watch-telegram').checked },
      useLogin: $<HTMLInputElement>('watch-login').checked,
    });
    if (!res?.ok) return msg(`Not created: ${res?.error ?? 'invalid'}`);
    msg(`Created “${res.watcher.name}”.`);
    draft = null;
    $('watch-form').classList.add('hidden');
  };

  // ---------------------------------------------------------------- list

  const fmt = (t: number) => new Date(t).toLocaleString();
  function render() {
    const w = $('watch-waiting');
    w.textContent = state.waiting ? `Waiting: ${state.waiting}. Watchers run only when no agent task or replay is running and nothing waits for your confirmation.` : '';
    w.classList.toggle('hidden', !state.waiting);
    const box = $('watch-list');
    if (!state.watchers.length) {
      box.replaceChildren(el('p', { class: 'muted small', 'data-testid': 'watchers-empty' }, 'No watchers yet.'));
    } else {
      box.replaceChildren(
        ...state.watchers.map((x) => {
          const item = el('div', { class: 'auto-item', 'data-testid': 'watcher-item', 'data-watcher-id': x.id });
          const badge = x.running ? el('span', { class: 'auto-badge on' }, 'running') : x.paused ? el('span', { class: 'auto-badge paused' }, 'paused') : x.failures ? el('span', { class: 'auto-badge err' }, `${x.failures} failed`) : el('span', { class: 'auto-badge' }, `next ${fmt(x.nextRunAt)}`);
          item.append(el('div', { class: 'row' }, el('span', { class: 'auto-title' }, x.name), badge));
          item.append(el('span', { class: 'muted' }, `${x.url} · ${x.kind} · notify when ${x.condition} · every ${x.everyMinutes} min${x.useLogin ? ' · uses your login' : ''}`));
          item.append(el('span', { 'data-testid': 'watcher-last' }, `Last value: ${x.lastValue === null ? '—' : String(x.lastValue)}`));
          item.append(
            el(
              'div',
              { class: 'row' },
              button('Run now', 'watcher-run-now', async () => {
                const r = await gb.invoke('watcher:run-now', x.id);
                msg(r?.waiting ?? (r?.ok ? '' : r?.error ?? ''));
              }),
              button(x.paused ? 'Resume' : 'Pause', 'watcher-pause', () => void gb.invoke('watcher:update', x.id, { paused: !x.paused })),
              button(hist.has(x.id) ? 'Hide history' : `History (${x.history.length})`, 'watcher-history-toggle', () => {
                if (hist.has(x.id)) hist.delete(x.id);
                else hist.add(x.id);
                render();
              }),
              button('Delete', 'watcher-delete', () => void gb.invoke('watcher:delete', x.id)),
            ),
          );
          if (hist.has(x.id)) {
            const t = el('table', { class: 'auto-hist', 'data-testid': 'watcher-history' });
            t.append(el('tr', {}, el('th', {}, 'time'), el('th', {}, 'value'), el('th', {}, 'met'), el('th', {}, 'error')));
            for (const h of x.history) {
              t.append(
                el('tr', { 'data-testid': 'watcher-history-row' }, el('td', {}, fmt(h.at)), el('td', {}, h.value === null ? '—' : String(h.value)), el('td', {}, h.met ? (h.notified ? 'yes, notified' : 'yes') : 'no'), el('td', {}, h.error ?? '')),
              );
            }
            item.append(t);
          }
          return item;
        }),
      );
    }
    // the runner: the external option is greyed out (with the reason) until the binary exists
    const r = state.runner;
    $<HTMLInputElement>('watch-runner-electron').checked = r.runner === 'electron';
    const ext = $<HTMLInputElement>('watch-runner-external');
    ext.checked = r.runner === 'external';
    ext.disabled = !r.externalAvailable;
    $('watch-runner-external-label').classList.toggle('muted', !r.externalAvailable);
    $('watch-runner-external-label').title = r.externalAvailable ? '' : `Unavailable: ${r.externalReason}`;
    const path = $<HTMLInputElement>('watch-runner-path');
    if (document.activeElement !== path) path.value = r.externalPath;
    $<HTMLSelectElement>('watch-runner-flavor').value = r.flavor;
    $('watch-runner-why').textContent = r.externalAvailable ? 'The external browser is available.' : `External runner unavailable: ${r.externalReason}. Set the absolute path of an installed binary and Save.`;
  }

  $('watch-runner-save').onclick = async () => {
    const res = await gb.invoke('watcher:runner-set', {
      runner: $<HTMLInputElement>('watch-runner-external').checked ? 'external' : 'electron',
      externalPath: $<HTMLInputElement>('watch-runner-path').value.trim(),
      flavor: $<HTMLSelectElement>('watch-runner-flavor').value,
    });
    if (!res?.ok) msg(res?.error ?? 'not saved');
    state.runner = { ...state.runner, ...res };
    render();
  };

  gb.on('watchers', (s: State) => {
    if (s && Array.isArray(s.watchers)) state = s;
    render();
  });

  return {
    async shown() {
      const s = await gb.invoke('watcher:list').catch(() => null);
      if (s) state = s;
      render();
    },
    /** "Watch…" on a read-only recipe */
    fromRecipe(r: { id: string; name: string; origins: string[] }) {
      draft = { recipeId: r.id };
      showForm(`From the recipe “${r.name}” (${r.origins.join(', ')}): its pages are opened and its first read value is watched.`, r.name, 'number', '');
    },
  };
}

// Recipes (item 5), the chrome side: "Save as recipe" after a finished task, and the Recipes panel —
// run (asking for parameters), steps in plain words with their "auto" switch, stored defaults,
// rename, delete, export / import. Every string from a recipe (element names, labels, page titles)
// was page data when it was recorded: it is inserted as TEXT only.

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

interface StepView {
  kind: string;
  text: string;
  auto: boolean;
  autoRefusal: string | null;
}
interface ParamView {
  name: string;
  kind: 'text' | 'sensitive';
  note: string;
  default?: string;
}
export interface RecipeView {
  id: string;
  name: string;
  createdAt: number;
  origins: string[];
  readOnly: boolean;
  params: ParamView[];
  steps: StepView[];
}

const AUTO_HELP =
  '“auto” runs this step without asking you. The browser refuses it for payments, logins and other credentials, and steps that reach a new site: those are always confirmed.';

export function initRecipes(gb: Bridge, opts: { onWatch: (r: RecipeView) => void }) {
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
  let list: RecipeView[] = [];
  const open = new Set<string>();
  const msg = (t: string) => ($('recipes-msg').textContent = t);

  // ---------------------------------------------------------------- Save as recipe (agent panel)

  function offerSave(r: { recipe?: { steps: number } | null; replay?: boolean }) {
    const box = $('recipe-save');
    $('recipe-save-form').classList.add('hidden');
    $('recipe-save-msg').textContent = '';
    box.classList.toggle('hidden', !(r.recipe && r.recipe.steps > 0) || !!r.replay);
  }
  $('recipe-save-open').onclick = async () => {
    const d = await gb.invoke('recipe:draft');
    if (!d?.ok) {
      $('recipe-save-msg').textContent = d?.error ?? 'nothing to save';
      return;
    }
    $('recipe-save-steps').replaceChildren(...d.steps.map((t: string) => el('li', { 'data-testid': 'recipe-save-step' }, t)));
    const sk = $('recipe-save-skipped');
    sk.textContent = d.skipped.length ? `Not recorded: ${d.skipped.join('; ')}` : '';
    sk.classList.toggle('hidden', !d.skipped.length);
    $<HTMLInputElement>('recipe-save-name').value = String(d.task ?? '').slice(0, 60);
    $('recipe-save-form').classList.remove('hidden');
  };
  $('recipe-save-cancel').onclick = () => $('recipe-save-form').classList.add('hidden');
  $('recipe-save-go').onclick = async () => {
    const r = await gb.invoke('recipe:save', $<HTMLInputElement>('recipe-save-name').value);
    $('recipe-save-msg').textContent = r?.ok ? `Saved “${r.recipe.name}” to Recipes.` : r?.error ?? 'not saved';
    if (r?.ok) {
      $('recipe-save-form').classList.add('hidden');
      $('recipe-save-open').classList.add('hidden');
    }
  };
  gb.on('agent:update', (u: { status?: string }) => {
    if (u?.status === 'started') {
      $('recipe-save').classList.add('hidden');
      $('recipe-save-open').classList.remove('hidden');
    }
  });
  gb.on('agent:done', (r) => offerSave(r ?? {}));

  // ---------------------------------------------------------------- the panel

  function runForm(r: RecipeView) {
    const f = $('recipe-run-form');
    f.replaceChildren();
    const inputs = new Map<string, HTMLInputElement>();
    f.append(el('strong', {}, `Run “${r.name}”`));
    f.append(el('p', { class: 'muted small' }, `Replays ${r.steps.length} step${r.steps.length === 1 ? '' : 's'} in the current tab with no AI, allowed to reach only: ${r.origins.join(', ')}.`));
    for (const p of r.params) {
      const i = el('input', { 'data-testid': 'recipe-param', 'data-param': p.name, type: p.kind === 'sensitive' ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
      if (p.kind === 'text' && p.default !== undefined) i.value = p.default;
      inputs.set(p.name, i);
      f.append(el('label', { class: 'small' }, `{{${p.name}}} — ${p.note}`, el('br'), i));
    }
    const start = button('Start replay', 'recipe-run-start', async () => {
      const values: Record<string, string> = {};
      for (const [k, i] of inputs) values[k] = i.value;
      const res = await gb.invoke('recipe:run', r.id, values);
      if (!res?.ok) return msg(res?.error ?? 'could not start');
      f.classList.add('hidden');
      f.replaceChildren();
      msg(`Replaying “${r.name}”: watch the agent panel for confirmations and the report.`);
    }, 'primary');
    const cancel = button('Cancel', 'recipe-run-cancel', () => {
      f.classList.add('hidden');
      f.replaceChildren();
    });
    f.append(el('div', { class: 'row' }, start, cancel));
    f.classList.remove('hidden');
  }

  function detail(r: RecipeView): HTMLElement {
    const box = el('div', { class: 'auto-box', 'data-testid': 'recipe-detail' });
    box.append(el('p', { class: 'auto-why' }, AUTO_HELP));
    const ol = el('ol', { class: 'auto-steps' });
    r.steps.forEach((s, i) => {
      const li = el('li', { 'data-testid': 'recipe-step' }, s.text);
      if (s.kind !== 'navigate' && s.kind !== 'extract') {
        const cb = el('input', { type: 'checkbox', 'data-testid': 'recipe-auto', 'data-step': String(i) }) as HTMLInputElement;
        cb.checked = s.auto;
        cb.disabled = !!s.autoRefusal && !s.auto;
        cb.onchange = async () => {
          const res = await gb.invoke('recipe:auto', r.id, i, cb.checked);
          if (!res?.ok) {
            cb.checked = !cb.checked;
            msg(res?.error ?? 'refused');
          }
        };
        li.append(el('label', { class: 'small' }, cb, ' auto (no confirmation)'));
        if (s.autoRefusal) li.append(el('span', { class: 'auto-why', 'data-testid': 'recipe-auto-why' }, `Always confirmed: ${s.autoRefusal}.`));
      }
      ol.append(li);
    });
    box.append(ol);
    if (r.params.length) {
      const inputs = new Map<string, HTMLInputElement>();
      box.append(el('strong', { class: 'small' }, 'Parameters'));
      for (const p of r.params) {
        if (p.kind === 'sensitive') {
          box.append(el('div', { class: 'small', 'data-testid': 'recipe-param-sensitive' }, `{{${p.name}}}: ${p.note}`));
          continue;
        }
        const i = el('input', { 'data-testid': 'recipe-param-default', 'data-param': p.name, autocomplete: 'off' }) as HTMLInputElement;
        i.value = p.default ?? '';
        inputs.set(p.name, i);
        box.append(el('label', { class: 'small' }, `{{${p.name}}} (${p.note}; empty = ask at every run)`, el('br'), i));
      }
      if (inputs.size) {
        box.append(
          el(
            'div',
            { class: 'row' },
            button('Save parameters', 'recipe-defaults-save', async () => {
              const values: Record<string, string> = {};
              for (const [k, i] of inputs) values[k] = i.value;
              const res = await gb.invoke('recipe:defaults', r.id, values);
              msg(res?.ok ? 'Parameters saved.' : res?.error ?? 'not saved');
            }),
          ),
        );
      }
    }
    return box;
  }

  function render() {
    const box = $('recipes-list');
    if (!list.length) {
      box.replaceChildren(el('p', { class: 'muted small', 'data-testid': 'recipes-empty' }, 'No recipes yet. Run a task, then press “Save as recipe” under its answer.'));
      return;
    }
    box.replaceChildren(
      ...list.map((r) => {
        const item = el('div', { class: 'auto-item', 'data-testid': 'recipe-item', 'data-recipe-id': r.id });
        item.append(el('span', { class: 'auto-title', 'data-testid': 'recipe-title' }, r.name));
        item.append(el('span', { class: 'muted' }, `${r.steps.length} step${r.steps.length === 1 ? '' : 's'} · ${r.origins.join(', ')}${r.readOnly ? ' · read-only' : ''}`));
        const rename = el('div', { class: 'row hidden' });
        const ri = el('input', { 'data-testid': 'recipe-rename-input', maxlength: '80' }) as HTMLInputElement;
        rename.append(
          ri,
          button('OK', 'recipe-rename-ok', async () => {
            const res = await gb.invoke('recipe:rename', r.id, ri.value);
            if (!res?.ok) msg('not renamed');
          }),
        );
        const actions = el(
          'div',
          { class: 'row' },
          button('Run', 'recipe-run', () => runForm(r), 'primary'),
          button(open.has(r.id) ? 'Hide steps' : 'Steps', 'recipe-steps-toggle', () => {
            if (open.has(r.id)) open.delete(r.id);
            else open.add(r.id);
            render();
          }),
          button('Rename', 'recipe-rename', () => {
            ri.value = r.name;
            rename.classList.toggle('hidden');
          }),
          button('Export', 'recipe-export', async () => {
            const res = await gb.invoke('recipe:export', r.id);
            const t = $<HTMLTextAreaElement>('recipe-json');
            t.value = res?.ok ? res.json : '';
            t.classList.toggle('hidden', !res?.ok);
            msg(res?.ok ? 'Exported below: copy the JSON. It holds no sensitive value (those are asked at every run).' : res?.error ?? 'failed');
          }),
          ...(r.readOnly ? [button('Watch…', 'recipe-watch', () => opts.onWatch(r))] : []),
          button('Delete', 'recipe-delete', async () => {
            await gb.invoke('recipe:delete', r.id);
          }),
        );
        item.append(actions, rename);
        if (open.has(r.id)) item.append(detail(r));
        return item;
      }),
    );
  }

  $('recipe-import').onclick = async () => {
    const res = await gb.invoke('recipe:import', $<HTMLTextAreaElement>('recipe-import-text').value);
    msg(res?.ok ? `Imported “${res.recipe.name}”.` : `Not imported: ${res?.error ?? 'invalid'}`);
    if (res?.ok) $<HTMLTextAreaElement>('recipe-import-text').value = '';
  };

  gb.on('recipes', (l: RecipeView[]) => {
    list = Array.isArray(l) ? l : [];
    render();
  });

  return {
    async shown() {
      list = (await gb.invoke('recipe:list').catch(() => [])) ?? [];
      render();
    },
  };
}

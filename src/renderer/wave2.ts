// Wave 2 chrome UI: reader mode view, gesture overlay, cloud banner, settings for the new
// features, and the wiring that keeps them all on the chrome side.
//
// The one rule this file exists to respect: everything here is CHROME. It renders text into the
// chrome document, it never injects into a page, and it never reads page content. Reader output and
// translate output are HUMAN-ONLY — they are inserted as text nodes, never as HTML from a page or
// from an endpoint.

import type { PaletteItem } from '../core/quick-commands';

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = (tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
};

export interface Wave2Ui {
  openReader(article: unknown): void;
  runAction(item: PaletteItem): void;
  setCloudStatus(text: string): void;
}

export function initWave2(gb: Bridge, hooks: { onInset: () => void; paletteOpen: (q?: string) => void; paletteClose: () => void; paletteIsOpen: () => boolean }): Wave2Ui {
  // ---------------- reader (ticket 24) ----------------
  let readerFont = 17;
  let readerWidth = 46; // em

  function paintReader(article: any) {
    const body = $('reader-body');
    body.replaceChildren();
    for (const b of article.blocks ?? []) {
      const tag = b.kind === 'h' ? 'h3' : b.kind === 'pre' ? 'pre' : b.kind === 'list' ? 'li' : 'p';
      // TEXT ONLY. A block is a string from the page; inserted as a text node so no markup from the
      // page can render in the chrome document.
      body.append(el(tag, {}, String(b.text ?? '')));
    }
    if (article.truncated) body.append(el('p', { class: 'muted' }, 'The article was truncated to keep it readable.'));
    body.style.fontSize = `${readerFont}px`;
    body.style.maxWidth = `${readerWidth}em`;
    $('reader-title').textContent = String(article.title ?? 'Reader');
  }

  $('reader-bigger').onclick = () => {
    readerFont = Math.min(30, readerFont + 1);
    ($('reader-body') as HTMLElement).style.fontSize = `${readerFont}px`;
  };
  $('reader-smaller').onclick = () => {
    readerFont = Math.max(12, readerFont - 1);
    ($('reader-body') as HTMLElement).style.fontSize = `${readerFont}px`;
  };
  $('reader-narrow').onclick = () => {
    readerWidth = Math.max(24, readerWidth - 4);
    ($('reader-body') as HTMLElement).style.maxWidth = `${readerWidth}em`;
  };
  $('reader-wide').onclick = () => {
    readerWidth = Math.min(80, readerWidth + 4);
    ($('reader-body') as HTMLElement).style.maxWidth = `${readerWidth}em`;
  };
  $('reader-close').onclick = () => {
    $('reader').classList.add('hidden');
    $('reader-body').replaceChildren();
    hooks.onInset();
  };

  // ---------------- gestures (ticket 16) ----------------
  // The trail is drawn in CHROME over the page, never in the page. It shows the path the main
  // process recognised, so a suppressed gesture can say so instead of appearing broken.
  gb.on('gesture', (payload: any) => {
    const box = $('gesture-trail');
    if (payload?.suppressed) {
      box.textContent = 'gesture ignored — an agent task is running';
      box.classList.remove('hidden');
      setTimeout(() => box.classList.add('hidden'), 1200);
    }
  });

  // ---------------- cloud banner (ticket 25) ----------------
  function setCloudStatus(text: string) {
    const b = $('cloud-banner');
    if (!text) {
      b.classList.add('hidden');
      b.textContent = '';
      return;
    }
    b.textContent = text;
    b.classList.remove('hidden');
  }

  // ---------------- settings: keybindings (15) ----------------
  async function loadKeybindings() {
    const data = await gb.invoke('keybindings:get').catch(() => null);
    const t = $('kb-table');
    t.replaceChildren();
    if (!data?.bindings?.bindings) return;
    const labels: Record<string, string> = data.bindings.bindings.__labels ?? {};
    for (const [action, chord] of Object.entries<string>(data.bindings.bindings)) {
      if (action === '__labels') continue;
      const input = el('input', { value: String(chord), placeholder: 'unbound', 'data-testid': `kb-${action}` }) as HTMLInputElement;
      input.dataset.action = action;
      const row = el('tr', {}, el('td', { class: 'small' }, action.replace(/\./g, ' › ')), el('td', {}, input));
      t.append(row);
    }
    void labels;
  }

  $('kb-reset').onclick = async () => {
    await gb.invoke('keybindings:reset');
    await loadKeybindings();
    $('kb-msg').textContent = 'reset to defaults';
  };

  /** Collect the table and save; the main process validates and refuses conflicts. */
  async function saveKeybindings() {
    const bindings: Record<string, string> = {};
    for (const input of $('kb-table').querySelectorAll('input')) {
      const el2 = input as HTMLInputElement;
      if (el2.dataset.action) bindings[el2.dataset.action] = el2.value.trim();
    }
    const r = await gb.invoke('keybindings:save', { version: 1, bindings });
    $('kb-msg').textContent = r?.ok ? 'saved' : (r?.error ?? '');
    return r?.ok === true;
  }

  // ---------------- settings: hibernation (23) ----------------
  async function loadHibernation() {
    const s = await gb.invoke('hibernation:state').catch(() => null);
    if (!s?.settings) return;
    ($('hib-enabled') as HTMLInputElement).checked = s.settings.enabled === true;
    ($('hib-minutes') as HTMLInputElement).value = String(s.settings.idleMinutes);
    ($('hib-form') as HTMLInputElement).checked = s.settings.allowFormState === true;
  }
  $('hib-sweep').onclick = async () => {
    const r = await gb.invoke('hibernation:sweep');
    $('hib-msg').textContent = `${r?.swept?.length ?? 0} tab(s) hibernated`;
  };

  // ---------------- settings: translate (25) ----------------
  async function loadTranslate() {
    const s = await gb.invoke('translate:state').catch(() => null);
    if (!s) return;
    ($('tr-enabled') as HTMLInputElement).checked = s.settings?.enabled === true;
    ($('tr-endpoint') as HTMLInputElement).value = s.settings?.endpoint ?? '';
    ($('tr-model') as HTMLInputElement).value = s.settings?.model ?? '';
    const sel = $('tr-lang') as HTMLSelectElement;
    sel.replaceChildren();
    for (const l of s.languages ?? []) {
      const o = el('option', { value: l.code }, l.label) as HTMLOptionElement;
      if (l.code === s.settings?.targetLang) o.selected = true;
      sel.append(o);
    }
    setCloudStatus(s.status ?? '');
  }

  // ---------------- settings: extensions (32) ----------------
  async function loadExtensions() {
    const s = await gb.invoke('extensions:list').catch(() => null);
    if (!s) return;
    $('ext-warning').textContent = s.warning ?? '';
    ($('ext-enabled') as HTMLInputElement).checked = s.enabled !== false;
    const list = $('ext-list');
    list.replaceChildren();
    for (const e of s.entries ?? []) {
      const on = el('input', { type: 'checkbox', 'data-testid': 'extension-enabled' }) as HTMLInputElement;
      on.checked = e.enabled === true;
      on.onchange = () => void gb.invoke('extensions:enable', e.path, on.checked);
      const rm = el('button', { class: 'danger', 'data-testid': 'extension-remove' }, 'Remove');
      rm.onclick = async () => {
        await gb.invoke('extensions:remove', e.path);
        await loadExtensions();
      };
      list.append(el('div', { class: 'lib-row', 'data-testid': 'extension-row', 'data-path': e.path }, on, el('span', { class: 'lib-title' }, e.name), el('span', { class: 'muted small' }, e.path), rm));
    }
  }
  $('ext-add').onclick = async () => {
    const r = await gb.invoke('extensions:pick');
    $('ext-msg').textContent = r?.ok ? `added ${r.entry?.name ?? ''}` : (r?.error ?? '');
    await loadExtensions();
  };

  // ---------------- settings: layout (17/21/28) ----------------
  async function loadLayout() {
    const s = await gb.invoke('panels:state').catch(() => null);
    if (!s) return;
    ($('opt-rail') as HTMLInputElement).checked = s.railVisible !== false;
    ($('opt-status') as HTMLInputElement).checked = s.statusBar !== false;
  }

  // ---------------- settings load/save glue ----------------
  async function loadAll() {
    await Promise.all([loadKeybindings(), loadHibernation(), loadTranslate(), loadExtensions(), loadLayout()]);
  }
  void loadAll();

  // the settings Save button also persists the new sections (the old handler is in renderer.ts)
  document.addEventListener('gb:settings-saved', () => {
    void saveKeybindings();
    void gb.invoke('hibernation:set', {
      enabled: ($('hib-enabled') as HTMLInputElement).checked,
      idleMinutes: Number(($('hib-minutes') as HTMLInputElement).value) || 30,
      allowFormState: ($('hib-form') as HTMLInputElement).checked,
    });
    void gb.invoke('translate:set', {
      enabled: ($('tr-enabled') as HTMLInputElement).checked,
      endpoint: ($('tr-endpoint') as HTMLInputElement).value.trim(),
      model: ($('tr-model') as HTMLInputElement).value.trim(),
      targetLang: ($('tr-lang') as HTMLSelectElement).value || 'en',
    });
    void gb.invoke('extensions:set-enabled', ($('ext-enabled') as HTMLInputElement).checked);
    void gb.invoke('rail:set', ($('opt-rail') as HTMLInputElement).checked);
    void gb.invoke('status:set', ($('opt-status') as HTMLInputElement).checked);
    void gb.invoke('tabstrip:set', ($('opt-tabstrip') as HTMLSelectElement).value);
  });

  // layout toggles apply immediately, not only on Save
  $('opt-rail').onchange = () => void gb.invoke('rail:set', ($('opt-rail') as HTMLInputElement).checked);
  $('opt-status').onchange = () => void gb.invoke('status:set', ($('opt-status') as HTMLInputElement).checked);
  $('opt-tabstrip').onchange = () => void gb.invoke('tabstrip:set', ($('opt-tabstrip') as HTMLSelectElement).value);

  // ---------------- profile bundle (30) ----------------
  $('bundle-preview').onclick = async () => {
    const r = await gb.invoke('bundle:dry-run', ($('bundle-text') as HTMLTextAreaElement).value);
    const s = r?.summary ?? {};
    $('bundle-msg').textContent = r?.ok
      ? `OK: ${s.bookmarks} bookmark node(s), ${s.savedSessions} session(s), ${s.workspaces} workspace(s), ${s.keybindings} keybinding(s)${s.settings ? ', settings' : ''}`
      : `rejected — ${r?.error ?? 'invalid'}`;
  };
  $('bundle-import').onclick = async () => {
    const r = await gb.invoke('bundle:import', ($('bundle-text') as HTMLTextAreaElement).value);
    $('bundle-msg').textContent = r?.ok ? `imported: ${(r.applied ?? []).join(', ')}` : `rejected — ${r?.error ?? 'invalid'}`;
    if (r?.ok) await loadAll();
  };
  $('bundle-export').onclick = async () => {
    const r = await gb.invoke('bundle:export-file');
    $('bundle-msg').textContent = r?.ok ? 'exported' : (r?.error ?? '');
  };

  // ---------------- palette / sessions / workspaces shortcuts from main ----------------
  gb.on('shortcut', (what: string) => {
    if (what === 'palette') hooks.paletteOpen();
    if (what === 'session:save') void saveKeybindings();
  });

  return {
    openReader(article: unknown) {
      paintReader(article ?? {});
      $('reader').classList.remove('hidden');
      hooks.onInset();
    },
    runAction(item: PaletteItem) {
      // Running by ACTION NAME, not by synthesising a keystroke: the action is the id, so there is
      // one dispatch path (main's runAction) and no way for the palette to do something a chord
      // cannot. Nothing here is page-derived.
      if (item.kind === 'command') void gb.invoke('action:run', item.id);
      if (item.kind === 'tab') void gb.invoke('tabs:activate', Number(item.id));
      if (item.kind === 'bookmark') void gb.invoke('bookmarks:open', item.id, false);
      if (item.kind === 'history') void gb.invoke('history:open', item.id, false);
      if (item.kind === 'session') void gb.invoke('sessions:restore', item.id);
      if (item.kind === 'workspace') void gb.invoke('workspaces:switch', item.id);
      if (item.kind === 'setting') void gb.invoke('panel:refresh', item.id.replace(/^panel:/, ''));
    },
    setCloudStatus,
  };
}

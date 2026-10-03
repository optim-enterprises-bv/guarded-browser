// Panels (ticket 17): the full-height left icon rail, built to the geometry measured from the
// target screenshot (docs/target-ui.md), not guessed:
//   icon rail    51 physical / 27 logical px wide, icons centred, ~37 px pitch
//   panel column 220 physical / 118 logical px
//
// INTEGRATION DECISION (recorded rather than hidden): the rail drives the EXISTING panel column
// (`#side`, library.ts) instead of standing up a second, parallel panel system. History and
// bookmarks already render there and are covered by the existing e2e suite; adding a second column
// would have meant two inset calculations and two ways for history to be wrong. The rail is the
// control surface; the column is the one the app already had.
//
// RULE 4: the agent never gets a reference to any of this. RULE 6: the rail is a separate element
// from #panel (the agent panel that hosts the guard / egress / reputation chips) and must never
// obscure it — it is laid out as a left inset, so those chips stay where they are.

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

export type PanelId = 'history' | 'bookmarks' | 'downloads' | 'sessions' | 'workspaces' | 'webpanels' | 'mail' | 'chat' | 'recipes' | 'watchers';

export interface PanelDef {
  id: PanelId;
  label: string;
  /** the section id in index.html that this panel shows */
  section: string;
}

/** Rail order, top group. The bottom-pinned group (settings, tiling) is added separately. */
export const PANELS: PanelDef[] = [
  { id: 'history', label: 'History', section: 'history-view' },
  { id: 'bookmarks', label: 'Bookmarks', section: 'bookmarks-view' },
  { id: 'downloads', label: 'Downloads', section: 'downloads-view' },
  { id: 'sessions', label: 'Sessions', section: 'sessions-view' },
  { id: 'workspaces', label: 'Workspaces', section: 'workspaces-view' },
  { id: 'webpanels', label: 'Web panels', section: 'webpanels-view' },
  // MAIL (ticket 37c): a panel in the shared column, NOT a second window.
  { id: 'mail', label: 'Mail (Ctrl+Shift+M)', section: 'mail-view' },
  // AI CHAT (item 2): the quarantined chat role about the current tab
  { id: 'chat', label: 'AI chat (Ctrl+Shift+K)', section: 'chat-view' },
  // RECIPES and WATCHERS (item 5): replay a finished task with no AI; read-only scheduled checks
  { id: 'recipes', label: 'Recipes', section: 'recipes-view' },
  { id: 'watchers', label: 'Watchers', section: 'watchers-view' },
];

/** Geometry, MEASURED from the target screenshots (physical px at COSMIC scale 187%).
 *
 * `docs/target-ui.md` and `docs/target-mail-ui.md` both put the rail's right edge at physical x = 95,
 * i.e. 50.8 logical px, with the icons centred near logical 30. The previously shipped 27 was about
 * half that; the user approved correcting it (2026-10-02). `PANEL_WIDTH` is the BROWSER panel column
 * (220, unchanged); the mail window's tree column is a different number (206) and lives in mail.css. */
export const RAIL_WIDTH = 51;
export const PANEL_WIDTH = 220;

export interface PanelsUi {
  active(): PanelId | null;
  toggle(id: PanelId): void;
  close(): void;
  setRailVisible(on: boolean): void;
}

export function initPanels(
  gb: Bridge,
  opts: {
    /** the left inset the page area must leave free (rail, plus the column when open) */
    onInset: (left: number) => void;
    /** open/close a section in the shared column; the caller owns the column itself */
    onShow: (id: PanelId | null) => void;
    /** the MAIL panel refreshes itself when it becomes the visible section (ticket 37c) */
    onMailShown?: () => void;
    /** so does the AI chat (item 2) */
    onChatShown?: () => void;
    /** and the recipes / watchers panels (item 5) */
    onShown?: (id: PanelId) => void;
  },
): PanelsUi {
  const rail = document.getElementById('rail') as HTMLElement;
  const bottom = document.getElementById('rail-bottom') as HTMLElement;
  let activeId: PanelId | null = null;
  let railVisible = true;
  const buttons = new Map<PanelId, HTMLButtonElement>();

  for (const p of PANELS) {
    const b = document.createElement('button');
    b.className = 'rail-btn';
    b.setAttribute('data-testid', `rail-${p.id}`);
    b.dataset.panel = p.id;
    b.title = p.label;
    b.setAttribute('aria-label', p.label);
    b.textContent = RAIL_GLYPH[p.id];
    b.onclick = () => toggle(p.id);
    rail.append(b);
    buttons.set(p.id, b);
  }

  // the bottom-pinned group: settings, then the panel-column toggle. Pinned because they are not
  // panels in the same sense — they are chrome-level controls, and keeping them apart is what makes
  // the divider in the target screenshot mean something.
  const gear = document.createElement('button');
  gear.className = 'rail-btn rail-bottom-btn';
  gear.setAttribute('data-testid', 'rail-settings');
  gear.title = 'Settings';
  gear.textContent = '\u2699';
  gear.onclick = () => document.getElementById('open-settings')?.click();
  bottom.append(gear);

  function applyInset() {
    // the RAIL only: the library adds the open column's own width (220, or the full width for mail).
    // Adding PANEL_WIDTH here too counted the column twice and left a 220 px gap beside every panel.
    const left = railVisible ? RAIL_WIDTH : 0;
    opts.onInset(left);
  }

  function paint() {
    for (const [id, b] of buttons) {
      b.classList.toggle('active', id === activeId);
      b.setAttribute('aria-pressed', id === activeId ? 'true' : 'false');
    }
    opts.onShow(activeId);
    applyInset();
    if (activeId) void load(activeId);
  }

  function toggle(id: PanelId) {
    activeId = activeId === id ? null : id;
    paint();
    if (activeId === 'mail') opts.onMailShown?.();
    if (activeId === 'chat') opts.onChatShown?.();
    if (activeId) opts.onShown?.(activeId);
  }

  async function load(id: PanelId) {
    // the runtime owns the data; this asks it to push the section that changed
    void gb.invoke('panel:refresh', id);
    if (id === 'sessions') renderSessions(await gb.invoke('sessions:list').catch(() => ({ sessions: [] })));
    if (id === 'workspaces') renderWorkspaces(await gb.invoke('workspaces:list').catch(() => ({ workspaces: [], activeId: '' })));
    if (id === 'webpanels') renderWebPanels(await gb.invoke('panels:list').catch(() => ({ saved: [], open: [] })));
  }

  // ---------- web panels (ticket 18) ----------
  // The list is user data (a panel's title comes from the SITE), so every field is set as TEXT and
  // a panel can be removed without ever being activated as a tab.
  function renderWebPanels(data: { saved?: any[]; open?: any[] }) {
    const list = document.getElementById('webpanels-list');
    if (!list) return;
    list.replaceChildren();
    const saved = data.saved ?? [];
    if (!saved.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'No panels yet. Open a site, then use "Pin to sidebar".';
      list.append(p);
    }
    for (const e of saved) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.setAttribute('data-testid', 'webpanel-row');
      row.dataset.panelUrl = e.url;
      const name = document.createElement('button');
      name.className = 'lib-title link-title';
      name.setAttribute('data-testid', 'webpanel-show');
      name.textContent = e.title || e.url;
      name.title = e.url;
      // showing the panel leaves the built-in section visible underneath; main draws the live view
      // over the column, and switching section again hides it (`panels:show null`)
      name.onclick = async () => {
        const r = await gb.invoke('panels:add', e.url);
        if (!r.ok) return;
        await gb.invoke('panels:show', e.url);
      };
      const badge = document.createElement('span');
      badge.className = 'muted small';
      badge.textContent = e.open ? 'open' : 'closed';
      const open = document.createElement('button');
      open.setAttribute('data-testid', 'webpanel-open');
      open.textContent = e.open ? 'Reload' : 'Open';
      open.onclick = async () => {
        await gb.invoke('panels:add', e.url);
        renderWebPanels(await gb.invoke('panels:list').catch(() => ({ saved: [], open: [] })));
      };
      const del = document.createElement('button');
      del.setAttribute('data-testid', 'webpanel-remove');
      del.textContent = 'Remove';
      del.onclick = async () => {
        await gb.invoke('panels:remove', e.url);
        renderWebPanels(await gb.invoke('panels:list').catch(() => ({ saved: [], open: [] })));
      };
      const actions = document.createElement('span');
      actions.className = 'dl-actions';
      actions.append(badge, open, del);
      row.append(name, actions);
      list.append(row);
    }
  }

  // ---------- sessions (ticket 22) ----------
  function renderSessions(data: { sessions?: any[] }) {
    const list = document.getElementById('sessions-list');
    if (!list) return;
    list.replaceChildren();
    for (const s of data.sessions ?? []) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.setAttribute('data-testid', 'session-row');
      row.dataset.sessionId = s.id;
      const name = document.createElement('span');
      name.className = 'lib-title';
      // a session name is user text: set as textContent, never as markup
      name.textContent = `${s.name} (${s.tabs?.length ?? 0} tabs)`;
      const restore = document.createElement('button');
      restore.setAttribute('data-testid', 'session-restore');
      restore.textContent = 'Restore';
      restore.onclick = async () => {
        const r = await gb.invoke('sessions:restore', s.id);
        const msg = document.getElementById('sess-msg');
        if (msg) msg.textContent = r?.ok ? `opened ${r.opened} tab(s)` : (r?.error ?? '');
      };
      const del = document.createElement('button');
      del.className = 'danger';
      del.setAttribute('data-testid', 'session-delete');
      del.textContent = 'Delete';
      del.onclick = async () => {
        await gb.invoke('sessions:delete', s.id);
        void load('sessions');
      };
      row.append(name, restore, del);
      list.append(row);
    }
    if (!list.childElementCount) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No saved sessions yet.';
      list.append(p);
    }
  }

  // ---------- workspaces (ticket 20) ----------
  function renderWorkspaces(data: { workspaces?: any[]; activeId?: string }) {
    const list = document.getElementById('workspaces-list');
    if (!list) return;
    list.replaceChildren();
    for (const w of data.workspaces ?? []) {
      const row = document.createElement('div');
      row.className = `lib-row${w.id === data.activeId ? ' active' : ''}`;
      row.setAttribute('data-testid', 'workspace-row');
      row.dataset.workspaceId = w.id;
      const name = document.createElement('span');
      name.className = 'lib-title';
      name.textContent = w.name;
      const go = document.createElement('button');
      go.setAttribute('data-testid', 'workspace-switch');
      go.textContent = w.id === data.activeId ? 'Active' : 'Switch';
      go.onclick = async () => {
        const r = await gb.invoke('workspaces:switch', w.id);
        const msg = document.getElementById('ws-msg');
        if (msg) msg.textContent = r?.ok ? '' : (r?.error ?? '');
        void load('workspaces');
      };
      row.append(name, go);
      list.append(row);
    }
  }

  document.getElementById('session-save')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('session-name') as HTMLInputElement;
    const r = await gb.invoke('sessions:save', nameInput.value);
    const msg = document.getElementById('sess-msg');
    if (msg) msg.textContent = r?.ok ? `saved "${nameInput.value}"` : (r?.error ?? '');
    if (r?.ok) nameInput.value = '';
    void load('sessions');
  });

  document.getElementById('ws-create')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('ws-name') as HTMLInputElement;
    const r = await gb.invoke('workspaces:create', nameInput.value);
    const msg = document.getElementById('ws-msg');
    if (msg) msg.textContent = r?.ok ? '' : (r?.error ?? '');
    if (r?.ok) nameInput.value = '';
    void load('workspaces');
  });

  // the badge count arrives as a 'mail' event from main (the unread total across this profile).
  // The chip lives on the mail PANEL button, so the rail shows the count where the panel is.
  gb.on('mail', (payload: { unread?: number }) => {
    const n = Number(payload?.unread ?? 0);
    const b = buttons.get('mail');
    if (!b) return;
    let chip = b.querySelector('.rail-badge') as HTMLElement | null;
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'rail-badge';
      chip.setAttribute('data-testid', 'rail-mail-badge');
      b.append(chip);
    }
    chip.textContent = n > 99 ? '99+' : n > 0 ? String(n) : '';
    chip.classList.toggle('hidden', !(n > 0));
    chip.dataset.count = String(n);
  });

  paint();

  return {
    active: () => activeId,
    toggle,
    close() {
      activeId = null;
      paint();
    },
    setRailVisible(on: boolean) {
      railVisible = on;
      rail.classList.toggle('hidden', !on);
      bottom.classList.toggle('hidden', !on);
      if (!on) activeId = null;
      paint();
    },
  };
}

/** Rail glyphs, drawn from text so the rail has no icon-font dependency. */
const RAIL_GLYPH: Record<PanelId, string> = {
  history: '\u{1F553}',
  bookmarks: '\u{1F516}',
  downloads: '\u2B07',
  sessions: '\u{1F4C1}',
  workspaces: '\u{1F5C2}',
  webpanels: '\u{1F310}',
  mail: '\u2709',
  chat: '\u{1F4AC}',
  recipes: '\u{1F4DC}',
  watchers: '\u{1F441}',
};

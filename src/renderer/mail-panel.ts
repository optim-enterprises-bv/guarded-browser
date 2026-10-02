// Mail window renderer (ticket 37).
//
// This file's whole job is DOM + the `mail:*` bridge. Every rule it appears to apply (search parsing,
// threading, counters, time formatting, the remote-content wording) lives in `core/mail/ui.ts` and is
// unit-tested there; this file must not grow rules of its own.
//
// SECURITY: a message body, subject, sender, attachment name and folder name are all TEXT from the
// wire. Every one of them reaches the DOM through `textContent`, never `innerHTML`, never an
// attribute built from the value. The one place markup is created is `el()` below, which takes a tag
// name from a closed set in this file — no server string is ever a tag name.

interface MailBridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
}

/** The mail preload's bridge. Declared structurally here so this file needs no `declare global`
 *  (the renderer bundle is an IIFE, not a module). */
type AnyRec = Record<string, any>;
type GbWindow = Window & { gb?: MailBridge };
let bridge: MailBridge | null = null;
const gb = (): MailBridge => {
  if (!bridge) throw new Error('the mail panel was used before it was initialised');
  return bridge;
};

let state: AnyRec = { accounts: [], view: {}, locked: false, keychain: { backend: 'unknown' } };
let selectedAccount = '';
let selectedFolder = '';
let selectedMessageId = 0;
let searchQuery = '';
let flagOnly = false;

// ---------------------------------------------------------------- DOM helpers (no server string is markup)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // text, always
  return n;
}

function button(id: string, label: string, title?: string): HTMLButtonElement {
  const b = el('button', undefined, label);
  b.dataset.testid = id;
  if (title) b.title = title;
  return b;
}

const setStatus = (msg: string) => {
  $('m-status').textContent = msg;
};

// ---------------------------------------------------------------- boot

async function refreshState() {
  state = await gb().invoke('mail:state');
  renderAccounts();
  renderUnlock();
}

/**
 * First-show behaviour: sync the SELECTED account once, so a freshly configured profile does not
 * present an empty folder tree as though there were no mail. Deliberately NOT "sync all" — eighteen
 * accounts would open eighteen connections; `Check all` is the explicit action for that.
 */
let autoSynced = false;
export async function autoSyncOnOpen(): Promise<void> {
  // a locked store has nothing to authenticate with, so the check would fail for the wrong reason
  if (autoSynced || !selectedAccount || state.locked) return;
  autoSynced = true;
  const r = await gb().invoke('mail:sync', selectedAccount);
  setStatus(r?.ok ? `synced ${selectedAccount}` : (r?.refused ?? r?.error ?? 'check failed'));
  await refreshState();
  await refreshTree();
  await refreshList();
}

async function refreshTree() {
  if (!selectedAccount) {
    $('m-tree').replaceChildren(el('p', 'muted small', 'No mail account configured — use Import or Add mail account.'));
    return;
  }
  const data = await gb().invoke('mail:folders', selectedAccount);
  const tree = $('m-tree');
  tree.replaceChildren();
  for (const section of data.tree ?? []) {
    const box = el('div', 'section');
    const head = el('div', 'section-head');
    head.append(el('span', undefined, `\u25be ${section.label}`));
    box.append(head);
    for (const row of section.rows ?? []) {
      const r = el('div', 'tree-row');
      r.dataset.testid = `tree-${row.id}`;
      r.dataset.rowId = row.id;
      if (selectedFolder === row.id) r.classList.add('active');
      if (row.hidden) r.classList.add('hidden-role');
      const icon = row.kind === 'label' ? '\u25cf' : row.kind === 'view' ? '\u2709' : '\u25ad';
      r.append(el('span', undefined, icon), el('span', 'label', row.label));
      const chips = el('div', 'chips');
      const unread = row.counts?.unseen ?? 0;
      const total = row.counts?.total ?? 0;
      const c1 = el('span', `chip${unread ? '' : ' zero'}`, String(unread));
      const c2 = el('span', `chip${total ? '' : ' zero'}`, String(total));
      chips.append(c1, c2);
      r.append(chips);
      r.onclick = () => {
        selectedFolder = row.id;
        selectedMessageId = 0;
        void refreshTree();
        void refreshList();
      };
      box.append(r);
    }
    tree.append(box);
  }
}

async function refreshList() {
  if (!selectedAccount) {
    $('m-rows').replaceChildren(el('p', 'muted small', 'No mail account configured.'));
    return;
  }
  const data = searchQuery
    ? await gb().invoke('mail:search', searchQuery, { accountId: selectedAccount })
    : await gb().invoke('mail:list', { accountId: selectedAccount, folder: folderPathFor(selectedFolder) });
  const rows = $('m-rows');
  rows.replaceChildren();
  $('m-count').textContent = `${data.total ?? data.rows?.length ?? 0} messages`;
  $('m-search-state').textContent = data.refused ? data.refused : '';
  const visible = (data.rows ?? []).filter((r: AnyRec) => !flagOnly || r.flagged);
  if (!visible.length) rows.append(el('p', 'muted small', searchQuery ? 'No matches.' : 'No messages in this folder.'));
  for (const r of visible) {
    const row = el('div', `row${r.unread ? ' unread' : ''}${r.id === selectedMessageId ? ' selected' : ''}`);
    row.dataset.testid = 'mail-row';
    row.dataset.messageId = String(r.id);
    const top = el('div', 'top');
    top.append(el('span', 'from', r.from));
    top.append(el('span', 'time', r.time));
    const subject = el('div', 'subject', r.subject);
    const preview = el('div', 'preview', r.preview || '');
    const badges = el('div', 'badges');
    if (r.threadCount > 1) badges.append(el('span', undefined, `\u2261 ${r.threadCount}`));
    if (r.flagged) badges.append(el('span', undefined, '\u2691'));
    if (r.hasAttachments) badges.append(el('span', undefined, '\u{1f4ce}'));
    row.append(top, subject, preview, badges);
    row.onclick = () => {
      selectedMessageId = r.id;
      void openMessage(r.id);
      void refreshList();
    };
    rows.append(row);
  }
}

/** A tree row id is either a folder path or a view/label id; only a path is a folder. */
function folderPathFor(id: string): string {
  if (!id || id.startsWith('view:') || id.startsWith('label:') || id.startsWith('filter:') || id.startsWith('role:')) return 'INBOX';
  return id;
}

async function openMessage(id: number) {
  const m = await gb().invoke('mail:message', id, { markRead: true });
  if (!m?.ok) {
    setStatus(m?.error ?? 'could not open that message');
    return;
  }
  $('m-subject').textContent = m.subject || '(no subject)';
  const fields = $('m-fields');
  fields.replaceChildren();
  for (const f of m.header ?? []) {
    const row = el('div', 'field');
    row.append(el('span', 'k', `${f.label}:`), el('span', undefined, f.value || ''));
    fields.append(row);
  }
  // TEXT. `textContent` on a <pre>-like block: an encoded <script> stays characters.
  $('m-body').textContent = m.text || (m.text === '' ? '(no text body)' : '');
  const atts = $('m-attachments');
  atts.replaceChildren();
  for (const a of m.attachments ?? []) {
    // an attachment is metadata here; the bytes are fetched only by an explicit click (ticket 41)
    atts.append(el('span', 'att', `${a.filename} (${a.mime}, ${Math.round((a.size ?? 0) / 1024)} KB)`));
  }
  const notice = $('m-notice');
  notice.textContent = m.notice || '';
  notice.classList.toggle('hidden', !m.notice);
  renderActions(m);
  await refreshState();
}

function renderActions(m: AnyRec) {
  const box = $('m-actions');
  box.replaceChildren();
  const action = async (label: string, id: string, fn: () => Promise<any>) => {
    const b = button(id, label);
    b.onclick = async () => {
      const r = await fn();
      if (r && r.ok === false) setStatus(r.error ?? 'that action failed');
      await refreshList();
    };
    box.append(b);
  };
  void action('Reply', 'mail-reply', async () => ({ ok: true })); // compose ships in ticket 38
  void action(m.flagged ? 'Unflag' : 'Flag', 'mail-flag', () => gb().invoke('mail:flags', [m.id], { flagged: !m.flagged }));
  void action(m.readFlag ? 'Mark Unread' : 'Mark Read', 'mail-read', () => gb().invoke('mail:flags', [m.id], { readFlag: !m.readFlag, seen: true }));
  void action('Archive', 'mail-archive', () => gb().invoke('mail:move', [m.id], 'Archive'));
  void action('Trash', 'mail-trash', () => gb().invoke('mail:move', [m.id], 'Trash'));
}

// ---------------------------------------------------------------- accounts

function renderAccounts() {
  const box = $('m-accounts');
  box.replaceChildren();
  for (const a of state.accounts ?? []) {
    const chip = el('span', 'acct');
    chip.dataset.testid = 'account-chip';
    chip.dataset.accountId = a.id;
    chip.append(el('span', undefined, `${a.name || a.address || a.id}`));
    const check = button('acct-check', 'Check', 'Check for new messages');
    check.onclick = async () => {
      setStatus(`checking ${a.host}\u2026`);
      const r = await gb().invoke('mail:sync', a.id);
      setStatus(r?.ok ? `checked ${a.host}` : (r?.refused ?? r?.error ?? 'check failed'));
      await refreshTree();
      await refreshList();
    };
    const test = button('acct-test-chip', 'Test', 'Test the connection');
    test.onclick = async () => {
      const r = await gb().invoke('mail:account-test', a.id);
      setStatus(`${r.step}: ${r.message}`);
    };
    const del = button('acct-remove', 'Remove', 'Remove this account and its stored mail');
    del.onclick = async () => {
      await gb().invoke('mail:account-remove', a.id);
      if (selectedAccount === a.id) selectedAccount = '';
      await refreshState();
      await refreshTree();
      await refreshList();
    };
    chip.append(check, test, del);
    box.append(chip);
  }
  const add = button('acct-add', '+ Add mail account');
  add.onclick = () => {
    $('m-account-form').classList.remove('hidden');
    $('m-acct-msg').textContent = '';
  };
  box.append(add);
  // the keyring report is shown where the choice is made, not buried
  box.append(el('span', 'muted small', `secret storage: ${state.secretMode ?? '?'}${state.keychain?.backend ? ` (keyring: ${state.keychain.backend})` : ''}`));
}

function renderUnlock() {
  const modal = $('m-unlock');
  const needs = state.locked === true && state.secretMode === 'passphrase';
  modal.classList.toggle('hidden', !needs);
  if (needs) {
    $('m-unlock-help').textContent =
      state.keychain && !state.keychain.available
        ? `No operating-system keyring is available (Electron reports "${state.keychain.backend}"), so mail passwords are protected by a master passphrase you choose. It is asked for once per session and never stored.`
        : 'Your mail passwords are protected by a master passphrase. It is asked for once per session and never stored.';
  }
  $('m-unlock-warn').classList.toggle('hidden', !state.warning);
  $('m-unlock-warn').textContent = state.warning ?? '';
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('m-search').addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    void refreshList();
  });
  $('m-filter-menu').onclick = (e) => {
    const t = (e.target as HTMLElement).closest('[data-view-key]') as HTMLElement | null;
    if (!t) return;
    void toggleViewFilter(t.dataset.viewKey as string);
  };
  $('m-filters').onclick = () => {
    const menu = $('m-filter-menu');
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    if (opening) renderFilterMenu();
  };
  $('m-check').onclick = async () => {
    if (!selectedAccount) return;
    setStatus('checking\u2026');
    const r = await gb().invoke('mail:sync', selectedAccount);
    setStatus(r?.ok ? 'up to date' : (r?.refused ?? r?.error ?? 'check failed'));
    await refreshTree();
    await refreshList();
  };
  $('m-flag').onclick = () => {
    flagOnly = !flagOnly;
    $('m-flag').classList.toggle('active', flagOnly);
    void refreshList();
  };
  $('m-check-all').onclick = async () => {
    setStatus('checking every account…');
    const r = await gb().invoke('mail:sync-all');
    const n = (r?.accounts ?? []).filter((a: { ok: boolean }) => a.ok).length;
    setStatus(`${n}/${(r?.accounts ?? []).length} account(s) checked`);
    await refreshState();
    await refreshTree();
    await refreshList();
  };
  $('m-filters').onclick = () => {
    const menu = $('m-filter-menu');
    menu.classList.toggle('hidden');
  };
  $('m-send').onclick = () => setStatus('Compose and sending ship in ticket 38 (compose, drafts, outbox).');
  $('m-import').onclick = () => setStatus('Compose ships in ticket 38.');
  // One click from the toolbar: open the account panel and run the scan straight away, so configuring
  // eighteen accounts is not "find the right modal first".
  $('m-import').onclick = () => {
    $('m-account-form').classList.remove('hidden');
    $('m-acct-msg').textContent = '';
    $('m-import-scan').click();
  };

  // unlock
  $('m-unlock-go').onclick = async () => {
    const pass = ($('m-unlock-pass') as HTMLInputElement).value;
    const r = await gb().invoke('mail:unlock', pass);
    if (r?.ok) {
      setStatus('mail unlocked');
      await refreshState();
    } else {
      $('m-unlock-msg').textContent = r?.error ?? 'could not unlock';
    }
  };
  $('m-unlock-plain').onclick = async () => {
    const r = await gb().invoke('mail:secret-mode', 'plaintext');
    if (r?.ok) {
      await refreshState();
      setStatus('passwords are stored in plaintext: see the warning in this window');
    } else {
      $('m-unlock-msg').textContent = r?.error ?? '';
    }
  };

  // account form
  $('m-acct-cancel').onclick = () => $('m-account-form').classList.add('hidden');
  $('m-acct-save').onclick = async () => {
    const body = {
      id: ($('m-a-user') as HTMLInputElement).value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || `acct-${Date.now().toString(36)}`,
      name: ($('m-a-name') as HTMLInputElement).value,
      address: ($('m-a-address') as HTMLInputElement).value,
      kind: 'imap',
      host: ($('m-a-host') as HTMLInputElement).value,
      port: Number(($('m-a-port') as HTMLInputElement).value) || 993,
      tls: 'implicit',
      username: ($('m-a-user') as HTMLInputElement).value,
      authKind: 'password',
      sentFolder: ($('m-a-sent') as HTMLInputElement).value || 'Sent',
      trashFolder: ($('m-a-trash') as HTMLInputElement).value || 'Trash',
      junkFolder: 'Junk',
      archiveFolder: 'Archive',
    };
    const r = await gb().invoke('mail:account-save', body, { password: ($('m-a-pass') as HTMLInputElement).value });
    $('m-acct-msg').textContent = r?.ok ? 'account saved' : (r?.error ?? 'could not save');
    if (r?.ok) {
      selectedAccount = r.id;
      ($('m-a-pass') as HTMLInputElement).value = '';
      $('m-account-form').classList.add('hidden');
      await refreshState();
      await refreshTree();
      await refreshList();
    }
  };
  $('m-import-scan').onclick = async () => {
    const box = $('m-import-list');
    box.replaceChildren();
    box.classList.remove('hidden');
    const scan = await gb().invoke('mail:import-scan');
    if (!scan?.ok) {
      box.append(el('p', 'small warn', scan?.error ?? 'could not read the config'));
      return;
    }
    box.append(el('p', 'small muted', `${scan.path} — ${scan.accounts.length} account(s) to import`));
    const rows: Array<{ id: string; checked: boolean }> = [];
    for (const a of scan.accounts) {
      const row = el('label', 'import-row');
      row.dataset.testid = 'import-row';
      row.dataset.accountId = a.account.id;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.testid = 'import-check';
      const existing = (scan.existing ?? []).includes(a.account.id);
      rows.push({ id: a.account.id, checked: true });
      cb.onchange = () => {
        const r = rows.find((x) => x.id === a.account.id);
        if (r) r.checked = cb.checked;
      };
      const text = el('span', 'import-text');
      text.append(el('strong', undefined, `${a.account.name} `));
      text.append(el('span', 'muted', `${a.account.username} @ ${a.account.host}:${a.account.port}${existing ? ' (already configured)' : ''}`));
      if (!a.hasPassword) text.append(el('span', 'warn', ' — no password in the config'));
      for (const n of a.notes ?? []) text.append(el('span', 'warn small', ` • ${n}`));
      row.append(cb, text);
      box.append(row);
    }
    for (const s of scan.skipped ?? []) box.append(el('p', 'small warn', `skipped ${s.name}: ${s.reason}`));
    const go = button('mail-import-apply', `Import ${scan.accounts.length} account(s)`);
    go.onclick = async () => {
      const ids = rows.filter((r) => r.checked).map((r) => r.id);
      const r = await gb().invoke('mail:import-apply', scan.path, ids);
      $('m-acct-msg').textContent = r?.ok
        ? `imported ${r.added} new, ${r.updated} updated`
        : `import finished with problems: ${(r?.failed ?? []).map((f: AnyRec) => f.id).join(', ') || r?.error || ''}`;
      if (r?.ok) {
        $('m-account-form').classList.add('hidden');
        await refreshState();
        const first = (state.accounts ?? [])[0];
        if (first) selectedAccount = first.id;
        await refreshTree();
        await refreshList();
      }
    };
    box.append(go);
  };

  // Test uses the SELECTED account's stored record: the form's unsaved values are not a connection
  $('m-acct-test').onclick = async () => {
    const id = selectedAccount || (state.accounts ?? [])[0]?.id;
    if (!id) {
      $('m-acct-msg').textContent = 'save the account first, then test it';
      return;
    }
    const r = await gb().invoke('mail:account-test', id);
    $('m-acct-msg').textContent = `${r.step}: ${r.message}`;
  };
}

export interface MailPanelUi {
  refresh(): Promise<void>;
  setSearch(q: string): void;
}

async function main() {
  wire();
  await refreshState();
  const first = (state.accounts ?? [])[0];
  if (first) selectedAccount = first.id;
  await refreshTree();
  await refreshList();
  setStatus(summary());
}

/** The line under the panel: accounts, and whether anything has been synced yet. */
function summary(): string {
  const n = (state.accounts ?? []).length;
  if (!n) return 'No mail account configured — use Import or Add mail account.';
  if (!state.synced) return `${n} account(s) configured, not synced yet — press ↻ to check the selected account, or ⇉ for all.`;
  return `${n} account(s)`;
}

export const mailPanel: MailPanelUi = {
  async refresh() {
    await refreshState();
    await refreshTree();
    await refreshList();
    setStatus(summary());
  },
  setSearch(q: string) {
    searchQuery = q;
    void refreshList();
  },
};

export function initMailPanel(gbIn: MailBridge) {
  bridge = gbIn;
  wire();
  void main();
}

// ---------------------------------------------------------------- view filters (measured from the reference)

/** The filter menu the reference screenshot shows under "View Filters". Applied store-side. */
const VIEW_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'read', label: 'Unread first' },
  { key: 'showJunk', label: 'Show Junk' },
  { key: 'showTrash', label: 'Show Trash' },
  { key: 'showArchive', label: 'Show Archive' },
  { key: 'showCustomFolders', label: 'Show Custom Folders' },
  { key: 'showMailingLists', label: 'Show Mailing Lists' },
  { key: 'showFeeds', label: 'Show Feeds' },
];

function renderFilterMenu() {
  const menu = $('m-filter-menu');
  menu.replaceChildren();
  for (const f of VIEW_FILTERS) {
    const on = f.key === 'read' ? state.view?.read !== 'all' : state.view?.[f.key] === true;
    const b = el('button', undefined, `${on ? '\u2713 ' : '\u2003'}${f.label}`);
    b.dataset.viewKey = f.key;
    menu.append(b);
  }
}

async function toggleViewFilter(key: string) {
  const isRead = key === 'read';
  const on = isRead ? state.view?.read === 'all' : state.view?.[key] === true;
  const patch = isRead ? { read: on ? 'unseen' : 'all' } : { [key]: !on };
  await gb().invoke('mail:view-set', patch);
  await refreshState();
  renderFilterMenu();
  await refreshTree();
  await refreshList();
}

void renderFilterMenu;

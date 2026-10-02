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
//
// HTML mail is NOT rendered here. When `mail:message` says `hasHtml`, this file asks main to show
// that message id in the locked-down HTML view (src/main/mail/html-view.ts) and reports where the
// reading pane is (`mail:view-rect`); the HTML itself never reaches this document. Because that view
// is a native view drawn OVER this page, the rect is reported as null whenever chrome UI would be
// covered by it: a modal, a menu, the address suggestions, a confirmation, or the panel closing.

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
/** the message the HTML view is showing (0 = the text body is in use) */
let htmlShownId = 0;
/** the folders of the selected account, as mail:folders last returned them (for the server Drafts) */
let lastFolders: AnyRec[] = [];

/**
 * The compose form (ticket 38), when it is open. It REPLACES the reading pane, and the HTML view is
 * hidden for as long as it is open: that view is a native view drawn over this document and would
 * cover the form. Every field is what the user typed (or what main prefilled from the STORED message
 * for a reply); nothing from a page can reach it — no page has a channel to this document.
 */
interface ComposeState {
  draftId: string;
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  refMessage: number;
}
let composing: ComposeState | null = null;
let autosaveTimer = 0;
const AUTOSAVE_MS = 800;
const LOCAL_DRAFTS = 'local:drafts';
const LOCAL_OUTBOX = 'local:outbox';

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
  lastFolders = data.folders ?? [];
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
        // the quick-reply strip replies to the OPEN message; there is none now
        ($('m-send') as HTMLButtonElement).disabled = true;
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
  if (!searchQuery && selectedFolder === LOCAL_DRAFTS) return renderDrafts();
  if (!searchQuery && selectedFolder === LOCAL_OUTBOX) return renderOutbox();
  const data = searchQuery
    ? await gb().invoke('mail:search', searchQuery, { accountId: selectedAccount })
    : await gb().invoke('mail:list', { accountId: selectedAccount, folder: folderPathFor(selectedFolder) });
  const rows = $('m-rows');
  rows.replaceChildren();
  $('m-count').textContent = `${data.total ?? data.rows?.length ?? 0} messages`;
  $('m-search-state').textContent = data.refused ? data.refused : '';
  const visible = (data.rows ?? []).filter((r: AnyRec) => !flagOnly || r.flagged);
  if (!visible.length) rows.append(el('p', 'muted small', searchQuery ? 'No matches.' : 'No messages in this folder.'));
  for (const r of visible) rows.append(messageRow(r));
}

function messageRow(r: AnyRec): HTMLElement {
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
  return row;
}

/** Drafts: the local ones (ticket 38), then any messages in the server's Drafts folder. */
async function renderDrafts() {
  const data = await gb().invoke('mail:drafts', selectedAccount);
  const rows = $('m-rows');
  rows.replaceChildren();
  const local: AnyRec[] = data?.drafts ?? [];
  const server = lastFolders.find((f) => f.kind === 'drafts');
  const remote = server ? await gb().invoke('mail:list', { accountId: selectedAccount, folder: server.path }) : { rows: [] };
  $('m-count').textContent = `${local.length + (remote.rows?.length ?? 0)} drafts`;
  if (!local.length && !remote.rows?.length) rows.append(el('p', 'muted small', 'No drafts.'));
  for (const d of local) {
    const row = el('div', 'row');
    row.dataset.testid = 'draft-row';
    row.dataset.draftId = d.id;
    const top = el('div', 'top');
    top.append(el('span', 'from', d.to ? `To: ${d.to}` : '(no recipients)'));
    top.append(el('span', 'time', new Date(d.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })));
    row.append(top, el('div', 'subject', d.subject || '(no subject)'), el('div', 'preview', 'Draft (saved on this computer)'));
    row.onclick = async () => {
      const r = await gb().invoke('mail:draft-get', d.id);
      if (!r?.ok) return setStatus(r?.error ?? 'could not open the draft');
      await openCompose({ ...r.draft, draftId: r.draft.id, attachments: r.attachments, originalAttachments: r.originalAttachments });
    };
    rows.append(row);
  }
  for (const r of remote.rows ?? []) rows.append(messageRow(r));
}

/** The Outbox: queued and failed messages, each with its error and a Retry. */
async function renderOutbox() {
  const data = await gb().invoke('mail:outbox', selectedAccount);
  const rows = $('m-rows');
  rows.replaceChildren();
  const items: AnyRec[] = data?.items ?? [];
  $('m-count').textContent = `${items.length} in the Outbox`;
  if (!items.length) rows.append(el('p', 'muted small', 'The Outbox is empty.'));
  for (const o of items) {
    const row = el('div', `row outbox${o.status === 'failed' ? ' failed' : ''}`);
    row.dataset.testid = 'outbox-row';
    row.dataset.outboxId = o.id;
    row.dataset.status = o.sending ? 'sending' : o.status;
    const top = el('div', 'top');
    top.append(el('span', 'from', `To ${o.recipients} recipient(s)${o.domains ? ` at ${o.domains.split(',').join(', ')}` : ''}`));
    row.append(top, el('div', 'subject', o.subject || '(no subject)'));
    const st = el('div', 'status', o.sending ? 'sending\u2026' : o.status === 'failed' ? o.error || 'failed' : 'queued');
    st.dataset.testid = 'outbox-error';
    row.append(st);
    const actions = el('div', 'row-actions');
    const retry = button('outbox-retry', 'Retry', 'Send this message now');
    retry.onclick = async (e) => {
      e.stopPropagation();
      setStatus('sending\u2026');
      const r = await gb().invoke('mail:outbox-retry', o.id);
      setStatus(sendOutcome(r));
      await refreshTree();
      await refreshList();
    };
    const del = button('outbox-delete', 'Delete', 'Delete this message without sending it');
    del.onclick = async (e) => {
      e.stopPropagation();
      const r = await gb().invoke('mail:outbox-delete', o.id);
      if (r && r.ok === false) setStatus(r.error ?? 'could not delete');
      await refreshTree();
      await refreshList();
    };
    actions.append(retry, del);
    row.append(actions);
    rows.append(row);
  }
}

/** One status line for a send / retry result. */
function sendOutcome(r: AnyRec): string {
  if (r?.ok) {
    const copy = r.sentCopy === 'failed' ? ` (the copy in Sent could not be saved: ${r.sentCopyError ?? 'unknown error'})` : r.sentCopy === 'skipped' ? ' (the server keeps the copy in Sent)' : '';
    return `Sent${copy}.`;
  }
  if (r?.refused) return `Not sent: ${r.refused}. It is in the Outbox; press Retry when that is over.`;
  if (r?.queued) return `Not sent: ${r.error ?? 'failed'}. It is in the Outbox.`;
  return r?.error ?? 'could not send';
}

/** A tree row id is either a folder path or a view/label id; only a path is a folder. */
function folderPathFor(id: string): string {
  if (!id || id.startsWith('view:') || id.startsWith('label:') || id.startsWith('filter:') || id.startsWith('role:')) return 'INBOX';
  return id;
}

async function openMessage(id: number) {
  // opening a message leaves the compose form; what was typed is kept as a draft
  if (composing) await leaveCompose(true);
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
  // HTML: shown by main in its own view over #m-body, which stays empty as the placeholder whose
  // rect is reported. TEXT otherwise: `textContent`, so an encoded <script> stays characters.
  const body = $('m-body');
  const shown = m.hasHtml ? await gb().invoke('mail:view-show', id) : null;
  if (shown?.hasHtml) {
    htmlShownId = id;
    body.replaceChildren();
    body.classList.add('html');
  } else {
    if (htmlShownId) void gb().invoke('mail:view-show', 0);
    htmlShownId = 0;
    body.classList.remove('html');
    body.textContent = m.text || (m.text === '' ? '(no text body)' : '');
  }
  scheduleViewRect();
  renderAttachments(id, m.attachments ?? []);
  renderNotice(m, id, !!shown?.hasHtml);
  renderActions(m);
  ($('m-send') as HTMLButtonElement).disabled = false;
  await refreshState();
}

/** `1.2 MB` / `340 KB` / `12 B` */
function fmtSize(n: number): string {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/**
 * The attachment chips (ticket 41): name, type, size and the dangerous-file warning, all as TEXT
 * (main already sanitized the name; it is still never markup). Nothing is fetched until a button is
 * pressed: Download saves through the browser's download path; Open asks main, which shows its own
 * confirmation naming the file and its type.
 */
function renderAttachments(id: number, list: AnyRec[]) {
  const atts = $('m-attachments');
  atts.replaceChildren();
  for (const a of list) {
    const chip = el('div', `att${a.warning ? ' att-warn' : ''}`);
    chip.dataset.testid = 'mail-attachment';
    chip.dataset.part = String(a.partId ?? '');
    const name = el('span', 'att-name', String(a.name ?? 'attachment'));
    name.dataset.testid = 'att-name';
    chip.append(name, el('span', 'att-meta muted', ` ${String(a.mime ?? '')} \u00b7 ${fmtSize(a.size)}`));
    if (a.warning) {
      const w = el('span', 'att-warning', ` \u26a0 ${String(a.warning)}`);
      w.dataset.testid = 'att-warning';
      chip.append(w);
    }
    const dl = button('att-download', 'Download', 'Download this attachment into your downloads folder');
    dl.onclick = async () => {
      dl.disabled = true;
      setStatus(`downloading ${a.name}\u2026`);
      try {
        const r = await gb().invoke('mail:attachment-download', id, a.partId);
        setStatus(r?.ok ? `Saved ${r.name} to your downloads folder.` : (r?.error ?? 'the attachment could not be downloaded'));
      } finally {
        dl.disabled = false;
      }
    };
    const op = button('att-open', 'Open', 'Open with the system application (asks first)');
    op.onclick = async () => {
      op.disabled = true;
      try {
        const r = await gb().invoke('mail:attachment-open', id, a.partId);
        setStatus(r?.ok ? `Opened ${a.name}.` : (r?.error ?? 'the attachment could not be opened'));
      } finally {
        op.disabled = false;
      }
    };
    chip.append(' ', dl, ' ', op);
    atts.append(chip);
  }
}

/**
 * The remote-content banner. For an HTML message with remote images it carries the per-message
 * "Load External Content" action; the allowance lasts for this display only (main resets it when
 * another message is shown, this one is reopened, or an agent task starts).
 */
function renderNotice(m: AnyRec, id: number, html: boolean) {
  const notice = $('m-notice');
  notice.replaceChildren();
  if (m.notice) notice.append(el('span', undefined, m.notice));
  if (html && m.remoteImages) {
    const b = button('mail-load-remote', 'Load External Content', 'Load this message\'s remote images, this time only');
    b.onclick = async () => {
      const r = await gb().invoke('mail:view-load-remote', id);
      if (id !== htmlShownId) return;
      notice.replaceChildren(el('span', undefined, r?.ok ? 'Remote images loaded for this message only.' : (r?.error ?? 'remote content could not be loaded')));
      if (!r?.ok) notice.append(b);
    };
    notice.append(' ', b);
  }
  notice.classList.toggle('hidden', !m.notice);
}

// ---------------------------------------------------------------- the HTML view's rectangle

/** chrome UI a native view must never cover; any of these visible means "report null" */
const COVERS = '.modal, .overlay, .menu, #suggest, #palette, #reader';
let rectTimer = 0;
let lastRect = '';

function viewRect(): { x: number; y: number; width: number; height: number } | null {
  if (!htmlShownId) return null;
  // the compose form replaces the reading pane: the native view must not cover it
  if (composing) return null;
  // the panel (or this section of it) is closed: display:none somewhere up the tree
  if (!$('mail-view').getClientRects().length) return null;
  for (const n of document.querySelectorAll(COVERS)) if (n.getClientRects().length) return null;
  const r = $('m-body').getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** coalesced: many DOM changes in one task produce one report, and an unchanged rect none */
function scheduleViewRect() {
  if (rectTimer) return;
  rectTimer = window.setTimeout(() => {
    rectTimer = 0;
    const r = viewRect();
    const key = r ? `${r.x},${r.y},${r.width},${r.height}` : '';
    if (key === lastRect) return;
    lastRect = key;
    void gb().invoke('mail:view-rect', r);
  }, 0);
}

function watchViewRect() {
  // class/style flips are how every panel, modal and menu in the chrome opens and closes
  new MutationObserver(() => {
    if (htmlShownId || lastRect) scheduleViewRect();
  }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'hidden'], subtree: true, childList: true });
  new ResizeObserver(() => scheduleViewRect()).observe($('m-body'));
  window.addEventListener('resize', () => scheduleViewRect());
}

function renderActions(m: AnyRec) {
  const box = $('m-actions');
  box.replaceChildren();
  const action = async (label: string, id: string, fn: () => Promise<any>) => {
    const b = button(id, label);
    b.onclick = async () => {
      const r = await fn();
      if (r && r.ok === false) setStatus(r.error ?? 'that action failed');
      if (!composing) await refreshList();
    };
    box.append(b);
  };
  const compose = (kind: 'reply' | 'replyAll' | 'forward') => async () => {
    const r = await gb().invoke('mail:compose-init', kind, m.id);
    if (!r?.ok) return r;
    await openCompose(r);
    return { ok: true };
  };
  void action('Reply', 'mail-reply', compose('reply'));
  void action('Reply All', 'mail-reply-all', compose('replyAll'));
  void action('Forward', 'mail-forward', compose('forward'));
  void action(m.flagged ? 'Unflag' : 'Flag', 'mail-flag', () => gb().invoke('mail:flags', [m.id], { flagged: !m.flagged }));
  void action(m.readFlag ? 'Mark Unread' : 'Mark Read', 'mail-read', () => gb().invoke('mail:flags', [m.id], { readFlag: !m.readFlag, seen: true }));
  void action('Archive', 'mail-archive', () => gb().invoke('mail:move', [m.id], 'Archive'));
  void action('Trash', 'mail-trash', () => gb().invoke('mail:move', [m.id], 'Trash'));
}

// ---------------------------------------------------------------- accounts

/**
 * The ACCOUNTS section at the top of the left column (the user's call: accounts belong in the left
 * column, not in a strip under the panel). One row per account, the selected one highlighted; the
 * folder tree under it is the selected account's. Clicking a row switches account, so every account
 * is reachable, not only the first.
 */
function renderAccounts() {
  const box = $('m-accounts');
  box.replaceChildren();
  const head = el('div', 'section-head');
  head.append(el('span', undefined, '\u25be Accounts'));
  box.append(head);
  // two accounts with the same display name (e.g. a personal and a work address under one person's
  // name) are told apart by their address, so every row says which mailbox it is
  const names = new Map<string, number>();
  for (const a of state.accounts ?? []) names.set(a.name || '', (names.get(a.name || '') ?? 0) + 1);
  for (const a of state.accounts ?? []) {
    const row = el('div', 'acct');
    row.dataset.testid = 'account-chip';
    row.dataset.accountId = a.id;
    if (selectedAccount === a.id) row.classList.add('active');
    row.title = a.address ? `${a.address} \u2014 ${a.host ?? ''}` : a.id;
    const label = a.name && (names.get(a.name) ?? 0) < 2 ? a.name : a.address || a.name || a.id;
    row.append(el('span', undefined, '\u2709'), el('span', 'label', label));
    const chips = el('div', 'chips');
    const unread = Number(a.unread ?? 0);
    chips.append(el('span', `chip${unread ? '' : ' zero'}`, String(unread)));
    row.append(chips);
    row.onclick = async () => {
      if (selectedAccount === a.id) return;
      selectedAccount = a.id;
      selectedFolder = '';
      selectedMessageId = 0;
      ($('m-send') as HTMLButtonElement).disabled = true;
      renderAccounts();
      await refreshTree();
      await refreshList();
    };
    box.append(row);
    // the per-account actions sit under the SELECTED row only, so the column stays a list
    if (selectedAccount !== a.id) continue;
    const tools = el('div', 'acct-tools');
    const check = button('acct-check', 'Check', 'Check for new messages');
    check.onclick = async (e) => {
      e.stopPropagation();
      setStatus(`checking ${a.host}\u2026`);
      const r = await gb().invoke('mail:sync', a.id);
      setStatus(r?.ok ? `checked ${a.host}` : (r?.refused ?? r?.error ?? 'check failed'));
      await refreshState();
      await refreshTree();
      await refreshList();
    };
    const test = button('acct-test-chip', 'Test', 'Test the connection');
    test.onclick = async (e) => {
      e.stopPropagation();
      const r = await gb().invoke('mail:account-test', a.id);
      setStatus(`${r.step}: ${r.message}`);
    };
    const del = button('acct-remove', 'Remove', 'Remove this account and its stored mail');
    del.onclick = async (e) => {
      e.stopPropagation();
      await gb().invoke('mail:account-remove', a.id);
      if (selectedAccount === a.id) selectedAccount = '';
      await refreshState();
      if (!selectedAccount) selectedAccount = (state.accounts ?? [])[0]?.id ?? '';
      renderAccounts();
      await refreshTree();
      await refreshList();
    };
    tools.append(check, test, del);
    box.append(tools);
  }
  const foot = el('div', 'acct-foot');
  const add = button('acct-add', '+ Add mail account');
  add.onclick = () => {
    $('m-account-form').classList.remove('hidden');
    $('m-acct-msg').textContent = '';
  };
  foot.append(add);
  // the keyring report is shown where the choice is made, not buried
  foot.append(el('span', 'muted small', `secret storage: ${state.secretMode ?? '?'}${state.keychain?.backend ? ` (keyring: ${state.keychain.backend})` : ''}`));
  box.append(foot);
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
  // the quick-reply strip: a reply to the OPEN message; recipients and subject come from main (the
  // stored row), the text is what was typed, and the quote (when checked) is added by main from the
  // stored text body
  $('m-send').onclick = async () => {
    const text = ($('m-reply') as HTMLTextAreaElement).value;
    if (!selectedMessageId) return setStatus('open a message to reply to');
    if (!text.trim()) return setStatus('write a reply first');
    const init = await gb().invoke('mail:compose-init', 'reply', selectedMessageId);
    if (!init?.ok) return setStatus(init?.error ?? 'could not reply');
    setStatus('sending\u2026');
    // one send per click: the button is off until the result is back, and main refuses a second
    // send under the same key while the first is in flight
    const btn = $('m-send') as HTMLButtonElement;
    btn.disabled = true;
    let r: AnyRec;
    try {
      r = await gb().invoke('mail:send', { ...init, draftId: `quickreply-${selectedMessageId}`, body: text, includeQuoted: ($('m-quoted') as HTMLInputElement).checked });
    } finally {
      btn.disabled = !selectedMessageId;
    }
    setStatus(sendOutcome(r));
    if (r?.ok || r?.queued) ($('m-reply') as HTMLTextAreaElement).value = '';
    await refreshTree();
  };
  $('m-compose-btn').onclick = () => void openCompose({ mode: 'new' });
  wireCompose();
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
  // the default port follows the security choice, unless the user typed another one
  $('m-a-smtp-tls').onchange = () => {
    const port = $('m-a-smtp-port') as HTMLInputElement;
    const tls = ($('m-a-smtp-tls') as HTMLSelectElement).value;
    if (port.value === '465' || port.value === '587' || !port.value) port.value = tls === 'starttls' ? '587' : '465';
  };
  $('m-acct-save').onclick = async () => {
    const smtpPort = Number(($('m-a-smtp-port') as HTMLInputElement).value) || 0;
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
      smtpHost: ($('m-a-smtp-host') as HTMLInputElement).value.trim(),
      ...(smtpPort ? { smtpPort } : {}),
      smtpTls: ($('m-a-smtp-tls') as HTMLSelectElement).value,
    };
    const r = await gb().invoke('mail:account-save', body, { password: ($('m-a-pass') as HTMLInputElement).value, smtpPassword: ($('m-a-smtp-pass') as HTMLInputElement).value });
    $('m-acct-msg').textContent = r?.ok ? 'account saved' : (r?.error ?? 'could not save');
    if (r?.ok) {
      selectedAccount = r.id;
      ($('m-a-pass') as HTMLInputElement).value = '';
      ($('m-a-smtp-pass') as HTMLInputElement).value = '';
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

// ---------------------------------------------------------------- compose (ticket 38)

const input = (id: string) => $(id) as HTMLInputElement;

/** Open the form, filled from a draft, a compose-init reply, or nothing. Replaces the reading pane. */
async function openCompose(f: AnyRec) {
  if (composing) await leaveCompose(true);
  composing = { draftId: String(f.draftId ?? ''), mode: f.mode ?? 'new', refMessage: Number(f.refMessage ?? 0) || 0 };
  // the HTML view is a native view over this document: hide it for as long as the form is open
  if (htmlShownId) {
    htmlShownId = 0;
    void gb().invoke('mail:view-show', 0);
  }
  scheduleViewRect();
  for (const id of ['m-read-head', 'm-body', 'm-attachments', 'm-composer']) $(id).classList.add('hidden');
  $('m-compose').classList.remove('hidden');
  const from = $('m-c-from') as HTMLSelectElement;
  from.replaceChildren();
  for (const a of state.accounts ?? []) {
    const o = el('option', undefined, a.address ? `${a.name ? `${a.name} ` : ''}<${a.address}>` : a.id);
    o.value = a.id;
    from.append(o);
  }
  from.value = String(f.accountId || selectedAccount || (state.accounts ?? [])[0]?.id || '');
  input('m-c-to').value = String(f.to ?? '');
  input('m-c-cc').value = String(f.cc ?? '');
  input('m-c-bcc').value = String(f.bcc ?? '');
  $('m-c-bcc-row').classList.toggle('hidden', !f.bcc);
  input('m-c-subject').value = String(f.subject ?? '');
  ($('m-c-body') as HTMLTextAreaElement).value = String(f.body ?? '');
  const reply = composing.mode === 'reply' || composing.mode === 'replyAll';
  input('m-c-quoted').checked = reply ? f.includeQuoted !== false : false;
  $('m-c-quoted-label').classList.toggle('hidden', !reply);
  $('m-c-note').textContent = reply
    ? 'The original message is quoted below your text when "Include Quoted Text" is checked.'
    : composing.mode === 'forward'
      ? 'The original message is added below your text as a forwarded message.'
      : '';
  $('m-c-msg').textContent = '';
  // ticket 41: the draft's attached files, and for a forward the original's attachments + the checkbox
  renderComposeAttachments(Array.isArray(f.attachments) ? f.attachments : []);
  const fwd = composing.mode === 'forward';
  input('m-c-fwd-att').checked = f.forwardAttachments !== false;
  const orig: AnyRec[] = Array.isArray(f.originalAttachments) ? f.originalAttachments : [];
  $('m-c-fwd-att-label').classList.toggle('hidden', !fwd || !orig.length);
  $('m-c-fwd-att-names').textContent = fwd && orig.length ? orig.map((a) => `${a.name} (${fmtSize(a.size)})`).join(', ') : '';
  (reply ? ($('m-c-body') as HTMLTextAreaElement) : input('m-c-to')).focus();
}

/** The compose form's attachment list: names and sizes (text), and a Remove button each. */
function renderComposeAttachments(list: AnyRec[]) {
  const box = $('m-c-atts');
  box.replaceChildren();
  for (const a of list) {
    const row = el('div', `c-att${a.warning ? ' att-warn' : ''}`);
    row.dataset.testid = 'compose-attachment';
    row.append(el('span', 'att-name', String(a.name ?? '')), el('span', 'muted', ` ${fmtSize(a.size)}`));
    if (a.warning) row.append(el('span', 'att-warning', ` \u26a0 ${String(a.warning)}`));
    const rm = button('compose-attachment-remove', '\u00d7', `Remove ${String(a.name ?? '')}`);
    rm.onclick = async () => {
      const c = composing;
      if (!c?.draftId) return;
      const r = await gb().invoke('mail:attach-remove', c.draftId, a.id);
      if (c === composing) renderComposeAttachments(r?.attachments ?? []);
    };
    row.append(' ', rm);
    box.append(row);
  }
  box.classList.toggle('hidden', !list.length);
}

function composeFields(): AnyRec {
  return {
    draftId: composing?.draftId ?? '',
    accountId: ($('m-c-from') as HTMLSelectElement).value,
    mode: composing?.mode ?? 'new',
    refMessage: composing?.refMessage ?? 0,
    to: input('m-c-to').value,
    cc: input('m-c-cc').value,
    bcc: input('m-c-bcc').value,
    subject: input('m-c-subject').value,
    body: ($('m-c-body') as HTMLTextAreaElement).value,
    includeQuoted: input('m-c-quoted').checked,
    forwardAttachments: input('m-c-fwd-att').checked,
  };
}

function composeEmpty(f: AnyRec): boolean {
  return !f.to.trim() && !f.cc.trim() && !f.bcc.trim() && !f.subject.trim() && !f.body.trim();
}

/** Save the form as a local draft. Silent for the autosave; a typed-nothing form is not saved. */
async function saveDraft(explicit: boolean): Promise<void> {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
  }
  if (!composing) return;
  const f = composeFields();
  if (!f.draftId && composeEmpty(f)) {
    if (explicit) $('m-c-msg').textContent = 'nothing to save yet';
    return;
  }
  const c = composing;
  const r = await gb().invoke('mail:draft-save', f);
  if (r?.ok && c === composing) c.draftId = r.id;
  if (composing) $('m-c-msg').textContent = r?.ok ? `Draft saved ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : (r?.error ?? 'could not save the draft');
  if (explicit) await refreshTree();
}

/** Close the form; `keep` saves what was typed as a draft first. Restores the reading pane. */
async function leaveCompose(keep: boolean) {
  if (keep) await saveDraft(false);
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = 0;
  composing = null;
  $('m-compose').classList.add('hidden');
  for (const id of ['m-read-head', 'm-body', 'm-attachments', 'm-composer']) $(id).classList.remove('hidden');
  scheduleViewRect();
}

function wireCompose() {
  // debounced autosave on every edit
  const onEdit = () => {
    if (!composing) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = 0;
      void saveDraft(false);
    }, AUTOSAVE_MS);
  };
  for (const id of ['m-c-to', 'm-c-cc', 'm-c-bcc', 'm-c-subject', 'm-c-body', 'm-c-quoted', 'm-c-from', 'm-c-fwd-att']) {
    $(id).addEventListener('input', onEdit);
    $(id).addEventListener('change', onEdit);
  }
  $('m-c-bcc-toggle').onclick = () => {
    const row = $('m-c-bcc-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) input('m-c-bcc').focus();
  };
  $('m-c-save').onclick = () => void saveDraft(true);
  // "Attach…": main runs the system file dialog and keeps private copies with the draft; this
  // document sends the form fields (so the draft exists) and never a path or a byte
  $('m-c-attach').onclick = async () => {
    const c = composing;
    if (!c) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    $('m-c-msg').textContent = 'choosing files\u2026';
    const r = await gb().invoke('mail:attach-pick', composeFields());
    if (c !== composing) return;
    if (r?.draftId) c.draftId = r.draftId;
    renderComposeAttachments(r?.attachments ?? []);
    $('m-c-msg').textContent = r?.error ?? (r?.cancelled ? '' : 'Attached.');
  };
  $('m-c-discard').onclick = async () => {
    const id = composing?.draftId;
    if (id) await gb().invoke('mail:draft-delete', id);
    await leaveCompose(false);
    setStatus('draft discarded');
    if (selectedMessageId) await openMessage(selectedMessageId);
    await refreshTree();
    await refreshList();
  };
  $('m-c-send').onclick = async () => {
    if (!composing) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    const btn = $('m-c-send') as HTMLButtonElement;
    if (btn.disabled) return;
    const f = composeFields();
    $('m-c-msg').textContent = 'sending\u2026';
    btn.disabled = true;
    let r: AnyRec;
    try {
      r = await gb().invoke('mail:send', f);
    } finally {
      btn.disabled = false;
    }
    // queued (refused by the gate, or a send failure): the message now lives in the Outbox, not in
    // the form; a validation error keeps the form open with the reason
    if (r?.ok || r?.queued) {
      await leaveCompose(false);
      setStatus(sendOutcome(r));
      if (selectedMessageId) await openMessage(selectedMessageId);
      await refreshTree();
      await refreshList();
    } else {
      $('m-c-msg').textContent = r?.error ?? 'could not send';
    }
  };
}

export interface MailPanelUi {
  refresh(): Promise<void>;
  setSearch(q: string): void;
  /** open an empty compose form (the toolbar button and Ctrl+N) */
  compose(): void;
}

async function main() {
  await refreshState();
  const first = (state.accounts ?? [])[0];
  if (first) selectedAccount = first.id;
  renderAccounts(); // now that a selection exists, so the row is highlighted and its tools shown
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
  compose() {
    void openCompose({ mode: 'new' });
  },
};

export function initMailPanel(gbIn: MailBridge) {
  bridge = gbIn;
  wire();
  watchViewRect();
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

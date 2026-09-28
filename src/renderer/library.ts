// History panel, bookmarks panel + bar, star button and address-bar suggestions. All of this is
// chrome UI: the data comes from this window's profile over IPC, page content never sees it.
// Every page-controlled string (titles, URLs) is inserted as TEXT only.

type Bridge = { invoke(channel: string, ...args: unknown[]): Promise<any>; on(channel: string, fn: (p: any) => void): void };

interface BNode { type: 'bookmark' | 'folder'; id: string; title: string; url?: string; nickname?: string; children?: BNode[] }
interface HEntry { url: string; title: string; lastVisit: number; visits: number; sources: string[] }

const TOP = 84;
const BAR = 28;
const SIDE = 340;

export function initLibrary(gb: Bridge) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const k of kids) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };
  let roots: BNode[] = [];
  let showBar = false;
  let side: 'history' | 'bookmarks' | null = null;
  let editing: string | null = null;
  let currentUrl = '';

  // ---------- layout: tell main how much room the chrome takes ----------
  function insets() {
    const top = TOP + (showBar ? BAR : 0);
    document.documentElement.style.setProperty('--top', `${top}px`);
    void gb.invoke('chrome:insets', top, side ? SIDE : 0);
  }

  // ---------- favicons: bytes from main, decoded here (sandboxed renderer) ----------
  const favUrls = new Map<string, string>();
  function favicon(url: string): HTMLElement {
    const img = el('img', { class: 'fav', alt: '' }) as HTMLImageElement;
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      return img;
    }
    const cached = favUrls.get(origin);
    if (cached) img.src = cached;
    else
      void gb.invoke('favicon:get', url).then((f: { mime: string; data: string } | null) => {
        if (!f || !/^image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|bmp)$/.test(f.mime) || f.data.length > 360_000) return;
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        const u = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
        favUrls.set(origin, u);
        img.src = u;
      });
    return img;
  }

  // ---------- side panel ----------
  function openSide(which: 'history' | 'bookmarks') {
    side = which;
    $('side').classList.remove('hidden');
    $('side-title').textContent = which === 'history' ? 'History' : 'Bookmarks';
    $('history-view').classList.toggle('hidden', which !== 'history');
    $('bookmarks-view').classList.toggle('hidden', which !== 'bookmarks');
    insets();
    if (which === 'history') void renderHistory();
    else void renderBookmarks();
  }
  function closeSide() {
    side = null;
    $('side').classList.add('hidden');
    insets();
  }
  function toggleSide(which: 'history' | 'bookmarks') {
    if (side === which) closeSide();
    else openSide(which);
  }
  $('side-close').onclick = closeSide;
  $('btn-history').onclick = () => toggleSide('history');
  $('btn-bookmarks').onclick = () => toggleSide('bookmarks');

  // ---------- history ----------
  async function renderHistory() {
    const r: { groups: Array<{ day: string; entries: HEntry[] }>; clearOnExit: boolean } = await gb.invoke('history:list', $<HTMLInputElement>('h-q').value, $<HTMLSelectElement>('h-src').value);
    $<HTMLInputElement>('h-clear-exit').checked = r.clearOnExit;
    const list = $('h-list');
    list.replaceChildren();
    for (const g of r.groups) {
      list.append(el('h4', {}, g.day));
      for (const e of g.entries) {
        const open = el('button', { title: 'Open', 'data-testid': 'history-open' }, 'Open');
        open.onclick = () => void gb.invoke('history:open', e.url, false);
        const nt = el('button', { title: 'Open in new tab', 'data-testid': 'history-open-tab' }, '+Tab');
        nt.onclick = () => void gb.invoke('history:open', e.url, true);
        const del = el('button', { title: 'Delete from history', 'data-testid': 'history-delete' }, '×');
        del.onclick = async () => {
          await gb.invoke('history:delete', e.url);
          void renderHistory();
        };
        const agent = e.sources.includes('agent') ? [el('span', { class: 'lock-agent-chip', title: 'visited by the agent' }, 'AGENT')] : [];
        const text = el('div', {}, el('span', { class: 't' }, ...agent, ` ${e.title || e.url}`), el('span', { class: 'u' }, `${e.url} · ${e.visits}× · ${e.sources.join('/')}`));
        list.append(el('div', { class: 'hrow', 'data-testid': 'history-row', 'data-url': e.url, 'data-sources': e.sources.join(',') }, favicon(e.url), text, el('span', { class: 'btns' }, open, nt, del)));
      }
    }
    if (!r.groups.length) list.append(el('p', { class: 'muted small' }, 'No history.'));
  }
  let hTimer: number | undefined;
  $('h-q').addEventListener('input', () => {
    window.clearTimeout(hTimer);
    hTimer = window.setTimeout(() => void renderHistory(), 150);
  });
  $('h-src').onchange = () => void renderHistory();
  $('h-del-range').onclick = async () => {
    await gb.invoke('history:delete-range', $<HTMLSelectElement>('h-range').value);
    void renderHistory();
  };
  $('h-clear-exit').onchange = () => void gb.invoke('history:clear-on-exit', $<HTMLInputElement>('h-clear-exit').checked);

  // ---------- bookmarks ----------
  const msg = (s: string) => ($('b-msg').textContent = s);
  const folders = (): Array<{ id: string; path: string }> => {
    const out: Array<{ id: string; path: string }> = [];
    const walk = (n: BNode, path: string) => {
      out.push({ id: n.id, path });
      for (const c of n.children ?? []) if (c.type === 'folder') walk(c, `${path} / ${c.title}`);
    };
    for (const r of roots) walk(r, r.title);
    return out;
  };

  let dragId: string | null = null;
  function row(n: BNode, depth: number, parent: BNode, index: number): HTMLElement {
    const folder = n.type === 'folder';
    const r = el('div', { class: `brow${folder ? ' folder' : ''}`, 'data-testid': folder ? 'bookmark-folder' : 'bookmark-row', 'data-id': n.id, draggable: String(!['bar', 'other'].includes(n.id)) });
    r.style.paddingLeft = `${depth * 12}px`;
    const text = el('div', {}, el('span', { class: 't' }, folder ? `\u{1F4C1} ${n.title}` : n.title), ...(folder ? [] : [el('span', { class: 'u' }, `${n.url}${n.nickname ? ` · nickname: ${n.nickname}` : ''}`)]));
    const btns = el('span', { class: 'btns' });
    if (!folder) {
      const open = el('button', { 'data-testid': 'bookmark-open' }, 'Open');
      open.onclick = () => void gb.invoke('bookmarks:open', n.id, false);
      btns.append(open);
    }
    if (!['bar', 'other'].includes(n.id)) {
      const edit = el('button', { 'data-testid': 'bookmark-edit' }, 'Edit');
      edit.onclick = () => {
        editing = editing === n.id ? null : n.id;
        void renderBookmarks();
      };
      const del = el('button', { 'data-testid': 'bookmark-delete' }, '×');
      del.onclick = async () => {
        const res = await gb.invoke('bookmarks:remove', n.id);
        msg(res.ok ? 'deleted' : res.error);
      };
      btns.append(edit, del);
    }
    r.append(folder ? el('span', {}) : favicon(n.url!), text, btns);
    // drag and drop: onto a folder = move into it; onto a bookmark = move before it
    r.addEventListener('dragstart', (e) => {
      dragId = n.id;
      e.dataTransfer?.setData('text/plain', n.id);
    });
    r.addEventListener('dragover', (e) => {
      if (!dragId || dragId === n.id) return;
      e.preventDefault();
      r.classList.add('dragover');
    });
    r.addEventListener('dragleave', () => r.classList.remove('dragover'));
    r.addEventListener('drop', async (e) => {
      e.preventDefault();
      r.classList.remove('dragover');
      const id = dragId;
      dragId = null;
      if (!id || id === n.id) return;
      const res = folder ? await gb.invoke('bookmarks:move', id, n.id, 1e9) : await gb.invoke('bookmarks:move', id, parent.id, index);
      msg(res.ok ? 'moved' : res.error);
    });
    return r;
  }

  function editor(n: BNode): HTMLElement {
    const title = el('input', { value: n.title, 'data-testid': 'bookmark-edit-title' }) as HTMLInputElement;
    const url = el('input', { value: n.url ?? '', 'data-testid': 'bookmark-edit-url' }) as HTMLInputElement;
    const nick = el('input', { value: n.nickname ?? '', placeholder: 'optional', 'data-testid': 'bookmark-edit-nickname' }) as HTMLInputElement;
    const folderSel = el('select', { 'data-testid': 'bookmark-edit-folder' }) as HTMLSelectElement;
    for (const f of folders()) if (f.id !== n.id) folderSel.append(new Option(f.path, f.id));
    const parentOf = (() => {
      let p = '';
      const walk = (x: BNode) => {
        for (const c of x.children ?? []) {
          if (c.id === n.id) p = x.id;
          if (c.type === 'folder') walk(c);
        }
      };
      roots.forEach(walk);
      return p;
    })();
    folderSel.value = parentOf || 'bar';
    const save = el('button', { class: 'primary', 'data-testid': 'bookmark-edit-save' }, 'Save');
    save.onclick = async () => {
      const patch: Record<string, unknown> = { title: title.value };
      if (n.type === 'bookmark') Object.assign(patch, { url: url.value, nickname: nick.value || null });
      const r = await gb.invoke('bookmarks:update', n.id, patch);
      if (r.ok && folderSel.value !== parentOf) {
        const m = await gb.invoke('bookmarks:move', n.id, folderSel.value, 1e9);
        if (!m.ok) return msg(m.error);
      }
      if (r.ok) editing = null;
      msg(r.ok ? 'saved' : r.error);
      void renderBookmarks();
    };
    const fields = [el('label', {}, 'Name'), title];
    if (n.type === 'bookmark') fields.push(el('label', {}, 'URL'), url, el('label', {}, 'Nickname'), nick);
    fields.push(el('label', {}, 'Folder'), folderSel, el('span', {}), save);
    return el('div', { class: 'bedit', 'data-testid': 'bookmark-editor' }, ...fields);
  }

  async function renderBookmarks() {
    const t = await gb.invoke('bookmarks:tree');
    roots = t.roots;
    showBar = t.showBar;
    $<HTMLInputElement>('b-bar').checked = showBar;
    renderBar();
    const box = $('b-tree');
    box.replaceChildren();
    const q = $<HTMLInputElement>('b-q').value.trim();
    if (q) {
      const found: Array<BNode & { path: string }> = await gb.invoke('bookmarks:search', q);
      for (const [i, b] of found.entries()) box.append(row(b, 0, roots[0], i), el('div', { class: 'u small muted' }, b.path));
      if (!found.length) box.append(el('p', { class: 'muted small' }, 'No bookmarks match.'));
      return;
    }
    const walk = (n: BNode, depth: number) => {
      (n.children ?? []).forEach((c, i) => {
        box.append(row(c, depth, n, i));
        if (editing === c.id) box.append(editor(c));
        if (c.type === 'folder') walk(c, depth + 1);
      });
    };
    for (const r of roots) {
      box.append(row(r, 0, r, 0));
      walk(r, 1);
    }
  }
  let bTimer: number | undefined;
  $('b-q').addEventListener('input', () => {
    window.clearTimeout(bTimer);
    bTimer = window.setTimeout(() => void renderBookmarks(), 150);
  });
  $('b-add-current').onclick = () => void bookmarkPage();
  $('b-add-folder').onclick = async () => {
    const r = await gb.invoke('bookmarks:add-folder', 'other', 'New folder');
    if (r.ok) editing = r.result.id;
    msg(r.ok ? 'folder created' : r.error);
  };
  $('b-bar').onchange = () => void gb.invoke('bookmarks:set-bar', $<HTMLInputElement>('b-bar').checked);
  $('b-import').onclick = async () => {
    const r = await gb.invoke('bookmarks:import', $<HTMLTextAreaElement>('b-io').value);
    msg(r.ok ? `imported ${r.result.imported}, skipped ${r.result.skipped}` : `rejected: ${r.error}`);
  };
  $('b-export').onclick = async () => {
    $<HTMLTextAreaElement>('b-io').value = await gb.invoke('bookmarks:export');
  };
  $('b-import-file').onclick = async () => {
    const r = await gb.invoke('bookmarks:import-file');
    msg(r.ok ? `imported ${r.result.imported}, skipped ${r.result.skipped}` : r.error);
  };
  $('b-export-file').onclick = async () => {
    const r = await gb.invoke('bookmarks:export-file');
    msg(r.ok ? 'exported' : r.error);
  };

  function renderBar() {
    const bar = $('bmbar');
    bar.classList.toggle('hidden', !showBar);
    bar.replaceChildren();
    for (const n of roots[0]?.children ?? []) {
      const b = el('button', { title: n.url ?? n.title, 'data-testid': 'bar-item' }, n.type === 'folder' ? `\u{1F4C1} ${n.title}` : n.title);
      b.onclick = () => (n.type === 'folder' ? openSide('bookmarks') : void gb.invoke('bookmarks:open', n.id, false));
      bar.append(b);
    }
    insets();
  }

  async function bookmarkPage() {
    const r = await gb.invoke('bookmarks:add-current');
    if (!r.ok) {
      openSide('bookmarks');
      msg(r.error);
      return;
    }
    editing = r.result.id;
    openSide('bookmarks');
    msg(r.result.existed ? 'already bookmarked' : 'bookmarked');
    void updateStar();
  }

  gb.on('bookmarks', (t: { roots: BNode[]; showBar: boolean }) => {
    roots = t.roots;
    showBar = t.showBar;
    renderBar();
    if (side === 'bookmarks') void renderBookmarks();
    void updateStar();
  });

  // ---------- star button ----------
  async function updateStar() {
    const id = await gb.invoke('bookmarks:is-bookmarked');
    const s = $('star');
    s.classList.toggle('on', !!id);
    s.innerHTML = id ? '&#9733;' : '&#9734;';
    s.setAttribute('data-bookmarked', id ? 'true' : 'false');
  }
  $('star').onclick = () => void bookmarkPage();

  // ---------- address bar suggestions ----------
  const addr = $<HTMLInputElement>('address');
  const box = $('suggest');
  let sel = -1;
  let items: Array<{ url: string }> = [];
  function hideSuggest() {
    if (box.classList.contains('hidden')) return;
    box.classList.add('hidden');
    void gb.invoke('chrome:overlay', false);
  }
  async function showSuggest() {
    const q = addr.value.trim();
    if (!q || document.activeElement !== addr) return hideSuggest();
    const r: { bookmarks: Array<{ title: string; url: string; nickname?: string }>; history: Array<{ title: string; url: string }> } = await gb.invoke('suggest', q);
    items = [];
    box.replaceChildren();
    const add = (kind: string, title: string, url: string) => {
      const i = items.length;
      items.push({ url });
      const d = el('div', { class: 'sug', 'data-testid': 'suggestion', 'data-kind': kind, role: 'option' }, el('span', { class: 'kind' }, kind), el('span', {}, title || url), el('span', { class: 'u' }, url));
      d.onmousedown = (e) => {
        e.preventDefault();
        go(items[i].url);
      };
      box.append(d);
    };
    for (const b of r.bookmarks) add(b.nickname && b.nickname === q.toLowerCase() ? 'nickname' : 'bookmark', b.title, b.url);
    for (const h of r.history) if (!r.bookmarks.some((b) => b.url === h.url)) add('history', h.title, h.url);
    sel = -1;
    if (!items.length) return hideSuggest();
    const rect = addr.getBoundingClientRect();
    Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.bottom + 2}px`, width: `${rect.width}px` });
    if (box.classList.contains('hidden')) {
      box.classList.remove('hidden');
      void gb.invoke('chrome:overlay', true); // page views step aside while the list is open
    }
  }
  function go(url: string) {
    hideSuggest();
    addr.blur();
    void gb.invoke('nav:go', url);
  }
  let sTimer: number | undefined;
  addr.addEventListener('input', () => {
    window.clearTimeout(sTimer);
    sTimer = window.setTimeout(() => void showSuggest(), 120);
  });
  // capture phase: runs before the address bar's own Enter handler
  addr.addEventListener('keydown', (e) => {
    if (box.classList.contains('hidden')) return;
    const rows = [...box.querySelectorAll('.sug')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('sel', i === sel));
    } else if (e.key === 'Enter' && sel >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      go(items[sel].url);
    } else if (e.key === 'Escape') hideSuggest();
  }, true);
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hideSuggest();
  });
  addr.addEventListener('blur', () => window.setTimeout(hideSuggest, 100));

  // ---------- keyboard ----------
  function shortcut(name: string) {
    if (name === 'history') toggleSide('history');
    else if (name === 'bookmark-page') void bookmarkPage();
    else if (name === 'toggle-bar') void gb.invoke('bookmarks:set-bar', !showBar);
  }
  gb.on('shortcut', shortcut);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && k === 'h') shortcut('history');
    else if (!e.shiftKey && k === 'd') shortcut('bookmark-page');
    else if (e.shiftKey && k === 'b') shortcut('toggle-bar');
    else return;
    e.preventDefault();
  });

  return {
    async load() {
      const t = await gb.invoke('bookmarks:tree');
      roots = t.roots;
      showBar = t.showBar;
      renderBar();
    },
    tabsChanged(url: string) {
      if (url !== currentUrl) {
        currentUrl = url;
        void updateStar();
      }
      if (side === 'history') void renderHistory();
    },
  };
}

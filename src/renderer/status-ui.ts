// Status bar, find bar, downloads panel and the page context menu — all chrome UI.
//
// Everything here is a VIEW over state main already owns: the status bar shows a zoom factor, the
// find bar shows Chromium's match counts, the downloads panel shows what the transfer layer
// recorded, and the context menu issues the same invokes the toolbar buttons do. None of it can
// reach page content, and no page-supplied string is ever inserted as HTML (text nodes only).

type Bridge = { invoke(channel: string, ...args: unknown[]): Promise<any>; on(channel: string, fn: (p: any) => void): void };

interface DownloadEntry {
  id: number;
  filename: string;
  host: string;
  url: string;
  total: number;
  received: number;
  state: string;
  path?: string;
  agentTask: boolean;
  source: 'user' | 'agent';
  paused: boolean;
}

const fmtBytes = (n: number) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

export function initStatus(gb: Bridge, getActiveTabId: () => number | null) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const k of kids) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };

  // ---------- zoom (bottom-right, per Vivaldi's status bar) ----------
  const label = $('zoom-label');
  function setZoom(factor: number) {
    label.textContent = `${Math.round(factor * 100)} %`;
    label.classList.toggle('sb-zoom-off', Math.abs(factor - 1) > 1e-6);
  }
  $('zoom-in').onclick = () => void gb.invoke('zoom:step', 1).then((r: { factor: number }) => setZoom(r.factor));
  $('zoom-out').onclick = () => void gb.invoke('zoom:step', -1).then((r: { factor: number }) => setZoom(r.factor));
  label.onclick = () => void gb.invoke('zoom:reset').then((r: { factor: number }) => setZoom(r.factor));
  gb.on('zoom', (z: { tab: number; factor: number }) => {
    if (z.tab === getActiveTabId()) setZoom(z.factor);
  });

  // ---------- find bar ----------
  const findbar = $('findbar');
  const findInput = $<HTMLInputElement>('find-q');
  const findCount = $('find-count');
  let findOpen = false;

  function openFind() {
    findOpen = true;
    findbar.classList.remove('hidden');
    findInput.focus();
    findInput.select();
  }
  function closeFind() {
    findOpen = false;
    findbar.classList.add('hidden');
    findCount.textContent = '';
    void gb.invoke('find:stop');
  }
  function runFind(opts: { forward?: boolean; findNext?: boolean } = {}) {
    const q = findInput.value;
    if (!q) {
      findCount.textContent = '';
      void gb.invoke('find:start', '');
      return;
    }
    void gb.invoke('find:start', q, { ...opts, matchCase: $<HTMLInputElement>('find-case').checked });
  }
  findInput.addEventListener('input', () => runFind());
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind({ findNext: true, forward: !e.shiftKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('find-next').onclick = () => runFind({ findNext: true, forward: true });
  $('find-prev').onclick = () => runFind({ findNext: true, forward: false });
  $('find-case').onchange = () => runFind();
  $('find-close').onclick = () => closeFind();
  gb.on('find:result', (r: { tab: number; matches: number; active: number; query: string }) => {
    if (r.tab !== getActiveTabId()) return;
    findCount.textContent = r.matches ? `${r.active}/${r.matches}` : r.query ? 'no matches' : '';
  });
  // Ctrl+F from main (the chord may arrive while a page has focus)
  gb.on('shortcut', (what: string) => {
    if (what === 'find') openFind();
  });
  // ---------- downloads ----------
  let downloads: DownloadEntry[] = [];
  const dlMenu = $('dl-menu');
  const dlBadge = $('sb-dl-badge');

  function renderDownloads() {
    const active = downloads.filter((d) => d.state === 'progressing' || d.state === 'paused').length;
    dlBadge.textContent = active ? String(active) : '';
    dlBadge.classList.toggle('hidden', active === 0);
    if (dlMenu.classList.contains('hidden')) return;
    dlMenu.replaceChildren();
    if (!downloads.length) {
      dlMenu.append(el('div', { class: 'menu-item muted' }, 'No downloads yet'));
      return;
    }
    for (const d of downloads) {
      const pct = d.total ? Math.floor((d.received / d.total) * 100) : null;
      const status = d.state === 'progressing' ? (d.paused ? `paused ${pct ?? 0}%` : `${pct ?? 0}%`) : d.state;
      const row = el('div', { class: 'menu-item dl-row', 'data-testid': 'download-row', 'data-dl-id': String(d.id) },
        el('div', { class: 'dl-name', title: d.url }, d.filename),
        el('div', { class: 'dl-meta muted small' },
          `${d.host} · ${status}${d.total ? ` · ${fmtBytes(d.received)}/${fmtBytes(d.total)}` : ''}${d.agentTask ? ' · agent' : ''}`));
      const acts = el('div', { class: 'dl-actions' });
      if (d.state === 'progressing' && !d.paused) acts.append(menuBtn('Pause', () => gb.invoke('downloads:action', d.id, 'pause')));
      if (d.state === 'paused') acts.append(menuBtn('Resume', () => gb.invoke('downloads:action', d.id, 'resume')));
      if (d.state === 'progressing' || d.state === 'paused') acts.append(menuBtn('Cancel', () => gb.invoke('downloads:action', d.id, 'cancel')));
      else acts.append(menuBtn('Remove', () => gb.invoke('downloads:action', d.id, 'remove')));
      row.append(acts);
      dlMenu.append(row);
    }
    dlMenu.append(el('div', { class: 'menu-sep' }), menuBtn('Clear finished', () => gb.invoke('downloads:clear')));
  }

  $('sb-downloads').onclick = (ev) => {
    ev.stopPropagation();
    hideMenus();
    dlMenu.classList.remove('hidden');
    dlMenu.style.left = `${Math.max(8, (ev as MouseEvent).clientX - 200)}px`;
    dlMenu.style.top = `${Math.max(8, (ev as MouseEvent).clientY - 320)}px`;
    renderDownloads();
  };
  gb.on('downloads', (list: DownloadEntry[]) => {
    downloads = list ?? [];
    renderDownloads();
  });

  // ---------- page context menu ----------
  // The menu itself is chrome; the page never renders it. Coordinates come from the page's
  // contextmenu event but are only ever used as numbers, and the items are fixed.
  const pageMenu = $('page-menu');
  function showPageMenu(opts: { x: number; y: number; hasSelection: boolean; canGoBack: boolean; canGoForward: boolean; link: string | null }) {
    hideMenus();
    pageMenu.replaceChildren();
    pageMenu.append(el('div', { class: 'menu-head muted small' }, 'Page'));
    pageMenu.append(menuBtn('Back', () => gb.invoke('nav:back'), !opts.canGoBack));
    pageMenu.append(menuBtn('Forward', () => gb.invoke('nav:forward'), !opts.canGoForward));
    pageMenu.append(menuBtn('Reload', () => gb.invoke('nav:reload')));
    pageMenu.append(menuBtn('Print…', () => gb.invoke('page:print')));
    pageMenu.append(el('div', { class: 'menu-sep' }));
    pageMenu.append(menuBtn('Find in page…', openFind));
    pageMenu.append(menuBtn('Bookmark this page', () => gb.invoke('bookmarks:add-current')));
    pageMenu.append(menuBtn('Copy page address', () => void navigator.clipboard.writeText(currentPageUrl())));
    if (opts.link) {
      pageMenu.append(el('div', { class: 'menu-sep' }));
      pageMenu.append(menuBtn('Copy link address', () => void navigator.clipboard.writeText(opts.link!)));
    }
    if (opts.hasSelection) {
      pageMenu.append(el('div', { class: 'menu-sep' }));
      pageMenu.append(menuBtn('Search for selection', () => {
        const sel = window.getSelection()?.toString() ?? '';
        if (sel) void gb.invoke('nav:go', sel.slice(0, 200));
      }));
    }
    pageMenu.classList.remove('hidden');
    pageMenu.style.left = `${opts.x}px`;
    pageMenu.style.top = `${opts.y}px`;
  }
  gb.on('page:contextmenu', (o: { x: number; y: number; hasSelection: boolean; link: string | null }) => {
    const active = lastTabsState.find((t) => t.active);
    showPageMenu({ ...o, canGoBack: !!active?.canGoBack, canGoForward: !!active?.canGoForward });
  });

  function menuBtn(label: string, fn: () => void, disabled = false): HTMLElement {
    const b = el('button', { class: 'menu-item', 'data-testid': 'menu-item' }, label) as HTMLButtonElement;
    b.disabled = disabled;
    b.onclick = () => {
      hideMenus();
      fn();
    };
    return b;
  }
  function hideMenus() {
    pageMenu.classList.add('hidden');
    dlMenu.classList.add('hidden');
  }
  window.addEventListener('click', hideMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenus();
      if (findOpen && e.target !== findInput) closeFind();
    }
  });

  // ---------- clock + left status text ----------
  function tick() {
    const d = new Date();
    $('sb-clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  tick();
  setInterval(tick, 15_000);

  // ---------- store notices (a profile file was unreadable and was kept aside) ----------
  const notice = $('sb-notice');
  let dismissed = '';
  notice.onclick = () => {
    dismissed = notice.textContent ?? '';
    notice.classList.add('hidden');
  };
  function setNotices(lines: string[]) {
    const text = lines.join(' · ');
    notice.textContent = text;
    notice.title = `${lines.join('\n')}\n(click to dismiss)`;
    notice.classList.toggle('hidden', !text || text === dismissed);
  }

  let lastTabsState: Array<{ active: boolean; url: string; canGoBack: boolean; canGoForward: boolean }> = [];
  function currentPageUrl() {
    return lastTabsState.find((t) => t.active)?.url ?? '';
  }

  return {
    setZoom,
    setNotices,
    openFind,
    closeFind,
    setTabs(t: typeof lastTabsState) {
      lastTabsState = t;
      const a = t.find((x) => x.active);
      let host = '';
      try {
        host = a?.url && a.url !== 'about:blank' ? new URL(a.url).host : '';
      } catch {
        host = '';
      }
      $('sb-left').textContent = host;
    },
    isFindOpen: () => findOpen,
  };
}

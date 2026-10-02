// Start / new-tab page (ticket 13).
//
// DESIGN CHOICE, and it is a security choice: the start page is CHROME, not a page.
// The alternatives were worse:
//   * register a `guarded-browser://` scheme and load it in a tab — that needs a privileged scheme,
//     a preload for that origin and therefore a page -> main IPC channel, i.e. a new reachable
//     surface, and it makes "the agent's tab" sometimes a chrome page.
//   * generate HTML and inject data through it — same problem plus a URL the page (or an injected
//     script) could navigate to with attacker-chosen parameters.
// Rendered as chrome DOM over the page area instead: the tab stays `about:blank` (no content, no
// script, nothing to gate), the agent can only ever navigate it away to a real http(s) page, and
// RULE 4 is satisfied by construction — the agent has no reference to this DOM and cannot see it in
// a snapshot.
//
// The data it shows comes from the chrome's own lists (history, bookmarks) over channels the chrome
// already had. This module invents NO new IPC and reads no page content.

import type { PaletteItem } from '../core/quick-commands';

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

interface HistoryEntry {
  url: string;
  title: string;
  at?: number;
}
interface BookmarkNodeLike {
  type: 'bookmark' | 'folder';
  id: string;
  title: string;
  url?: string;
  speedDial?: boolean;
  children?: BookmarkNodeLike[];
}

const el = (tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
};

/** The URL a top-site click should go to. http(s) only, so the chrome cannot be turned into a
 *  launcher for `file:` / `javascript:` / data: URLs by a crafted history or bookmark entry. */
function safeUrl(u: unknown): string | null {
  const s = String(u ?? '').trim();
  if (!s) return null;
  try {
    const p = new URL(s);
    return p.protocol === 'http:' || p.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/** A host label for a URL, text only (a hostile hostname is shown as its own characters). */
function hostLabel(u: string): string {
  try {
    return new URL(u).host.slice(0, 80);
  } catch {
    return '';
  }
}

/**
 * Top sites from the profile's OWN history: most-visited origins, one entry per origin, in visit
 * order. Deliberately derived from local history only — never from a network service, never from
 * page-reported data.
 */
export function topSites(history: HistoryEntry[], limit = 8): Array<{ url: string; title: string; host: string }> {
  const byOrigin = new Map<string, { url: string; title: string; count: number }>();
  for (const h of history) {
    const url = safeUrl(h.url);
    if (!url) continue;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    const cur = byOrigin.get(origin);
    if (cur) cur.count++;
    else byOrigin.set(origin, { url, title: String(h.title ?? '').slice(0, 120) || hostLabel(url), count: 1 });
  }
  return [...byOrigin.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((s) => ({ url: s.url, title: s.title, host: hostLabel(s.url) }));
}

/** Speed-dial bookmarks (ticket 33's flag) for the start page grid. */
export function speedDial(roots: BookmarkNodeLike[], limit = 12): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const walk = (nodes: BookmarkNodeLike[]) => {
    for (const n of nodes) {
      if (out.length >= limit) return;
      if (n.type === 'folder') {
        if (Array.isArray(n.children)) walk(n.children);
      } else if (n.speedDial) {
        const url = safeUrl(n.url);
        if (url) out.push({ url, title: String(n.title ?? '').slice(0, 120) || hostLabel(url) });
      }
    }
  };
  walk(roots);
  return out;
}

export interface StartUi {
  /** main tells the chrome when the active tab is showing the start page */
  setVisible(on: boolean): void;
  refresh(): void;
}

export function initStart(
  gb: Bridge,
  onOpen: (url: string, newTab: boolean) => void,
): StartUi {
  const box = document.getElementById('startpage') as HTMLElement;
  let visible = false;

  const open = (url: string) => {
    const u = safeUrl(url);
    if (u) onOpen(u, false);
  };

  async function render() {
    if (!visible) return;
    const [hist, bms] = await Promise.all([
      gb.invoke('history:list', '', undefined).catch(() => ({ groups: [] })),
      gb.invoke('bookmarks:tree').catch(() => ({ roots: [] })),
    ]);

    const entries: HistoryEntry[] = [];
    for (const g of hist?.groups ?? []) for (const it of g.items ?? []) entries.push(it);
    const sites = topSites(entries);
    const dial = speedDial((bms?.roots ?? []) as BookmarkNodeLike[]);

    const form = el('form', { class: 'start-search', 'data-testid': 'start-search' });
    const input = el('input', {
      id: 'start-q',
      placeholder: 'Search the web',
      spellcheck: 'false',
      autocomplete: 'off',
      'data-testid': 'start-query',
    }) as HTMLInputElement;
    const go = el('button', { type: 'submit', 'data-testid': 'start-go' }, 'Search');
    form.append(input, go);
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      // search goes through the ordinary navigation path (nav:go), where the configured engine,
      // the reputation check and every gate apply
      void gb.invoke('nav:go', q);
    };

    const grid = el('div', { class: 'start-grid', 'data-testid': 'start-sites' });
    const addTile = (title: string, url: string, host: string) => {
      const a = el(
        'button',
        { class: 'start-tile', 'data-testid': 'start-tile', 'data-url': url, title: url },
        el('span', { class: 'start-tile-title' }, title),
        // the destination is always shown: a title cannot masquerade as another site
        el('span', { class: 'start-tile-host' }, host),
      );
      a.onclick = () => open(url);
      grid.append(a);
    };
    for (const s of dial) addTile(s.title, s.url, hostLabel(s.url));
    for (const s of sites) if (!dial.some((d) => d.url === s.url)) addTile(s.title, s.url, s.host);

    if (!grid.childElementCount) {
      grid.append(el('p', { class: 'muted' }, 'No history or bookmarks yet — the sites you visit will appear here.'));
    }

    const wrap = el('div', { class: 'start-inner' }, form, el('h3', {}, 'Top sites'), grid);
    box.replaceChildren(wrap);
  }

  return {
    setVisible(on: boolean) {
      const changed = on !== visible;
      visible = on;
      box.classList.toggle('hidden', !on);
      // refresh on becoming visible, and never while hidden (no wasted work behind a page)
      if (on && changed) void render();
    },
    refresh() {
      if (visible) void render();
    },
  };
}

// Quick Commands palette (ticket 14). Ctrl+E / F2.
//
// The palette is chrome. It reads the aggregate the runtime builds from lists the chrome already
// owns (commands, tabs, bookmarks, history, sessions, workspaces) — it never reads page content and
// never reaches the agent (RULE 4).
//
// RULE 3, the part that matters here: a bookmark or history title is attacker-influenced text. It is
// inserted as a TEXT NODE, capped, and its destination URL is always shown beside it, so a page whose
// title is "Close tab" cannot look like the real command. The ranking rule lives in
// core/quick-commands.ts and guarantees a command always outranks untrusted text.

import { searchPalette, clampItems, type PaletteItem } from '../core/quick-commands';

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

export interface PaletteUi {
  open(query?: string): void;
  close(): void;
  isOpen(): boolean;
}

export function initPalette(gb: Bridge, run: (item: PaletteItem) => void): PaletteUi {
  const box = document.getElementById('palette') as HTMLElement;
  const input = document.getElementById('palette-q') as HTMLInputElement;
  const list = document.getElementById('palette-list') as HTMLElement;
  let items: PaletteItem[] = [];
  let shown: PaletteItem[] = [];
  let cursor = 0;
  let open = false;

  function paint() {
    list.replaceChildren();
    shown.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = `palette-row${i === cursor ? ' active' : ''}`;
      row.dataset.testid = 'palette-row';
      row.dataset.kind = it.kind;
      row.dataset.id = it.id;
      const t = document.createElement('span');
      t.className = 'palette-title';
      // text, never HTML: a title from a page or a file must not be able to render markup
      t.textContent = it.title;
      row.append(t);
      if (it.subtitle) {
        const s = document.createElement('span');
        s.className = 'palette-sub';
        s.textContent = it.subtitle;
        row.append(s);
      }
      if (it.chord) {
        const c = document.createElement('span');
        c.className = 'palette-chord';
        c.textContent = it.chord;
        row.append(c);
      }
      if (it.untrusted) {
        const u = document.createElement('span');
        u.className = 'palette-untrusted';
        u.title = 'this text came from a page or a file, not from the browser';
        u.textContent = 'page text';
        row.append(u);
      }
      row.onclick = () => {
        close();
        run(it);
      };
      list.append(row);
    });
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = input.value.trim() ? 'No matches.' : 'Type to search commands, tabs, bookmarks and history.';
      list.append(empty);
    }
  }

  async function refresh() {
    const raw = await gb.invoke('commands:search').catch(() => []);
    items = clampItems(Array.isArray(raw) ? raw : []);
    apply();
  }

  function apply() {
    shown = searchPalette(items, input.value);
    cursor = 0;
    paint();
  }

  input.oninput = apply;

  input.onkeydown = (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      cursor = Math.min(cursor + 1, Math.max(0, shown.length - 1));
      paint();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      paint();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const it = shown[cursor];
      if (it) {
        close();
        run(it);
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  };

  function close() {
    open = false;
    box.classList.add('hidden');
    input.value = '';
  }

  return {
    open(query = '') {
      open = true;
      box.classList.remove('hidden');
      input.value = query;
      input.focus();
      void refresh();
    },
    close,
    isOpen: () => open,
  };
}

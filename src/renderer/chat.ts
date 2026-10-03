// AI chat panel (AI capabilities item 2): the chrome side of the per-tab conversation.
//
// Rules this file keeps:
//   * every reply is MODEL OUTPUT conditioned on untrusted page text: it is parsed by
//     core/chat-render.ts and built with textContent — never innerHTML;
//   * a link in a reply shows its URL and opens only on a click, as a new tab through the ordinary
//     `tabs:new` path; nothing opens on its own;
//   * "Do it" copies the USER's message (never the model's words) into the agent's task box. It does
//     not press Run: the user reads, edits and starts the task, which then goes through the normal
//     planner / policy / confirmations.

import { parseInline, parseReply, type InlineToken } from '../core/chat-render';

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'reading' | 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  note?: string;
  pageDerived?: boolean;
  removed?: number;
  guard?: 'scored' | 'not-loaded';
  sources?: Array<{ title: string; url: string }>;
  usedFallback?: boolean;
  endpoint?: string;
  question?: string;
}

interface TabLite { id: number; title: string; url: string; active: boolean }

export function initChat(
  gb: Bridge,
  opts: {
    activeTab: () => number | null;
    /** put text in the agent's task box (focus it; never start the task) */
    prefillTask: (text: string) => void;
  },
) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const k of kids) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };
  const convs = new Map<number, Turn[]>();
  /** tabs the user added with "Include tab…", per chatting tab */
  const included = new Map<number, number[]>();
  let tabs: TabLite[] = [];
  let note = '';

  // ---------- reply rendering (DOM nodes only) ----------
  function inline(tokens: InlineToken[]): Node[] {
    return tokens.map((tk) => {
      if (tk.t === 'text') return document.createTextNode(tk.text);
      if (tk.t === 'bold') return el('strong', {}, tk.text);
      if (tk.t === 'code') return el('code', {}, tk.text);
      // a link: its text AND its URL are visible; only http(s) is clickable, and only on a click
      const same = tk.text === tk.url;
      const span = el('span', { class: `chat-link${tk.clickable ? '' : ' inert'}`, 'data-testid': 'chat-link', 'data-url': tk.url }, same ? tk.url : `${tk.text} `, ...(same ? [] : [el('span', { class: 'chat-url' }, `<${tk.url}>`)]));
      if (tk.clickable) {
        span.setAttribute('role', 'link');
        span.tabIndex = 0;
        span.title = `Open in a new tab: ${tk.url}`;
        const open = () => void gb.invoke('tabs:new', tk.url);
        span.onclick = open;
        span.onkeydown = (e) => {
          if (e.key === 'Enter') open();
        };
      }
      return span;
    });
  }

  function replyBody(text: string): HTMLElement {
    const box = el('div', { class: 'chat-text', 'data-testid': 'chat-text' });
    for (const b of parseReply(text)) {
      if (b.kind === 'code') box.append(el('pre', { class: 'chat-code' }, b.text));
      else if (b.kind === 'row') box.append(el('div', { class: 'chat-row' }, ...inline(parseInline(b.text))));
      else if (b.kind === 'heading') box.append(el('div', { class: 'chat-h' }, ...inline(b.inline)));
      else if (b.kind === 'item') {
        const li = el('div', { class: 'chat-li' }, el('span', { class: 'chat-marker' }, b.marker), el('span', {}, ...inline(b.inline)));
        li.style.marginLeft = `${b.depth * 14}px`;
        box.append(li);
      } else box.append(el('p', {}, ...inline(b.inline)));
    }
    return box;
  }

  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };

  function turnNode(t: Turn): HTMLElement {
    if (t.role === 'user') return el('div', { class: 'chat-turn user', 'data-testid': 'chat-user' }, t.text);
    const node = el('div', { class: `chat-turn assistant ${t.status ?? ''}`, 'data-testid': 'chat-reply', 'data-status': t.status ?? '' });
    const labels = el('div', { class: 'chat-labels' });
    if (t.pageDerived) labels.append(el('span', { class: 'chat-label page', 'data-testid': 'chat-page-derived', title: 'This reply was written with the page text in context. Page text is untrusted.' }, 'page-derived'));
    if (t.usedFallback) labels.append(el('span', { class: 'chat-label cloud', 'data-testid': 'chat-fallback-used' }, `via cloud fallback (${host(t.endpoint ?? '')})`));
    if (labels.childElementCount) node.append(labels);
    if (t.removed) {
      const x = el('button', { class: 'link-inline', 'data-testid': 'chat-xray' }, 'Show in X-ray');
      x.onclick = () => void gb.invoke('xray:scan');
      node.append(el('p', { class: 'chat-warn small', 'data-testid': 'chat-removed' }, `${t.removed} suspicious fragment${t.removed === 1 ? ' was' : 's were'} removed from what the AI saw. `, x));
    } else if (t.guard === 'not-loaded') {
      const x = el('button', { class: 'link-inline', 'data-testid': 'chat-xray' }, 'Open X-ray');
      x.onclick = () => void gb.invoke('xray:scan');
      node.append(el('p', { class: 'chat-warn small', 'data-testid': 'chat-unscreened' }, 'Guard not loaded: the page text was not screened for injections. ', x));
    }
    if (t.text) node.append(replyBody(t.text));
    if (t.status === 'reading') node.append(el('p', { class: 'muted small' }, 'Reading the page…'));
    if (t.status === 'streaming') node.append(el('span', { class: 'chat-cursor', 'aria-hidden': 'true' }, '▍'));
    if (t.status === 'stopped') node.append(el('p', { class: 'muted small', 'data-testid': 'chat-stopped' }, 'Stopped.'));
    if (t.status === 'error') node.append(el('p', { class: 'chat-error small', 'data-testid': 'chat-error' }, `The chat model did not answer: ${t.error ?? 'unknown error'}`));
    if (t.note) node.append(el('p', { class: 'muted small' }, t.note));
    if (t.sources?.length) {
      const src = el('div', { class: 'muted small chat-sources', 'data-testid': 'chat-sources' }, 'Context: ');
      t.sources.forEach((s, i) => src.append(`${i ? '; ' : ''}${s.title || '(untitled)'} — ${s.url}`));
      node.append(src);
    }
    if ((t.status === 'done' || t.status === 'stopped') && t.question) {
      const doIt = el('button', { class: 'small', 'data-testid': 'chat-do-it', title: 'Put YOUR message (not this reply) in the task box, to edit and run yourself' }, 'Do it');
      const q = t.question;
      doIt.onclick = () => {
        opts.prefillTask(q);
        note = 'Your message is in the task box. Edit it, then press Run task — nothing runs until you do.';
        render();
      };
      const copy = el('button', { class: 'small', 'data-testid': 'chat-copy', title: 'Copy this reply as text' }, 'Copy reply');
      const text = t.text;
      copy.onclick = () => void navigator.clipboard.writeText(text).catch(() => undefined);
      node.append(el('div', { class: 'row chat-actions' }, doIt, copy));
    }
    return node;
  }

  // ---------- panel ----------
  function render() {
    const id = opts.activeTab();
    const turns = id === null ? [] : convs.get(id) ?? [];
    const tab = tabs.find((t) => t.id === id);
    $('chat-page').textContent = tab ? `About: ${tab.title || tab.url}` : '';
    const log = $('chat-log');
    log.replaceChildren(...turns.map(turnNode));
    if (!turns.length) log.append(el('p', { class: 'muted small', 'data-testid': 'chat-empty' }, 'Ask about this page: summarise it, explain something, compare it with another tab.'));
    log.scrollTop = log.scrollHeight;
    const streaming = turns.some((t) => t.status === 'reading' || t.status === 'streaming');
    $<HTMLButtonElement>('chat-send').disabled = streaming;
    $<HTMLButtonElement>('chat-stop').disabled = !streaming;
    $('chat-msg').textContent = note;
    // the included tabs, as removable chips
    const inc = $('chat-included');
    inc.replaceChildren();
    for (const tid of id === null ? [] : included.get(id) ?? []) {
      const t = tabs.find((x) => x.id === tid);
      if (!t) continue;
      const rm = el('button', { class: 'chip-x', title: 'Stop including this tab', 'data-testid': 'chat-include-remove' }, '×');
      rm.onclick = () => {
        included.set(id!, (included.get(id!) ?? []).filter((x) => x !== tid));
        render();
      };
      inc.append(el('span', { class: 'chip chat-chip', 'data-testid': 'chat-included-tab', 'data-tab-id': String(tid) }, `+ ${t.title || t.url}`, rm));
    }
  }

  async function refreshIncludeOptions() {
    const sel = $<HTMLSelectElement>('chat-include');
    const list: Array<{ id: number; title: string; url: string }> = await gb.invoke('chat:tabs').catch(() => []);
    sel.replaceChildren(el('option', { value: '' }, list.length ? 'Include tab…' : 'Include tab… (no other web page open)'));
    for (const t of list) sel.append(el('option', { value: String(t.id) }, `${t.title || t.url}`.slice(0, 80)));
  }

  async function refreshState() {
    const s = await gb.invoke('chat:state').catch(() => null);
    if (s && typeof s.tabId === 'number') convs.set(s.tabId, s.turns ?? []);
    const cloud = $('chat-cloud');
    cloud.textContent = s?.fallbackNotice ?? '';
    cloud.classList.toggle('hidden', !s?.fallbackNotice);
    render();
  }

  async function send() {
    const id = opts.activeTab();
    const input = $<HTMLTextAreaElement>('chat-input');
    const text = input.value.trim();
    if (id === null || !text) return;
    note = '';
    const r = await gb.invoke('chat:send', text, included.get(id) ?? []).catch((e) => ({ ok: false, error: String(e) }));
    if (r?.ok) input.value = '';
    else note = r?.error ?? 'could not send';
    render();
  }

  $('chat-send').onclick = () => void send();
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  $('chat-stop').onclick = () => void gb.invoke('chat:stop');
  $('chat-clear').onclick = () => {
    note = '';
    const id = opts.activeTab();
    if (id !== null) included.delete(id);
    void gb.invoke('chat:clear');
  };
  $('chat-include').addEventListener('focus', () => void refreshIncludeOptions());
  $('chat-include').addEventListener('change', () => {
    const sel = $<HTMLSelectElement>('chat-include');
    const id = opts.activeTab();
    const tid = Number(sel.value);
    sel.value = '';
    if (id === null || !Number.isInteger(tid) || tid <= 0) return;
    const list = included.get(id) ?? [];
    if (!list.includes(tid) && list.length < 3) included.set(id, [...list, tid]);
    render();
  });

  // main pushes every change of a conversation (a new turn, streamed text, a clear, a closed tab)
  gb.on('chat', (p: { tabId: number; turns: Turn[]; closed?: boolean }) => {
    if (!p || typeof p.tabId !== 'number') return;
    if (p.closed) {
      convs.delete(p.tabId);
      included.delete(p.tabId);
    } else convs.set(p.tabId, Array.isArray(p.turns) ? p.turns : []);
    if (p.tabId === opts.activeTab()) render();
  });

  return {
    /** the panel became visible */
    shown() {
      note = '';
      void refreshState();
      void refreshIncludeOptions();
      $('chat-input').focus();
    },
    /** the tab list changed: follow the active tab, drop included tabs that are gone */
    tabsChanged(list: TabLite[]) {
      tabs = list;
      if (!document.getElementById('chat-view')?.classList.contains('hidden')) void refreshIncludeOptions();
      const ids = new Set(list.map((t) => t.id));
      for (const [k, v] of included) {
        if (!ids.has(k)) included.delete(k);
        else included.set(k, v.filter((x) => ids.has(x)));
      }
      render();
    },
  };
}

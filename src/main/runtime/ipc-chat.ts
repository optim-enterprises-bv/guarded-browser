// AI chat (AI capabilities item 2): a per-tab conversation with the QUARANTINED chat role.
//
// What this module may do, and nothing else:
//   * read the semantic markdown of the active tab (and of tabs the user explicitly included) in the
//     tab's ISOLATED world (core/markdown.ts);
//   * screen that markdown with the shared guard and drop flagged lines (core/chat.ts);
//   * stream ONE request at a time per tab to the `chat` role's endpoint (or its fallback, under the
//     same settings switch as the other roles) — no tools, no task values (redacted), no mail /
//     history / bookmarks / cookies;
//   * push the conversation to this window's chrome and write one audit event per reply (sizes,
//     screening, endpoint — never the text).
// Conversations live in memory only, per tab, and are forgotten when the tab closes. The chat never
// starts a task: "Do it" is chrome-side and only fills the task box with the USER's message.

import { randomUUID } from 'node:crypto';
import { buildChatMessages, CHAT_LIMITS, screenMarkdown, type ChatPage, type ChatTurn } from '../../core/chat';
import { StreamAbortedError } from '../../core/llm';
import { MARKDOWN_JS, normalizeMdPage, pageMarkdown } from '../../core/markdown';
import { ISOLATED_WORLD } from '../page-scripts';
import type { Handler } from '../runtime';
import type { Tab } from '../tabs';
import type { RuntimeDeps } from './deps';

export interface ChatTurnView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** assistant turns only */
  status?: 'reading' | 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  /** something the user should know about the context (an included tab that could not be read) */
  note?: string;
  /** page text was in this reply's context */
  pageDerived?: boolean;
  /** lines the guard removed from what the model saw */
  removed?: number;
  /** 'not-loaded' = the page text went to the model unscreened */
  guard?: 'scored' | 'not-loaded';
  /** the pages this reply was given (title + URL, shown as text) */
  sources?: Array<{ title: string; url: string }>;
  usedFallback?: boolean;
  endpoint?: string;
  /** the user message this reply answers: what "Do it" copies into the task box */
  question?: string;
}

interface Conversation {
  turns: ChatTurnView[];
  abort: AbortController | null;
}

const MAX_TURNS = 60;
const READ_TIMEOUT_MS = 8_000;
const readable = (url: string) => /^(https?|file):/i.test(url);

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const convs = new Map<number, Conversation>();
  const push = (tabId: number) => rt.sendUI('chat', { tabId, turns: convs.get(tabId)?.turns ?? [] });

  /** the chat's fallback switch, for the panel's "sends page text to the provider" notice */
  const fallbackNotice = () => {
    const fb = rt.settings.models.chat.fallback;
    if (!fb.enabled) return null;
    let host = fb.baseURL;
    try {
      host = new URL(fb.baseURL).host;
    } catch {
      /* shown as typed */
    }
    return `Cloud fallback is ON for chat: when the local model is unreachable, the page text and your messages are sent to ${host}.`;
  };

  async function readTab(t: Tab, maxChars: number): Promise<{ page: ChatPage; hiddenDropped: number } | { error: string }> {
    const url = t.wc.isDestroyed() ? '' : t.wc.getURL();
    if (!readable(url)) return { error: 'not a web page' };
    if (rt.tabs.isHibernated(t.id)) return { error: 'the tab is hibernated' };
    let raw: unknown;
    try {
      raw = await Promise.race([
        t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: MARKDOWN_JS }]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('the page did not answer in time')), READ_TIMEOUT_MS)),
      ]);
    } catch (e) {
      return { error: `could not read the page: ${(e as Error).message.slice(0, 120)}` };
    }
    const md = pageMarkdown(normalizeMdPage(raw), maxChars);
    const s = await screenMarkdown(rt.ctx.guard, md.markdown);
    return {
      page: { title: t.wc.getTitle(), url, markdown: s.markdown, removed: s.removed, screened: s.guard.state === 'scored' },
      hiddenDropped: md.hiddenDropped,
    };
  }

  /** the running task's sensitive values (task secrets, emails, phone / card numbers): never sent to chat */
  const taskSecrets = () => (rt.current ? rt.current.task.taint.all().filter((v) => v.kind === 'user-sensitive').map((v) => v.value) : []);

  async function answer(tabId: number, conv: Conversation, reply: ChatTurnView, message: string, history: ChatTurn[], include: number[], ctl: AbortController) {
    const t = rt.tabs.byId(tabId);
    const update = (patch: Partial<ChatTurnView>) => {
      Object.assign(reply, patch);
      if (convs.get(tabId) === conv) push(tabId);
    };
    try {
      const pages: ChatPage[] = [];
      let hiddenDropped = 0;
      const sources: Array<{ title: string; url: string }> = [];
      const notes: string[] = [];
      const targets = [t, ...include.map((id) => rt.tabs.byId(id))];
      for (let i = 0; i < targets.length; i++) {
        const tab = targets[i];
        if (!tab) continue;
        const r = await readTab(tab, i === 0 ? CHAT_LIMITS.currentPage : CHAT_LIMITS.includedPage);
        if ('error' in r) {
          if (i > 0) notes.push(`an included tab could not be read (${r.error})`);
          continue;
        }
        hiddenDropped += r.hiddenDropped;
        pages.push(r.page);
        sources.push({ title: r.page.title, url: r.page.url });
      }
      if (ctl.signal.aborted) throw new StreamAbortedError('');
      const withText = pages.filter((p) => p.markdown.trim());
      const removed = pages.reduce((n, p) => n + p.removed, 0);
      const unscreened = withText.some((p) => !p.screened);
      const messages = buildChatMessages({ pages, history, message, redact: taskSecrets() });
      update({ status: 'streaming', pageDerived: withText.length > 0, removed, guard: withText.length ? (unscreened ? 'not-loaded' : 'scored') : undefined, sources, ...(notes.length ? { note: notes.join('; ') } : {}) });
      let pending = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flushDeltas = () => {
        timer = null;
        if (!pending) return;
        reply.text += pending;
        pending = '';
        if (convs.get(tabId) === conv) push(tabId);
      };
      const r = await rt
        .chatClient()
        .stream({ messages, maxTokens: CHAT_LIMITS.maxTokens }, (d) => {
          pending += d;
          timer ??= setTimeout(flushDeltas, 40);
        }, ctl.signal)
        .finally(() => {
          if (timer) clearTimeout(timer);
          flushDeltas();
        });
      update({ status: 'done', text: r.text, usedFallback: r.usedFallback, endpoint: r.endpoint });
      rt.audit.write('chat', { tabId, urls: sources.map((s) => s.url), pageChars: pages.reduce((n, p) => n + p.markdown.length, 0), hiddenDropped, removed, screened: !unscreened, replyChars: r.text.length, usedFallback: r.usedFallback, endpoint: r.endpoint });
    } catch (e) {
      if (e instanceof StreamAbortedError || ctl.signal.aborted) update({ status: 'stopped' });
      else update({ status: 'error', error: (e as Error).message.slice(0, 400) });
    } finally {
      if (conv.abort === ctl) conv.abort = null;
    }
  }

  on('chat:state', () => {
    const t = rt.tabs.active();
    return { tabId: t?.id ?? null, turns: t ? convs.get(t.id)?.turns ?? [] : [], streaming: t ? !!convs.get(t.id)?.abort : false, fallbackNotice: fallbackNotice() };
  });

  on('chat:send', (_e, text: unknown, includeIds: unknown) => {
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    const message = String(text ?? '').trim();
    if (!message) return { ok: false, error: 'type a message first' };
    if (message.length > CHAT_LIMITS.message) return { ok: false, error: `messages are limited to ${CHAT_LIMITS.message} characters` };
    let conv = convs.get(t.id);
    if (!conv) {
      conv = { turns: [], abort: null };
      convs.set(t.id, conv);
    }
    if (conv.abort) return { ok: false, error: 'a reply is still streaming: press Stop first' };
    // only tabs the user picked, never the agent's hidden state; each at most once
    const include = [...new Set((Array.isArray(includeIds) ? includeIds : []).map(Number))]
      .filter((id) => Number.isInteger(id) && id !== t.id && !!rt.tabs.byId(id) && !rt.tabs.isPanel(id))
      .slice(0, CHAT_LIMITS.maxIncluded);
    // earlier turns: what the user typed and what the chat replied (finished or stopped), nothing else
    const history: ChatTurn[] = conv.turns.filter((x) => x.text.trim() && (x.role === 'user' || x.status === 'done' || x.status === 'stopped')).map((x) => ({ role: x.role, content: x.text }));
    const user: ChatTurnView = { id: randomUUID().slice(0, 8), role: 'user', text: message };
    const reply: ChatTurnView = { id: randomUUID().slice(0, 8), role: 'assistant', text: '', status: 'reading', question: message };
    conv.turns.push(user, reply);
    if (conv.turns.length > MAX_TURNS) conv.turns.splice(0, conv.turns.length - MAX_TURNS);
    const ctl = new AbortController();
    conv.abort = ctl;
    push(t.id);
    void answer(t.id, conv, reply, message, history, include, ctl);
    return { ok: true, id: reply.id };
  });

  on('chat:stop', () => {
    const t = rt.tabs.active();
    const conv = t ? convs.get(t.id) : undefined;
    conv?.abort?.abort();
    return { ok: true };
  });

  on('chat:clear', () => {
    const t = rt.tabs.active();
    if (!t) return { ok: false };
    convs.get(t.id)?.abort?.abort();
    convs.delete(t.id);
    push(t.id);
    return { ok: true };
  });

  /** other tabs the user may add with "Include tab…" (title + URL; web pages only) */
  on('chat:tabs', () => {
    const active = rt.tabs.active()?.id;
    return rt.tabs
      .list()
      .filter((x) => x.id !== active && readable(x.url))
      .map((x) => ({ id: x.id, title: x.title, url: x.url }));
  });

  return {
    /** the tab is gone: its conversation (and any stream) goes with it */
    forget(id: number) {
      const conv = convs.get(id);
      if (!conv) return;
      conv.abort?.abort();
      convs.delete(id);
      rt.sendUI('chat', { tabId: id, turns: [], closed: true });
    },
  };
}

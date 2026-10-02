// Chrome IPC: history, bookmarks (and the bookmarks panel extras), suggestions, saved sessions and
// workspaces. Chrome-side private data only: the agent never reaches these stores.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import { BAR_ID, OTHER_ID, type ParsedImport } from '../../core/bookmarks';
import { SortModeSchema, sortTree } from '../../core/bookmarks-panel';
import { Worker } from 'node:worker_threads';
import { dialog } from 'electron';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { originOf } from '../../core/policy';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { saveSettings } from '../../core/config';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const { bookmarkTrash, bookmarks, closeTab, downloads, faviconCache, history, liftGateOnCommit, saveSessionSoon, savedSessions, sendUI, settingsFile, workspaces } = rt;
  // ---------- history & bookmarks: chrome UI only ----------
  const libraryChanged = () => sendUI('bookmarks', { roots: bookmarks.tree(), showBar: bookmarks.showBar });
  /** open through the normal navigation path: reputation, proxy and every gate apply */
  const openUrl = (url: string, newTab: boolean) => {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs' };
    if (newTab) {
      const t = rt.tabs.create(url);
      t.navSource = 'user';
    } else {
      const t = rt.tabs.active();
      if (!t) return { ok: false };
      if (!rt.current) liftGateOnCommit(t);
      t.navSource = 'user';
      void t.wc.loadURL(url).catch(() => undefined);
    }
    return { ok: true };
  };
  const wrap = <T>(fn: () => T) => {
    try {
      const r = fn();
      libraryChanged();
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  };
  /** Parse in a worker with a time budget; only the (re-validated) result touches the store. */
  const importInWorker = (html: string, folder: string) =>
    new Promise<{ ok: boolean; error?: string; result?: unknown }>((resolve) => {
      if (html.length > 5 * 1024 * 1024) return resolve({ ok: false, error: 'bookmark file larger than 5 MB' });
      const w = new Worker(join(__dirname, 'import-worker.js'), { workerData: { html } });
      const timer = setTimeout(() => {
        void w.terminate();
        resolve({ ok: false, error: 'import took too long and was stopped' });
      }, 5000);
      w.once('message', (m: { ok: boolean; parsed?: ParsedImport; error?: string }) => {
        clearTimeout(timer);
        void w.terminate();
        if (!m.ok || !m.parsed) return resolve({ ok: false, error: m.error ?? 'import failed' });
        resolve(wrap(() => bookmarks.importParsed(m.parsed!, folder)));
      });
      w.once('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: (e as Error).message.slice(0, 200) });
      });
    });
  const RANGES = new Set(['hour', 'day', 'week', 'all']);
  const SOURCES = new Set(['user', 'page', 'agent']);
  on('history:list', (_e, q: unknown, source: unknown) => ({
    groups: history.grouped(String(q ?? '').slice(0, 200), SOURCES.has(String(source)) ? (String(source) as 'user') : undefined),
    clearOnExit: history.clearOnExit,
  }));
  on('history:delete', (_e, url: unknown) => ({ ok: true, removed: history.deleteUrl(String(url)) }));
  on('history:delete-range', (_e, range: unknown) => (RANGES.has(String(range)) ? { ok: true, removed: history.deleteRange(String(range) as 'all') } : { ok: false }));
  on('history:clear-on-exit', (_e, v: unknown) => {
    history.setClearOnExit(v === true);
    return { ok: true };
  });
  on('history:open', (_e, url: unknown, newTab: unknown) => openUrl(String(url), newTab === true));
  on('bookmarks:tree', () => ({ roots: bookmarks.tree(), showBar: bookmarks.showBar }));
  on('bookmarks:add', async (_e, parent: unknown, title: unknown, url: unknown, nickname: unknown) =>
    (await nicknameResolves(nickname))
      ? { ok: false, error: `"${String(nickname)}" resolves as a host name on this network; choose another nickname` }
      : wrap(() => bookmarks.addBookmark(String(parent ?? BAR_ID), String(title ?? ''), String(url ?? ''), nickname ? String(nickname) : undefined)),
  );
  on('bookmarks:add-current', () => {
    const t = rt.tabs.active();
    const url = t?.wc.getURL() ?? '';
    const existing = bookmarks.isBookmarked(url);
    if (existing) return { ok: true, result: { id: existing, existed: true } };
    return wrap(() => bookmarks.addBookmark(BAR_ID, t?.wc.getTitle() ?? url, url));
  });
  on('bookmarks:add-folder', (_e, parent: unknown, title: unknown) => wrap(() => bookmarks.addFolder(String(parent ?? OTHER_ID), String(title ?? ''))));
  /** a nickname must not be a word that resolves as a host on this network (e.g. an intranet name) */
  const nicknameResolves = async (nick: unknown): Promise<boolean> => {
    if (typeof nick !== 'string' || !nick) return false;
    try {
      await Promise.race([lookup(nick), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 500))]);
      return true;
    } catch {
      return false;
    }
  };
  on('bookmarks:update', async (_e, id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>;
    if (await nicknameResolves(p.nickname)) return { ok: false, error: `"${String(p.nickname)}" resolves as a host name on this network; choose another nickname` };
    return wrap(() =>
      bookmarks.update(String(id), {
        ...(p.title !== undefined ? { title: String(p.title) } : {}),
        ...(p.url !== undefined ? { url: String(p.url) } : {}),
        ...(p.nickname !== undefined ? { nickname: p.nickname === null || p.nickname === '' ? null : String(p.nickname) } : {}),
      }),
    );
  });
  on('bookmarks:remove', (_e, id: unknown) => wrap(() => bookmarks.remove(String(id))));
  on('bookmarks:move', (_e, id: unknown, parent: unknown, index: unknown) => wrap(() => bookmarks.move(String(id), String(parent), Number(index))));
  on('bookmarks:search', (_e, q: unknown) => bookmarks.search(String(q ?? '').slice(0, 200)));
  on('bookmarks:set-bar', (_e, v: unknown) => wrap(() => bookmarks.setShowBar(v === true)));
  on('bookmarks:is-bookmarked', () => bookmarks.isBookmarked(rt.tabs.active()?.wc.getURL() ?? ''));
  on('bookmarks:open', (_e, id: unknown, newTab: unknown) => {
    const b = bookmarks.all().find((x) => x.id === String(id));
    return b ? openUrl(b.url, newTab === true) : { ok: false, error: 'no such bookmark' };
  });
  on('bookmarks:import', async (_e, html: unknown, folder: unknown) => {
    if (typeof html !== 'string') return { ok: false, error: 'expected text' };
    return importInWorker(html, folder ? String(folder) : 'Imported');
  });
  on('bookmarks:import-file', async () => {
    const r = await dialog.showOpenDialog(rt.win, { title: 'Import bookmarks (HTML)', filters: [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(r.filePaths[0]).size > 5 * 1024 * 1024) return { ok: false, error: 'file larger than 5 MB' };
    return importInWorker(readFileSync(r.filePaths[0], 'utf8'), 'Imported');
  });
  on('bookmarks:export', () => bookmarks.exportNetscape());
  on('bookmarks:export-file', async () => {
    const r = await dialog.showSaveDialog(rt.win, { title: 'Export bookmarks', defaultPath: 'bookmarks.html' });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    writeFileSync(r.filePath, bookmarks.exportNetscape());
    return { ok: true };
  });
  on('suggest', (_e, q: unknown) => {
    const query = String(q ?? '').slice(0, 200);
    const nick = bookmarks.byNickname(query);
    const bms = bookmarks.search(query, 5);
    return {
      bookmarks: (nick ? [nick, ...bms.filter((b) => b.id !== nick.id)] : bms).slice(0, 5).map((b) => ({ title: b.title, url: b.url, nickname: b.nickname })),
      history: history.suggest(query, 5).map((h) => ({ title: h.title, url: h.url })),
    };
  });
  on('favicon:get', (_e, url: unknown) => {
    const o = originOf(String(url ?? ''));
    return o ? faviconCache.get(o) ?? null : null;
  });
  // ---------- 17/18: panels ----------
  on('panel:refresh', (_e, which: unknown) => {
    if (which === 'history') sendUI('history', { groups: history.grouped('', undefined), clearOnExit: history.clearOnExit });
    if (which === 'bookmarks') libraryChanged();
    if (which === 'downloads') sendUI('downloads', downloads.list());
    return { ok: true };
  });
  // ---------- 20: workspaces ----------
  on('workspaces:list', () => ({ workspaces: workspaces.list(), activeId: workspaces.activeId }));
  on('workspaces:create', (_e, name: unknown, colorIndex: unknown) => {
    const r = workspaces.create(String(name ?? ''), Number(colorIndex) || 0);
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    return r;
  });
  on('workspaces:rename', (_e, id: unknown, name: unknown) => {
    const ok = workspaces.rename(String(id), String(name ?? ''));
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    return { ok };
  });
  on('workspaces:delete', (_e, id: unknown) => {
    const r = workspaces.remove(String(id));
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    return r;
  });
  /**
   * Switching workspaces is REFUSED while an agent task runs. The agent's tab belongs to the
   * workspace the task started in; letting a switch hide it would make the security UI describe a
   * state that is no longer on screen (the same reasoning as "untile shows the agent's tab").
   */
  on('workspaces:switch', (_e, id: unknown) => {
    if (rt.current) return { ok: false, error: 'a workspace cannot be switched while an agent task is running: the agent tab would leave the screen' };
    const currentTabs = rt.tabs.list().map((t) => ({ url: t.url, title: t.title }));
    const r = workspaces.switchTo(String(id), currentTabs);
    if (!r.ok) return r;
    // open the target workspace's tabs: close the non-agent tabs, then create the saved set
    const keep = rt.tabs.agentTab;
    for (const t of rt.tabs.list()) if (t.id !== keep) closeTab(t.id);
    for (const x of r.tabs) {
      const t = rt.tabs.create(x.url);
      t.navSource = 'user';
    }
    // Only fall back to a blank tab when the switch genuinely left nothing on screen. A workspace
    // with no saved tabs used to add a blank ON TOP of the tab that was already there.
    if (!rt.tabs.list().length) {
      const t = rt.tabs.create('about:blank');
      t.navSource = 'user';
    }
    saveSessionSoon();
    sendUI('workspaces', { workspaces: workspaces.list(), activeId: workspaces.activeId });
    void rt.tabs.layout();
    return { ok: true };
  });

  // ---------- 22: saved sessions ----------
  on('sessions:list', () => ({ sessions: savedSessions.list() }));
  on('sessions:save', (_e, name: unknown) => {
    const list = rt.tabs.list().map((t) => ({ url: t.url, title: t.title }));
    const r = savedSessions.save(String(name ?? ''), list);
    sendUI('sessions', { sessions: savedSessions.list() });
    return r;
  });
  on('sessions:restore', (_e, id: unknown) => {
    const r = savedSessions.restorableTabs(String(id));
    if (!r.length) return { ok: false, error: 'that session has no restorable tabs' };
    const created: number[] = [];
    for (const t of r) {
      const tab = rt.tabs.create(t.url);
      // a restored session's tabs start CLEAN: navSource 'user' records history as a user action,
      // and there is no gate state to resurrect because none is stored
      tab.navSource = 'user';
      created.push(tab.id);
    }
    saveSessionSoon();
    return { ok: true, opened: created.length };
  });
  on('sessions:rename', (_e, id: unknown, name: unknown) => {
    const ok = savedSessions.rename(String(id), String(name ?? ''));
    sendUI('sessions', { sessions: savedSessions.list() });
    return { ok };
  });
  on('sessions:delete', (_e, id: unknown) => {
    const ok = savedSessions.remove(String(id));
    sendUI('sessions', { sessions: savedSessions.list() });
    return { ok };
  });
  on('sessions:export', () => savedSessions.toJson());

  // ---------- 33: bookmarks panel extras ----------
  on('bookmarks:set-description', (_e, id: unknown, text: unknown) => wrap(() => bookmarks.update(String(id), { description: String(text ?? '').slice(0, 2000) })));
  on('bookmarks:set-speeddial', (_e, id: unknown, on: unknown) => wrap(() => bookmarks.update(String(id), { speedDial: on === true })));
  on('bookmarks:sort', (_e, mode: unknown) => {
    const r = SortModeSchema.safeParse(mode);
    if (!r.success) return { ok: false, error: 'unknown sort mode' };
    rt.bookmarkSort = r.data;
    saveSettings(settingsFile, rt.settings);
    return { ok: true, mode: rt.bookmarkSort, tree: sortTree(bookmarks.tree(), rt.bookmarkSort) };
  });
  on('bookmarks:tree-sorted', () => ({ roots: sortTree(bookmarks.tree(), rt.bookmarkSort), showBar: bookmarks.showBar, sort: rt.bookmarkSort }));
  on('bookmarks:trash', () => ({ entries: bookmarkTrash.list().map((e) => ({ id: e.node.id, title: e.node.title, type: e.node.type, deletedAt: e.deletedAt })), count: bookmarkTrash.count() }));
  on('bookmarks:trash-restore', (_e, id: unknown) => {
    const e = bookmarkTrash.get(String(id));
    if (!e) return { ok: false, error: 'not in the trash' };
    const parent = bookmarks.tree().find((f) => f.id === e.parentId) ?? bookmarks.tree()[0];
    bookmarkTrash.remove(e.node.id);
    // restore through the ordinary add path so the store's own validation still applies
    const n = e.node;
    if (n.type === 'bookmark') return wrap(() => bookmarks.addBookmark(parent.id, n.title, n.url));
    return wrap(() => bookmarks.addFolder(parent.id, e.node.title));
  });
  on('bookmarks:trash-empty', (_e, confirm: unknown) => {
    const r = bookmarkTrash.empty(confirm === true);
    rt.audit.write('bundle', { taskId: rt.current?.task.id, action: 'empty bookmarks trash', wouldDiscard: r.wouldDiscard, ok: r.ok });
    return r;
  });
}

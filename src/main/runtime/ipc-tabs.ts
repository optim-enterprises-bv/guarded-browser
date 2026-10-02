// Chrome IPC: tabs, navigation, tiles, zoom, find, print, downloads, panels, stacks and hibernation.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import { HibernationSettingsSchema } from '../../core/hibernation';
import { MAX_WEB_PANELS, saveSettings } from '../../core/config';
import type { TileLayout } from '../tile-layout';
import type { WebContents } from 'electron';
import { clampZoom, stepZoom } from '../../core/zoom';
import { join } from 'node:path';
import { originOf } from '../../core/policy';
import { searchUrl } from '../../core/search';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const { bookmarks, closeTab, closedTabs, downloads, hibernationSweep, lastFindQuery, liftGateOnCommit, openPanel, panelState, printTab, profileDir, reopenClosed, runChord, saveSessionSoon, scheduleHibernation, sendUI, sessionState, settingsFile, stacks, state, updateSiteAccent, zoom } = rt;
  on('state:get', () => state());
  on('tabs:new', (_e, url?: string) => {
    const t = rt.tabs.create(url || 'about:blank');
    t.navSource = 'user';
    return t.id;
  });
  on('tabs:close', (_e, id: number) => closeTab(Number(id)));
  on('tabs:reopen', () => reopenClosed());
  on('tabs:closed-list', () => closedTabs.list());
  /**
   * The active tab's security state, for the chrome UI and for tests. Read-only, and it reports
   * booleans and origins rather than granting any capability.
   */
  on('tabs:guard-state', () => {
    const t = rt.tabs.active();
    if (!t) return { gated: false, origins: [], agentTab: false, taskRunning: !!rt.current };
    const s = rt.tabs.guardStateOf(t.id);
    return { gated: s?.gate === 'post-task', origins: s?.gateOrigins ?? [], agentTab: s?.agentTab ?? false, taskRunning: !!rt.current };
  });
  on('tabs:activate', (_e, id: number) => {
    rt.tabs.activate(Number(id));
    rt.tabs.noteActivated(Number(id));
    saveSessionSoon();
    void updateSiteAccent();
  });
  on('tabs:move', (_e, id: unknown, to: unknown) => {
    const order = rt.tabs.move(Number(id), Number(to));
    saveSessionSoon();
    return order;
  });
  on('tabs:duplicate', (_e, id: unknown) => {
    const target = id === undefined || id === null ? rt.tabs.active()?.id : Number(id);
    const t = rt.tabs.duplicate(target ?? -1);
    saveSessionSoon();
    return t?.id ?? null;
  });
  on('tabs:close-others', (_e, id: unknown) => {
    const n = rt.tabs.closeOthers(Number(id), !!rt.current);
    saveSessionSoon();
    return n;
  });
  on('tabs:close-right', (_e, id: unknown) => {
    const n = rt.tabs.closeRight(Number(id), !!rt.current);
    saveSessionSoon();
    return n;
  });
  on('tabs:mute', (_e, id: unknown, muted: unknown) => {
    const wasMuted = rt.tabs.byId(Number(id))?.wc.isAudioMuted() ?? false;
    rt.tabs.setAudioMuted(Number(id), typeof muted === 'boolean' ? muted : !wasMuted);
    sendUI('tabs', rt.tabs.list());
  });

  // ---------- zoom (view property; per origin) ----------
  on('zoom:get', () => {
    const t = rt.tabs.active();
    if (!t) return { factor: 1, origin: null };
    return { factor: t.wc.getZoomFactor(), origin: originOf(t.wc.getURL()) };
  });
  on('zoom:set', (_e, factor: unknown) => {
    const t = rt.tabs.active();
    if (!t) return { factor: 1 };
    const f = clampZoom(Number(factor) || 1);
    t.wc.setZoomFactor(f);
    const o = originOf(t.wc.getURL());
    if (o) zoom.set(o, f);
    sendUI('zoom', { tab: t.id, factor: f });
    return { factor: f };
  });
  on('zoom:step', (_e, dir: unknown) => {
    const t = rt.tabs.active();
    if (!t) return { factor: 1 };
    const f = stepZoom(t.wc.getZoomFactor(), Number(dir) === 1 ? 1 : -1);
    t.wc.setZoomFactor(f);
    const o = originOf(t.wc.getURL());
    if (o) zoom.set(o, f);
    sendUI('zoom', { tab: t.id, factor: f });
    return { factor: f };
  });
  on('zoom:reset', () => {
    const t = rt.tabs.active();
    if (!t) return { factor: 1 };
    t.wc.setZoomFactor(1);
    const o = originOf(t.wc.getURL());
    if (o) zoom.clear(o);
    sendUI('zoom', { tab: t.id, factor: 1 });
    return { factor: 1 };
  });

  // ---------- find in page (Chromium reports counts, never content) ----------
  on('find:start', (_e, query: unknown, opts: unknown) => {
    const t = rt.tabs.active();
    if (!t) return { requestId: 0 };
    const q = String(query ?? '').slice(0, 200);
    const o = (opts ?? {}) as { forward?: boolean; findNext?: boolean; matchCase?: boolean };
    const prev = lastFindQuery.get(t.id);
    lastFindQuery.set(t.id, q);
    if (!q) {
      rt.tabs.stopFind(t.id);
      return { requestId: 0, cleared: true };
    }
    // The FIRST request of a find session must carry findNext:true (Electron's own docs); only
    // repeat requests within the same query use findNext:false. A fresh query resets the session.
    const freshQuery = prev !== q;
    const rid = rt.tabs.findInPage(t.id, q, { ...o, findNext: freshQuery ? true : o.findNext === true });
    return { requestId: rid };
  });
  on('find:stop', () => {
    const t = rt.tabs.active();
    if (t) rt.tabs.stopFind(t.id, 'clearSelection');
  });

  // ---------- print (chrome-initiated only) ----------
  on('page:print', async () => {
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    return { ok: await printTab(t) };
  });

  // ---------- downloads panel (observes the transfer; never decides) ----------
  on('downloads:list', () => downloads.list());
  on('downloads:action', (_e, id: unknown, what: unknown) => downloads.action(Number(id), String(what) as 'pause' | 'resume' | 'cancel' | 'remove'));
  on('downloads:clear', () => {
    downloads.clearFinished();
    return downloads.list();
  });

  // ---------- session restore ----------
  on('session:info', () => {
    const r = sessionState.restorableTabs();
    return { tabs: r.tabs, activeIndex: r.activeIndex, crashed: sessionState.crashed, startup: rt.settings.general.startup };
  });
  on('tabs:select', (_e, id: number, on?: boolean) => rt.tabs.toggleSelected(Number(id), typeof on === 'boolean' ? on : undefined));
  const LAYOUTS = new Set(['columns', 'rows', 'grid']);
  const layoutArg = (l: unknown): TileLayout => (LAYOUTS.has(String(l)) ? (String(l) as TileLayout) : 'columns');
  on('tiles:tile', (_e, ids: unknown, layout: unknown) => rt.tabs.tile(Array.isArray(ids) ? ids.map(Number) : undefined, layoutArg(layout)));
  on('tiles:untile', () => rt.tabs.untile());
  on('tiles:layout', (_e, layout: unknown) => rt.tabs.setTileLayout(layoutArg(layout)));
  on('tiles:drag', (_e, phase: unknown, key: unknown, at: unknown) => {
    if (phase === 'start') rt.tabs.setDragging(true);
    else if (phase === 'move' && typeof key === 'string' && /^(col|row|c\d|r\d)$/.test(key)) rt.tabs.dragDivider(key as never, Number(at));
    else if (phase === 'end') rt.tabs.setDragging(false);
  });
  on('tiles:state', () => rt.tabs.tileState());
  on('nav:go', (_e, input: string) => {
    const t = rt.tabs.active();
    if (!t) return;
    if (!rt.current) liftGateOnCommit(t); // the user took the tab back (lifted when the load commits)
    t.navSource = 'user';
    let url = input.trim();
    const nick = bookmarks.byNickname(url);
    if (nick) url = nick.url; // a bookmark nickname typed in the address bar
    else if (!/^[a-z]+:/i.test(url)) url = /^[\w.-]+(:\d+)?(\/|$)/.test(url) ? `http://${url}` : searchUrl(url, rt.settings.general.search);
    void t.wc.loadURL(url).catch(() => undefined);
  });

  on('chrome:insets', (_e, top: unknown, left: unknown, bottom: unknown) => {
    const t = Math.max(0, Math.min(400, Math.round(Number(top) || 0)));
    // Bounded by the window's own width (in setInsets), NOT by a fixed 600: the mail panel covers
    // the whole page area and asks for the full width, and a 600 cap left a live page view drawn
    // on top of the mail panel (a see-through hole on a transparent about:blank).
    const l = Math.max(0, Math.min(16_384, Math.round(Number(left) || 0)));
    const b = Math.max(0, Math.min(200, Math.round(Number(bottom) || 0)));
    rt.tabs.setInsets(t, l, b);
  });
  on('chrome:overlay', (_e, on: unknown) => rt.tabs.setOverlay(on === true));
  // The chrome window's own keydown handler forwards keystrokes here, so the chord table applies
  // whether a page or the chrome has focus. Only a key event is accepted; the payload is a plain
  // description, never anything page-derived.
  on('chord', (_e, key: unknown, mods: unknown) => {
    const m = (mods ?? {}) as { ctrl?: boolean; shift?: boolean; alt?: boolean };
    if (typeof key !== 'string' || key.length > 32) return { handled: false };
    return { handled: runChord({ key, control: m.ctrl === true, shift: m.shift === true, alt: m.alt === true, type: 'keyDown' }) };
  });
  const userNav = (fn: (wc: WebContents) => void) => {
    const t = rt.tabs.active();
    if (!t) return;
    if (!rt.current) liftGateOnCommit(t);
    t.navSource = 'user';
    fn(t.wc);
  };
  on('nav:back', () => userNav((wc) => wc.navigationHistory.goBack()));
  on('nav:forward', () => userNav((wc) => wc.navigationHistory.goForward()));
  on('nav:reload', () => userNav((wc) => wc.reload()));
  // The renderer asks for this on boot, and boot happens BEFORE `tabs` exists (the UI is loaded
  // first so the window paints early). So this must not assume a TabManager; the real geometry is
  // pushed by sendUI('geometry') once there is one.
  on('panels:state', () => ({
    railVisible: rt.settings.general.railVisible,
    statusBar: rt.settings.general.statusBar,
    tabStrip: rt.settings.general.tabStrip,
    inset: rt.tabs?.insets() ?? { top: 0, left: 0, bottom: 0 },
  }));

  // ---------- 18: web panels ----------
  // A panel is a website pinned into the sidebar. It is NOT a strip tab, it is never `active()`, and
  // `setAgentTab` refuses a panel id — so a panel cannot become the agent's tab and cannot be an
  // escape hatch around a task's allowlist. Its requests still pass through the same session, proxy,
  // host allowlist, reputation feed and webRequest content filter as any tab.

  on('panels:list', () => panelState());
  /** the chrome reports where the sidebar column landed; panels are drawn exactly there */
  on('panels:rect', (_e, r: unknown) => {
    const o = (r ?? null) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (!o) {
      rt.tabs.setPanelRect(null);
      return { ok: true };
    }
    rt.tabs.setPanelRect({
      x: Math.max(0, Math.round(Number(o.x) || 0)),
      y: Math.max(0, Math.round(Number(o.y) || 0)),
      width: Math.max(0, Math.round(Number(o.width) || 0)),
      height: Math.max(0, Math.round(Number(o.height) || 0)),
    });
    return { ok: true };
  });
  /** show a panel in the column (or none). Only http(s) URLs can ever be shown. */
  on('panels:show', (_e, url: unknown) => {
    const u = url === null ? null : String(url ?? '');
    if (u !== null && !rt.tabs.panelList().some((t) => (t.intendedUrl || t.wc.getURL()) === u)) return { ok: false, error: 'no such panel' };
    rt.tabs.setPanelShown(u);
    return { ok: true };
  });
  /** pin the active tab into the sidebar AND show it immediately */
  on('panels:show-view', (_e, id: unknown) => {
    const t = rt.tabs.panelList().find((x) => x.id === Number(id));
    if (!t) return { ok: false, error: 'no such panel' };
    rt.tabs.setPanelShown(t.intendedUrl || t.wc.getURL());
    return { ok: true };
  });
  on('panels:add', (_e, url: unknown) => {
    const u = String(url ?? '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'a panel must be an http(s) site' };
    if (rt.settings.general.webPanels.length >= MAX_WEB_PANELS) return { ok: false, error: `no more than ${MAX_WEB_PANELS} panels` };
    if (!rt.settings.general.webPanels.some((p) => p.url === u)) {
      rt.settings.general.webPanels.push({ url: u.slice(0, 2048), title: '' });
      saveSettings(settingsFile, rt.settings);
    }
    const r = openPanel(u);
    if (r.ok) sendUI('panels:list', panelState());
    return r;
  });
  on('panels:open-current', () => {
    const t = rt.tabs.active();
    const u = t?.wc.getURL() ?? '';
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'the active tab is not an http(s) site' };
    if (rt.settings.general.webPanels.length >= MAX_WEB_PANELS) return { ok: false, error: `no more than ${MAX_WEB_PANELS} panels` };
    if (!rt.settings.general.webPanels.some((p) => p.url === u)) {
      rt.settings.general.webPanels.push({ url: u.slice(0, 2048), title: t?.wc.getTitle() ?? '' });
      saveSettings(settingsFile, rt.settings);
    }
    const r = openPanel(u);
    sendUI('panels:list', panelState());
    return r;
  });
  on('panels:remove', (_e, url: unknown) => {
    const u = String(url ?? '');
    rt.settings.general.webPanels = rt.settings.general.webPanels.filter((p) => p.url !== u);
    saveSettings(settingsFile, rt.settings);
    const open = rt.tabs.panelList().find((t) => (t.intendedUrl || t.wc.getURL()) === u);
    if (open) rt.tabs.closePanel(open.id);
    rt.audit.write('panel', { url: u, open: false });
    sendUI('panels:list', panelState());
    return { ok: true };
  });
  on('panels:close', (_e, id: unknown) => {
    const n = Number(id);
    // a panel is closed through the SAME reporting path as a tab, so it lands on the reopen stack
    rt.tabs.closePanel(n, (url, title, pos) => {
      closedTabs.push(url, title, pos);
      sendUI('closed-tabs', closedTabs.list());
    });
    sendUI('panels:list', panelState());
    return { ok: true };
  });

  // ---------- 19: tab stacks ----------
  on('stacks:list', () => stacks.list());
  on('stacks:create', (_e, ids: unknown, name: unknown) => {
    const live = rt.tabs.list().map((t) => t.id);
    const r = stacks.create(Array.isArray(ids) ? ids.map(Number).filter((n) => live.includes(n)) : [], String(name ?? ''));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return r;
  });
  on('stacks:collapse', (_e, id: unknown, collapsed: unknown) => {
    const ok = stacks.toggleCollapsed(String(id), typeof collapsed === 'boolean' ? collapsed : undefined);
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  on('stacks:rename', (_e, id: unknown, name: unknown) => {
    const ok = stacks.rename(String(id), String(name ?? ''));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  on('stacks:color', (_e, id: unknown, index: unknown) => {
    const ok = stacks.setColor(String(id), Number(index) || 0);
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  on('stacks:dissolve', (_e, id: unknown) => {
    const ok = stacks.dissolve(String(id));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok };
  });
  /**
   * "Close stack" resolves to a list of ids and runs them through the ORDINARY close path, so every
   * tab is captured to the closed-tab stack and a gated tab keeps its gate until it is closed.
   * There is deliberately no bulk close that bypasses closeTab().
   */
  on('stacks:close', (_e, id: unknown) => {
    const ids = stacks.members(String(id));
    let n = 0;
    for (const tid of ids) {
      // never close the agent's pane out from under a running task
      if (rt.current && rt.tabs.agentTab === tid) continue;
      closeTab(tid);
      n++;
    }
    stacks.dissolve(String(id));
    stacks.flush(join(profileDir, 'tab-stacks.json'));
    sendUI('stacks', stacks.list());
    return { ok: true, closed: n };
  });

  // ---------- 23: hibernation ----------
  on('hibernation:state', () => ({ settings: rt.settings.hibernation, hibernated: rt.tabs.hibernatedIds() }));
  on('hibernation:set', (_e, patch: unknown) => {
    const r = HibernationSettingsSchema.safeParse({ ...rt.settings.hibernation, ...(patch as object) });
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    rt.settings.hibernation = r.data;
    saveSettings(settingsFile, rt.settings);
    scheduleHibernation();
    return { ok: true, settings: r.data };
  });
  /** Sweep now. The decision is delegated to planSweep — this handler does not decide anything. */
  on('hibernation:sweep', () => ({ swept: hibernationSweep() }));
}

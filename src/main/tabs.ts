// Tabs are WebContentsViews in the dedicated `persist:guarded` session, laid out beside the UI.

import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import type { ActionOutcome, BrowserDriver } from '../core/agent';
import type { FormField, Snapshot } from '../core/types';
import { ISOLATED_WORLD, PAGE_TEXT_JS, SNAPSHOT_JS, actionJs } from './page-scripts';
import { MAX_TILES, computeTiles, contentArea, tooSmall, defaultRatios, dragDivider, innerRect, type DividerGeometry, type Rect, type TileLayout, type TileState } from './tile-layout';
import { TabGuardBook, type TabGuardState } from './tab-guard';

function originOfUrl(u: string): string | null {
  try {
    const o = new URL(u).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

export const TOP_BAR = 84;
export const PANEL_WIDTH = 440;

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  active: boolean;
  guardFlags: number;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 1-based pane number when tiled, else null */
  pane: number | null;
  selected: boolean;
  agent: boolean;
  /** the page is currently playing audio (speaker indicator) */
  audible: boolean;
  /** the tab is muted by the user */
  muted: boolean;
}

/** What the chrome UI needs to draw pane frames, headers and dividers around the page views. */
export interface Geometry {
  mode: 'single' | 'tiled';
  layout: TileLayout | null;
  dragging: boolean;
  panes: Array<{ tabId: number; pane: number | null; outer: Rect; active: boolean; agent: boolean; chrome: boolean }>;
  dividers: DividerGeometry[];
  /** set when the window is too small to give every pane its minimum size */
  notice?: string;
}

export class Tab {
  /** 'tab' is a strip tab; 'panel' is a sidebar web panel (ticket 18). A panel is a website: same
   *  session, same proxy, same allowlist, same gate — but it is never a strip tab and can never be
   *  the agent's tab, so it cannot become an escape hatch around the task's allowlist. */
  kind: 'tab' | 'panel' = 'tab';
  guardFlags = 0;
  /** favicon URLs reported by the page (page-controlled; only used for the optional site accent) */
  favicons: string[] = [];
  /** who started the pending main-frame navigation (for the audit log) */
  navSource?: 'user' | 'agent' | 'page';
  /** true while this tab's current load came from a session restore (see runtime's did-navigate) */
  restored?: boolean;
  /** the URL this tab was last told to load (getURL() is '' until a load commits) */
  intendedUrl?: string;
  /** the user started a navigation of this gated tab: the gate lifts when it COMMITS (runtime's
   *  did-navigate), not before, so the gated document's pagehide still runs gated. `leaving` is
   *  that document's origin, for the tombstone. */
  gateLiftPending?: { leaving: string | null };
  constructor(
    readonly id: number,
    readonly view: WebContentsView,
  ) {}
  get wc(): WebContents {
    return this.view.webContents;
  }
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId = -1;
  private seq = 0;
  private tiles: TileState | null = null;
  private agentTabId: number | null = null;
  /** per-tab security state — see tab-guard.ts for the rules */
  private readonly guards = new TabGuardBook();
  private selected = new Set<number>();
  /** web panels (ticket 18): NOT part of `tabs`, so they can never be the strip's active tab */
  private panels: Tab[] = [];
  private panelClosed?: (url: string, title: string, index: number) => void;
  /** where the sidebar column is on screen, reported by the chrome (x, y, w, h) */
  private panelRect: { x: number; y: number; width: number; height: number } | null = null;
  /** which panel URL (if any) the column is currently showing */
  private panelShown: string | null = null;
  private dragging = false;
  private overlay = false;
  private topInset = TOP_BAR;
  private leftInset = 0;
  private bottomInset = 0;
  /** tab id -> what to reload when it is woken (ticket 23); never holds gate state */
  private readonly hibernated = new Map<number, { url: string; title: string; scrollY: number }>();
  /** called with the chrome geometry after every layout */
  onGeometry: (g: Geometry) => void = () => undefined;

  constructor(
    private readonly win: BaseWindow,
    private readonly session: Session,
    private readonly onChange: () => void,
    private readonly setupTab: (tab: Tab) => void,
  ) {
    win.on('resize', () => this.layout());
  }

  list(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.wc.getTitle() || 'New tab',
      url: t.wc.getURL(),
      loading: t.wc.isLoading(),
      active: t.id === this.activeId,
      guardFlags: t.guardFlags,
      canGoBack: t.wc.navigationHistory.canGoBack(),
      canGoForward: t.wc.navigationHistory.canGoForward(),
      pane: this.paneOf(t.id),
      selected: this.selected.has(t.id),
      agent: t.id === this.agentTabId,
      audible: t.wc.isCurrentlyAudible(),
      muted: t.wc.isAudioMuted(),
    }));
  }

  paneOf(id: number): number | null {
    const i = this.tiles?.ids.indexOf(id) ?? -1;
    return i >= 0 ? i + 1 : null;
  }

  tileState(): TileState | null {
    return this.tiles ? { ...this.tiles, ids: [...this.tiles.ids], ratios: [...this.tiles.ratios] } : null;
  }

  /** Browser-generated description of a tab (for confirmation dialogs): number, pane, role. */
  describe(id: number): { label: string; title: string } | null {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const t = this.tabs[i];
    const pane = this.paneOf(id);
    const role = id === this.agentTabId ? 'AGENT pane' : pane ? 'not the agent pane' : id === this.activeId ? 'visible tab' : 'background tab';
    return { label: `Tab ${i + 1}${pane ? `, pane ${pane} of ${this.tiles!.ids.length}` : ''} (${role})`, title: (t.wc.getTitle() || t.wc.getURL()).slice(0, 80) };
  }

  /**
   * Pin the tab the agent is driving. A PANEL is refused here rather than only being unreachable by
   * convention: `panels` is not `tabs`, so a panel id should never arrive, and if one ever does the
   * answer must be "no" rather than an agent working in a view that is not on the task's allowlist.
   */
  setAgentTab(id: number | null) {
    if (id !== null && !this.tabs.some((t) => t.id === id)) return;
    this.agentTabId = id;
    this.layout();
    this.onChange();
  }

  get agentTab(): number | null {
    return this.agentTabId;
  }

  toggleSelected(id: number, on?: boolean) {
    const want = on ?? !this.selected.has(id);
    if (want) this.selected.add(id);
    else this.selected.delete(id);
    this.onChange();
  }

  /** Tile 2-4 tabs. Without ids: the selected tabs, else the active tab plus the next ones. */
  tile(ids: number[] | undefined, layout: TileLayout) {
    let list = (ids?.length ? ids : [...this.selected]).filter((id) => this.byId(id));
    if (list.length < 2) {
      const start = Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId));
      list = [...new Set([this.activeId, ...this.tabs.slice(start).map((t) => t.id), ...this.tabs.map((t) => t.id)])];
    }
    list = [...new Set(list)].slice(0, MAX_TILES);
    if (list.length < 2) return false;
    this.tiles = { ids: list, layout, ratios: defaultRatios(list.length, layout) };
    if (!list.includes(this.activeId)) this.activeId = list[0];
    this.selected.clear();
    this.layout();
    this.onChange();
    return true;
  }

  setTileLayout(layout: TileLayout) {
    if (!this.tiles) return;
    this.tiles = { ...this.tiles, layout, ratios: defaultRatios(this.tiles.ids.length, layout) };
    this.layout();
  }

  untile() {
    // while the agent works, leaving split view shows the agent's tab so its frame stays visible
    if (this.agentTabId !== null && this.tiles?.ids.includes(this.agentTabId)) this.activeId = this.agentTabId;
    this.tiles = null;
    this.dragging = false;
    this.layout();
    this.onChange();
  }

  /** chrome heights / widths around the pages (bookmarks bar, side panel, status bar) */
  setInsets(top: number, left: number, bottom = 0) {
    this.topInset = Math.max(TOP_BAR, top);
    this.leftInset = Math.max(0, left);
    this.bottomInset = Math.max(0, bottom);
    this.layout();
  }

  /** hide page views while a chrome overlay (address suggestions) needs the space */
  setOverlay(on: boolean) {
    this.overlay = on;
    this.layout();
  }

  setDragging(on: boolean) {
    this.dragging = on;
    this.layout();
  }

  dragDivider(key: DividerGeometry['key'], at: number) {
    if (!this.tiles) return;
    this.tiles = { ...this.tiles, ratios: dragDivider(this.area(), this.tiles, key, at) };
    this.layout();
  }

  /** which panel URL the column is showing (null = the built-in panel sections) */
  setPanelShown(url: string | null) {
    this.panelShown = url;
    this.layout();
  }

  /** the chrome reports the column's rectangle; panels are drawn there and nowhere else */
  setPanelRect(r: { x: number; y: number; width: number; height: number } | null) {
    this.panelRect = r && r.width > 0 && r.height > 0 ? r : null;
    this.layout();
  }

  /**
   * Lay the panels into the reported column. A panel is only visible when the column is open AND a
   * panel is the shown view; otherwise its WebContents stays alive but is not drawn, exactly like a
   * background tab — the page keeps its session, its gate and its state.
   */
  private layoutPanels() {
    for (const p of this.panels) {
      const r = this.panelRect;
      const show = !!r && !!this.panelShown && !this.dragging && !this.overlay;
      if (r && show) p.view.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
      p.view.setVisible(!!r && show);
    }
  }

  private area(): Rect {
    const { width, height } = this.win.getContentBounds();
    // never wider than the space left of the agent panel, even in a tiny window
    const a = contentArea(width - this.leftInset, height - this.bottomInset, this.topInset, PANEL_WIDTH);
    return { ...a, x: a.x + this.leftInset };
  }

  /**
   * The on-screen bounds of a tab's page area, for capture (ticket 26). Derived from the same
   * layout the panes use, so a capture of the "visible area" is exactly what the user sees rather
   * than a guess. Falls back to the whole area for a tab that is not currently tiled or active.
   */
  paneBounds(id: number): { x: number; y: number; width: number; height: number } {
    const a = this.area();
    const pane = this.paneOf(id);
    if (!pane || !this.tiles) return { x: 0, y: 0, width: a.width, height: a.height };
    const { panes } = computeTiles({ ...a, x: 0, y: 0 }, this.tiles);
    const r = panes[pane - 1]?.outer;
    if (!r) return { x: 0, y: 0, width: a.width, height: a.height };
    // capture rects are relative to the page, so the pane's offset inside the area is removed
    return { x: r.x - a.x, y: r.y - a.y, width: r.width, height: r.height };
  }

  active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  byWebContents(wc: WebContents): Tab | undefined {
    return this.tabs.find((t) => t.wc === wc) ?? this.panels.find((t) => t.wc === wc);
  }

  /** true when this id belongs to a sidebar panel rather than a strip tab */
  isPanel(id: number): boolean {
    return this.panels.some((t) => t.id === id);
  }

  // ---------- per-tab security state (single source of truth) ----------
  // The rules live in TabGuardBook (src/main/tab-guard.ts) so they are unit-testable without a
  // browser; this is the thin adapter to live tabs. runtime.ts reads these instead of keeping its
  // own sets, so every tab-shaped feature (reopen, restore, hibernation, stacks, vertical tabs)
  // asks the same question and gets the same answer.

  /** the agent's pane, or undefined when no task owns a tab */
  agentTabObj(): Tab | undefined {
    return this.agentTabId === null ? undefined : this.tabs.find((t) => t.id === this.agentTabId);
  }

  /** full security state for one tab (including whether it is the agent's pane) */
  guardStateOf(id: number): TabGuardState | null {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return null;
    return this.guards.state(id, t.id === this.agentTabId, t.navSource);
  }

  /** true while a tab's current document is under the post-task gate */
  isGated(id: number): boolean {
    return this.guards.isGated(id);
  }

  /** true when any tab is still gated (the worker gate is keyed on this) */
  anyGated(): boolean {
    return this.guards.anyGated();
  }

  /** every origin reached by a currently-gated tab (the worker gate's watch list) */
  gatedOrigins(): Set<string> {
    return this.guards.gatedOrigins();
  }

  setGate(id: number, gate: 'none' | 'post-task') {
    if (gate === 'none') this.guards.lift(id);
    else this.guards.gate(id);
  }

  /** The user's own navigation COMMITTED in this tab: lift the gate, tombstoning the document left. */
  liftGateOnCommit(id: number, leaving: string | null, fresh: string | null) {
    const t = this.tabs.find((x) => x.id === id);
    if (t) this.guards.lift(id, { wcId: t.wc.id, leaving, fresh });
  }

  /** see TabGuardBook.heldByTomb */
  heldByTomb(req: { wcId?: number; liveTab: boolean; origin: string | null; referrerOrigin: string | null }): boolean {
    return this.guards.heldByTomb(req);
  }

  addGuardOrigin(id: number, origin: string) {
    this.guards.addOrigin(id, origin);
  }

  /** drop a closed tab's state */
  forgetTab(id: number) {
    this.guards.forget(id);
  }

  // ---------- zoom, find, audio (view properties of a tab) ----------

  /** Set a tab's zoom factor. A view property only: it never touches what a snapshot reports. */
  setZoom(id: number, factor: number) {
    this.byId(id)?.wc.setZoomFactor(factor);
  }

  zoomOf(id: number): number {
    return this.byId(id)?.wc.getZoomFactor() ?? 1;
  }

  /**
   * Find in a tab's page. The callback receives (matches, activeMatchOrdinal) as Chromium reports
   * them; the caller must stopFindInPage when the bar closes. `findNext` continues from the last
   * result. Nothing here reads page text — Chromium reports counts, not content.
   */
  findInPage(id: number, query: string, opts: { forward?: boolean; findNext?: boolean; matchCase?: boolean } = {}): number {
    const t = this.byId(id);
    if (!t) return 0;
    const r = t.wc.findInPage(query, {
      forward: opts.forward !== false,
      findNext: opts.findNext === true,
      matchCase: opts.matchCase === true,
    });
    return r; // the request id
  }

  stopFind(id: number, action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection') {
    this.byId(id)?.wc.stopFindInPage(action);
  }

  setAudioMuted(id: number, muted: boolean) {
    this.byId(id)?.wc.setAudioMuted(muted);
  }

  // ---------- hibernation (ticket 23) ----------

  /**
   * Discard a tab's contents to free memory, remembering its URL so activating it reloads.
   *
   * THE CONSTRAINT, stated here because this is where it could go wrong: this method REFUSES a tab
   * that is the agent's pane or that is under the post-task gate. Discarding a webContents destroys
   * the id the gate is keyed on, so allowing it here would silently drop the guarantee that a page
   * which received an agent POST is cleaned before reuse. The refusal is a hard second check: the
   * caller already filtered with decideHibernation, and this cannot be bypassed by calling directly.
   *
   * What "discard" actually does here — and the honest limit of it: Electron exposes no public
   * webContents discard, so hibernation is implemented by freeing the VIEW and keeping the tab's
   * identity, URL and title, then recreating the view on activation. The rendered page's memory is
   * released with the view; the tab itself stays in the strip and keeps its position.
   */
  hibernate(id: number): boolean {
    const t = this.byId(id);
    if (!t) return false;
    if (id === this.agentTabId) return false; // the agent is driving it
    if (this.isGated(id)) return false; // discarding it would drop the gate
    if (id === this.activeId) return false; // it is on screen
    if (this.hibernated.has(id)) return false;
    const url = t.intendedUrl || t.wc.getURL();
    const title = t.wc.getTitle();
    if (!url || url === 'about:blank') return false; // nothing worth keeping
    t.view.setVisible(false);
    this.win.contentView.removeChildView(t.view);
    this.hibernated.set(id, { url, title, scrollY: 0 });
    // deliberately NOT destroying the webContents: destroying it would change the tab id's meaning
    // and put the gate's key at risk. Detaching the view frees the rendered surface instead.
    this.layout();
    this.onChange();
    return true;
  }

  isHibernated(id: number): boolean {
    return this.hibernated.has(id);
  }

  hibernatedIds(): number[] {
    return [...this.hibernated.keys()];
  }

  /** Bring a hibernated tab back: re-attach its view (and reload if it had gone blank). */
  wake(id: number): boolean {
    const t = this.byId(id);
    const h = this.hibernated.get(id);
    if (!t || !h) return false;
    this.hibernated.delete(id);
    this.win.contentView.addChildView(t.view);
    if (!t.wc.getURL()) {
      t.restored = true;
      void t.wc.loadURL(h.url).catch(() => undefined);
    }
    this.layout();
    this.onChange();
    return true;
  }

  /** The current chrome insets, so the renderer can restore them after a reload. */
  insets(): { top: number; left: number; bottom: number } {
    return { top: this.topInset, left: this.leftInset, bottom: this.bottomInset };
  }

  /**
   * Restore a saved session: one tab per URL, in order, with the given tab active and the tile set
   * reapplied. Every restored tab is a NEW tab id, so it starts out of the post-task gate — the
   * whole reason session state deliberately cannot carry gate state.
   */
  restore(tabs: Array<{ url: string; title?: string }>, activeIndex: number, tiles: { indexes: number[]; layout: TileLayout; ratios: number[] } | null): void {
    if (!tabs.length) return;
    const created: Tab[] = [];
    tabs.forEach((t, i) => {
      created.push(this.createAt(t.url, { background: i !== activeIndex }));
    });
    for (const t of created) {
      t.navSource = 'user';
      t.restored = true;
    }
    if (tiles && tiles.indexes.length >= 2) {
      const ids = tiles.indexes.map((i) => created[i]?.id).filter((x): x is number => x !== undefined);
      if (ids.length >= 2) {
        this.tiles = { ids, layout: tiles.layout, ratios: tiles.ratios.length === ids.length ? tiles.ratios : defaultRatios(ids.length, tiles.layout) };
        this.activeId = created[activeIndex]?.id ?? ids[0];
        this.layout();
        this.onChange();
      }
    }
  }

  create(url?: string, opts: { background?: boolean } = {}): Tab {
    return this.createAt(url, opts);
  }

  /**
   * Create a tab at a specific strip position (used by reopen, so a restored tab lands where it
   * was instead of at the end). `at` is clamped; a tab created at the end behaves exactly like
   * `create()`. The new tab is a fresh document: no security state is carried over from whatever
   * tab used to occupy this position.
   */
  createAt(url?: string, opts: { background?: boolean; at?: number } = {}): Tab {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // tiny sandboxed preload: removes RTCPeerConnection from the page while an agent task drives the tab
        preload: join(__dirname, 'tab-preload.js'),
      },
    });
    const tab = new Tab(++this.seq, view);
    const at = opts.at === undefined ? this.tabs.length : Math.max(0, Math.min(Math.round(opts.at), this.tabs.length));
    this.tabs.splice(at, 0, tab);
    this.win.contentView.addChildView(view);
    const wc = view.webContents;
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(ev as 'did-stop-loading', () => this.onChange());
    }
    wc.on('did-navigate', () => {
      tab.guardFlags = 0;
    });
    // clicking into a tiled pane focuses it (address bar, focus highlight follow)
    wc.on('focus', () => {
      if (this.tiles?.ids.includes(tab.id) && this.activeId !== tab.id) {
        this.activeId = tab.id;
        this.layout();
        this.onChange();
      }
    });
    this.setupTab(tab);
    if (opts.background) {
      view.setVisible(false);
      this.layout();
      this.onChange();
    } else this.activate(tab.id);
    if (url) {
      tab.intendedUrl = url;
      void wc.loadURL(url).catch(() => undefined);
    }
    return tab;
  }

  /**
   * Create a web panel (ticket 18): a WebContentsView pinned into the sidebar column. It shares the
   * profile's session, so the proxy, host allowlist, reputation feed and webRequest rules all apply
   * exactly as they do to a tab — that is the whole reason a panel is inside the threat model
   * rather than beside it.
   *
   * Two structural guarantees, not UI conventions:
   *  - a panel is NOT in `this.tabs`, so it never appears in the strip and never becomes `active()`;
   *  - `agentTabId` is only ever set from the strip and `createPanel` refuses to set it, so a panel
   *    cannot be the agent's tab even if a caller asks.
   * The panel IS registered in `panels` so `closePanel` and the guard book can find it.
   */
  createPanel(url: string, opts: { onClosed?: (url: string, title: string, index: number) => void } = {}): Tab {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: join(__dirname, 'tab-preload.js'),
      },
    });
    const tab = new Tab(++this.seq, view);
    tab.kind = 'panel';
    tab.navSource = 'user';
    this.panels.push(tab);
    this.panelClosed = opts.onClosed;
    this.win.contentView.addChildView(view);
    const wc = view.webContents;
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(ev as 'did-stop-loading', () => this.onChange());
    }
    wc.on('did-navigate', () => {
      tab.guardFlags = 0;
    });
    this.setupTab(tab);
    // a popup from a panel is never allowed to open a window: same rule as the strip
    tab.intendedUrl = url;
    void wc.loadURL(url).catch(() => undefined);
    return tab;
  }

  /** the open web panels, in creation order */
  panelList(): Tab[] {
    return [...this.panels];
  }

  closePanel(id: number, onClosed?: (url: string, title: string, index: number) => void) {
    const t = this.panels.find((x) => x.id === id);
    if (!t) return;
    const report = onClosed ?? this.panelClosed;
    if (report) {
      const url = t.wc.getURL();
      if (url) report(url, t.wc.getTitle(), this.panels.indexOf(t));
    }
    this.guards.forget(id);
    this.win.contentView.removeChildView(t.view);
    t.wc.close();
    this.panels = this.panels.filter((x) => x !== t);
    this.layout();
    this.onChange();
  }

  /** a panel's WebContents belongs to this manager, so `ownsWebContents` must see it */
  panelByWebContents(wc: WebContents): Tab | undefined {
    return this.panels.find((t) => t.wc === wc);
  }

  /** set by the runtime so every close captures what it removed (see close()) */
  onTabClosed?: (url: string, title: string, index: number) => void;
  /** the id of a tab whose close must NOT be captured (the agent's own pane, and restart) */
  silentCloseId: number | null = null;

  /**
   * Close a tab, reporting what it was so the caller can push it onto the closed-tab stack. The
   * reporter is called with (url, title, index) while the tab is still alive — after `close()`
   * the WebContents is gone and its URL with it.
   *
   * When `onClosed` is omitted, `onTabClosed` (set by the runtime) is used. That is what makes the
   * bulk closes — close others, close right, and the "close" of an emptied window — capture every
   * tab they remove, instead of the tabs vanishing un-reopenable.
   */
  close(id: number, onClosed?: (url: string, title: string, index: number) => void) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    const index = this.tabs.indexOf(t);
    const report = onClosed ?? this.onTabClosed;
    if (report && t.id !== this.silentCloseId) {
      const url = t.wc.getURL();
      const title = t.wc.getTitle();
      if (url) report(url, title, index);
    }
    // a closed tab's gate goes with it, leaving a tombstone: wc.close() below runs the document's
    // pagehide / unload, whose beacons arrive after the tab is gone
    this.guards.forget(id, { wcId: t.wc.id, leaving: originOfUrl(t.wc.getURL()) });
    this.hibernated.delete(id); // ...and so does its wake target
    this.win.contentView.removeChildView(t.view);
    t.wc.close();
    this.tabs = this.tabs.filter((x) => x !== t);
    this.selected.delete(id);
    if (this.tiles) {
      const ids = this.tiles.ids.filter((x) => x !== id);
      this.tiles = ids.length >= 2 ? { ...this.tiles, ids, ratios: defaultRatios(ids.length, this.tiles.layout) } : null;
    }
    if (this.activeId === id) this.activeId = this.tiles?.ids[0] ?? this.tabs.at(-1)?.id ?? -1;
    if (this.tabs.length === 0) this.create('about:blank');
    this.layout();
    this.onChange();
  }

  /** Activating a tab outside the current tile set leaves split view (like Vivaldi). */
  activate(id: number) {
    // Only a STRIP tab can be activated. A panel id (or any unknown id) must be a no-op: setting
    // activeId to something that is not in `tabs` left the strip with no active tab at all.
    if (!this.tabs.some((t) => t.id === id)) return;
    if (this.tiles && !this.tiles.ids.includes(id)) this.tiles = null;
    this.activeId = id;
    // a hibernated tab must be re-attached before it is shown, or the pane would be empty
    if (this.hibernated.has(id)) this.wake(id);
    this.layout();
    this.onChange();
  }

  /** Move a tab to a new strip position (drag reorder). Returns the resulting order. */
  move(id: number, to: number): number[] {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return this.tabs.map((t) => t.id);
    const [t] = this.tabs.splice(from, 1);
    const at = Math.max(0, Math.min(Math.round(to), this.tabs.length));
    this.tabs.splice(at, 0, t);
    this.layout();
    this.onChange();
    return this.tabs.map((x) => x.id);
  }

  /**
   * Duplicate a tab: a new tab at the same URL, immediately to its right.
   *
   * The URL comes from the tab's intended target when the current document has not committed yet
   * (`wc.getURL()` is '' until a load commits, which is the common case right after "new tab" or a
   * navigation that is still in flight). Falling back to that keeps duplicate from silently doing
   * nothing, which is what an unconditional `if (!url) return` did.
   */
  duplicate(id: number): Tab | undefined {
    const t = this.byId(id);
    if (!t) return undefined;
    const url = t.wc.getURL() || t.intendedUrl || '';
    if (!url || !/^https?:/i.test(url)) return undefined;
    const i = this.tabs.indexOf(t);
    const d = this.createAt(url, { at: i + 1 });
    d.navSource = 'user';
    return d;
  }

  /** Close every tab except this one (and never the agent's pane while a task runs). */
  closeOthers(id: number, keepAgentPane = true): number[] {
    const doomed = this.tabs.filter((t) => t.id !== id && !(keepAgentPane && t.id === this.agentTabId)).map((t) => t.id);
    for (const d of doomed) this.close(d);
    return doomed;
  }

  /** Close every tab to the right of this one (skipping the agent's pane while a task runs). */
  closeRight(id: number, keepAgentPane = true): number[] {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return [];
    const doomed = this.tabs.slice(i + 1).filter((t) => !(keepAgentPane && t.id === this.agentTabId)).map((t) => t.id);
    for (const d of doomed) this.close(d);
    return doomed;
  }

  /** The tab order as ids, newest first by most-recent activation (for Ctrl+Tab cycling). */
  private mru: number[] = [];

  noteActivated(id: number) {
    this.mru = [id, ...this.mru.filter((x) => x !== id)];
  }

  /** The next tab in most-recently-used order (Ctrl+Tab), optionally the previous. */
  nextInMru(dir: 1 | -1): number | undefined {
    this.mru = this.mru.filter((x) => this.tabs.some((t) => t.id === x));
    if (this.mru.length < 2) return undefined;
    const at = Math.max(0, this.mru.indexOf(this.activeId));
    const n = (at + (dir === 1 ? 1 : -1) + this.mru.length) % this.mru.length;
    return this.mru[n];
  }

  layout() {
    const area = this.area();
    const g: Geometry = { mode: this.tiles ? 'tiled' : 'single', layout: this.tiles?.layout ?? null, dragging: this.dragging, panes: [], dividers: [] };
    const views = new Map<number, Rect>();
    if (this.tiles) {
      const c = computeTiles(area, this.tiles);
      this.tiles.ratios = c.ratios;
      g.dividers = c.dividers;
      if (tooSmall(area, this.tiles)) g.notice = 'Window too small for this split view: panes are below their minimum size. Enlarge the window, use fewer panes, or untile.';
      c.panes.forEach((p, i) => {
        views.set(p.tabId, p.view);
        g.panes.push({ tabId: p.tabId, pane: i + 1, outer: p.outer, active: p.tabId === this.activeId, agent: p.tabId === this.agentTabId, chrome: true });
      });
    } else if (this.activeId >= 0) {
      // single view: the agent's tab always gets the chrome frame + AGENT ACTIVE header
      const agent = this.activeId === this.agentTabId;
      views.set(this.activeId, innerRect(area, agent));
      g.panes.push({ tabId: this.activeId, pane: null, outer: area, active: true, agent, chrome: agent });
    }
    for (const t of this.tabs) {
      const r = views.get(t.id);
      // while a divider is dragged the page views are hidden so the chrome receives the pointer;
      // a pane squeezed to nothing hides its view instead of drawing outside its slot
      t.view.setVisible(!!r && r.width >= 1 && r.height >= 1 && !this.dragging && !this.overlay);
      if (r) t.view.setBounds(r);
    }
    this.layoutPanels();
    this.onGeometry(g);
  }
}

function waitForLoad(wc: WebContents, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    if (!wc.isLoading()) return resolve();
    const t = setTimeout(resolve, timeoutMs);
    wc.once('did-stop-loading', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BrowserDriver over one tab. All page access goes through the isolated world. */
export class ElectronDriver implements BrowserDriver {
  constructor(private readonly tab: Tab) {}

  private get wc() {
    return this.tab.wc;
  }

  private async run<T>(code: string): Promise<T> {
    return (await this.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }])) as T;
  }

  currentUrl() {
    return this.wc.getURL();
  }

  async navigate(url: string): Promise<ActionOutcome> {
    this.tab.navSource = 'agent';
    try {
      await this.wc.loadURL(url);
      return { ok: true };
    } catch (e) {
      await waitForLoad(this.wc);
      return { ok: false, detail: (e as Error).message.slice(0, 200) };
    }
  }

  async snapshot(): Promise<Snapshot> {
    await waitForLoad(this.wc);
    try {
      return await this.run<Snapshot>(SNAPSHOT_JS);
    } catch {
      return { url: this.wc.getURL(), title: this.wc.getTitle(), elements: [] };
    }
  }

  async pageText(): Promise<string> {
    await waitForLoad(this.wc);
    try {
      return await this.run<string>(PAGE_TEXT_JS);
    } catch {
      return '';
    }
  }

  private async act(kind: Parameters<typeof actionJs>[0], ref: string, value = ''): Promise<ActionOutcome> {
    const r = await this.run<ActionOutcome>(actionJs(kind, ref, value)).catch((e) => ({ ok: false, detail: String(e) }));
    // give navigations triggered by the action a moment to start, then wait for them
    await delay(400);
    await waitForLoad(this.wc);
    return r;
  }

  click(ref: string) {
    return this.act('click', ref);
  }
  type(ref: string, text: string) {
    return this.act('type', ref, text);
  }
  select(ref: string, value: string) {
    return this.act('select', ref, value);
  }
  scroll(direction: 'up' | 'down') {
    return this.act('scroll', '', direction);
  }
  submit(ref: string) {
    return this.act('submit', ref);
  }
  async formFields(ref: string): Promise<FormField[]> {
    const r = await this.run<{ ok: boolean; fields?: FormField[] }>(actionJs('formFields', ref)).catch(() => ({ ok: false, fields: [] }));
    return r.fields ?? [];
  }
}

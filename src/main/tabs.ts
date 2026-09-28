// Tabs are WebContentsViews in the dedicated `persist:guarded` session, laid out beside the UI.

import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import type { ActionOutcome, BrowserDriver } from '../core/agent';
import type { FormField, Snapshot } from '../core/types';
import { ISOLATED_WORLD, PAGE_TEXT_JS, SNAPSHOT_JS, actionJs } from './page-scripts';
import { MAX_TILES, computeTiles, defaultRatios, dragDivider, innerRect, type DividerGeometry, type Rect, type TileLayout, type TileState } from './tile-layout';

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
}

/** What the chrome UI needs to draw pane frames, headers and dividers around the page views. */
export interface Geometry {
  mode: 'single' | 'tiled';
  layout: TileLayout | null;
  dragging: boolean;
  panes: Array<{ tabId: number; pane: number | null; outer: Rect; active: boolean; agent: boolean; chrome: boolean }>;
  dividers: DividerGeometry[];
}

export class Tab {
  guardFlags = 0;
  /** favicon URLs reported by the page (page-controlled; only used for the optional site accent) */
  favicons: string[] = [];
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
  private selected = new Set<number>();
  private dragging = false;
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

  setAgentTab(id: number | null) {
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
    this.tiles = null;
    this.dragging = false;
    this.layout();
    this.onChange();
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

  private area(): Rect {
    const { width, height } = this.win.getContentBounds();
    return { x: 0, y: TOP_BAR, width: Math.max(100, width - PANEL_WIDTH), height: Math.max(100, height - TOP_BAR) };
  }

  active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  byWebContents(wc: WebContents): Tab | undefined {
    return this.tabs.find((t) => t.wc === wc);
  }

  create(url?: string): Tab {
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
    this.tabs.push(tab);
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
    this.activate(tab.id);
    if (url) void wc.loadURL(url).catch(() => undefined);
    return tab;
  }

  close(id: number) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
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
    if (this.tiles && !this.tiles.ids.includes(id)) this.tiles = null;
    this.activeId = id;
    this.layout();
    this.onChange();
  }

  layout() {
    const area = this.area();
    const g: Geometry = { mode: this.tiles ? 'tiled' : 'single', layout: this.tiles?.layout ?? null, dragging: this.dragging, panes: [], dividers: [] };
    const views = new Map<number, Rect>();
    if (this.tiles) {
      const c = computeTiles(area, this.tiles);
      this.tiles.ratios = c.ratios;
      g.dividers = c.dividers;
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
      // while a divider is dragged the page views are hidden so the chrome receives the pointer
      t.view.setVisible(!!r && !this.dragging);
      if (r) t.view.setBounds(r);
    }
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

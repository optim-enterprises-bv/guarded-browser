// Tabs are WebContentsViews in the dedicated `persist:guarded` session, laid out beside the UI.

import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import type { ActionOutcome, BrowserDriver } from '../core/agent';
import type { FormField, Snapshot } from '../core/types';
import { ISOLATED_WORLD, PAGE_TEXT_JS, SNAPSHOT_JS, actionJs } from './page-scripts';

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
}

export class Tab {
  guardFlags = 0;
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
    }));
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
    if (this.activeId === id) this.activeId = this.tabs.at(-1)?.id ?? -1;
    if (this.tabs.length === 0) this.create('about:blank');
    this.layout();
    this.onChange();
  }

  activate(id: number) {
    this.activeId = id;
    this.layout();
    this.onChange();
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    for (const t of this.tabs) {
      const visible = t.id === this.activeId;
      t.view.setVisible(visible);
      if (visible) t.view.setBounds({ x: 0, y: TOP_BAR, width: Math.max(100, width - PANEL_WIDTH), height: Math.max(100, height - TOP_BAR) });
    }
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

// What the pieces split out of createRuntime (src/main/runtime/*.ts) may reach of ONE profile's
// runtime. runtime.ts builds this object once; every field that runtime.ts reassigns (settings, the
// running task, the tab manager, ...) is a GETTER onto the runtime's own variable, so a module always
// sees the live value and never a copy taken when it was created.

import type { BrowserWindow } from 'electron';
import type { AgentTask } from '../../core/agent';
import type { AuditLog } from '../../core/audit';
import type { BookmarkStore } from '../../core/bookmarks';
import type { SortMode, TrashStore } from '../../core/bookmarks-panel';
import type { Chord } from '../../core/chords';
import type { ClosedTabStore } from '../../core/closed-tabs';
import type { Settings } from '../../core/config';
import type { DownloadList } from '../../core/downloads';
import type { EgressController } from '../../core/egress';
import type { Point } from '../../core/gestures';
import type { HistoryStore } from '../../core/history';
import type { PageActionsStore } from '../../core/page-actions';
import type { PaletteItem } from '../../core/quick-commands';
import type { LocalLists, ReputationChecker, ReputationDb } from '../../core/reputation';
import type { SavedSessionStore } from '../../core/saved-sessions';
import type { SessionStore } from '../../core/session-state';
import type { StackModel } from '../../core/tab-stacks';
import type { TabHostLog } from '../../core/xray';
import type { Theme } from '../../core/theme';
import type { WorkspaceStore } from '../../core/workspaces';
import type { ZoomStore } from '../../core/zoom';
import type { ConfirmBroker } from '../confirm';
import type { ExtensionList } from '../extensions';
import type { MailController } from '../mail/controller';
import type { MailHtmlView } from '../mail/html-view';
import type { Handler, RuntimeContext } from '../runtime';
import type { Tab, TabManager } from '../tabs';

export interface RuntimeDeps {
  // ---- live state (getters onto runtime.ts's variables) ----
  /** settable: settings:save replaces the whole object */
  settings: Settings;
  readonly tabs: TabManager;
  readonly win: BrowserWindow;
  readonly audit: AuditLog;
  readonly egress: EgressController;
  readonly broker: ConfirmBroker;
  /** the running agent task and the tab it drives, or null */
  readonly current: { task: AgentTask; tab: Tab } | null;
  /** webRequest-layer flows the user denied during the current task */
  readonly deniedFlows: Set<string>;
  /** gesture trail from the MAIN process's own input events; never page-reported (ticket 16) */
  gestureTrail: Point[];
  /** the bookmarks panel's sort mode (ticket 33); presentation only */
  bookmarkSort: SortMode;

  // ---- fixed for the runtime's lifetime ----
  ctx: RuntimeContext;
  handlers: Record<string, Handler>;
  profileDir: string;
  settingsFile: string;
  feeds: ReputationDb;
  localLists: LocalLists;
  reputation: ReputationChecker;
  history: HistoryStore;
  bookmarks: BookmarkStore;
  bookmarkTrash: TrashStore;
  closedTabs: ClosedTabStore;
  sessionState: SessionStore;
  zoom: ZoomStore;
  downloads: DownloadList;
  savedSessions: SavedSessionStore;
  workspaces: WorkspaceStore;
  stacks: StackModel;
  pageActions: PageActionsStore;
  extensions: ExtensionList;
  /** favicon bytes by origin (in memory only) */
  faviconCache: Map<string, { mime: string; data: string }>;
  /** the query the user last typed in the find bar, per tab */
  lastFindQuery: Map<number, string>;
  /** hosts each tab's pages requested (webRequest layer), for the Injection X-ray; in memory only */
  tabHosts: TabHostLog;

  // ---- runtime functions ----
  sendUI(channel: string, payload: unknown): void;
  state(): unknown;
  reputationState(): unknown;
  stopTask(): void;
  startTask(text: string, origins?: string[]): Promise<string>;
  previewOrigins(text: string): string[];
  closeTab(id: number): void;
  reopenClosed(): { ok: boolean; url?: string };
  liftGateOnCommit(t: Tab): void;
  printTab(tab: Tab): Promise<boolean>;
  saveSessionSoon(): void;
  updateSiteAccent(): Promise<void>;
  importTheme(json: unknown): { ok: boolean; error?: string; theme?: Theme };
  applyPageActions(tab: Tab, origin: string): void;
  commandItems(): PaletteItem[];
  hibernationSweep(): number[];
  scheduleHibernation(): void;
  panelState(): unknown;
  openPanel(url: string): { ok: boolean; error?: string; id?: number };
  runChord(input: { key: string; control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; type?: string }): boolean;
  runAction(action: string): boolean;
  /** toggle the Injection X-ray of the active tab (the chord / menu path; read-only) */
  toggleXray(): void;
  chordTable(): Chord[];
  /** the per-profile mail controller (ticket 37c), created on first use */
  mail(): MailController;
  /** this window's HTML reading view for mail, created on first use (never a tab, never agent-visible) */
  mailView(): MailHtmlView;
}

// What the pieces split out of createRuntime (src/main/runtime/*.ts) may reach of ONE profile's
// runtime. runtime.ts builds this object once; every field that runtime.ts reassigns (settings, the
// running task, the tab manager, ...) is a GETTER onto the runtime's own variable, so a module always
// sees the live value and never a copy taken when it was created.

import type { BrowserWindow } from 'electron';
import type { AgentTask } from '../../core/agent';
import type { AuditLog } from '../../core/audit';
import type { Settings } from '../../core/config';
import type { DownloadList } from '../../core/downloads';
import type { EgressController } from '../../core/egress';
import type { ZoomStore } from '../../core/zoom';
import type { ConfirmBroker } from '../confirm';
import type { Tab, TabManager } from '../tabs';

export interface RuntimeDeps {
  // ---- live state (getters; reassigned by runtime.ts) ----
  readonly settings: Settings;
  readonly tabs: TabManager;
  readonly win: BrowserWindow;
  readonly audit: AuditLog;
  readonly egress: EgressController;
  readonly broker: ConfirmBroker;
  /** the running agent task and the tab it drives, or null */
  readonly current: { task: AgentTask; tab: Tab } | null;
  /** webRequest-layer flows the user denied during the current task */
  readonly deniedFlows: Set<string>;

  // ---- fixed for the runtime's lifetime ----
  profileDir: string;
  settingsFile: string;
  downloads: DownloadList;
  zoom: ZoomStore;

  // ---- runtime functions ----
  sendUI(channel: string, payload: unknown): void;
  stopTask(): void;
  closeTab(id: number): void;
  reopenClosed(): { ok: boolean; url?: string };
  liftGateOnCommit(t: Tab): void;
  printTab(tab: Tab): Promise<boolean>;
}

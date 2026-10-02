// Workspaces (ticket 20): named sets of tabs the user switches between.
//
// THE BOUNDARY, stated plainly because this is the ticket where it is easiest to be wrong:
// **a workspace is NOT a profile.** Workspaces share cookies, storage, the session partition,
// history, bookmarks and every security layer. They are a view over tabs, nothing more. The
// identity boundary in this product stays the profile (profiles.ts) — a different profile has a
// different partition and different storage; a different workspace has neither.
//
// A running agent task therefore pins its workspace: switching during a task is refused (with the
// reason shown), mirroring how untiling during a task keeps the agent's pane visible. Letting a
// switch hide the agent's tab mid-task would make the security UI lie about what is happening.
//
// Persistence holds ids, names, colours and tab URLs/titles — never gate state, never taint.

import { z } from 'zod';
import { atomicWriteFile, loadJson } from './persist';
import { restorable } from './session-state';

export const MAX_WORKSPACES = 20;
export const MAX_NAME = 40;
export const MAX_TABS = 50;

const TabSchema = z.object({ url: z.string().max(2048), title: z.string().max(200) }).strict();

const WorkspaceSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().min(1).max(MAX_NAME),
    /** a CSS colour from a fixed palette, chosen by index; never page-derived */
    colorIndex: z.number().int().min(0).max(11),
    tabs: z.array(TabSchema).max(MAX_TABS),
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

const FileSchema = z
  .object({
    version: z.literal(1),
    activeId: z.string().max(64),
    workspaces: z.array(WorkspaceSchema).min(1).max(MAX_WORKSPACES),
  })
  .strict();

export const WORKSPACE_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#6366f1',
  '#a855f7',
  '#64748b',
  '#84cc16',
];

export const cleanName = (n: string) =>
  String(n)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);


export class WorkspaceStore {
  private data: z.infer<typeof FileSchema>;
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    const first: z.infer<typeof FileSchema> = {
      version: 1,
      activeId: 'w-default',
      workspaces: [{ id: 'w-default', name: 'Default', colorIndex: 0, tabs: [] }],
    };
    const r = loadJson(file, FileSchema, { fallback: first });
    this.data = r.value;
    this.loadError = r.loadError;
  }

  list(): Workspace[] {
    return this.data.workspaces.map((w) => ({ ...w }));
  }

  get activeId() {
    return this.data.activeId;
  }

  active(): Workspace {
    return this.data.workspaces.find((w) => w.id === this.data.activeId) ?? this.data.workspaces[0];
  }

  create(name: string, colorIndex = 0): { ok: true; workspace: Workspace } | { ok: false; error: string } {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'a workspace needs a name' };
    if (this.data.workspaces.length >= MAX_WORKSPACES) return { ok: false, error: `at most ${MAX_WORKSPACES} workspaces` };
    if (this.data.workspaces.some((w) => w.name === clean)) return { ok: false, error: 'that name is taken' };
    const w: Workspace = {
      id: `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: clean,
      colorIndex: Math.abs(Math.floor(colorIndex)) % WORKSPACE_COLORS.length,
      tabs: [],
    };
    this.data.workspaces = [...this.data.workspaces, w];
    this.flush();
    return { ok: true, workspace: { ...w } };
  }

  rename(id: string, name: string): boolean {
    const clean = cleanName(name);
    if (!clean) return false;
    const w = this.data.workspaces.find((x) => x.id === id);
    if (!w) return false;
    if (this.data.workspaces.some((x) => x.id !== id && x.name === clean)) return false;
    w.name = clean;
    this.flush();
    return true;
  }

  remove(id: string): { ok: boolean; error?: string } {
    if (this.data.workspaces.length <= 1) return { ok: false, error: 'the last workspace cannot be removed' };
    const before = this.data.workspaces.length;
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    if (this.data.workspaces.length === before) return { ok: false, error: 'no such workspace' };
    if (this.data.activeId === id) this.data.activeId = this.data.workspaces[0].id;
    this.flush();
    return { ok: true };
  }

  /**
   * Switch the active workspace, remembering the tab set of the one being left. Returns the tabs
   * the caller should now open. This is the ONLY mutating entry point the runtime uses for a
   * switch, so "save current tabs, load the other set" cannot half-happen.
   */
  switchTo(id: string, currentTabs: Array<{ url: string; title: string }>): { ok: true; tabs: Array<{ url: string; title: string }> } | { ok: false; error: string } {
    const target = this.data.workspaces.find((w) => w.id === id);
    if (!target) return { ok: false, error: 'no such workspace' };
    if (id === this.data.activeId) return { ok: true, tabs: target.tabs.map((t) => ({ ...t })) };
    this.remember(currentTabs);
    this.data.activeId = id;
    this.flush();
    return { ok: true, tabs: target.tabs.filter((t) => restorable(t.url)).map((t) => ({ ...t })) };
  }

  /** Record the tab set for a workspace (used on switch, and on session save). */
  remember(tabs: Array<{ url: string; title: string }>, id = this.data.activeId) {
    const w = this.data.workspaces.find((x) => x.id === id);
    if (!w) return;
    w.tabs = tabs
      .filter((t) => restorable(t.url))
      .slice(0, MAX_TABS)
      .map((t) => ({ url: t.url, title: String(t.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) }));
    this.flush();
  }

  flush() {
    atomicWriteFile(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
}

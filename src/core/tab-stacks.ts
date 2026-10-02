// Tab stacks (ticket 19): a presentation grouping over the strip.
//
// THE INVARIANT (rule 1/2): a stack is presentation, NOT a security boundary. Collapsing a stack
// must not unload, reset or un-gate anything — it changes which tabs the strip draws and nothing
// else. This module is a pure model over tab ids; it holds no view state and cannot close a tab by
// itself. "Close stack" is resolved to a list of ids that the caller feeds through the ordinary
// close path (which captures to the closed-tab stack), so a gated tab inside a collapsed stack
// keeps its gate and still holds its POST.
//
// A stack nests: a stack's members are tab ids, and stacks are drawn in strip order. A tab belongs
// to at most one stack (the model enforces this), which keeps the strip a sequence, not a tree.

import { z } from 'zod';
import { atomicWriteFile, loadJson } from './persist';

export const MAX_STACKS = 100;
export const MAX_NAME = 60;

const TabSchema = z.object({ url: z.string().max(2048), title: z.string().max(200) }).strict();

const StackSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().max(MAX_NAME),
    colorIndex: z.number().int().min(0).max(11),
    collapsed: z.boolean(),
    /** tab ids, in strip order */
    tabs: z.array(z.number().int().nonnegative()),
    /** remembered tabs so a stack survives a restart (same shape as session restore) */
    saved: z.array(TabSchema).max(50),
  })
  .strict();
export type TabStack = z.infer<typeof StackSchema>;

const FileSchema = z.object({ version: z.literal(1), stacks: z.array(StackSchema).max(MAX_STACKS) }).strict();

export const STACK_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#10b981', '#14b8a6', '#06b6d4', '#6366f1', '#a855f7', '#64748b', '#84cc16'];

export const cleanName = (n: string) =>
  String(n)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);


/**
 * Pure stack model. Every method takes and returns plain data so the rules are unit-testable
 * without a browser.
 */
export class StackModel {
  private stacks: TabStack[] = [];

  constructor(initial: TabStack[] = []) {
    this.stacks = initial.map(clone);
  }

  list(): TabStack[] {
    return this.stacks.map(clone);
  }

  /** The stack containing a tab, or null. */
  stackOf(tabId: number): TabStack | null {
    const s = this.stacks.find((x) => x.tabs.includes(tabId));
    return s ? clone(s) : null;
  }

  /** Create a stack from 2+ tab ids. A tab already in a stack is moved, never double-listed. */
  create(tabIds: number[], name = '', colorIndex = 0): { ok: true; stack: TabStack } | { ok: false; error: string } {
    const ids = [...new Set(tabIds)].filter((n) => Number.isInteger(n) && n >= 0);
    if (ids.length < 2) return { ok: false, error: 'a stack needs at least two tabs' };
    if (this.stacks.length >= MAX_STACKS) return { ok: false, error: `at most ${MAX_STACKS} stacks` };
    for (const s of this.stacks) s.tabs = s.tabs.filter((t) => !ids.includes(t));
    this.stacks = this.stacks.filter((s) => s.tabs.length >= 2);
    const stack: TabStack = {
      id: `st${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: cleanName(name) || `Stack of ${ids.length}`,
      colorIndex: Math.abs(Math.floor(colorIndex)) % STACK_COLORS.length,
      collapsed: false,
      tabs: ids,
      saved: [],
    };
    this.stacks.push(stack);
    return { ok: true, stack: clone(stack) };
  }

  /** Remove a tab from whatever stack holds it. A stack left with <2 tabs dissolves. */
  removeTab(tabId: number) {
    for (const s of this.stacks) s.tabs = s.tabs.filter((t) => t !== tabId);
    this.stacks = this.stacks.filter((s) => s.tabs.length >= 2);
  }

  addTab(stackId: string, tabId: number): boolean {
    const s = this.stacks.find((x) => x.id === stackId);
    if (!s) return false;
    for (const other of this.stacks) other.tabs = other.tabs.filter((t) => t !== tabId);
    s.tabs.push(tabId);
    this.stacks = this.stacks.filter((x) => x.tabs.length >= 2);
    return true;
  }

  /** Collapsing is pure presentation: no tab is closed, unloaded or un-gated. */
  toggleCollapsed(stackId: string, collapsed?: boolean): boolean {
    const s = this.stacks.find((x) => x.id === stackId);
    if (!s) return false;
    s.collapsed = typeof collapsed === 'boolean' ? collapsed : !s.collapsed;
    return true;
  }

  rename(stackId: string, name: string): boolean {
    const s = this.stacks.find((x) => x.id === stackId);
    if (!s) return false;
    const clean = cleanName(name);
    if (!clean) return false;
    s.name = clean;
    return true;
  }

  setColor(stackId: string, colorIndex: number): boolean {
    const s = this.stacks.find((x) => x.id === stackId);
    if (!s) return false;
    s.colorIndex = Math.abs(Math.floor(colorIndex)) % STACK_COLORS.length;
    return true;
  }

  /** Ids to close for "close stack" — the caller runs them through the normal close path. */
  members(stackId: string): number[] {
    return this.stacks.find((x) => x.id === stackId)?.tabs.slice() ?? [];
  }

  dissolve(stackId: string): boolean {
    const before = this.stacks.length;
    this.stacks = this.stacks.filter((s) => s.id !== stackId);
    return this.stacks.length !== before;
  }

  /**
   * Reconcile against live tab ids: drop dead ids, and remember the URLs of tabs that survive so a
   * stack can be rebuilt after a restart. Called whenever tabs open/close.
   */
  reconcile(liveIds: number[], urls: Map<number, { url: string; title: string }>): void {
    for (const s of this.stacks) {
      s.tabs = s.tabs.filter((t) => liveIds.includes(t));
      const known = s.tabs.map((t) => urls.get(t)).filter((x): x is { url: string; title: string } => !!x);
      if (known.length) s.saved = known.slice(0, 50);
    }
    this.stacks = this.stacks.filter((s) => s.tabs.length >= 2);
  }

  flush(file: string) {
    atomicWriteFile(file, JSON.stringify({ version: 1, stacks: this.stacks }, null, 2) + '\n');
  }

  static load(file: string): { model: StackModel; loadError: string | null } {
    const r = loadJson(file, FileSchema, { fallback: { version: 1, stacks: [] } });
    return { model: new StackModel(r.value.stacks), loadError: r.loadError };
  }
}

const clone = (s: TabStack): TabStack => ({ ...s, tabs: s.tabs.slice(), saved: s.saved.map((t) => ({ ...t })) });


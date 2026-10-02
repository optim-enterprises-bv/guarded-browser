// Bookmarks panel extras for ticket 33: sort modes, per-folder counts and a Trash.
//
// Kept separate from bookmarks.ts so the store's own rules (nicknames, import, depth) are not
// disturbed by presentation concerns. These are PURE functions over the store's tree plus a small
// trash file, so the rules are unit-testable without a browser.
//
// TRASH DECISION, and it matters: emptying the trash does NOT hard-delete silently. A Trash that
// destroys data on "empty" is a data-loss footgun, so `emptyTrash` reports exactly how many items it
// is about to discard and the caller must pass `confirm: true`. The panel shows the count and asks.
// Nothing is ever hard-deleted by a sort, a restore or a purge triggered by an import.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { BookmarkSchema, FolderSchema, type FolderNode, type Node } from './bookmarks';

export const SORT_MODES = ['manual', 'title', 'url', 'added'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const SortModeSchema = z.enum(SORT_MODES);

/** Per-folder item counts for the right-hand side of each row. Recursive, like the tree. */
export function folderCounts(folder: FolderNode): number {
  let n = 0;
  for (const c of folder.children) {
    n++;
    if (c.type === 'folder') n += folderCounts(c);
  }
  return n;
}

/** A shallow copy of the tree sorted by the chosen mode. `manual` returns the tree untouched. */
export function sortTree(roots: FolderNode[], mode: SortMode): FolderNode[] {
  if (mode === 'manual') return roots;
  const cmp = (a: Node, b: Node): number => {
    if (mode === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (mode === 'url') {
      const ua = a.type === 'bookmark' ? a.url : '';
      const ub = b.type === 'bookmark' ? b.url : '';
      return ua.localeCompare(ub);
    }
    return b.added - a.added; // 'added' — newest first
  };
  const walk = (f: FolderNode): FolderNode => ({
    ...f,
    // folders keep their position relative to each other; only the contents are ordered, so a sort
    // can never move a bookmark out of the folder the user put it in
    children: [...f.children].sort((a, b) => (a.type === b.type ? cmp(a, b) : a.type === 'folder' ? -1 : 1)).map((c) => (c.type === 'folder' ? walk(c) : c)),
  });
  return roots.map(walk);
}

// ------------------------------------ trash ------------------------------------

export const MAX_TRASH = 2000;

const TrashEntrySchema = z
  .object({
    /** the node as it was, so a restore puts back exactly what was removed */
    node: z.union([BookmarkSchema, FolderSchema]),
    /** the folder it came from, so a restore returns it where the user expects */
    parentId: z.string().regex(/^(bar|other|[0-9a-f-]{36})$/),
    /** the index within that folder */
    index: z.number().int().nonnegative(),
    deletedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TrashEntry = z.infer<typeof TrashEntrySchema>;

const TrashFileSchema = z.object({ version: z.literal(1), entries: z.array(TrashEntrySchema).max(MAX_TRASH) }).strict();

export class TrashStore {
  private data: z.infer<typeof TrashFileSchema> = { version: 1, entries: [] };
  readonly loadError: string | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const r = TrashFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (r.success) this.data = r.data;
      else this.loadError = r.error.issues[0]?.message ?? 'invalid';
    } catch (e) {
      this.loadError = (e as Error).message;
    }
  }

  /** Newest first, which is what a Trash list should show. */
  list(): TrashEntry[] {
    return [...this.data.entries].sort((a, b) => b.deletedAt - a.deletedAt).map((e) => structuredClone(e));
  }

  count(): number {
    return this.data.entries.length;
  }

  add(entry: TrashEntry) {
    this.data.entries.push(entry);
    // bounded: the oldest is dropped, and it is dropped because the cap was reached, not silently
    if (this.data.entries.length > MAX_TRASH) this.data.entries = this.data.entries.slice(-MAX_TRASH);
    this.flush();
  }

  get(id: string): TrashEntry | null {
    return this.data.entries.find((e) => e.node.id === id) ?? null;
  }

  remove(id: string): TrashEntry | null {
    const e = this.get(id);
    if (!e) return null;
    this.data.entries = this.data.entries.filter((x) => x.node.id !== id);
    this.flush();
    return e;
  }

  /**
   * Empty the trash. Refuses without `confirm` and always reports the count, so the caller cannot
   * discard data by accident or by a single mis-click.
   */
  empty(confirm: boolean): { ok: boolean; wouldDiscard: number; error?: string } {
    const n = this.data.entries.length;
    if (!n) return { ok: true, wouldDiscard: 0 };
    if (!confirm) return { ok: false, wouldDiscard: n, error: `this would permanently discard ${n} item(s)` };
    this.data.entries = [];
    this.flush();
    return { ok: true, wouldDiscard: n };
  }

  flush() {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// The downloads list shown in the chrome UI. This module OBSERVES transfers; it never decides
// anything. The agent-task staging → confirm → rename flow lives in runtime.ts and is unchanged —
// in particular, an agent download only appears here as "saved" once the user approved it AND the
// transfer completed, so the panel can never advertise a file that was not written.
//
// Chrome-side private data: the agent never gets a reference. The filename and host are page-
// controlled strings and are displayed as text (the renderer never injects them as HTML).

import { basename } from 'node:path';

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'denied' | 'failed';

export interface DownloadEntry {
  id: number;
  /** the page-supplied filename, cleaned and length-capped */
  filename: string;
  /** host the bytes came from */
  host: string;
  url: string;
  /** total bytes when known, else 0 */
  total: number;
  received: number;
  state: DownloadState;
  /** where it was written, once saved */
  path?: string;
  startedAt: number;
  endedAt?: number;
  /** true while the transfer belongs to an agent task (shown as a chip) */
  agentTask: boolean;
  /** who started it */
  source: 'user' | 'agent';
  paused: boolean;
}

export const MAX_FILENAME = 200;
export const MAX_ENTRIES = 200;

const cleanName = (n: string) =>
  basename(n)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME) || 'download';

/** The subset of Electron's DownloadItem this module needs (so it is testable without Electron). */
export interface DownloadItemLike {
  getFilename(): string;
  getURL(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getSavePath(): string;
  isPaused(): boolean;
  canResume(): boolean;
  pause(): void;
  resume(): void;
  cancel(): void;
  on(event: 'updated', cb: (e: unknown, state: string) => void): void;
  on(event: 'done', cb: (e: unknown, state: string) => void): void;
}

export class DownloadList {
  private items: DownloadEntry[] = [];
  private seq = 0;
  private readonly byId = new Map<number, DownloadItemLike>();

  constructor(private readonly onChange: (list: DownloadEntry[]) => void = () => undefined) {}

  /**
   * Record a transfer and subscribe to its progress. Returns the id used by later updates.
   */
  add(item: DownloadItemLike, meta: { agentTask: boolean; host: string; source: 'user' | 'agent' }): number {
    const id = ++this.seq;
    const entry: DownloadEntry = {
      id,
      filename: cleanName(item.getFilename()),
      host: meta.host,
      url: item.getURL().slice(0, 2048),
      total: Math.max(0, item.getTotalBytes()),
      received: Math.max(0, item.getReceivedBytes()),
      state: 'progressing',
      path: item.getSavePath() || undefined,
      startedAt: Date.now(),
      agentTask: meta.agentTask,
      source: meta.source,
      paused: false,
    };
    this.items = [entry, ...this.items].slice(0, MAX_ENTRIES);
    this.byId.set(id, item);
    item.on('updated', () => {
      const e = this.items.find((x) => x.id === id);
      if (!e) return;
      e.received = Math.max(0, item.getReceivedBytes());
      e.total = Math.max(0, item.getTotalBytes()) || e.total;
      e.paused = item.isPaused();
      e.state = e.paused ? 'paused' : 'progressing';
      this.changed();
    });
    item.on('done', (_e, state) => {
      const e = this.items.find((x) => x.id === id);
      if (!e) return;
      e.endedAt = Date.now();
      if (state === 'completed') {
        e.state = 'completed';
        e.path = item.getSavePath() || e.path;
      } else if (state === 'cancelled') e.state = 'cancelled';
      else e.state = 'interrupted';
      this.byId.delete(id);
      this.changed();
    });
    this.changed();
    return id;
  }

  /** The transfer finished and the file was written to `dest` (agent path, after confirmation). */
  saved(id: number, dest: string) {
    const e = this.items.find((x) => x.id === id);
    if (!e) return;
    e.state = 'completed';
    e.path = dest;
    e.endedAt ??= Date.now();
    e.received = e.total || e.received;
    this.changed();
  }

  /** The transfer ended without a saved file (denied, interrupted, cancelled). */
  failed(id: number, why: string) {
    const e = this.items.find((x) => x.id === id);
    if (!e) return;
    e.state = why === 'denied' ? 'denied' : why === 'cancelled' ? 'cancelled' : 'interrupted';
    e.endedAt ??= Date.now();
    this.changed();
  }

  /** pause / resume / cancel / remove — the panel's buttons. Returns false when not applicable. */
  action(id: number, what: 'pause' | 'resume' | 'cancel' | 'remove') {
    const e = this.items.find((x) => x.id === id);
    const item = this.byId.get(id);
    if (!e) return false;
    if (what === 'remove') {
      if (e.state === 'progressing' || e.state === 'paused') return false; // an active transfer is not removable
      this.items = this.items.filter((x) => x.id !== id);
      this.byId.delete(id);
      this.changed();
      return true;
    }
    if (!item) return false;
    if (what === 'pause' && !item.isPaused()) item.pause();
    else if (what === 'resume' && item.isPaused() && item.canResume()) item.resume();
    else if (what === 'cancel') item.cancel();
    else return false;
    this.changed();
    return true;
  }

  list(): DownloadEntry[] {
    return this.items.map((e) => ({ ...e }));
  }

  /** number of transfers still running (for the toolbar badge) */
  get activeCount() {
    return this.items.filter((e) => e.state === 'progressing' || e.state === 'paused').length;
  }

  clearFinished() {
    this.items = this.items.filter((e) => e.state === 'progressing' || e.state === 'paused');
    this.changed();
  }

  private changed() {
    this.onChange(this.list());
  }
}

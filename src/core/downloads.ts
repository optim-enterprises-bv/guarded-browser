// The downloads list shown in the chrome UI. This module OBSERVES transfers; it never decides
// anything. The agent-task staging → confirm → rename flow lives in runtime.ts and is unchanged —
// in particular, an agent download only appears here as "saved" once the user approved it AND the
// transfer completed, so the panel can never advertise a file that was not written.
//
// Chrome-side private data: the agent never gets a reference. The filename and host are page-
// controlled strings and are displayed as text (the renderer never injects them as HTML).

import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';

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
  /** a dangerous-file warning (executable / script type, or a disguised double extension); '' when none */
  warning: string;
}

export const MAX_FILENAME = 200;
export const MAX_ENTRIES = 200;

const cleanName = (n: string) =>
  basename(n)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME) || 'download';

// ---------------------------------------------------------------- dangerous-file classification
//
// One rule for every file the browser writes: a page download and a mail attachment get the SAME
// warning from the same function. The lists are deliberately broad — a false "this can run code" on a
// .py file costs a glance; a missing one on a .lnk can cost the machine.

/** extensions that run code when opened (Windows, macOS, Linux, cross-platform script hosts, macro documents, auto-mounting images) */
export const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'msi', 'msp', 'mst', 'msc', 'dll', 'cpl', 'ocx', 'sys', 'drv',
  'jar', 'js', 'jse', 'mjs', 'vbs', 'vbe', 'wsf', 'wsh', 'ws', 'wsc', 'ps1', 'psm1', 'psd1', 'ps1xml', 'hta', 'lnk', 'reg', 'inf', 'scf', 'url', 'chm', 'gadget', 'application', 'appref-ms', 'xbap', 'msix', 'appx', 'appxbundle',
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'run', 'elf', 'appimage', 'deb', 'rpm', 'apk', 'desktop', 'flatpakref',
  'app', 'command', 'tool', 'workflow', 'dmg', 'pkg', 'mpkg', 'scpt', 'applescript',
  'py', 'pyw', 'pyc', 'pl', 'rb', 'php', 'lua', 'tcl', 'awk',
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm',
  'iso', 'img', 'vhd', 'vhdx',
]);

/** declared types that mean "a program or a script", whatever the name says */
const EXECUTABLE_MIME =
  /^(?:application\/(?:x-msdownload|x-msdos-program|x-ms-installer|x-msi|vnd\.microsoft\.portable-executable|x-dosexec|x-executable|x-elf|x-mach-binary|x-sh|x-shellscript|x-csh|x-bat|x-msbatch|hta|x-ms-shortcut|java-archive|x-java-archive|javascript|x-javascript|ecmascript|x-python|x-python-code|x-perl|x-ruby|x-php|x-apple-diskimage|x-iso9660-image|x-powershell|x-ms-application|vnd\.ms-word\.document\.macroenabled\.12|vnd\.ms-excel\.sheet\.macroenabled\.12|vnd\.ms-powerpoint\.presentation\.macroenabled\.12)|text\/(?:javascript|ecmascript|jscript|vbscript|x-vbscript|x-sh|x-shellscript|x-python|x-perl|x-script(?:\.[a-z]+)?))$/i;

/** what a disguise pretends to be: a document, picture, archive or media type */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'md',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg',
  'zip', 'rar', '7z', 'tar', 'gz', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'm4a', 'html', 'htm', 'eml', 'ics', 'vcf', 'xml', 'json',
]);

export interface FileRisk {
  /** opening it can run code (by extension or by declared type) */
  executable: boolean;
  /** `invoice.pdf.exe`: a harmless-looking inner extension in front of an executable one */
  doubleExtension: boolean;
  /** the sentence the UI shows; '' when there is nothing to warn about */
  warning: string;
}

/** Classify a (sanitized) file name and its declared type. Pure; the UI shows `warning` as text. */
export function fileRisk(name: string, mime = ''): FileRisk {
  const lower = String(name ?? '').toLowerCase();
  const exts = lower.split('.').slice(1).map((e) => e.trim());
  const last = exts.at(-1) ?? '';
  const byExt = EXECUTABLE_EXTENSIONS.has(last);
  const byMime = EXECUTABLE_MIME.test(String(mime ?? '').trim());
  const executable = byExt || byMime;
  const inner = exts.length >= 2 ? exts[exts.length - 2] : '';
  const doubleExtension = byExt && DOCUMENT_EXTENSIONS.has(inner);
  let warning = '';
  if (doubleExtension) warning = `disguised file: it looks like a .${inner} but is a .${last}, which can run programs on this computer`;
  else if (byExt) warning = `.${last} files can run programs or scripts on this computer`;
  else if (byMime) warning = `declared as ${String(mime).toLowerCase().slice(0, 80)}, a program or script type`;
  return { executable, doubleExtension, warning };
}

/**
 * A unique path for `name` in `dir`: never an existing file (`report.pdf`, `report (1).pdf`, ...).
 * Path separators, NUL and leading dots in the name are neutralised here too, so a caller that forgot
 * to sanitize still cannot escape `dir`.
 */
export function uniquePath(dir: string, name: string): string {
  const safe = name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '_') || 'download';
  const dot = safe.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
  for (let i = 0; ; i++) {
    const p = join(dir, i === 0 ? safe : `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

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
    const filename = cleanName(item.getFilename());
    const entry: DownloadEntry = {
      id,
      filename,
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
      warning: fileRisk(filename).warning,
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

  /**
   * A file main wrote itself, already complete (a mail attachment the user clicked). It joins the same
   * list, with the same dangerous-file warning, as a page download; there is no transfer to control.
   */
  addFile(meta: { filename: string; host: string; path: string; bytes: number; mime?: string }): number {
    const id = ++this.seq;
    const filename = cleanName(meta.filename);
    const now = Date.now();
    this.items = [
      {
        id,
        filename,
        host: meta.host,
        url: '',
        total: Math.max(0, meta.bytes),
        received: Math.max(0, meta.bytes),
        state: 'completed' as const,
        path: meta.path,
        startedAt: now,
        endedAt: now,
        agentTask: false,
        source: 'user' as const,
        paused: false,
        warning: fileRisk(filename, meta.mime ?? '').warning,
      },
      ...this.items,
    ].slice(0, MAX_ENTRIES);
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

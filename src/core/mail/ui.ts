// Mail UI model (ticket 37) — pure, no Electron, no DOM.
//
// Everything the mail window DECIDES lives here so it is unit-testable in milliseconds and so the
// window code has no rules of its own: which rows the view shows, how a search box becomes a safe FTS
// expression, how the folder tree is assembled with its counters, and what a list row looks like.
//
// Two things this module deliberately does NOT do:
//   * it never renders HTML. A row's strings are text, always; the window sets them as text nodes.
//   * it never reads a message body for display except through the store, and the body it returns is
//     the ALREADY-STRIPPED text the store kept (no HTML ever survived parsing).

import { ftsQuery, type MessageRow, type MessageCounts, type MailFolder, type FolderKind } from './store';

/** Vivaldi's view toggles, as a value object rather than seven booleans threaded through the UI. */
export interface ViewFilter {
  /** the read-state row that is selected: All / Unseen / Unread / Read */
  read: 'all' | 'unseen' | 'unread' | 'read';
  showJunk: boolean;
  showTrash: boolean;
  showArchive: boolean;
  showCustomFolders: boolean;
  showMailingLists: boolean;
  showFeeds: boolean;
}

/** The screenshot's default: the unread-oriented view with list mail folded away. */
export const DEFAULT_VIEW: ViewFilter = {
  read: 'all',
  showJunk: false,
  showTrash: false,
  showArchive: true,
  showCustomFolders: true,
  showMailingLists: true,
  showFeeds: true,
};

export const VIEW_TOGGLES: Array<{ key: keyof Omit<ViewFilter, 'read'>; label: string }> = [
  { key: 'showCustomFolders', label: 'Show Custom Folders' },
  { key: 'showMailingLists', label: 'Show Mailing Lists' },
  { key: 'showFeeds', label: 'Show Feeds' },
  { key: 'showJunk', label: 'Show Junk' },
  { key: 'showArchive', label: 'Show Archive' },
  { key: 'showTrash', label: 'Show Trashed Items' },
];

/** What a filter change does to the store query, so the UI never builds a query itself. */
export function filterToQuery(f: ViewFilter): {
  unseen?: boolean;
  unread?: boolean;
  junk?: boolean;
  folderKinds?: FolderKind[];
} {
  return {
    ...(f.read === 'unseen' ? { unseen: true } : {}),
    ...(f.read === 'unread' ? { unread: true } : {}),
    // a hidden category is EXCLUDED, not merely not-requested — otherwise "show junk off" still
    // lists junk from the folders the user is looking at
    junk: f.showJunk ? undefined : false,
  };
}

/** Folders the view hides, by role, so the tree and the list agree. */
export function hiddenFolders(f: ViewFilter, folders: MailFolder[]): Set<string> {
  const out = new Set<string>();
  for (const fo of folders) {
    if (fo.kind === 'junk' && !f.showJunk) out.add(fo.path);
    if (fo.kind === 'trash' && !f.showTrash) out.add(fo.path);
    if (fo.kind === 'archive' && !f.showArchive) out.add(fo.path);
  }
  return out;
}

// ---------------------------------------------------------------- search

export type SearchOperator = 'and' | 'or' | 'not';

export interface SearchTerm {
  field: 'from' | 'to' | 'subject' | 'body' | 'any';
  value: string;
}

export interface ParsedSearch {
  terms: SearchTerm[];
  operators: SearchOperator[];
  /** the FTS5 expression this search becomes, or null when there is nothing to search on */
  fts: string | null;
  /** true when the query contained a field prefix or a capitalised operator (shown in the UI) */
  advanced: boolean;
}

const FIELDS = new Set(['from', 'to', 'subject', 'body']);

/**
 * Parse a search box into terms + operators, then into a SAFE FTS5 expression.
 *
 * This is a security boundary. A search box is user input that reaches SQL, and FTS5 has an
 * expression language (`"`, `*`, `NEAR(`, `^`, column filters, `OR`). Rather than escape it, the
 * query is taken apart into terms whose values are reduced to letters/digits/underscore and emitted
 * as prefix matches, joined by the operator set this parser recognises. Nothing a user can type
 * reaches MATCH as syntax — the worst case is that their punctuation is ignored.
 *
 * Capitalised `AND` / `OR` / `NOT` are the operators (Vivaldi's own convention, and it is why the
 * capitalisation is significant here).
 */
export function parseMailSearch(q: string, maxTerms = 12): ParsedSearch {
  const raw = String(q ?? '').trim();
  if (!raw) return { terms: [], operators: [], fts: null, advanced: false };
  const tokens = raw.split(/\s+/).slice(0, 200);
  const terms: SearchTerm[] = [];
  const operators: SearchOperator[] = [];
  let advanced = false;
  let pendingOp: SearchOperator = 'and';
  /** a leading NOT cannot be expressed in FTS5 (a pure negation matches nothing) */
  let leadingNot = false;

  for (const tok of tokens) {
    const op = /^(AND|OR|NOT)$/.exec(tok);
    if (op) {
      pendingOp = op[1].toLowerCase() as SearchOperator;
      advanced = true;
      continue;
    }
    if (terms.length >= maxTerms) break; // the cap is on what is KEPT, not on what is read
    if (terms.length) operators.push(pendingOp);
    else if (pendingOp === 'not') leadingNot = true;
    pendingOp = 'and';
    const m = /^([a-zA-Z]+):(.*)$/.exec(tok);
    if (m && FIELDS.has(m[1].toLowerCase())) {
      advanced = true;
      terms.push({ field: m[1].toLowerCase() as SearchTerm['field'], value: m[2] });
      continue;
    }
    terms.push({ field: 'any', value: tok });
  }

  // A search box cannot start with NOT: "NOT x" would have to match everything except x, and an
  // FTS5 expression cannot say that. Silently returning `x` would INVERT what the user asked for, so
  // the search is refused (the UI reports it) rather than quietly meaning the opposite.
  const fts = leadingNot ? null : buildFts(terms, operators, maxTerms);
  return { terms, operators, fts, advanced };
}

/** Reduce a value to safe tokens and emit a prefix term, or null when nothing survives. */
function safeTokens(value: string): string[] {
  return String(value ?? '')
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function termToFts(t: SearchTerm): string | null {
  const toks = safeTokens(t.value);
  if (!toks.length) return null;
  const joined = toks.map((x) => `${x}*`).join(' AND ');
  switch (t.field) {
    case 'from':
      return `(fromName:${joined} OR fromAddr:${joined})`;
    case 'to':
      return `toAddrs:${joined}`;
    case 'subject':
      return `subject:${joined}`;
    case 'body':
      return `bodyText:${joined}`;
    default:
      return `(${joined})`;
  }
}

/**
 * Join terms with the operators the user actually wrote. `NOT` binds to the NEXT term only, which is
 * what a search box user means by it; an expression that would start with an operator drops it,
 * because `NOT x` alone cannot be a MATCH expression in FTS5.
 */
export function buildFts(terms: SearchTerm[], operators: SearchOperator[], maxTerms = 12): string | null {
  if (operators[0] === 'not') return null; // see parseMailSearch: a leading NOT is refused, not inverted
  const parts: string[] = [];
  let i = 0;
  let negateNext = false;
  let pending: SearchOperator | null = null;
  for (const t of terms.slice(0, maxTerms)) {
    const op = i > 0 ? (operators[i - 1] ?? 'and') : null;
    const expr = termToFts(t);
    i++;
    if (!expr) continue;
    if (op === 'not') negateNext = true;
    const piece = negateNext ? `NOT ${expr}` : expr;
    // FTS5 refuses a leading binary operator: drop it rather than emit an invalid MATCH
    parts.push(pending && parts.length ? `${pending.toUpperCase()} ${piece}` : piece);
    pending = op === 'not' ? null : op;
    negateNext = false;
  }
  if (!parts.length) return null;
  const out = parts.join(' ').trim();
  // `NOT x` with nothing before it is not a valid expression; the caller falls back to no search
  return /^NOT\b/.test(out) ? null : out;
}

/** The fallback used only when a search is too exotic for FTS: a plain AND of its safe tokens. */
export function fallbackSearch(q: string): string | null {
  return ftsQuery(q);
}

// ---------------------------------------------------------------- folder tree

export interface TreeCounts {
  unseen: number;
  unread: number;
  total: number;
}

export interface TreeRow {
  kind: 'folder' | 'label' | 'view';
  id: string;
  label: string;
  counts: TreeCounts;
  /** the view filter a row selects, when it is one of the read-state rows */
  view?: ViewFilter['read'];
  depth: number;
  /** roles hidden by the current view are still returned, but marked, so the UI can show them greyed */
  hidden?: boolean;
}

export interface TreeSection {
  id: 'all-messages' | 'custom-folders' | 'mailing-lists' | 'filters' | 'flags' | 'labels' | 'feeds';
  label: string;
  rows: TreeRow[];
}

export const SEARCH_OPERATORS: SearchOperator[] = ['and', 'or', 'not'];

/** tree row ids of the two local roles (ticket 38) */
export const LOCAL_DRAFTS = 'local:drafts';
export const LOCAL_OUTBOX = 'local:outbox';

const ZERO: TreeCounts = { unseen: 0, unread: 0, total: 0 };

/**
 * Assemble the panel tree in the order the screenshot shows: All Messages (Unread / Received / Sent /
 * Drafts / Outbox / Spam / Trash / Archive), then Custom Folders, Mailing Lists, Filters, Flags,
 * Labels, Feeds. Counters are per row: unseen, unread and total, because the screenshot's chips show
 * two numbers (new mail, then total).
 *
 * A folder's role decides where it lands; an unrecognised folder is a custom folder, never dropped.
 */
export function buildFolderTree(
  folders: MailFolder[],
  counts: Array<{ folder: string; kind: FolderKind; counts: MessageCounts }>,
  labels: Array<{ id: string; name: string }> = [],
  filters: Array<{ id: string; name: string }> = [],
  view: ViewFilter = DEFAULT_VIEW,
  /** ticket 38: local drafts and the outbox (failed = items waiting for a Retry) */
  local: { drafts: number; outbox: number; outboxFailed: number } = { drafts: 0, outbox: 0, outboxFailed: 0 },
): TreeSection[] {
  const byPath = new Map(counts.map((c) => [c.folder, c.counts]));
  const hidden = hiddenFolders(view, folders);
  const countsFor = (path: string): TreeCounts => {
    const c = byPath.get(path);
    return c ? { unseen: c.unseen, unread: c.unread, total: c.total } : { ...ZERO };
  };
  // a role's counters are the SUM over every folder with that role, so a server with two Sent
  // folders does not show two Sent rows with half the numbers each
  const sumFor = (kind: FolderKind): TreeCounts => {
    const out = { ...ZERO };
    for (const f of folders) {
      if (f.kind !== kind) continue;
      const c = countsFor(f.path);
      out.unseen += c.unseen;
      out.unread += c.unread;
      out.total += c.total;
    }
    return out;
  };
  const folderOf = (kind: FolderKind) => folders.find((f) => f.kind === kind);

  const roleRow = (kind: FolderKind, label: string, viewKey?: ViewFilter['read']): TreeRow => ({
    kind: viewKey ? 'view' : 'folder',
    id: viewKey ? `view:${viewKey}` : (folderOf(kind)?.path ?? `role:${kind}`),
    label,
    counts: sumFor(kind),
    ...(viewKey ? { view: viewKey } : {}),
    depth: 1,
    ...(hidden.has(folderOf(kind)?.path ?? '') ? { hidden: true } : {}),
  });

  // The reference panel's All Messages section has exactly ONE read-state row: "Unread". (An earlier
  // draft added an invented "Unseen" row beside it; the screenshot does not have one, and inventing a
  // row is how a UI stops matching the thing it was measured from.) The store still keeps `seen` and
  // `readFlag` apart — that is what the row's two chips are.
  const allMessages: TreeRow[] = [
    { kind: 'view', id: 'view:unread', label: 'Unread', counts: allCounts(counts).unreadPart, view: 'unread', depth: 1 },
    roleRow('inbox', 'Received', 'all'),
    roleRow('sent', 'Sent'),
    // Drafts and Outbox are LOCAL (ticket 38): the rows open the store's drafts / outbox, and a server
    // Drafts folder's messages are listed under the same row
    { ...roleRow('drafts', 'Drafts'), id: LOCAL_DRAFTS, counts: { ...sumFor('drafts'), total: sumFor('drafts').total + local.drafts } },
    { ...roleRow('outbox', 'Outbox'), id: LOCAL_OUTBOX, counts: { unseen: local.outboxFailed, unread: 0, total: local.outbox } },
    roleRow('junk', 'Spam'),
    roleRow('trash', 'Trash'),
    roleRow('archive', 'Archive'),
  ];

  const custom = folders.filter((f) => f.kind === 'folder' && !f.hidden).map((f) => ({ kind: 'folder' as const, id: f.path, label: f.name || f.path, counts: countsFor(f.path), depth: 1 }));
  const mailing = folders.filter((f) => /^(mailing lists?|lists?)$/i.test(f.name)).map((f) => ({ kind: 'folder' as const, id: f.path, label: f.name, counts: countsFor(f.path), depth: 1 }));

  return [
    { id: 'all-messages', label: 'All Messages', rows: allMessages },
    { id: 'custom-folders', label: 'Custom Folders', rows: custom },
    { id: 'mailing-lists', label: 'Mailing Lists', rows: mailing },
    { id: 'filters', label: 'Filters', rows: filters.map((f) => ({ kind: 'view' as const, id: `filter:${f.id}`, label: f.name, counts: { ...ZERO }, depth: 1 })) },
    { id: 'flags', label: 'Flags', rows: [] },
    { id: 'labels', label: 'Labels', rows: labels.map((l) => ({ kind: 'label' as const, id: `label:${l.id}`, label: l.name, counts: { ...ZERO }, depth: 1 })) },
    { id: 'feeds', label: 'Feeds', rows: [] },
  ];
}

/**
 * The two chips the screenshot shows next to a folder: the count of messages with unread meaning
 * (never seen OR seen-but-not-dealt-with) and the total. Kept as a pair so the UI cannot show one
 * number where the reference shows two.
 */
function allCounts(counts: Array<{ counts: MessageCounts }>): { unseenPart: TreeCounts; unreadPart: TreeCounts } {
  let unseen = 0;
  let unread = 0;
  let total = 0;
  let read = 0;
  for (const c of counts) {
    unseen += c.counts.unseen;
    unread += c.counts.unread;
    total += c.counts.total;
    read += c.counts.total - c.counts.unseen - c.counts.unread;
  }
  return {
    unseenPart: { unseen, unread: 0, total: unseen + unread },
    unreadPart: { unseen: unread, unread: 0, total: unread + read },
  };
}

// ---------------------------------------------------------------- list rows

export interface ListRow {
  id: number;
  from: string;
  subject: string;
  preview: string;
  /** the list shows a short form; the full header is available in the reading pane */
  time: string;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  folder: string;
  threadId: string;
  threadCount: number;
  labels: string[];
}

/** A one-line preview: whitespace collapsed, capped, and never markup (the store already stripped it). */
export function previewText(body: string, max = 90): string {
  return String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Group rows into threads for display (Vivaldi's default is threaded). A thread is whatever the sync
 * layer stored as `threadId` — never a subject guess, because two different conversations with the
 * same subject are not one thread.
 */
export interface ThreadGroup {
  threadId: string;
  rows: MessageRow[];
  /** the newest member is the row the list shows */
  head: MessageRow;
}

export function groupThreads(rows: MessageRow[]): ThreadGroup[] {
  const byThread = new Map<string, MessageRow[]>();
  for (const r of rows) {
    const key = r.messageId || r.threadId || `solo:${r.id}`;
    const list = byThread.get(key);
    if (list) list.push(r);
    else byThread.set(key, [r]);
  }
  const out: ThreadGroup[] = [];
  for (const [threadId, list] of byThread) {
    list.sort((a, b) => b.receivedAt - a.receivedAt);
    out.push({ threadId, rows: list, head: list[0] });
  }
  out.sort((a, b) => b.head.receivedAt - a.head.receivedAt);
  return out;
}

export function listRowFrom(m: MessageRow, threadCount = 1, labels: string[] = []): ListRow {
  return {
    id: m.id,
    from: displayName(m.fromName, m.fromAddr),
    subject: m.subject || '(no subject)',
    preview: previewText(''),
    time: relativeTime(m.receivedAt),
    unread: !m.readFlag,
    flagged: m.flagged,
    hasAttachments: m.hasAttachments,
    folder: m.folder,
    threadId: m.messageId || m.threadId,
    threadCount,
    labels,
  };
}

/** `Ada Lovelace <ada@x>` shows as `Ada Lovelace`; a bare address shows as the address. */
export function displayName(name: string, addr: string): string {
  const n = String(name ?? '').trim();
  if (n) return n;
  const a = String(addr ?? '').trim();
  return a || '(unknown sender)';
}

const DAY = 86_400_000;

/**
 * Today / Yesterday / a date, matching the screenshot's `Today 02:51 AM`, `Yesterday 09:08 PM`.
 * Times are rendered in the LOCAL zone, and a future timestamp (a server with a bad clock) reads as
 * the time rather than as a negative age.
 */
export function relativeTime(t: number, now = Date.now(), locale = 'en-GB'): string {
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const clock = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: true });
  // `t >= startOfToday` alone calls a date SIX DAYS IN THE FUTURE "Today"; the window must be a day
  const isToday = t >= startOfToday && t < startOfToday + DAY;
  if (isToday) return `Today ${clock}`;
  if (t >= startOfToday - DAY && t < startOfToday) return `Yesterday ${clock}`;
  // a clock ahead of ours: show a plain date rather than a negative age or a misleading "Today"
  if (t >= startOfToday + DAY) return d.toLocaleDateString(locale, d.getFullYear() === today.getFullYear() ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(locale, sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
}

/** The reading pane's header fields, straight from the row (no body needed). */
export function readingHeader(m: MessageRow): Array<{ label: string; value: string }> {
  return [
    { label: 'From', value: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr },
    { label: 'To', value: m.toAddrs },
    ...(m.ccAddrs ? [{ label: 'Cc', value: m.ccAddrs }] : []),
    ...(m.replyTo ? [{ label: 'Reply-To', value: m.replyTo }] : []),
    { label: 'Date', value: m.sentAt ? new Date(m.sentAt).toLocaleString('en-GB') : '' },
  ];
}

/**
 * The remote-content decision, as a value: the client NEVER loads it, and the banner says so. The
 * strings are user-visible, so they live here where a test can assert the wording.
 */
export function externalContentNotice(remoteContent: boolean): string {
  return remoteContent
    ? 'This message was prevented from loading external content.'
    : '';
}

export const LOAD_EXTERNAL_LABEL = 'Load External Content';
/** The banner over an HTML message that references remote images (blocked until the user asks). */
export const REMOTE_IMAGES_NOTICE = 'Remote images are blocked.';
export const COMPOSE_PLACEHOLDER = 'Write a quick reply here';
export const SEND_LABEL = 'Send';
export const INCLUDE_QUOTED_LABEL = 'Include Quoted Text';
export const MAIL_SEARCH_PLACEHOLDER = 'Mail Search';

/** Toolbar buttons in the message view, in the screenshot's order. */
export const MESSAGE_ACTIONS = [
  { id: 'reply', label: 'Reply' },
  { id: 'replyAll', label: 'Reply to All' },
  { id: 'forward', label: 'Forward' },
  { id: 'flag', label: 'Flag' },
  { id: 'label', label: 'Label' },
  { id: 'unread', label: 'Mark Unread' },
  { id: 'archive', label: 'Archive' },
  { id: 'move', label: 'Move to Folder' },
  { id: 'delete', label: 'Delete' },
] as const;

export const UNREAD_BADGE_MAX = 99;

/** The rail badge: total unread-ish mail across every account, capped so the chip cannot grow. */
export function badgeCount(counts: Array<Pick<MessageCounts, 'unseen' | 'unread'>>): number {
  let n = 0;
  for (const c of counts) n += c.unseen + c.unread;
  return Math.min(n, UNREAD_BADGE_MAX);
}

export function badgeLabel(n: number): string {
  return n <= 0 ? '' : n > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(n);
}

// Safe inbox triage (AI capabilities item 4), the main-process half.
//
// What this module does, and the order it does it in, for each message of a run:
//   1. the gate (no agent task running, no confirmation pending) — checked before EVERY message, and a
//      task starting aborts the run and its in-flight request (MailController.disconnectAll);
//   2. the stored text body (fetched with BODY.PEEK through the gated syncer when it was never
//      fetched; the message is NOT marked read);
//   3. core/mail/triage.ts picks the allowed fields, caps them and guard-screens them;
//   4. the cache (per message id + model, keyed by a hash of exactly that input) or ONE request to
//      the quarantined `triage` role — no tools, one message per request, one request at a time;
//   5. strict validation; anything invalid is category "other" and nothing else.
// The result is shown to the user. NOTHING here acts on it: every action is planned from the user's
// choice (a category or a selection), shown as the exact list of messages, and executed only when
// the user approves that list (`plan` -> `apply` with the plan's one-time token). No path here can
// send, forward, open a link or open an attachment, and no model output names a message to act on.

import { randomUUID } from 'node:crypto';
import type { StreamRequest, StreamResult } from '../../core/llm';
import { StreamAbortedError } from '../../core/llm';
import type { Guard } from '../../core/types';
import type { MailFolder, MailStore, MessageRow } from '../../core/mail/store';
import {
  CATEGORIES,
  SAFE_DEFAULT,
  TRIAGE_LIMITS,
  TriageFactsSchema,
  applyFilter,
  buildDraftMessages,
  buildTriageMessages,
  categoryTotals,
  cleanDraft,
  inputHash,
  isFilter,
  parseTriage,
  screenLabel,
  screenTriageInput,
  sortByDue,
  triageInputFrom,
  type Category,
  type TriageFacts,
  type TriageRow,
} from '../../core/mail/triage';

export interface TriageLlm {
  stream(req: StreamRequest, onDelta: (d: string) => void, signal?: AbortSignal): Promise<StreamResult>;
}

export interface MailTriageDeps {
  store: () => MailStore;
  /** the mail gate: refused while an agent task runs or a confirmation is pending */
  canConnect: () => { ok: boolean; reason?: string };
  audit: (kind: string, detail: Record<string, unknown>) => void;
  guard: () => Guard;
  /** the quarantined `triage` role's client (streamBody: no tools, ever) */
  client: () => TriageLlm;
  /** the primary endpoint's identity, the cache key's model part */
  modelId: () => string;
  /** the "mail text goes to <host>" notice when the role's cloud fallback is ON, else null */
  fallbackNotice: () => string | null;
  /** fetch a never-fetched body through the gated syncer, without marking the message read */
  fetchBody: (row: MessageRow) => Promise<boolean>;
  accountIds: () => string[];
  folders: (accountId: string) => MailFolder[];
  archiveFolder: (accountId: string) => string;
  /** the existing gated mail actions (one account + folder per call) */
  move: (ids: number[], to: string) => Promise<{ ok: boolean; error?: string }>;
  setFlags: (ids: number[], patch: { flagged: boolean }) => Promise<{ ok: boolean; error?: string }>;
  /** the reply prefill (recipients and subject from the STORED row) and the local draft save */
  composeInit: (id: number) => Record<string, unknown> & { ok: boolean; error?: string };
  draftSave: (fields: Record<string, unknown>) => { ok: boolean; id?: string; error?: string };
  now?: () => number;
}

export type TriageRange = { kind: 'unread' } | { kind: 'days'; days: number } | { kind: 'folder'; folder: string };
export type TriageAction = 'archive' | 'move' | 'flag' | 'label';

export const RUN_DEFAULT = 50;
export const RUN_MAX = 200;
export const MAX_DAYS = 365;
export const PLAN_TTL_MS = 10 * 60_000;
export const MAX_PLAN = 500;
/** folders a range other than "current folder" never triages */
const SKIP_KINDS = new Set(['trash', 'junk', 'sent', 'drafts', 'outbox']);

const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function parseRunOpts(o: unknown): { ok: true; accountId: string; range: TriageRange; max: number } | { ok: false; error: string } {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const accountId = typeof x.accountId === 'string' ? x.accountId.slice(0, 64) : '';
  if (!accountId) return { ok: false, error: 'choose an account (or all accounts)' };
  const r = (x.range && typeof x.range === 'object' ? x.range : {}) as Record<string, unknown>;
  let range: TriageRange;
  if (r.kind === 'unread') range = { kind: 'unread' };
  else if (r.kind === 'days') {
    const days = Math.floor(Number(r.days));
    if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) return { ok: false, error: `the number of days must be 1..${MAX_DAYS}` };
    range = { kind: 'days', days };
  } else if (r.kind === 'folder') {
    const folder = typeof r.folder === 'string' ? r.folder.slice(0, 255) : '';
    if (!folder) return { ok: false, error: 'no folder is selected' };
    range = { kind: 'folder', folder };
  } else return { ok: false, error: 'unknown range' };
  const max = x.max === undefined ? RUN_DEFAULT : Math.floor(Number(x.max));
  if (!Number.isFinite(max) || max < 1 || max > RUN_MAX) return { ok: false, error: `a run triages 1..${RUN_MAX} messages` };
  return { ok: true, accountId, range, max };
}

interface Run {
  id: string;
  ctl: AbortController;
  accounts: string[];
  range: TriageRange;
  total: number;
  done: number;
  cached: number;
  fetched: number;
  invalid: number;
  guardDrops: number;
  labelDrops: number;
  screened: boolean;
  usedFallback: boolean;
  model: string;
  running: boolean;
  /** why the run ended early ('' = it did not) */
  stopped: string;
  error: string;
}

interface Plan {
  token: string;
  action: TriageAction;
  target: string;
  ids: number[];
  expires: number;
}

export class MailTriage {
  private run: Run | null = null;
  private rows: TriageRow[] = [];
  private plan: Plan | null = null;
  private draftCtl: AbortController | null = null;

  constructor(private readonly deps: MailTriageDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  get busy(): boolean {
    return !!this.run?.running || !!this.draftCtl;
  }

  /** The messages a run covers, newest first, capped. Only stored rows; nothing is listed from a server. */
  candidates(accountId: string, range: TriageRange, max: number): MessageRow[] {
    const store = this.deps.store();
    const accounts = accountId === 'all' ? this.deps.accountIds() : this.deps.accountIds().filter((a) => a === accountId);
    const out: MessageRow[] = [];
    for (const acc of accounts) {
      const skip = new Set(this.deps.folders(acc).filter((f) => SKIP_KINDS.has(f.kind)).map((f) => f.path));
      const listed = store.listMessages({
        accountId: acc,
        junk: range.kind === 'folder' ? undefined : false,
        folder: range.kind === 'folder' ? range.folder : undefined,
        notRead: range.kind === 'unread' ? true : undefined,
        since: range.kind === 'days' ? this.now() - range.days * 86_400_000 : undefined,
        limit: max,
      }).messages;
      out.push(...listed.filter((m) => range.kind === 'folder' || !skip.has(m.folder)));
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt || b.id - a.id).slice(0, max);
  }

  /** Start a run. Returns at once; the renderer polls `state`. Refused during a task. */
  start(opts: unknown): { ok: boolean; error?: string; refused?: string; total?: number } {
    const p = parseRunOpts(opts);
    if (!p.ok) return { ok: false, error: p.error };
    if (this.busy) return { ok: false, error: 'triage is already running: press Stop first' };
    const accounts = p.accountId === 'all' ? this.deps.accountIds() : this.deps.accountIds().filter((a) => a === p.accountId);
    if (!accounts.length) return { ok: false, error: 'unknown account' };
    const gate = this.deps.canConnect();
    if (!gate.ok) {
      this.deps.audit('triage', { action: 'run', accounts, range: p.range.kind, refused: gate.reason ?? 'refused', messages: 0 });
      return { ok: false, refused: gate.reason ?? 'mail cannot run triage right now' };
    }
    const list = this.candidates(p.accountId, p.range, p.max);
    this.plan = null;
    this.rows = [];
    this.run = {
      id: randomUUID().slice(0, 8),
      ctl: new AbortController(),
      accounts,
      range: p.range,
      total: list.length,
      done: 0,
      cached: 0,
      fetched: 0,
      invalid: 0,
      guardDrops: 0,
      labelDrops: 0,
      screened: true,
      usedFallback: false,
      model: this.deps.modelId(),
      running: true,
      stopped: '',
      error: '',
    };
    void this.loop(this.run, list);
    return { ok: true, total: list.length };
  }

  /** Stop: the in-flight request is aborted and nothing after it runs. */
  stop(reason = 'stopped by the user') {
    if (this.run?.running) {
      this.run.stopped ||= reason;
      this.run.ctl.abort();
    }
    this.draftCtl?.abort();
  }

  private async loop(run: Run, list: MessageRow[]) {
    const store = this.deps.store();
    const today = localDay(this.now());
    try {
      for (const row of list) {
        if (run.ctl.signal.aborted) break;
        // before EVERY message: a task or a confirmation that appeared since the last one ends the run
        const gate = this.deps.canConnect();
        if (!gate.ok) {
          run.stopped ||= gate.reason ?? 'refused';
          break;
        }
        let body = store.body(row.id);
        if (!body?.bodyFetched) {
          if (await this.deps.fetchBody(row)) run.fetched++;
          body = store.body(row.id);
          if (run.ctl.signal.aborted) break;
        }
        const fresh = store.byId(row.id) ?? row;
        const screened = await screenTriageInput(this.deps.guard(), triageInputFrom(fresh, body));
        if (!screened.screened) run.screened = false;
        run.guardDrops += screened.dropped;
        const hash = inputHash(screened);
        let facts: TriageFacts = { ...SAFE_DEFAULT };
        let valid = false;
        let cached = false;
        const hit = store.triageGet(row.id, run.model);
        if (hit && hit.inputHash === hash) {
          // the store is a file: re-validate what comes out of it like a model reply
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(hit.facts);
          } catch {
            /* a broken row is a miss */
          }
          const p = TriageFactsSchema.safeParse(parsed);
          if (p.success) {
            facts = p.data;
            valid = hit.valid;
            cached = true;
          }
        }
        if (!cached) {
          if (run.ctl.signal.aborted || !this.deps.canConnect().ok) {
            run.stopped ||= this.deps.canConnect().reason ?? 'stopped';
            break;
          }
          const r = await this.deps.client().stream({ messages: buildTriageMessages(screened, today), maxTokens: TRIAGE_LIMITS.maxTokens }, () => undefined, run.ctl.signal);
          if (r.usedFallback) run.usedFallback = true;
          const parsed = parseTriage(r.text);
          const label = await screenLabel(this.deps.guard(), parsed.facts);
          if (label.dropped) run.labelDrops++;
          facts = label.facts;
          valid = parsed.valid;
          store.triagePut(row.id, r.usedFallback ? `fallback:${r.endpoint}` : run.model, { inputHash: hash, facts, valid, dropped: screened.dropped });
        } else run.cached++;
        if (!valid) run.invalid++;
        this.rows.push({
          id: row.id,
          accountId: fresh.accountId,
          folder: fresh.folder,
          subject: fresh.subject,
          from: fresh.fromName ? `${fresh.fromName} <${fresh.fromAddr}>` : fresh.fromAddr,
          date: localDay(fresh.sentAt || fresh.receivedAt),
          facts,
          valid,
          cached,
          dropped: screened.dropped,
        });
        run.done++;
      }
    } catch (e) {
      if (e instanceof StreamAbortedError || run.ctl.signal.aborted) run.stopped ||= 'stopped';
      else run.error = String((e as Error).message ?? e).slice(0, 300);
    } finally {
      run.running = false;
      const hist = categoryTotals(this.rows);
      this.deps.audit('triage', {
        action: 'run',
        run: run.id,
        accounts: run.accounts,
        range: run.range.kind,
        messages: run.done,
        requested: run.total,
        cached: run.cached,
        fetched: run.fetched,
        model: run.model,
        usedFallback: run.usedFallback,
        categories: Object.fromEntries(Object.entries(hist).filter(([, n]) => n > 0)),
        invalid: run.invalid,
        guardDrops: run.guardDrops,
        labelDrops: run.labelDrops,
        screened: run.screened,
        ...(run.stopped ? { stopped: run.stopped } : {}),
        ...(run.error ? { error: run.error } : {}),
      });
    }
  }

  /** The triage view: the last run's rows (filtered, sorted by due date), totals over ALL its rows. */
  state(filter: unknown = 'all') {
    const f = isFilter(filter) ? filter : 'all';
    const today = localDay(this.now());
    const r = this.run;
    return {
      running: !!r?.running,
      drafting: !!this.draftCtl,
      progress: r ? { done: r.done, total: r.total, cached: r.cached, invalid: r.invalid, guardDrops: r.guardDrops, screened: r.screened } : null,
      stopped: r?.stopped ?? '',
      error: r?.error ?? '',
      model: r?.model ?? this.deps.modelId(),
      today,
      filter: f,
      totals: categoryTotals(this.rows),
      count: this.rows.length,
      rows: sortByDue(applyFilter(this.rows, f, today)),
      fallbackNotice: this.deps.fallbackNotice(),
      gate: this.deps.canConnect(),
      categories: CATEGORIES,
    };
  }

  // ------------------------------------------------------------ actions: plan, show, approve

  /**
   * Plan a bulk action from the USER's choice: a category of the last run, or a selection of its
   * rows. Returns the exact list (subject + sender from the store) and a one-time token. Nothing is
   * touched here; `apply` with this token and an explicit approval is the only way to execute it.
   */
  planAction(spec: unknown): { ok: true; token: string; action: TriageAction; target: string; items: Array<{ id: number; subject: string; from: string; account: string; folder: string }> } | { ok: false; error: string } {
    const s = (spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>;
    const action = s.action;
    if (action !== 'archive' && action !== 'move' && action !== 'flag' && action !== 'label') return { ok: false, error: 'unknown action' };
    let target = '';
    if (action === 'move') {
      target = typeof s.target === 'string' ? s.target.trim().slice(0, 255) : '';
      if (!target) return { ok: false, error: 'choose a folder to move to' };
    }
    if (action === 'label') {
      target = typeof s.target === 'string' ? s.target.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
      if (!target) return { ok: false, error: 'type a label name' };
    }
    // listed in the order the triage view shows them (due date first)
    const view = sortByDue(this.rows);
    let ids: number[];
    if (typeof s.category === 'string') {
      if (!(CATEGORIES as readonly string[]).includes(s.category)) return { ok: false, error: 'unknown category' };
      ids = view.filter((r) => r.facts.category === (s.category as Category)).map((r) => r.id);
    } else if (Array.isArray(s.ids)) {
      // a selection can only name messages of this triage view
      const picked = new Set(s.ids.map(Number));
      ids = view.filter((r) => picked.has(r.id)).map((r) => r.id);
    } else return { ok: false, error: 'choose a category or select messages' };
    ids = ids.slice(0, MAX_PLAN);
    if (!ids.length) return { ok: false, error: 'no messages match' };
    const store = this.deps.store();
    const items = ids
      .map((id) => store.byId(id))
      .filter((r): r is MessageRow => !!r)
      .map((r) => ({ id: r.id, subject: r.subject || '(no subject)', from: r.fromName ? `${r.fromName} <${r.fromAddr}>` : r.fromAddr, account: r.accountId, folder: r.folder }));
    if (!items.length) return { ok: false, error: 'those messages are no longer in the store' };
    this.plan = { token: randomUUID(), action, target, ids: items.map((i) => i.id), expires: this.now() + PLAN_TTL_MS };
    return { ok: true, token: this.plan.token, action, target, items };
  }

  /**
   * Answer a plan. Deny (or a wrong / stale token) changes nothing. Approve runs the planned action on
   * EXACTLY the planned ids through the existing gated mail actions, one account + folder at a time.
   */
  async apply(token: unknown, approve: unknown): Promise<{ ok: boolean; error?: string; refused?: string; applied?: number; denied?: boolean; failed?: number }> {
    const p = this.plan;
    if (!p || typeof token !== 'string' || token !== p.token) return { ok: false, error: 'that confirmation is no longer valid: plan the action again' };
    this.plan = null;
    if (this.now() > p.expires) return { ok: false, error: 'that confirmation expired: plan the action again' };
    if (approve !== true) {
      this.deps.audit('triage', { action: 'apply', op: p.action, messages: p.ids.length, approved: false });
      return { ok: true, denied: true, applied: 0 };
    }
    const gate = this.deps.canConnect();
    if (!gate.ok) {
      this.deps.audit('triage', { action: 'apply', op: p.action, messages: p.ids.length, approved: true, refused: gate.reason ?? 'refused' });
      return { ok: false, refused: gate.reason ?? 'refused', error: gate.reason ?? 'refused' };
    }
    const store = this.deps.store();
    const groups = new Map<string, MessageRow[]>();
    for (const id of p.ids) {
      const r = store.byId(id);
      if (!r) continue;
      const k = `${r.accountId}\u0000${r.folder}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    let applied = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const rows of groups.values()) {
      const ids = rows.map((r) => r.id);
      let res: { ok: boolean; error?: string };
      if (p.action === 'archive' || p.action === 'move') {
        const to = p.action === 'archive' ? this.deps.archiveFolder(rows[0].accountId) : p.target;
        if (rows[0].folder === to) {
          applied += ids.length;
          continue;
        }
        res = await this.deps.move(ids, to);
      } else if (p.action === 'flag') {
        res = await this.deps.setFlags(ids, { flagged: true });
      } else {
        const labelId = `label-${p.target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'triage'}`;
        const added = store.addLabel(labelId, p.target, '', '');
        res = added.ok ? { ok: true } : { ok: false, error: added.error };
        if (added.ok) store.addLabelToMessages(ids, labelId);
      }
      if (res.ok) applied += ids.length;
      else {
        failed += ids.length;
        if (res.error) errors.push(res.error);
      }
    }
    // the view follows the store (a moved message has a new folder)
    this.rows = this.rows.map((r) => {
      const now = store.byId(r.id);
      return now ? { ...r, folder: now.folder } : r;
    });
    this.deps.audit('triage', { action: 'apply', op: p.action, messages: p.ids.length, approved: true, applied, failed });
    return failed ? { ok: false, applied, failed, error: [...new Set(errors)].join('; ').slice(0, 300) || 'some messages could not be changed' } : { ok: true, applied };
  }

  // ------------------------------------------------------------ the reply draft

  /**
   * "Draft reply": ONE message's screened fields + the user's one-line instruction go to the triage
   * role; its text becomes a LOCAL draft (recipients and subject from the stored row, never from the
   * model) that the panel opens in compose. Nothing is sent: only the user's Send in compose sends.
   */
  async draft(id: unknown, instruction: unknown): Promise<{ ok: boolean; error?: string; refused?: string; draft?: Record<string, unknown> }> {
    const mid = Math.floor(Number(id)) || 0;
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false, refused: gate.reason ?? 'refused', error: gate.reason ?? 'refused' };
    if (this.busy) return { ok: false, error: 'triage is running: wait for it or press Stop' };
    const store = this.deps.store();
    const row = store.byId(mid);
    if (!row) return { ok: false, error: 'unknown message' };
    const ask = String(instruction ?? '').slice(0, TRIAGE_LIMITS.instruction);
    const ctl = new AbortController();
    this.draftCtl = ctl;
    try {
      let body = store.body(row.id);
      if (!body?.bodyFetched) {
        await this.deps.fetchBody(row);
        body = store.body(row.id);
      }
      if (ctl.signal.aborted || !this.deps.canConnect().ok) return { ok: false, refused: this.deps.canConnect().reason ?? 'stopped', error: this.deps.canConnect().reason ?? 'stopped' };
      const screened = await screenTriageInput(this.deps.guard(), triageInputFrom(store.byId(row.id) ?? row, body));
      const r = await this.deps.client().stream({ messages: buildDraftMessages(screened, ask), maxTokens: TRIAGE_LIMITS.draftTokens }, () => undefined, ctl.signal);
      const text = cleanDraft(r.text);
      const init = this.deps.composeInit(row.id);
      if (!init.ok) return { ok: false, error: init.error ?? 'could not prepare the reply' };
      const fields = { ...init, body: text };
      const saved = this.deps.draftSave(fields);
      if (!saved.ok || !saved.id) return { ok: false, error: saved.error ?? 'could not save the draft' };
      this.deps.audit('triage', { action: 'draft', account: row.accountId, message: row.id, chars: text.length, guardDrops: screened.dropped, screened: screened.screened, model: this.deps.modelId(), usedFallback: r.usedFallback });
      return { ok: true, draft: { ...fields, draftId: saved.id } };
    } catch (e) {
      if (e instanceof StreamAbortedError || ctl.signal.aborted) return { ok: false, error: 'the draft was stopped' };
      return { ok: false, error: String((e as Error).message ?? e).slice(0, 300) };
    } finally {
      if (this.draftCtl === ctl) this.draftCtl = null;
    }
  }
}

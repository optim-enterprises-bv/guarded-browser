// Injection X-ray (AI capabilities item 1): per tab, chrome-initiated, read-only.
//
// What this module may do, and nothing else:
//   * run the X-ray scripts in the tab's ISOLATED world (scan, overlay, reveal, clear);
//   * score the scanned text with the shared guard model (local, CPU) when it is loaded;
//   * read this profile's per-tab host log and reputation lists (in memory);
//   * push the report to this window's chrome.
// It makes no request, writes nothing to disk, and never reaches the planner / reader / judge: the
// agent's snapshot and page text are produced by other scripts and are unchanged by an X-ray.

import { ISOLATED_WORLD } from '../page-scripts';
import { hostKey } from '../../core/egress';
import {
  XRAY_CLEAR_JS,
  XRAY_SCAN_JS,
  assessForms,
  normalizeScan,
  overlayMarks,
  scoreFragments,
  summarize,
  summaryLine,
  thirdPartyHosts,
  xrayOverlayJs,
  xrayRevealJs,
  type XrayForm,
  type XrayFragment,
  type XrayHost,
  type XraySummary,
} from '../../core/xray';
import type { Handler } from '../runtime';
import type { Tab } from '../tabs';
import type { RuntimeDeps } from './deps';

/** What the chrome gets. Visible text is included only when the guard flagged it. */
export interface XrayReport {
  tabId: number;
  url: string;
  fragments: XrayFragment[];
  hosts: XrayHost[];
  forms: XrayForm[];
  guard: { state: 'scoring' | 'scored' | 'not-loaded'; detail: string };
  summary: XraySummary;
  line: string;
  truncated: boolean;
  overlay: { boxes: number };
}

interface Entry {
  report: XrayReport;
  /** every fragment, visible ones included (kept in main; never sent unless flagged) */
  all: XrayFragment[];
}

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const entries = new Map<number, Entry>();
  /** bumped on every navigation of a tab: a scan that started before it is discarded */
  const navSeq = new Map<number, number>();
  const busy = new Set<number>();
  const seqOf = (id: number) => navSeq.get(id) ?? 0;
  const run = (t: Tab, code: string) => t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]);
  const push = (tabId: number) => rt.sendUI('xray', { tabId, report: entries.get(tabId)?.report ?? null });
  const listedBy = (hostOrUrl: string): string | null => {
    // egress.reputation is null when reputation checking is switched off in settings
    const hit = rt.egress.reputation?.check(hostOrUrl);
    return hit?.listed ? hit.feed ?? 'local blocklist' : null;
  };

  function build(tabId: number, url: string, all: XrayFragment[], hosts: XrayHost[], forms: XrayForm[], guard: XrayReport['guard'], truncated: boolean, boxes: number): XrayReport {
    const summary = summarize({ fragments: all, hosts, forms });
    return {
      tabId,
      url,
      fragments: all.filter((f) => f.kind === 'hidden' || f.flagged),
      hosts,
      forms,
      guard,
      summary,
      line: summaryLine(summary),
      truncated,
      overlay: { boxes },
    };
  }

  async function draw(t: Tab, e: Entry): Promise<number> {
    const r = (await run(t, xrayOverlayJs(overlayMarks(e.all, e.report.forms))).catch(() => null)) as { boxes?: number } | null;
    return Math.max(0, Number(r?.boxes) || 0);
  }

  async function scan(t: Tab): Promise<{ ok: boolean; error?: string; report?: XrayReport }> {
    const url = t.wc.getURL();
    if (!/^(https?|file):/i.test(url)) return { ok: false, error: 'the X-ray works on web pages only' };
    if (busy.has(t.id)) return { ok: false, error: 'a scan of this tab is already running' };
    busy.add(t.id);
    const seq = seqOf(t.id);
    try {
      await run(t, XRAY_CLEAR_JS).catch(() => undefined);
      const s = normalizeScan(await run(t, XRAY_SCAN_JS));
      if (seqOf(t.id) !== seq) return { ok: false, error: 'the page navigated during the scan' };
      const forms = assessForms(s.forms, url, listedBy);
      const formHosts = new Set(s.forms.flatMap((f) => [f.action, ...f.formActions]).map((a) => (/^https?:/i.test(a) ? hostKey(a) : null)).filter((h): h is string => !!h));
      const hosts = thirdPartyHosts(url, rt.tabHosts.hosts(t.wc.id), listedBy, formHosts);
      const all: XrayFragment[] = [...s.hidden, ...s.visible].map((f, id) => ({ ...f, id, score: null, flagged: false }));
      const ready = rt.ctx.guard.status() === 'ready';
      const guard: XrayReport['guard'] = ready ? { state: 'scoring', detail: rt.ctx.guard.statusDetail() } : { state: 'not-loaded', detail: rt.ctx.guard.statusDetail() };
      const entry: Entry = { all, report: build(t.id, url, all, hosts, forms, guard, s.truncated, 0) };
      entries.set(t.id, entry);
      entry.report.overlay.boxes = await draw(t, entry);
      push(t.id);
      if (ready) void score(t, entry, seq);
      return { ok: true, report: entry.report };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    } finally {
      busy.delete(t.id);
    }
  }

  /** Phase two: guard scores (CPU, can take a while). The report is replaced only if it is still current. */
  async function score(t: Tab, entry: Entry, seq: number) {
    let guard: XrayReport['guard'];
    let all = entry.all;
    try {
      const r = await scoreFragments(rt.ctx.guard, entry.all.map((f) => f.text));
      guard = r.guard;
      all = entry.all.map((f, i) => ({ ...f, score: r.scores[i]?.score ?? null, flagged: r.scores[i]?.flagged ?? false }));
    } catch (e) {
      guard = { state: 'not-loaded', detail: `guard failed: ${(e as Error).message.slice(0, 160)}` };
    }
    if (entries.get(t.id) !== entry || seqOf(t.id) !== seq || t.wc.isDestroyed()) return;
    const old = entry.report;
    const next: Entry = { all, report: build(t.id, old.url, all, old.hosts, old.forms, guard, old.truncated, 0) };
    entries.set(t.id, next);
    next.report.overlay.boxes = await draw(t, next);
    if (entries.get(t.id) === next) push(t.id);
  }

  async function clear(t: Tab) {
    const had = entries.delete(t.id);
    if (!t.wc.isDestroyed()) await run(t, XRAY_CLEAR_JS).catch(() => undefined);
    if (had) push(t.id);
  }

  async function toggle(): Promise<{ ok: boolean; error?: string; report?: XrayReport | null }> {
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    if (entries.has(t.id)) {
      await clear(t);
      return { ok: true, report: null };
    }
    return scan(t);
  }

  on('xray:toggle', () => toggle());
  on('xray:scan', () => {
    const t = rt.tabs.active();
    return t ? scan(t) : { ok: false, error: 'no active tab' };
  });
  on('xray:clear', async () => {
    const t = rt.tabs.active();
    if (t) await clear(t);
    return { ok: true };
  });
  on('xray:state', () => {
    const t = rt.tabs.active();
    return { tabId: t?.id ?? null, report: t ? entries.get(t.id)?.report ?? null : null };
  });
  on('xray:reveal', async (_e, anchor: unknown) => {
    const t = rt.tabs.active();
    const n = Number(anchor);
    if (!t || !entries.has(t.id) || !Number.isInteger(n) || n < 0 || n > 100_000) return { ok: false };
    return ((await run(t, xrayRevealJs(n)).catch(() => null)) as { ok?: boolean } | null) ?? { ok: false };
  });

  return {
    /** the chord / menu entry: toggle the X-ray of the active tab */
    toggleActive: () => void toggle(),
    /** a navigation committed (new document or in-page): the report no longer describes the page */
    onNavigate(t: Tab) {
      navSeq.set(t.id, seqOf(t.id) + 1);
      if (entries.has(t.id)) void clear(t);
    },
    /** the tab is gone */
    forget(id: number) {
      entries.delete(id);
      navSeq.delete(id);
    },
  };
}

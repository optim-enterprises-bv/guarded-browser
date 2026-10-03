// Egress wiring for one profile's session: the webRequest content filter, the reputation
// interstitial and its "Proceed anyway" path, download staging and the permission handler.
// Moved out of runtime.ts unchanged; the runtime's live state is reached through `rt` (getters),
// never captured by value, so a later reassignment in runtime.ts (a new task, new settings) is seen.

import { app, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { bodyValues, hostKey } from '../../core/egress';
import { uniquePath } from '../../core/downloads';
import { originOf } from '../../core/policy';
import { normalizeHost, safeBrowsingLookup } from '../../core/reputation';
import type { ConfirmOutcome, ConfirmRequest } from '../../core/types';
import { testEnv } from '../test-hooks';
import type { RuntimeDeps } from './deps';

/** the in-page "Proceed anyway" link on an interstitial; intercepted in setupTab's will-navigate */
export const PROCEED_PREFIX = 'https://guarded-browser.invalid/proceed?t=';

export function createEgressWiring(rt: RuntimeDeps) {
const { profileDir, downloads, stopTask } = rt;
/** reputation interstitials waiting for Go back / Proceed anyway */
const interstitials = new Map<string, { url: string; host: string; feed: string; wcId: number }>();
const sbCache = new Map<string, { verdict: string | null; at: number }>();

/** Browser-generated "where does this request come from" for confirmation dialogs. */
function sourceOf(wcId: number | undefined): ConfirmRequest['source'] {
  const t = rt.tabs?.list().map((x) => rt.tabs.byId(x.id)!).find((x) => x.wc.id === wcId);
  if (!t) return { label: 'a background worker or the browser itself (no tab)' };
  return rt.tabs.describe(t.id) ?? undefined;
}

function isTabRequest(id: number | undefined): boolean {
  return id !== undefined && rt.tabs.list().some((t) => rt.tabs.byId(t.id)?.wc.id === id);
}

/**
 * The webRequest layer sees WebContents ids, but tab security state lives in TabGuardBook. The
 * two are kept in lockstep by TabManager.create()/close(), so one lookup is enough — and if a
 * WebContents has no live tab (a destroyed tab, a devtools target) the answer is "not gated",
 * which is what the old `postTaskGuard.has(id)` gave once the tab was gone.
 */
function tabIdOf(wcId: number): number {
  return rt.tabs.list().find((t) => rt.tabs.byId(t.id)?.wc.id === wcId)?.id ?? -1;
}
const inflightFlows = new Map<string, Promise<ConfirmOutcome>>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Full-page interstitial for a listed host. Proceed goes through a browser-chrome confirmation. */
function showInterstitial(wc: WebContents, url: string, host: string, feed: string, matched: string) {
  const token = randomBytes(16).toString('hex');
  interstitials.set(token, { url, host, feed, wcId: wc.id });
  const agent = !!rt.current;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Blocked: ${esc(host)}</title>
<style>body{font-family:system-ui,sans-serif;background:#7f1d1d;color:#fff;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.box{max-width:640px;padding:32px}code{background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;word-break:break-all}
button{font:inherit;padding:8px 16px;margin-right:8px;border-radius:6px;border:0;cursor:pointer}button:disabled{opacity:.5;cursor:default}</style></head>
<body><div class="box"><h1>Dangerous site blocked</h1>
<p><code>${esc(host)}</code> is listed as malicious by <b>${esc(feed)}</b> (matched <code>${esc(matched)}</code>).</p>
<p>Requested URL: <code>${esc(url.slice(0, 300))}</code></p>
<p>Threat feeds list phishing and malware hosts. A listing can be wrong, but visiting is risky.</p>
${agent ? '<p><b>An agent task is running: the agent can never override a reputation block.</b></p>' : ''}
<button onclick="history.back()">Go back</button>
<button id="proceed" ${agent ? 'disabled' : ''} onclick="location.href='${PROCEED_PREFIX}${token}'">Proceed anyway (asks for confirmation)</button>
</div></body></html>`;
  setImmediate(() => void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined));
}

/** "Proceed anyway" only ever applies to the tab that showed that interstitial. */
function handleProceed(token: string, wc: WebContents) {
  const it = interstitials.get(token);
  if (!it || it.wcId !== wc.id) return;
  if (rt.current) {
    rt.audit.write('egress', { taskId: rt.current.task.id, layer: 'reputation', decision: 'block', host: it.host, method: 'GET', url: it.url, reason: 'proceed refused: an agent task is running (the agent can never override a reputation block)', feed: it.feed });
    return;
  }
  void rt.broker
    .request({
      id: `r${Date.now().toString(36)}`,
      kind: 'reputation',
      source: sourceOf(wc.id),
      action: 'visit a host listed as malicious',
      target: it.host,
      destination: it.url,
      values: [],
      reasons: [`${it.host} is listed by ${it.feed}`, 'you chose Proceed anyway on the interstitial'],
    })
    .then((o) => {
      rt.audit.write('egress', { layer: 'reputation', decision: o === 'approve' ? 'allow' : 'block', host: it.host, method: 'GET', url: it.url, reason: `user override via interstitial: ${o}`, feed: it.feed });
      if (o !== 'approve') return;
      rt.egress.overrideReputation(it.host);
      interstitials.delete(token);
      if (!wc.isDestroyed()) void wc.loadURL(it.url).catch(() => undefined);
    });
}

async function safeBrowsingVerdict(url: string): Promise<string | null> {
  const sb = rt.settings.reputation.safeBrowsing;
  const key = sb.enabled ? process.env[sb.apiKeyEnv] : undefined;
  if (!key) return null;
  const host = normalizeHost(url);
  const c = sbCache.get(host);
  if (c && Date.now() - c.at < 30 * 60_000) return c.verdict;
  try {
    const verdict = await safeBrowsingLookup(url, key);
    sbCache.set(host, { verdict, at: Date.now() });
    return verdict;
  } catch (e) {
    rt.audit.write('error', { where: 'safe-browsing', error: (e as Error).message });
    return null;
  }
}

function setupEgress(ses: Session) {
  // Layer 2: content filter on full URL + body. Blocks tainted values leaving without a confirmed flow.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!/^(https?|wss?):/i.test(d.url)) return cb({});
    // Reputation first: top-level navigations get an interstitial, subresources are dropped silently.
    const rep = rt.egress.reputationCheck(d.url);
    // the Injection X-ray's per-tab host list (observation only: it decides nothing)
    rt.tabHosts.record(d.webContentsId, hostKey(d.url), { mainFrame: d.resourceType === 'mainFrame', blockedBy: rep ? rep.feed ?? 'reputation' : undefined });
    if (rep) {
      const top = d.resourceType === 'mainFrame';
      rt.egress.auditReputation(rep, d.method, d.url, 'webrequest', top ? 'interstitial' : 'blocked subresource');
      if (top && d.webContents) showInterstitial(d.webContents, d.url, rep.host, rep.feed ?? '?', rep.matched ?? rep.host);
      return cb({ cancel: true });
    }
    if (d.resourceType === 'mainFrame' && rt.settings.reputation.safeBrowsing.enabled) {
      void safeBrowsingVerdict(d.url).then((v) => {
        if (!v) return void egressCheck(d).then((cancel) => cb({ cancel }), () => cb({ cancel: true }));
        const host = normalizeHost(d.url);
        rt.audit.write('egress', { layer: 'reputation', decision: 'block', host, method: d.method, url: d.url, reason: `interstitial: google safe browsing ${v}`, feed: 'google-safe-browsing' });
        if (d.webContents) showInterstitial(d.webContents, d.url, host, `google-safe-browsing (${v})`, host);
        cb({ cancel: true });
      });
      return;
    }
    void egressCheck(d).then((cancel) => cb({ cancel }), () => cb({ cancel: true }));
  });

  async function readBody(d: Electron.OnBeforeRequestListenerDetails): Promise<{ text: string; unreadable: string[] }> {
    let text = '';
    const unreadable: string[] = [];
    for (const u of d.uploadData ?? []) {
      if (u.bytes) text += Buffer.from(u.bytes).toString('utf8');
      else if (u.blobUUID) {
        try {
          text += (await ses.getBlobData(u.blobUUID)).toString('utf8');
        } catch {
          unreadable.push('blob');
        }
      } else if (u.file) unreadable.push(`file upload (${u.file.split('/').pop()})`);
    }
    return { text, unreadable };
  }

  /** Ask once per key; remember denials for the rest of the task. Resolves true = allowed. */
  function askEgress(key: string, req: Omit<ConfirmRequest, 'id' | 'kind'>): Promise<boolean> {
    if (rt.deniedFlows.has(key)) return Promise.resolve(false);
    let p = inflightFlows.get(key);
    if (!p) {
      p = rt.broker.request({ id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: 'egress', ...req });
      inflightFlows.set(key, p);
      void p.finally(() => inflightFlows.delete(key));
    }
    return p.then((o) => {
      if (o === 'approve') return true;
      rt.deniedFlows.add(key);
      if (o === 'stop') stopTask();
      return false;
    });
  }

  /** Layers after reputation. Resolves true = cancel the request. */
  async function egressCheck(d: Electron.OnBeforeRequestListenerDetails): Promise<boolean> {
    const inTask = !!rt.current && rt.egress.mode === 'agent';
    const host = hostKey(d.url) ?? '?';
    const base = { host, method: d.method, url: d.url.slice(0, 500) };
    const workerOfGuardedOrigin = rt.tabs.anyGated() && !isTabRequest(d.webContentsId) && rt.tabs.gatedOrigins().has(originOf(d.url) ?? '');
    const liveGate = inTask || (d.webContentsId !== undefined && rt.tabs.isGated(tabIdOf(d.webContentsId))) || workerOfGuardedOrigin;
    // a gate lifted / closed in the last 30 s still holds what its unloading document sends
    const tombstoned =
      !liveGate &&
      !['GET', 'HEAD', 'OPTIONS'].includes(d.method) &&
      rt.tabs.heldByTomb({ wcId: d.webContentsId, liveTab: isTabRequest(d.webContentsId), origin: originOf(d.url), referrerOrigin: d.referrer ? originOf(d.referrer) : null });
    const gated = liveGate || tombstoned;

    // hosts the proxy refuses anyway are cancelled here first: no pointless prompts, and a prompt
    // can never reveal to the page whether a host is on the allowlist
    if (inTask && !rt.egress.hostPasses(host)) {
      rt.egress.decideHost(host, d.method, d.url);
      return true;
    }
    const { text: body, unreadable } = await readBody(d);

    // (a) bodies we cannot inspect never leave silently during a task
    if (inTask && unreadable.length) {
      const ok = await askEgress(`unreadable|${host}|${unreadable.join(',')}`, {
        source: sourceOf(d.webContentsId),
        action: `${d.method} request (${d.resourceType}) with a body the egress filter cannot inspect`,
        target: host,
        destination: d.url,
        values: unreadable.map((u) => ({ field: 'body part', value: u, label: 'untrusted', provenance: [], taintIds: [] })),
        reasons: ['request body contains parts (file / blob) that could not be scanned for your data'],
      });
      rt.egress.auditWebRequest({ ...base, decision: ok ? 'allow' : 'block', reason: `uninspectable body (${unreadable.join(', ')}): ${ok ? 'confirmed' : 'not confirmed'}` });
      if (!ok) return true;
    }

    // (b) every state-changing request during a task (any tab of this session, any resource type:
    //     form POST, fetch, XHR, beacon, ping, ...) needs a matching one-shot approval or a confirmation.
    //     After the task, the tab it drove stays gated until the user navigates it.
    if (gated && !['GET', 'HEAD', 'OPTIONS'].includes(d.method)) {
      const mr = rt.egress.matchApproval(d.method, d.url, body);
      const m = mr.result;
      if (m === 'match') {
        // the Content-Type header is only visible in onBeforeSendHeaders: check it there
        pendingContentType.set(d.id, { enctype: mr.enctype!, boundary: mr.boundary });
        rt.egress.auditWebRequest({ ...base, decision: 'allow', reason: 'matches the submission confirmed at the action layer (method, URL, fields)' });
      } else {
        const shown = bodyValues(body, m === 'mismatch', rt.egress.taint);
        const ok = await askEgress(`write|${d.method}|${d.url}|${createHash('sha256').update(body).digest('hex')}`, {
        source: sourceOf(d.webContentsId),
          action: `${d.method} ${d.resourceType} request that was not confirmed`,
          target: host,
          destination: d.url,
          values: shown.values,
          reasons: [
            !inTask
              ? tombstoned
                ? 'the page the agent was operating is sending data while it unloads (you navigated away from it or closed it)'
                : workerOfGuardedOrigin
                ? 'a background worker (no tab) of a site the agent visited is sending data after the task ended'
                : 'the page the agent was operating is sending data after the task ended (the tab stays guarded until you navigate it yourself)'
              : m === 'mismatch'
              ? 'the page changed what is sent after you approved it: this is the ACTUAL request body'
              : `a state-changing ${d.method} request (${d.resourceType}) during the task, not covered by an approval`,
          ],
        });
        rt.egress.auditWebRequest({ ...base, decision: ok ? 'allow' : 'block', reason: `unconfirmed ${d.method} ${d.resourceType}${m === 'mismatch' ? ' (body differs from the approved one)' : ''}: ${ok ? 'user approved' : 'blocked'}` });
        if (!ok) return true;
        // only what the dialog showed (the destination URL is shown in full): anything it cut off
        // stays tracked and the content filter below asks about it with the value itself
        rt.egress.confirmFlow([...new Set([...rt.egress.idsIn(d.url), ...shown.shownIds])], d.url);
      }
    }

    // (c) tracked values (reader output, user data the agent typed) in URL or body
    const { unconfirmed } = rt.egress.checkRequest(d.url, d.method, body);
    if (!unconfirmed.length) return false;
    const ids = unconfirmed.map((v) => v.id).sort();
    const ok = await askEgress(`${ids.join(',')}|${host}`, {
        source: sourceOf(d.webContentsId),
      action: `${d.method} request (${d.resourceType})`,
      target: host,
      destination: d.url,
      values: unconfirmed.map((v) => ({ value: v.value, label: v.kind === 'untrusted' ? 'untrusted' : 'trusted', provenance: v.provenance, taintIds: [v.id], field: v.kind })),
      reasons: [`egress filter: this request carries ${unconfirmed.length} tracked value(s) to ${host} with no confirmed flow`],
    });
    if (ok) rt.egress.confirmFlow(ids, d.url);
    rt.egress.auditWebRequest({ ...base, taintIds: ids, decision: ok ? 'allow' : 'block', reason: ok ? 'user confirmed this flow' : 'tainted value in request, not confirmed' });
    return !ok;
  }

  // An approved submission must also be SENT with the approved form's encoding.
  const pendingContentType = new Map<number, { enctype: string; boundary?: string }>();
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
    const want = pendingContentType.get(d.id);
    if (!want) return cb({ requestHeaders: d.requestHeaders });
    pendingContentType.delete(d.id);
    const ct = Object.entries(d.requestHeaders).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const media = ct.split(';')[0].trim().toLowerCase();
    const boundary = /boundary=("?)([^";]+)\1/i.exec(ct)?.[2];
    const boundaries = (ct.match(/(^|;)\s*boundary\s*=/gi) ?? []).length;
    const ok = media === want.enctype && boundaries <= 1 && (want.enctype !== 'multipart/form-data' || (boundaries === 1 && boundary === want.boundary));
    if (!ok) {
      rt.egress.auditWebRequest({ host: hostKey(d.url) ?? '?', method: d.method, url: d.url.slice(0, 500), decision: 'block', reason: `approved submission sent with Content-Type "${ct.slice(0, 100)}" instead of ${want.enctype}` });
      return cb({ cancel: true });
    }
    cb({ requestHeaders: d.requestHeaders });
  });

  ses.on('will-download', (_e, item, dlWc) => {
    // The downloads panel only OBSERVES the transfer: the staging / confirm / rename logic below is
    // unchanged. Recording happens regardless of who started it, so the user can see the bytes.
    const dlId = downloads.add(item, {
      agentTask: !!rt.current,
      host: hostKey(item.getURL()) ?? '',
      source: rt.current ? 'agent' : 'user',
    });
    if (!rt.current) {
      // manual browsing: Electron's save dialog (no silent writes, no overwrites without asking)
      rt.audit.write('egress', { layer: 'download', decision: 'log', host: hostKey(item.getURL()), method: 'GET', url: item.getURL(), reason: 'manual download (save dialog)' });
      return;
    }
    if (rt.current.task.pageEvent) {
      // a recipe replay never downloads: the transfer is cancelled and the replay stops on it
      item.cancel();
      downloads.failed(dlId, 'cancelled: recipe replay');
      rt.audit.write('egress', { layer: 'download', decision: 'block', host: hostKey(item.getURL()), method: 'GET', url: item.getURL(), reason: 'download during a recipe replay (not part of the recipe)' });
      rt.current.task.pageEvent('download', `the page started a download of ${item.getFilename().slice(0, 80)}`);
      return;
    }
    // agent task: bytes go to a private staging dir; the file only reaches the downloads folder
    // (under a unique name, never overwriting) after the user approves AND the transfer completed
    const staging = join(profileDir, 'downloads-pending');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const tmp = join(staging, `${randomBytes(8).toString('hex')}.part`);
    item.setSavePath(tmp);
    item.pause();
    const done = new Promise<string>((r) => item.once('done', (_ev, state) => r(state)));
    const url = item.getURL();
    const name = item.getFilename();
    void rt.broker
      .request({ id: `d${Date.now().toString(36)}`, kind: 'download', source: sourceOf(dlWc?.id), action: 'file download', target: name, destination: url, values: [], reasons: ['file downloads during an agent task are always confirmed'] })
      .then(async (o) => {
        rt.audit.write('egress', { layer: 'download', decision: o === 'approve' ? 'allow' : 'block', host: hostKey(url), method: 'GET', url, reason: `confirmation ${o}` });
        if (o === 'approve') {
          if (item.getState() === 'progressing') item.resume();
          const state = await done;
          if (state === 'completed' && existsSync(tmp)) {
            const dest = uniquePath(testEnv('GUARDED_DOWNLOAD_DIR') || app.getPath('downloads'), name);
            renameSync(tmp, dest);
            downloads.saved(dlId, dest);
            rt.audit.write('egress', { layer: 'download', decision: 'allow', host: hostKey(url), method: 'GET', url, reason: `saved as ${dest}` });
          } else {
            downloads.failed(dlId, state);
          }
        } else {
          if (item.getState() === 'progressing') item.cancel();
          await done;
          rmSync(tmp, { force: true });
          downloads.failed(dlId, 'denied');
        }
      });
  });

  // No camera / mic / geolocation / notifications etc. for pages in v1.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

return { setupEgress, sourceOf, handleProceed };
}

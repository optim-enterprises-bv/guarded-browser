// The HTML reading view (mail): ONE locked-down WebContentsView per window, created lazily.
//
// What makes it safe to point at hostile HTML, and where each property is enforced:
//   * JavaScript off, sandboxed, context-isolated, no node, no preload, no devtools when packaged
//     (webPreferences in `ensure()`); the document is the SANITIZED message (core/mail/html.ts) with
//     a CSP meta first in <head>, loaded as a data: URL, so it has an opaque origin and no storage.
//   * its own IN-MEMORY session partition (`mailview-<profileId>`, no `persist:`): no cookies, cache
//     or storage shared with the profile's tabs, and nothing written to disk.
//   * network: `onBeforeRequest` cancels everything except the displayed document and inline data:
//     images — unless the user pressed "Load External Content" for THIS message, and then only GET
//     images from public http(s) hosts on default ports, with Cookie / Referer stripped and Set-Cookie
//     dropped, reputation-listed hosts refused, and the host's DNS answers checked for private
//     addresses (mail is not a LAN probe). The allowance ends with the display: another message, the
//     same message reopened, or an agent task starting all go back to blocked.
//   * navigation: `will-navigate` is always prevented and `setWindowOpenHandler` always denies; an
//     http(s) link is handed to the runtime, which opens it in a NEW normal tab through the ordinary
//     user path (reputation interstitial, proxy, egress rules). Any other scheme is ignored.
//   * permissions, downloads: denied / cancelled.
//   * invisible to the agent: this view is NOT a TabManager tab or panel, so `tabs.byWebContents`,
//     `ownsWebContents`, the ElectronDriver, capture, reader mode and the tab preload never see it;
//     it has no preload, so it cannot send IPC at all, and `isUi` only matches the chrome window.
//   * visibility: drawn only while the chrome reports a reading-pane rect (it sends null whenever a
//     modal, menu or the address suggestions are up, or the panel closes), AND main has no overlay
//     and no pending confirmation, AND a message is on display. A native view covers chrome DOM, so a
//     stale visible view is a hole over the UI — `update()` re-derives visibility from all of these.

import { app, session, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron';
import { dataUrlFor, mailDocument, mailRequestDecision, sanitizeMailHtml, isPrivateHost } from '../../core/mail/html';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MailHtmlViewDeps {
  win: BrowserWindow;
  /** an in-memory partition name (never `persist:`) */
  partition: string;
  /** the stored HTML of a message, or null */
  html: (id: number) => string | null;
  /** open an http(s) URL in a new normal tab through the user navigation path */
  openLink: (url: string) => void;
  /** the mail network gate (refused while an agent task runs) */
  canConnect: () => { ok: boolean; reason?: string };
  /** true while main must not draw native views over the chrome (overlay, pending confirmation) */
  chromeBusy: () => boolean;
  /** true when the profile's reputation lists flag this URL's host */
  reputationListed: (url: string) => boolean;
  audit: (detail: Record<string, unknown>) => void;
  /** TEST ONLY: allow 127.0.0.1 for the remote-image opt-in (the e2e fixture server) */
  allowLoopbackForTest?: boolean;
}

export class MailHtmlView {
  private view: WebContentsView | null = null;
  private ses: Session | null = null;
  private rect: Rect | null = null;
  /** the message on display (0 = none) */
  private shownId = 0;
  private documentUrl = '';
  private remoteImages = false;
  private visible = false;

  constructor(private readonly deps: MailHtmlViewDeps) {
    if (deps.partition.startsWith('persist:')) throw new Error('the mail view session must be in-memory');
  }

  /** true for this view's WebContents (used only to REFUSE it, never to grant anything) */
  owns(wc: WebContents): boolean {
    return !!this.view && !this.view.webContents.isDestroyed() && wc === this.view.webContents;
  }

  get messageId(): number {
    return this.shownId;
  }

  private ensure(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const ses = session.fromPartition(this.deps.partition);
    this.ses = ses;
    this.installSessionRules(ses);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        devTools: !app.isPackaged,
        webgl: false,
        plugins: false,
        enableWebSQL: false,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
        disableDialogs: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    const wc = view.webContents;
    wc.on('will-navigate', (e, url) => {
      e.preventDefault();
      this.forwardLink(url);
    });
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame) e.preventDefault();
    });
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      this.forwardLink(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    this.deps.win.contentView.addChildView(view);
    this.view = view;
    return view;
  }

  private forwardLink(url: string) {
    if (!/^https?:\/\//i.test(url)) return; // mailto:, javascript:, data:, file: ... ignored
    this.deps.openLink(url);
  }

  private installSessionRules(ses: Session) {
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setSpellCheckerEnabled(false);
    ses.on('will-download', (e) => e.preventDefault());
    ses.webRequest.onBeforeRequest((details, cb) => {
      const d = mailRequestDecision(
        { url: details.url, method: details.method, resourceType: details.resourceType },
        { documentUrl: this.documentUrl, remoteImages: this.remoteImages, allowLoopbackForTest: this.deps.allowLoopbackForTest },
      );
      if (!d.allow) return cb({ cancel: true });
      if (!d.host) return cb({ cancel: false });
      if (this.deps.reputationListed(details.url)) return cb({ cancel: true });
      void this.resolvesPublic(ses, d.host).then((ok) => cb({ cancel: !ok || !this.remoteImages }));
    });
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = { ...details.requestHeaders };
      for (const k of Object.keys(headers)) if (/^(cookie|referer|origin)$/i.test(k)) delete headers[k];
      cb({ requestHeaders: headers });
    });
    ses.webRequest.onHeadersReceived((details, cb) => {
      const headers = { ...(details.responseHeaders ?? {}) };
      for (const k of Object.keys(headers)) if (/^set-cookie2?$/i.test(k)) delete headers[k];
      // a redirect must land on a host the policy would have allowed in the first place
      if (details.statusCode >= 300 && details.statusCode < 400) {
        const loc = Object.entries(headers).find(([k]) => k.toLowerCase() === 'location')?.[1]?.[0];
        let target = '';
        try {
          target = loc ? new URL(loc, details.url).toString() : '';
        } catch {
          target = '';
        }
        const d = target
          ? mailRequestDecision({ url: target, method: 'GET', resourceType: details.resourceType }, { documentUrl: this.documentUrl, remoteImages: this.remoteImages, allowLoopbackForTest: this.deps.allowLoopbackForTest })
          : { allow: false as const, reason: 'redirect without a location' };
        if (!d.allow || this.deps.reputationListed(target)) return cb({ cancel: true });
      }
      cb({ responseHeaders: headers });
    });
  }

  /** a name that resolves to a private address is refused even though its spelling looked public */
  private async resolvesPublic(ses: Session, host: string): Promise<boolean> {
    if (/^[\d.]+$/.test(host) || host.includes(':')) return this.deps.allowLoopbackForTest || !isPrivateHost(host);
    if (this.deps.allowLoopbackForTest && host === 'localhost') return true;
    try {
      const r = await ses.resolveHost(host);
      const addrs = r.endpoints.map((e) => e.address);
      return addrs.length > 0 && addrs.every((a) => !isPrivateHost(a));
    } catch {
      return false;
    }
  }

  /**
   * Display a message's HTML (0 = clear). Every display starts BLOCKED, including a reopen of the
   * message that was just shown with remote images. Returns hasHtml=false when the message has no
   * HTML or its document would not fit a data: URL — the chrome then shows the text.
   */
  show(id: number): { ok: boolean; hasHtml: boolean; remoteImages: boolean } {
    this.remoteImages = false;
    const mid = Math.max(0, Math.floor(Number(id) || 0));
    const html = mid ? this.deps.html(mid) : null;
    if (!html) {
      this.clear();
      return { ok: true, hasHtml: false, remoteImages: false };
    }
    const clean = sanitizeMailHtml(html);
    const url = dataUrlFor(mailDocument(clean.html, { remoteImages: false }));
    if (!url) {
      this.clear();
      return { ok: true, hasHtml: false, remoteImages: false };
    }
    this.shownId = mid;
    this.load(url);
    return { ok: true, hasHtml: true, remoteImages: clean.remoteImageHosts.length > 0 };
  }

  /** The per-message, per-display opt-in: reload THIS message with remote images allowed. */
  loadRemote(id: number): { ok: boolean; error?: string; hosts?: number } {
    const mid = Math.floor(Number(id) || 0);
    if (!mid || mid !== this.shownId) return { ok: false, error: 'that message is not on display' };
    const gate = this.deps.canConnect();
    if (!gate.ok) return { ok: false, error: gate.reason ?? 'remote content cannot be loaded right now' };
    const html = this.deps.html(mid);
    if (!html) return { ok: false, error: 'that message has no HTML body' };
    const clean = sanitizeMailHtml(html);
    const url = dataUrlFor(mailDocument(clean.html, { remoteImages: true }));
    if (!url) return { ok: false, error: 'that message is too large to display' };
    this.remoteImages = true;
    this.load(url);
    // the opt-in is audited by message id and host COUNT: no URL, no query string
    this.deps.audit({ action: 'load-remote-images', message: mid, hosts: clean.remoteImageHosts.length });
    return { ok: true, hosts: clean.remoteImageHosts.length };
  }

  /** An agent task started: any remote allowance ends now, and the message reloads blocked. */
  revokeRemote() {
    if (!this.remoteImages) return;
    this.remoteImages = false;
    if (this.shownId) this.show(this.shownId);
  }

  private load(url: string) {
    const view = this.ensure();
    this.documentUrl = url;
    void view.webContents.loadURL(url).catch(() => undefined);
    this.update();
  }

  clear() {
    this.shownId = 0;
    this.remoteImages = false;
    this.documentUrl = '';
    if (this.view && !this.view.webContents.isDestroyed()) void this.view.webContents.loadURL('about:blank').catch(() => undefined);
    this.update();
  }

  /** the reading pane's rectangle as the chrome measured it; null = do not draw */
  setRect(r: Rect | null) {
    this.rect = r && r.width >= 1 && r.height >= 1 ? r : null;
    this.update();
  }

  /** Re-derive visibility from every input. Called on rect, show, overlay and confirmation changes. */
  update() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    const show = !!this.rect && this.shownId > 0 && !this.deps.chromeBusy() && !this.deps.win.isDestroyed();
    if (show && this.rect) {
      view.setBounds(this.rect);
      // topmost: a tab view created after this one must never be drawn over the reading pane
      if (!this.visible) this.deps.win.contentView.addChildView(view);
    }
    view.setVisible(show);
    this.visible = show;
  }

  dispose() {
    const view = this.view;
    this.view = null;
    if (!view) return;
    try {
      if (!this.deps.win.isDestroyed()) this.deps.win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      /* the window is going away */
    }
    void this.ses?.clearStorageData().catch(() => undefined);
  }
}

// HTML mail (the HTML reading view): which part is "the HTML", the sanitizer, the network policy,
// the per-message remote-image opt-in, and the store's v2 html table. Pure modules are tested
// directly; the main-process view is tested against a small fake of the Electron surface it uses.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { extractContent, parseMime } from '../../src/core/mail/mime';
import {
  CSP_BLOCKED,
  CSP_REMOTE_IMAGES,
  dataUrlFor,
  isPrivateHost,
  looksLikeHtml,
  mailDocument,
  mailRequestDecision,
  pickHtml,
  sanitizeMailHtml,
} from '../../src/core/mail/html';
import { MailStore, DB_FILE, MAX_BODY_HTML, SCHEMA_VERSION } from '../../src/core/mail/store';

// ---------------------------------------------------------------- a fake of the Electron surface html-view.ts uses

const fake = vi.hoisted(() => {
  type Cb = (...a: any[]) => void;
  const state = {
    beforeRequest: null as null | ((d: any, cb: Cb) => void),
    sendHeaders: null as null | ((d: any, cb: Cb) => void),
    headersReceived: null as null | ((d: any, cb: Cb) => void),
    resolved: new Map<string, string[]>(),
    views: [] as any[],
    prefs: [] as any[],
    partitions: [] as string[],
  };
  const ses = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    setDevicePermissionHandler: () => undefined,
    setSpellCheckerEnabled: () => undefined,
    on: () => undefined,
    clearStorageData: async () => undefined,
    resolveHost: async (h: string) => ({ endpoints: (state.resolved.get(h) ?? ['93.184.216.34']).map((address) => ({ address, family: 'ipv4' })) }),
    webRequest: {
      onBeforeRequest: (fn: any) => (state.beforeRequest = fn),
      onBeforeSendHeaders: (fn: any) => (state.sendHeaders = fn),
      onHeadersReceived: (fn: any) => (state.headersReceived = fn),
    },
  };
  class WebContentsView {
    visible = true;
    bounds: any = null;
    listeners = new Map<string, Cb>();
    openHandler: any = null;
    loaded: string[] = [];
    webContents: any;
    constructor(opts: any) {
      state.prefs.push(opts.webPreferences);
      const self = this;
      this.webContents = {
        on: (ev: string, fn: Cb) => self.listeners.set(ev, fn),
        setWindowOpenHandler: (fn: any) => (self.openHandler = fn),
        isDestroyed: () => false,
        loadURL: async (u: string) => void self.loaded.push(u),
        close: () => undefined,
      };
      state.views.push(this);
    }
    setBackgroundColor() {}
    setVisible(v: boolean) {
      this.visible = v;
    }
    setBounds(b: any) {
      this.bounds = b;
    }
  }
  return { state, ses, WebContentsView };
});

vi.mock('electron', () => ({
  app: { isPackaged: true },
  session: {
    fromPartition: (p: string) => {
      fake.state.partitions.push(p);
      return fake.ses;
    },
  },
  WebContentsView: fake.WebContentsView,
}));

import { MailHtmlView } from '../../src/main/mail/html-view';

const tmp = () => mkdtempSync(join(tmpdir(), 'gb-mailhtml-'));

// ---------------------------------------------------------------- choosing the html body


/** Remove what schema v4 (ticket 38) added, so a file can be turned back into a genuine older one. */
function dropV4(raw: InstanceType<typeof DatabaseSync>) {
  raw.exec('DROP TABLE draft');
  raw.exec('DROP TABLE outbox');
  for (const c of ['smtpHost', 'smtpPort', 'smtpTls']) raw.exec(`ALTER TABLE account DROP COLUMN ${c}`);
}

describe('mail html: which part is the HTML body', () => {
  const alt = [
    'Subject: newsletter',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain version of the newsletter',
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><h1>Newsletter</h1><table><tr><td>cell</td></tr></table></body></html>',
    '--ALT--',
  ].join('\r\n');

  it('multipart/alternative: prefers the text/html part and keeps the text/plain part as text', () => {
    const c = extractContent(parseMime(alt));
    expect(c.html).toContain('<h1>Newsletter</h1>');
    expect(c.text).toBe('Plain version of the newsletter');
  });

  it('a single text/plain part that is HTML source is treated as html, and its TEXT carries no tags', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<tr><td class="c">row ${i}</td></tr>`).join('\n');
    const raw = ['Subject: vendor', 'Content-Type: text/plain; charset=utf-8', '', `<table width="600">${rows}</table>`].join('\r\n');
    const c = extractContent(parseMime(raw));
    expect(c.html).toContain('<table width="600">');
    expect(c.text).toContain('row 7');
    expect(c.text).not.toContain('<td');
  });

  it('a document-shaped text/plain part is html even with few tags', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html><body>hi</body></html>')).toBe(true);
    expect(looksLikeHtml('  <html>hi')).toBe(true);
  });

  it('plain text stays plain: no html, prose that mentions <div> once is not HTML', () => {
    const c = extractContent(parseMime(['Subject: x', 'Content-Type: text/plain', '', 'Hello,\r\nuse a <div> here.\r\nBye'].join('\r\n')));
    expect(c.html).toBe('');
    expect(c.text).toContain('use a <div> here');
    expect(pickHtml('', 'just words')).toBe('');
  });

  it('caps the chosen html at MAX_BODY_HTML', () => {
    expect(pickHtml('x'.repeat(MAX_BODY_HTML + 10), '').length).toBe(MAX_BODY_HTML);
  });
});

// ---------------------------------------------------------------- sanitizer

describe('mail html: the sanitizer drops every active construct', () => {
  const s = (h: string) => sanitizeMailHtml(h).html;

  it.each([
    ['script (with content)', '<p>a</p><script>alert(1)</script><p>b</p>', /script|alert/i],
    ['iframe', '<iframe src="https://evil.example"></iframe>x', /iframe|evil/i],
    ['frame / frameset', '<frameset><frame src="https://evil.example"></frameset>x', /frame|evil/i],
    ['object', '<object data="x.swf"><param name="a" value="b"></object>x', /object|param|swf/i],
    ['embed', '<embed src="x.swf">x', /embed|swf/i],
    ['applet', '<applet code="X.class">fallback</applet>x', /applet|X\.class|fallback/i],
    ['form + input', '<form action="https://evil.example/collect" method="post"><input name="pw" value="1"></form>x', /form|input|collect|action/i],
    ['submit button', '<button type="submit" formaction="https://evil.example">Go</button>', /button|formaction|evil/i],
    ['base', '<base href="https://evil.example/">x', /base|evil/i],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/a.css">x', /link|evil/i],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">x', /meta|refresh|evil/i],
    ['on* attributes', '<p onclick="alert(1)" onmouseover=alert(2) ONLOAD="x">t</p>', /on\w+=|alert/i],
    ['javascript: href', '<a href="javascript:alert(1)">t</a>', /javascript|alert/i],
    ['vbscript: href', '<a href="vbscript:msgbox(1)">t</a>', /vbscript|msgbox/i],
    ['data:text/html src', '<img src="data:text/html;base64,PHNjcmlwdD4=">', /data:text/i],
    ['entity-encoded javascript:', '<a href="&#106;ava&#x73;cript&colon;alert(1)">t</a>', /alert|href/i],
    ['tab-split javascript:', '<a href="java\tscript:alert(1)">t</a>', /alert|href/i],
    ['svg with foreign <style>', '<svg><style><img src=x onerror=alert(1)></style></svg>ok', /svg|onerror|alert/i],
    ['noscript / xmp / textarea / title', '<noscript><p title="</noscript><img src=x onerror=1>"></noscript><xmp><b></xmp><textarea><b></textarea><title>t</title>ok', /noscript|onerror|xmp|textarea|title/i],
    ['css expression / @import', '<p style="width:expression(alert(1))">t</p><style>@import url(https://evil.example/x.css);</style>', /expression|@import|evil/i],
    ['srcset', '<img srcset="https://evil.example/a.png 1x" src="data:image/png;base64,AA==">', /srcset|evil/i],
  ])('%s', (_name, input, forbidden) => {
    const out = s(input);
    expect(out).not.toMatch(forbidden);
  });

  it('keeps the layout a newsletter needs: tables, headings, inline style, <style>, safe links and data: images', () => {
    const out = s(
      '<html><head><title>T</title><style>.h{color:red}</style></head><body bgcolor="#eee"><table width="600" cellpadding="4"><tr><td align="center"><h1 class="h" style="color:#c00">Hello &amp; welcome</h1><a href="https://example.com/a?b=1&amp;c=2" target="_blank">read</a><img src="data:image/png;base64,iVBORw0KGgo=" alt="x"></td></tr></table></body></html>',
    );
    expect(out).toContain('<style>.h{color:red}</style>');
    expect(out).toContain('<table width="600" cellpadding="4">');
    expect(out).toContain('<h1 class="h" style="color:#c00">Hello &amp; welcome</h1>');
    expect(out).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(out).not.toContain('target=');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(out).not.toMatch(/<title>|<head>|<body/i);
  });

  it('re-quotes attributes so a value cannot break out of its tag', () => {
    const out = s(`<p title='a"><img src=x onerror=alert(1)>'>t</p>`);
    expect(out).toBe('<p title="a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">t</p>');
  });

  it('a stray < is text, and an unterminated tag eats the rest (as in a browser)', () => {
    expect(s('1 < 2 and 3 > 2')).toBe('1 &lt; 2 and 3 &gt; 2');
    expect(s('ok<p title="never closed')).toBe('ok');
  });

  it('reports the remote image hosts (img src, background, css url()) for the banner', () => {
    const r = sanitizeMailHtml('<img src="https://a.example/p.gif"><td background="http://b.example/bg.png"></td><style>.x{background:url("https://c.example/x.png")}</style><a href="https://link.example/">l</a>');
    expect(r.remoteImageHosts.sort()).toEqual(['a.example', 'b.example', 'c.example']);
    expect(sanitizeMailHtml('<p>no images</p>').remoteImageHosts).toEqual([]);
  });

  it('runs in linear time on hostile input (no ReDoS) and caps the input', () => {
    const n = 400_000;
    const inputs = [
      '<a '.repeat(n / 3),
      '<p title="'.repeat(n / 10),
      '<!--'.repeat(n / 4),
      '<script>'.repeat(n / 8),
      '<'.repeat(n),
      `<p ${'a=b '.repeat(n / 4)}>`,
      '<style>'.repeat(n / 7),
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      sanitizeMailHtml(input);
      const t1 = performance.now();
      sanitizeMailHtml(input + input + input + input);
      const t4 = performance.now() - t1;
      // 4x the input in well under the 16x a quadratic pass would need (plus a floor for timer noise)
      expect(t4, input.slice(0, 12)).toBeLessThan(Math.max(8 * (t1 - t0), 400));
    }
    expect(sanitizeMailHtml('x'.repeat(MAX_BODY_HTML * 2)).html.length).toBe(MAX_BODY_HTML);
  });
});

describe('mail html: the document and its CSP', () => {
  it('puts the CSP meta first in <head>, blocked unless the user opted in', () => {
    const blocked = mailDocument('<p>x</p>', { remoteImages: false });
    expect(blocked.indexOf('<head><meta http-equiv="Content-Security-Policy"')).toBeGreaterThan(0);
    expect(blocked).toContain(CSP_BLOCKED);
    expect(CSP_BLOCKED).toContain("img-src data:;");
    expect(CSP_BLOCKED).toContain("default-src 'none'");
    expect(mailDocument('<p>x</p>', { remoteImages: true })).toContain(CSP_REMOTE_IMAGES);
  });

  it('a document that would not fit a data: URL is refused (the text is shown instead)', () => {
    expect(dataUrlFor('<p>x</p>')).toMatch(/^data:text\/html;charset=utf-8;base64,/);
    expect(dataUrlFor('x'.repeat(2 * 1024 * 1024))).toBeNull();
  });
});

// ---------------------------------------------------------------- the network policy

describe('mail html: what the view may fetch', () => {
  const doc = 'data:text/html;charset=utf-8;base64,PHA+eDwvcD4=';
  const blocked = { documentUrl: doc, remoteImages: false };
  const opted = { documentUrl: doc, remoteImages: true };
  const req = (url: string, resourceType = 'image', method = 'GET') => ({ url, resourceType, method });

  it('blocked by default: only the displayed document and inline data: images', () => {
    expect(mailRequestDecision(req(doc, 'mainFrame'), blocked).allow).toBe(true);
    expect(mailRequestDecision(req('data:text/html;base64,AAAA', 'mainFrame'), blocked).allow).toBe(false);
    expect(mailRequestDecision(req('data:image/png;base64,AA=='), blocked).allow).toBe(true);
    expect(mailRequestDecision(req('https://tracker.example/p.gif'), blocked).allow).toBe(false);
    expect(mailRequestDecision(req('https://example.com/', 'mainFrame'), blocked).allow).toBe(false);
  });

  it('after the opt-in: a GET image from a public host is allowed', () => {
    expect(mailRequestDecision(req('https://cdn.example.com/hero.png'), opted)).toEqual({ allow: true, host: 'cdn.example.com' });
    expect(mailRequestDecision(req('http://cdn.example.com/hero.png'), opted).allow).toBe(true);
  });

  it.each([
    ['script', req('https://cdn.example.com/a.js', 'script')],
    ['xhr', req('https://cdn.example.com/api', 'xhr')],
    ['subframe', req('https://cdn.example.com/f', 'subFrame')],
    ['navigation', req('https://cdn.example.com/', 'mainFrame')],
    ['stylesheet', req('https://cdn.example.com/a.css', 'stylesheet')],
    ['websocket', req('wss://cdn.example.com/', 'webSocket')],
    ['ping', req('https://cdn.example.com/p', 'ping')],
    ['POST image', req('https://cdn.example.com/p.gif', 'image', 'POST')],
    ['non-standard port', req('https://cdn.example.com:8443/p.gif')],
    ['credentials', req('https://u:p@cdn.example.com/p.gif')],
    ['ftp', req('ftp://cdn.example.com/p.gif')],
    ['loopback', req('http://127.0.0.1/p.gif')],
    ['loopback (decimal spelling)', req('http://2130706433/p.gif')],
    ['private 10/8', req('http://10.1.2.3/p.gif')],
    ['private 192.168/16', req('http://192.168.1.1/p.gif')],
    ['private 172.16/12', req('http://172.20.0.1/p.gif')],
    ['link-local', req('http://169.254.169.254/latest/meta-data')],
    ['ipv6 loopback', req('http://[::1]/p.gif')],
    ['ipv6 unique-local', req('http://[fd00::1]/p.gif')],
    ['ipv4-mapped private', req('http://[::ffff:192.168.0.1]/p.gif')],
    ['.local name', req('http://printer.local/p.gif')],
    ['single-label name', req('http://router/p.gif')],
    ['localhost', req('http://localhost/p.gif')],
  ])('still blocked after the opt-in: %s', (_n, r) => {
    expect(mailRequestDecision(r, opted).allow).toBe(false);
  });

  it('the test-only loopback allowance admits 127.0.0.1 and nothing else private', () => {
    const t = { ...opted, allowLoopbackForTest: true };
    expect(mailRequestDecision(req('http://127.0.0.1:41234/p.gif'), t).allow).toBe(true);
    expect(mailRequestDecision(req('http://192.168.1.1/p.gif'), t).allow).toBe(false);
    expect(mailRequestDecision(req('http://127.0.0.1:41234/a.js', 'script'), t).allow).toBe(false);
  });

  it('isPrivateHost: public names and addresses are public', () => {
    for (const h of ['example.com', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8']) expect(isPrivateHost(h), h).toBe(false);
    for (const h of ['127.0.0.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::', 'fe80::1', 'ff02::1', 'x.internal']) expect(isPrivateHost(h), h).toBe(true);
  });
});

// ---------------------------------------------------------------- the main-process view (fake Electron)

describe('mail html: the main-process view', () => {
  const HTML = '<h1>Hi</h1><img src="https://cdn.example.com/hero.png"><a href="https://example.com/">x</a>';
  let gate = { ok: true } as { ok: boolean; reason?: string };
  let busy = false;
  let opened: string[] = [];
  let audits: Array<Record<string, unknown>> = [];
  const win = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false };
  const make = (html: Record<number, string> = { 1: HTML, 2: HTML, 3: '' }) =>
    new MailHtmlView({
      win: win as any,
      partition: 'mailview-test',
      html: (id) => html[id] || null,
      openLink: (u) => opened.push(u),
      canConnect: () => gate,
      chromeBusy: () => busy,
      reputationListed: (u) => u.includes('listed.example'),
      audit: (d) => audits.push(d),
    });
  const request = (url: string, resourceType = 'image', method = 'GET') =>
    new Promise<boolean>((resolve) => fake.state.beforeRequest!({ url, resourceType, method }, (r: { cancel: boolean }) => resolve(r.cancel)));
  const view = () => fake.state.views.at(-1);

  beforeEach(() => {
    gate = { ok: true };
    busy = false;
    opened = [];
    audits = [];
    fake.state.views.length = 0;
    fake.state.prefs.length = 0;
    fake.state.resolved.clear();
  });

  it('is created locked down: JS off, sandbox, isolation, no node, no preload, no devtools when packaged, in-memory partition', () => {
    const v = make();
    v.show(1);
    const p = fake.state.prefs.at(-1);
    expect(p).toMatchObject({ javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: false });
    expect(p.preload).toBeUndefined();
    expect(fake.state.partitions.at(-1)).toBe('mailview-test');
    expect(() => new MailHtmlView({ ...(v as any).deps, partition: 'persist:mail' })).toThrow(/in-memory/);
    expect(view().loaded.at(-1)).toMatch(/^data:text\/html;charset=utf-8;base64,/);
    const doc = Buffer.from(view().loaded.at(-1).split(',')[1], 'base64').toString('utf8');
    expect(doc).toContain(CSP_BLOCKED);
  });

  it('remote images: blocked by default, allowed after the opt-in, still no scripts/xhr/subframes/POST/private hosts, reset on the next message', async () => {
    const v = make();
    expect(await v.show(1)).toEqual({ ok: true, hasHtml: true, remoteImages: true });
    expect(await request('https://cdn.example.com/hero.png')).toBe(true); // cancelled
    expect(v.loadRemote(1)).toEqual({ ok: true, hosts: 1 });
    expect(audits.at(-1)).toEqual({ action: 'load-remote-images', message: 1, hosts: 1 });
    expect(JSON.stringify(audits)).not.toContain('hero.png');
    expect(Buffer.from(view().loaded.at(-1).split(',')[1], 'base64').toString('utf8')).toContain(CSP_REMOTE_IMAGES);
    expect(await request('https://cdn.example.com/hero.png')).toBe(false); // allowed
    expect(await request('https://cdn.example.com/a.js', 'script')).toBe(true);
    expect(await request('https://cdn.example.com/api', 'xhr')).toBe(true);
    expect(await request('https://cdn.example.com/f', 'subFrame')).toBe(true);
    expect(await request('https://cdn.example.com/hero.png', 'image', 'POST')).toBe(true);
    expect(await request('http://192.168.1.10/p.gif')).toBe(true);
    expect(await request('https://listed.example/p.gif')).toBe(true); // reputation
    fake.state.resolved.set('rebind.example', ['10.0.0.5']);
    expect(await request('https://rebind.example/p.gif')).toBe(true); // a public spelling that resolves private
    // the next message, and a reopen of this one, start blocked again
    v.show(2);
    expect(await request('https://cdn.example.com/hero.png')).toBe(true);
    v.loadRemote(2);
    v.show(2);
    expect(await request('https://cdn.example.com/hero.png')).toBe(true);
  });

  it('the opt-in is refused during an agent task, for a message not on display, and revoked when a task starts', async () => {
    const v = make();
    v.show(1);
    gate = { ok: false, reason: 'an agent task is running' };
    expect(v.loadRemote(1)).toEqual({ ok: false, error: 'an agent task is running' });
    gate = { ok: true };
    expect(v.loadRemote(2).ok).toBe(false);
    expect(v.loadRemote(1).ok).toBe(true);
    v.revokeRemote();
    expect(await request('https://cdn.example.com/hero.png')).toBe(true);
  });

  it('strips Cookie / Referer / Origin from requests and Set-Cookie from responses', async () => {
    make().show(1);
    const sent = await new Promise<any>((r) => fake.state.sendHeaders!({ requestHeaders: { Cookie: 'a=b', Referer: 'x', Origin: 'null', Accept: '*/*' } }, r));
    expect(sent.requestHeaders).toEqual({ Accept: '*/*' });
    const got = await new Promise<any>((r) => fake.state.headersReceived!({ statusCode: 200, url: 'https://cdn.example.com/a.png', resourceType: 'image', responseHeaders: { 'Set-Cookie': ['a=b'], 'Content-Type': ['image/png'] } }, r));
    expect(got.responseHeaders).toEqual({ 'Content-Type': ['image/png'] });
  });

  it('navigation: never in the view; http(s) links go to a new tab, other schemes are ignored', () => {
    make().show(1);
    const v = view();
    let prevented = 0;
    const ev = { preventDefault: () => prevented++ };
    v.listeners.get('will-navigate')(ev, 'https://example.com/article');
    v.listeners.get('will-navigate')(ev, 'javascript:alert(1)');
    v.listeners.get('will-navigate')(ev, 'file:///etc/passwd');
    expect(prevented).toBe(3);
    expect(v.openHandler({ url: 'http://example.org/x' })).toEqual({ action: 'deny' });
    expect(v.openHandler({ url: 'mailto:a@example.com' })).toEqual({ action: 'deny' });
    expect(opened).toEqual(['https://example.com/article', 'http://example.org/x']);
  });

  it('inline cid: images (41): written into the document as data: URLs before it loads; the CSP stays blocked; the data: image is the only thing allowed', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const v = new MailHtmlView({
      win: win as any,
      partition: 'mailview-test',
      html: () => '<p>logo</p><img src="cid:logo@shop.example"><img src="https://cdn.example.com/x.png">',
      openLink: () => undefined,
      canConnect: () => gate,
      chromeBusy: () => false,
      reputationListed: () => false,
      audit: () => undefined,
      inlineImages: async () => new Map([['logo@shop.example', png]]),
    });
    expect(await v.show(1)).toEqual({ ok: true, hasHtml: true, remoteImages: true });
    const doc = Buffer.from(view().loaded.at(-1).split(',')[1], 'base64').toString('utf8');
    expect(doc).toContain(`<img src="${png}">`);
    expect(doc).toContain(CSP_BLOCKED);
    expect(await request(png)).toBe(false); // the inline image: allowed
    expect(await request('https://cdn.example.com/x.png')).toBe(true); // remote: still blocked
    // the opt-in keeps the inline images
    v.loadRemote(1);
    expect(Buffer.from(view().loaded.at(-1).split(',')[1], 'base64').toString('utf8')).toContain(png);
  });

  it('visible only with a message on display, a rect, and no chrome overlay or confirmation', async () => {
    const v = make();
    v.setRect({ x: 10, y: 20, width: 300, height: 200 });
    expect(fake.state.views.length).toBe(0); // created lazily, on the first html message
    v.show(1);
    expect(view().visible).toBe(true);
    expect(view().bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    v.setRect(null);
    expect(view().visible).toBe(false);
    v.setRect({ x: 10, y: 20, width: 300, height: 200 });
    busy = true;
    v.update();
    expect(view().visible).toBe(false);
    busy = false;
    v.update();
    expect(view().visible).toBe(true);
    // a message without html clears the view
    expect(await v.show(3)).toEqual({ ok: true, hasHtml: false, remoteImages: false });
    expect(view().visible).toBe(false);
  });
});

// ---------------------------------------------------------------- the store

describe('mail html: the store keeps html apart (schema v2)', () => {
  const account = { id: 'a1', name: '', address: '', kind: 'imap' as const, host: 'h', port: 993, tls: 'implicit' as const, username: '', sentFolder: '', trashFolder: '', junkFolder: '', archiveFolder: '' };
  const header = (uid: number) => ({ accountId: 'a1', folder: 'INBOX', uid, subject: 'S', fromName: '', fromAddr: 'a@example.com', toAddrs: '', receivedAt: 1_700_000_000_000 });

  it('stores the html capped, keeps it out of bodyText and the FTS index, and returns it only through html()', () => {
    const s = new MailStore(':memory:');
    s.addAccount(account);
    const r = s.upsertMessage(header(1));
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { text: 'plain words', html: `<p>htmlonlytoken</p>${'x'.repeat(MAX_BODY_HTML)}` });
    const b = s.body(r.id)!;
    expect(b.hasHtml).toBe(true);
    expect(b.bodyText).toBe('plain words');
    expect(JSON.stringify(b)).not.toContain('htmlonlytoken');
    expect(s.html(r.id)!.length).toBe(MAX_BODY_HTML);
    expect(s.search('htmlonlytoken').hits).toHaveLength(0);
    // an empty html removes the stored one
    s.setBody('a1', 'INBOX', 1, { text: 'plain words' });
    expect(s.body(r.id)!.hasHtml).toBe(false);
    expect(s.html(r.id)).toBeNull();
    s.close();
  });

  it('the html row goes with its message (account removal cascades)', () => {
    const s = new MailStore(':memory:');
    s.addAccount(account);
    const r = s.upsertMessage(header(1));
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { html: '<p>x</p>' });
    s.removeAccount('a1');
    expect(s.html(r.id)).toBeNull();
    s.close();
  });

  it('migrates a v1 store: the table appears, existing messages keep their text and simply have no html', () => {
    const f = join(tmp(), DB_FILE);
    const s = new MailStore(f);
    s.addAccount(account);
    const r = s.upsertMessage(header(1));
    if (!r.ok) throw new Error(r.error);
    s.setBody('a1', 'INBOX', 1, { text: 'old text' });
    s.close();
    // turn it back into a v1 file, the way one written before this change looks
    const raw = new DatabaseSync(f);
    raw.exec('DROP TABLE message_html');
    dropV4(raw);
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const again = new MailStore(f);
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5); // ticket 41
    // v3: the text stays, and the message is marked unfetched so the next open stores its HTML
    expect(again.body(r.id)).toMatchObject({ bodyText: 'old text', hasHtml: false, bodyFetched: false });
    again.setBody('a1', 'INBOX', 1, { text: 'old text', html: '<p>new</p>' });
    expect(again.html(r.id)).toBe('<p>new</p>');
    again.close();
  });

  it('migrates a v2 store: text-only fetched bodies are re-marked unfetched, bodies WITH html are left alone', () => {
    const f = join(tmp(), DB_FILE);
    const s = new MailStore(f);
    s.addAccount(account);
    const a = s.upsertMessage(header(1));
    const b = s.upsertMessage(header(2));
    if (!a.ok || !b.ok) throw new Error('upsert');
    s.setBody('a1', 'INBOX', 1, { text: 'text only' });
    s.setBody('a1', 'INBOX', 2, { text: 'has html', html: '<p>x</p>' });
    s.close();
    const raw = new DatabaseSync(f);
    dropV4(raw);
    raw.exec('PRAGMA user_version = 2');
    raw.close();
    const again = new MailStore(f);
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(again.body(a.id)).toMatchObject({ bodyText: 'text only', bodyFetched: false });
    expect(again.body(b.id)).toMatchObject({ bodyText: 'has html', bodyFetched: true, hasHtml: true });
    again.close();
  });
});

// ---------------------------------------------------------------- invisible to the agent (structural)

describe('mail html: the view is invisible to the agent and every page-reading path', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('html-view.ts reaches no tab, driver, capture, reader or preload code', () => {
    const v = src('src/main/mail/html-view.ts');
    expect(v).not.toMatch(/from '\.\.\/(tabs|capture|reader-mode|tab-preload|page-scripts|preload)'/);
    expect(v).not.toMatch(/preload\s*:/);
    expect(v).not.toMatch(/executeJavaScript/);
  });

  it('the agent, capture and reader paths only ever target TabManager tabs, and the runtime never hands the view to them', () => {
    const rt = src('src/main/runtime.ts');
    // the driver is built from a TabManager tab; ownsWebContents / isUi know nothing of the mail view
    expect(rt).toMatch(/driver: new ElectronDriver\(tab\)/);
    expect(rt).toMatch(/const tab = opts\.tab \?\? tabs\.active\(\);/);
    // the only caller passing `opts.tab` (an MCP task, item 3) passes a tab it created with the TabManager
    expect(src('src/main/runtime/mcp.ts')).toMatch(/const tab = rt\.tabs\.create\('about:blank'/);
    const owns = /ownsWebContents: \(wc: WebContents\) => ([^\n]+)/.exec(rt)![1];
    expect(owns).not.toMatch(/mail/i);
    const isUi = /isUi: \(wc: WebContents\) => ([^\n]+)/.exec(rt)![1];
    expect(isUi).toBe('!win.isDestroyed() && wc === win.webContents,');
    // the view is constructed in exactly one place, and the TabManager never sees it
    expect(rt.match(/new MailHtmlView\(/g)).toHaveLength(1);
    expect(src('src/main/tabs.ts')).not.toMatch(/MailHtmlView|html-view/);
    for (const f of ['src/main/capture.ts', 'src/main/reader-mode.ts', 'src/main/runtime/ipc-misc.ts', 'src/core/agent.ts', 'src/core/planner.ts', 'src/core/reader.ts']) {
      expect(src(f), f).not.toMatch(/mailView|MailHtmlView|html-view/);
    }
  });

  it('main.ts resolves chrome IPC only from a runtime\'s own UI window (the view has no preload and cannot be a sender)', () => {
    const m = src('src/main/main.ts');
    expect(m).toMatch(/return \[\.\.\.runtimes\.values\(\)\]\.find\(\(r\) => r\.isUi\(wc\)\);/);
    expect(m).toMatch(/const rt = runtimeOfUi\(e\.sender\);/);
  });
});

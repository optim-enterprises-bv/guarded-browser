import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAR_ID, BookmarkStore, MAX_DEPTH, MAX_NODES, OTHER_ID, htmlText, parseNetscape, safeUrl } from '../../src/core/bookmarks';
import { HistoryStore, MAX_VISITS_PER_ORIGIN_PER_MIN, recordable } from '../../src/core/history';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'gb-hist-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('history store', () => {
  it('records only real web pages, caps titles, groups by day, searches and filters by source', () => {
    const f = join(tmp(), 'history.json');
    const h = new HistoryStore(f);
    const t0 = new Date(2026, 8, 27, 10).getTime();
    expect(h.record('https://shop.example/a', 'Shop <b>A</b>', 'user', t0)).toBe(true);
    h.record('https://shop.example/a', 'Shop A', 'agent', t0 + 60_000);
    h.record('https://news.example/', 'x'.repeat(500), 'page', t0 + 86_400_000);
    for (const bad of ['data:text/html,hi', 'blob:https://x/1', 'about:blank', 'file:///etc/passwd', 'https://guarded-browser.invalid/proceed?t=1', 'javascript:alert(1)']) {
      expect(h.record(bad, 't', 'user', t0), bad).toBe(false);
      expect(recordable(bad)).toBe(false);
    }
    const g = h.grouped();
    expect(g.map((d) => d.day)).toEqual(['2026-09-28', '2026-09-27']);
    expect(g[1].entries[0]).toMatchObject({ url: 'https://shop.example/a', visits: 2 });
    expect(g[1].entries[0].sources.sort()).toEqual(['agent', 'user']);
    expect(g[0].entries[0].title.length).toBe(200);
    expect(h.grouped('shop').flatMap((d) => d.entries)).toHaveLength(1);
    expect(h.grouped('', 'agent').flatMap((d) => d.entries).map((e) => e.url)).toEqual(['https://shop.example/a']);
    expect(h.suggest('shop')[0].url).toBe('https://shop.example/a');
    h.updateTitle('https://news.example/', 'News');
    expect(h.grouped('news')[0].entries[0].title).toBe('News');
  });

  it('deletes by url and by range; persists atomically (0600) and validates on load', () => {
    const f = join(tmp(), 'history.json');
    const h = new HistoryStore(f);
    const now = Date.now();
    h.record('https://a.example/', 'a', 'user', now - 10 * 60_000);
    h.record('https://b.example/', 'b', 'user', now - 5 * 3_600_000);
    h.record('https://c.example/', 'c', 'user', now - 3 * 86_400_000);
    h.record('https://d.example/', 'd', 'user', now - 30 * 86_400_000);
    expect(h.deleteRange('hour', now)).toBe(1);
    expect(h.deleteRange('day', now)).toBe(1);
    expect(h.deleteRange('week', now)).toBe(1);
    expect(h.deleteUrl('https://d.example/')).toBe(1);
    h.record('https://e.example/', 'e', 'page');
    h.flush();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(new HistoryStore(f).visits().map((v) => v.url)).toEqual(['https://e.example/']);
    h.deleteRange('all');
    expect(new HistoryStore(f).visits()).toEqual([]);
    writeFileSync(f, JSON.stringify({ version: 1, clearOnExit: false, visits: [{ url: 'x', title: 't', t: 1, source: 'hacker' }] }));
    const bad = new HistoryStore(f);
    expect(bad.loadError).toBeTruthy();
    expect(bad.visits()).toEqual([]);
  });
});

describe('bookmark store', () => {
  it('add / edit / nickname / folders / move / delete / search, http(s) only', () => {
    const f = join(tmp(), 'bookmarks.json');
    const s = new BookmarkStore(f);
    const a = s.addBookmark(BAR_ID, 'Shop', 'https://shop.example/', 'shop');
    const folder = s.addFolder(OTHER_ID, 'Work');
    const sub = s.addFolder(folder.id, 'Docs');
    const b = s.addBookmark(sub.id, 'Spec', 'https://docs.example/spec');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x', 'not a url']) expect(() => s.addBookmark(BAR_ID, 'x', bad), bad).toThrow(/http/);
    expect(() => s.addBookmark(BAR_ID, 'dup nick', 'https://x.example/', 'shop')).toThrow(/nickname/);
    expect(() => s.update(a.id, { nickname: 'Bad Nick!' })).toThrow(/nickname/);
    s.update(b.id, { title: 'Spec v2', url: 'https://docs.example/v2', nickname: 'spec' });
    expect(s.byNickname('SPEC')?.url).toBe('https://docs.example/v2');
    expect(s.search('docs').map((x) => x.title)).toEqual(['Spec v2']);
    expect(s.search('docs')[0].path).toBe('Other bookmarks/Work/Docs');
    s.move(b.id, BAR_ID, 0);
    expect(s.tree()[0].children.map((n) => n.title)).toEqual(['Spec v2', 'Shop']);
    s.move(b.id, BAR_ID, 2); // same folder, to the end
    expect(s.tree()[0].children.map((n) => n.title)).toEqual(['Shop', 'Spec v2']);
    expect(() => s.move(folder.id, sub.id, 0)).toThrow(/into itself/);
    s.remove(folder.id);
    expect(s.search('docs').length).toBe(1); // Spec moved out before the folder was deleted
    expect(s.isBookmarked('https://shop.example/')).toBe(a.id);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(new BookmarkStore(f).all().map((x) => x.title).sort()).toEqual(['Shop', 'Spec v2']);
  });

  it('refuses invalid files on load (schemes, depth, unknown keys)', () => {
    const f = join(tmp(), 'bookmarks.json');
    const s = new BookmarkStore(f);
    s.addBookmark(BAR_ID, 'ok', 'https://ok.example/');
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    raw.roots[0].children[0].url = 'javascript:alert(1)';
    writeFileSync(f, JSON.stringify(raw));
    const bad = new BookmarkStore(f);
    expect(bad.loadError).toBeTruthy();
    expect(bad.all()).toEqual([]);
  });
});

describe('Netscape bookmark import / export', () => {
  const file = (body: string) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<DL><p>\n${body}\n</DL><p>\n`;

  it('parses folders, bookmarks and nicknames; drops non-http(s) URLs; titles are plain text', () => {
    const p = parseNetscape(file(`
      <DT><H3>Folder &amp; <i>stuff</i></H3>
      <DL><p>
        <DT><A HREF="https://a.example/" SHORTCUTURL="aa">A &lt;title&gt;</A>
        <DT><A HREF="javascript:alert(document.cookie)">bookmarklet</A>
        <DT><A HREF="data:text/html,<script>alert(1)</script>">data</A>
        <DT><A HREF="file:///etc/passwd">file</A>
        <DT><A HREF='https://b.example/x?y=1'>B<script>alert(1)</script></A>
        <DT><A HREF=http://c.example/>C</A>
      </DL><p>
      <script>document.write('<DT><A HREF="https://injected.example/">x</A>')</script>
      <!-- <DT><A HREF="https://commented.example/">x</A> -->
    `));
    expect(p.bookmarks).toBe(3);
    expect(p.skipped).toBe(3);
    const folder = p.children[0];
    expect(folder).toMatchObject({ type: 'folder', title: 'Folder & stuff' });
    const kids = folder.type === 'folder' ? folder.children : [];
    expect(kids.map((k) => (k.type === 'bookmark' ? [k.title, k.url, k.nickname ?? null] : null))).toEqual([
      ['A <title>', 'https://a.example/', null], // SHORTCUTURL is never imported
      ['B', 'https://b.example/x?y=1', null],
      ['C', 'http://c.example/', null],
    ]);
    expect(JSON.stringify(p)).not.toMatch(/injected|commented|javascript:|data:|file:/);
    expect(p.nicknamesDropped).toBe(1);
  });

  it('caps size, node count and depth', () => {
    expect(() => parseNetscape(file('x'.repeat(6 * 1024 * 1024)))).toThrow(/larger than/);
    expect(() => parseNetscape('<html><body>nope</body></html>')).toThrow(/not a Netscape/);
    const many = parseNetscape(file(Array.from({ length: MAX_NODES + 50 }, (_, i) => `<DT><A HREF="https://x.example/${i}">${i}</A>`).join('\n')));
    expect(many.bookmarks).toBe(MAX_NODES);
    expect(many.skipped).toBe(50);
    const deep = parseNetscape(file(`${'<DT><H3>d</H3><DL><p>'.repeat(200)}<DT><A HREF="https://deep.example/">deep</A>${'</DL><p>'.repeat(200)}`));
    let depth = 0;
    let n = deep.children[0];
    while (n && n.type === 'folder') {
      depth++;
      n = n.children.find((c) => c.type === 'folder') ?? n.children[0];
    }
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
    expect(JSON.stringify(deep)).toContain('https://deep.example/');
    expect(htmlText('a&#0;b&#xD800;c&#x1F600;')).toBe('a b c\u{1F600}');
  });

  it('round-trips through export and import', () => {
    const s = new BookmarkStore(join(tmp(), 'b.json'));
    const f = s.addFolder(BAR_ID, 'Tools & "stuff"');
    s.addBookmark(f.id, 'Search <engine>', 'https://search.example/?q=a&b=c', 'srch');
    s.addBookmark(OTHER_ID, 'Other', 'https://other.example/');
    const html = s.exportNetscape();
    expect(html).toMatch(/^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true"');
    const t = new BookmarkStore(join(tmp(), 'c.json'));
    const r = t.importNetscape(html);
    expect(r).toMatchObject({ imported: 2, skipped: 0, nicknamesDropped: 1 });
    const got = t.all().map((b) => [b.path, b.title, b.url, b.nickname ?? null]);
    expect(got).toEqual([
      ['Other bookmarks/Imported/Bookmarks bar/Tools & "stuff"', 'Search <engine>', 'https://search.example/?q=a&b=c', null],
      ['Other bookmarks/Imported/Other bookmarks', 'Other', 'https://other.example/', null],
    ]);
  });

  it('importing into the same store drops nicknames that are already taken; the bar is off by default', () => {
    const s = new BookmarkStore(join(tmp(), 'n.json'));
    expect(s.showBar).toBe(false);
    s.addBookmark(BAR_ID, 'A', 'https://a.example/', 'aa');
    const r = s.importNetscape(s.exportNetscape());
    expect(r.imported).toBe(1);
    expect(s.all().filter((b) => b.nickname === 'aa')).toHaveLength(1);
  });

  it('safeUrl accepts only http(s)', () => {
    expect(safeUrl('https://x.example')).toBe('https://x.example/');
    for (const u of ['javascript:1', ' JAVASCRIPT:alert(1)', 'data:,', 'file:///', 'chrome://settings', 'vbscript:x', '//x.example']) expect(safeUrl(u), u).toBeNull();
  });
});

describe('review r8: parser timing, nicknames', () => {
  it('a 5 MB adversarial file parses in well under a second (linear, stops at the node cap)', () => {
    const pad = 'x'.repeat(100);
    for (const tags of [8000, 30_000]) {
      const body = Array.from({ length: tags }, (_, i) => `<DT><A HREF="https://e${i}.example/">${pad}</A>`).join('\n');
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n${body}\n</DL>`.slice(0, 5 * 1024 * 1024);
      const t = Date.now();
      const r = parseNetscape(html);
      expect(Date.now() - t, `${tags} tags`).toBeLessThan(1000);
      expect(r.bookmarks).toBe(Math.min(tags, MAX_NODES));
    }
    // no closing tags at all (every title search runs to the end of the file in the naive parser)
    const open = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>${'<DT><H3>t'.repeat(400_000)}`.slice(0, 5 * 1024 * 1024);
    const t2 = Date.now();
    parseNetscape(open);
    expect(Date.now() - t2).toBeLessThan(1000);
  });

  it('never imports nicknames; reserved words cannot be nicknames', () => {
    const nick = parseNetscape('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://evil.example/login" SHORTCUTURL="bank">Bank</A><DT><A HREF="https://evil.example/r" SHORTCUTURL="localhost">x</A><DT><A HREF=" JaVaScRiPt:alert(1)">j</A><DT><A HREF="&#106;avascript:alert(1)">k</A><DT><A HREF="https://ok.example/" ICON="data:text/html,<script>1</script>">ok</A></DL>');
    expect(nick.children.map((n) => (n.type === 'bookmark' ? [n.url, n.nickname ?? ''] : null))).toEqual([
      ['https://evil.example/login', ''],
      ['https://evil.example/r', ''],
      ['https://ok.example/', ''],
    ]);
    expect(nick.skipped).toBe(2);
    expect(nick.nicknamesDropped).toBe(2);
    expect(JSON.stringify(nick)).not.toMatch(/icon|data:text/i);
    const s = new BookmarkStore(join(tmp(), 'r.json'));
    for (const bad of ['localhost', 'wpad', 'router', 'intranet', 'javascript']) {
      expect(() => s.addBookmark(BAR_ID, 'x', 'https://x.example/', bad), bad).toThrow(/reserved/);
    }
  });
});

describe('review: history clear-on-exit after a crash, flood limit, async writes', () => {
  it('clears at load when "clear on exit" was set and the last exit did not clear', () => {
    const f = join(tmp(), 'history.json');
    writeFileSync(f, JSON.stringify({ version: 1, clearOnExit: true, visits: [{ url: 'https://left.example/', title: 't', t: 1, source: 'user' }] }));
    const h = new HistoryStore(f);
    expect(h.visits()).toEqual([]);
    expect(JSON.parse(readFileSync(f, 'utf8')).visits).toEqual([]);
  });

  it('a page cannot flood history: <= 30 visits per origin per minute, other origins unaffected', async () => {
    const f = join(tmp(), 'history.json');
    const h = new HistoryStore(f);
    h.record('https://real.example/', 'real', 'user', 1_000);
    const t0 = 10_000;
    let stored = 0;
    for (let i = 0; i < 500; i++) if (h.record(`https://flood.example/${i}`, 'x', 'page', t0 + i * 10)) stored++;
    expect(stored).toBe(MAX_VISITS_PER_ORIGIN_PER_MIN);
    expect(h.record('https://other.example/', 'o', 'user', t0 + 5000)).toBe(true);
    expect(h.record('https://flood.example/later', 'x', 'page', t0 + 61_000)).toBe(true); // next minute
    expect(h.visits().some((v) => v.url === 'https://real.example/')).toBe(true);
    // writes are asynchronous and atomic; a later synchronous flush always wins
    await new Promise((r) => setTimeout(r, 2200));
    await h.settled();
    expect(JSON.parse(readFileSync(f, 'utf8')).visits.length).toBe(33);
    h.deleteRange('all');
    await h.settled();
    expect(JSON.parse(readFileSync(f, 'utf8')).visits).toEqual([]);
  });
});

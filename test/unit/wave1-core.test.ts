// Unit tests for the Wave-1 store/config modules. These are the ones that must be right without a
// browser: what a session file may contain, what zoom is allowed to be, how a search template is
// substituted, and what the chord table resolves to.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, MAX_TABS, restorable } from '../../src/core/session-state';
import { ZoomStore, clampZoom, stepZoom, MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS } from '../../src/core/zoom';
import { SEARCH_ENGINES, searchUrl, SearchSettingsSchema, defaultSearch, validTemplate } from '../../src/core/search';
import { DownloadList, MAX_FILENAME, type DownloadItemLike } from '../../src/core/downloads';
import { resolveChord, DEFAULT_CHORDS } from '../../src/core/chords';

const tmp = () => mkdtempSync(join(tmpdir(), 'gb-w1-'));

describe('SessionStore', () => {
  it('round-trips tabs, active index and tiling', () => {
    const dir = tmp();
    const s = new SessionStore(join(dir, 'session.json'));
    s.save(
      [
        { url: 'https://a.example/', title: 'A' },
        { url: 'https://b.example/', title: 'B' },
      ],
      1,
      { indexes: [0, 1], layout: 'columns', ratios: [0.5, 0.5] },
      true,
    );
    const s2 = new SessionStore(join(dir, 'session.json'));
    const r = s2.restorableTabs();
    expect(r.tabs.map((t) => t.url)).toEqual(['https://a.example/', 'https://b.example/']);
    expect(r.activeIndex).toBe(1);
    expect(s2.crashed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('cannot represent gate state — a tampered file is rejected outright', () => {
    // The invariant that matters for reopen/restore: a restored tab starts clean. The strongest
    // form of that claim is that the schema has no field for gate state, so a hand-written file
    // carrying one cannot even be parsed.
    const dir = tmp();
    const f = join(dir, 'session.json');
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        clean: true,
        activeIndex: 0,
        tiles: null,
        tabs: [{ url: 'https://x.example/', title: 'X', gate: 'post-task', agentTab: true, taint: true }],
      }),
    );
    const s = new SessionStore(f);
    expect(s.loadError).toBeTruthy();
    expect(s.restorableTabs().tabs).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a restored tab has exactly url + title, nothing else', () => {
    const dir = tmp();
    const f = join(dir, 'session.json');
    const s = new SessionStore(f);
    s.save([{ url: 'https://x.example/', title: 'X' }], 0, null, true);
    const r = new SessionStore(f).restorableTabs();
    expect(Object.keys(r.tabs[0]).sort()).toEqual(['title', 'url']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops non-web URLs and clamps the tab list', () => {
    const dir = tmp();
    const many = Array.from({ length: MAX_TABS + 25 }, (_, i) => ({ url: `https://s${i}.example/`, title: `${i}` }));
    many.push({ url: 'file:///etc/passwd', title: 'no' }, { url: 'javascript:alert(1)', title: 'no' }, { url: 'about:blank', title: 'blank' }, { url: 'data:text/html,x', title: 'no' });
    const s = new SessionStore(join(dir, 'session.json'));
    s.save(many, 0, null, true);
    const r = s.restorableTabs();
    expect(r.tabs.length).toBeLessThanOrEqual(MAX_TABS);
    expect(r.tabs.every((t) => /^https?:/.test(t.url))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('restorable() rejects anything that is not a plain web page', () => {
    expect(restorable('https://a.example/')).toBe(true);
    expect(restorable('about:blank')).toBe(false);
    expect(restorable('file:///etc/passwd')).toBe(false);
    expect(restorable('javascript:alert(1)')).toBe(false);
    expect(restorable('data:text/html,<b>x')).toBe(false);
    expect(restorable('')).toBe(false);
  });

  it('an unclean exit is detected at the next launch', () => {
    const dir = tmp();
    const f = join(dir, 'session.json');
    // while running the file says clean:false — exactly what a crash leaves behind
    new SessionStore(f).save([{ url: 'https://a.example/', title: 'A' }], 0, null, false);
    expect(new SessionStore(f).crashed).toBe(true);
    // a clean quit marks it clean, so the next launch has nothing to report
    new SessionStore(f).save([{ url: 'https://a.example/', title: 'A' }], 0, null, true);
    expect(new SessionStore(f).crashed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('written file is 0600', () => {
    const dir = tmp();
    const f = join(dir, 'session.json');
    new SessionStore(f).save([{ url: 'https://a.example/', title: 'A' }], 0, null, true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('zoom', () => {
  it('steps through the ladder and clamps at both ends', () => {
    expect(stepZoom(1, 1)).toBeGreaterThan(1);
    expect(stepZoom(1, -1)).toBeLessThan(1);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM);
    expect(clampZoom(1.1)).toBe(1.1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS).toContain(1); // 100% is always reachable
  });

  it('remembers per origin, and 100% means "forget it"', () => {
    const dir = tmp();
    const z = new ZoomStore(join(dir, 'zoom.json'));
    z.set('https://a.example', 1.5);
    expect(z.get('https://a.example')).toBe(1.5);
    expect(z.get('https://b.example')).toBe(1); // unknown origin is 100%
    z.clear('https://a.example');
    expect(z.get('https://a.example')).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed on a tampered store rather than trusting it', () => {
    // An out-of-range factor means the file is not ours: reject the whole thing, remember nothing.
    const dir = tmp();
    const f = join(dir, 'zoom.json');
    writeFileSync(f, JSON.stringify({ version: 1, origins: { 'https://a.example': 9999 } }));
    const z = new ZoomStore(f);
    expect(z.loadError).toBeTruthy();
    expect(z.get('https://a.example')).toBe(1);
    expect(z.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('search', () => {
  it('substitutes exactly one encoded query', () => {
    const q = 'a b&c=d?e';
    const url = searchUrl(q, { engine: 'duckduckgo', customTemplate: '' });
    expect(url).toBe(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`);
    expect(url).not.toMatch(/&c=d/); // the & is encoded, not left as a parameter break
  });

  it('a query cannot escape into another origin or a scheme', () => {
    const url = searchUrl('https://evil.example/', { engine: 'duckduckgo', customTemplate: '' });
    expect(new URL(url).origin).toBe('https://duckduckgo.com');
  });

  it('a custom template must be http(s) and carry exactly one %s', () => {
    expect(SearchSettingsSchema.safeParse({ engine: 'custom', customTemplate: 'javascript:alert(%s)' }).success).toBe(false);
    expect(SearchSettingsSchema.safeParse({ engine: 'custom', customTemplate: 'file:///x%s' }).success).toBe(false);
    expect(SearchSettingsSchema.safeParse({ engine: 'custom', customTemplate: 'https://s.example/?q=%s' }).success).toBe(true);
    // exactly one %s: none, or two, is invalid
    expect(validTemplate('https://s.example/?q=')).toBe(false);
    expect(validTemplate('https://s.example/?q=%s&p=%s')).toBe(false);
    expect(validTemplate('https://s.example/?q=%d')).toBe(false);
    expect(validTemplate('https://s.example/?q=%s')).toBe(true);
  });

  it('an unknown engine id is rejected, and the default is a real engine', () => {
    expect(SearchSettingsSchema.safeParse({ engine: 'not-an-engine', customTemplate: '' }).success).toBe(false);
    expect(SEARCH_ENGINES.some((e) => e.id === defaultSearch().engine)).toBe(true);
  });

  it('every built-in engine is https with exactly one %s', () => {
    expect(SEARCH_ENGINES.every((e) => validTemplate(e.template))).toBe(true);
  });
});

describe('DownloadList', () => {
  function fakeItem(over: Partial<DownloadItemLike> = {}): DownloadItemLike & { fire: (e: 'updated' | 'done', s: string) => void } {
    const handlers: Record<string, Array<(e: unknown, s: string) => void>> = { updated: [], done: [] };
    return {
      getFilename: () => 'report.pdf',
      getURL: () => 'https://files.example/report.pdf',
      getTotalBytes: () => 1000,
      getReceivedBytes: () => 250,
      getSavePath: () => '',
      isPaused: () => false,
      canResume: () => true,
      pause: () => undefined,
      resume: () => undefined,
      cancel: () => undefined,
      on: (e: 'updated' | 'done', cb: (e: unknown, s: string) => void) => handlers[e].push(cb),
      fire: (e: 'updated' | 'done', s: string) => handlers[e].forEach((cb) => cb({}, s)),
      ...over,
    } as DownloadItemLike & { fire: (e: 'updated' | 'done', s: string) => void };
  }

  it('an agent download shows as denied, never as completed, when the user refused it', () => {
    const list = new DownloadList();
    const id = list.add(fakeItem(), { agentTask: true, host: 'files.example', source: 'agent' });
    expect(list.list()[0].state).toBe('progressing');
    list.failed(id, 'denied');
    expect(list.list()[0].state).toBe('denied');
    expect(list.list()[0].path).toBeUndefined();
  });

  it('records progress and completion, and caps the filename', () => {
    const list = new DownloadList();
    const item = fakeItem({ getFilename: () => 'x'.repeat(500) + '.pdf' });
    const id = list.add(item, { agentTask: false, host: 'files.example', source: 'user' });
    expect(list.list()[0].filename.length).toBe(MAX_FILENAME);
    item.fire('updated', 'progressing');
    expect(list.list()[0].received).toBe(250);
    list.saved(id, '/home/x/report.pdf');
    expect(list.list()[0]).toMatchObject({ state: 'completed', path: '/home/x/report.pdf' });
  });

  it('strips path separators from a page-supplied filename', () => {
    const list = new DownloadList();
    list.add(fakeItem({ getFilename: () => '../../etc/passwd' }), { agentTask: false, host: 'h', source: 'user' });
    expect(list.list()[0].filename).toBe('passwd');
  });

  it('an active transfer is not removable, a finished one is', () => {
    const list = new DownloadList();
    const id = list.add(fakeItem(), { agentTask: false, host: 'h', source: 'user' });
    expect(list.action(id, 'remove')).toBe(false);
    list.saved(id, '/x/y');
    expect(list.action(id, 'remove')).toBe(true);
    expect(list.list()).toHaveLength(0);
  });

  it('counts only in-flight transfers as active', () => {
    const list = new DownloadList();
    const a = list.add(fakeItem(), { agentTask: false, host: 'h', source: 'user' });
    expect(list.activeCount).toBe(1);
    list.failed(a, 'denied');
    expect(list.activeCount).toBe(0);
  });
});

describe('chords', () => {
  it('resolves the documented chords', () => {
    expect(resolveChord({ key: 't', control: true, type: 'keyDown' })).toBe('tab.new');
    expect(resolveChord({ key: 'T', control: true, shift: true, type: 'keyDown' })).toBe('tab.reopen');
    expect(resolveChord({ key: 'w', control: true, type: 'keyDown' })).toBe('tab.close');
    expect(resolveChord({ key: '=', control: true, type: 'keyDown' })).toBe('view.zoomIn');
    expect(resolveChord({ key: '-', control: true, type: 'keyDown' })).toBe('view.zoomOut');
    expect(resolveChord({ key: '0', control: true, type: 'keyDown' })).toBe('view.zoomReset');
    expect(resolveChord({ key: 'f', control: true, type: 'keyDown' })).toBe('view.find');
    expect(resolveChord({ key: 'p', control: true, type: 'keyDown' })).toBe('view.print');
    expect(resolveChord({ key: 'F5', type: 'keyDown' })).toBe('tab.reload');
    expect(resolveChord({ key: 'F11', type: 'keyDown' })).toBe('view.fullscreen');
  });

  it('requires exact modifiers, so Ctrl+Shift+T never means Ctrl+T', () => {
    expect(resolveChord({ key: 't', control: true, shift: true })).toBe('tab.reopen');
    // an extra modifier is NOT matched. Ctrl+Alt+T is bound to translate (wave 2), so the unbound
    // combination to assert against is Ctrl+Alt+Shift+T — the point is the exactness, not the key.
    expect(resolveChord({ key: 't', control: true, alt: true })).toBe('view.translate');
    expect(resolveChord({ key: 't', control: true, alt: true, shift: true })).toBeNull();
    expect(resolveChord({ key: 't', shift: true })).toBeNull(); // shift alone is never a chord
  });

  it('leaves ordinary typing to the page', () => {
    expect(resolveChord({ key: 'a' })).toBeNull();
    expect(resolveChord({ key: 'Enter' })).toBeNull();
    expect(resolveChord({ key: 't' })).toBeNull();
  });

  it('meta counts as ctrl (macOS) and keyUp is ignored', () => {
    expect(resolveChord({ key: 't', meta: true, type: 'keyDown' })).toBe('tab.new');
    expect(resolveChord({ key: 't', control: true, type: 'keyUp' })).toBeNull();
  });

  it('has no duplicate chord that would shadow another action', () => {
    const seen = new Map<string, string>();
    for (const c of DEFAULT_CHORDS) {
      const k = `${c.ctrl ? 'C' : ''}${c.shift ? 'S' : ''}${c.alt ? 'A' : ''}:${c.key}`;
      const clash = seen.get(k);
      expect(clash === undefined || clash === c.action, `chord ${k} maps to both ${clash} and ${c.action}`).toBe(true);
      seen.set(k, c.action);
    }
  });
});

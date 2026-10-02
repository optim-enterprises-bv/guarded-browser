// Chrome IPC: quick commands, gestures, reader mode, translate, capture, page actions, the
// ephemeral-window hint and the profile bundle.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import { CaptureRequestSchema, captureFilename, clampFullHeight, clampRect, writeCapture } from '../capture';
import { EXTRACT_ARTICLE_JS, normalizeArticle } from '../reader-mode';
import { ISOLATED_WORLD } from '../page-scripts';
import { LANGUAGES, TRANSLATE_SYSTEM, canTranslate, chunkText, cloudStatus, translatePrompt } from '../translate';
import { MAX_BUNDLE_BYTES, buildBundle, dryRun, parseBundle } from '../../core/profile-bundle';
import { PageActionsSchema, defaultPageActions } from '../../core/page-actions';
import { type Settings, saveSettings } from '../../core/config';
import { clampItems } from '../../core/quick-commands';
import { clipboard, dialog } from 'electron';
import { originOf } from '../../core/policy';
import { pathFrom, resolveGesture } from '../../core/gestures';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { defaultKeybindings, validateBindings } from '../../core/keybindings';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const { applyPageActions, bookmarks, commandItems, ctx, handlers, pageActions, runAction, savedSessions, sendUI, settingsFile, workspaces } = rt;
  // ---------- 16: gestures ----------
  // The trail is fed from the page view's own input events (setupTab in runtime.ts), never by page
  // script. A gesture is REFUSED while a task runs: it could otherwise move the agent's tab out from
  // under the gate.
  on('gesture:trail', (_e, phase: unknown, x: unknown, y: unknown) => {
    if (rt.settings.gestures.enabled !== true) return { action: null };
    if (phase === 'start') rt.gestureTrail = [{ x: Number(x) || 0, y: Number(y) || 0 }];
    else if (phase === 'move') rt.gestureTrail.push({ x: Number(x) || 0, y: Number(y) || 0 });
    else if (phase === 'end') {
      // The final point IS part of the path: a flick sends start then end, with no 'move' in
      // between, so dropping the end point left a one-point trail and no gesture ever resolved.
      rt.gestureTrail.push({ x: Number(x) || 0, y: Number(y) || 0 });
      const path = pathFrom(rt.gestureTrail);
      rt.gestureTrail = [];
      const r = resolveGesture(path, { suppressed: !!rt.current });
      if ('suppressed' in r) {
        sendUI('gesture', { path, suppressed: true, reason: 'an agent task is running' });
        return { suppressed: true };
      }
      if (r.action) runAction(r.action);
      return { action: r.action };
    }
    return { action: null };
  });

  // ---------- 14: quick commands ----------
  on('commands:search', () => clampItems(commandItems()));
  /** Run a bound action by NAME. The palette reaches actions through this, so it cannot do anything
   *  a chord cannot, and there is a single dispatch path (runAction). */
  on('action:run', (_e, action: unknown) => ({ ok: runAction(String(action ?? '')) }));

  // ---------- 24: reader mode (HUMAN-ONLY output) ----------
  on('reader:open', async () => {
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    if (t.wc.getURL() === '' || t.wc.getURL() === 'about:blank') return { ok: false, error: 'nothing to read' };
    try {
      // runs in the page's own ISOLATED WORLD; its output is text and is shown to the human only
      const raw = await t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: EXTRACT_ARTICLE_JS }]);
      const article = normalizeArticle(raw);
      if (!article.ok) return { ok: false, error: article.error ?? 'no readable content' };
      // NOTE, and it is the point of this ticket: this NEVER calls runReader, never touches taint,
      // and never reaches the planner. Reader mode is not a text channel into any model.
      rt.audit.write('reader', { taskId: rt.current?.task.id, url: t.wc.getURL(), blocks: article.blocks.length, humanOnly: true });
      return { ok: true, article };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  on('translate:run', async (_e, langCode: unknown) => {
    const gate = canTranslate(rt.settings.translate, { taskRunning: !!rt.current });
    if (!gate.ok) return { ok: false, error: gate.error };
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    const target = String(langCode ?? rt.settings.translate.targetLang);
    const label = LANGUAGES.find((l) => l.code === target)?.label ?? target;
    try {
      const text = String(await t.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: '(() => (document.body && document.body.innerText) || "")()' }]) ?? '');
      const chunks = chunkText(text);
      if (!chunks.length) return { ok: false, error: 'nothing to translate' };
      const out: string[] = [];
      for (const c of chunks.slice(0, 10)) {
        const r = await fetch(rt.settings.translate.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: rt.settings.translate.model || undefined,
            messages: [
              { role: 'system', content: TRANSLATE_SYSTEM },
              { role: 'user', content: translatePrompt(c, label) },
            ],
          }),
        });
        if (!r.ok) return { ok: false, error: `endpoint returned ${r.status}` };
        const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
        out.push(String(j.choices?.[0]?.message?.content ?? '').slice(0, 20_000));
      }
      // deliberately NOT recorded as taint: this text went to the user's OWN configured endpoint for
      // the user, and marking the page tainted would silently change the agent's behaviour on it
      rt.audit.write('translate', { taskId: rt.current?.task.id, url: t.wc.getURL(), target: label, chunks: out.length, taint: false });
      return { ok: true, text: out.join('\n\n'), target: label, status: cloudStatus(rt.settings.translate) };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  // ---------- 26: capture ----------
  on('capture:run', async (_e, req: unknown) => {
    // (1) chrome-initiated only: there is no path from a page to this handler. (2) never while a
    // confirmation is pending — that would photograph the security UI.
    if (rt.broker.pendingCount() > 0) return { ok: false, error: 'a confirmation dialog is open; a capture now would include the security UI' };
    const parsed = CaptureRequestSchema.safeParse(req);
    if (!parsed.success) return { ok: false, error: 'bad capture request' };
    const t = rt.tabs.active();
    if (!t || t.wc.isDestroyed()) return { ok: false, error: 'no active tab' };
    try {
      const b = rt.tabs.paneBounds(t.id);
      const w = b.width;
      const h = b.height;
      let image: Electron.NativeImage;
      if (parsed.data.mode === 'visible') {
        image = await t.wc.capturePage();
      } else {
        const rect = parsed.data.mode === 'region' && parsed.data.rect ? clampRect(parsed.data.rect, { width: w, height: h }) : { x: 0, y: 0, width: w, height: h };
        if (parsed.data.mode === 'full') {
          // a page can report an enormous scroll height; cap it and say so rather than OOM
          const { height, clipped } = clampFullHeight(h, w);
          image = await t.wc.capturePage({ x: 0, y: 0, width: w, height });
          if (clipped) rt.audit.write('capture', { taskId: rt.current?.task.id, mode: 'full', clipped: true, height });
        } else {
          image = await t.wc.capturePage(rect);
        }
      }
      const png = image.toPNG();
      const save = await dialog.showSaveDialog(rt.win, { title: 'Save capture', defaultPath: captureFilename(originOf(t.wc.getURL())?.replace(/^https?:\/\//, '') ?? 'page') });
      if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled', bytes: png.length };
      const w2 = writeCapture(save.filePath, png);
      rt.audit.write('capture', { taskId: rt.current?.task.id, mode: parsed.data.mode, bytes: png.length, ok: w2.ok });
      return { ok: w2.ok, bytes: png.length, file: save.filePath, error: w2.ok ? undefined : w2.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });
  on('capture:to-clipboard', async (_e, req: unknown) => {
    if (rt.broker.pendingCount() > 0) return { ok: false, error: 'a confirmation dialog is open; a capture now would include the security UI' };
    const parsed = CaptureRequestSchema.safeParse(req);
    if (!parsed.success) return { ok: false, error: 'bad capture request' };
    const t = rt.tabs.active();
    if (!t || t.wc.isDestroyed()) return { ok: false, error: 'no active tab' };
    try {
      const bb = rt.tabs.paneBounds(t.id);
      const image = await t.wc.capturePage(parsed.data.rect ? clampRect(parsed.data.rect, bb) : undefined);
      const png = image.toPNG();
      // Electron 44 removed Clipboard.writeImage; the supported path is the async ClipboardItem API
      // the DOM lib also declares ClipboardItem with an incompatible getType signature, so this
      // goes through unknown; at runtime it is Electron's own ClipboardItem the module expects
      const item = new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }) as unknown as Electron.ClipboardItem;
      await clipboard.write([item]);
      rt.audit.write('capture', { taskId: rt.current?.task.id, mode: 'clipboard', bytes: png.length });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  // ---------- 27: page actions ----------
  on('pageactions:get', () => {
    const o = originOf(rt.tabs.active()?.wc.getURL() ?? '');
    return { actions: o ? pageActions.byOrigin(o) : defaultPageActions(), custom: o ? pageActions.byOrigin(o).customCss : '' };
  });
  on('pageactions:set', (_e, patch: unknown) => {
    const t = rt.tabs.active();
    if (!t) return { ok: false, error: 'no active tab' };
    const o = originOf(t.wc.getURL());
    if (!o) return { ok: false, error: 'this page has no origin to remember actions for' };
    const r = PageActionsSchema.safeParse({ ...pageActions.byOrigin(o), ...(patch as object) });
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    pageActions.set(o, r.data);
    applyPageActions(t, o);
    return { ok: true, actions: r.data };
  });

  // ---------- 29: ephemeral window ----------
  on('profiles:create-ephemeral', (_e, name: unknown) => {
    const p = ctx.profile();
    if (p.ephemeral) return { ok: false, error: 'this window is already ephemeral' };
    return { ok: true, hint: 'create it from the profile manager; the window is removed when it closes' };
  });

  // ---------- 30: profile bundle ----------
  on('bundle:export', (): string => {
    const b = buildBundle({
      settings: { general: rt.settings.general, hibernation: rt.settings.hibernation, translate: rt.settings.translate, gestures: rt.settings.gestures, extensions: rt.settings.extensions },
      themes: { custom: rt.settings.appearance.custom as unknown as Array<Record<string, unknown>>, activeId: rt.settings.appearance.theme },
      bookmarks: bookmarks.tree() as never,
      keybindings: rt.settings.keybindings.bindings,
      savedSessions: savedSessions.list().map((s) => ({ name: s.name, createdAt: s.createdAt, tabs: s.tabs })),
      workspaces: workspaces.list().map((w) => ({ name: w.name, colorIndex: w.colorIndex, tabs: w.tabs })),
    });
    return JSON.stringify(b, null, 2) + '\n';
  });
  on('bundle:dry-run', (_e, text: unknown) => dryRun(String(text ?? '')));
  on('bundle:import', (_e, text: unknown) => {
    const r = parseBundle(String(text ?? ''));
    if (!r.ok) return { ok: false, error: r.error };
    const b = r.bundle;
    const applied: string[] = [];
    // validated as a whole before anything is touched; a bundle that fails anywhere changes nothing
    if (b.settings) {
      const g = b.settings.general as Settings['general'] | undefined;
      if (g && typeof g === 'object') {
        rt.settings.general = { ...rt.settings.general, startup: g.startup === 'last-session' ? 'last-session' : rt.settings.general.startup, tabStrip: rt.settings.general.tabStrip };
        applied.push('settings');
      }
    }
    if (b.keybindings) {
      const merged = { version: 1 as const, bindings: { ...defaultKeybindings().bindings, ...b.keybindings } };
      const problems = validateBindings(merged.bindings);
      if (!problems.length) {
        rt.settings.keybindings = merged;
        applied.push('keybindings');
      }
    }
    if (b.savedSessions) {
      for (const s of b.savedSessions) savedSessions.save(s.name, s.tabs);
      applied.push(`sessions (${b.savedSessions.length})`);
    }
    if (b.workspaces) {
      for (const w of b.workspaces) {
        const c = workspaces.create(w.name, w.colorIndex);
        if (c.ok) workspaces.remember(w.tabs, c.workspace.id);
      }
      applied.push(`workspaces (${b.workspaces.length})`);
    }
    saveSettings(settingsFile, rt.settings);
    rt.audit.write('bundle', { taskId: rt.current?.task.id, applied: applied.join(', '), bookmarks: b.bookmarks?.length ?? 0 });
    return { ok: true, applied };
  });
  on('bundle:export-file', async () => {
    const save = await dialog.showSaveDialog(rt.win, { title: 'Export profile bundle', defaultPath: 'guarded-browser-profile.json' });
    if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' };
    const text = JSON.stringify(
      buildBundle({
        settings: { general: rt.settings.general, hibernation: rt.settings.hibernation, translate: rt.settings.translate, gestures: rt.settings.gestures, extensions: rt.settings.extensions },
        themes: { custom: rt.settings.appearance.custom as unknown as Array<Record<string, unknown>>, activeId: rt.settings.appearance.theme },
        bookmarks: bookmarks.tree() as never,
        keybindings: rt.settings.keybindings.bindings,
        savedSessions: savedSessions.list().map((s) => ({ name: s.name, createdAt: s.createdAt, tabs: s.tabs })),
        workspaces: workspaces.list().map((w) => ({ name: w.name, colorIndex: w.colorIndex, tabs: w.tabs })),
      }),
      null,
      2,
    );
    if (text.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'bundle too large to write' };
    writeFileSync(save.filePath, text, { mode: 0o600 });
    return { ok: true };
  });
  on('bundle:import-file', async () => {
    const open = await dialog.showOpenDialog(rt.win, { title: 'Import profile bundle', filters: [{ name: 'Bundle JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (open.canceled || !open.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(open.filePaths[0]).size > MAX_BUNDLE_BYTES) return { ok: false, error: 'file too large' };
    return handlers['bundle:import']({}, readFileSync(open.filePaths[0], 'utf8')) as { ok: boolean };
  });
}

// Chrome IPC: settings, appearance/themes, reputation, audit, keybindings, chrome layout switches,
// translate settings and unpacked extensions.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import { AppearanceSchema, BUILTIN_THEMES } from '../../core/theme';
import { EXTENSION_WARNING } from '../extensions';
import { KeybindingsSchema, defaultKeybindings, validateBindings } from '../../core/keybindings';
import { LANGUAGES, TranslateSettingsSchema, cloudStatus } from '../translate';
import { SEARCH_ENGINES } from '../../core/search';
import { type Settings, saveSettings } from '../../core/config';
import { dialog } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const { chordTable, ctx, extensions, feeds, importTheme, localLists, reputation, reputationState, sendUI, settingsFile, updateSiteAccent } = rt;
  // ---------- search engine setting ----------
  on('search:get', () => ({ engines: SEARCH_ENGINES, current: rt.settings.general.search }));

  on('settings:get', () => ({ ...rt.settings, guard: { ...ctx.sharedGuard() }, reputation: { ...rt.settings.reputation, feeds: ctx.sharedFeeds() } }));
  on('settings:save', (_e, s: Settings) => {
    // appearance has its own validated path; never take it from the generic settings form
    // ...nor the MCP / phone switches: they have their own channels (src/main/runtime/mcp.ts)
    s = { ...s, appearance: rt.settings.appearance, mcp: rt.settings.mcp, phone: rt.settings.phone };
    rt.settings = s;
    saveSettings(settingsFile, s);
    rt.egress.setDenylist(s.egress.denylist);
    rt.egress.reputation = s.reputation.enabled ? reputation : null;
    // app-wide values: the feed LIST (public data) and the guard model settings apply to every profile
    ctx.setSharedFeeds(s.reputation.feeds);
    ctx.setSharedGuard(s.guard);
    return true;
  });
  // ---------- appearance (themes for the chrome UI only) ----------
  on('appearance:get', () => ({ appearance: rt.settings.appearance, builtins: BUILTIN_THEMES }));
  on('appearance:save', (_e, a: unknown) => {
    const r = AppearanceSchema.safeParse(a);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) };
    rt.settings.appearance = r.data;
    saveSettings(settingsFile, rt.settings);
    sendUI('appearance', rt.settings.appearance);
    void updateSiteAccent();
    return { ok: true };
  });
  on('theme:import', (_e, json: unknown) => importTheme(json));
  on('theme:import-file', async () => {
    const r = await dialog.showOpenDialog(rt.win, { title: 'Import theme', filters: [{ name: 'Theme JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    if (statSync(r.filePaths[0]).size > 64 * 1024) return { ok: false, error: 'theme file larger than 64 KB' };
    return importTheme(readFileSync(r.filePaths[0], 'utf8'));
  });
  on('theme:export-file', async (_e, name: unknown) => {
    const t = [...BUILTIN_THEMES, ...rt.settings.appearance.custom].find((x) => x.name === String(name));
    if (!t) return { ok: false, error: 'no such theme' };
    const r = await dialog.showSaveDialog(rt.win, { title: 'Export theme', defaultPath: `${t.name.replace(/[^\w.-]/g, '_')}.theme.json` });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    writeFileSync(r.filePath, JSON.stringify(t, null, 2) + '\n');
    return { ok: true };
  });

  on('reputation:refresh', async () => {
    localLists.reload();
    await feeds.refresh(true);
    return reputationState();
  });
  on('audit:recent', () => rt.audit.read().slice(-400));

  // ================================ wave 2 (tickets 14-33) ================================

  // ---------- 15: remappable keybindings ----------
  on('keybindings:get', () => ({ bindings: rt.settings.keybindings, chords: chordTable() }));
  on('keybindings:save', (_e, b: unknown) => {
    const r = KeybindingsSchema.safeParse(b);
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    const problems = validateBindings(r.data.bindings);
    if (problems.length) return { ok: false, error: problems.map((p) => `${p.action}: ${p.problem}`).join('; ').slice(0, 300) };
    rt.settings.keybindings = r.data;
    saveSettings(settingsFile, rt.settings);
    sendUI('keybindings', rt.settings.keybindings);
    return { ok: true };
  });
  on('keybindings:reset', () => {
    rt.settings.keybindings = defaultKeybindings();
    saveSettings(settingsFile, rt.settings);
    sendUI('keybindings', rt.settings.keybindings);
    return { ok: true, bindings: rt.settings.keybindings };
  });

  // ---------- 21: tab strip placement ----------
  on('tabstrip:set', (_e, placement: unknown) => {
    const OK = new Set(['top', 'left', 'right', 'bottom']);
    const p = OK.has(String(placement)) ? (String(placement) as 'top') : 'top';
    rt.settings.general.tabStrip = p;
    saveSettings(settingsFile, rt.settings);
    sendUI('tabstrip', { placement: p });
    return { ok: true, placement: p };
  });

  // ---------- 25: translate (opt-in, off by default, refused during a task) ----------
  on('translate:state', () => ({ settings: rt.settings.translate, languages: LANGUAGES, status: cloudStatus(rt.settings.translate) }));
  on('translate:set', (_e, patch: unknown) => {
    const r = TranslateSettingsSchema.safeParse({ ...rt.settings.translate, ...(patch as object) });
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
    rt.settings.translate = r.data;
    saveSettings(settingsFile, rt.settings);
    sendUI('translate', { settings: r.data, status: cloudStatus(r.data) });
    return { ok: true, settings: r.data, status: cloudStatus(r.data) };
  });
  // ---------- 28: status bar ----------
  on('status:set', (_e, on: unknown) => {
    rt.settings.general.statusBar = on !== false;
    saveSettings(settingsFile, rt.settings);
    return { ok: true, on: rt.settings.general.statusBar };
  });
  on('rail:set', (_e, on: unknown) => {
    rt.settings.general.railVisible = on !== false;
    saveSettings(settingsFile, rt.settings);
    return { ok: true, on: rt.settings.general.railVisible };
  });

  // ---------- 32: unpacked extensions ----------
  on('extensions:list', () => ({ entries: extensions.list(), warning: EXTENSION_WARNING, enabled: rt.settings.extensions.enabled }));
  on('extensions:add', (_e, dir: unknown) => {
    const r = extensions.add(String(dir ?? ''));
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return r;
  });
  on('extensions:enable', (_e, dir: unknown, on: unknown) => {
    const ok = extensions.setEnabled(String(dir), on !== false);
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return { ok };
  });
  on('extensions:remove', (_e, dir: unknown) => {
    const ok = extensions.remove(String(dir));
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return { ok };
  });
  on('extensions:pick', async () => {
    const r = await dialog.showOpenDialog(rt.win, { title: 'Add an unpacked extension', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' };
    const added = extensions.add(r.filePaths[0]);
    sendUI('extensions', { entries: extensions.list(), warning: EXTENSION_WARNING });
    return added;
  });
  on('extensions:set-enabled', (_e, on: unknown) => {
    rt.settings.extensions.enabled = on !== false;
    saveSettings(settingsFile, rt.settings);
    return { ok: true, enabled: rt.settings.extensions.enabled };
  });
}

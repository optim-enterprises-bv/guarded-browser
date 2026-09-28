// Themes for the chrome UI: apply CSS custom properties on :root, theme editor with live preview,
// named themes, JSON import / export, optional site accent, day / night schedule.
// Security UI (.lock-*) never reads these variables (see styles.css), and web pages are separate
// WebContentsViews that this document cannot style.

import { z } from 'zod';
import { BUILTIN_THEMES, ThemeSchema, parseColor, resolveTheme, themeVars, type Appearance, type Theme } from '../core/theme';

type Bridge = { invoke(channel: string, ...args: unknown[]): Promise<any>; on(channel: string, fn: (p: any) => void): void };

// the chrome's CSP forbids eval: keep zod on its non-JIT path
z.config({ jitless: true });

export function initAppearance(gb: Bridge) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  let appearance: Appearance | null = null;
  let site: { color: string; source: string } | null = null;
  let preview: Theme | null = null;

  const current = (): Theme | null => (appearance ? resolveTheme(appearance, new Date(), dark.matches) : null);

  function apply() {
    const t = preview ?? current();
    if (!t || !appearance) return;
    const siteRgb = appearance.siteAccent && site ? parseColor(site.color) : null;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeVars(t, siteRgb))) root.style.setProperty(k, v);
    root.dataset.theme = t.name;
    root.dataset.base = t.base;
    root.dataset.density = t.density;
    root.dataset.siteAccent = siteRgb ? site!.source : 'off';
    root.style.colorScheme = t.base;
  }

  const names = () => ['System', ...BUILTIN_THEMES.map((t) => t.name), ...(appearance?.custom ?? []).map((t) => t.name)];

  function fillSelect(sel: HTMLSelectElement, value: string) {
    sel.replaceChildren(...names().map((n) => new Option(n, n)));
    sel.value = names().includes(value) ? value : 'System';
  }

  function renderForm() {
    if (!appearance) return;
    fillSelect($('ap-theme'), appearance.theme);
    fillSelect($('ap-day'), appearance.schedule.day);
    fillSelect($('ap-night'), appearance.schedule.night);
    $<HTMLSelectElement>('ap-mode').value = appearance.schedule.mode;
    $<HTMLInputElement>('ap-day-start').value = appearance.schedule.dayStart;
    $<HTMLInputElement>('ap-night-start').value = appearance.schedule.nightStart;
    $<HTMLInputElement>('ap-site').checked = appearance.siteAccent;
  }

  function loadEditor(t: Theme) {
    $<HTMLInputElement>('te-name').value = BUILTIN_THEMES.some((b) => b.name === t.name) ? `${t.name} copy` : t.name;
    $<HTMLSelectElement>('te-base').value = t.base;
    for (const k of ['background', 'foreground', 'accent', 'highlight'] as const) $<HTMLInputElement>(`te-${k}`).value = t[k];
    $<HTMLInputElement>('te-radius').value = String(t.radius);
    $<HTMLSelectElement>('te-density').value = t.density;
  }

  function editorTheme(): unknown {
    return {
      name: $<HTMLInputElement>('te-name').value,
      base: $<HTMLSelectElement>('te-base').value,
      background: $<HTMLInputElement>('te-background').value,
      foreground: $<HTMLInputElement>('te-foreground').value,
      accent: $<HTMLInputElement>('te-accent').value,
      highlight: $<HTMLInputElement>('te-highlight').value,
      radius: Number($<HTMLInputElement>('te-radius').value),
      density: $<HTMLSelectElement>('te-density').value,
    };
  }

  const msg = (s: string) => ($('theme-msg').textContent = s);

  // live preview: every edit re-validates and re-applies (invalid values are simply not applied)
  $('theme-editor').addEventListener('input', (e) => {
    if (!(e.target as HTMLElement).id.startsWith('te-')) return; // the JSON box is not the editor
    const r = ThemeSchema.safeParse(editorTheme());
    if (r.success) {
      preview = r.data;
      apply();
      msg('previewing (not saved)');
    } else msg(r.error.issues[0]?.message ?? 'invalid');
  });

  $('te-load').onclick = () => {
    const t = current();
    if (t) loadEditor(t);
  };
  $('te-save').onclick = async () => {
    const r = await gb.invoke('theme:import', JSON.stringify(editorTheme()));
    if (!r.ok) return msg(`not saved: ${r.error}`);
    preview = null;
    await gb.invoke('appearance:save', { ...appearance!, theme: r.theme.name });
    msg(`saved "${r.theme.name}"`);
  };
  $('te-revert').onclick = () => {
    preview = null;
    apply();
    msg('preview reverted');
  };
  $('theme-import').onclick = async () => {
    const r = await gb.invoke('theme:import', $<HTMLTextAreaElement>('theme-json').value);
    msg(r.ok ? `imported "${r.theme.name}"` : `rejected: ${r.error}`);
  };
  $('theme-import-file').onclick = async () => {
    const r = await gb.invoke('theme:import-file');
    msg(r.ok ? `imported "${r.theme.name}"` : `rejected: ${r.error}`);
  };
  $('theme-export').onclick = () => {
    const t = current();
    if (t) $<HTMLTextAreaElement>('theme-json').value = JSON.stringify(t, null, 2);
  };
  $('theme-export-file').onclick = async () => {
    const t = current();
    if (!t) return;
    const r = await gb.invoke('theme:export-file', t.name);
    msg(r.ok ? 'exported' : r.error);
  };
  $('ap-save').onclick = async () => {
    if (!appearance) return;
    const next: Appearance = {
      ...appearance,
      theme: $<HTMLSelectElement>('ap-theme').value,
      siteAccent: $<HTMLInputElement>('ap-site').checked,
      schedule: {
        mode: $<HTMLSelectElement>('ap-mode').value as Appearance['schedule']['mode'],
        day: $<HTMLSelectElement>('ap-day').value,
        night: $<HTMLSelectElement>('ap-night').value,
        dayStart: $<HTMLInputElement>('ap-day-start').value,
        nightStart: $<HTMLInputElement>('ap-night-start').value,
      },
    };
    const r = await gb.invoke('appearance:save', next);
    msg(r.ok ? 'appearance saved' : `not saved: ${r.error}`);
  };

  gb.on('appearance', (a: Appearance) => {
    appearance = a;
    renderForm();
    apply();
  });
  gb.on('site-accent', (s: { color: string; source: string } | null) => {
    // page-controlled: only a strictly parsed colour is kept
    site = s && parseColor(s.color) ? s : null;
    apply();
  });
  dark.addEventListener('change', apply);
  window.setInterval(apply, 30_000); // scheduled day / night switch

  /** Called when the settings panel closes: drop any unsaved preview. */
  return {
    closePreview() {
      preview = null;
      apply();
    },
    async load() {
      const r = await gb.invoke('appearance:get');
      appearance = r.appearance;
      renderForm();
      const t = current();
      if (t) loadEditor(t);
      apply();
    },
  };
}

// Themes for the browser CHROME only (tab strip, toolbar, agent panel). Never applied to web pages,
// never to security UI (see "LOCKED SECURITY STYLING" in src/renderer/styles.css).
//
// A theme file is untrusted input: every value is validated with zod. Colours are accepted ONLY as
// #rgb / #rrggbb / rgb(r, g, b) and are re-serialised to #rrggbb, numbers are range-checked, unknown
// keys are rejected. No string from a theme file ever reaches CSS except a normalised #rrggbb or a
// number we formatted ourselves, so a theme cannot inject CSS.
//
// This module is shared by main (validation) and the renderer (applying variables); no Node imports.

import { z } from 'zod';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FN = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** Strict colour parser: #rgb, #rrggbb or rgb(r, g, b) with 0..255 components. Anything else: null. */
export function parseColor(input: unknown): RGB | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const s = input.trim();
  const h = HEX.exec(s);
  if (h) {
    const v = h[1].length === 3 ? h[1].split('').map((c) => c + c).join('') : h[1];
    return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
  }
  const m = RGB_FN.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].every((x) => x >= 0 && x <= 255)) return { r, g, b };
  }
  return null;
}

export const toHex = ({ r, g, b }: RGB): string =>
  `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;

const ColorSchema = z
  .string()
  .max(32)
  .refine((s) => parseColor(s) !== null, 'colour must be #rgb, #rrggbb or rgb(r, g, b)')
  .transform((s) => toHex(parseColor(s)!));

export const ThemeSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9 _.-]{1,40}$/, 'name: 1-40 letters, digits, space, _ . -'),
    base: z.enum(['light', 'dark']),
    background: ColorSchema,
    foreground: ColorSchema,
    accent: ColorSchema,
    highlight: ColorSchema,
    radius: z.number().int().min(0).max(16),
    density: z.enum(['compact', 'normal']),
  })
  .strict();

export type Theme = z.infer<typeof ThemeSchema>;

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM');

export const AppearanceSchema = z
  .object({
    /** 'System' follows prefers-color-scheme (Light / Dark) */
    theme: z.string().max(40),
    custom: z.array(ThemeSchema).max(50),
    siteAccent: z.boolean(),
    schedule: z
      .object({
        mode: z.enum(['off', 'times', 'system']),
        day: z.string().max(40),
        night: z.string().max(40),
        dayStart: TIME,
        nightStart: TIME,
      })
      .strict(),
  })
  .strict();

export type Appearance = z.infer<typeof AppearanceSchema>;

export const BUILTIN_THEMES: Theme[] = [
  { name: 'Light', base: 'light', background: '#f6f7f9', foreground: '#1d2330', accent: '#2f5bd3', highlight: '#fdf0d5', radius: 6, density: 'normal' },
  { name: 'Dark', base: 'dark', background: '#16181d', foreground: '#e3e6ec', accent: '#6f95ff', highlight: '#3a3320', radius: 6, density: 'normal' },
  { name: 'Light Violet', base: 'light', background: '#f7f5fb', foreground: '#231d30', accent: '#7c3aed', highlight: '#ede4ff', radius: 8, density: 'normal' },
  { name: 'Dark Teal', base: 'dark', background: '#111a1b', foreground: '#dcebea', accent: '#14b8a6', highlight: '#17363a', radius: 4, density: 'compact' },
];

export function defaultAppearance(): Appearance {
  return { theme: 'System', custom: [], siteAccent: false, schedule: { mode: 'off', day: 'Light', night: 'Dark', dayStart: '07:00', nightStart: '19:00' } };
}

export function findTheme(name: string, a: Appearance, systemDark: boolean): Theme {
  if (name === 'System') return BUILTIN_THEMES[systemDark ? 1 : 0];
  return a.custom.find((t) => t.name === name) ?? BUILTIN_THEMES.find((t) => t.name === name) ?? BUILTIN_THEMES[systemDark ? 1 : 0];
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Which theme applies now: fixed choice, day/night by local clock, or day/night by system scheme. */
export function resolveTheme(a: Appearance, now: Date, systemDark: boolean): Theme {
  const s = a.schedule;
  if (s.mode === 'system') return findTheme(systemDark ? s.night : s.day, a, systemDark);
  if (s.mode === 'times') {
    const m = now.getHours() * 60 + now.getMinutes();
    const [d, n] = [minutes(s.dayStart), minutes(s.nightStart)];
    const isDay = d === n ? true : d < n ? m >= d && m < n : !(m >= n && m < d);
    return findTheme(isDay ? s.day : s.night, a, systemDark);
  }
  return findTheme(a.theme, a, systemDark);
}

// ---------- colour maths (WCAG 2.x) ----------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: RGB): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/**
 * An accent plus the text colour to put on it, with contrast >= min (WCAG AA 4.5:1 by default).
 * Picks white or black text, then darkens / lightens the accent until the ratio holds.
 */
export function accessibleAccent(accent: RGB, min = 4.5): { accent: RGB; text: RGB; ratio: number } {
  const text = contrast(accent, WHITE) >= contrast(accent, BLACK) ? WHITE : BLACK;
  let a = { ...accent };
  for (let i = 0; i < 40 && contrast(a, text) < min; i++) a = mix(a, text === WHITE ? BLACK : WHITE, 0.08);
  a = parseColor(toHex(a))!; // round to what CSS will actually use
  return { accent: a, text, ratio: contrast(a, text) };
}

/** Blend a page-supplied colour into the theme accent (weight 0.6 site) and make it accessible. */
export function blendSiteAccent(themeAccent: RGB, site: RGB): { accent: RGB; text: RGB; ratio: number } {
  return accessibleAccent(mix(themeAccent, site, 0.6));
}

/** CSS custom properties for a theme (+ optional site colour). Values are only hex / numbers. */
export function themeVars(t: Theme, siteColor?: RGB | null): Record<string, string> {
  const bg = parseColor(t.background)!;
  const fg = parseColor(t.foreground)!;
  const card = mix(bg, WHITE, t.base === 'dark' ? 0.05 : 0.7);
  const line = mix(bg, fg, 0.18);
  const muted = mix(bg, fg, 0.6);
  const acc = siteColor ? blendSiteAccent(parseColor(t.accent)!, siteColor) : accessibleAccent(parseColor(t.accent)!);
  return {
    '--bg': t.background,
    '--fg': t.foreground,
    '--card': toHex(card),
    '--line': toHex(line),
    '--muted': toHex(muted),
    '--accent': toHex(acc.accent),
    '--accent-fg': toHex(acc.text),
    '--highlight': t.highlight,
    '--radius': `${t.radius}px`,
    '--radius-sm': `${Math.max(0, Math.round(t.radius * 0.66))}px`,
    '--pad': t.density === 'compact' ? '2px 7px' : '4px 10px',
    '--font-size': t.density === 'compact' ? '12px' : '13px',
  };
}

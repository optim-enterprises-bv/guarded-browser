import { describe, expect, it } from 'vitest';
import {
  AppearanceSchema, BUILTIN_THEMES, ThemeSchema, accessibleAccent, blendSiteAccent, contrast, defaultAppearance,
  parseColor, resolveTheme, themeVars, toHex,
} from '../../src/core/theme';

const good = { name: 'My theme', base: 'dark', background: '#000', foreground: 'rgb(255, 255, 255)', accent: '#12ab34', highlight: '#fff', radius: 4, density: 'compact' };

describe('colour parsing', () => {
  it('accepts only #rgb, #rrggbb and rgb(r, g, b)', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseColor('#A1B2C3')).toEqual({ r: 161, g: 178, b: 195 });
    expect(parseColor('rgb(1, 2, 255)')).toEqual({ r: 1, g: 2, b: 255 });
    for (const bad of ['red', 'rgb(256,0,0)', 'rgba(0,0,0,0)', '#abcd', 'hsl(0,0%,0%)', 'var(--x)', '#fff; background:url(x)', 'url(javascript:alert(1))', 'expression(alert(1))', '', null, 42]) {
      expect(parseColor(bad), String(bad)).toBeNull();
    }
  });
});

describe('theme schema (import validation)', () => {
  it('normalises colours to #rrggbb', () => {
    const t = ThemeSchema.parse(good);
    expect([t.background, t.foreground, t.highlight]).toEqual(['#000000', '#ffffff', '#ffffff']);
  });
  it('rejects CSS-injection strings, bad ranges, unknown keys and odd names', () => {
    const cases: Array<Record<string, unknown>> = [
      { ...good, background: 'red;}</style><script>alert(1)</script>' },
      { ...good, accent: 'url(javascript:alert(1))' },
      { ...good, foreground: '#fff !important; --bg: red' },
      { ...good, highlight: 'var(--accent)' },
      { ...good, radius: 99 },
      { ...good, radius: 2.5 },
      { ...good, radius: '4px' },
      { ...good, density: 'tiny' },
      { ...good, base: 'sepia' },
      { ...good, name: '<img src=x>' },
      { ...good, css: 'body{display:none}' },
    ];
    for (const c of cases) expect(ThemeSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
  });
  it('appearance schema validates the schedule', () => {
    expect(AppearanceSchema.safeParse(defaultAppearance()).success).toBe(true);
    const bad = defaultAppearance();
    bad.schedule.dayStart = '25:00';
    expect(AppearanceSchema.safeParse(bad).success).toBe(false);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
    expect(contrast({ r: 119, g: 119, b: 119 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(4.48, 1);
  });
  it('accessibleAccent always reaches 4.5:1 for text on the accent', () => {
    for (const hex of ['#ffff00', '#00ff00', '#777777', '#ff0000', '#0000ff', '#ffffff', '#000000', '#b00020']) {
      const r = accessibleAccent(parseColor(hex)!);
      expect(r.ratio, hex).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('site accent is blended and clamped', () => {
    const r = blendSiteAccent(parseColor('#2f5bd3')!, parseColor('#ffff00')!);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    expect(toHex(r.accent)).not.toBe('#2f5bd3');
  });
  it('themeVars only produces hex colours and numbers', () => {
    for (const t of BUILTIN_THEMES) {
      for (const [k, v] of Object.entries(themeVars(t, parseColor('#123456')))) {
        expect(v, k).toMatch(/^(#[0-9a-f]{6}|\d+px|\d+px \d+px)$/);
      }
    }
  });
});

describe('scheduled themes', () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m);
  it('day / night by local clock, including a window over midnight', () => {
    const a = { ...defaultAppearance(), schedule: { mode: 'times' as const, day: 'Light Violet', night: 'Dark Teal', dayStart: '07:00', nightStart: '19:00' } };
    expect(resolveTheme(a, at(12), false).name).toBe('Light Violet');
    expect(resolveTheme(a, at(6, 59), false).name).toBe('Dark Teal');
    expect(resolveTheme(a, at(19), false).name).toBe('Dark Teal');
    const b = { ...a, schedule: { ...a.schedule, dayStart: '22:00', nightStart: '04:00' } };
    expect(resolveTheme(b, at(23), false).name).toBe('Light Violet');
    expect(resolveTheme(b, at(12), false).name).toBe('Dark Teal');
  });
  it('follow system, and the System theme', () => {
    const a = { ...defaultAppearance(), schedule: { ...defaultAppearance().schedule, mode: 'system' as const, day: 'Light Violet', night: 'Dark Teal' } };
    expect(resolveTheme(a, at(12), true).name).toBe('Dark Teal');
    expect(resolveTheme(a, at(12), false).name).toBe('Light Violet');
    expect(resolveTheme(defaultAppearance(), at(12), true).name).toBe('Dark');
    expect(resolveTheme(defaultAppearance(), at(12), false).name).toBe('Light');
  });
  it('custom themes shadow built-ins by name; unknown names fall back to System', () => {
    const custom = ThemeSchema.parse({ ...good, name: 'Mine' });
    expect(resolveTheme({ ...defaultAppearance(), theme: 'Mine', custom: [custom] }, at(12), false).name).toBe('Mine');
    expect(resolveTheme({ ...defaultAppearance(), theme: 'Nope' }, at(12), false).name).toBe('Light');
  });
});

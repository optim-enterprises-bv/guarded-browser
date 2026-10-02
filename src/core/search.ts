// Search engines. The template is USER configuration and never page-derived; `%s` is substituted
// with exactly one encodeURIComponent of the query, and a custom template must be an http(s) URL.
// The default stays DuckDuckGo (unchanged from before this ticket).

import { z } from 'zod';

export interface SearchEngine {
  id: string;
  name: string;
  /** must contain %s exactly once */
  template: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'startpage', name: 'Startpage', template: 'https://www.startpage.com/sp/search?query=%s' },
  { id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
  { id: 'wikipedia', name: 'Wikipedia', template: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { id: 'mojeek', name: 'Mojeek', template: 'https://www.mojeek.com/search?q=%s' },
];

export const DEFAULT_ENGINE = 'duckduckgo';

/**
 * A template is valid when it is http(s), contains exactly one %s, and has no other format
 * specifier that could be substituted from something else.
 */
export function validTemplate(t: string): boolean {
  if (typeof t !== 'string' || t.length > 2048) return false;
  if ((t.match(/%s/g) ?? []).length !== 1) return false;
  if (/%[a-zA-Z]/.test(t.replace('%s', ''))) return false;
  try {
    const u = new URL(t.replace('%s', 'x'));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const SearchSettingsSchema = z
  .object({
    /** id of a built-in engine, or 'custom' to use customTemplate */
    engine: z.string().max(64),
    customTemplate: z.string().max(2048),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.engine === 'custom') {
      if (!validTemplate(v.customTemplate)) ctx.addIssue({ code: 'custom', path: ['customTemplate'], message: 'template must be an http(s) URL containing exactly one %s' });
      return;
    }
    if (!SEARCH_ENGINES.some((e) => e.id === v.engine)) ctx.addIssue({ code: 'custom', path: ['engine'], message: `unknown search engine: ${v.engine}` });
  });

export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

export const defaultSearch = (): SearchSettings => ({ engine: DEFAULT_ENGINE, customTemplate: '' });

/** The template actually in force. */
export function activeTemplate(s: SearchSettings): string {
  if (s.engine === 'custom') return s.customTemplate;
  return SEARCH_ENGINES.find((e) => e.id === s.engine)?.template ?? SEARCH_ENGINES[0].template;
}

/**
 * Build the search URL for a query. The query is percent-encoded exactly once — a query
 * containing %s, & or a full URL is data, never a template.
 */
export function searchUrl(query: string, s: SearchSettings): string {
  return activeTemplate(s).replace('%s', encodeURIComponent(query));
}

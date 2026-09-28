// Everything page-derived that reaches the planner or judge prompt goes through here.
// Inventory of planner-visible strings (see README "What the planner sees"):
//   role            -> fixed ARIA role list, else "generic"
//   input type      -> fixed list, else "text"
//   form method     -> "get" | "post"
//   element name    -> whitespace-collapsed, capped at 80, guard-screened
//   page title      -> capped at 80, guard-screened
//   page URL / href / form action -> origin + path capped at 40 (query and fragment dropped), path guard-screened
//   action results  -> fixed strings; driver errors reduced to a Chromium error code
//   reader output   -> numbers / booleans only; strings become handles (src/core/handles.ts)

import { getDomain } from 'tldts';

export const ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'treeitem', 'generic',
]);

export const INPUT_TYPES = new Set([
  'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time',
  'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'color', 'range',
]);

export const MAX_NAME = 80;
export const MAX_PATH = 40;

export function safeRole(r: string | undefined): string {
  const v = String(r ?? '').trim().toLowerCase();
  return ROLES.has(v) ? v : 'generic';
}

export function safeInputType(t: string | undefined): string | undefined {
  if (t === undefined) return undefined;
  const v = String(t).trim().toLowerCase();
  return INPUT_TYPES.has(v) ? v : 'text';
}

export function safeMethod(m: string | undefined): 'get' | 'post' {
  return String(m ?? '').toLowerCase() === 'post' ? 'post' : 'get';
}

export function capName(s: string, max = MAX_NAME): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

export const MAX_SITE = 40;
export const SITE_WITHHELD = '[site withheld]';

/**
 * Split a URL for display. The host is page data too (attackers choose hostnames), so only the
 * registrable domain (eTLD+1, public-suffix list via tldts) is shown, subdomains collapse to "*.",
 * and a domain longer than MAX_SITE is withheld. IP literals / localhost are shown with their port.
 */
export function urlParts(url: string): { origin: string; path: string; withheld: boolean } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { origin: `${u.protocol}`, path: '', withheld: false };
    const host = u.hostname;
    const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;
    let path = decodeURIComponentSafe(u.pathname);
    if (path.length > MAX_PATH) path = `${path.slice(0, MAX_PATH)}…`;
    if (domain.length > MAX_SITE) return { origin: SITE_WITHHELD, path: '', withheld: true };
    const site = `${u.protocol}//${domain !== host ? '*.' : ''}${domain}${u.port ? `:${u.port}` : ''}`;
    return { origin: site, path, withheld: false };
  } catch {
    return null;
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Reduce a driver / Chromium error message to its error code (no URLs, no page text). */
export function errorCode(detail: string | undefined): string {
  const m = /\b(ERR_[A-Z_]+)\b/.exec(detail ?? '');
  if (m) return m[1];
  if (/not found/i.test(detail ?? '')) return 'element not found (take a new snapshot)';
  if (/not inside a form/i.test(detail ?? '')) return 'element is not inside a form';
  return 'error';
}

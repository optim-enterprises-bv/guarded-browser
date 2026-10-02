// Quick Commands (ticket 14): one palette over commands, tabs, bookmarks, history and sessions.
//
// The matcher is pure and lives here so it is unit-testable. The aggregate is built by the runtime
// from lists the chrome already owns — this module never reads page content and never touches a tab.
//
// RANKING RULE for untrusted titles (rule 3): a bookmark or history title is attacker-influenced
// text. It is searched and displayed as TEXT, never parsed, and its destination URL is always shown
// next to it so a title cannot masquerade as a command or as another site. Scores from titles are
// capped below the score of a real command match, so a page whose title is "Close tab" can never
// outrank the actual Close tab action.

export const MAX_RESULTS = 12;
export const MAX_QUERY = 100;

export type CommandKind = 'command' | 'tab' | 'bookmark' | 'history' | 'session' | 'workspace' | 'setting';

export interface PaletteItem {
  kind: CommandKind;
  /** stable id the runtime will act on */
  id: string;
  /** primary line — user text for bookmark/history, our own label for commands */
  title: string;
  /** secondary line: the destination URL, the chord, or a status */
  subtitle?: string;
  /** the chord bound to a command, shown as a hint */
  chord?: string;
  /** true for text that came from a page or a file rather than from us */
  untrusted?: boolean;
}

const BASE_SCORE: Record<CommandKind, number> = {
  command: 1000,
  tab: 800,
  workspace: 700,
  session: 600,
  bookmark: 400,
  history: 300,
  setting: 200,
};

/**
 * Subsequence match with a contiguity bonus: "ct" matches "Close tab". Returns null when the query
 * is not a subsequence of the text. Case-insensitive.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const t = String(text).toLowerCase();
  if (!q) return 0;
  if (!t) return null;
  if (q.length > t.length * 3 + 20) return null;
  let ti = 0;
  let score = 0;
  let streak = 0;
  let lastMatch = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    streak = found === lastMatch + 1 ? streak + 1 : 0;
    lastMatch = found;
    // matches early in the string and in a run are better
    score += 10 + streak * 6 - Math.min(found, 20) * 0.5;
    ti = found + 1;
  }
  // an exact prefix beats a scattered match
  if (t.startsWith(q)) score += 60;
  return score;
}

/**
 * Rank items for a query. Commands first, then the user's own live state, then remembered things
 * (bookmarks, history). A command's score can never be beaten by untrusted text: the kind bonus
 * (BASE_SCORE) is larger than any achievable fuzzy score gap.
 */
export function searchPalette(items: PaletteItem[], query: string, limit = MAX_RESULTS): PaletteItem[] {
  const q = String(query ?? '').slice(0, MAX_QUERY);
  if (!q.trim()) {
    // no query: show commands, then tabs — the useful "what can I do" default
    return items
      .filter((i) => i.kind === 'command' || i.kind === 'tab')
      .sort((a, b) => BASE_SCORE[b.kind] - BASE_SCORE[a.kind])
      .slice(0, limit);
  }
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of items) {
    // text that came from a page is scored on its title; everything else on title + subtitle
    const hay = item.untrusted ? item.title : `${item.title} ${item.subtitle ?? ''}`;
    const s = fuzzyScore(q, hay);
    if (s === null) continue;
    scored.push({ item, score: BASE_SCORE[item.kind] + s });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Cap the aggregate the runtime hands over, so a huge history cannot flood the palette. */
export function clampItems(items: PaletteItem[], max = 600): PaletteItem[] {
  return items.slice(0, Math.max(1, max)).map((i) => ({
    ...i,
    title: String(i.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
    subtitle: i.subtitle ? String(i.subtitle).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : undefined,
  }));
}

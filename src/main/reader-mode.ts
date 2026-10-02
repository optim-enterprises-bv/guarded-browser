// Reader mode (ticket 24) — extraction script plus the rule about who may see the result.
//
// THE SECURITY DECISION THIS FILE EXISTS TO MAKE EXPLICIT:
// **reader output is HUMAN-ONLY.** It never reaches the planner, the reader component or the judge,
// and it does NOT register taint. Reader mode is a convenience for the person looking at the screen;
// it must not become a second, wider and unguarded text channel into a model. That is a real risk
// here because "extract the article text" is exactly the shape of the reader component's job, so the
// two are easy to conflate. The runtime's reader path (`runReader`) is untouched by this module.
//
// The extraction runs in the ISOLATED WORLD (`page-scripts.ts` pattern) and returns plain text. The
// result is inserted into the chrome view as TEXT, never as HTML from the page: the page's markup is
// attacker-influenced, and reader mode must not become an injection route into chrome.
//
// The script below reads the page's DOM, which is why it is the one place in this product where that
// is allowed — it runs in the page's own isolated world, its output is text, and its output is
// discarded unless the USER asked for it. The agent's snapshot path is separate and unchanged.

export const MAX_ARTICLE_CHARS = 100_000;
export const MAX_BLOCKS = 400;

/**
 * The extraction script, evaluated in the page's isolated world. Kept as a self-contained
 * expression: no imports, no closure over main-process state, and it must return a plain object.
 *
 * Heuristic (the classic readability shape): prefer <article>/<main>, else the densest container of
 * <p> text, then keep paragraph-level blocks and strip navigation/aside/footer noise by tag list.
 * Everything is length-capped so a hostile page cannot return an unbounded payload.
 */
export const EXTRACT_ARTICLE_JS = `(() => {
  const MAX_BLOCKS = ${MAX_BLOCKS};
  const MAX_CHARS = ${MAX_ARTICLE_CHARS};
  const NOISE = 'script,style,noscript,nav,aside,footer,header,form,button,iframe,svg,canvas,template,[aria-hidden="true"],.ad,.ads,.advert,.cookie,.newsletter';
  const clean = (s) => String(s || '').replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, ' ').replace(/\\s+/g, ' ').trim();
  const textLen = (el) => { try { return (el.innerText || '').length; } catch { return 0; } };

  // candidate containers, best first
  const candidates = [];
  const push = (el) => { if (el && !candidates.includes(el)) candidates.push(el); };
  push(document.querySelector('article'));
  push(document.querySelector('main'));
  push(document.querySelector('[role="main"]'));
  const all = Array.from(document.querySelectorAll('div,section'));
  all.sort((a, b) => textLen(b) - textLen(a));
  for (const el of all.slice(0, 8)) push(el);
  push(document.body);

  let best = null, bestScore = -1;
  for (const el of candidates) {
    if (!el) continue;
    const ps = el.querySelectorAll('p');
    let chars = 0;
    ps.forEach((p) => { chars += clean(p.innerText).length; });
    // density: paragraph text relative to the container, plus a bonus for many real paragraphs
    const score = chars + Math.min(ps.length, 40) * 20;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  if (!best) return { ok: false, error: 'no content' };

  const clone = best.cloneNode(true);
  try { clone.querySelectorAll(NOISE).forEach((n) => n.remove()); } catch {}

  const blocks = [];
  let total = 0;
  const walk = (el) => {
    if (!el || blocks.length >= MAX_BLOCKS) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'p' || tag === 'pre' || tag === 'blockquote' || tag === 'li') {
      const t = clean(el.innerText);
      if (t.length > 1 && total + t.length <= MAX_CHARS) {
        blocks.push({ kind: tag === 'pre' ? 'pre' : tag === 'li' ? 'list' : 'p', text: t.slice(0, 4000) });
        total += t.length;
      }
      return;
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const t = clean(el.innerText);
      if (t && total + t.length <= MAX_CHARS) { blocks.push({ kind: 'h', text: t.slice(0, 300) }); total += t.length; }
      return;
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(clone);

  // a page with no block structure: fall back to the container's own text, capped
  if (!blocks.length) {
    const t = clean(best.innerText).slice(0, MAX_CHARS);
    if (t) blocks.push({ kind: 'p', text: t });
  }

  const title = clean(document.querySelector('h1') && document.querySelector('h1').innerText) || clean(document.title);
  const byline = clean((document.querySelector('[rel="author"], .author, [itemprop="author"]') || {}).innerText || '');
  return { ok: blocks.length > 0, title: title.slice(0, 300), byline: byline.slice(0, 200), blocks, truncated: total >= MAX_CHARS, url: location.href };
})()`;

export interface ArticleBlock {
  kind: 'p' | 'h' | 'pre' | 'list';
  text: string;
}

export interface Article {
  ok: boolean;
  title: string;
  byline: string;
  blocks: ArticleBlock[];
  truncated: boolean;
  error?: string;
}

/**
 * Validate and cap what the page handed back. The page is untrusted: every field is a string, the
 * block list is bounded, and the shape is rebuilt rather than trusted, so a page returning
 * `{blocks: [{__proto__: ...}]}` or a nested object cannot smuggle structure into chrome.
 */
export function normalizeArticle(raw: unknown): Article {
  const empty: Article = { ok: false, title: '', byline: '', blocks: [], truncated: false };
  if (!raw || typeof raw !== 'object') return { ...empty, error: 'extraction returned nothing' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    String(typeof v === 'string' ? v : '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const kinds = new Set(['p', 'h', 'pre', 'list']);
  const blocks: ArticleBlock[] = [];
  let total = 0;
  if (Array.isArray(r.blocks)) {
    for (const b of r.blocks.slice(0, MAX_BLOCKS)) {
      if (!b || typeof b !== 'object') continue;
      const bb = b as Record<string, unknown>;
      const kind = kinds.has(String(bb.kind)) ? (String(bb.kind) as ArticleBlock['kind']) : 'p';
      const text = str(bb.text, 4000);
      if (!text) continue;
      if (total + text.length > MAX_ARTICLE_CHARS) break;
      total += text.length;
      blocks.push({ kind, text });
    }
  }
  return {
    ok: blocks.length > 0,
    title: str(r.title, 300),
    byline: str(r.byline, 200),
    blocks,
    truncated: r.truncated === true || total >= MAX_ARTICLE_CHARS,
    ...(blocks.length ? {} : { error: 'no readable content on this page' }),
  };
}

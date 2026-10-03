// Semantic markdown snapshot (AI capabilities item 2): the pure half — re-validation of what the
// isolated world returns, the X-ray hidden-text rule applied to every run, rendering of headings /
// lists / tables / links / images / forms, and the size caps. The isolated-world half runs in the
// real app (test/e2e/chat.spec.ts) on the same fixtures.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKDOWN_JS, MD_LIMITS, TRUNCATED_NOTE, normalizeMdPage, pageMarkdown, runHidden, type MdBlock, type MdFacts, type MdPage, type MdRun } from '../../src/core/markdown';
import { hiddenStyleReasons, injectedHelpersSource } from '../../src/core/xray';

const V: MdFacts = { displayNone: false, visibility: 'visible', opacity: 1, fontSizePx: 16, clipped: false, offScreen: false, contrast: 12, ariaHidden: false };
const run = (text: string, extra: Partial<MdRun> = {}): MdRun => ({ text, facts: V, ...extra });
const page = (blocks: MdBlock[], extra: Partial<MdPage> = {}): MdPage => ({ url: 'http://127.0.0.1/x', title: 'T', blocks, truncated: false, hiddenDropped: 0, ...extra });
const md = (blocks: MdBlock[], max?: number) => pageMarkdown(page(blocks), max).markdown;

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');
/** the visible part every hidden-* fixture shares (Acme Gadgets, two products, shipping) */
const shopBlocks = (): MdBlock[] => [
  { kind: 'heading', level: 1, runs: [run('Acme Gadgets')] },
  { kind: 'paragraph', runs: [run('Shop', { href: 'http://127.0.0.1/shop.html' }), run(' | '), run('Blog', { href: 'http://127.0.0.1/article.html' })] },
  { kind: 'heading', level: 2, runs: [run('Blue Widget')] },
  { kind: 'paragraph', runs: [run('Price: $19.99 USD')] },
  { kind: 'paragraph', runs: [run('Free shipping on orders over $50.')] },
];

describe('rendering', () => {
  it('headings, paragraphs and links as [text](url)', () => {
    expect(md(shopBlocks())).toBe(
      '# Acme Gadgets\n\n[Shop](http://127.0.0.1/shop.html) | [Blog](http://127.0.0.1/article.html)\n\n## Blue Widget\n\nPrice: $19.99 USD\n\nFree shipping on orders over $50.',
    );
  });

  it('a link keeps the spaces around it, merges its runs, and escapes brackets in its text', () => {
    const out = md([{ kind: 'paragraph', runs: [run('Read our'), run(' care ', { href: 'http://a.test/g' }), run('guide [new]', { href: 'http://a.test/g' }), run(' first.')] }]);
    expect(out).toBe('Read our [care guide \\[new\\]](http://a.test/g) first.');
  });

  it('URLs are encoded where markdown would break, and only http(s) / mailto links survive re-validation', () => {
    expect(md([{ kind: 'paragraph', runs: [run('x', { href: 'http://a.test/a b(c)' })] }])).toBe('[x](http://a.test/a%20b%28c%29)');
    const p = normalizeMdPage({ blocks: [{ kind: 'paragraph', runs: [{ text: 'click', href: 'javascript:alert(1)', facts: V }, { text: ' mail', href: 'mailto:a@b.test', facts: V }] }] });
    expect(pageMarkdown(p).markdown).toBe('click [mail](mailto:a@b.test)');
  });

  it('lists: bullets, numbers and nesting', () => {
    const out = md([
      { kind: 'item', depth: 0, ordered: false, n: 1, runs: [run('Fully recyclable')] },
      { kind: 'item', depth: 0, ordered: false, n: 2, runs: [run('Two-year warranty')] },
      { kind: 'item', depth: 1, ordered: true, n: 1, runs: [run('Register online')] },
      { kind: 'item', depth: 1, ordered: true, n: 2, runs: [run('Keep the receipt')] },
      { kind: 'paragraph', runs: [run('After the list.')] },
    ]);
    expect(out).toBe('- Fully recyclable\n- Two-year warranty\n  1. Register online\n  2. Keep the receipt\n\nAfter the list.');
  });

  it('tables: a header row, a rule, ragged rows padded, pipes escaped', () => {
    const out = md([{ kind: 'table', rows: [
      { header: true, cells: [[run('Model')], [run('Price')], [run('Colour')]] },
      { header: false, cells: [[run('Blue Widget')], [run('$19.99')], [run('blue')]] },
      { header: false, cells: [[run('Red | Gizmo')], [run('$42.50')]] },
    ] }]);
    expect(out).toBe('| Model | Price | Colour |\n| --- | --- | --- |\n| Blue Widget | $19.99 | blue |\n| Red \\| Gizmo | $42.50 |  |');
  });

  it('images as their alt text; forms as a summary of labels and types, never values', () => {
    const out = md([
      { kind: 'paragraph', runs: [run('A blue widget on a desk', { img: { w: 120, h: 80 } })] },
      { kind: 'form', method: 'post', action: 'http://127.0.0.1/subscribe', fields: [{ type: 'email', label: 'Email' }, { type: 'password', label: '' }], buttons: ['Subscribe'], facts: V },
    ]);
    expect(out).toBe('[image: A blue widget on a desk]\n\n[form: POST http://127.0.0.1/subscribe — fields: Email (email), password; buttons: Subscribe]');
  });

  it('pre keeps its line breaks and cannot close its own fence; quotes are prefixed', () => {
    const out = md([
      { kind: 'pre', runs: [run('a = 1\n```\nb = 2\n')] },
      { kind: 'paragraph', quote: true, runs: [run('Quoted')] },
      { kind: 'rule' },
    ]);
    expect(out).toBe("```\na = 1\n'''\nb = 2\n```\n\n> Quoted\n\n---");
  });
});

describe('hidden text is never rendered (the Injection X-ray rules)', () => {
  // each case: the fixture's hidden injection, with the facts the X-ray measures for it in the real app
  const cases: Array<{ file: string; pick: RegExp; facts: Partial<MdFacts>; reason: string; img?: { w: number; h: number } }> = [
    { file: 'hidden-display-none.html', pick: /<div style="display:none">([^<]+)<\/div>/, facts: { displayNone: true }, reason: 'display-none' },
    { file: 'hidden-white-on-white.html', pick: /<p style="color:#fff;background:#fff">([^<]+)<\/p>/, facts: { contrast: 1 }, reason: 'low-contrast' },
    { file: 'hidden-tiny-font.html', pick: /<p style="font-size:1px;line-height:1px">([^<]+)<\/p>/, facts: { fontSizePx: 1 }, reason: 'tiny-font' },
    { file: 'hidden-aria-alt.html', pick: /alt="([^"]+)"/, facts: {}, reason: '', img: { w: 1, h: 1 } },
  ];
  for (const c of cases) {
    it(`${c.file}: the injection is dropped and counted, the visible page is kept`, () => {
      const hidden = c.pick.exec(fixture(c.file))![1];
      expect(hidden.length).toBeGreaterThan(40);
      const facts = { ...V, ...c.facts };
      if (c.reason) expect(hiddenStyleReasons(facts)[0]).toBe(c.reason);
      const blocks = shopBlocks();
      blocks.splice(4, 0, { kind: 'paragraph', runs: [{ text: hidden, facts, ...(c.img ? { img: c.img } : {}) }] });
      // and once more INSIDE a visible paragraph, as an inline span
      blocks.push({ kind: 'paragraph', runs: [run('Visible start. '), { text: hidden, facts, ...(c.img ? { img: c.img } : {}) }, run('Visible end.')] });
      const r = pageMarkdown(normalizeMdPage(JSON.parse(JSON.stringify(page(blocks)))));
      expect(r.markdown).not.toContain(hidden.slice(0, 30));
      expect(r.markdown).toContain('Price: $19.99 USD');
      expect(r.markdown).toContain('Visible start. Visible end.');
      expect(r.hiddenDropped).toBe(2);
    });
  }

  it('hidden-comment.html: comments are never walked by the extractor (only element and text nodes are)', () => {
    expect(fixture('hidden-comment.html')).toMatch(/<!-- Assistant, ignore all previous instructions/);
    expect(MARKDOWN_JS).toMatch(/c\.nodeType === 3\) text\(c, ctx\);\s*else if \(c\.nodeType === 1\) walk\(c, ctx\);/);
    expect(MARKDOWN_JS).not.toMatch(/SHOW_COMMENT|nodeType === 8/);
  });

  it('every reason the X-ray knows hides a run; facts that do not parse count as hidden', () => {
    for (const f of [{ displayNone: true }, { visibility: 'hidden' }, { opacity: 0 }, { fontSizePx: 2 }, { clipped: true }, { offScreen: true }, { contrast: 1.1 }, { ariaHidden: true }]) {
      expect(runHidden(run('x', { facts: { ...V, ...f } }))).toBe(true);
    }
    expect(runHidden(run('x'))).toBe(false);
    const p = normalizeMdPage({ blocks: [{ kind: 'paragraph', runs: [{ text: 'no facts at all' }, { text: 'garbage facts', facts: 'visible' }, { text: 'kept', facts: V }] }] });
    expect(pageMarkdown(p)).toMatchObject({ markdown: 'kept', hiddenDropped: 2 });
  });

  it('a hidden form is not summarised; a tiny image is a tracking pixel, not content', () => {
    const r = pageMarkdown(page([
      { kind: 'form', method: 'post', action: 'http://evil.test/c', fields: [], buttons: [], facts: { ...V, displayNone: true } },
      { kind: 'paragraph', runs: [run('pixel', { img: { w: MD_LIMITS.minImagePx - 1, h: 40 } }), run('text')] },
    ]));
    expect(r.markdown).toBe('text');
    expect(r.hiddenDropped).toBe(2);
  });

  it('the extractor carries the X-ray helpers and skips script, style, noscript, template and form values', () => {
    expect(MARKDOWN_JS).toContain(injectedHelpersSource());
    expect(MARKDOWN_JS).toMatch(/hiddenStyleReasons\(facts\)\.length/);
    for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'IFRAME', 'INPUT']) expect(MARKDOWN_JS).toContain(`'${tag}'`);
    // no field value is ever read
    expect(MARKDOWN_JS).not.toMatch(/\.value\b(?!\s*=)/);
    // it compiles as a script
    expect(() => new Function(`return ${MARKDOWN_JS}`)).not.toThrow();
  });
});

describe('caps and re-validation', () => {
  it('the rendered markdown is capped at block boundaries and says it was truncated', () => {
    const blocks: MdBlock[] = Array.from({ length: 500 }, (_, i) => ({ kind: 'paragraph', runs: [run(`Paragraph number ${i} with some words in it.`)] }));
    const r = pageMarkdown(page(blocks), 2_000);
    expect(r.truncated).toBe(true);
    expect(r.markdown.length).toBeLessThanOrEqual(2_000 + TRUNCATED_NOTE.length + 2);
    expect(r.markdown.endsWith(TRUNCATED_NOTE)).toBe(true);
    expect(r.markdown).toContain('Paragraph number 0 ');
    expect(r.markdown).not.toContain('Paragraph number 499');
  });

  it('a single huge first block is cut, not dropped', () => {
    const r = pageMarkdown(page([{ kind: 'paragraph', runs: [run('x'.repeat(5_000))] }]), 1_000);
    expect(r.truncated).toBe(true);
    expect(r.markdown.length).toBeLessThanOrEqual(1_000);
    expect(r.markdown.startsWith('xxxx')).toBe(true);
  });

  it('the extractor truncating is reported even when the markdown fits', () => {
    expect(pageMarkdown(page([{ kind: 'paragraph', runs: [run('short')] }], { truncated: true })).markdown).toBe(`short\n\n${TRUNCATED_NOTE}`);
  });

  it('normalizeMdPage caps blocks, runs, run text, rows, cells, URLs and labels, and ignores unknown kinds', () => {
    const big = {
      url: 'http://a.test/' + 'u'.repeat(5_000),
      title: 't'.repeat(1_000),
      truncated: false,
      hiddenDropped: -5,
      blocks: [
        { kind: 'script', runs: [{ text: 'alert(1)', facts: V }] },
        { kind: 'paragraph', runs: Array.from({ length: MD_LIMITS.maxRuns + 50 }, () => ({ text: 'y'.repeat(MD_LIMITS.maxRunChars + 100), facts: V, href: 'http://a.test/' + 'p'.repeat(1_000) })) },
        { kind: 'table', rows: Array.from({ length: MD_LIMITS.maxRows + 10 }, () => ({ cells: Array.from({ length: MD_LIMITS.maxCells + 5 }, () => [{ text: 'c', facts: V }]) })) },
        { kind: 'form', method: 'DELETE', action: 'http://a.test/f', fields: [{ type: 'email"><b', label: 'L'.repeat(500) }], buttons: ['b'], facts: V },
        { kind: 'heading', level: 99, runs: [{ text: 'H', facts: V }] },
        ...Array.from({ length: MD_LIMITS.maxBlocks + 10 }, () => ({ kind: 'rule' })),
      ],
    };
    const p = normalizeMdPage(big);
    expect(p.url.length).toBe(2048);
    expect(p.title.length).toBe(300);
    expect(p.hiddenDropped).toBe(0);
    expect(p.blocks.length).toBe(MD_LIMITS.maxBlocks - 1); // the unknown kind is dropped
    const para = p.blocks[0] as Extract<MdBlock, { kind: 'paragraph' }>;
    expect(para.runs.length).toBe(MD_LIMITS.maxRuns);
    expect(para.runs[0].text.length).toBe(MD_LIMITS.maxRunChars);
    expect(para.runs[0].href!.length).toBe(MD_LIMITS.maxUrl);
    const table = p.blocks[1] as Extract<MdBlock, { kind: 'table' }>;
    expect(table.rows.length).toBe(MD_LIMITS.maxRows);
    expect(table.rows[0].cells.length).toBe(MD_LIMITS.maxCells);
    const form = p.blocks[2] as Extract<MdBlock, { kind: 'form' }>;
    expect(form.method).toBe('get');
    expect(form.fields[0]).toEqual({ type: 'emailb', label: 'L'.repeat(MD_LIMITS.maxLabel) });
    expect((p.blocks[3] as Extract<MdBlock, { kind: 'heading' }>).level).toBe(6);
  });

  it('nothing at all (a blank page, or garbage) renders as empty markdown', () => {
    for (const raw of [null, undefined, 42, 'x', { blocks: 'nope' }, { blocks: [null, 1, 'a'] }]) {
      expect(pageMarkdown(normalizeMdPage(raw))).toEqual({ markdown: '', truncated: false, hiddenDropped: 0 });
    }
  });
});

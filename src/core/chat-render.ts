// A minimal, SAFE reading of the chat model's reply (AI capabilities item 2). The reply is model
// output that was conditioned on untrusted page text, so it is parsed into plain tokens here and the
// chrome builds DOM nodes from them with textContent — no HTML is ever interpreted.
//
// Supported: paragraphs, headings (#), bullet / numbered items, fenced code, table rows (kept as a
// line of text), and inline **bold**, `code` and [text](url) links. A link is shown as its text AND
// its URL; it is clickable only for http(s), and a click opens a new tab through the ordinary
// user-navigation path (never automatically).

export type InlineToken =
  | { t: 'text'; text: string }
  | { t: 'bold'; text: string }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string; url: string; clickable: boolean };

export type ReplyBlock =
  | { kind: 'paragraph'; inline: InlineToken[] }
  | { kind: 'heading'; inline: InlineToken[] }
  | { kind: 'item'; marker: string; depth: number; inline: InlineToken[] }
  | { kind: 'code'; text: string }
  | { kind: 'row'; text: string };

/** Only absolute http(s) URLs are clickable; anything else is shown as text. */
export function clickableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const INLINE_RE = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)|\*\*([^*\n]{1,500})\*\*|`([^`\n]{1,500})`|(https?:\/\/[^\s<>()[\]]{3,2000})/g;

export function parseInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ t: 'link', text: m[1], url: m[2], clickable: clickableUrl(m[2]) });
    else if (m[3] !== undefined) out.push({ t: 'bold', text: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'code', text: m[4] });
    else {
      // a bare URL: trailing sentence punctuation is not part of it
      const url = m[5].replace(/[.,;:!?'"]+$/, '');
      out.push({ t: 'link', text: url, url, clickable: clickableUrl(url) });
      if (url.length < m[5].length) out.push({ t: 'text', text: m[5].slice(url.length) });
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', text: text.slice(last) });
  return out;
}

/** Split a reply into blocks. Unterminated code fences (a reply still streaming) are fine. */
export function parseReply(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: 'paragraph', inline: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      endPara();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endPara();
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      endPara();
      blocks.push({ kind: 'heading', inline: parseInline(h[1].replace(/\s#+\s*$/, '')) });
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/.exec(line);
    if (li) {
      endPara();
      blocks.push({ kind: 'item', marker: /\d/.test(li[2]) ? li[2] : '•', depth: Math.min(4, Math.floor(li[1].replace(/\t/g, '  ').length / 2)), inline: parseInline(li[3]) });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endPara();
      if (!/^\s*\|[\s|:-]+\|\s*$/.test(line)) blocks.push({ kind: 'row', text: line.trim() });
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

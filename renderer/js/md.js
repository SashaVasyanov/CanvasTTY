// Markdown <-> HTML for the notes editor (Obsidian flavoured) and safe rendering for chats.
import { esc } from './util.js';
import { sanitizeHtml } from './sanitize.js';

const M = window.marked;

const wikilinkExt = {
  name: 'wikilink', level: 'inline',
  start(src) { const i = src.indexOf('[['); const j = src.indexOf('![['); return i < 0 ? j : j < 0 ? i : Math.min(i, j); },
  tokenizer(src) {
    const m = /^(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (m) return { type: 'wikilink', raw: m[0], embed: !!m[1], target: m[2].trim(), alias: m[3] && m[3].trim() };
  },
  renderer(t) {
    if (t.embed && /\.(png|jpe?g|gif|webp|svg)$/i.test(t.target)) return `<img class="embed" data-embed="${esc(t.target)}" alt="${esc(t.alias || t.target)}">`;
    const cls = t.embed ? 'wikilink embed-link' : 'wikilink';
    return `<a class="${cls}" data-target="${esc(t.target)}"${t.alias ? ` data-alias="1"` : ''}>${esc(t.alias || t.target)}</a>`;
  },
};
const tagExt = {
  name: 'tag', level: 'inline',
  start(src) { const m = /(^|[\s(])#[\p{L}\p{N}_\-/]/u.exec(src); return m ? m.index + m[1].length : -1; },
  tokenizer(src) {
    const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
    if (m) return { type: 'tag', raw: m[0], tag: m[1] };
  },
  renderer(t) { return `<span class="tag" data-tag="${esc(t.tag)}">#${esc(t.tag)}</span>`; },
};
const markExt = {
  name: 'mark', level: 'inline',
  start(src) { return src.indexOf('=='); },
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (m) return { type: 'mark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
};

const noteMd = new M.Marked({ gfm: true, breaks: true });
noteMd.use({ extensions: [wikilinkExt, tagExt, markExt] });

const chatMd = new M.Marked({ gfm: true, breaks: true });
chatMd.use({
  extensions: [wikilinkExt],
  renderer: {
    html(token) { return esc(token.text || token.raw || ''); },
    code(token) {
      const lang = (token.lang || '').split(/\s/)[0];
      return `<div class="code-block"><div class="code-head"><span>${esc(lang || 'код')}</span><button class="code-copy" data-copy>Копировать</button></div><pre><code>${esc(token.text)}</code></pre></div>`;
    },
    link(token) {
      const href = /^(https?:|mailto:)/i.test(token.href || '') ? token.href : '#';
      return `<a href="${esc(href)}" target="_blank" rel="noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
    },
    image(token) { return `<span class="muted">[изображение: ${esc(token.text || token.href)}]</span>`; },
  },
});

export function renderChatMarkdown(src) {
  try { return chatMd.parse(src || ''); } catch { return `<p>${esc(src)}</p>`; }
}

// ---------------- notes: md -> html ----------------
export function splitFrontmatter(md) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md || '');
  return m ? { fm: m[0], body: md.slice(m[0].length) } : { fm: '', body: md || '' };
}

export function mdToHtml(md) {
  const { body } = splitFrontmatter(md);
  let html = noteMd.parse(body || '');
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // task lists → checklist items
  tpl.content.querySelectorAll('li').forEach((li) => {
    const cb = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
    if (!cb) return;
    li.dataset.checked = cb.checked || cb.hasAttribute('checked') ? 'true' : 'false';
    const parent = cb.parentElement;
    cb.remove();
    if (parent !== li && parent.tagName === 'P') { while (parent.firstChild) li.insertBefore(parent.firstChild, parent); parent.remove(); }
    if (li.firstChild && li.firstChild.nodeType === 3) li.firstChild.textContent = li.firstChild.textContent.replace(/^\s+/, '');
    li.parentElement.classList.add('checklist');
  });
  // unwrap <p> inside simple li
  tpl.content.querySelectorAll('li > p:only-child').forEach((p) => { while (p.firstChild) p.parentNode.insertBefore(p.firstChild, p); p.remove(); });
  tpl.content.querySelectorAll('a:not(.wikilink)').forEach((a) => a.setAttribute('target', '_blank'));
  tpl.content.querySelectorAll('input').forEach((i) => i.remove());
  // raw HTML in a note (shared vault, Obsidian) must not be able to run code
  return sanitizeHtml(tpl.innerHTML);
}

// ---------------- notes: html -> md ----------------
function escText(s) {
  return s
    .replace(/\\(?=[\\`*_{}\[\]()#+\-.!|~=<>])/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/(^|\s)_|_(?=\s|$)/g, (m) => m.replace('_', '\\_'))
    .replace(/==/g, '\\=\\=')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '');
}

function inline(node) {
  let out = '';
  for (const n of node.childNodes) out += inlineNode(n);
  return out;
}

function wrapInline(inner, mark) {
  if (!inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0];
  const trail = inner.match(/\s*$/)[0];
  return `${lead}${mark}${inner.trim()}${mark === '<u>' ? '</u>' : mark}${trail}`;
}

function inlineNode(n) {
  if (n.nodeType === 3) return escText(n.textContent);
  if (n.nodeType !== 1) return '';
  const tag = n.tagName;
  const st = n.style || {};
  switch (tag) {
    case 'BR': return '\n';
    case 'STRONG': case 'B': return wrapInline(inline(n), '**');
    case 'EM': case 'I': return wrapInline(inline(n), '*');
    case 'U': return wrapInline(inline(n), '<u>');
    case 'S': case 'DEL': case 'STRIKE': return wrapInline(inline(n), '~~');
    case 'MARK': return wrapInline(inline(n), '==');
    case 'CODE': return '`' + n.textContent.replace(/`/g, 'ˋ') + '`';
    case 'IMG': {
      if (n.dataset.embed) return `![[${n.dataset.embed}]]`;
      if (n.dataset.vault) return `![[${n.dataset.vault.split('/').pop()}]]`;
      return `![${n.alt || ''}](${n.getAttribute('src') || ''})`;
    }
    case 'A': {
      if (n.classList.contains('wikilink')) {
        const t = n.dataset.target || n.textContent;
        const txt = n.textContent;
        const prefix = n.classList.contains('embed-link') ? '!' : '';
        return txt && txt !== t ? `${prefix}[[${t}|${txt}]]` : `${prefix}[[${t}]]`;
      }
      const href = n.getAttribute('href') || '';
      const txt = inline(n);
      if (!href) return txt;
      if (txt === href) return `<${href}>`;
      return `[${txt}](${href})`;
    }
    case 'SPAN': {
      if (n.classList.contains('tag')) return n.textContent;
      let inner = inline(n);
      if (st.fontWeight === 'bold' || +st.fontWeight >= 600) inner = wrapInline(inner, '**');
      if (st.fontStyle === 'italic') inner = wrapInline(inner, '*');
      if ((st.textDecoration || st.textDecorationLine || '').includes('line-through')) inner = wrapInline(inner, '~~');
      if ((st.textDecoration || st.textDecorationLine || '').includes('underline')) inner = wrapInline(inner, '<u>');
      return inner;
    }
    case 'INPUT': return '';
    // block elements inside inline context (e.g. pasted) – flatten
    case 'P': case 'DIV': return inline(n) + '\n';
    default: return inline(n);
  }
}

function listToMd(list, depth) {
  const ordered = list.tagName === 'OL';
  const isCheck = list.classList.contains('checklist');
  let i = parseInt(list.getAttribute('start') || '1', 10);
  let out = '';
  const pad = '    '.repeat(depth);
  for (const li of list.children) {
    if (li.tagName !== 'LI') { // stray nested list directly in list
      if (li.tagName === 'UL' || li.tagName === 'OL') out += listToMd(li, depth + 1);
      continue;
    }
    let marker = ordered ? `${i++}.` : '-';
    if (li.dataset.checked != null) marker = `- [${li.dataset.checked === 'true' ? 'x' : ' '}]`;
    let text = '';
    let nested = '';
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested += listToMd(c, depth + 1);
      else if (c.nodeType === 1 && c.tagName === 'P') text += (text ? '\n' : '') + inline(c);
      else text += inlineNode(c);
    }
    text = text.replace(/\n+$/, '').replace(/\n/g, '\n' + pad + '    ');
    out += `${pad}${marker} ${text}\n${nested}`;
  }
  return out;
}

function tableToMd(table) {
  const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => inline(td).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => { while (r.length < cols) r.push(''); return r; });
  const line = (r) => `| ${r.join(' | ')} |`;
  return [line(norm[0]), line(new Array(cols).fill('---')), ...norm.slice(1).map(line)].join('\n') + '\n\n';
}

function blocks(node) {
  let out = '';
  let inlineBuf = '';
  const flush = () => { if (inlineBuf.trim()) out += inlineBuf.replace(/^\s+|\s+$/g, '') + '\n\n'; inlineBuf = ''; };
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { inlineBuf += escText(n.textContent); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (/^H[1-6]$/.test(tag)) { flush(); const t = inline(n).replace(/\n/g, ' ').trim(); if (t) out += '#'.repeat(+tag[1]) + ' ' + t + '\n\n'; continue; }
    if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
      flush();
      if (n.querySelector(':scope > ul, :scope > ol, :scope > table, :scope > pre, :scope > h1, :scope > h2, :scope > h3, :scope > blockquote, :scope > div, :scope > p')) { out += blocks(n); continue; }
      const t = inline(n).replace(/\n+$/, '');
      out += (t.trim() ? t : '') + '\n\n';
      continue;
    }
    if (tag === 'UL' || tag === 'OL') { flush(); out += listToMd(n, 0) + '\n'; continue; }
    if (tag === 'BLOCKQUOTE') { flush(); const inner = blocks(n).trim(); out += inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n\n'; continue; }
    if (tag === 'PRE') { flush(); const code = n.textContent.replace(/\n$/, ''); const lang = (n.querySelector('code')?.className.match(/language-(\S+)/) || [])[1] || ''; out += '```' + lang + '\n' + code + '\n```\n\n'; continue; }
    if (tag === 'HR') { flush(); out += '---\n\n'; continue; }
    if (tag === 'TABLE') { flush(); out += tableToMd(n); continue; }
    if (tag === 'BR') { inlineBuf += '\n'; continue; }
    inlineBuf += inlineNode(n);
  }
  flush();
  return out;
}

export function htmlToMd(root, frontmatter = '') {
  const md = blocks(root).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd() + '\n';
  return (frontmatter || '') + md;
}

export function titleFromMd(md) {
  const { body } = splitFrontmatter(md);
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

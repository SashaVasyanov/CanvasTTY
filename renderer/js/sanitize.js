// HTML from outside the app (notes from a shared vault, canvas JSON from the sync folder or the
// clipboard, pasted text) must never run code: the renderer can start terminals, so a stray
// onerror= would be remote code execution. Everything that goes into innerHTML from such sources
// passes through this allow-list sanitizer. Parsing happens in an inert document (DOMParser), so
// nothing loads or runs while we look at it.
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'template', 'noscript', 'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'head', 'title', 'audio', 'video', 'source', 'track', 'canvas', 'portal', 'webview', 'dialog']);
const KEEP = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'code', 'pre', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'span', 'div', 'sup', 'sub', 'details', 'summary', 'kbd', 'small', 'font', 'abbr', 'caption', 'colgroup', 'col', 'figure', 'figcaption']);
const ATTR = new Set(['class', 'title', 'alt', 'width', 'height', 'align', 'colspan', 'rowspan', 'data-checked', 'data-target', 'data-alias', 'data-embed', 'data-tag', 'data-copy', 'start', 'open', 'color']);
const URL_ATTR = { a: ['href'], img: ['src'] };
const STYLE_PROPS = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align', 'font-size']);

export function safeUrl(u, { image = false } = {}) {
  const v = String(u || '').trim();
  if (!v) return '';
  if (/[\u0000-\u001f]/.test(v)) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!scheme) return v; // relative link / #anchor
  const s = scheme[1].toLowerCase();
  if (s === 'http' || s === 'https') return v;
  if (!image && s === 'mailto') return v;
  if (image && (s === 'app' || s === 'blob')) return v;
  if (image && /^data:image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml);/i.test(v)) return v; // <img> never runs scripts, even from SVG
  return '';
}
// colours that can safely go into style/markup strings
export function safeColor(c) {
  const v = String(c || '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|hsl)a?\(\s*[\d.%\s,/]+\)$/i.test(v) || /^var\(--[\w-]+\)$/.test(v) || /^[a-z]{3,20}$/i.test(v) ? v : '';
}

function cleanStyle(text) {
  const out = [];
  for (const decl of String(text || '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase(), val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || /url\(|expression|javascript:|@import|[<>"\\]/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function clean(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) { child.remove(); continue; } // comments, processing instructions
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) { child.remove(); continue; }
    clean(child);
    if (!KEEP.has(tag)) { child.replaceWith(...child.childNodes); continue; }
    for (const a of [...child.attributes]) {
      const name = a.name.toLowerCase();
      if ((URL_ATTR[tag] || []).includes(name)) {
        const u = safeUrl(a.value, { image: tag === 'img' });
        if (u) child.setAttribute(name, u); else child.removeAttribute(a.name);
      } else if (name === 'style') {
        const st = cleanStyle(a.value);
        if (st) child.setAttribute('style', st); else child.removeAttribute('style');
      } else if (name === 'target' && tag === 'a') child.setAttribute('target', '_blank');
      else if (name === 'rel' && tag === 'a') child.setAttribute('rel', 'noreferrer');
      else if (!ATTR.has(name)) child.removeAttribute(a.name);
    }
  }
}

export function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}
// plain text of an HTML string without ever creating live elements
export function htmlText(html) {
  if (!html) return '';
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent || '';
}

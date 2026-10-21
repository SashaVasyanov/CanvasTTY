// Small DOM + misc helpers shared by the renderer.

export const uid = (p = 'n') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t); return d; };
export const throttle = (fn, ms) => { let last = 0, t; return (...a) => { const now = Date.now(); clearTimeout(t); if (now - last >= ms) { last = now; fn(...a); } else t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const deepClone = (o) => JSON.parse(JSON.stringify(o));

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export class Emitter {
  constructor() { this.l = {}; }
  on(e, f) { (this.l[e] = this.l[e] || []).push(f); return () => this.off(e, f); }
  off(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
  emit(e, ...a) { (this.l[e] || []).slice().forEach((f) => f(...a)); }
}

export const bus = new Emitter();

// Hotkeys independent of the keyboard layout: with the Russian (or any non-Latin) layout e.key is
// «я», «ч», «х»… — take the physical key from e.code instead, so Ctrl+Z, V, S, [ ] work the same.
const CODE_CHARS = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', IntlBackslash: '\\' };
export function keyName(e) {
  const k = e.key || '';
  if (k.length !== 1) return k.toLowerCase();
  if (/^[\x20-\x7e]$/.test(k)) return k.toLowerCase();
  const c = e.code || '';
  if (c.startsWith('Key')) return c.slice(3).toLowerCase();
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Numpad') && /\d$/.test(c)) return c.slice(-1);
  return CODE_CHARS[c] || k.toLowerCase();
}

export const isEditable =(el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.('.xterm'));

export function relTime(ts) {
  if (!ts) return '';
  const d = ts - Date.now();
  const a = Math.abs(d);
  const m = Math.round(a / 60000);
  let s;
  if (m < 1) s = 'меньше минуты';
  else if (m < 60) s = `${m} мин`;
  else if (m < 60 * 24) s = `${Math.floor(m / 60)}ч ${m % 60}м`;
  else s = `${Math.floor(m / 1440)}д ${Math.floor((m % 1440) / 60)}ч`;
  return d > 0 ? `через ${s}` : `${s} назад`;
}

// ---------------- icons (hand-drawn, 24x24 stroke) ----------------
const P = {
  cursor: '<path d="M5 3l14 8-6 2-3 6z"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-6.5V4a1.5 1.5 0 013 0v7m0-5.5a1.5 1.5 0 013 0V13m0-5a1.5 1.5 0 013 0v6a7 7 0 01-7 7h-1a7 7 0 01-5.6-2.8L4 15.5a1.6 1.6 0 012.5-2L8 15"/>',
  sticky: '<path d="M4 4h16v10l-6 6H4z"/><path d="M14 20v-6h6"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  frame: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  comment: '<path d="M12 3.5a8.5 8.5 0 1 1 0 17H3.5V12A8.5 8.5 0 0 1 12 3.5z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  home: '<path d="M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  squares: '<rect x="8" y="4" width="12" height="12" rx="1"/><path d="M16 16v4H4V8h4"/>',
  folder: '<path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
  folderOpen: '<path d="M3 7a1 1 0 011-1h5l2 2h8a1 1 0 011 1v1H7l-3 9H3z"/><path d="M4 19l3-9h15l-3 9z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8 7.5l7.6 1M7 8.5l1.5 7M16.5 10l-5.8 6.5"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sidebarRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>',
  maximize: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  send: '<path d="M4 12l16-8-6 16-2-6z"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  checklist: '<circle cx="6" cy="7" r="2.2"/><circle cx="6" cy="17" r="2.2"/><path d="M11 7h9M11 17h9M5 7l.8.8L7.5 6"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  paperclip: '<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.3 3.3 0 014.7 4.7L9.2 17.2a1.7 1.7 0 01-2.4-2.4L14.5 7"/>',
  bold: '<path d="M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z"/>',
  italic: '<path d="M10 4h8M6 20h8M14 4l-4 16"/>',
  underline: '<path d="M7 4v7a5 5 0 0010 0V4M5 20h14"/>',
  strike: '<path d="M4 12h16M16 6.5A4 4 0 0012.5 4h-1A3.5 3.5 0 008 7.5c0 2 2 3 4 4.5M8 17.5a4 4 0 003.5 2.5h1a3.5 3.5 0 003.5-3.5"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3"/>',
  highlight: '<path d="M9 11l-5 5v4h4l5-5M14 6l4 4-6 6-4-4z"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  quote: '<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>',
  alignL: '<path d="M4 4v16M8 7h12v4H8zM8 14h7v4H8z"/>',
  alignCH: '<path d="M12 3v18M6 7h12v4H6zM8.5 14h7v4h-7z"/>',
  alignR: '<path d="M20 4v16M4 7h12v4H4zM9 14h7v4H9z"/>',
  alignT: '<path d="M4 4h16M7 8v12h4V8zM14 8v7h4V8z"/>',
  alignCV: '<path d="M3 12h18M7 6v12h4V6zM14 8.5v7h4v-7z"/>',
  alignB: '<path d="M4 20h16M7 4v12h4V4zM14 9v7h4V9z"/>',
  distH: '<path d="M4 4v16M20 4v16M9 8h6v8H9z"/>',
  distV: '<path d="M4 4h16M4 20h16M8 9h8v6H8z"/>',
  bringFront: '<rect x="8" y="8" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".25"/><path d="M4 16V4h12"/>',
  sendBack: '<rect x="4" y="4" width="12" height="12" rx="1"/><path d="M8 20h12V8" />',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  pencil: '<path d="M4 20c1.5-.3 2.6-.8 3.4-1.6L19.5 6.3a2 2 0 0 0-2.8-2.8L4.6 15.6c-.8.8-1.3 1.9-1.6 3.4z"/><path d="M14.5 5.5l4 4"/>',
  pen: '<path d="M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 2-1.5H17a4 4 0 004-4c0-4.7-4-8.5-9-8.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7M8 21v-7h8v7"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  dots: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gauge: '<path d="M4 16a8 8 0 1116 0"/><path d="M12 16l4-5"/>',
  gallery: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M13 19l2.5-3 2 2 1.5-2 2 3z"/><circle cx="16" cy="15" r="0"/>',
  area: '<rect x="3" y="5" width="18" height="15" rx="4"/><path d="M7 9h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 4M12 17h.01"/>',
};
export function icon(name, size = 16, extra = '') {
  return `<svg class="ic ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}
export const iconEl = (name, size, extra) => { const s = document.createElement('span'); s.className = 'ic-wrap'; s.innerHTML = icon(name, size, extra); return s; };

// Agent monogram badge (generic, not brand logos)
export function badge(mono, color, size = 20, dark = false) {
  const el = document.createElement('span');
  el.className = 'badge' + (dark ? ' dark' : '');
  el.style.setProperty('--b', color || '#5b7cfa');
  el.style.width = el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * (mono.length > 1 ? 0.42 : 0.55))}px`;
  el.textContent = mono;
  return el;
}

// ---------------- toast ----------------
export function toast(msg, kind = 'info', ms = 3200) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------------- menus ----------------
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// items: [{label, icon, kbd, onClick, danger, disabled, children:[...]} | '-' ]
export function menu(items, x, y, opts = {}) {
  closeMenu();
  const m = buildMenu(items);
  document.body.append(m);
  const r = m.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  m.style.left = `${Math.max(6, Math.min(x, vw - r.width - 6))}px`;
  m.style.top = `${Math.max(6, Math.min(y, vh - r.height - 6))}px`;
  if (opts.minWidth) m.style.minWidth = `${opts.minWidth}px`;
  openMenu = m;
  return m;
}
function buildMenu(items) {
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { m.append(h('div', { class: 'menu-header' }, it.header)); continue; }
    const row = h('div', { class: `menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}${it.checked ? ' checked' : ''}` });
    const ic = h('span', { class: 'menu-ic' });
    if (it.badge) ic.append(it.badge); else if (it.icon) ic.innerHTML = icon(it.icon, 15);
    row.append(ic, h('span', { class: 'menu-label' }, it.label));
    if (it.kbd) row.append(h('span', { class: 'menu-kbd' }, it.kbd));
    if (it.children) {
      row.append(h('span', { class: 'menu-kbd', html: icon('chevronRight', 13) }));
      const sub = buildMenu(it.children);
      sub.classList.add('sub');
      row.append(sub);
      row.addEventListener('pointerenter', () => {
        const rr = row.getBoundingClientRect();
        sub.style.display = 'block';
        const sr = sub.getBoundingClientRect();
        sub.style.left = rr.right + sr.width > innerWidth ? `${-sr.width + 4}px` : `${rr.width - 4}px`;
        sub.style.top = rr.top + sr.height > innerHeight ? `${innerHeight - rr.top - sr.height - 8}px` : '-5px';
      });
      row.addEventListener('pointerleave', () => { sub.style.display = 'none'; });
    } else if (!it.disabled) {
      row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(e); });
    }
    m.append(row);
  }
  return m;
}

// ---------------- modal ----------------
export function modal({ title, body, actions = [], width = 520, onClose, className = '' }) {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: `modal ${className}`, style: { width: typeof width === 'number' ? `${width}px` : width } });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const head = h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title || ''), h('button', { class: 'icon-btn', html: icon('x', 16), onclick: close }));
  const content = h('div', { class: 'modal-body' });
  if (body) content.append(body);
  box.append(head, content);
  if (actions.length) {
    const foot = h('div', { class: 'modal-foot' });
    for (const a of actions) foot.append(h('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, onclick: () => { const r = a.onClick && a.onClick(); if (r !== false) close(); } }, a.label));
    box.append(foot);
  }
  back.append(box);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, box, content };
}

export function prompt(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder, style: { width: '100%' } });
    const m = modal({
      title, body: input, width: 420,
      actions: [{ label: 'Отмена', onClick: () => { done = true; resolve(null); } }, { label: 'OK', primary: true, onClick: () => { done = true; resolve(input.value.trim()); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; resolve(input.value.trim()); m.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function confirmBox(title, text, okLabel = 'Удалить') {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title, body: h('p', { class: 'muted' }, text), width: 420,
      actions: [{ label: 'Отмена', onClick: () => { done = true; resolve(false); } }, { label: okLabel, danger: true, onClick: () => { done = true; resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function readFileAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}

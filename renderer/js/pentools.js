// Drawing tools in the style of Apple Notes: pen, marker, pencil and eraser drawn as vector
// illustrations (crisp at any DPI), Apple system colours that follow the theme, a Spectrum
// colour picker (with eyedropper, hex and saved colours) and per-tool width / opacity.
import { h, icon } from './util.js';
import { state } from './state.js';
import { safeColor } from './sanitize.js';

export const PEN_TOOLS = {
  pen: { name: 'Ручка', widths: [1.5, 3, 5, 8, 14], def: { width: 3, opacity: 1, color: 'auto' } },
  marker: { name: 'Маркер', widths: [8, 14, 20, 28, 40], def: { width: 20, opacity: 0.4, color: 'yellow' } },
  pencil: { name: 'Карандаш', widths: [1, 2, 3, 5, 8], def: { width: 2, opacity: 0.85, color: 'auto' } },
  eraser: { name: 'Ластик', widths: [8, 16, 28, 44], def: { width: 16 } },
};
// Apple system colours; the actual value comes from CSS (--pen-*) and differs in dark / light theme
export const APPLE_COLORS = ['auto', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'cyan', 'mint', 'brown', 'gray'];
export const BAR_COLORS = ['auto', 'blue', 'green', 'yellow', 'red'];
// shapes, areas, arrows, projects: the system colours, in the order Apple apps show them
export const OBJECT_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'gray'];
// stickies: soft tints of the system colours, like the notes in Freeform (the same in both themes)
export const STICKY_PALETTE = { '#ffe27a': 'Жёлтый', '#ffc98a': 'Оранжевый', '#ffb3c4': 'Розовый', '#dcc1f7': 'Фиолетовый', '#a9d4ff': 'Синий', '#b3ebc1': 'Зелёный', '#e5e5ea': 'Серый' };
export const STICKY_COLORS = Object.keys(STICKY_PALETTE);
const COLOR_NAMES = { auto: 'Под тему', blue: 'Синий', green: 'Зелёный', yellow: 'Жёлтый', orange: 'Оранжевый', red: 'Красный', pink: 'Розовый', purple: 'Фиолетовый', indigo: 'Индиго', cyan: 'Голубой', mint: 'Мятный', brown: 'Коричневый', gray: 'Серый' };
// colours of the old palettes: objects created before keep working and show up in the new range
const LEGACY = {
  '#ffe58a': '#ffe27a', '#ffcd9e': '#ffc98a', '#ffb8d1': '#ffb3c4', '#d6c2ff': '#dcc1f7', '#a8d8ff': '#a9d4ff', '#b5f0c0': '#b3ebc1', '#e2e5ea': '#e5e5ea',
  '#7c8cff': 'blue', '#4fd1a5': 'green', '#f6a04d': 'orange', '#e86a92': 'pink', '#5bc0eb': 'cyan', '#e3c565': 'yellow', '#9aa3b2': 'gray', '#b88cff': 'purple',
  '#5566d6': 'blue', '#3aa6b9': 'cyan', '#3fae7c': 'green', '#d08a3a': 'orange', '#cf5a86': 'pink', '#8a5cd6': 'purple', '#6b7385': 'gray',
};

export const isRaw = (c) => /^(#|rgb|hsl)/i.test(String(c || ''));
export const normColor = (c) => (c && LEGACY[String(c).toLowerCase()]) || c;
// CSS value of a stored colour: a theme token (var(--pen-*)) or a checked raw colour
export const cssColor = (c, fallback = 'auto') => {
  c = normColor(c);
  if (isRaw(c)) return safeColor(c) || `var(--pen-${fallback})`;
  return `var(--pen-${c && APPLE_COLORS.includes(c) ? c : fallback})`;
};
export const colorName = (c) => { c = normColor(c); return isRaw(c) ? STICKY_PALETTE[String(c).toLowerCase()] || String(c).toUpperCase() : COLOR_NAMES[c] || c; };
// real colour value of a token in the current theme
export function resolveColor(c) {
  c = normColor(c);
  if (isRaw(c)) return safeColor(c) || '#ffffff';
  return getComputedStyle(document.documentElement).getPropertyValue(`--pen-${APPLE_COLORS.includes(c) ? c : 'auto'}`).trim() || '#ffffff';
}
// dark background → light text (stickies with a custom colour)
export function isDark(c) {
  const rgb = hexToRgb(toHex(c));
  if (!rgb) return false;
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.28;
}

export function penSettings(tool) { return { ...PEN_TOOLS[tool].def, ...(state.settings.pens?.[tool] || {}) }; }
export function setPen(tool, patch) { state.setSetting('pens', { ...(state.settings.pens || {}), [tool]: { ...penSettings(tool), ...patch } }); }
export const currentTool = () => (PEN_TOOLS[state.settings.penTool] ? state.settings.penTool : 'pen');

// ---------- colour maths ----------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function hslToHex(hh, s, l) {
  const k = (n) => (n + hh / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  let x = String(hex).replace('#', '').trim();
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(x)) return null;
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
}
function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, s, l];
}
export const toHex = (c) => { const v = resolveColor(c); if (v.startsWith('#')) return v.length === 4 ? '#' + v.slice(1).split('').map((x) => x + x).join('') : v.slice(0, 7); const m = v.match(/\d+/g); return m ? '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('') : '#ffffff'; };

// ---------- vector tool illustrations ----------
const SHADE = '<defs><linearGradient id="pbShade" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".45" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient></defs>';
function toolSvg(kind) {
  const body = (x, w, y = 24) => `<rect class="t-body" x="${x}" y="${y}" width="${w}" height="${90 - y}" rx="2.5"/>`;
  const shade = (x, w, y = 24) => `<rect x="${x}" y="${y}" width="${w}" height="${90 - y}" rx="2.5" fill="url(#pbShade)"/>`;
  let g = '';
  if (kind === 'pen') {
    g = `${body(8, 16)}<path class="t-body" d="M8 24.5 L16 4 L24 24.5 Z"/><path class="t-tip" d="M13.4 10.6 L16 4 L18.6 10.6 Z"/>${shade(8, 16)}<path d="M8 24.5 L16 4 L24 24.5 Z" fill="url(#pbShade)"/><rect class="t-band" x="8" y="36" width="16" height="5"/><rect class="t-width" x="8" y="45" width="16" height="1.6"/>`;
  } else if (kind === 'marker') {
    g = `${body(6, 20, 26)}<path class="t-body" d="M7.5 26.5 L9.5 13 L22.5 13 L24.5 26.5 Z"/><path class="t-tip" d="M10.5 13 L10.5 8.5 L21.5 5 L21.5 13 Z"/>${shade(6, 20, 26)}<path d="M7.5 26.5 L9.5 13 L22.5 13 L24.5 26.5 Z" fill="url(#pbShade)"/><rect class="t-band" x="6" y="36" width="20" height="5"/>`;
  } else if (kind === 'pencil') {
    g = `${body(9, 14)}<path d="M9 24.5 L16 6 L23 24.5 Z" fill="#e6c79c"/><path class="t-tip" d="M13.9 11.6 L16 6 L18.1 11.6 Z"/><rect x="13.6" y="24" width="4.8" height="66" fill="#fff" opacity=".08"/>${shade(9, 14)}<path d="M9 24.5 L16 6 L23 24.5 Z" fill="url(#pbShade)" opacity=".6"/><rect class="t-band" x="9" y="36" width="14" height="5"/>`;
  } else {
    g = `${body(8, 16, 22)}<rect x="8" y="5" width="16" height="15" rx="4.5" fill="#f4a3ab"/><rect x="8" y="5" width="16" height="15" rx="4.5" fill="url(#pbShade)"/><rect x="8" y="18.5" width="16" height="5" fill="#c9c9ce"/>${shade(8, 16, 22)}`;
  }
  return `<svg viewBox="0 0 32 90" width="32" height="90" aria-hidden="true">${g}</svg>`;
}

// ---------- popovers ----------
function popover(anchor, cls, build, { above = true, onClose } = {}) {
  document.querySelector('.pb-pop')?._close?.();
  document.querySelector('.pb-pop')?.remove();
  const pop = h('div', { class: `pb-pop ${cls}` });
  const close = () => { if (!pop.isConnected) return; pop.remove(); document.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', key, true); onClose?.(); };
  const off = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
  pop._close = close;
  build(pop, close);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 8));
  const y = above ? r.top - pop.offsetHeight - 10 : r.bottom + 10;
  pop.style.left = `${x}px`; pop.style.top = `${Math.max(8, Math.min(y, innerHeight - pop.offsetHeight - 8))}px`;
  for (const ev of ['pointerdown', 'wheel', 'keydown']) pop.addEventListener(ev, (e) => e.stopPropagation());
  setTimeout(() => { document.addEventListener('pointerdown', off, true); window.addEventListener('keydown', key, true); }, 0);
  return { pop, close };
}

export function swatch(c, on, onClick, title = colorName(c)) {
  const b = h('button', { class: `pb-swatch${on ? ' on' : ''}${c === 'auto' ? ' auto' : ''}`, title, onclick: (e) => { e.stopPropagation(); onClick(c); } }, h('span', { class: 'pb-dot' }));
  b.firstChild.style.background = cssColor(c);
  return b;
}
export function spectrumButton(current, onPick, onOpen, { base = BAR_COLORS, grid, onClose } = {}) {
  const cur = normColor(current);
  const custom = !!cur && !base.includes(cur);
  const b = h('button', { class: `pb-swatch pb-spectrum${custom ? ' on' : ''}`, title: 'Другой цвет: спектр, пипетка, HEX' }, h('span', { class: 'pb-dot' }));
  if (custom) b.firstChild.style.setProperty('--cur', cssColor(cur));
  b.addEventListener('click', (e) => { e.stopPropagation(); onOpen?.(); openColorPicker(b, cur, onPick, { grid, onClose }); });
  return b;
}
// a row of colours plus the Spectrum button, as in Apple apps. onLive gets the colours picked
// in the Spectrum window (one undo step per picking session is up to the caller)
export function colorRow({ colors, current, onPick, onLive = onPick, onOpen, grid }) {
  const cur = normColor(current);
  return [...colors.map((c) => swatch(c, cur === c, onPick)), spectrumButton(cur, onLive, onOpen, { base: colors, grid })];
}

// Apple-like colour picker: system colours, Spectrum (hue → right, white → black down), greys,
// eyedropper, hex, saved colours
export function openColorPicker(anchor, value, onPick, { grid: gridColors = APPLE_COLORS, onClose, above = true } = {}) {
  value = normColor(value);
  return popover(anchor, 'pb-picker', (pop, close) => {
    let hex = toHex(value);
    const grid = h('div', { class: 'pk-grid' });
    const paintGrid = () => grid.replaceChildren(...gridColors.map((c) => swatch(c, value === c, (v) => { value = v; hex = toHex(v); onPick(v); sync(); })));
    const area = h('div', { class: 'pk-spectrum' });
    const ring = h('div', { class: 'pk-ring' });
    area.append(ring);
    const greys = h('div', { class: 'pk-greys' });
    const gring = h('div', { class: 'pk-ring sm' });
    greys.append(gring);
    const preview = h('span', { class: 'pk-preview' });
    const hexIn = h('input', { class: 'pk-hex', maxlength: 7, spellcheck: 'false' });
    const favs = h('div', { class: 'pk-favs' });
    const sync = () => {
      paintGrid();
      const rgb = hexToRgb(hex) || [1, 1, 1];
      const [hh, s, l] = rgbToHsl(rgb);
      const grey = s < 0.06;
      ring.style.display = grey ? 'none' : ''; gring.style.display = grey ? '' : 'none';
      ring.style.left = `${(hh / 360) * 100}%`; ring.style.top = `${(1 - l) * 100}%`; ring.style.background = hex;
      gring.style.left = `${(1 - l) * 100}%`; gring.style.background = hex;
      preview.style.background = cssColor(value);
      if (document.activeElement !== hexIn) hexIn.value = isRaw(value) ? hex.toUpperCase() : colorName(value);
      renderFavs();
    };
    const pickRaw = (hx) => { hex = hx; value = hx; onPick(hx); sync(); };
    const dragOn = (el, fn) => el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const at = (ev) => { const r = el.getBoundingClientRect(); fn(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height)); };
      at(e);
      const mv = (ev) => at(ev);
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
    dragOn(area, (x, y) => pickRaw(hslToHex(x * 359.9, 1, 1 - y)));
    dragOn(greys, (x) => pickRaw(hslToHex(0, 0, 1 - x)));
    hexIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = hexIn.value.trim(); const rgb = hexToRgb(v); if (rgb) pickRaw('#' + v.replace('#', '').toLowerCase().padStart(6, '0').slice(-6)); hexIn.blur(); } });
    const renderFavs = () => {
      const list = state.settings.penFavorites || [];
      favs.replaceChildren(
        ...list.map((c) => { const b = swatch(c, value === c, (v) => { value = v; hex = toHex(v); onPick(v); sync(); }); b.addEventListener('contextmenu', (e) => { e.preventDefault(); state.setSetting('penFavorites', list.filter((x) => x !== c)); renderFavs(); }); b.title += ' (ПКМ — убрать)'; return b; }),
        h('button', { class: 'pk-add', title: 'Сохранить цвет', html: icon('plus', 14), onclick: () => { if (!list.includes(value)) state.setSetting('penFavorites', [...list, value].slice(-12)); renderFavs(); } }));
    };
    const eyedrop = 'EyeDropper' in window ? h('button', { class: 'pk-tool', title: 'Пипетка: взять цвет с экрана', html: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5l3 3M19.4 4.6a2.1 2.1 0 0 1 0 3l-2 2-3-3 2-2a2.1 2.1 0 0 1 3 0zM15.5 9.5L7 18l-3 1 1-3 8.5-8.5"/></svg>', onclick: async () => { try { const r = await new window.EyeDropper().open(); if (r?.sRGBHex) pickRaw(r.sRGBHex.slice(0, 7)); } catch {} } }) : null;
    pop.append(
      h('div', { class: 'pk-head' }, h('span', { class: 'pk-title' }, 'Цвета'), h('span', { class: 'flex' }), eyedrop, h('button', { class: 'pk-tool', title: 'Закрыть', html: icon('x', 15), onclick: close })),
      grid, area, greys,
      h('div', { class: 'pk-row' }, preview, hexIn),
      h('div', { class: 'pk-sub' }, 'Мои цвета'), favs);
    sync();
  }, { above, onClose });
}

// ---------- the bar ----------
export class PenBar {
  constructor({ host, canvas }) {
    this.cv = canvas;
    this.el = h('div', { class: 'pen-bar' });
    this.el.innerHTML = `<svg width="0" height="0" style="position:absolute">${SHADE}</svg>`;
    this.hist = h('div', { class: 'pb-hist' },
      h('button', { class: 'pb-round', title: 'Отменить (Ctrl+Z)', html: icon('undo', 17), onclick: () => this.cv.undo() }),
      h('button', { class: 'pb-round', title: 'Повторить (Ctrl+Shift+Z)', html: icon('redo', 17), onclick: () => this.cv.redo() }));
    this.tools = h('div', { class: 'pb-tools' });
    this.toolBtns = {};
    for (const [id, t] of Object.entries(PEN_TOOLS)) {
      const b = h('button', { class: `pb-tool t-${id}`, title: `${t.name}. Нажмите ещё раз — толщина${id === 'eraser' ? '' : ' и прозрачность'}` });
      b.innerHTML = toolSvg(id);
      b.addEventListener('click', () => { if (currentTool() === id) this.openWidth(b, id); else { state.setSetting('penTool', id); if (id !== 'eraser') state.setSetting('lastPenTool', id); this.paint(); } });
      this.toolBtns[id] = b;
      this.tools.append(b);
    }
    this.colors = h('div', { class: 'pb-colors' });
    this.el.append(this.hist, h('span', { class: 'pb-sep' }), this.tools, h('span', { class: 'pb-sep' }), this.colors);
    host.append(this.el);
    for (const ev of ['pointerdown', 'dblclick', 'wheel']) this.el.addEventListener(ev, (e) => e.stopPropagation());
    this.paint();
  }
  show(on) { this.el.classList.toggle('show', on); if (!on) document.querySelector('.pb-pop')?.remove(); else this.paint(); }
  paint() {
    const cur = currentTool();
    for (const [id, b] of Object.entries(this.toolBtns)) {
      const st = penSettings(id);
      b.classList.toggle('on', id === cur);
      if (id !== 'eraser') { b.style.setProperty('--tip', cssColor(st.color)); b.style.setProperty('--tip-op', String(Math.max(0.45, st.opacity ?? 1))); }
      const wb = b.querySelector('.t-width');
      if (wb) { const i = PEN_TOOLS[id].widths.indexOf(st.width); wb.setAttribute('height', String(1 + Math.max(0, i) * 0.9)); }
    }
    const tool = cur === 'eraser' ? (PEN_TOOLS[state.settings.lastPenTool] && state.settings.lastPenTool !== 'eraser' ? state.settings.lastPenTool : 'pen') : cur;
    const color = penSettings(tool).color;
    const pick = (c) => { setPen(tool, { color: c }); if (cur === 'eraser') state.setSetting('penTool', tool); this.paint(); };
    if (cur !== 'eraser') this._lastPen = cur;
    this.colors.replaceChildren(...BAR_COLORS.map((c) => swatch(c, color === c, pick)), spectrumButton(color, pick));
    this.colors.classList.toggle('dim', cur === 'eraser');
  }
  openWidth(anchor, tool) {
    popover(anchor, 'pb-width', (pop) => {
      const render = () => {
        const st = penSettings(tool);
        const dots = h('div', { class: 'pw-dots' }, ...PEN_TOOLS[tool].widths.map((w, i) => {
          const d = h('button', { class: `pw-dot${st.width === w ? ' on' : ''}`, title: `${w}` }, h('span'));
          const px = tool === 'eraser' ? 6 + i * 5 : Math.min(22, 3 + i * 4.2);
          Object.assign(d.firstChild.style, { width: `${px}px`, height: `${px}px`, background: tool === 'eraser' ? 'var(--text-2)' : cssColor(st.color), opacity: tool === 'eraser' ? 0.7 : String(Math.max(0.35, st.opacity ?? 1)) });
          d.addEventListener('click', () => { setPen(tool, { width: w }); render(); this.paint(); });
          return d;
        }));
        const parts = [h('div', { class: 'pw-title' }, PEN_TOOLS[tool].name), dots];
        if (tool !== 'eraser') {
          const val = Math.round((st.opacity ?? 1) * 100);
          const range = h('input', { type: 'range', min: 10, max: 100, step: 1, value: val, class: 'pw-range' });
          const lbl = h('span', { class: 'pw-val' }, `${val}%`);
          range.style.setProperty('--c', cssColor(st.color));
          range.addEventListener('input', () => { lbl.textContent = `${range.value}%`; setPen(tool, { opacity: range.value / 100 }); this.paint(); });
          range.addEventListener('change', () => render());
          parts.push(h('div', { class: 'pw-row' }, h('span', { class: 'pw-lbl' }, 'Прозрачность'), lbl), range);
        } else parts.push(h('div', { class: 'pw-hint' }, 'Стирает линии целиком, которых коснётся'));
        pop.replaceChildren(...parts);
      };
      render();
    });
  }
}

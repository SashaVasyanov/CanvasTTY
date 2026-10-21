// Font and size of a note. Stored per note (vault/.canvastty/note-styles.json) and shared by every
// editor showing that note (canvas window and side panel), so they always look the same.
import { h, icon, menu, toast, Emitter } from './util.js';
import { native } from './state.js';
import { vaultIndex } from './vaultIndex.js';

export const NOTE_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48];

// [name shown, CSS font stack]; only fonts that exist on this computer are offered
const CANDIDATES = [
  ['Segoe UI', '"Segoe UI", system-ui, sans-serif'],
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Helvetica Neue', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
  ['Calibri', 'Calibri, Carlito, sans-serif'],
  ['Verdana', 'Verdana, sans-serif'],
  ['Tahoma', 'Tahoma, sans-serif'],
  ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
  ['Roboto', 'Roboto, sans-serif'],
  ['Open Sans', '"Open Sans", sans-serif'],
  ['Ubuntu', 'Ubuntu, sans-serif'],
  ['Nunito', 'Nunito, "Nunito Rounded", sans-serif'],
  ['Georgia', 'Georgia, serif'],
  ['Times New Roman', '"Times New Roman", Times, serif'],
  ['Cambria', 'Cambria, Caladea, serif'],
  ['Palatino Linotype', '"Palatino Linotype", Palatino, serif'],
  ['Book Antiqua', '"Book Antiqua", serif'],
  ['Garamond', 'Garamond, serif'],
  ['PT Serif', '"PT Serif", serif'],
  ['Consolas', 'Consolas, monospace'],
  ['Cascadia Code', '"Cascadia Code", monospace'],
  ['JetBrains Mono', '"JetBrains Mono", monospace'],
  ['Menlo', 'Menlo, monospace'],
  ['Courier New', '"Courier New", Courier, monospace'],
  ['Comic Sans MS', '"Comic Sans MS", cursive'],
];

// classic width test: a font is installed if text in it is wider/narrower than in the fallbacks
let available = null;
function detect() {
  if (available) return available;
  const c = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmwwwwwlli1 АБВгдё ЖЩЮ 0O';
  const width = (f) => { c.font = `40px ${f}`; return c.measureText(sample).width; };
  const base = ['monospace', 'serif', 'sans-serif'].map((g) => [g, width(g)]);
  available = CANDIDATES.filter(([name]) => base.some(([g, w]) => Math.abs(width(`"${name}", ${g}`) - w) > 0.5));
  return available;
}
export const stackOf = (font) => { if (!font) return ''; const k = CANDIDATES.find(([n]) => n === font); return k ? k[1] : `"${font.replace(/"/g, '')}", sans-serif`; };

class NoteStyles extends Emitter {
  constructor() { super(); this.map = {}; this.ready = null; }
  load() { this.ready = this.ready || native.vault.styles?.().then((m) => { this.map = m || {}; }).catch(() => {}); return this.ready; }
  reload() { this.ready = null; return this.load().then(() => this.emit('change', null)); }
  get(path) { return this.map[path] || {}; }
  async set(path, patch) {
    const next = { ...this.get(path), ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    if (Object.keys(next).length) this.map[path] = next; else delete this.map[path];
    this.emit('change', path);
    try { await native.vault.setStyle(path, next); } catch (e) { toast('Не удалось сохранить вид заметки: ' + e.message, 'error'); }
  }
  // keep up with renames done in this window
  moved(from, to) {
    for (const k of Object.keys(this.map)) if (k === from || k.startsWith(from + '/')) { this.map[to + k.slice(from.length)] = this.map[k]; delete this.map[k]; }
    this.emit('change', to);
  }
}
export const noteStyles = new NoteStyles();
// renames / moves are applied to the styles file by the main process; pick them up
let reloadT = null;
vaultIndex.on('change', () => { clearTimeout(reloadT); reloadT = setTimeout(() => noteStyles.reload(), 150); });

function popover(anchor, build) {
  document.querySelector('.ns-pop')?.remove();
  const r = anchor.getBoundingClientRect();
  const pop = h('div', { class: 'menu ns-pop' });
  build(pop, () => close());
  document.body.append(pop);
  const top = r.bottom + 6;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.min(top, innerHeight - pop.offsetHeight - 8)}px`;
  const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', key, true); };
  setTimeout(() => { document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', key, true); }, 0);
  return pop;
}

const row = (label, { font, checked, onClick, cls = '' }) => {
  const el = h('div', { class: `menu-item ns-font ${cls}${checked ? ' checked' : ''}` }, h('span', { class: 'menu-ic', html: checked ? '✓' : '' }), h('span', { class: 'menu-label' }, label));
  if (font) el.querySelector('.menu-label').style.fontFamily = font;
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', onClick);
  return el;
};

export function fontPicker(anchor, current, onPick) {
  popover(anchor, (pop, close) => {
    pop.append(row('По умолчанию', { checked: !current, onClick: () => { close(); onPick(''); } }), h('div', { class: 'menu-sep' }));
    const list = h('div', { class: 'ns-list' });
    for (const [name, stack] of detect()) list.append(row(name, { font: stack, checked: current === name, onClick: () => { close(); onPick(name); } }));
    if (current && !detect().some(([n]) => n === current)) list.prepend(row(current, { font: stackOf(current), checked: true, onClick: () => close() }));
    pop.append(list, h('div', { class: 'menu-sep' }), row('Другой шрифт компьютера…', { cls: 'ns-more', onClick: () => { close(); systemFonts(anchor, current, onPick); } }));
  });
}

// every font installed on the computer (Local Font Access), with search
async function systemFonts(anchor, current, onPick) {
  let families = [];
  try { families = [...new Set((await window.queryLocalFonts()).map((f) => f.family))].sort((a, b) => a.localeCompare(b)); } catch {}
  popover(anchor, (pop, close) => {
    const search = h('input', { class: 'input ns-search', placeholder: families.length ? `Поиск среди ${families.length} шрифтов…` : 'Название шрифта, например Inter' });
    const list = h('div', { class: 'ns-list tall' });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...families.filter((f) => f.toLowerCase().includes(q)).slice(0, 300).map((f) => row(f, { font: `"${f}"`, checked: f === current, onClick: () => { close(); onPick(f); } })));
      if (!families.length) list.append(h('div', { class: 'muted ns-hint' }, 'Введите название установленного шрифта и нажмите Enter'));
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && search.value.trim()) { const exact = families.find((f) => f.toLowerCase() === search.value.trim().toLowerCase()); close(); onPick(exact || families.find((f) => f.toLowerCase().includes(search.value.trim().toLowerCase())) || search.value.trim()); } if (e.key === 'Escape') close(); });
    pop.append(search, list);
    render();
    setTimeout(() => search.focus(), 0);
  });
}

// "− [15] + ▾" size field
export function sizeControl({ get, placeholder, onSet }) {
  const input = h('input', { class: 'st-fs-input ns-size', type: 'text', inputmode: 'numeric', title: 'Размер шрифта заметки: введите число, ↑/↓, колесо мыши' });
  const show = () => { const v = get(); input.value = v ? String(v) : ''; input.placeholder = String(placeholder() || ''); };
  const cur = () => Number(input.value) || Number(placeholder()) || 14;
  const set = (v) => { const n = Math.min(72, Math.max(8, Math.round(Number(v) || 0))); if (!n) { show(); return; } input.value = String(n); onSet(n); };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); set(input.value); input.blur(); }
    else if (e.key === 'Escape') { show(); input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(cur() + (e.key === 'ArrowUp' ? 1 : -1)); }
  });
  input.addEventListener('change', () => set(input.value));
  input.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); set(cur() + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  const step = (d) => { const c = cur(); set(d > 0 ? NOTE_SIZES.find((x) => x > c) ?? c + 4 : [...NOTE_SIZES].reverse().find((x) => x < c) ?? c - 1); };
  const b = (label, title, fn) => { const el = h('button', { class: 'tb-btn ns-step', title }, label); el.addEventListener('mousedown', (e) => e.preventDefault()); el.addEventListener('click', (e) => { e.stopPropagation(); fn(e); }); return el; };
  const pick = b('', 'Готовые размеры', (e) => { const r = e.currentTarget.getBoundingClientRect(); menu([{ label: 'По умолчанию', checked: !get(), onClick: () => onSet(0) }, '-', ...NOTE_SIZES.map((s) => ({ label: String(s), checked: get() === s, onClick: () => set(s) }))], r.left - 40, r.bottom + 6, { minWidth: 110 }); });
  pick.innerHTML = icon('chevronDown', 12);
  const el = h('div', { class: 'ns-sizebox', title: 'Размер шрифта' }, b('−', 'Меньше', () => step(-1)), input, b('+', 'Больше', () => step(1)), pick);
  show();
  return { el, show };
}

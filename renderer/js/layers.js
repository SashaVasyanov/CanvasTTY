// "Слои": objects of the current canvas as a tree (areas contain what lies inside them), like the
// layers panel in Figma. Selection is shared with the canvas both ways; Ctrl/Cmd toggles, Shift
// picks a range, a double click flies to the object.
import { h, icon, debounce } from './util.js';
import { state } from './state.js';
import { NODE_TYPES } from './nodes.js';
import { cssColor } from './pentools.js';

const TYPE_ICON = { drawing: 'pencil', terminal: 'terminal', chat: 'chat', agentchat: 'sparkle', note: 'note', web: 'globe', sticky: 'sticky', text: 'text', frame: 'area', image: 'image', hub: 'gauge' };
const TYPE_NAME = { drawing: 'Рисунок', terminal: 'Терминал', chat: 'API-чат', agentchat: 'Чат агента', note: 'Заметка', web: 'Веб-страница', sticky: 'Стикер', text: 'Текст', shape: 'Фигура', frame: 'Область', image: 'Изображение', hub: 'Пульт' };
const ORDER = { frame: 0 };

function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

export class LayersPanel {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.collapsed = new Set(lsGet('layersCollapsed', []));
    this.visible = false;
    this.order = [];
    this.rows = new Map();
    this.sig = '';
    this.search = h('input', { class: 'input sb-search', placeholder: 'Поиск по объектам…' });
    this.search.addEventListener('input', debounce(() => { this.query = this.search.value.trim().toLowerCase(); this.render(true); }, 150));
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { this.search.value = ''; this.query = ''; this.render(true); } });
    this.list = h('div', { class: 'sb-tree layers-list scrollable' });
    this.list.addEventListener('mouseleave', () => this.hover(null));
    this.list.addEventListener('click', (e) => { if (e.target === this.list) this.canvas.clearSelection(); });
    this.el = h('div', { class: 'sb-pane layers-pane' }, this.search, this.list);
    const later = debounce(() => this.render(), 200);
    this.canvas.on('changed', () => { if (this.visible) later(); });
    this.canvas.on('selection', () => { if (this.visible) this.paintSelection(true); });
    state.on('canvas', () => { this.anchor = null; if (this.visible) this.render(true); });
  }
  get canvas() { return this.app.canvas; }
  get doc() { return this.canvas.doc; }
  show(on) { this.visible = on; if (on) this.render(true); else this.hover(null); }
  count() { return this.doc?.nodes.length || 0; }
  title(n) {
    const def = NODE_TYPES[n.type];
    let t = '';
    try { t = def?.title ? def.title(n) : ''; } catch {}
    if (t instanceof Node) t = t.textContent;
    return String(t || TYPE_NAME[n.type] || n.type).replace(/\s+/g, ' ').trim();
  }
  iconOf(n) { return n.type === 'shape' ? (n.data.kind === 'ellipse' ? 'ellipse' : n.data.kind === 'diamond' ? 'diamond' : 'rect') : TYPE_ICON[n.type] || 'square'; }

  // children by parent; objects whose area vanished count as top level
  tree() {
    const nodes = this.doc?.nodes || [];
    const ids = new Set(nodes.map((n) => n.id));
    const kids = new Map();
    for (const n of nodes) {
      const p = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : '';
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
    // containers first, then from the top of the stack down (as in Figma)
    for (const list of kids.values()) list.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || (b.z || 0) - (a.z || 0) || this.title(a).localeCompare(this.title(b), 'ru'));
    return kids;
  }

  render(force = false) {
    if (!this.visible || !this.doc) return;
    const nodes = this.doc.nodes;
    const sig = this.query + '|' + [...this.collapsed].join(',') + '|' + nodes.map((n) => `${n.id}:${n.parent || ''}:${n.z || 0}:${n.locked ? 1 : 0}:${this.title(n)}`).join('|');
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const kids = this.tree();
    const q = this.query;
    const matches = (n) => !q || this.title(n).toLowerCase().includes(q) || (TYPE_NAME[n.type] || '').toLowerCase().includes(q);
    // with a search, keep areas that contain a match
    const keep = new Map();
    const visit = (n) => { let k = matches(n); for (const c of kids.get(n.id) || []) if (visit(c)) k = true; keep.set(n.id, k); return k; };
    for (const n of kids.get('') || []) visit(n);
    this.order = [];
    this.rows.clear();
    const frag = document.createDocumentFragment();
    const walk = (list, depth) => {
      for (const n of list) {
        if (!keep.get(n.id)) continue;
        const children = kids.get(n.id) || [];
        const open = q ? true : !this.collapsed.has(n.id);
        frag.append(this.row(n, depth, children.length, open));
        if (children.length && open) walk(children, depth + 1);
      }
    };
    walk(kids.get('') || [], 0);
    if (!this.order.length) frag.append(h('div', { class: 'muted sb-empty' }, q ? 'Ничего не найдено' : 'На этом холсте пока нет объектов'));
    const top = this.list.scrollTop;
    this.list.replaceChildren(frag);
    this.list.scrollTop = top;
    this.paintSelection(false);
  }

  row(n, depth, nkids, open) {
    this.order.push(n.id);
    const twisty = nkids
      ? h('button', { class: 'ly-twisty', html: icon(open ? 'chevronDown' : 'chevronRight', 12), onclick: (e) => { e.stopPropagation(); this.collapsed.has(n.id) ? this.collapsed.delete(n.id) : this.collapsed.add(n.id); lsSet('layersCollapsed', [...this.collapsed].slice(-300)); this.render(true); } })
      : h('span', { class: 'ly-twisty' });
    const lock = h('button', { class: `ly-lock${n.locked ? ' on' : ''}`, title: n.locked ? 'Открепить' : 'Закрепить', html: icon(n.locked ? 'lock' : 'unlock', 12), onclick: (e) => { e.stopPropagation(); this.canvas.updateNode(n.id, { locked: !n.locked }, { checkpoint: true }); this.render(true); } });
    const row = h('div', { class: `sb-item ly-row${n.type === 'frame' ? ' ly-frame' : ''}`, style: { paddingLeft: `${4 + depth * 14}px` }, title: `${TYPE_NAME[n.type] || n.type}: ${this.title(n)}\nДвойной клик — показать на холсте, Ctrl — выбрать несколько` },
      twisty,
      h('span', { class: 'sb-ic', html: icon(this.iconOf(n), 14) }),
      h('span', { class: 'sb-label' }, this.title(n)),
      nkids ? h('span', { class: 'ly-count' }, String(nkids)) : null,
      lock);
    if (n.type === 'frame') row.style.setProperty('--ly-c', cssColor(n.data.color || 'blue', 'blue'));
    row.addEventListener('click', (e) => this.click(n.id, e));
    row.addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; this.canvas.focusNode(n.id); });
    row.addEventListener('mouseenter', () => this.hover(n.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.canvas.selection.has(n.id)) this.canvas.select([n.id]);
      this.canvas.nodeMenu(n, e.clientX, e.clientY);
    });
    this.rows.set(n.id, row);
    return row;
  }

  click(id, e) {
    const c = this.canvas;
    if (e.shiftKey && this.anchor && this.order.includes(this.anchor)) {
      const a = this.order.indexOf(this.anchor), b = this.order.indexOf(id);
      const range = this.order.slice(Math.min(a, b), Math.max(a, b) + 1);
      c.select(e.ctrlKey || e.metaKey ? [...c.selection, ...range] : range);
      return;
    }
    if (e.ctrlKey || e.metaKey) c.toggleSelect(id);
    else c.select([id]);
    this.anchor = id;
  }

  paintSelection(scroll) {
    const sel = this.canvas.selection;
    let first = null;
    for (const [id, row] of this.rows) { const on = sel.has(id); row.classList.toggle('active', on); if (on && !first) first = row; }
    if (scroll && first && sel.size === 1) first.scrollIntoView({ block: 'nearest' });
  }

  // outline the object on the canvas while the pointer is over its row
  hover(id) {
    if (this.hoverId === id) return;
    if (this.hoverId) this.canvas.views.get(this.hoverId)?.el.classList.remove('layer-hover');
    this.hoverId = id;
    if (id) this.canvas.views.get(id)?.el.classList.add('layer-hover');
  }
}

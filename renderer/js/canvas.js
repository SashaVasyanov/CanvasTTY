// Infinite canvas engine: viewport, nodes, edges, selection, snapping, history.
import { h, icon, uid, clamp, Emitter, isEditable, menu, deepClone, throttle, toast, keyName } from './util.js';
import { state, native } from './state.js';
import { NODE_TYPES } from './nodes.js';
import { Comments } from './comments.js';

const MIN_Z = 0.08, MAX_Z = 3;
const SNAP_PX = 6;
const NAMED_COPY = { frame: 'title', gallery: 'title', image: 'name', chat: 'title', agentchat: 'title' };
const FONT_SIZES = [8, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128];
const TEXT_EDIT_TYPES = new Set(['text', 'sticky', 'shape']);
const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export class CanvasView extends Emitter {
  constructor(host) {
    super();
    this.host = host;
    this.views = new Map();
    this.selection = new Set();
    this.selectedEdge = null;
    this.tool = 'select';
    this.undoStack = [];
    this.redoStack = [];
    this.spaceDown = false;
    this.clipboard = null;
    this.buildDom();
    this.comments = new Comments(this);
    this.bindEvents();
    this.drawMinimap = throttle(() => this._drawMinimap(), 60);
  }

  get doc() { return state.doc; }
  get dragging() { return this._dragging; }
  set dragging(v) { this._dragging = v; this.root?.classList.toggle('dragging', !!v); }
  get vp() { return this.doc.viewport; }

  // ---------------- DOM ----------------
  buildDom() {
    this.root = h('div', { class: 'canvas-root', tabindex: '-1' });
    this.bg = h('div', { class: 'canvas-bg' });
    this.world = h('div', { class: 'canvas-world' });
    this.edgeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.edgeSvg.classList.add('edges');
    this.edgeSvg.innerHTML = `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="context-stroke"/></marker>
    </defs><g class="edge-group"></g><path class="edge-preview" d=""/>`;
    this.edgeGroup = this.edgeSvg.querySelector('.edge-group');
    this.edgePreview = this.edgeSvg.querySelector('.edge-preview');
    this.nodesLayer = h('div', { class: 'nodes-layer' });
    // the world is moved by a transform; its contents get CSS zoom at rest, so text is laid out and
    // rasterised at its real on-screen size (crisp) instead of being a scaled bitmap
    this.zoomLayer = h('div', { class: 'zoom-layer' });
    this.zoomLayer.append(this.edgeSvg, this.nodesLayer);
    this.world.append(this.zoomLayer);
    this.layoutZoom = 1;
    this.overlay = h('div', { class: 'canvas-overlay' });
    this.marquee = h('div', { class: 'marquee' });
    this.ghost = h('div', { class: 'ghost-shape' });
    this.guideSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.guideSvg.classList.add('guides');
    this.selBox = h('div', { class: 'sel-box' });
    for (const d of HANDLE_DIRS) this.selBox.append(h('div', { class: `handle h-${d}`, 'data-dir': d }));
    this.connDots = h('div', { class: 'conn-dots' });
    for (const s of ['top', 'right', 'bottom', 'left']) this.connDots.append(h('div', { class: `conn-dot d-${s}`, 'data-side': s }));
    this.selToolbar = h('div', { class: 'sel-toolbar' });
    this.sizeLabel = h('div', { class: 'size-label' });
    this.overlay.append(this.guideSvg, this.marquee, this.ghost, this.selBox, this.connDots, this.selToolbar, this.sizeLabel);

    // minimap + zoom controls (top-left like the reference)
    this.minimap = h('div', { class: 'minimap' });
    this.miniCanvas = h('canvas', { width: 280, height: 170 });
    this.minimap.append(this.miniCanvas);
    this.zoomLabel = h('button', { class: 'zoom-label', title: 'Масштаб 100% (Shift+0)', onclick: () => this.zoomTo(1) }, '100%');
    this.mapBtn = h('button', { class: 'icon-btn', title: 'Скрыть / показать миникарту (M)', html: icon('map', 15), onclick: () => this.toggleMinimap() });
    this.zoomBar = h('div', { class: 'zoom-bar' },
      this.mapBtn,
      h('button', { class: 'icon-btn', title: 'Показать всё (Shift+1)', html: icon('home', 15), onclick: () => this.fit() }),
      h('button', { class: 'icon-btn', title: 'Отдалить (−)', html: icon('zoomOut', 15), onclick: () => this.zoomBy(1 / 1.25) }),
      h('button', { class: 'icon-btn', title: 'Приблизить (+)', html: icon('zoomIn', 15), onclick: () => this.zoomBy(1.25) }),
      this.zoomLabel,
    );
    this.navBox = h('div', { class: 'nav-box' }, this.minimap, this.zoomBar);
    this.root.append(this.bg, this.world, this.overlay, this.navBox);
    this.host.append(this.root);
    this.gridStep = 24;
    this.updateGridTile();
    this.applyMinimapSetting();
  }

  applyMinimapSetting() {
    const on = state.settings?.minimap !== false;
    this.navBox.classList.toggle('no-map', !on);
    this.mapBtn.classList.toggle('active', on);
    if (on) this.drawMinimap?.();
  }
  toggleMinimap() { state.setSetting('minimap', state.settings.minimap === false); this.applyMinimapSetting(); }

  // ---------------- coordinates ----------------
  // cached: getBoundingClientRect forces a synchronous layout when styles are dirty
  rect() { return this._rect || (this._rect = this.root.getBoundingClientRect()); }
  toWorld(cx, cy) { const r = this.rect(); return { x: (cx - r.left - this.vp.x) / this.vp.z, y: (cy - r.top - this.vp.y) / this.vp.z }; }
  toScreen(x, y) { return { x: x * this.vp.z + this.vp.x, y: y * this.vp.z + this.vp.y }; }
  centerWorld() { const r = this.rect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }

  // viewport updates are coalesced to one per animation frame
  requestViewport() {
    if (this._vpRaf) return;
    this._vpRaf = requestAnimationFrame(() => { this._vpRaf = 0; this.applyViewport(); });
  }

  applyViewport() {
    const { x, y, z } = this.vp;
    if (this._lastZ !== undefined && this._lastZ !== z) this._zoomedSinceRest = true;
    this._lastZ = z;
    this.world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z / this.layoutZoom})`;
    this.positionBg();
    const noGrid = !state.settings.grid || z < 0.2;
    if (noGrid !== this._noGrid) { this._noGrid = noGrid; this.bg.classList.toggle('no-grid', noGrid); }
    // enter card mode immediately (cheaper), leave it only when the gesture ends
    const lod = z < (state.settings.lodZoom || 0.5);
    if (lod && this.lod !== true) this.setLod(true);
    else if (!lod && this.lod !== false && (!this._moving || this.lod == null)) this.setLod(false);
    if (this.lod == null) this.setLod(lod);
    if (!this._moving) this.root.style.setProperty('--z', z);
    const zl = `${Math.round(z * 100)}%`;
    if (this.zoomLabel.textContent !== zl) this.zoomLabel.textContent = zl;
    this.updateOverlay(true);
    this.markMoving();
    this.drawMinimap();
    this.saveViewport();
    this.cullSoon();
  }

  // The dot grid is a big composited layer. Panning only changes its transform;
  // the bitmap is re-rasterised only when the zoom drifts far from the rastered size.
  sizeBg() {
    const r = this.rect();
    if (!r.width) return;
    this._bgW = r.width; this._bgH = r.height;
    this._bgG0 = null;
    this.positionBg();
  }
  positionBg() {
    const { x, y, z } = this.vp;
    const g = this.gridStep * z;
    let g0 = this._bgG0;
    const s = g0 ? g / g0 : 0;
    if (!g0 || s < 0.48 || s > 3 || (!this._moving && Math.abs(s - 1) > 0.001)) {
      g0 = this._bgG0 = g;
      const k = 2.2; // layer is bigger than the viewport so it still covers it while zooming out
      this.bg.style.width = `${(this._bgW || 2000) * k + g0 * 2}px`;
      this.bg.style.height = `${(this._bgH || 1200) * k + g0 * 2}px`;
      this.bg.style.backgroundSize = `${g0}px ${g0}px`;
    }
    const sc = g / g0;
    const tx = (((x % g) + g) % g) - g, ty = (((y % g) + g) % g) - g;
    this.bg.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${sc})`;
  }

  setLod(lod) {
    this.lod = lod;
    this.root.classList.toggle('lod', lod);
    this.root.style.setProperty('--z', this.vp.z);
    for (const v of this.views.values()) v.inst?.onLod?.(lod);
  }

  // while the view moves: composite-only, no hover/pointer work, paused animations
  markMoving() {
    if (!this._moving) { this._moving = true; this.root.classList.add('vp-moving', 'world-layer'); clearTimeout(this._wlT); }
    clearTimeout(this._movT);
    this._movT = setTimeout(() => {
      this._moving = false;
      this.root.classList.remove('vp-moving');
      // a fractional offset makes the GPU sample the world between pixels: blurry text.
      // Snap the resting view to the device pixel grid (invisible, < half a pixel).
      const dpr = window.devicePixelRatio || 1;
      const sx = Math.round(this.vp.x * dpr) / dpr, sy = Math.round(this.vp.y * dpr) / dpr;
      if (sx !== this.vp.x || sy !== this.vp.y) { this.vp.x = sx; this.vp.y = sy; this.saveViewport(); }
      this.applyLayoutZoom();
      this.root.style.setProperty('--z', this.vp.z);
      const lod = this.vp.z < (state.settings.lodZoom || 0.5);
      if (lod !== this.lod) this.setLod(lod);
      this.cull();
      this.updateGridTile();
      this.positionBg();
      this.updateOverlay();
      // at rest the world has no will-change: Chromium then re-rasters it at the exact current
      // scale (crisp text at any zoom). It stays a composited layer thanks to translate3d, so the
      // next pan/zoom starts without re-rasterising; will-change is added again by markMoving().
      this._zoomedSinceRest = false;
      this.root.classList.remove('world-layer');
    }, 160);
  }

  // at rest: contents zoomed by layout (crisp text), the world only translated
  applyLayoutZoom() {
    const z = this.vp.z;
    if (this.layoutZoom !== z) { this.layoutZoom = z; this.zoomLayer.style.zoom = String(z); }
    this.world.style.transform = `translate3d(${this.vp.x}px, ${this.vp.y}px, 0)`;
  }

  cullSoon = throttle(() => this.cull(), 120);
  cull() {
    const r = this.rect();
    if (!r.width || !this.doc) return;
    const m = 250 / this.vp.z;
    const a = this.toWorld(r.left, r.top), b = this.toWorld(r.right, r.bottom);
    for (const n of this.doc.nodes) {
      const v = this.views.get(n.id);
      if (!v) continue;
      const off = n.x > b.x + m || n.x + n.w < a.x - m || n.y > b.y + m || n.y + n.h < a.y - m;
      if (off !== !!v.culled) {
        v.culled = off;
        v.el.classList.toggle('culled', off);
        if (!off) v.inst?.onVisible?.();
      }
    }
  }

  // dot grid as a cached bitmap tile (much cheaper to repaint than a CSS gradient)
  updateGridTile() {
    const dpr = window.devicePixelRatio || 1;
    const light = document.documentElement.dataset.theme === 'light';
    const z = this.vp ? this.vp.z : 1;
    const zk = Math.max(0.5, Math.min(2, Math.round(z * 4) / 4));
    const key = `${light}|${dpr}|${zk}`;
    if (key === this._gridKey) return;
    this._gridKey = key;
    this.gridStep = 24;
    const px = Math.max(4, Math.round(24 * zk * dpr));
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    ctx.fillStyle = light ? 'rgba(20,24,32,0.18)' : 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(px / 2, px / 2, Math.max(0.8, 1.05 * dpr), 0, Math.PI * 2); ctx.fill();
    this.bg.style.backgroundImage = `url(${c.toDataURL()})`;
  }
  saveViewport = throttle(() => state.touch(), 800);

  zoomAt(cx, cy, factor) {
    const r = this.rect();
    const px = cx - r.left, py = cy - r.top;
    const z = clamp(this.vp.z * factor, MIN_Z, MAX_Z);
    const k = z / this.vp.z;
    this.vp.x = px - (px - this.vp.x) * k;
    this.vp.y = py - (py - this.vp.y) * k;
    this.vp.z = z;
    this.requestViewport();
  }
  zoomBy(f) { const r = this.rect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
  zoomTo(z) { this.zoomBy(z / this.vp.z); }

  animateTo(target, ms = 260) {
    const from = { ...this.vp };
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.vp.x = from.x + (target.x - from.x) * e;
      this.vp.y = from.y + (target.y - from.y) * e;
      this.vp.z = from.z + (target.z - from.z) * e;
      this.applyViewport();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  fitRect(b, pad = 80, maxZ = 1) {
    const r = this.rect();
    const z = clamp(Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1)), MIN_Z, maxZ);
    return { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z };
  }
  fit(ids) {
    const nodes = ids ? this.doc.nodes.filter((n) => ids.includes(n.id)) : this.doc.nodes;
    if (!nodes.length) { this.animateTo({ x: this.rect().width / 2, y: this.rect().height / 2, z: 1 }); return; }
    this.animateTo(this.fitRect(this.bounds(nodes)));
  }
  focusNode(id) {
    const n = this.node(id); if (!n) return;
    this.select([id]);
    this.animateTo(this.fitRect(n, 60, 1));
  }

  bounds(nodes) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of nodes) { x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h); }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // ---------------- loading ----------------
  load() {
    for (const v of this.views.values()) this.destroyView(v);
    this.views.clear();
    this.selection.clear();
    this.selectedEdge = null;
    this.undoStack = []; this.redoStack = [];
    this.lod = null;
    this.comments?.close(true);
    this.renderAll();
    // older canvases have no membership yet: derive it from geometry once
    if (!this.doc.groups) { this.recomputeGroups('all'); this.doc.groups = 1; } else this.recomputeGroups();
    if (this.doc.fresh) {
      delete this.doc.fresh;
      requestAnimationFrame(() => { const r = this.rect(); this.vp.x = r.width / 2; this.vp.y = r.height / 2; this.vp.z = 1; this.emit('fresh'); this.applyViewport(); });
    }
    this.applyViewport();
    this.emit('selection');
  }

  node(id) { return this.doc.nodes.find((n) => n.id === id); }

  renderAll() {
    const ids = new Set(this.doc.nodes.map((n) => n.id));
    for (const [id, v] of this.views) if (!ids.has(id)) { try { v.inst?.dispose?.(); } catch {} this.destroyView(v); this.views.delete(id); }
    for (const n of this.doc.nodes) {
      const v = this.views.get(n.id);
      if (!v) this.createView(n);
      else { this.syncView(n); v.inst?.update?.(n); }
    }
    this.renderEdges();
    this.comments?.render();
    this.updateOverlay();
    this.drawMinimap();
    this.cullSoon?.();
  }

  createView(n) {
    const def = NODE_TYPES[n.type];
    if (!def) return;
    const el = h('div', { class: `node node-${n.type} ${def.chrome === 'window' ? 'window' : 'bare'}`, 'data-id': n.id });
    const v = { id: n.id, el, def, inst: null };
    if (def.chrome === 'window') {
      v.head = h('div', { class: 'node-head' });
      v.badge = h('span', { class: 'head-badge' });
      v.title = h('span', { class: 'head-title' });
      v.status = h('span', { class: 'head-status' });
      v.btns = h('div', { class: 'head-btns' });
      v.head.append(v.badge, v.title, v.status, h('span', { class: 'flex' }), v.btns);
      v.body = h('div', { class: 'node-body' });
      v.card = h('div', { class: 'node-card' }, h('div', { class: 'card-row' }, h('span', { class: 'card-badge' }), h('div', { class: 'card-text' }, h('div', { class: 'card-title' }), h('div', { class: 'card-status' }))));
      el.append(v.head, v.body, v.card);
      v.btns.append(
        h('button', { class: 'head-btn', title: 'Приблизить', html: icon('maximize', 13), onclick: (e) => { e.stopPropagation(); this.focusNode(n.id); } }),
        h('button', { class: 'head-btn', title: 'Ещё', html: icon('more', 13), onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); this.nodeMenu(this.node(n.id), r.left, r.bottom + 4); } }),
        h('button', { class: 'head-btn close', title: 'Закрыть', html: icon('x', 13), onclick: (e) => { e.stopPropagation(); this.removeNodes([n.id]); } }),
      );
    } else {
      v.body = h('div', { class: 'node-body' });
      el.append(v.body);
    }
    this.nodesLayer.append(el);
    this.views.set(n.id, v);
    try { v.inst = def.mount({ node: n, view: this, v, body: v.body, el }); }
    catch (err) { console.error('mount failed', n.type, err); v.body.append(h('div', { class: 'muted', style: { padding: '12px' } }, `Ошибка: ${err.message}`)); }
    this.syncView(n);
    if (this.lod) v.inst?.onLod?.(true);
    return v;
  }

  destroyView(v) { try { v.inst?.destroy?.(); } catch (e) { console.error(e); } v.el.remove(); }

  syncView(n) {
    const v = this.views.get(n.id);
    if (!v) return;
    const s = v.el.style;
    if (!v.el.classList.contains('dragged')) { s.left = `${n.x}px`; s.top = `${n.y}px`; }
    s.width = `${n.w}px`; s.height = `${n.h}px`;
    s.zIndex = String((n.type === 'frame' ? 0 : 1000) + (n.z || 0));
    v.el.classList.toggle('selected', this.selection.has(n.id));
    v.el.classList.toggle('locked', !!n.locked);
    if (v.def.chrome === 'window') this.syncHead(n);
  }

  syncHead(n) {
    const v = this.views.get(n.id);
    if (!v || !v.head) return;
    const def = v.def;
    const title = def.title(n);
    const status = def.status ? def.status(n, v.inst) : null;
    if (v.title.textContent !== title) v.title.textContent = title;
    if (this.lod === false && v.culled && v.skey) return;
    const bkey = `${n.data.agentId || ''}|${n.data.provider || ''}|${n.data.kind || ''}`;
    if (v.bkey !== bkey) {
      v.bkey = bkey;
      v.badge.replaceChildren(def.badge(n, 14));
      v.card.querySelector('.card-badge').replaceChildren(def.badge(n, 22));
    }
    const skey = `${title}|${status ? status.label + status.kind : ''}`;
    if (v.skey === skey) return;
    v.skey = skey;
    v.card.querySelector('.card-title').textContent = title;
    const st = v.card.querySelector('.card-status');
    st.textContent = status ? status.label : '';
    st.className = `card-status ${status ? status.kind : ''}`;
    v.status.className = `head-status ${status ? status.kind : ''}`;
    v.status.title = status ? status.label : '';
  }

  refreshStatuses() { for (const n of this.doc.nodes) { const v = this.views.get(n.id); if (v && v.def.status) this.syncHead(n); } }

  // ---------------- mutations ----------------
  snapshot() { return JSON.stringify({ nodes: this.doc.nodes, edges: this.doc.edges }); }
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.redoStack = [];
  }
  restore(snap) {
    this.cancelDrag();
    const s = JSON.parse(snap);
    // undo is about the layout: conversations and sessions keep their current state
    const VOLATILE = ['messages', 'sessionId', 'convId', 'ctxHash', 'actualModel'];
    const cur = new Map(this.doc.nodes.map((n) => [n.id, n]));
    for (const n of s.nodes) {
      const c = cur.get(n.id);
      if (!c || !['chat', 'agentchat', 'terminal'].includes(n.type)) continue;
      for (const k of VOLATILE) { if (k in (c.data || {})) n.data[k] = c.data[k]; else delete n.data[k]; }
    }
    this.doc.nodes = s.nodes; this.doc.edges = s.edges;
    for (const id of [...this.selection]) if (!this.node(id)) this.selection.delete(id);
    this.renderAll();
    this.recomputeGroups();
    state.touch();
    this.emit('selection');
    this.emit('changed');
  }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); }

  changed() { if (!this.dragging) { this.recomputeGroups(); this.cullSoon(); } state.lastEdit = Date.now(); state.touch(); this.drawMinimap(); this.emit('changed'); }

  maxZ() { return this.doc.nodes.reduce((m, n) => Math.max(m, n.z || 0), 0); }

  addNode(type, opts = {}, { select = true, checkpoint = true, center = true } = {}) {
    const def = NODE_TYPES[type];
    if (!def) throw new Error('unknown node type ' + type);
    const size = def.defaultSize || { w: 300, h: 200 };
    const w = opts.w || size.w, hgt = opts.h || size.h;
    let x = opts.x, y = opts.y;
    if (x == null || y == null) { const c = this.centerWorld(); x = c.x; y = c.y; center = true; }
    if (center) { x -= w / 2; y -= hgt / 2; }
    const n = { id: uid(type.slice(0, 2)), type, x: Math.round(x), y: Math.round(y), w, h: hgt, z: type === 'frame' ? -this.doc.nodes.length : this.maxZ() + 1, data: { ...(def.defaultData ? def.defaultData() : {}), ...(opts.data || {}) } };
    if (checkpoint) this.checkpoint();
    this.doc.nodes.push(n);
    this.createView(n);
    if (type === 'frame') this.adoptInto(n); else this.recomputeGroups(new Set([n.id]));
    if (select) this.select([n.id]);
    this.changed();
    return n;
  }

  updateNode(id, patch, { checkpoint = false, silent = false } = {}) {
    const n = this.node(id);
    if (!n) return;
    if (checkpoint) this.checkpoint();
    const { data, ...rest } = patch;
    Object.assign(n, rest);
    if (data) n.data = { ...n.data, ...data };
    this.syncView(n);
    if (data && !silent) this.views.get(id)?.inst?.update?.(n);
    if ('x' in rest || 'y' in rest || 'w' in rest || 'h' in rest) { this.renderEdges(); this.updateOverlay(); }
    this.changed();
  }
  // data change originating from the node itself (no re-render)
  setData(id, data) { const n = this.node(id); if (!n) return; n.data = { ...n.data, ...data }; if (this.views.get(id)?.def.chrome === 'window') this.syncHead(n); this.changed(); }

  removeNodes(ids, { checkpoint = true } = {}) {
    ids = ids.filter((id) => { const n = this.node(id); return n && !n.locked; });
    if (!ids.length) return;
    if (checkpoint) this.checkpoint();
    const set = new Set(ids);
    for (const id of ids) { const v = this.views.get(id); if (v) { v.inst?.dispose?.(); this.destroyView(v); this.views.delete(id); } }
    this.doc.nodes = this.doc.nodes.filter((n) => !set.has(n.id));
    this.doc.edges = this.doc.edges.filter((e) => !set.has(e.from) && !set.has(e.to));
    for (const id of ids) this.selection.delete(id);
    if (this.dragging?.kind === 'connect' && set.has(this.dragging.from)) this.cancelDrag();
    this.renderEdges();
    this.updateOverlay();
    this.emit('selection');
    this.changed();
  }

  addEdge(from, to, extra = {}) {
    if (from === to) return;
    if (this.doc.edges.some((e) => e.from === from && e.to === to)) return;
    this.checkpoint();
    const e = { id: uid('e'), from, to, arrow: true, ...extra };
    this.doc.edges.push(e);
    this.renderEdges();
    this.changed();
    this.emit('edges');
    return e;
  }
  removeEdge(id) { this.checkpoint(); this.doc.edges = this.doc.edges.filter((e) => e.id !== id); if (this.selectedEdge === id) this.selectedEdge = null; this.renderEdges(); this.changed(); this.emit('edges'); }
  connected(id) { return this.doc.edges.filter((e) => e.from === id || e.to === id).map((e) => this.node(e.from === id ? e.to : e.from)).filter(Boolean); }
  incoming(id) { return this.doc.edges.filter((e) => e.to === id).map((e) => this.node(e.from)).filter(Boolean); }

  // ---------------- selection ----------------
  select(ids, add = false) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.selectedEdge = null;
    this.afterSelect();
  }
  toggleSelect(id) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); this.selectedEdge = null; this.afterSelect(); }
  clearSelection() { if (!this.selection.size && !this.selectedEdge) return; this.selection.clear(); this.selectedEdge = null; this.afterSelect(); }
  afterSelect() {
    if (this.grabId && (!this.selection.has(this.grabId) || this.selection.size > 1)) this.setGrab(null);
    for (const [id, v] of this.views) v.el.classList.toggle('selected', this.selection.has(id));
    this.renderEdges();
    this.updateOverlay();
    this.emit('selection');
  }
  // "grab" mode: after a double-click the whole object (window body, area interior)
  // works as a handle until it is deselected, Esc is pressed or it is double-clicked again
  setGrab(id) {
    if (this.grabId === id) return;
    if (this.grabId) this.views.get(this.grabId)?.el.classList.remove('grab');
    this.grabId = id || null;
    if (id) this.views.get(id)?.el.classList.add('grab');
  }
  selectedNodes() { return this.doc.nodes.filter((n) => this.selection.has(n.id)); }

  // ---------------- edges ----------------
  anchor(n, side) {
    switch (side) {
      case 'top': return { x: n.x + n.w / 2, y: n.y, dx: 0, dy: -1 };
      case 'bottom': return { x: n.x + n.w / 2, y: n.y + n.h, dx: 0, dy: 1 };
      case 'left': return { x: n.x, y: n.y + n.h / 2, dx: -1, dy: 0 };
      default: return { x: n.x + n.w, y: n.y + n.h / 2, dx: 1, dy: 0 };
    }
  }
  bestSides(a, b) {
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = bc.x - ac.x, dy = bc.y - ac.y;
    if (Math.abs(dx) * (a.h + b.h) > Math.abs(dy) * (a.w + b.w)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
    return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  }
  curve(p1, p2) {
    const d = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4);
    const c1 = { x: p1.x + p1.dx * d, y: p1.y + p1.dy * d };
    const c2 = { x: p2.x + (p2.dx || 0) * d, y: p2.y + (p2.dy || 0) * d };
    return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, mid: { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 } };
  }
  // cheap path update for edges touching moving nodes (no DOM rebuild)
  updateEdgesFor(ids) {
    if (!this._edgeEls) return this.renderEdges();
    for (const e of this.doc.edges) {
      if (!ids.has(e.from) && !ids.has(e.to)) continue;
      const el = this._edgeEls.get(e.id);
      const a = this.node(e.from), b = this.node(e.to);
      if (!el || !a || !b) continue;
      const [sa, sb] = [e.fromSide, e.toSide].every(Boolean) ? [e.fromSide, e.toSide] : this.bestSides(a, b);
      const { d, mid } = this.curve(this.anchor(a, sa), this.anchor(b, sb));
      el.hit.setAttribute('d', d); el.line.setAttribute('d', d);
      if (el.label) { el.label.setAttribute('x', mid.x); el.label.setAttribute('y', mid.y - 6); }
    }
  }

  renderEdges() {
    if (this.dragging?.kind !== 'connect') this.clearConnectPreview();
    const g = this.edgeGroup;
    g.innerHTML = '';
    this._edgeEls = new Map();
    for (const e of this.doc.edges) {
      const a = this.node(e.from), b = this.node(e.to);
      if (!a || !b) continue;
      const [sa, sb] = [e.fromSide, e.toSide].every(Boolean) ? [e.fromSide, e.toSide] : this.bestSides(a, b);
      const { d, mid } = this.curve(this.anchor(a, sa), this.anchor(b, sb));
      const sel = this.selectedEdge === e.id || (this.selection.has(e.from) && this.selection.has(e.to));
      const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      grp.setAttribute('class', `edge${sel ? ' selected' : ''}`);
      grp.dataset.id = e.id;
      grp.innerHTML = `<path class="edge-hit" d="${d}"/><path class="edge-line" d="${d}" style="${e.color ? `stroke:${e.color}` : ''}" ${e.arrow !== false ? 'marker-end="url(#arrow)"' : ''}/>`;
      if (e.label) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', mid.x); t.setAttribute('y', mid.y - 6); t.setAttribute('class', 'edge-label'); t.textContent = e.label;
        grp.append(t);
      }
      g.append(grp);
      this._edgeEls.set(e.id, { hit: grp.firstChild, line: grp.children[1], label: grp.querySelector('text') });
    }
  }

  // ---------------- overlay (selection box, handles, toolbar) ----------------
  updateOverlay(light = false) {
    this.comments?.position();
    const nodes = this.selectedNodes();
    const show = nodes.length > 0 && !this.dragging?.noOverlay;
    this.selBox.style.display = show ? 'block' : 'none';
    this.connDots.style.display = 'none';
    this.selToolbar.style.display = 'none';
    if (!show) return;
    const b = this.bounds(nodes);
    const p = this.toScreen(b.x, b.y);
    const w = b.w * this.vp.z, hh = b.h * this.vp.z;
    this.placeBox(this.selBox, p.x, p.y, w, hh);
    const single = nodes.length === 1 ? nodes[0] : null;
    this.selBox.classList.toggle('multi', !single);
    this.selBox.classList.toggle('window-sel', !!single && NODE_TYPES[single.type]?.chrome === 'window');
    this.selBox.classList.toggle('no-handles', !single || !!single.locked || this.lod && NODE_TYPES[single.type]?.chrome === 'window' && false);
    if (single && !single.locked && !this.dragging) {
      this.connDots.style.display = 'block';
      this.placeBox(this.connDots, p.x, p.y, w, hh);
    }
    if (!this.dragging && !light) this.renderSelToolbar(nodes, p, w);
  }

  // position via transform (composited), touch width/height only when they change
  placeBox(el, x, y, w, hh) {
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const k = `${Math.round(w * 10)}|${Math.round(hh * 10)}`;
    if (el._sz !== k) { el._sz = k; el.style.width = `${w}px`; el.style.height = `${hh}px`; }
  }

  renderSelToolbar(nodes, p, w) {
    const tb = this.selToolbar;
    tb.innerHTML = '';
    const btn = (ic, title, fn, cls = '') => h('button', { class: `st-btn ${cls}`, title, html: icon(ic, 15), onclick: (e) => { e.stopPropagation(); fn(e); } });
    const single = nodes.length === 1 ? nodes[0] : null;
    const def = single && NODE_TYPES[single.type];
    if (single && def.colors) {
      for (const c of def.colors) {
        const sw = h('button', { class: `swatch${single.data.color === c ? ' on' : ''}`, style: { background: c }, title: c, onclick: (e) => { e.stopPropagation(); this.updateNode(single.id, { data: { color: c } }, { checkpoint: true }); this.updateOverlay(); } });
        tb.append(sw);
      }
      tb.append(h('span', { class: 'st-sep' }));
    }
    if (single && single.type === 'shape') {
      for (const k of ['rect', 'ellipse', 'diamond']) tb.append(btn(k, k, () => { this.updateNode(single.id, { data: { kind: k } }, { checkpoint: true }); this.updateOverlay(); }, single.data.kind === k ? 'on' : ''));
      tb.append(h('span', { class: 'st-sep' }));
    }
    if (nodes.length && nodes.every((n) => n.type === 'text')) {
      tb.append(this.fontSizeControl(nodes), h('span', { class: 'st-sep' }));
    }
    if (nodes.length > 1) {
      tb.append(
        btn('alignL', 'По левому краю', () => this.align('left')), btn('alignCH', 'По центру', () => this.align('hcenter')), btn('alignR', 'По правому краю', () => this.align('right')),
        btn('alignT', 'По верху', () => this.align('top')), btn('alignCV', 'По середине', () => this.align('vcenter')), btn('alignB', 'По низу', () => this.align('bottom')),
      );
      if (nodes.length > 2) tb.append(btn('distH', 'Распределить по горизонтали', () => this.distribute('h')), btn('distV', 'Распределить по вертикали', () => this.distribute('v')));
      tb.append(btn('grid', 'Разложить сеткой', () => this.tidy()), h('span', { class: 'st-sep' }), btn('area', 'Сгруппировать в область (Ctrl+G)', () => this.groupIntoFrame()));
    }
    if (single && single.type !== 'frame') tb.append(btn('arrow', 'Соединить: потяните за точку на краю', () => { this.setTool('arrow'); toast('Нажмите на объект и протяните стрелку к другому'); }));
    tb.append(
      btn('bringFront', 'На передний план (])', () => this.zOrder('front')),
      btn('sendBack', 'На задний план ([)', () => this.zOrder('back')),
      btn(nodes.some((n) => n.locked) ? 'lock' : 'unlock', 'Закрепить / открепить (Ctrl+L)', () => this.toggleLock()),
      btn('copy', 'Дублировать (Ctrl+D)', () => this.duplicate()),
      btn('trash', 'Удалить (Del)', () => this.removeNodes([...this.selection]), 'danger'),
    );
    tb.style.display = 'flex';
    const tw = tb.offsetWidth;
    const r = this.rect();
    let left = clamp(p.x + w / 2 - tw / 2, 8, r.width - tw - 8);
    let top = p.y - 48;
    if (top < 8) top = Math.min(r.height - 50, p.y + 12);
    tb.style.left = `${left}px`; tb.style.top = `${top}px`;
  }

  // font size of text objects: a number field (type, wheel, arrows) with − / + and common sizes
  fontSizeControl(nodes) {
    const sizes = [...new Set(nodes.map((n) => n.data.size || 20))];
    const ids = nodes.map((n) => n.id);
    const apply = (v) => {
      const size = Math.round(Math.min(400, Math.max(6, Number(v) || 0)));
      if (!size) { input.value = sizes.length === 1 ? sizes[0] : ''; return; }
      if (nodes.every((n) => (n.data.size || 20) === size)) { input.value = size; return; }
      const keepFocus = document.activeElement === input;
      this.checkpoint();
      for (const id of ids) this.updateNode(id, { data: { size } });
      this.updateOverlay();
      // the toolbar was rebuilt: keep typing / arrowing in the new field
      if (keepFocus) { const i = this.selToolbar.querySelector('.st-fs-input'); if (i) { i.focus(); i.select(); } }
    };
    const cur = () => Number(input.value) || sizes[0] || 20;
    const step = (d) => {
      const list = FONT_SIZES;
      const c = cur();
      const next = d > 0 ? list.find((x) => x > c) ?? c + 8 : [...list].reverse().find((x) => x < c) ?? Math.max(6, c - 1);
      apply(next);
    };
    const input = h('input', { class: 'st-fs-input', type: 'text', inputmode: 'numeric', value: sizes.length === 1 ? String(sizes[0]) : '', placeholder: sizes.length > 1 ? '—' : '', title: 'Размер шрифта: введите число, ↑/↓ — на 1, Shift — на 10' });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); apply(input.value); input.blur(); }
      else if (e.key === 'Escape') { input.value = sizes.length === 1 ? sizes[0] : ''; input.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const d = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1); apply(cur() + d); }
    });
    input.addEventListener('change', () => apply(input.value));
    input.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); apply(cur() + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    const btn = (label, title, fn) => h('button', { class: 'st-btn st-fs-btn', title, onclick: (e) => { e.stopPropagation(); fn(e); } }, label);
    const pick = btn('', 'Готовые размеры', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu(FONT_SIZES.map((sz) => ({ label: String(sz), checked: sizes.length === 1 && sizes[0] === sz, onClick: () => apply(sz) })), r.left - 40, r.bottom + 6, { minWidth: 90 });
    });
    pick.innerHTML = icon('chevronDown', 13);
    return h('div', { class: 'st-fs', title: 'Размер шрифта' },
      btn('−', 'Меньше', () => step(-1)), input, btn('+', 'Больше', () => step(1)), pick);
  }

  // ---------------- arrange ----------------
  align(mode) {
    const nodes = this.selectedNodes().filter((n) => !n.locked);
    if (nodes.length < 2) return;
    this.checkpoint();
    const b = this.bounds(nodes);
    for (const n of nodes) {
      if (mode === 'left') n.x = b.x;
      if (mode === 'right') n.x = b.x + b.w - n.w;
      if (mode === 'hcenter') n.x = Math.round(b.x + b.w / 2 - n.w / 2);
      if (mode === 'top') n.y = b.y;
      if (mode === 'bottom') n.y = b.y + b.h - n.h;
      if (mode === 'vcenter') n.y = Math.round(b.y + b.h / 2 - n.h / 2);
      this.syncView(n);
    }
    this.renderEdges(); this.updateOverlay(); this.changed();
  }
  distribute(axis) {
    const nodes = this.selectedNodes().filter((n) => !n.locked);
    if (nodes.length < 3) return;
    this.checkpoint();
    const k = axis === 'h' ? 'x' : 'y', s = axis === 'h' ? 'w' : 'h';
    nodes.sort((a, b) => a[k] - b[k]);
    const total = nodes.reduce((t, n) => t + n[s], 0);
    const b = this.bounds(nodes);
    const gap = ((axis === 'h' ? b.w : b.h) - total) / (nodes.length - 1);
    let cur = nodes[0][k];
    for (const n of nodes) { n[k] = Math.round(cur); cur += n[s] + gap; this.syncView(n); }
    this.renderEdges(); this.updateOverlay(); this.changed();
  }
  tidy() {
    const nodes = this.selectedNodes().filter((n) => !n.locked);
    if (nodes.length < 2) return;
    this.checkpoint();
    const b = this.bounds(nodes);
    const cols = Math.ceil(Math.sqrt(nodes.length));
    const gap = 32;
    nodes.sort((a, b2) => a.y - b2.y || a.x - b2.x);
    let x = b.x, y = b.y, rowH = 0;
    nodes.forEach((n, i) => {
      if (i && i % cols === 0) { x = b.x; y += rowH + gap; rowH = 0; }
      n.x = x; n.y = y; x += n.w + gap; rowH = Math.max(rowH, n.h);
      this.syncView(n);
    });
    this.renderEdges(); this.updateOverlay(); this.changed();
  }
  zOrder(where) {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    this.checkpoint();
    const zs = this.doc.nodes.map((n) => n.z || 0);
    const max = Math.max(...zs), min = Math.min(...zs);
    nodes.forEach((n, i) => { n.z = where === 'front' ? max + 1 + i : min - nodes.length + i; this.syncView(n); });
    this.changed();
  }
  toggleLock() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    this.checkpoint();
    const lock = !nodes.every((n) => n.locked);
    nodes.forEach((n) => { n.locked = lock; this.syncView(n); });
    this.updateOverlay(); this.changed();
    toast(lock ? 'Закреплено' : 'Откреплено');
  }
  // Ctrl+G. If the selection already has an area, the other objects join it (the area grows to
  // hold them) instead of a new area appearing around everything; otherwise a new area is made.
  groupIntoFrame() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const pad = 40, head = 40;
    const selIds = new Set(nodes.map((n) => n.id));
    const isInside = (n, f) => { for (let p = n.parent, d = 0; p && d < 60; d++) { if (p === f.id) return true; p = this.node(p)?.parent; } return false; };
    // areas of the selection that are not inside another selected area
    const frames = nodes.filter((n) => n.type === 'frame' && !nodes.some((o) => o.type === 'frame' && o !== n && isInside(n, o)));
    if (!frames.length) {
      const b = this.bounds(nodes);
      const f = this.addNode('frame', { x: b.x - pad, y: b.y - pad - head, w: b.w + pad * 2, h: b.h + pad * 2 + head, data: { title: 'Область' } }, { center: false });
      this.select([f.id]);
      return;
    }
    const target = frames.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const joining = nodes.filter((n) => n !== target && !isInside(n, target));
    if (!joining.length) { this.select([target.id]); toast(`Всё выделенное уже в области «${target.data.title || 'Область'}»`); return; }
    this.checkpoint();
    // grow the area so everything that joins lies inside it (contents of joining areas come along)
    const b = this.bounds([...joining, ...joining.filter((n) => n.type === 'frame').flatMap((f) => this.descendants(f))]);
    const x1 = Math.min(target.x, b.x - pad), y1 = Math.min(target.y, b.y - pad - head);
    const x2 = Math.max(target.x + target.w, b.x + b.w + pad), y2 = Math.max(target.y + target.h, b.y + b.h + pad);
    target.x = Math.round(x1); target.y = Math.round(y1); target.w = Math.round(x2 - x1); target.h = Math.round(y2 - y1);
    this.syncView(target);
    for (const n of joining) n.parent = target.id;
    this.recomputeGroups(new Set(joining.map((n) => n.id)));
    // joined areas must be drawn above the area that now holds them
    for (const n of joining) if (n.type === 'frame' && (n.z || 0) <= (target.z || 0)) { n.z = (target.z || 0) + 1; this.syncView(n); }
    this.renderEdges();
    this.select([target.id]);
    this.changed();
    toast(`Добавлено в область «${target.data.title || 'Область'}»: ${joining.length}`);
  }

  // ---------------- clipboard ----------------
  copy(cut = false) {
    const nodes = this.withContents(this.selectedNodes());
    if (!nodes.length) return false;
    const ids = new Set(nodes.map((n) => n.id));
    const payload = { canvastty: 1, nodes: deepClone(nodes), edges: deepClone(this.doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to))) };
    this.clipboard = payload;
    try { navigator.clipboard.writeText(JSON.stringify(payload)); } catch {}
    if (cut) this.removeNodes([...ids]);
    return true;
  }
  pastePayload(payload, at) {
    if (!payload || !payload.nodes?.length) return;
    this.checkpoint();
    const b = this.bounds(payload.nodes);
    const target = at || (() => { const c = this.centerWorld(); return { x: c.x - b.w / 2, y: c.y - b.h / 2 }; })();
    const { newIds } = this.insertCopies(payload.nodes, payload.edges, target.x - b.x, target.y - b.y);
    this.select(newIds);
    this.changed();
  }
  // copies of nodes (+ the edges between them) shifted by dx/dy; returns old id -> new id
  insertCopies(srcNodes, edges = [], dx = 0, dy = 0) {
    const map = {};
    const z = this.maxZ();
    const newIds = [];
    for (const src of srcNodes) {
      const n = deepClone(src);
      map[src.id] = n.id = uid(n.type.slice(0, 2));
      n.x = Math.round(n.x + dx); n.y = Math.round(n.y + dy); n.z = z + 1 + newIds.length; n.locked = false;
      if (n.data) { delete n.data.sessionId; delete n.data.convId; if (n.type === 'chat') n.data.messages = [...(n.data.messages || [])]; }
      this.numberCopy(n);
      this.doc.nodes.push(n); this.createView(n); newIds.push(n.id);
    }
    for (const id of newIds) { const n = this.node(id); if (n.parent) { if (map[n.parent]) n.parent = map[n.parent]; else delete n.parent; } }
    this.recomputeGroups(new Set(newIds.filter((id) => !this.node(id).parent)));
    for (const e of edges || []) if (map[e.from] && map[e.to]) this.doc.edges.push({ ...deepClone(e), id: uid('e'), from: map[e.from], to: map[e.to] });
    this.renderEdges();
    this.forkNotes(newIds);
    return { map, newIds };
  }
  // Figma-style names for copies: «Фото 1» -> «Фото 2», «Фото 3»… (the next free number among
  // objects of the same kind on this canvas). Notes get the same treatment for their file name.
  numberCopy(n) {
    const field = NAMED_COPY[n.type];
    if (!field) return;
    const cur = field === 'name' ? (n.data.name || (n.data.vault || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '')) : n.data[field];
    if (!cur || !String(cur).trim()) return;
    const base = String(cur).replace(/\s+\d+$/, '').trim();
    if (!base) return;
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc}(?: (\\d+))?$`);
    let max = 1;
    for (const o of this.doc.nodes) {
      if (o.type !== n.type) continue;
      const v = field === 'name' ? (o.data.name || (o.data.vault || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '')) : o.data[field];
      const m = String(v || '').match(re);
      if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
    }
    n.data[field] = `${base} ${max + 1}`;
  }
  // a copied note gets its own .md file (same text), so the copy is a real duplicate and not a
  // second window onto the same file that edits along with the original
  async forkNotes(ids) {
    const notes = ids.map((id) => this.node(id)).filter((n) => n?.type === 'note' && n.data.path);
    if (!notes.length) return;
    try { await (await import('./editor.js')).flushEditors(); } catch {}
    for (const n of notes) {
      const src = n.data.path;
      const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
      try {
        const text = await native.vault.read(src);
        const stem = src.split('/').pop().replace(/\.md$/i, '');
        const p = native.vault.createNumbered ? await native.vault.createNumbered(dir, stem, text) : await native.vault.create(dir, stem, text);
        try { const { noteStyles } = await import('./notestyle.js'); const st = noteStyles.get(src); if (Object.keys(st).length) await noteStyles.set(p, st); } catch {}
        if (this.node(n.id)) this.updateNode(n.id, { data: { path: p } });
        else native.vault.remove?.(p); // the copy was undone meanwhile
      } catch {}
    }
    try { (await import('./vaultIndex.js')).vaultIndex.refresh(); } catch {}
  }
  duplicate() {
    const nodes = this.withContents(this.selectedNodes());
    if (!nodes.length) return;
    const ids = new Set(nodes.map((n) => n.id));
    const b = this.bounds(nodes);
    this.pastePayload({ nodes: deepClone(nodes), edges: deepClone(this.doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to))) }, { x: b.x + 32, y: b.y + 32 });
  }

  // ---------------- tools ----------------
  setTool(t) {
    this.tool = t;
    this.root.dataset.tool = t;
    this.emit('tool', t);
  }

  // ---------------- events ----------------
  bindEvents() {
    const r = this.root;
    r.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    r.addEventListener('dblclick', (e) => this.onDblClick(e));
    r.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    r.addEventListener('contextmenu', (e) => this.onContext(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', () => this.cancelDrag());
    window.addEventListener('blur', () => { if (this.dragging?.kind === 'connect') this.cancelDrag(); });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isEditable(document.activeElement) && !e.repeat) { this.spaceDown = true; r.classList.add('space-pan'); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this.spaceDown = false; r.classList.remove('space-pan'); } });
    window.addEventListener('blur', () => { this.spaceDown = false; r.classList.remove('space-pan'); });
    new ResizeObserver(() => { this._rect = null; this.updateOverlay(); this.drawMinimap(); this.sizeBg(); }).observe(r);
    window.addEventListener('resize', () => { this._rect = null; });
    // minimap navigation
    this.miniCanvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const go = (ev) => {
        const m = this.miniMeta; if (!m) return;
        const rc = this.miniCanvas.getBoundingClientRect();
        const wx = m.x + ((ev.clientX - rc.left) / rc.width) * m.w;
        const wy = m.y + ((ev.clientY - rc.top) / rc.height) * m.h;
        const rr = this.rect();
        this.vp.x = rr.width / 2 - wx * this.vp.z; this.vp.y = rr.height / 2 - wy * this.vp.z;
        this.requestViewport();
      };
      go(e);
      const mv = (ev) => go(ev);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    // drag & drop (notes from sidebar, images, md files)
    r.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; r.classList.add('drop-hover'); });
    r.addEventListener('dragleave', (e) => { if (e.target === r || !r.contains(e.relatedTarget)) r.classList.remove('drop-hover'); });
    r.addEventListener('drop', (e) => { r.classList.remove('drop-hover'); this.emit('drop', e); });
  }

  hitNode(target) {
    const el = target.closest?.('.node');
    if (!el || !this.root.contains(el)) return null;
    return this.node(el.dataset.id);
  }

  onPointerDown(e) {
    if (this.dragging) this.cancelDrag();
    if (e.target.closest('.nav-box') || e.target.closest('.sel-toolbar')) return;
    // a click inside text that is being edited moves the caret / selects words, it must not end editing
    if (e.button === 0 && e.target.closest('.node [contenteditable="true"]')) return;
    this.root.focus({ preventScroll: true });
    const pan = e.button === 1 || (e.button === 0 && (this.spaceDown || this.tool === 'hand'));
    if (pan) { e.preventDefault(); this.startPan(e); return; }
    if (e.button !== 0) return;

    // resize handles
    const handle = e.target.closest('.handle');
    if (handle) { e.stopPropagation(); this.startResize(e, handle.dataset.dir); return; }
    // connection dots
    const dot = e.target.closest('.conn-dot');
    if (dot) { e.stopPropagation(); e.preventDefault(); window.getSelection()?.removeAllRanges(); const n = this.selectedNodes()[0]; if (n) this.startConnect(e, n, dot.dataset.side); return; }

    // edges
    const edgeEl = e.target.closest('.edge');
    if (edgeEl && !this.hitNode(e.target)) {
      this.selection.clear(); this.selectedEdge = edgeEl.dataset.id; this.afterSelect();
      return;
    }

    const n = this.hitNode(e.target);
    const creating = ['sticky', 'text', 'rect', 'ellipse', 'diamond', 'frame'].includes(this.tool);

    if (this.tool === 'arrow') {
      if (n) { e.preventDefault(); this.startConnect(e, n, null); }
      return;
    }
    if (this.tool === 'comment') { e.preventDefault(); this.comments.startNew(e); return; }
    if (this.tool === 'text' && n?.type === 'text') { e.preventDefault(); this.setTool('select'); this.select([n.id]); this.editAt(n, e); return; }
    if (creating && (!n || n.type === 'frame')) { e.preventDefault(); this.startCreate(e); return; }

    if (n && n.id === this.grabId && !e.target.closest('.node-head button')) {
      if (e.shiftKey) { this.toggleSelect(n.id); e.preventDefault(); return; }
      if (!this.selection.has(n.id)) this.select([n.id]);
      e.preventDefault();
      if (!n.locked) this.startMove(e);
      return;
    }
    if (n) {
      const v = this.views.get(n.id);
      const inHead = !!e.target.closest('.node-head');
      const inBtn = !!e.target.closest('button, input, select, textarea, a, .no-drag');
      const isWindow = v.def.chrome === 'window';
      const editing = e.target.closest('[contenteditable="true"]');
      if (n.type === 'frame' && !e.target.closest('.frame-title')) {
        // empty frame area behaves like the canvas (marquee)
        if (!e.shiftKey) this.clearSelection();
        this.startMarquee(e);
        return;
      }
      const grp = !e.ctrlKey && !e.metaKey && !inBtn && !editing && (inHead || !isWindow || this.lod) ? this.groupRoot(n) : null;
      if (grp) {
        e.preventDefault();
        if (e.shiftKey) { this.toggleSelect(grp.id); return; }
        if (!this.selection.has(grp.id)) this.select([grp.id]);
        if (!grp.locked) this.startMove(e);
        return;
      }
      if (e.shiftKey && (inHead || !isWindow || this.lod)) { this.toggleSelect(n.id); e.preventDefault(); return; }
      const wasOnlySelected = this.selection.size === 1 && this.selection.has(n.id);
      if (!this.selection.has(n.id)) this.select([n.id]);
      if (inBtn && !this.lod) return;
      if (editing) return;
      if (isWindow && !inHead && !this.lod) { this.bringToFront(n); return; } // let content handle it
      if (n.locked) return;
      e.preventDefault();
      // like Figma / Miro: clicking text that is already selected (without dragging) edits it
      this.startMove(e, wasOnlySelected && TEXT_EDIT_TYPES.has(n.type) && !this.grabId ? n : null);
      return;
    }
    // background
    if (!e.shiftKey) this.clearSelection();
    if (document.activeElement && isEditable(document.activeElement)) document.activeElement.blur();
    this.startMarquee(e);
  }

  justMoved() { return performance.now() - (this.lastMoveEnd || 0) < 300; }

  bringToFront(n) {
    const max = this.maxZ();
    if ((n.z || 0) < max) { n.z = max + 1; this.syncView(n); state.touch(); }
  }

  startPan(e) {
    const sx = e.clientX, sy = e.clientY, ox = this.vp.x, oy = this.vp.y;
    this.root.classList.add('panning');
    this.dragging = { kind: 'pan', move: (ev) => { this.vp.x = ox + ev.clientX - sx; this.vp.y = oy + ev.clientY - sy; this.requestViewport(); }, up: () => this.root.classList.remove('panning') };
  }

  startMarquee(e) {
    const r = this.rect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const base = new Set(e.shiftKey ? this.selection : []);
    let moved = false;
    this.dragging = {
      kind: 'marquee',
      move: (ev) => {
        const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
        if (!moved && Math.hypot(cx - sx, cy - sy) < 3) return;
        moved = true;
        const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), hh = Math.abs(cy - sy);
        this.marquee.style.display = 'block';
        this.placeBox(this.marquee, x, y, w, hh);
        const a = this.toWorld(x + r.left, y + r.top), b = this.toWorld(x + w + r.left, y + hh + r.top);
        const sel = new Set(base);
        for (const n of this.doc.nodes) {
          const hit = n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + n.h > a.y;
          // frames only when fully enclosed
          const enclosed = n.x >= a.x && n.y >= a.y && n.x + n.w <= b.x && n.y + n.h <= b.y;
          if (n.type === 'frame' ? enclosed : hit) sel.add(n.id);
        }
        const prev = this.selection;
        this.selection = sel;
        for (const id of prev) if (!sel.has(id)) this.views.get(id)?.el.classList.remove('selected');
        for (const id of sel) if (!prev.has(id)) this.views.get(id)?.el.classList.add('selected');
      },
      up: () => { this.marquee.style.display = 'none'; this.afterSelect(); },
    };
  }

  editAt(n, e) { requestAnimationFrame(() => this.views.get(n.id)?.inst?.edit?.(e)); }

  startMove(e, editOnClick = null) {
    const start = this.toWorld(e.clientX, e.clientY);
    let nodes, all, ids, orig, b0, others, movingFrames, views;
    // areas carry everything that belongs to them (nested areas included)
    const setup = (sel) => {
      nodes = sel;
      ids = new Set(nodes.map((n) => n.id));
      const extra = [];
      for (const f of nodes.filter((n) => n.type === 'frame')) {
        for (const n of this.descendants(f)) if (!ids.has(n.id) && !n.locked) { ids.add(n.id); extra.push(n); }
      }
      all = [...nodes, ...extra];
      orig = new Map(all.map((n) => [n.id, { x: n.x, y: n.y }]));
      b0 = this.bounds(nodes);
      others = this.snapTargets(ids);
      movingFrames = new Set(all.filter((n) => n.type === 'frame').map((n) => n.id));
      // during the drag nodes are moved by a composited transform; left/top are written once at the end
      views = all.map((n) => this.views.get(n.id)).filter(Boolean);
    };
    setup(this.selectedNodes().filter((n) => !n.locked));
    let moved = false, checkpointed = false, duplicated = false, fresh = false, lastDx = 0, lastDy = 0, dropFrame = null;
    const setDrop = (f) => {
      if (dropFrame === f) return;
      if (dropFrame) this.views.get(dropFrame.id)?.el.classList.remove('drop-target');
      dropFrame = f;
      if (f) this.views.get(f.id)?.el.classList.add('drop-target');
    };
    // Alt + drag (like Figma): the originals stay where they were, copies follow the cursor
    const duplicateNow = () => {
      duplicated = true;
      for (const v of views) { v.el.classList.remove('dragged'); v.el.style.transform = ''; }
      for (const n of all) { const o = orig.get(n.id); n.x = o.x; n.y = o.y; }
      const edges = this.doc.edges.filter((ed) => ids.has(ed.from) && ids.has(ed.to));
      const { map } = this.insertCopies(all, edges, 0, 0);
      this.updateEdgesFor(ids);
      const copies = nodes.map((n) => this.node(map[n.id])).filter(Boolean);
      setup(copies);
      this.select(copies.map((n) => n.id));
      for (const v of views) v.el.classList.add('dragged');
      fresh = true;
    };
    this.dragging = {
      kind: 'move',
      move: (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        let dx = p.x - start.x, dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) * this.vp.z < 3) return;
        if (!checkpointed) {
          this.checkpoint(); checkpointed = true;
          this.root.classList.add('moving');
          for (const v of views) v.el.classList.add('dragged');
        }
        moved = true;
        if (!duplicated && (ev.altKey || e.altKey) && nodes.length) duplicateNow();
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const free = ev.ctrlKey || ev.metaKey;
        const snapped = free ? { dx, dy, gx: [], gy: [] } : this.snapMove(b0, dx, dy, others);
        dx = Math.round(snapped.dx); dy = Math.round(snapped.dy);
        this.drawGuides(snapped.gx, snapped.gy);
        if (dx === lastDx && dy === lastDy && !fresh) return;
        fresh = false; lastDx = dx; lastDy = dy;
        const tf = `translate3d(${dx}px, ${dy}px, 0)`;
        for (const v of views) v.el.style.transform = tf;
        for (const n of all) { const o = orig.get(n.id); n.x = o.x + dx; n.y = o.y + dy; }
        this.updateEdgesFor(ids);
        this.updateOverlay();
        // highlight the area the objects will land in
        if (!nodes.every((n) => n.type === 'frame')) {
          const c = { x: b0.x + dx + b0.w / 2, y: b0.y + dy + b0.h / 2 };
          setDrop(this.frameAt(c.x, c.y, movingFrames));
        }
      },
      up: (ev) => {
        this.drawGuides([], []);
        this.root.classList.remove('moving');
        setDrop(null);
        for (const v of views) { v.el.classList.remove('dragged'); v.el.style.transform = ''; }
        for (const n of all) this.syncView(n);
        if (moved) {
          this.lastMoveEnd = performance.now();
          this.recomputeGroups(new Set(nodes.map((n) => n.id)));
          this.renderEdges();
          this.updateOverlay(); this.changed();
          this.emit('moveEnd', { nodes, clientX: ev.clientX, clientY: ev.clientY });
        } else if (editOnClick) this.editAt(editOnClick, { clientX: ev.clientX, clientY: ev.clientY });
      },
    };
  }

  // ---------------- areas as groups ----------------
  // An object belongs to the innermost area that contains its centre. Membership is stored in
  // node.parent and recomputed whenever something comes to rest, so moving an area always
  // carries its contents, even if they stick out of it a little.
  frameAt(x, y, exclude = new Set()) {
    let best = null, ba = Infinity;
    for (const f of this.doc.nodes) {
      if (f.type !== 'frame' || exclude.has(f.id)) continue;
      if (x < f.x || y < f.y || x > f.x + f.w || y > f.y + f.h) continue;
      const a = f.w * f.h;
      if (a < ba) { ba = a; best = f; }
    }
    return best;
  }
  withContents(nodes) {
    const ids = new Set(nodes.map((n) => n.id)); const out = [...nodes];
    for (const f of nodes) if (f.type === 'frame') for (const n of this.descendants(f)) if (!ids.has(n.id)) { ids.add(n.id); out.push(n); }
    return out;
  }
  children(f) { return this.doc.nodes.filter((n) => n.parent === f.id); }
  descendants(f, out = [], seen = new Set([f.id])) {
    for (const n of this.doc.nodes) {
      if (n.parent !== f.id || seen.has(n.id)) continue;
      seen.add(n.id); out.push(n);
      if (n.type === 'frame') this.descendants(n, out, seen);
    }
    return out;
  }
  groupRoot(n) {
    let root = null, cur = n, guard = 0;
    while (cur && cur.parent && guard++ < 50) { cur = this.node(cur.parent); if (cur?.data?.grouped) root = cur; }
    return root;
  }
  // fresh: ids (or 'all') whose area is chosen anew; everything else keeps its area while its
  // centre is still inside it, so overlapping areas don't steal each other's objects
  recomputeGroups(fresh = null) {
    const nodes = this.doc.nodes;
    const frames = nodes.filter((n) => n.type === 'frame');
    const byId = new Map(frames.map((f) => [f.id, f]));
    const inside = (n, f) => { const cx = n.x + n.w / 2, cy = n.y + n.h / 2; return cx >= f.x && cy >= f.y && cx <= f.x + f.w && cy <= f.y + f.h; };
    const fits = (n, f) => f.id !== n.id && inside(n, f) && (n.type !== 'frame' || f.w * f.h > n.w * n.h);
    for (const n of nodes) {
      const cur = n.parent && byId.get(n.parent);
      const isFresh = fresh === 'all' || (fresh && fresh.has(n.id));
      if (!isFresh && (cur ? fits(n, cur) : !n.parent)) continue; // loose objects stay loose until moved
      let best = null, ba = Infinity;
      for (const f of frames) {
        if (!fits(n, f)) continue;
        const a = f.w * f.h;
        if (a < ba - 1 || (Math.abs(a - ba) <= 1 && (f.z || 0) > (best.z || 0))) { ba = a; best = f; }
      }
      if (best) n.parent = best.id; else delete n.parent;
    }
    // break accidental cycles between areas
    for (const f of frames) { let c = f, d = 0; while (c && c.parent && d < 60) { c = byId.get(c.parent); d++; if (c === f) { delete f.parent; break; } } }
    // nested areas are drawn above their parents
    const depth = (f) => { let d = 0, c = f; while (c.parent && d < 50) { c = this.node(c.parent); if (!c) break; d++; } return d; };
    const order = frames.map((f) => [f, depth(f)]).sort((a, b) => a[1] - b[1] || (a[0].z || 0) - (b[0].z || 0));
    order.forEach(([f], i) => { const z = -order.length + i; if (f.z !== z) { f.z = z; this.syncView(f); } });
    for (const f of frames) this.views.get(f.id)?.inst?.setCount?.(this.descendants(f).length, !!f.data.grouped);
  }
  adoptInto(f) {
    const ids = new Set(this.doc.nodes.filter((n) => n.id !== f.id && n.x + n.w / 2 >= f.x && n.y + n.h / 2 >= f.y && n.x + n.w / 2 <= f.x + f.w && n.y + n.h / 2 <= f.y + f.h).map((n) => n.id));
    ids.add(f.id);
    this.recomputeGroups(ids);
  }
  selectContents(f) { const d = this.descendants(f).map((n) => n.id); if (d.length) this.select(d); else toast('В области пока ничего нет'); }
  toggleGrouped(f) {
    this.updateNode(f.id, { data: { grouped: !f.data.grouped } }, { checkpoint: true });
    this.recomputeGroups();
    toast(f.data.grouped ? 'Область и её содержимое двигаются как одно целое. Ctrl + клик — выбрать объект внутри' : 'Объекты внутри области снова выбираются по отдельности');
  }
  ungroupFrame(f) {
    const kids = this.children(f).map((n) => n.id);
    this.removeNodes([f.id]);
    if (kids.length) this.select(kids.filter((id) => this.node(id)));
  }
  removeFrameWithContents(f) { this.removeNodes([f.id, ...this.descendants(f).map((n) => n.id)]); }

  snapTargets(exclude) {
    const r = this.rect();
    const a = this.toWorld(r.left, r.top), b = this.toWorld(r.right, r.bottom);
    const xs = [], ys = [];
    for (const n of this.doc.nodes) {
      if (exclude.has(n.id)) continue;
      if (n.x > b.x || n.x + n.w < a.x || n.y > b.y || n.y + n.h < a.y) continue;
      xs.push(n.x, n.x + n.w / 2, n.x + n.w);
      ys.push(n.y, n.y + n.h / 2, n.y + n.h);
    }
    return { xs, ys };
  }

  snapMove(b0, dx, dy, t) {
    const th = SNAP_PX / this.vp.z;
    const best = (vals, targets) => {
      let bd = th + 1, off = 0, line = null;
      for (const v of vals) for (const tv of targets) { const d = tv - v; if (Math.abs(d) < Math.abs(bd)) { bd = d; off = d; line = tv; } }
      return Math.abs(bd) <= th ? { off, line } : null;
    };
    const nx = b0.x + dx, ny = b0.y + dy;
    const sx = best([nx, nx + b0.w / 2, nx + b0.w], t.xs);
    const sy = best([ny, ny + b0.h / 2, ny + b0.h], t.ys);
    let gx = [], gy = [];
    if (sx) { dx += sx.off; gx = [sx.line]; }
    else if (state.settings.snap) { dx = Math.round((b0.x + dx) / 8) * 8 - b0.x; }
    if (sy) { dy += sy.off; gy = [sy.line]; }
    else if (state.settings.snap) { dy = Math.round((b0.y + dy) / 8) * 8 - b0.y; }
    return { dx, dy, gx, gy };
  }

  drawGuides(xs, ys) {
    const r = this.rect();
    let s = '';
    for (const x of xs) { const p = this.toScreen(x, 0); s += `<line x1="${p.x}" y1="0" x2="${p.x}" y2="${r.height}"/>`; }
    for (const y of ys) { const p = this.toScreen(0, y); s += `<line x1="0" y1="${p.y}" x2="${r.width}" y2="${p.y}"/>`; }
    if (this._guides !== s) { this._guides = s; this.guideSvg.innerHTML = s; }
  }

  startResize(e, dir) {
    const n = this.selectedNodes()[0];
    if (!n || n.locked) return;
    const def = NODE_TYPES[n.type];
    const minW = def.minSize?.w || 60, minH = def.minSize?.h || 40;
    const o = { x: n.x, y: n.y, w: n.w, h: n.h };
    const start = this.toWorld(e.clientX, e.clientY);
    const ratio = o.w / o.h;
    this.checkpoint();
    this.dragging = {
      kind: 'resize', noOverlay: false,
      move: (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        let dx = p.x - start.x, dy = p.y - start.y;
        let { x, y, w, h: hh } = o;
        if (dir.includes('e')) w = o.w + dx;
        if (dir.includes('s')) hh = o.h + dy;
        if (dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
        if (dir.includes('n')) { hh = o.h - dy; y = o.y + dy; }
        if (ev.shiftKey || def.keepRatio) {
          if (dir.length === 2) { if (w / hh > ratio) w = hh * ratio; else hh = w / ratio; if (dir.includes('w')) x = o.x + o.w - w; if (dir.includes('n')) y = o.y + o.h - hh; }
        }
        if (state.settings.snap && !ev.altKey) {
          const sn = (v) => Math.round(v / 8) * 8;
          if (dir.includes('e')) w = sn(x + w) - x;
          if (dir.includes('s')) hh = sn(y + hh) - y;
          if (dir.includes('w')) { const nx = sn(x); w += x - nx; x = nx; }
          if (dir.includes('n')) { const ny = sn(y); hh += y - ny; y = ny; }
        }
        if (w < minW) { if (dir.includes('w')) x -= minW - w; w = minW; }
        if (hh < minH) { if (dir.includes('n')) y -= minH - hh; hh = minH; }
        Object.assign(n, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) });
        this.syncView(n);
        this.views.get(n.id)?.inst?.onResize?.(n);
        this.renderEdges();
        this.updateOverlay();
        const sp = this.toScreen(n.x + n.w, n.y + n.h);
        Object.assign(this.sizeLabel.style, { display: 'block', left: `${sp.x + 8}px`, top: `${sp.y + 8}px` });
        this.sizeLabel.textContent = `${n.w} × ${n.h}`;
      },
      up: () => { this.sizeLabel.style.display = 'none'; this.views.get(n.id)?.inst?.onResize?.(n); if (n.type === 'frame') this.adoptInto(n); else this.recomputeGroups(new Set([n.id])); this.changed(); },
    };
  }

  startCreate(e) {
    const tool = this.tool;
    const r = this.rect();
    const s = this.toWorld(e.clientX, e.clientY);
    let moved = false;
    this.dragging = {
      kind: 'create',
      cancel: () => { this.ghost.style.display = 'none'; },
      move: (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        if (!moved && Math.hypot(p.x - s.x, p.y - s.y) * this.vp.z < 5) return;
        moved = true;
        const a = this.toScreen(Math.min(s.x, p.x), Math.min(s.y, p.y));
        Object.assign(this.ghost.style, { display: 'block', left: `${a.x}px`, top: `${a.y}px`, width: `${Math.abs(p.x - s.x) * this.vp.z}px`, height: `${Math.abs(p.y - s.y) * this.vp.z}px`, borderRadius: tool === 'ellipse' ? '50%' : '6px' });
      },
      up: (ev) => {
        this.ghost.style.display = 'none';
        const p = this.toWorld(ev.clientX, ev.clientY);
        const type = ['rect', 'ellipse', 'diamond'].includes(tool) ? 'shape' : tool;
        const data = type === 'shape' ? { kind: tool } : {};
        let n;
        if (moved && Math.abs(p.x - s.x) > 20 && Math.abs(p.y - s.y) > 20) {
          n = this.addNode(type, { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y), data }, { center: false });
        } else n = this.addNode(type, { x: s.x, y: s.y, data });
        if (!ev.shiftKey) this.setTool('select');
        if (['sticky', 'text', 'shape'].includes(type)) this.views.get(n.id)?.inst?.edit?.();
      },
    };
  }

  startConnect(e, from, side) {
    const fromNode = from;
    // keep receiving pointerup even if the button is released outside the window
    try { this.root.setPointerCapture(e.pointerId); } catch {}
    this.dragging = {
      kind: 'connect',
      from: fromNode.id,
      cancel: () => this.clearConnectPreview(),
      move: (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        const target = this.hitNode(document.elementFromPoint(ev.clientX, ev.clientY) || document.body);
        const a = side ? this.anchor(fromNode, side) : this.anchor(fromNode, this.bestSides(fromNode, { x: p.x, y: p.y, w: 1, h: 1 })[0]);
        let b = { x: p.x, y: p.y, dx: 0, dy: 0 };
        if (target && target.id !== fromNode.id) { const [, sb] = this.bestSides(fromNode, target); b = this.anchor(target, sb); }
        this._previewOn = true;
        this.edgePreview.setAttribute('d', this.curve(a, b).d);
        for (const v of this.views.values()) v.el.classList.toggle('connect-target', !!target && v.id === target.id && target.id !== fromNode.id);
      },
      up: (ev) => {
        this.clearConnectPreview();
        if (!this.node(fromNode.id)) return; // the source was deleted meanwhile
        const target = this.hitNode(document.elementFromPoint(ev.clientX, ev.clientY) || document.body);
        if (target && target.id !== fromNode.id) { this.addEdge(fromNode.id, target.id); if (this.tool === 'arrow' && !ev.shiftKey) this.setTool('select'); return; }
        const p = this.toWorld(ev.clientX, ev.clientY);
        if (Math.hypot(p.x - (fromNode.x + fromNode.w / 2), p.y - (fromNode.y + fromNode.h / 2)) < Math.max(fromNode.w, fromNode.h) / 2) return;
        // dropped on empty canvas → quick create connected node
        this.emit('connectToEmpty', { from: fromNode, world: p, clientX: ev.clientX, clientY: ev.clientY });
      },
    };
  }

  clearConnectPreview() {
    if (!this._previewOn) return;
    this._previewOn = false;
    this.edgePreview.setAttribute('d', '');
    for (const v of this.views.values()) v.el.classList.remove('connect-target');
  }
  // abandon whatever drag is in progress (lost pointerup, window lost focus, Esc, a new click…)
  cancelDrag() {
    const d = this.dragging;
    if (!d) return;
    this.dragging = null;
    this._pendingMove = null;
    if (this._moveRaf) { cancelAnimationFrame(this._moveRaf); this._moveRaf = 0; }
    if (d.cancel) d.cancel();
    else if (d.up) { try { d.up({ clientX: this.lastPointer?.x ?? 0, clientY: this.lastPointer?.y ?? 0, shiftKey: false, altKey: false }); } catch {} }
    this.clearConnectPreview();
    this.updateOverlay();
  }

  onPointerMove(e) {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (!this.dragging) return;
    this._pendingMove = e;
    if (!this._moveRaf) this._moveRaf = requestAnimationFrame(() => this.flushMove());
  }
  flushMove() {
    if (this._moveRaf) { cancelAnimationFrame(this._moveRaf); this._moveRaf = 0; }
    const e = this._pendingMove; this._pendingMove = null;
    if (e && this.dragging) this.dragging.move(e);
  }
  onPointerUp(e) {
    this.flushMove();
    const d = this.dragging;
    this.dragging = null;
    if (d) { d.up && d.up(e); this.updateOverlay(); }
  }

  onDblClick(e) {
    if (e.target.closest('.node [contenteditable="true"]')) return; // word selection inside text being edited
    const n = this.hitNode(e.target);
    if (!n) {
      if (e.target.closest('.nav-box,.sel-toolbar,.edge')) {
        const edgeEl = e.target.closest('.edge');
        if (edgeEl) this.emit('editEdge', edgeEl.dataset.id);
        return;
      }
      return; // a double-click on empty canvas does nothing (stickies: S or the toolbar)
    }
    if (this.lod && NODE_TYPES[n.type].chrome === 'window') { this.focusNode(n.id); return; }
    const v = this.views.get(n.id);
    if (this.tool === 'select') {
      // second double-click on a grabbed object returns control to its content
      if (this.grabId === n.id) { this.setGrab(null); if (v.def.chrome !== 'window') v.inst?.edit?.(e); return; }
      const inHead = !!e.target.closest('.node-head');
      const typing = e.target.closest('input, textarea, select, button, [contenteditable="true"]');
      const grabbable = (v.def.chrome === 'window' && !inHead && !typing) || (n.type === 'frame' && !e.target.closest('.frame-title'));
      if (grabbable) {
        window.getSelection()?.removeAllRanges();
        if (document.activeElement && isEditable(document.activeElement)) document.activeElement.blur();
        this.root.focus({ preventScroll: true });
        this.select([n.id]);
        this.setGrab(n.id);
        if (!this.grabHinted) { this.grabHinted = true; toast('Объект можно перетаскивать за любое место. Двойной клик или Esc — снова работать с содержимым'); }
        return;
      }
    }
    if (e.target.closest('.node-head .head-title') && v.def.rename) { v.def.rename(n, this); return; }
    v.inst?.edit?.(e);
  }

  onWheel(e) {
    if (e.target.closest('.nav-box')) return;
    const n = this.hitNode(e.target);
    const inWindowBody = n && !this.lod && NODE_TYPES[n.type]?.chrome === 'window' && e.target.closest('.node-body');
    const sc = n && !this.lod && e.target.closest('.scrollable');
    const inScrollable = sc && sc.scrollHeight > sc.clientHeight + 2;
    if ((inWindowBody || inScrollable) && !e.ctrlKey && !e.metaKey) return; // let the content scroll
    e.preventDefault();
    const zoomMode = e.ctrlKey || e.metaKey || (state.settings.wheel === 'zoom' && !e.shiftKey && !e.deltaX);
    if (zoomMode) {
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(e.clientX, e.clientY, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.vp.x -= dx; this.vp.y -= dy;
      this.requestViewport();
    }
  }

  onContext(e) {
    if (e.target.closest('.xterm') && !this.lod) return; // terminal has own selection/paste
    if (e.target.closest('[contenteditable="true"]')) return;
    e.preventDefault();
    const edgeEl = e.target.closest('.edge');
    if (edgeEl && !this.hitNode(e.target)) { this.edgeMenu(edgeEl.dataset.id, e.clientX, e.clientY); return; }
    const n = this.hitNode(e.target);
    if (n) { if (!this.selection.has(n.id)) this.select([n.id]); this.nodeMenu(n, e.clientX, e.clientY); return; }
    this.emit('bgMenu', { x: e.clientX, y: e.clientY, world: this.toWorld(e.clientX, e.clientY) });
  }

  edgeMenu(id, x, y) {
    const e = this.doc.edges.find((q) => q.id === id);
    if (!e) return;
    this.selection.clear(); this.selectedEdge = id; this.afterSelect();
    const colors = [['По умолчанию', null], ['Синий', '#7c8cff'], ['Зелёный', '#4fd1a5'], ['Оранжевый', '#f6a04d'], ['Розовый', '#e86a92']];
    menu([
      { label: 'Подпись…', icon: 'text', onClick: () => this.emit('editEdge', id) },
      { label: e.arrow !== false ? 'Убрать стрелку' : 'Добавить стрелку', icon: 'arrow', onClick: () => { this.checkpoint(); e.arrow = e.arrow === false; this.renderEdges(); this.changed(); } },
      { label: 'Развернуть направление', icon: 'refresh', onClick: () => { this.checkpoint(); [e.from, e.to] = [e.to, e.from]; this.renderEdges(); this.changed(); this.emit('edges'); } },
      { label: 'Цвет', icon: 'palette', children: colors.map(([l, c]) => ({ label: l, checked: (e.color || null) === c, onClick: () => { this.checkpoint(); e.color = c; this.renderEdges(); this.changed(); } })) },
      '-',
      { label: 'Удалить связь', icon: 'trash', danger: true, onClick: () => this.removeEdge(id) },
    ], x, y);
  }

  nodeMenu(n, x, y) {
    const def = NODE_TYPES[n.type];
    const custom = def.menu ? def.menu(n, this, this.views.get(n.id)?.inst) : [];
    const multi = this.selection.size > 1;
    menu([
      ...custom, custom.length ? '-' : null,
      { label: 'Приблизить', icon: 'maximize', onClick: () => multi ? this.fit([...this.selection]) : this.focusNode(n.id) },
      { label: 'Дублировать', icon: 'copy', kbd: 'Ctrl+D', onClick: () => this.duplicate() },
      { label: 'Копировать', icon: 'squares', kbd: 'Ctrl+C', onClick: () => this.copy() },
      { label: 'В область', icon: 'area', kbd: 'Ctrl+G', onClick: () => this.groupIntoFrame() },
      '-',
      { label: 'На передний план', icon: 'bringFront', kbd: ']', onClick: () => this.zOrder('front') },
      { label: 'На задний план', icon: 'sendBack', kbd: '[', onClick: () => this.zOrder('back') },
      { label: n.locked ? 'Открепить' : 'Закрепить', icon: n.locked ? 'unlock' : 'lock', kbd: 'Ctrl+L', onClick: () => this.toggleLock() },
      '-',
      { label: 'Удалить', icon: 'trash', kbd: 'Del', danger: true, onClick: () => this.removeNodes([...this.selection]) },
    ], x, y, { minWidth: 220 });
  }

  // ---------------- keyboard ----------------
  handleKey(e) {
    if (isEditable(document.activeElement)) return false;
    const mod = e.ctrlKey || e.metaKey;
    const k = keyName(e);
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return true; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return true; }
    if (mod && k === 'a') { e.preventDefault(); this.select(this.doc.nodes.map((n) => n.id)); return true; }
    if (mod && k === 'c') { if (this.copy()) { e.preventDefault(); return true; } return false; }
    if (mod && k === 'x') { if (this.copy(true)) { e.preventDefault(); return true; } return false; }
    if (mod && k === 'd') { e.preventDefault(); this.duplicate(); return true; }
    if (mod && k === 'g') { e.preventDefault(); this.groupIntoFrame(); return true; }
    if (mod && k === 'l') { e.preventDefault(); this.toggleLock(); return true; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.zoomBy(1.25); return true; }
    if (mod && k === '-') { e.preventDefault(); this.zoomBy(0.8); return true; }
    if (mod && k === '0') { e.preventDefault(); this.zoomTo(1); return true; }
    if (mod) return false;
    if (e.shiftKey && e.code === 'Digit1') { this.fit(); return true; }
    if (e.shiftKey && e.code === 'Digit2') { if (this.selection.size) this.fit([...this.selection]); return true; }
    if (e.shiftKey && e.code === 'Digit0') { this.zoomTo(1); return true; }
    if (k === 'delete' || k === 'backspace') {
      if (this.selectedEdge) { this.removeEdge(this.selectedEdge); return true; }
      if (this.selection.size) { this.removeNodes([...this.selection]); return true; }
    }
    if (k === 'escape') { if (this.comments?.thread) { this.comments.close(); return true; } if (this.dragging) { this.cancelDrag(); return true; } if (this.grabId) { this.setGrab(null); return true; } this.clearSelection(); this.setTool('select'); return true; }
    if (k.startsWith('arrow') && this.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
      const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
      if (!this.nudging) { this.checkpoint(); this.nudging = true; }
      clearTimeout(this.nudgeT); this.nudgeT = setTimeout(() => { this.nudging = false; }, 600);
      for (const n of this.withContents(this.selectedNodes())) if (!n.locked) { n.x += dx; n.y += dy; this.syncView(n); }
      this.renderEdges(); this.updateOverlay(); this.changed();
      return true;
    }
    if (k === ']') { this.zOrder('front'); return true; }
    if (k === '[') { this.zOrder('back'); return true; }
    if (k === 'enter' && this.selection.size === 1) { const n = this.selectedNodes()[0]; e.preventDefault(); this.views.get(n.id)?.inst?.edit?.(); return true; }
    if (k === 'm' && !e.altKey) { this.toggleMinimap(); return true; }
    if (k === 'g' && !e.altKey) { this.emit('addGallery'); return true; }
    if (k === 'c' && e.shiftKey && !e.altKey) { this.comments.toggleVisible(); return true; }
    const tools = { v: 'select', h: 'hand', s: 'sticky', t: 'text', r: 'rect', o: 'ellipse', f: 'frame', a: 'arrow', l: 'arrow', c: 'comment' };
    if (tools[k] && !e.altKey) { this.setTool(tools[k]); return true; }
    if (k === '-' || k === '_') { this.zoomBy(0.8); return true; }
    if (k === '=' || k === '+') { this.zoomBy(1.25); return true; }
    return false;
  }

  // ---------------- minimap ----------------
  _drawMinimap() {
    if (state.settings?.minimap === false) return;
    const light = document.documentElement.dataset.theme === 'light';
    const c = this.miniCanvas;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const r = this.rect();
    if (!r.width) return;
    const vpw = { x: -this.vp.x / this.vp.z, y: -this.vp.y / this.vp.z, w: r.width / this.vp.z, h: r.height / this.vp.z };
    const nodes = this.doc.nodes;
    const b = nodes.length ? this.bounds([...nodes, vpw]) : vpw;
    const pad = Math.max(b.w, b.h) * 0.08;
    const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    const s = Math.min(W / box.w, H / box.h);
    const ox = (W - box.w * s) / 2, oy = (H - box.h * s) / 2;
    this.miniMeta = { x: box.x - ox / s, y: box.y - oy / s, w: W / s, h: H / s };
    const tx = (x) => ox + (x - box.x) * s, ty = (y) => oy + (y - box.y) * s;
    for (const n of nodes) {
      const def = NODE_TYPES[n.type];
      ctx.fillStyle = n.type === 'sticky' ? (n.data.color || '#ffe58a') : n.type === 'frame' ? (light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)') : def?.chrome === 'window' ? (light ? '#c9cfdb' : '#3a4150') : n.type === 'hub' ? (light ? '#9aa3b5' : '#cfd3da') : (light ? '#b5bccb' : '#4a5263');
      ctx.fillRect(tx(n.x), ty(n.y), Math.max(2, n.w * s), Math.max(2, n.h * s));
      if (this.selection.has(n.id)) { ctx.strokeStyle = '#7c8cff'; ctx.lineWidth = 1.5; ctx.strokeRect(tx(n.x), ty(n.y), Math.max(2, n.w * s), Math.max(2, n.h * s)); }
    }
    ctx.strokeStyle = light ? 'rgba(30,36,48,0.75)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx(vpw.x), ty(vpw.y), vpw.w * s, vpw.h * s);
  }
}

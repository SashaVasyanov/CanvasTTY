// Codex pets: sprite animation, the agent-state watcher and the floating companion that
// behaves like the pet in the Codex app — it shows what the agents are doing (running,
// waiting for you, ready for review, failed), can be dragged around (it runs while you drag),
// waves when clicked, jumps when a task is done and, for 11-row pets, looks at the cursor.
import { h, icon, bus, menu, toast, Emitter } from './util.js';
import { state, native } from './state.js';

export const CELL_W = 192, CELL_H = 208;
const seq = (n, d, last) => [...Array(n - 1).fill(d), last];
// frame timings of the Codex app (hatch-pet animation contract)
export const PET_ROWS = {
  idle: { row: 0, d: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, d: seq(8, 120, 220) },
  'running-left': { row: 2, d: seq(8, 120, 220) },
  waving: { row: 3, d: seq(4, 140, 280) },
  jumping: { row: 4, d: seq(5, 140, 280) },
  failed: { row: 5, d: seq(8, 140, 240) },
  waiting: { row: 6, d: seq(6, 150, 260) },
  running: { row: 7, d: seq(6, 120, 220) },
  review: { row: 8, d: seq(6, 150, 280) },
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------- installed pets cache ----------------
export const codexPets = { list: [], byId: new Map(), loaded: false };
export async function loadCodexPets() {
  try { codexPets.list = (await native.codexPets?.installed?.()) || []; } catch { codexPets.list = []; }
  codexPets.byId = new Map(codexPets.list.map((p) => [p.id, p]));
  codexPets.loaded = true;
  bus.emit('codexPets:changed');
  return codexPets.list;
}
export const isCodexKind = (k) => String(k || '').startsWith('codex:');
export const codexPetFor = (k) => (isCodexKind(k) ? codexPets.byId.get(k.slice(6)) : null);

// ---------------- sprite ----------------
export class SpritePet {
  constructor({ url, rows = 9, size = 96, state: st = 'idle', still = false }) {
    this.el = h('div', { class: 'cpet' });
    this.img = h('div', { class: 'cpet-img' });
    this.el.append(this.img);
    this.size = size; this.rows = rows; this.still = still;
    this.cur = { row: 0, frame: 0 };
    this.setSheet(url, rows);
    this.play(st);
  }
  setSheet(url, rows = 9) {
    this.url = url; this.rows = rows;
    this.img.style.backgroundImage = `url("${url}")`;
    this.resize(this.size);
  }
  resize(size) {
    this.size = size;
    const ch = (CELL_H * size) / CELL_W;
    this.el.style.width = `${size}px`; this.el.style.height = `${ch}px`;
    this.img.style.backgroundSize = `${size * 8}px ${ch * this.rows}px`;
    this.paint();
  }
  paint() {
    const ch = (CELL_H * this.size) / CELL_W;
    this.img.style.backgroundPosition = `${-this.cur.frame * this.size}px ${-this.cur.row * ch}px`;
  }
  play(name, { once = false, then = null } = {}) {
    if (!PET_ROWS[name]) name = 'idle';
    this.lookIdx = null;
    if (!once && !this.once && name === this.state) return;
    this.state = name; this.once = once; this.then = then; this.frame = 0;
    clearTimeout(this.t);
    this.tick();
  }
  tick() {
    const r = PET_ROWS[this.state];
    this.cur = { row: r.row, frame: this.frame };
    this.paint();
    if (this.still || (reducedMotion.matches && !this.once)) return;
    this.t = setTimeout(() => {
      this.frame++;
      if (this.frame >= r.d.length) {
        if (this.once) { const next = this.then || 'idle'; this.once = false; this.then = null; this.state = null; this.play(next); return; }
        this.frame = 0;
      }
      this.tick();
    }, r.d[this.frame]);
  }
  // 11-row pets have 16 look directions (0 = up, clockwise)
  look(idx) {
    if (this.rows < 11 || this.once) return false;
    clearTimeout(this.t);
    this.lookIdx = idx;
    this.cur = { row: 9 + Math.floor(idx / 8), frame: idx % 8 };
    this.paint();
    return true;
  }
  unlook() {
    if (this.lookIdx == null) return;
    this.lookIdx = null;
    const s = this.state; this.state = null; this.play(s || 'idle');
  }
  setStill(v) { this.still = v; const s = this.state; this.state = null; this.play(s || 'idle'); }
  destroy() { clearTimeout(this.t); this.el.remove(); }
}

// ---------------- what the agents are doing ----------------
const AGENT_TYPES = new Set(['terminal', 'chat', 'agentchat']);
export class AgentWatch extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.unseen = new Set();
    this.prev = new Map();
    this.info = { state: 'idle', text: '', target: null, count: 0 };
    this.timer = setInterval(() => this.poll(), 700);
    app.canvas.on('selection', () => { let ch = false; for (const id of app.canvas.selection) if (this.unseen.delete(id)) ch = true; if (ch) this.poll(true); });
    state.on('canvas', () => { this.prev.clear(); this.unseen.clear(); });
  }
  seen(id) { if (id && this.unseen.delete(id)) this.poll(true); }
  poll(force = false) {
    const c = this.app.canvas;
    if (!c?.doc) return;
    const items = [];
    const alive = new Set();
    for (const n of c.doc.nodes) {
      if (!AGENT_TYPES.has(n.type)) continue;
      const v = c.views.get(n.id);
      if (!v) continue;
      alive.add(n.id);
      const st = v.def.status?.(n, v.inst) || { kind: 'off', label: '' };
      const prev = this.prev.get(n.id);
      if (prev === 'busy' && st.kind !== 'busy') {
        if (st.kind === 'na') this.emit('failed', n);
        else { if (!c.selection.has(n.id)) this.unseen.add(n.id); this.emit('finished', n); }
      }
      this.prev.set(n.id, st.kind);
      items.push({ n, name: v.def.title(n), st });
    }
    for (const id of [...this.unseen]) if (!alive.has(id)) this.unseen.delete(id);
    const pick = (f) => items.filter(f);
    const waiting = pick((x) => x.st.kind === 'wait');
    const failed = pick((x) => x.st.kind === 'na' && /ошибк/i.test(x.st.label || ''));
    const running = pick((x) => x.st.kind === 'busy');
    const review = pick((x) => this.unseen.has(x.n.id) && x.st.kind !== 'busy');
    const more = (list) => (list.length > 1 ? ` и ещё ${list.length - 1}` : '');
    let info;
    if (waiting.length) info = { state: 'waiting', text: `${waiting[0].name}${more(waiting)} — нужен ваш ответ`, target: waiting[0].n.id };
    else if (failed.length) info = { state: 'failed', text: `${failed[0].name} — ошибка`, target: failed[0].n.id };
    else if (running.length) info = { state: 'running', text: `${running[0].name}${more(running)} — работает…`, target: running[0].n.id };
    else if (review.length) info = { state: 'review', text: `${review[0].name}${more(review)} — готово, посмотрите`, target: review[0].n.id };
    else info = { state: 'idle', text: items.length ? '' : '', target: null };
    info.count = items.length;
    const sig = `${info.state}|${info.text}|${info.target}`;
    if (force || sig !== this.sig) { this.sig = sig; this.info = info; this.emit('change', info); bus.emit('agentstate', info); }
  }
  destroy() { clearInterval(this.timer); }
}

// ---------------- floating companion ----------------
const SIZES = { small: 72, medium: 96, large: 128 };
export class Companion {
  constructor(app, pet) {
    this.app = app; this.pet = pet; this.watch = app.agentWatch;
    const s = state.settings;
    this.size = SIZES[s.companionSize] || SIZES.medium;
    this.sprite = new SpritePet({ url: pet.url, rows: pet.rows, size: this.size, state: 'idle' });
    this.bubble = h('div', { class: 'cbubble' });
    this.el = h('div', { class: 'companion', title: `${pet.displayName} — нажмите, чтобы помахать; тяните, чтобы переставить; ПКМ — меню` }, this.bubble, this.sprite.el);
    app.canvasHost.append(this.el);
    this.pos = { ...(s.companionPos || { right: 28, bottom: 92 }) };
    this.place();
    this.bindPointer();
    this.offs = [
      this.watch.on('change', (info) => this.apply(info)),
      this.watch.on('finished', () => { if (!this.dragging) this.sprite.play('jumping', { once: true, then: this.watch.info.state }); }),
      this.watch.on('failed', () => this.sprite.play('failed')),
    ];
    this.onMove = (e) => this.lookAt(e);
    window.addEventListener('pointermove', this.onMove, { passive: true });
    this.onResize = () => this.place();
    window.addEventListener('resize', this.onResize);
    this.apply(this.watch.info);
    this.sprite.play('waving', { once: true, then: this.watch.info.state }); // hello
  }
  place() {
    const r = this.app.canvasHost.getBoundingClientRect();
    const w = this.size, ht = (CELL_H * this.size) / CELL_W;
    this.pos.right = Math.min(Math.max(0, this.pos.right), Math.max(0, r.width - w));
    this.pos.bottom = Math.min(Math.max(0, this.pos.bottom), Math.max(0, r.height - ht));
    this.el.style.right = `${this.pos.right}px`;
    this.el.style.bottom = `${this.pos.bottom}px`;
  }
  apply(info) {
    if (!this.dragging && !this.sprite.once) this.sprite.play(info.state);
    else if (this.sprite.once) this.sprite.then = info.state;
    this.bubble.textContent = info.text || '';
    this.bubble.className = `cbubble ${info.state}${info.text ? ' on' : ''}`;
    this.bubble.onclick = (e) => { e.stopPropagation(); if (info.target) { this.app.canvas.focusNode(info.target); this.watch.seen(info.target); } };
  }
  bindPointer() {
    const sp = this.sprite.el;
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      sp.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, o = { ...this.pos };
      let lastX = e.clientX, moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        if (!moved) { moved = true; this.dragging = true; this.el.classList.add('dragging'); }
        this.pos.right = o.right - (ev.clientX - sx);
        this.pos.bottom = o.bottom - (ev.clientY - sy);
        this.place();
        const dx = ev.clientX - lastX;
        if (Math.abs(dx) >= 2) { this.sprite.play(dx > 0 ? 'running-right' : 'running-left'); lastX = ev.clientX; }
      };
      const up = () => {
        sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
        if (moved) {
          this.dragging = false; this.el.classList.remove('dragging');
          state.setSetting('companionPos', { ...this.pos });
          this.sprite.play('jumping', { once: true, then: this.watch.info.state });
        } else this.click();
      };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
    });
    sp.addEventListener('dblclick', (e) => { e.stopPropagation(); this.sprite.play('jumping', { once: true, then: this.watch.info.state }); });
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.menu(e.clientX, e.clientY); });
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }
  click() {
    const info = this.watch.info;
    this.sprite.play('waving', { once: true, then: info.state });
    if (info.target) { this.app.canvas.focusNode(info.target); this.watch.seen(info.target); }
  }
  // 11-row pets turn their head toward the cursor while nothing else is going on
  lookAt(e) {
    if (this.sprite.rows < 11 || this.dragging || this.sprite.once || this.watch.info.state !== 'idle') return;
    if (this._lookRaf) return;
    this._lookRaf = requestAnimationFrame(() => {
      this._lookRaf = 0;
      const r = this.sprite.el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * 0.42);
      const d = Math.hypot(dx, dy);
      clearTimeout(this._lookT);
      if (d < 26 || d > 520) { this.sprite.unlook(); return; }
      const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      this.sprite.look(Math.round(deg / 22.5) % 16);
      this._lookT = setTimeout(() => this.sprite.unlook(), 2200);
    });
  }
  setSize(k) { state.setSetting('companionSize', k); this.size = SIZES[k]; this.sprite.resize(this.size); this.place(); }
  menu(x, y) {
    const cur = state.settings.companionSize || 'medium';
    menu([
      { label: this.pet.displayName, disabled: true },
      { label: 'Помахать', icon: 'sparkle', onClick: () => this.sprite.play('waving', { once: true, then: this.watch.info.state }) },
      { label: 'Подпрыгнуть', icon: 'arrow', onClick: () => this.sprite.play('jumping', { once: true, then: this.watch.info.state }) },
      '-',
      { label: 'Размер', icon: 'maximize', children: [['small', 'Маленький'], ['medium', 'Средний'], ['large', 'Большой']].map(([k, l]) => ({ label: l, checked: cur === k, onClick: () => this.setSize(k) })) },
      { label: 'Вернуть в угол', icon: 'home', onClick: () => { this.pos = { right: 28, bottom: 92 }; this.place(); state.setSetting('companionPos', { ...this.pos }); } },
      { label: 'Сменить питомца…', icon: 'refresh', onClick: () => bus.emit('openPetPicker') },
      { label: 'Каталог Codex Pets…', icon: 'globe', onClick: () => bus.emit('openPetCatalog') },
      '-',
      { label: 'Спрятать питомца', icon: 'x', onClick: () => { state.setSetting('pet', false); bus.emit('pet:changed'); toast('Питомец спрятан. Вернуть: Настройки → Общие → «Питомец на экране»'); } },
    ], x, y);
  }
  destroy() {
    for (const off of this.offs) off?.();
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('resize', this.onResize);
    clearTimeout(this._lookT);
    this.sprite.destroy();
    this.el.remove();
  }
}

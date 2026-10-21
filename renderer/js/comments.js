// Comments on the canvas, like in Figma: a round pin with the author's initial that keeps its
// on-screen size at any zoom, expands to "name · time · text" on hover and opens a thread with
// replies on click. A comment dropped on an object is attached to it and moves with it.
// Stored in doc.comments (synced and merged by id, not part of undo).
import { h, icon, uid, prompt, toast, confirmBox } from './util.js';
import { state } from './state.js';

// avatar colours: Apple system colours (light variants, white initials read on all of them)
const COLORS = ['#34c759', '#ff3b30', '#007aff', '#ff9500', '#af52de', '#ff2d55', '#30b0c7', '#5856d6', '#a2845e', '#8e8e93'];
const colorOf = (name) => { let x = 0; for (const ch of String(name || '?')) x = (x * 31 + ch.codePointAt(0)) >>> 0; return COLORS[x % COLORS.length]; };
const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();

export function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 172800) return 'вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export class Comments {
  constructor(canvas) {
    this.cv = canvas;
    this.pins = new Map();
    this.layer = h('div', { class: 'comments-layer' });
    canvas.root.append(this.layer);
    this.thread = null;
    canvas.on('changed', () => this.render());
    setInterval(() => this.refreshTimes(), 60000);
  }
  get list() { const d = this.cv.doc; if (!d) return []; if (!Array.isArray(d.comments)) d.comments = []; return d.comments; }
  get visible() { return state.settings.showComments !== false; }
  author() { return state.settings.userName || ''; }
  async ensureAuthor() {
    if (this.author()) return this.author();
    const guess = (state.info.home || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const name = await prompt('Как подписывать ваши комментарии?', guess ? guess[0].toUpperCase() + guess.slice(1) : '', 'Имя');
    if (!name) return '';
    state.setSetting('userName', name.trim());
    return name.trim();
  }

  // world position of a comment (attached ones follow their object)
  pos(c) {
    const n = c.node && this.cv.node(c.node);
    if (n) { c.x = n.x + c.rx; c.y = n.y + c.ry; }
    return { x: c.x, y: c.y };
  }
  attach(c, x, y) {
    c.x = x; c.y = y;
    // the topmost object under the point (areas are below everything else)
    let best = null;
    for (const n of this.cv.doc.nodes) {
      if (n.type === 'hub' || x < n.x || y < n.y || x > n.x + n.w || y > n.y + n.h) continue;
      if (!best || (n.z || 0) > (best.z || 0)) best = n;
    }
    if (best) { c.node = best.id; c.rx = x - best.x; c.ry = y - best.y; } else { delete c.node; delete c.rx; delete c.ry; }
  }
  save() { state.touch(); }

  // ---------- pins ----------
  render() {
    // leftovers of comments that were never sent
    const d = this.cv.doc;
    if (d?.comments?.some((c) => !c.messages?.length && c !== this.draft)) d.comments = d.comments.filter((c) => c.messages?.length || c === this.draft);
    const want = new Set();
    const showResolved = !!state.settings.showResolvedComments;
    if (this.visible) {
      for (const c of this.list) {
        if (c.resolved && !showResolved && this.thread?.c !== c) continue;
        want.add(c.id);
        let pin = this.pins.get(c.id);
        if (!pin) { pin = this.makePin(c); this.pins.set(c.id, pin); this.layer.append(pin.el); }
        this.paintPin(pin, c);
      }
    }
    for (const [id, pin] of this.pins) if (!want.has(id)) { pin.el.remove(); this.pins.delete(id); }
    this.position();
  }
  position() {
    if (!this.pins.size && !this.thread) return;
    const byId = new Map(this.list.map((c) => [c.id, c]));
    for (const [id, pin] of this.pins) {
      const c = byId.get(id); if (!c) continue;
      const w = this.pos(c), p = this.cv.toScreen(w.x, w.y);
      pin.el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
    }
    if (this.thread) this.placeThread();
  }
  makePin(c) {
    const el = h('div', { class: 'cmt-pin' });
    const av = h('div', { class: 'cmt-av' });
    const prev = h('div', { class: 'cmt-prev' }, h('div', { class: 'cmt-prev-head' }, h('b', { class: 'cmt-name' }), h('span', { class: 'cmt-time' })), h('div', { class: 'cmt-prev-text' }));
    const count = h('span', { class: 'cmt-count' });
    el.append(h('div', { class: 'cmt-bubble' }, av, prev, count));
    const pin = { el, av, prev, count, c };
    el.addEventListener('pointerdown', (e) => this.pinDown(e, pin));
    el.addEventListener('dblclick', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => { if (el.classList.contains('open')) e.stopPropagation(); }, { passive: true });
    return pin;
  }
  paintPin(pin, c) {
    pin.c = c;
    const first = c.messages?.[0] || {};
    const last = c.messages?.[c.messages.length - 1] || first;
    pin.av.textContent = initial(first.author);
    pin.av.style.background = first.color || colorOf(first.author);
    pin.prev.querySelector('.cmt-name').textContent = first.author || 'Без имени';
    pin.prev.querySelector('.cmt-time').textContent = timeAgo(last.ts || Date.now());
    pin.prev.querySelector('.cmt-prev-text').textContent = first.text || '';
    const replies = (c.messages?.length || 1) - 1;
    pin.count.textContent = replies > 0 ? String(replies + 1) : '';
    pin.el.classList.toggle('resolved', !!c.resolved);
    pin.el.classList.toggle('active', this.thread?.c === c);
  }
  refreshTimes() { for (const pin of this.pins.values()) this.paintPin(pin, pin.c); this.thread?.refresh?.(); }

  // click opens the thread, drag moves the pin (and re-attaches it to what it lands on)
  pinDown(e, pin) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const c = pin.c;
    const sx = e.clientX, sy = e.clientY;
    const start = this.pos(c);
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      pin.el.classList.add('dragging');
      delete c.node;
      c.x = start.x + dx / this.cv.vp.z; c.y = start.y + dy / this.cv.vp.z;
      this.position();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      pin.el.classList.remove('dragging');
      if (moved) { this.attach(c, c.x, c.y); this.save(); this.position(); }
      else this.open(c);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // ---------- creating ----------
  async startNew(e) {
    const w = this.cv.toWorld(e.clientX, e.clientY);
    const name = await this.ensureAuthor();
    if (!name) return;
    const c = { id: uid('cm'), x: Math.round(w.x), y: Math.round(w.y), messages: [], created: Date.now() };
    this.attach(c, c.x, c.y);
    this.draft = c;
    this.list.push(c);
    if (state.settings.showComments === false) state.setSetting('showComments', true);
    this.render();
    this.open(c, { draft: true });
  }

  // ---------- thread ----------
  open(c, { draft = false } = {}) {
    this.close(true);
    const box = h('div', { class: 'cmt-thread' });
    const list = h('div', { class: 'cmt-msgs scrollable' });
    const input = h('textarea', { class: 'cmt-input', rows: 1, placeholder: draft ? 'Добавить комментарий' : 'Ответить' });
    const send = h('button', { class: 'cmt-send', title: 'Отправить (Enter)', html: icon('send', 15) });
    const head = h('div', { class: 'cmt-head' },
      h('span', { class: 'cmt-title' }, draft ? 'Новый комментарий' : 'Комментарий'),
      h('span', { class: 'flex' }),
      draft ? null : h('button', { class: `cmt-hbtn${c.resolved ? ' on' : ''}`, title: c.resolved ? 'Открыть снова' : 'Решено', html: icon('check', 16), onclick: () => this.resolve(c) }),
      draft ? null : h('button', { class: 'cmt-hbtn', title: 'Удалить комментарий', html: icon('trash', 15), onclick: () => this.remove(c) }),
      h('button', { class: 'cmt-hbtn', title: 'Закрыть (Esc)', html: icon('x', 15), onclick: () => this.close() }));
    const renderMsgs = () => {
      list.replaceChildren(...(c.messages || []).map((m) => h('div', { class: 'cmt-msg' },
        h('div', { class: 'cmt-av sm', style: { background: m.color || colorOf(m.author) } }, initial(m.author)),
        h('div', { class: 'cmt-msg-body' }, h('div', { class: 'cmt-msg-head' }, h('b', {}, m.author || 'Без имени'), h('span', { class: 'cmt-time' }, timeAgo(m.ts))), h('div', { class: 'cmt-msg-text' }, m.text)))));
      list.style.display = c.messages?.length ? '' : 'none';
      list.scrollTop = list.scrollHeight;
    };
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
    const post = async () => {
      const text = input.value.trim();
      if (!text) return;
      const author = await this.ensureAuthor();
      if (!author) return;
      (c.messages ||= []).push({ id: uid('cmm'), author, color: colorOf(author), text, ts: Date.now() });
      if (this.draft === c) this.draft = null;
      input.value = ''; grow();
      this.save(); this.render(); renderMsgs();
      if (draft) { draft = false; input.placeholder = 'Ответить'; head.querySelector('.cmt-title').textContent = 'Комментарий'; this.close(); this.cv.setTool?.('select'); }
    };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); post(); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    send.addEventListener('click', post);
    box.append(head, list, h('div', { class: 'cmt-compose' }, input, send));
    for (const ev of ['pointerdown', 'wheel', 'dblclick', 'contextmenu']) box.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === 'wheel' });
    this.layer.append(box);
    this.thread = { c, box, refresh: renderMsgs };
    renderMsgs();
    this.render();
    this.placeThread();
    setTimeout(() => input.focus(), 0);
    // a click elsewhere closes the thread
    this._outside = (e) => { if (!box.contains(e.target) && !e.target.closest?.('.cmt-pin')) this.close(); };
    setTimeout(() => document.addEventListener('pointerdown', this._outside, true), 0);
  }
  placeThread() {
    const t = this.thread; if (!t) return;
    const w = this.pos(t.c), p = this.cv.toScreen(w.x, w.y);
    const r = this.cv.rect();
    const bw = t.box.offsetWidth || 300, bh = t.box.offsetHeight || 160;
    let x = p.x + 44, y = p.y - 40;
    if (x + bw > r.width - 8) x = p.x - bw - 12;
    y = Math.max(8, Math.min(y, r.height - bh - 8));
    t.box.style.transform = `translate3d(${Math.round(Math.max(8, x))}px, ${Math.round(y)}px, 0)`;
  }
  close(silent = false) {
    if (!this.thread) return;
    document.removeEventListener('pointerdown', this._outside, true);
    const c = this.thread.c;
    this.thread.box.remove();
    this.thread = null;
    // an unsent new comment disappears
    if (this.draft === c && !c.messages?.length) { const i = this.list.indexOf(c); if (i >= 0) this.list.splice(i, 1); this.draft = null; this.save(); }
    if (!silent) this.render(); else for (const pin of this.pins.values()) pin.el.classList.remove('active');
  }
  resolve(c) {
    c.resolved = !c.resolved;
    this.save();
    if (c.resolved) { this.close(); toast('Комментарий решён и скрыт. Показать решённые — ПКМ по кнопке комментариев'); } else this.open(c);
    this.render();
  }
  async remove(c) {
    if (!(await confirmBox('Удалить комментарий?', 'Ветка со всеми ответами будет удалена.'))) return;
    this.close(true);
    const i = this.list.indexOf(c); if (i >= 0) this.list.splice(i, 1);
    this.save(); this.render();
  }
  toggleVisible(on = !this.visible) { state.setSetting('showComments', on); if (!on) this.close(); this.render(); }
  toggleResolved() { state.setSetting('showResolvedComments', !state.settings.showResolvedComments); this.render(); }
  count() { return this.list.filter((c) => !c.resolved && c.messages?.length).length; }
}

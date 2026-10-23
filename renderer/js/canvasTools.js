// Canvas tools for the agents in chat windows. The agent's CLI calls them through the MCP server
// main/mcp-history.js → main/canvas-bridge.js → main/main.js → here. The agent sees the canvas of
// its own window and adds stickies, notes, text, areas and arrows next to the window (or inside an
// area). It edits only what it added itself, deletes nothing, and everything one answer adds is one
// step of Ctrl+Z. A canvas that is not on screen is changed in its file. Setting: «Инструменты
// холста для агентов» (state.settings.canvasTools).
import { uid, toast } from './util.js';
import { state, native, editCanvasFile } from './state.js';
import { NODE_TYPES } from './nodes.js';
import { describeObject, titleOf } from './context.js';
import { sanitizeHtml, htmlText } from './sanitize.js';
import { vaultIndex } from './vaultIndex.js';

export const CANVAS_COLORS = ['yellow', 'green', 'blue', 'orange', 'red', 'pink', 'purple', 'gray'];
const NAME = { frame: 'область', note: 'заметка', sticky: 'стикер', text: 'текст', shape: 'фигура', image: 'картинка', chat: 'API-чат', agentchat: 'чат агента', terminal: 'терминал', web: 'веб-страница', widget: 'виджет', drawing: 'рисунок', diff: 'изменения', hub: 'хаб' };
const GAP = 40, STEP = 20, MARGIN = 16, PAD = 40, HEAD = 50;
const MAX_PER_RUN = 100;
const MAX_TEXT = 20000;
const NOTE_FOLDER = 'Из чатов';

const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const str = (v, name, max = MAX_TEXT) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Нужен параметр ${name} (текст)`);
  if (v.length > max) throw new Error(`${name}: слишком длинный текст (больше ${max} символов)`);
  return v;
};
const textHtml = (t) => sanitizeHtml(String(t).split('\n').map((l) => esc(l) || '<br>').map((l, i) => (i ? `<div>${l}</div>` : l)).join(''));
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const inside = (r, f) => r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + f.w && r.y + r.h <= f.y + f.h;

// ---------------- placement ----------------
// A free spot for a w×h object: in columns to the right of the anchor (as tall as the anchor, at
// least 900), then under it; inside an area: in its free space, else under its contents (the area
// grows). nodes: the canvas; skip: ids that are not obstacles (the areas the anchor is in).
export function freeSpot(nodes, anchor, w, h, { area = null } = {}) {
  const ancestors = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let p = (area || anchor)?.parent, d = 0; p && d < 60; d++) { ancestors.add(p); p = byId.get(p)?.parent; }
  if (area) ancestors.add(area.id);
  const obstacles = nodes.filter((n) => !ancestors.has(n.id)).map((n) => grow(n, MARGIN));
  const free = (x, y) => { const r = { x, y, w, h }; return !obstacles.some((o) => overlap(r, o)); };
  if (area) {
    for (let y = area.y + HEAD; y + h <= area.y + area.h - PAD / 2; y += STEP) {
      for (let x = area.x + PAD; x + w <= area.x + area.w - PAD / 2; x += STEP) if (free(x, y)) return { x, y };
    }
    const kids = nodes.filter((n) => n.parent === area.id);
    const y = kids.length ? Math.max(...kids.map((n) => n.y + n.h)) + GAP : area.y + HEAD;
    return { x: area.x + PAD, y, growArea: { w: Math.max(area.w, w + PAD * 2), h: Math.max(area.h, y - area.y + h + PAD) } };
  }
  const colH = Math.max(anchor.h, 900);
  const x0 = anchor.x + anchor.w + GAP;
  for (let dx = 0; dx <= 2400; dx += STEP) {
    for (let dy = 0; dy + h <= colH || dy === 0; dy += STEP) if (free(x0 + dx, anchor.y + dy)) return { x: x0 + dx, y: anchor.y + dy };
  }
  const y0 = anchor.y + anchor.h + GAP;
  for (let dy = 0; dy <= 2400; dy += STEP) {
    for (let dx = 0; dx <= Math.max(anchor.w, 900); dx += STEP) if (free(anchor.x + dx, y0 + dy)) return { x: anchor.x + dx, y: y0 + dy };
  }
  return { x: Math.max(...nodes.map((n) => n.x + n.w)) + GAP, y: anchor.y };
}

// the smallest area that holds the rectangle (for a canvas edited in its file)
function frameFor(nodes, r, selfId = null) {
  let best = null;
  for (const f of nodes) if (f.type === 'frame' && f.id !== selfId && inside(r, f) && (!best || f.w * f.h < best.w * best.h)) best = f;
  return best;
}

// ---------------- the canvas an agent works on ----------------
// the canvas on screen: changes go through the view (one undo step per answer)
let undoMark = null; // { run, snap }: the undo step taken before the last run's first change
function liveCanvas(view, run) {
  const step = () => {
    const top = view.undoStack[view.undoStack.length - 1];
    if (undoMark?.run === run && top === undoMark.snap) return; // nothing else happened since: the same step
    view.checkpoint();
    undoMark = { run, snap: view.undoStack[view.undoStack.length - 1] };
  };
  return {
    live: true, doc: view.doc, view,
    node: (id) => view.node(id),
    add(type, geom, data) { step(); return view.addNode(type, { ...geom, data }, { select: false, checkpoint: false, center: false }); },
    edge(from, to, extra) { step(); return view.addEdge(from, to, extra, { checkpoint: false }); },
    update(id, patch) { step(); view.updateNode(id, patch); },
    save: async () => {},
  };
}
// a canvas that is not on screen: its file
function fileCanvas(doc) {
  const node = (id) => doc.nodes.find((n) => n.id === id);
  const maxZ = () => doc.nodes.reduce((m, n) => Math.max(m, n.z || 0), 0);
  return {
    live: false, doc, view: { doc, node, views: new Map() },
    node,
    add(type, geom, data) {
      const def = NODE_TYPES[type];
      const n = { id: uid(type.slice(0, 2)), type, x: Math.round(geom.x), y: Math.round(geom.y), w: geom.w, h: geom.h, z: type === 'frame' ? -doc.nodes.length : maxZ() + 1, data: { ...(def.defaultData ? def.defaultData() : {}), ...data } };
      const host = frameFor(doc.nodes, n);
      if (host) n.parent = host.id;
      if (type === 'frame') {
        for (const x of doc.nodes) {
          if (x.id === n.id || !inside(x, n)) continue;
          const cur = x.parent && node(x.parent);
          if (!cur || inside(n, cur)) x.parent = n.id; // the new area is the closer one
        }
      }
      doc.nodes.push(n);
      return n;
    },
    edge(from, to, extra) {
      if (doc.edges.some((e) => e.from === from && e.to === to)) return null;
      const e = { id: uid('e'), from, to, arrow: true, ...extra };
      doc.edges.push(e);
      return e;
    },
    update(id, patch) { const n = node(id); if (!n) return; const { data, ...rest } = patch; Object.assign(n, rest); if (data) n.data = { ...n.data, ...data }; },
  };
}

// ---------------- what the agent can do ----------------
const where = (n) => `x ${Math.round(n.x)}, y ${Math.round(n.y)}, ${Math.round(n.w)}×${Math.round(n.h)}`;
const label = (n) => `[${n.id}] ${NAME[n.type] || n.type} «${clip(titleOf(n), 60)}»`;
const canvasName = (docId) => { for (const p of state.ws?.projects || []) { const c = p.canvases.find((x) => x.id === docId); if (c) return `${p.name} / ${c.name}`; } return docId; };
const dist = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);

function listObjects(c, self, t, { type = '', limit = 80 } = {}) {
  limit = Math.max(1, Math.min(300, Number(limit) || 80));
  const all = c.doc.nodes.filter((n) => n.id !== self.id && (!type || n.type === type));
  const rows = all.sort((a, b) => dist(a, self) - dist(b, self)).slice(0, limit).map((n) => {
    const out = c.doc.edges.filter((e) => e.from === n.id).map((e) => `→ [${e.to}]`);
    const inc = c.doc.edges.filter((e) => e.to === n.id).map((e) => `← [${e.from}]`);
    const bits = [label(n), where(n)];
    if (n.parent) bits.push(`в области [${n.parent}]`);
    if (out.length || inc.length) bits.push(`стрелки: ${[...out, ...inc].slice(0, 8).join(' ')}`);
    if (n.data?.createdBy === self.id) bits.push('добавлен вами');
    return `- ${bits.join(' · ')}`;
  });
  const mine = c.doc.edges.filter((e) => e.from === self.id || e.to === self.id).map((e) => (e.from === self.id ? `→ [${e.to}]` : `← [${e.from}]`));
  return [`Холст «${canvasName(t.docId)}»${c.live ? '' : ' (сейчас не открыт у пользователя)'}.`,
    `Ваше окно: ${label(self)} · ${where(self)}${self.parent ? ` · в области [${self.parent}]` : ''}${mine.length ? ` · стрелки: ${mine.join(' ')}` : ''}`,
    all.length ? `Объекты (${all.length}${all.length > rows.length ? `, показаны ${rows.length} ближайших` : ''}, ближние к вашему окну первыми):` : 'Других объектов на холсте нет.',
    ...rows].join('\n');
}

async function readObject(c, self, { id }) {
  const n = c.node(str(id, 'id', 200));
  if (!n) throw new Error(`Объекта ${id} нет на холсте`);
  const head = `${label(n)} · ${where(n)}${n.parent ? ` · в области [${n.parent}]` : ''}${n.data?.createdBy === self.id ? ' · добавлен вами' : ''}`;
  let body = await describeObject(c.view, n);
  if (n.type === 'frame') {
    const kids = c.doc.nodes.filter((x) => x.parent === n.id);
    body = `${kids.length ? `Внутри: ${kids.map(label).join(', ')}` : 'Внутри пусто'}\n\n${body}`;
  }
  return `${head}\n\n${clip(body.trim() || '(без текста)', MAX_TEXT)}`;
}

// where a new object goes: next to `near` (default: the agent's window) or inside the area `area`
function spot(c, self, { near, area }, w, h) {
  let a = null;
  if (area) {
    a = c.node(String(area));
    if (!a || a.type !== 'frame') throw new Error(`Области ${area} нет на холсте`);
  }
  const anchor = near ? c.node(String(near)) : self;
  if (!anchor) throw new Error(`Объекта ${near} нет на холсте`);
  const p = freeSpot(c.doc.nodes, anchor, w, h, { area: a });
  if (p.growArea) c.update(a.id, { w: p.growArea.w, h: p.growArea.h });
  return { x: p.x, y: p.y, w, h };
}

const ops = {
  list_objects: (c, self, t, a) => listObjects(c, self, t, a),
  read_object: (c, self, t, a) => readObject(c, self, a),
  async create_sticky(c, self, t, a) {
    const text = str(a.text, 'text', 4000);
    const color = CANVAS_COLORS.includes(a.color) ? a.color : 'yellow';
    const n = c.add('sticky', spot(c, self, a, 220, 220), { text, color, createdBy: self.id });
    return `Стикер добавлен: [${n.id}] · ${where(n)}`;
  },
  async create_text(c, self, t, a) {
    const text = str(a.text, 'text', 4000);
    const size = Math.max(12, Math.min(96, Number(a.size) || 20));
    const lines = text.split('\n');
    const w = Math.round(Math.min(720, Math.max(120, Math.max(...lines.map((l) => l.length)) * size * 0.56 + 16)));
    const h = Math.round(lines.length * size * 1.45 + 8);
    const n = c.add('text', spot(c, self, a, w, h), { html: textHtml(text), size, createdBy: self.id });
    return `Текст добавлен: [${n.id}] · ${where(n)}`;
  },
  async create_note(c, self, t, a) {
    const title = str(a.title, 'title', 120).replace(/\s+/g, ' ').trim();
    const name = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Заметка агента';
    const md = typeof a.markdown === 'string' ? a.markdown : '';
    if (md.length > 200000) throw new Error('markdown: заметка слишком большая');
    const path = await native.vault.create(NOTE_FOLDER, name, /^#\s/.test(md) ? md : `# ${title}\n\n${md}`);
    vaultIndex.refresh?.();
    const n = c.add('note', spot(c, self, a, 420, 380), { path, createdBy: self.id });
    return `Заметка добавлена: [${n.id}] · файл «${path}» в заметках пользователя · ${where(n)}`;
  },
  async create_area(c, self, t, a) {
    const title = str(a.title, 'title', 120);
    const color = CANVAS_COLORS.includes(a.color) ? a.color : 'blue';
    const ids = Array.isArray(a.objects) ? a.objects.map(String) : [];
    let geom;
    if (ids.length) {
      const nodes = ids.map((id) => c.node(id));
      const miss = ids.filter((id, i) => !nodes[i]);
      if (miss.length) throw new Error(`Нет на холсте: ${miss.join(', ')}`);
      if (nodes.some((n) => n.id === self.id)) throw new Error('Ваше окно нельзя поместить в область');
      const x1 = Math.min(...nodes.map((n) => n.x)), y1 = Math.min(...nodes.map((n) => n.y));
      const x2 = Math.max(...nodes.map((n) => n.x + n.w)), y2 = Math.max(...nodes.map((n) => n.y + n.h));
      geom = { x: x1 - PAD, y: y1 - HEAD, w: x2 - x1 + PAD * 2, h: y2 - y1 + HEAD + PAD };
    } else {
      const w = Math.max(200, Math.min(4000, Number(a.width) || 800)), h = Math.max(160, Math.min(4000, Number(a.height) || 520));
      geom = spot(c, self, a, w, h);
    }
    const n = c.add('frame', geom, { title, color, createdBy: self.id });
    const kids = c.doc.nodes.filter((x) => x.parent === n.id).length;
    return `Область добавлена: [${n.id}] «${title}» · ${where(n)}${kids ? ` · внутри ${kids} ${plural(kids, 'объект', 'объекта', 'объектов')}` : ' · пустая: добавляйте в неё объекты с параметром area'}`;
  },
  async connect(c, self, t, a) {
    const from = c.node(str(a.from, 'from', 200)), to = c.node(str(a.to, 'to', 200));
    if (!from) throw new Error(`Объекта ${a.from} нет на холсте`);
    if (!to) throw new Error(`Объекта ${a.to} нет на холсте`);
    if (from.id === to.id) throw new Error('Стрелка должна соединять два разных объекта');
    if (c.doc.edges.some((e) => e.from === from.id && e.to === to.id)) return `Стрелка [${from.id}] → [${to.id}] уже есть`;
    const extra = { createdBy: self.id };
    if (typeof a.label === 'string' && a.label.trim()) extra.label = clip(a.label.trim(), 80);
    const e = c.edge(from.id, to.id, extra);
    if (!e) return `Стрелка [${from.id}] → [${to.id}] уже есть`;
    return `Стрелка добавлена: [${from.id}] → [${to.id}]${extra.label ? ` «${extra.label}»` : ''}`;
  },
  async update_text(c, self, t, a) {
    const n = c.node(str(a.id, 'id', 200));
    if (!n) throw new Error(`Объекта ${a.id} нет на холсте`);
    if (n.data?.createdBy !== self.id) throw new Error('Менять можно только объекты, которые вы добавили сами в этом окне чата. Чужие объекты пользователь правит сам — предложите ему правку текстом или добавьте новый стикер рядом.');
    const text = typeof a.text === 'string' ? a.text : '';
    if (text.length > 200000) throw new Error('text: слишком длинный текст');
    switch (n.type) {
      case 'sticky': case 'shape': c.update(n.id, { data: { text } }); break;
      case 'text': c.update(n.id, { data: { html: textHtml(text) } }); break;
      case 'frame': c.update(n.id, { data: { title: text.trim() || 'Область' } }); break;
      case 'note': await native.vault.write(n.data.path, text); c.live && c.view.views.get(n.id)?.inst?.load?.(); return `Заметка [${n.id}] обновлена`;
      default: throw new Error('У этого объекта нет текста');
    }
    return `Текст [${n.id}] обновлён`;
  },
};
export const CANVAS_OPS = Object.keys(ops);
const WRITES = new Set(['create_sticky', 'create_text', 'create_note', 'create_area', 'connect', 'update_text']);

// ---------------- requests from the agents ----------------
const perRun = new Map(); // run → objects added
let notice = null;
// «Агент добавил на холст…»: one message per burst of additions
function tell(view, self, n) {
  if (!notice || notice.id !== self.id) notice = { id: self.id, title: titleOf(self), count: 0 };
  notice.count += n;
  clearTimeout(notice.timer);
  const cur = notice;
  cur.timer = setTimeout(() => { if (notice === cur) notice = null; toast(`«${cur.title}» ${cur.count === 1 ? 'добавил на холст объект' : `добавил на холст ${cur.count} ${plural(cur.count, 'объект', 'объекта', 'объектов')}`} — Ctrl+Z уберёт`, 'info', 4500); }, 900);
}

// target: { nodeId, docId, run } — decided by the main process from the run's token
export async function canvasRequest(view, target, op, args = {}) {
  const fn = Object.hasOwn(ops, op) ? ops[op] : null;
  if (!fn) throw new Error(`Нет такого действия: ${op}`);
  if (state.settings?.canvasTools === false) throw new Error('Пользователь выключил инструменты холста в настройках VibeTabula.');
  const write = WRITES.has(op);
  if (write && op !== 'update_text' && op !== 'connect') {
    const k = perRun.get(target.run) || 0;
    if (k >= MAX_PER_RUN) throw new Error(`За один ответ можно добавить не больше ${MAX_PER_RUN} объектов`);
  }
  const work = async (c) => {
    const self = c.node(target.nodeId);
    if (!self) throw new Error('Окна этого чата больше нет на холсте');
    const before = c.doc.nodes.length;
    const r = await fn(c, self, target, args || {});
    const added = c.doc.nodes.length - before;
    if (added > 0) perRun.set(target.run, (perRun.get(target.run) || 0) + added);
    if (c.live && added > 0) tell(view, self, added);
    return r;
  };
  if (view.doc?.id === target.docId) return work(liveCanvas(view, target.run));
  if (!write) { const doc = await native.canvas.load(target.docId); if (!doc) throw new Error('Холст этого чата не найден'); return work(fileCanvas(doc)); }
  let out;
  await editCanvasFile(target.docId, async (doc) => {
    // the user opened that canvas while the request waited: change it on screen instead
    if (view.doc?.id === target.docId) { out = await work(liveCanvas(view, target.run)); return false; }
    out = await work(fileCanvas(doc));
  });
  return out;
}

export function bindCanvasTools(view) {
  if (!native.canvasTools?.onRequest) return;
  native.canvasTools.onRequest(async ({ id, nodeId, docId, run, op, args }) => {
    try { native.canvasTools.reply(id, { result: await canvasRequest(view, { nodeId, docId, run }, op, args) }); }
    catch (e) { native.canvasTools.reply(id, { error: String(e.message || e) }); }
  });
  native.canvasTools.ready?.();
}

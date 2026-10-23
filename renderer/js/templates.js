// Layout templates: a set of objects with their arrows (an area with stickies, chat windows with
// starter prompts, «Передавать ответ» arrows…) saved once and placed again in one click. Built-in
// ones are «Баг», «Фича» and «Ревью»; your own live in the workspace (state.ws.templates), so they
// sync between computers with it (main/sync.js merges them by id). A template keeps what makes the
// layout, not the work done in it: chats come without their conversation and session, notes keep
// their text and get a new file when placed, folders and copies of projects are not kept.
import { h, icon, toast, prompt, confirmBox, modal, uid, deepClone } from './util.js';
import { state, native } from './state.js';
import { NODE_TYPES } from './nodes.js';
import { vaultIndex } from './vaultIndex.js';

const NOTE_FOLDER = 'Из шаблонов';
const MAX_SIZE = 1_500_000; // characters of JSON: a template is a layout, not an archive
// data that belongs to the work done in an object, not to the layout
const DROP = ['messages', 'sessionId', 'convId', 'ctxHash', 'actualModel', 'worktree', 'compare', 'pendingRelay', 'createdBy', 'cwd', 'changes', 'running', 'draftAtt'];
const SKIP_TYPES = new Set(['diff']); // a changes card belongs to one answer

// ---------------- built-in ----------------
const sticky = (x, y, text, color = 'yellow', w = 440, hh = 200) => ({ type: 'sticky', x, y, w, h: hh, data: { text, color } });
const agent = (x, y, kind, title, mode, draft, w = 520, hh = 760) => ({ type: 'agentchat', x, y, w, h: hh, data: { agentId: kind, kind, title, mode, model: '', ...(draft ? { draft } : {}) } });
function built(id, name, desc, nodes, edges) {
  const ids = nodes.map((n, i) => ({ ...n, id: `${id}_${i}` }));
  return { id, name, desc, builtIn: true, nodes: ids, edges: edges.map(([a, b, extra = {}], i) => ({ id: `${id}_e${i}`, from: `${id}_${a}`, to: `${id}_${b}`, arrow: true, ...extra })) };
}
export const BUILT_IN = [
  built('tpl_bug', 'Баг', 'Описание бага → агент исправляет → второй проверяет исправление', [
    { type: 'frame', x: 0, y: 0, w: 520, h: 760, data: { title: 'Описание бага', color: 'red' } },
    sticky(40, 70, 'Что сломалось:\n', 'pink'),
    sticky(40, 290, 'Как воспроизвести:\n1. \n2. '),
    sticky(40, 510, 'Ожидалось:\n\nНа деле:\n'),
    agent(600, 0, 'claude', 'Исправление бага', 'acceptEdits', 'Найди причину бага по описанию из контекста (область «Описание бага»). Сначала воспроизведи его, потом исправь и добавь тест, который ловит этот баг. В конце коротко: в чём была причина и что изменено.'),
    agent(1200, 0, 'codex', 'Проверка исправления', 'read'),
  ], [[0, 4], [4, 5, { relay: { note: 'Проверь это исправление бага: нет ли регрессий, покрыт ли баг тестом, нет ли такой же ошибки в похожих местах. Ответь списком замечаний.' } }]]),
  built('tpl_feature', 'Фича', 'Описание → план без изменений → реализация по плану, чек-лист готовности', [
    { type: 'frame', x: 0, y: 0, w: 520, h: 760, data: { title: 'Фича', color: 'blue' } },
    sticky(40, 70, 'Зачем:\n', 'green'),
    sticky(40, 290, 'Что должно получиться:\n'),
    sticky(40, 510, 'Ограничения и что не трогать:\n'),
    agent(600, 0, 'claude', 'План фичи', 'plan', 'Составь план реализации фичи из контекста (область «Фича»): шаги, какие файлы меняются, риски и как проверить результат. Ничего не меняй — только план.'),
    agent(1200, 0, 'codex', 'Реализация', 'write'),
    { type: 'widget', x: 600, y: 800, w: 360, h: 300, data: { kind: 'checklist', title: 'Готово, когда', items: ['Работает по описанию', 'Есть тесты', 'Обновлена документация', 'Проверено вручную'].map((text, i) => ({ id: `t${i}`, text, done: false })) } },
  ], [[0, 4], [0, 5], [4, 5, { relay: { note: 'Реализуй этот план. Если что-то в плане не сходится с кодом, скажи об этом до того, как менять.' } }]]),
  built('tpl_review', 'Ревью', 'Что проверить → два агента смотрят изменения с разных сторон, итог на стикере', [
    { type: 'frame', x: 0, y: 0, w: 520, h: 540, data: { title: 'Что проверить', color: 'purple' } },
    sticky(40, 70, 'Ветка или PR:\n'),
    sticky(40, 290, 'На что обратить внимание:\n'),
    agent(600, 0, 'claude', 'Ревью: ошибки и риски', 'default', 'Сделай ревью изменений текущей ветки относительно основной (git diff). Найди ошибки, риски и места без тестов; по каждому — файл, строка и почему это проблема. Ничего не меняй.', 520, 700),
    agent(1200, 0, 'codex', 'Ревью: тесты и стиль', 'read', 'Посмотри изменения текущей ветки относительно основной (git diff): чего не хватает в тестах, что сложно читать или не в стиле проекта. Ничего не меняй, ответь списком.', 520, 700),
    sticky(600, 760, 'Итог ревью:\n', 'green', 1120, 200),
  ], [[0, 3], [0, 4]]),
];

export const userTemplates = () => (state.ws?.templates || []).filter((t) => t && Array.isArray(t.nodes));
export const allTemplates = () => [...BUILT_IN, ...userTemplates()];
const count = (n) => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? 'объект' : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? 'объекта' : 'объектов'}`; };

// ---------------- saving ----------------
// selected objects (an area brings what is inside) → a template; null when there is nothing to keep
export async function templateFrom(view, nodes, name) {
  const all = view.withContents(nodes).filter((n) => !SKIP_TYPES.has(n.type));
  if (!all.length) return null;
  const ids = new Set(all.map((n) => n.id));
  const b = view.bounds(all);
  // areas first (bigger ones first): placed again, they stay under what lies in them
  const order = [...all].sort((a, c) => (a.type === 'frame') !== (c.type === 'frame') ? (a.type === 'frame' ? -1 : 1) : a.type === 'frame' ? c.w * c.h - a.w * a.h : (a.z || 0) - (c.z || 0));
  const out = [];
  for (const n of order) {
    const c = { id: n.id, type: n.type, x: Math.round(n.x - b.x), y: Math.round(n.y - b.y), w: n.w, h: n.h, data: deepClone(n.data || {}) };
    if (n.parent && ids.has(n.parent)) c.parent = n.parent;
    for (const k of DROP) delete c.data[k];
    if (n.type === 'note') {
      let text = '';
      try { text = n.data.path ? await native.vault.read(n.data.path) : ''; } catch {}
      c.data = { title: NODE_TYPES.note.title(n), text };
    }
    if (n.type === 'terminal') c.data = { agentId: n.data.agentId, ...(n.data.extraArgs ? { extraArgs: n.data.extraArgs } : {}) };
    out.push(c);
  }
  const edges = view.doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => { const c = deepClone(e); delete c.createdBy; return c; });
  const tpl = { id: uid('tpl'), name: String(name || 'Шаблон').trim().slice(0, 80) || 'Шаблон', created: Date.now(), nodes: out, edges };
  if (JSON.stringify(tpl).length > MAX_SIZE) throw new Error('Шаблон слишком большой — скорее всего, из-за картинок, вставленных из буфера. Уберите их из выделения или сохраните картинки в хранилище.');
  return tpl;
}

export async function saveTemplate(view, nodes = view.selectedNodes()) {
  if (!nodes.length) { toast('Выделите объекты или область, из которых сделать шаблон', 'warn'); return null; }
  const first = nodes.find((n) => n.type === 'frame');
  const name = await prompt('Название шаблона', first?.data.title || '', 'например Разбор бага');
  if (name == null) return null;
  let tpl;
  try { tpl = await templateFrom(view, nodes, name); } catch (e) { toast(e.message, 'error'); return null; }
  if (!tpl) { toast('В выделении нет объектов для шаблона', 'warn'); return null; }
  state.ws.templates = [...userTemplates(), tpl];
  state.saveWs();
  state.emit('templates');
  toast(`Шаблон «${tpl.name}» сохранён: ${count(tpl.nodes.length)}. Вставить — правый клик по холсту → «Шаблон раскладки…»`, 'ok', 4500);
  return tpl;
}

export async function renameTemplate(id) {
  const t = userTemplates().find((x) => x.id === id);
  if (!t) return;
  const name = await prompt('Название шаблона', t.name);
  if (!name?.trim()) return;
  state.ws.templates = userTemplates().map((x) => (x.id === id ? { ...x, name: name.trim().slice(0, 80) } : x));
  state.saveWs(); state.emit('templates');
}
export async function deleteTemplate(id) {
  const t = userTemplates().find((x) => x.id === id);
  if (!t || !(await confirmBox(`Удалить шаблон «${t.name}»?`, 'Объекты, уже вставленные из него, останутся на холстах. На других компьютерах шаблон тоже пропадёт.', 'Удалить'))) return false;
  state.ws.templates = userTemplates().filter((x) => x.id !== id);
  state.tombstone(id); // so a computer that still has it doesn't bring it back
  state.saveWs(); state.emit('templates');
  return true;
}

// ---------------- placing ----------------
// at: the world point for the middle of the layout (default: the middle of the screen) → new ids
export async function placeTemplate(view, tpl, at = null) {
  const nodes = deepClone(tpl.nodes).filter((n) => NODE_TYPES[n.type] && !SKIP_TYPES.has(n.type));
  if (!nodes.length) return [];
  // notes: a new file with the template's text, so each placed copy is its own note
  for (const n of nodes) {
    if (n.type !== 'note') continue;
    const title = String(n.data.title || 'Заметка').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Заметка';
    try { n.data = { path: await native.vault.create(NOTE_FOLDER, title, n.data.text || '') }; } catch (e) { n.data = { path: '' }; console.warn('template note', e); }
  }
  for (const n of nodes) if (n.type === 'agentchat' || n.type === 'chat') n.data = { ...n.data, messages: [], sessionId: null };
  const b = view.bounds(nodes);
  const c = at || view.centerWorld();
  view.checkpoint();
  const { newIds } = view.insertCopies(nodes, tpl.edges || [], c.x - b.w / 2 - b.x, c.y - b.h / 2 - b.y, { fork: false, numbered: false });
  view.select(newIds);
  view.changed();
  if (nodes.some((n) => n.type === 'note')) vaultIndex.refresh();
  return newIds;
}

// ---------------- the picker ----------------
const PREVIEW_COLOR = { frame: 'var(--accent)', sticky: '#ffd60a', agentchat: '#d9825b', chat: '#10a37f', note: '#8e8e93', text: '#8e8e93', widget: '#34c759', terminal: '#59606f', image: '#5ac8fa', shape: '#5b7cfa' };
function preview(tpl) {
  const nodes = tpl.nodes || [];
  const x1 = Math.min(...nodes.map((n) => n.x)), y1 = Math.min(...nodes.map((n) => n.y));
  const w = Math.max(...nodes.map((n) => n.x + n.w)) - x1, hh = Math.max(...nodes.map((n) => n.y + n.h)) - y1;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `${x1 - 20} ${y1 - 20} ${w + 40} ${hh + 40}`);
  svg.setAttribute('class', 'tpl-preview');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const r = document.createElementNS(ns, 'rect');
    for (const [k, v] of Object.entries({ x: n.x, y: n.y, width: n.w, height: n.h, rx: n.type === 'frame' ? 24 : 14 })) r.setAttribute(k, v);
    r.setAttribute('style', `fill:${PREVIEW_COLOR[n.type] || '#8e8e93'};fill-opacity:${n.type === 'frame' ? 0.12 : 0.55};stroke:${PREVIEW_COLOR[n.type] || '#8e8e93'};stroke-width:${Math.max(4, w / 160)}`);
    svg.append(r);
  }
  for (const e of tpl.edges || []) {
    const a = byId.get(e.from), c = byId.get(e.to);
    if (!a || !c) continue;
    const l = document.createElementNS(ns, 'line');
    for (const [k, v] of Object.entries({ x1: a.x + a.w, y1: a.y + a.h / 2, x2: c.x, y2: c.y + c.h / 2 })) l.setAttribute(k, v);
    l.setAttribute('style', `stroke:${e.relay ? 'var(--accent)' : 'var(--text-dim, #888)'};stroke-width:${Math.max(6, w / 120)};stroke-dasharray:${e.relay ? `${w / 40} ${w / 60}` : 'none'}`);
    svg.append(l);
  }
  return svg;
}

// at: where to put the layout (a right click on the canvas); otherwise the middle of the screen
export function openTemplates(view, { at = null } = {}) {
  const grid = h('div', { class: 'tpl-grid' });
  let close = () => {};
  const paint = () => {
    const card = (t) => {
      const el = h('div', { class: `tpl-card${t.builtIn ? ' built-in' : ''}`, tabindex: 0, 'data-id': t.id, title: t.desc || '' },
        preview(t),
        h('div', { class: 'tpl-name' }, t.name),
        h('div', { class: 'muted small tpl-meta' }, t.builtIn ? `встроенный · ${count(t.nodes.length)}` : count(t.nodes.length)),
        t.builtIn ? null : h('div', { class: 'tpl-actions' },
          h('button', { class: 'icon-btn sm', title: 'Переименовать', html: icon('pen', 12), onclick: async (e) => { e.stopPropagation(); await renameTemplate(t.id); paint(); } }),
          h('button', { class: 'icon-btn sm danger', title: 'Удалить', html: icon('trash', 12), onclick: async (e) => { e.stopPropagation(); if (await deleteTemplate(t.id)) paint(); } })));
      const go = async () => { close(); const ids = await placeTemplate(view, t, at); if (ids.length) toast(`Вставлен шаблон «${t.name}»`, 'ok'); };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return el;
    };
    const mine = userTemplates();
    grid.replaceChildren(
      h('div', { class: 'tpl-section' }, 'Встроенные'), ...BUILT_IN.map(card),
      h('div', { class: 'tpl-section' }, 'Ваши'),
      ...(mine.length ? mine.map(card) : [h('div', { class: 'muted small tpl-empty' }, 'Пока нет. Выделите объекты или область и выберите «Сохранить как шаблон…» в меню по правой кнопке.')]));
  };
  paint();
  const sel = view.selectedNodes();
  const m = modal({
    title: 'Шаблоны раскладки', width: 760, className: 'tpl-modal',
    body: h('div', {}, h('p', { class: 'muted small' }, 'Набор объектов со связями: область с описанием, окна агентов со стартовыми задачами, стрелки «Передавать ответ». Клик — вставить на холст.'), grid),
    actions: [
      { label: sel.length ? `Сохранить выделенное (${count(view.withContents(sel).length)})` : 'Сохранить выделенное', disabled: !sel.length, onClick: () => { saveTemplate(view, sel); return true; } },
      { label: 'Закрыть', primary: true },
    ],
  });
  close = m.close;
  return m;
}

// Search across everything (Ctrl+K): the objects and chat messages of every canvas of every
// project, notes by their text, saved conversations (main/search.js) and the output of the
// terminals open now. Enter goes there: opens the canvas, flies to the object, scrolls a chat to
// the message and highlights the words found.
import { h, icon, modal, toast, debounce } from './util.js';
import { state, native } from './state.js';

const TYPE = { sticky: 'Стикер', text: 'Текст', shape: 'Фигура', frame: 'Область', note: 'Заметка', image: 'Картинка', web: 'Веб-страница', diff: 'Изменения', terminal: 'Терминал', widget: 'Виджет', chat: 'API-чат', agentchat: 'Чат агента' };
const ICON = { sticky: 'sticky', text: 'text', shape: 'rect', frame: 'area', note: 'note', image: 'image', web: 'globe', diff: 'diff', terminal: 'terminal', widget: 'grid', chat: 'chat', agentchat: 'sparkle' };
const LIMIT = { objects: 40, notes: 15, chats: 15, terms: 10 };
const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const matchAll = (q) => { const w = words(q); return (s) => { const low = String(s || '').toLowerCase(); return w.length > 0 && w.every((x) => low.includes(x)); }; };

// every canvas of the workspace: id → { pid, project, canvas }
function canvasPlaces() {
  const out = new Map();
  for (const p of state.ws?.projects || []) for (const c of p.canvases) out.set(c.id, { pid: p.id, project: p.name, canvas: c.name });
  return out;
}

// the words found, painted in an element (CSS Custom Highlight API: the text itself is not changed)
let clearT = null;
export function highlightIn(el, q) {
  if (!el || !window.CSS?.highlights || typeof Highlight === 'undefined') return 0;
  const ws = words(q);
  const ranges = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t && ranges.length < 300; t = walker.nextNode()) {
    const low = t.data.toLowerCase();
    for (const w of ws) for (let i = low.indexOf(w); i >= 0 && ranges.length < 300; i = low.indexOf(w, i + w.length)) { const r = new Range(); r.setStart(t, i); r.setEnd(t, i + w.length); ranges.push(r); }
  }
  CSS.highlights.set('vt-found', new Highlight(...ranges));
  clearTimeout(clearT);
  clearT = setTimeout(() => CSS.highlights.delete('vt-found'), 8000);
  return ranges.length;
}

// the output of the terminals on the canvas now (their text is not saved anywhere)
function terminalHits(view, q) {
  const match = matchAll(q), out = [];
  for (const v of view.views.values()) {
    const inst = v.inst;
    if (!inst?.term?.buffer || out.length >= LIMIT.terms) continue;
    const buf = inst.term.buffer.active;
    for (let i = buf.length - 1; i >= 0 && i >= buf.length - 5000; i--) {
      const line = buf.getLine(i)?.translateToString(true) || '';
      if (!match(line)) continue;
      out.push({ nodeId: v.node?.id || inst.node?.id, line: i, text: line.trim().slice(0, 160) });
      break; // the newest line of each terminal
    }
  }
  return out;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
async function showCanvas(canvasId) {
  if (state.doc?.id === canvasId) return true;
  const place = canvasPlaces().get(canvasId);
  if (!place) { toast('Этого холста больше нет', 'warn'); return false; }
  await state.openCanvas(place.pid, canvasId);
  await nextFrame();
  return true;
}
// fly to an object; a message of a chat window: scrolled to and highlighted
export async function goToObject(app, { canvasId, nodeId, msg = null }, q = '') {
  if (!(await showCanvas(canvasId))) return false;
  const view = app.canvas;
  const n = view.node(nodeId);
  if (!n) { toast('Этого объекта уже нет на холсте', 'warn'); return false; }
  view.focusNode(n.id);
  view.flashNode?.(n.id);
  setTimeout(() => {
    const v = view.views.get(n.id);
    if (msg != null && v?.inst?.revealMessage) v.inst.revealMessage(msg, q);
    else highlightIn(v?.el, q);
  }, 380);
  return true;
}
async function goToTerminal(app, hit, q) {
  const view = app.canvas;
  view.focusNode(hit.nodeId);
  view.flashNode?.(hit.nodeId);
  const term = view.views.get(hit.nodeId)?.inst?.term;
  if (!term) return;
  try {
    term.scrollToLine(Math.max(0, hit.line - Math.floor(term.rows / 2)));
    const line = term.buffer.active.getLine(hit.line)?.translateToString(true) || '';
    const w = words(q)[0] || '';
    const col = line.toLowerCase().indexOf(w);
    if (col >= 0) term.select(col, hit.line, w.length);
  } catch {}
}
// a saved conversation: its window if it is on this canvas, else a new window with it
async function goToConversation(app, hit, q) {
  const view = app.canvas;
  const open = view.doc.nodes.find((n) => (n.type === 'agentchat' || n.type === 'chat') && n.data.convId === hit.id);
  if (open) return goToObject(app, { canvasId: view.doc.id, nodeId: open.id, msg: hit.msg }, q);
  const rec = await native.history.get(hit.id);
  if (!rec) { toast('Этого чата больше нет в истории', 'warn'); return false; }
  const agent = hit.kind === 'agentchat' ? state.settings.agents.find((a) => a.id === (rec.agent || hit.agent) && a.chat) : null;
  const n = hit.kind === 'agentchat' ? app.launchAgentChat({ agentId: agent?.id || 'claude' }) : app.launchChat({ provider: rec.provider || hit.provider || state.settings.defaultProvider || 'openai' });
  await nextFrame();
  const inst = view.views.get(n.id)?.inst;
  inst?.loadConversation?.({ convId: rec.id, messages: rec.messages || [], title: rec.title, sessionId: rec.sessionId, cwd: rec.cwd, model: rec.model, provider: rec.provider });
  return goToObject(app, { canvasId: view.doc.id, nodeId: n.id, msg: hit.msg }, q);
}

function mark(text, q) {
  const out = h('span', { class: 'sr-snip' });
  const ws = words(q);
  const s = String(text || '');
  const low = s.toLowerCase();
  let i = 0;
  while (i < s.length) {
    let best = -1, len = 0;
    for (const w of ws) { const j = low.indexOf(w, i); if (j >= 0 && (best < 0 || j < best)) { best = j; len = w.length; } }
    if (best < 0) { out.append(s.slice(i)); break; }
    out.append(s.slice(i, best), h('mark', {}, s.slice(best, best + len)));
    i = best + len;
  }
  return out;
}

// the rows of the list: headers and hits (each with go())
function buildRows(app, r, terms, q) {
  const places = canvasPlaces();
  const here = state.doc?.id;
  const rows = [];
  const objects = [...(r.objects || [])].filter((o) => places.has(o.canvasId))
    .sort((a, b) => (a.canvasId === here ? 0 : 1) - (b.canvasId === here ? 0 : 1)).slice(0, LIMIT.objects);
  if (objects.length) {
    rows.push({ header: `На холстах · ${objects.length}` });
    for (const o of objects) {
      const p = places.get(o.canvasId);
      const what = o.msg != null ? `${TYPE[o.type] || o.type} «${o.title || 'без названия'}» · ${o.role === 'user' ? 'ваше сообщение' : 'ответ'}` : `${TYPE[o.type] || o.type}${o.title ? ` «${o.title}»` : ''}`;
      rows.push({ icon: ICON[o.type] || 'grid', label: what, hint: o.canvasId === here ? 'этот холст' : `${p.project} / ${p.canvas}`, snippet: o.snippet, go: () => goToObject(app, o, q) });
    }
  }
  if (terms.length) {
    rows.push({ header: `В терминалах · ${terms.length}` });
    for (const t of terms) {
      const n = app.canvas.node(t.nodeId);
      rows.push({ icon: 'terminal', label: `Терминал${n?.data?.title ? ` «${n.data.title}»` : ''}`, hint: 'этот холст', snippet: t.text, go: () => goToTerminal(app, t, q) });
    }
  }
  const notes = (r.notes || []).slice(0, LIMIT.notes);
  if (notes.length) {
    rows.push({ header: `Заметки · ${notes.length}` });
    for (const n of notes) rows.push({ icon: 'note', label: n.name, hint: n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : 'заметка', snippet: n.snippet, go: async () => { await app.openNote(n.path); setTimeout(() => highlightIn(document.querySelector('.note-panel'), q), 300); } });
  }
  const chats = (r.chats || []).slice(0, LIMIT.chats);
  if (chats.length) {
    rows.push({ header: `История чатов · ${chats.length}` });
    for (const c of chats) rows.push({ icon: c.kind === 'agentchat' ? 'sparkle' : 'chat', label: c.title, hint: c.updated ? new Date(c.updated).toLocaleDateString('ru-RU') : '', snippet: c.snippet, go: () => goToConversation(app, c, q) });
  }
  return rows;
}

export function openSearch(app, initial = '') {
  const input = h('input', { class: 'input palette-input search-input', placeholder: 'Поиск по холстам, заметкам, чатам и терминалам', value: initial });
  const status = h('div', { class: 'muted small search-status' });
  const list = h('div', { class: 'palette-list search-list' });
  const m = modal({ title: '', body: h('div', {}, input, status, list), width: 700, className: 'palette search-modal' });
  let rows = [], idx = -1, seq = 0, q = '';
  const items = () => rows.map((r, i) => (r.header ? -1 : i)).filter((i) => i >= 0);
  const paint = () => {
    list.replaceChildren(...rows.map((r, i) => (r.header
      ? h('div', { class: 'sr-head' }, r.header)
      : h('div', { class: `pl-row sr-row${i === idx ? ' active' : ''}`, onclick: () => go(i) },
        h('span', { class: 'pl-ic', html: icon(r.icon, 15) }),
        h('div', { class: 'sr-main' }, h('div', { class: 'sr-label' }, mark(r.label, q)), r.snippet ? mark(r.snippet, q) : null),
        h('span', { class: 'pl-hint' }, r.hint || '')))));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const go = (i) => { const r = rows[i]; if (!r?.go) return; m.close(); r.go(); };
  const run = async () => {
    q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { rows = []; idx = -1; paint(); status.textContent = q ? 'Введите хотя бы 2 буквы' : 'Ищет по всем холстам всех проектов, заметкам, истории чатов и терминалам на этом холсте'; return; }
    status.textContent = 'Ищу…';
    try { state.saveDoc.flush?.(); } catch {}
    let r = { objects: [], notes: [], chats: [] };
    try { r = native.search?.all ? await native.search.all(q, { canvasIds: [...canvasPlaces().keys()] }) : r; } catch (e) { console.warn('search', e); }
    if (my !== seq) return; // a newer query is running
    rows = buildRows(app, r, terminalHits(app.canvas, q), q);
    idx = items()[0] ?? -1;
    const n = items().length;
    status.textContent = n ? `Найдено: ${n}${n >= 40 ? '+' : ''} · Enter — перейти` : `Ничего не найдено по «${q}»`;
    paint();
  };
  const soon = debounce(run, 160);
  input.addEventListener('input', soon);
  input.addEventListener('keydown', (e) => {
    const it = items();
    const at = it.indexOf(idx);
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = it[Math.min(it.length - 1, at + 1)] ?? idx; paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); idx = it[Math.max(0, at - 1)] ?? idx; paint(); }
    // typed faster than the search: search for what is in the box now, then go
    if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim() !== q) { soon.cancel(); run().then(() => go(idx)); } else go(idx); }
  });
  run();
  setTimeout(() => { input.focus(); input.select(); }, 30);
  return m;
}

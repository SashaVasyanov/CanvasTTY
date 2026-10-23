// What a chat window gets from the canvas: objects joined to it by an arrow and objects named in
// the message with @. An area brings everything inside it (notes, stickies, pictures, nested
// areas…). Text goes into the prompt, pictures are attached to the message as files.
import { h, icon } from './util.js';
import { native } from './state.js';
import { htmlText } from './sanitize.js';
import { NODE_TYPES } from './nodes.js';
import { vaultIndex } from './vaultIndex.js';

export const CONTEXT_TYPES = ['frame', 'note', 'sticky', 'text', 'shape', 'image', 'chat', 'agentchat', 'terminal', 'web', 'widget'];
const TYPE_LABEL = { frame: 'Область', note: 'Заметка', sticky: 'Стикер', text: 'Текст', shape: 'Фигура', image: 'Картинка', chat: 'API-чат', agentchat: 'Чат агента', terminal: 'Терминал', web: 'Ссылка', widget: 'Виджет' };
const TYPE_ICON = { frame: 'area', note: 'note', sticky: 'sticky', text: 'text', shape: 'rect', image: 'image', chat: 'chat', agentchat: 'sparkle', terminal: 'terminal', web: 'globe', widget: 'grid' };
const MAX_IMAGES = 12;
const MAX_TEXT = 80_000;
const MAX_NOTE = 20_000;

export const titleOf = (n) => String(NODE_TYPES[n.type]?.title?.(n) || TYPE_LABEL[n.type] || n.type).replace(/\s+/g, ' ').trim();
const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
const dist = (a, b) => { const p = center(a), q = center(b); return Math.hypot(p.x - q.x, p.y - q.y); };

// objects that can be named with @ from this chat, nearest first
export function mentionables(view, selfId) {
  const self = view.node(selfId);
  return view.doc.nodes
    .filter((n) => n.id !== selfId && CONTEXT_TYPES.includes(n.type))
    .map((n) => ({ node: n, title: titleOf(n), type: n.type, d: self ? dist(self, n) : 0 }))
    .filter((c) => c.title)
    .sort((a, b) => a.d - b.d);
}

// @Название in the text → objects (the longest title wins; equal titles → the nearest object)
export function findMentions(view, selfId, text) {
  if (!text || !text.includes('@')) return [];
  const lower = text.toLowerCase();
  const taken = [];
  const found = new Map();
  const cands = mentionables(view, selfId).sort((a, b) => b.title.length - a.title.length || a.d - b.d);
  for (const c of cands) {
    const needle = '@' + c.title.toLowerCase();
    let i = lower.indexOf(needle);
    while (i >= 0) {
      const end = i + needle.length;
      const next = text[end];
      const free = !taken.some(([a, b]) => i < b && end > a);
      if (free && (next === undefined || !/[\p{L}\p{N}_]/u.test(next))) {
        taken.push([i, end]);
        if (![...found.values()].some((f) => f.title.toLowerCase() === c.title.toLowerCase())) found.set(c.node.id, c);
      }
      i = lower.indexOf(needle, i + 1);
    }
  }
  return [...found.values()].map((c) => c.node);
}

// (an arrow that passes answers between chats is not context: the answer arrives as a message)
export const linkedNodes = (view, selfId) => view.doc.edges.filter((e) => (e.from === selfId || e.to === selfId) && !e.relay)
  .map((e) => view.node(e.from === selfId ? e.to : e.from)).filter((n) => n && CONTEXT_TYPES.includes(n.type));

// "Карты · 4 картинки, 1 заметка" for the chips
function areaSummary(view, f) {
  const inside = view.descendants(f).filter((n) => CONTEXT_TYPES.includes(n.type));
  const count = {};
  for (const n of inside) count[n.type] = (count[n.type] || 0) + 1;
  const words = { image: ['картинка', 'картинки', 'картинок'], note: ['заметка', 'заметки', 'заметок'], sticky: ['стикер', 'стикера', 'стикеров'], text: ['текст', 'текста', 'текстов'], frame: ['область', 'области', 'областей'] };
  const pl = (k, [a, b, c]) => { const m10 = k % 10, m100 = k % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const bits = Object.entries(count).map(([t, k]) => `${k} ${words[t] ? pl(k, words[t]) : (TYPE_LABEL[t] || t).toLowerCase()}`);
  return bits.length ? bits.join(', ') : 'пусто';
}

// one object as text; pictures are collected for attaching
async function describe(view, n, images, depth = 0) {
  const t = titleOf(n);
  const hh = depth ? '####' : '###';
  try {
    switch (n.type) {
      case 'note': {
        if (!n.data.path) return '';
        let md = await native.vault.read(n.data.path);
        if (md.length > MAX_NOTE) md = md.slice(0, MAX_NOTE) + '\n…(заметка обрезана)';
        return `${hh} Заметка «${t}»\n${md}`;
      }
      case 'sticky': return n.data.text ? `${hh} Стикер\n${n.data.text}` : '';
      case 'shape': return n.data.text ? `${hh} Фигура\n${n.data.text}` : '';
      case 'text': { const s = htmlText(n.data.html); return s.trim() ? `${hh} Текст\n${s}` : ''; }
      case 'image': {
        if (!images) return `${hh} Картинка «${t}»`;
        if (images.length >= MAX_IMAGES) return `${hh} Картинка «${t}» (не приложена: больше ${MAX_IMAGES} картинок)`;
        images.push(n);
        return `${hh} Картинка «${t}» — приложена к сообщению`;
      }
      case 'chat': case 'agentchat': {
        const last = [...(n.data.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
        return last ? `${hh} Ответ из чата «${t}»\n${last.content}` : '';
      }
      case 'terminal': {
        const tail = view.views.get(n.id)?.inst?.tailText?.();
        return tail ? `${hh} Вывод терминала «${t}» (последние строки)\n\`\`\`\n${tail}\n\`\`\`` : '';
      }
      case 'web': return n.data.url ? `${hh} Ссылка\n${n.data.url}` : '';
      case 'widget': {
        const d = n.data;
        if (d.kind === 'checklist' && d.items?.length) return `${hh} Чек-лист «${d.title || 'Задачи'}»\n${d.items.map((x) => `- [${x.done ? 'x' : ' '}] ${x.text}`).join('\n')}`;
        if (d.kind === 'calendar' && d.notes && Object.keys(d.notes).length) return `${hh} Календарь: заметки по дням\n${Object.entries(d.notes).sort().map(([k, v]) => `- ${k}${v.text ? `: ${v.text}` : ''}`).join('\n')}`;
        if (d.kind === 'countdown') return `${hh} До события «${d.title || ''}»: ${d.date || ''}`;
        return '';
      }
      case 'frame': {
        const parts = [`${depth ? '###' : '##'} Область «${t}»`];
        for (const c of view.doc.nodes.filter((x) => x.parent === n.id && CONTEXT_TYPES.includes(x.type)).sort((a, b) => a.y - b.y || a.x - b.x)) {
          const s = await describe(view, c, images, depth + 1);
          if (s) parts.push(s);
        }
        return parts.length > 1 ? parts.join('\n\n') : `${parts[0]}\n(пусто)`;
      }
      default: return '';
    }
  } catch { return ''; }
}

// one object as text for the agents' canvas tools (renderer/js/canvasTools.js); pictures are not sent
export const describeObject = (view, n) => describe(view, n, null, 0);

// text + pictures of a set of objects (objects inside an area that is also in the set come once)
export async function collect(view, nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  const inArea = (n) => { let p = n.parent; while (p) { if (ids.has(p)) return true; p = view.node(p)?.parent; } return false; };
  const images = [];
  const parts = [];
  for (const n of nodes.filter((x) => !inArea(x))) { const s = await describe(view, n, images); if (s) parts.push(s); }
  let text = parts.join('\n\n');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n\n…(контекст обрезан)';
  const sig = `${text.length}|${text.slice(0, 300)}|${text.slice(-300)}|${images.map((i) => i.data.vault || (i.data.src || '').length).join(',')}`;
  return { text, images, sig, nodes };
}

// pictures from the canvas → attachments of the message (copied once per app session)
const attCache = new Map();
export async function imagesToAttachments(images) {
  const out = [];
  for (const n of images) {
    try {
      // a picture from the vault is copied file to file by the main process (fast for big images)
      if (n.data.vault && vaultIndex.root && native.attach?.importPath) {
        const key = `vault|${n.data.vault}`;
        if (!attCache.has(key)) attCache.set(key, native.attach.importPath(`${vaultIndex.root.replace(/[\\/]+$/, '')}/${n.data.vault}`));
        try { out.push(await attCache.get(key)); continue; } catch { attCache.delete(key); }
      }
      const url = n.data.vault ? await native.vault.readAsset(n.data.vault) : n.data.src;
      if (!url) continue;
      const key = `${n.data.vault || ''}|${url.length}|${url.slice(-64)}`;
      if (!attCache.has(key)) {
        const blob = await (await fetch(url)).blob();
        let name = titleOf(n).replace(/[\\/:*?"<>|]/g, '_');
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
        attCache.set(key, native.attach.saveBytes({ name, bytes: new Uint8Array(await blob.arrayBuffer()) }));
      }
      out.push(await attCache.get(key));
    } catch (e) { attCache.clear(); console.warn('context image', e); }
  }
  return out;
}

// Everything a message needs: linked objects (sent again only when they changed since the last
// message of this session) and objects named with @ (always sent with that message).
export async function chatContext(view, selfId, text, lastSig) {
  const linked = linkedNodes(view, selfId);
  const mentioned = findMentions(view, selfId, text).filter((n) => !linked.some((l) => l.id === n.id));
  const L = await collect(view, linked);
  const M = await collect(view, mentioned);
  const sendLinked = !!L.text && L.sig !== lastSig;
  const pieces = [sendLinked ? L.text : '', M.text].filter(Boolean);
  const images = [...(sendLinked ? L.images : []), ...M.images];
  const labels = [...(sendLinked ? linked : []), ...mentioned].map((n) => (n.type === 'frame' ? `${titleOf(n)} (${areaSummary(view, n)})` : titleOf(n)));
  return { text: pieces.join('\n\n'), images, labels, linkedSig: L.text ? L.sig : null };
}

// ---------------- chips under the chat: what goes to the agent ----------------
export function renderContextRow(row, view, selfId, text = '') {
  const linked = linkedNodes(view, selfId);
  const mentioned = findMentions(view, selfId, text).filter((n) => !linked.some((l) => l.id === n.id));
  row.replaceChildren();
  if (!linked.length && !mentioned.length) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.append(h('span', { class: 'muted' }, 'Контекст:'));
  const chip = (n, at) => {
    const label = titleOf(n);
    const extra = n.type === 'frame' ? ` · ${areaSummary(view, n)}` : '';
    return h('span', { class: `ctx-chip${at ? ' at' : ''}`, title: `${TYPE_LABEL[n.type] || ''} «${label}»${extra}${at ? '\nупомянут через @' : '\nсоединён стрелкой'}`, onclick: () => view.focusNode(n.id) },
      h('span', { class: 'ctx-ic', html: icon(TYPE_ICON[n.type] || 'grid', 11) }), `${at ? '@' : ''}${label.length > 28 ? label.slice(0, 27) + '…' : label}${extra}`);
  };
  for (const n of linked) row.append(chip(n, false));
  for (const n of mentioned) row.append(chip(n, true));
}

// a short line in the sent message: what was attached from the canvas
export function renderContextNote(labels) {
  if (!labels?.length) return null;
  return h('div', { class: 'msg-ctx', title: labels.join('\n') }, h('span', { html: icon('link', 11) }), `Контекст: ${labels.join(', ')}`);
}

// ---------------- @ in the input: pick an object ----------------
export function attachMentions(input, { view, selfId, onChange }) {
  let pop = null, items = [], idx = 0, start = -1;
  const close = () => { pop?.remove(); pop = null; start = -1; };
  const query = () => {
    const before = input.value.slice(0, input.selectionStart);
    const m = /(^|[\s(«"'])@([^\n@]{0,40})$/u.exec(before);
    return m ? { q: m[2], at: before.length - m[2].length - 1 } : null;
  };
  const pick = (c) => {
    const end = input.selectionStart;
    const ins = `@${c.title} `;
    input.value = input.value.slice(0, start) + ins + input.value.slice(end);
    const caret = start + ins.length;
    input.setSelectionRange(caret, caret);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const render = () => {
    pop.replaceChildren(h('div', { class: 'mention-head' }, 'Упомянуть объект с холста'),
      ...items.map((c, i) => {
        const row = h('div', { class: `menu-item${i === idx ? ' active' : ''}` },
          h('span', { class: 'menu-ic', html: icon(TYPE_ICON[c.type] || 'grid', 14) }),
          h('span', { class: 'menu-label' }, c.title.length > 48 ? c.title.slice(0, 47) + '…' : c.title),
          h('span', { class: 'menu-kbd' }, TYPE_LABEL[c.type] || ''));
        row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
        row.addEventListener('mousemove', () => { if (idx !== i) { idx = i; render(); } });
        return row;
      }));
    if (!items.length) pop.append(h('div', { class: 'mention-empty' }, 'Ничего не найдено'));
  };
  const update = () => {
    const q = query();
    if (!q) { close(); return; }
    const needle = q.q.toLowerCase();
    const all = mentionables(view, selfId);
    // a finished mention ("@Название " and the text after it) does not open the list again
    if (all.some((c) => needle.startsWith(`${c.title.toLowerCase()} `))) { close(); return; }
    items = all.filter((c) => !needle || c.title.toLowerCase().includes(needle)).slice(0, 8);
    if (!items.length && /\s/.test(needle)) { close(); return; } // just a sentence after an @
    start = q.at;
    if (!pop) {
      pop = h('div', { class: 'menu mention-pop' });
      pop.addEventListener('mousedown', (e) => e.preventDefault());
      document.body.append(pop);
    }
    idx = Math.min(idx, Math.max(0, items.length - 1));
    render();
    const r = input.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
  };
  input.addEventListener('input', () => { update(); onChange?.(); });
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
  return {
    // returns true when the key was used by the list (Enter must not send the message then)
    handleKey(e) {
      if (!pop) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; render(); } return true; }
      if ((e.key === 'Enter' || e.key === 'Tab') && items.length) { e.preventDefault(); pick(items[idx]); return true; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
      return false;
    },
    close,
  };
}

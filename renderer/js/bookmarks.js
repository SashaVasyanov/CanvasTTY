// View bookmarks: Ctrl+Shift+1…9 remembers where you look on this canvas (the place and the zoom),
// Ctrl+1…9 flies back. They live in the canvas file (doc.bookmarks), so every canvas has its own,
// and sync between computers merges them by slot like objects (renderer/js/merge.js, main/sync.js).
// Listed in the command palette, the menu of the canvas and the bookmark button by the zoom buttons.
//   doc.bookmarks: [{ id: 'b3', slot: 3, name: 'Сборка', named?: true, x, y, z }]
//   x, y: the world point in the middle of the screen — the same place on a screen of another size;
//   named: the user gave the name (kept when the slot is saved again)
import { toast, prompt } from './util.js';
import { state } from './state.js';

export const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const clip = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

export const bookmarks = (view) => (Array.isArray(view.doc?.bookmarks) ? view.doc.bookmarks : []).filter((b) => b && SLOTS.includes(b.slot)).sort((a, b) => a.slot - b.slot);
export const bookmarkAt = (view, slot) => bookmarks(view).find((b) => b.slot === slot) || null;
const freeSlot = (view) => SLOTS.find((s) => !bookmarkAt(view, s)) || null;

function middle(view) {
  const r = view.rect(), { x, y, z } = view.vp;
  return { x: (r.width / 2 - x) / z, y: (r.height / 2 - y) / z, z };
}
// a name from what is in the middle of the screen: the smallest titled area around it, else the
// nearest window, note or sticky on screen
function autoName(view, c, slot) {
  const inside = (n, p) => p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
  const title = (n) => clip(view.views.get(n.id)?.def?.title?.(n) || '');
  const frame = view.doc.nodes.filter((n) => n.type === 'frame' && n.data?.title && inside(n, c)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (frame) return clip(frame.data.title);
  const r = view.rect(), half = { w: r.width / 2 / c.z, h: r.height / 2 / c.z };
  const screen = { x: c.x - half.w, y: c.y - half.h, w: half.w * 2, h: half.h * 2 };
  const onScreen = (n) => n.x < screen.x + screen.w && n.x + n.w > screen.x && n.y < screen.y + screen.h && n.y + n.h > screen.y;
  const near = view.doc.nodes
    .filter((n) => ['agentchat', 'chat', 'terminal', 'note', 'sticky', 'text', 'web', 'frame'].includes(n.type) && onScreen(n) && title(n))
    .map((n) => ({ n, d: Math.hypot(n.x + n.w / 2 - c.x, n.y + n.h / 2 - c.y) }))
    .sort((a, b) => a.d - b.d)[0];
  return near ? title(near.n) : `Вид ${slot}`;
}

function write(view, next) {
  view.doc.bookmarks = next.sort((a, b) => a.slot - b.slot);
  state.touch();
  view.emit?.('bookmarks');
}

export function saveBookmark(view, slot) {
  if (!SLOTS.includes(slot)) return null;
  const c = middle(view), old = bookmarkAt(view, slot);
  const b = { id: `b${slot}`, slot, name: old?.named ? old.name : autoName(view, c, slot), ...(old?.named ? { named: true } : {}), x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, z: Math.round(c.z * 1000) / 1000 };
  write(view, [...bookmarks(view).filter((x) => x.slot !== slot), b]);
  toast(`Закладка ${slot} «${b.name}» запомнена — вернуться: Ctrl+${slot}`, 'ok');
  return b;
}
// into the first free slot (palette, menu); all nine taken → says how to replace one
export function saveToFree(view) {
  const slot = freeSlot(view);
  if (!slot) { toast('Все 9 закладок заняты — замените любую: Ctrl+Shift+цифра', 'warn'); return null; }
  return saveBookmark(view, slot);
}

export function goBookmark(view, slot) {
  const b = bookmarkAt(view, slot);
  if (!b) { toast(`Закладки ${slot} на этом холсте нет. Запомнить этот вид — Ctrl+Shift+${slot}`, 'warn'); return false; }
  const r = view.rect(), z = Math.min(Math.max(Number(b.z) || 1, 0.08), 3); // canvas.js MIN_Z … MAX_Z
  view.animateTo({ z, x: r.width / 2 - b.x * z, y: r.height / 2 - b.y * z });
  toast(`Закладка ${slot} · ${b.name}`, 'info', 1400);
  return true;
}

export async function renameBookmark(view, slot) {
  const b = bookmarkAt(view, slot);
  if (!b) return;
  const name = await prompt(`Название закладки ${slot}`, b.name);
  if (name == null) return;
  const v = clip(name, 60);
  const next = bookmarks(view).map((x) => (x.slot === slot ? (v ? { ...x, name: v, named: true } : { ...x, name: `Вид ${slot}`, named: undefined }) : x));
  for (const x of next) if (x.named === undefined) delete x.named;
  write(view, next);
}

export function deleteBookmark(view, slot) {
  if (!bookmarkAt(view, slot)) return;
  write(view, bookmarks(view).filter((x) => x.slot !== slot));
  toast(`Закладка ${slot} удалена`);
}

// the menu «Закладки вида» (right click on the canvas, the button by the zoom buttons)
export function bookmarkItems(view) {
  const list = bookmarks(view);
  return [
    ...(list.length ? list.map((b) => ({ label: `${b.slot} · ${b.name}`, icon: 'bookmark', kbd: `Ctrl+${b.slot}`, onClick: () => goBookmark(view, b.slot) }))
      : [{ label: 'Закладок пока нет — Ctrl+Shift+1…9', disabled: true }]),
    '-',
    { label: 'Запомнить этот вид', icon: 'plus', children: SLOTS.map((s) => { const b = bookmarkAt(view, s); return { label: b ? `${s} · вместо «${b.name}»` : `${s} · свободна`, kbd: `Ctrl+Shift+${s}`, onClick: () => saveBookmark(view, s) }; }) },
    list.length ? { label: 'Переименовать', icon: 'pencil', children: list.map((b) => ({ label: `${b.slot} · ${b.name}`, onClick: () => renameBookmark(view, b.slot) })) } : { label: 'Переименовать', icon: 'pencil', disabled: true },
    list.length ? { label: 'Удалить', icon: 'trash', children: list.map((b) => ({ label: `${b.slot} · ${b.name}`, danger: true, onClick: () => deleteBookmark(view, b.slot) })) } : { label: 'Удалить', icon: 'trash', disabled: true },
  ];
}

// Ctrl+1…9 go, Ctrl+Shift+1…9 remember (the digit keys, any keyboard layout; the number pad too)
export function bookmarkKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
  return m ? { slot: Number(m[1]), save: e.shiftKey } : null;
}

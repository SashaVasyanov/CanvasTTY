// «Ждут вас»: agent and API chats that finished, wait for a permission, failed or broke off while
// you were not looking at them — on any canvas of any project. One entry per chat window (the
// newest event wins). An entry goes away when you open it from the list, click into the window or
// send it a new message. Kept per computer (localStorage), so it survives a restart and does not
// travel with sync. When the app is not in focus, a system notification (and a flashing taskbar
// button) says that an agent is done; click → straight to the window.
import { state, native, PROVIDER_META, providerName } from './state.js';
import { bus } from './util.js';

const KEY = 'vt:inbox';
const MAX = 50;

export const INBOX_KINDS = {
  done: { label: 'Готово', cls: 'ok' },
  wait: { label: 'Нужно разрешение', cls: 'wait' },
  error: { label: 'Ошибка', cls: 'err' },
  interrupted: { label: 'Прервано', cls: 'wait' },
  background: { label: 'Готово в фоне', cls: 'ok' },
};

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

class Inbox {
  constructor() { this.items = load(); }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.items)); } catch {} bus.emit('inbox'); }
  get count() { return this.items.length; }
  has(nodeId) { return this.items.some((x) => x.nodeId === nodeId); }

  // item: { nodeId, docId, kind, title, text, type, agentId, provider }
  add(item, { notify = true } = {}) {
    if (!item?.nodeId || !INBOX_KINDS[item.kind]) return;
    const p = projectOf(item.docId);
    const entry = { ...item, projectId: p?.id || null, where: where(item.docId), text: preview(item.text), ts: Date.now() };
    this.items = [entry, ...this.items.filter((x) => x.nodeId !== item.nodeId)].slice(0, MAX);
    this.save();
    if (notify) this.notify(entry);
  }
  remove(nodeId) {
    if (!this.has(nodeId)) return;
    this.items = this.items.filter((x) => x.nodeId !== nodeId);
    this.save();
  }
  clear() { this.items = []; this.save(); }

  notify(e) {
    if (state.settings?.notifyAgents === false) return;
    if (document.hasFocus() && !document.hidden) return;
    native.win?.attention?.(); // the taskbar button flashes until the window is focused
    try {
      const n = new Notification(`${e.title}: ${INBOX_KINDS[e.kind].label.toLowerCase()}`, { body: e.text || e.where || '', icon: 'assets/logo64.png', tag: `vt-${e.nodeId}`, silent: false });
      n.onclick = () => { native.win?.focus?.(); window.focus(); bus.emit('inbox:open', e); n.close(); };
    } catch {}
  }
}

export const inbox = new Inbox();

export function projectOf(docId) { return state.ws?.projects?.find((p) => p.canvases.some((c) => c.id === docId)) || null; }
// "Проект / Canvas" (only the canvas when there is one project)
export function where(docId) {
  const p = projectOf(docId);
  const c = p?.canvases.find((x) => x.id === docId);
  if (!p || !c) return '';
  return state.ws.projects.length > 1 ? `${p.name} / ${c.name}` : c.name;
}
// the first words of the answer without markdown markers (snake_case names stay as they are)
const preview = (t) => String(t || '').replace(/\*\*|__|`+/g, '').replace(/^\s*(#+|>)\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 140);

// the badge of the window: the agent's or the API provider's
export function badgeOf(item) {
  if (item.type === 'chat') { const m = PROVIDER_META[item.provider] || PROVIDER_META.custom || {}; return { mono: m.mono || 'AI', color: m.color, dark: m.dark, name: providerName(item.provider || 'openai') }; }
  const a = state.agent(item.agentId);
  return { mono: a.mono, color: a.color, dark: a.dark, name: a.name };
}

// "5 мин назад"
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 50) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

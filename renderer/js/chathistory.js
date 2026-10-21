// Conversation history for chat windows: a panel on the left, like in the ChatGPT / Claude apps.
// "VibeTabula" lists conversations made in this app; for agent windows a second tab lists the
// sessions Claude Code / Codex keep on disk (also those started in a terminal) and resumes them.
import { h, icon, uid, toast, debounce } from './util.js';
import { native } from './state.js';

const DAY = 86400000;
function groupLabel(ts) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const t = d0.getTime();
  if (ts >= t) return 'Сегодня';
  if (ts >= t - DAY) return 'Вчера';
  if (ts >= t - 7 * DAY) return 'За неделю';
  if (ts >= t - 30 * DAY) return 'За месяц';
  return 'Раньше';
}
const timeLabel = (ts) => {
  const d = new Date(ts);
  return Date.now() - ts < DAY && d.getDate() === new Date().getDate()
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;

// ---------------- saving ----------------
// Every chat window owns a conversation id; the conversation is written to history after
// each answer, so the list always contains the current chat too.
export function saveConversation(inst) {
  const n = inst.view.node(inst.node.id) || inst.node;
  const msgs = (n.data.messages || []).filter((m) => !m.running);
  if (!msgs.length || !native.history) return;
  let convId = n.data.convId;
  if (!convId) { convId = uid('cv'); inst.view.setData(n.id, { convId }); }
  const isAgent = n.type === 'agentchat';
  native.history.save({
    id: convId,
    kind: n.type,
    agent: isAgent ? inst.kind : n.data.provider || 'openai',
    title: n.data.title && n.data.title !== 'Новый чат' ? n.data.title : '',
    model: (isAgent ? n.data.actualModel || n.data.model : n.data.model) || '',
    cwd: isAgent ? inst.cwd : '',
    sessionId: isAgent ? n.data.sessionId || null : null,
    provider: isAgent ? undefined : n.data.provider,
    messages: msgs,
  }).catch(() => {});
}

// ---------------- panel ----------------
export class ChatHistory {
  constructor(inst) {
    this.inst = inst;
    this.isAgent = inst.node.type === 'agentchat';
    this.tab = 'app';
    this.onlyHere = true;
    this.button = h('button', { class: 'icon-btn sm hist-btn no-drag', title: 'История чатов', html: icon('sidebar', 15), onclick: (e) => { e.stopPropagation(); this.toggle(); } });
    this.search = h('input', { class: 'input sm hist-search no-drag', placeholder: 'Поиск по чатам' });
    this.list = h('div', { class: 'hist-list scrollable' });
    this.tabs = h('div', { class: 'hist-tabs' });
    this.foot = h('div', { class: 'hist-foot' });
    this.panel = h('div', { class: 'hist-panel no-drag' },
      h('div', { class: 'hist-head' },
        h('b', {}, 'История'),
        h('span', { class: 'flex' }),
        h('button', { class: 'btn sm hist-new', onclick: () => this.newChat() }, h('span', { html: icon('plus', 13) }), 'Новый чат'),
        h('button', { class: 'icon-btn sm', title: 'Закрыть', html: icon('x', 14), onclick: () => this.close() })),
      this.tabs, this.search, this.list, this.foot);
    this.back = h('div', { class: 'hist-back', onclick: () => this.close() });
    this.search.addEventListener('input', debounce(() => this.render(), 120));
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    this.panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }
  get kind() { return this.inst.kind; }
  get cliName() { return this.kind === 'codex' ? 'Codex' : 'Claude Code'; }

  toggle() { this.isOpen ? this.close() : this.open(); }
  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    saveConversation(this.inst);
    this.inst.root.append(this.back, this.panel);
    requestAnimationFrame(() => this.panel.classList.add('open'));
    this.button.classList.add('active');
    this.renderTabs();
    await this.load();
    this.search.focus();
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.classList.remove('open');
    this.button.classList.remove('active');
    this.back.remove();
    setTimeout(() => { if (!this.isOpen) this.panel.remove(); }, 160);
  }

  renderTabs() {
    this.tabs.replaceChildren();
    if (!this.isAgent) { this.tabs.style.display = 'none'; return; }
    const mk = (id, label) => h('button', { class: `hist-tab ${this.tab === id ? 'on' : ''}`, onclick: () => { this.tab = id; this.renderTabs(); this.load(); } }, label);
    this.tabs.append(mk('app', 'В VibeTabula'), mk('cli', `Сессии ${this.cliName}`));
  }

  async load() {
    this.list.replaceChildren(h('div', { class: 'hist-empty' }, 'Загрузка…'));
    try {
      if (this.tab === 'app') {
        const q = this.isAgent ? { kind: 'agentchat', agent: this.kind } : { kind: 'chat' };
        this.items = ((await native.history?.list(q)) || []).map((r) => ({ ...r, source: 'app' }));
      } else {
        this.items = (await native.sessions?.list(this.kind, { cwd: this.inst.cwd })) || [];
      }
    } catch (e) { this.items = []; }
    this.render();
  }

  render() {
    const q = this.search.value.trim().toLowerCase();
    const cur = this.inst.view.node(this.inst.node.id)?.data || {};
    let items = this.items || [];
    const cliHere = this.tab === 'cli' ? items.filter((s) => s.here) : null;
    if (this.tab === 'cli' && this.onlyHere && cliHere.length) items = cliHere;
    if (q) items = items.filter((r) => (r.title || '').toLowerCase().includes(q) || (r.cwd || '').toLowerCase().includes(q));
    this.list.replaceChildren();
    if (!items.length) {
      this.list.append(h('div', { class: 'hist-empty' }, q ? 'Ничего не найдено'
        : this.tab === 'app' ? 'Здесь появятся ваши чаты. Каждый разговор сохраняется автоматически.'
          : `Сессий ${this.cliName} не найдено. Они появятся после работы с агентом в окне чата или в терминале.`));
    }
    let lastGroup = '';
    for (const r of items) {
      const g = groupLabel(r.updated || r.created || 0);
      if (g !== lastGroup) { lastGroup = g; this.list.append(h('div', { class: 'hist-group' }, g)); }
      const active = r.source === 'app' ? r.id === cur.convId : r.sessionId && r.sessionId === cur.sessionId;
      const meta = [timeLabel(r.updated || r.created)];
      if (r.source === 'app') { if (r.model) meta.push(r.model); if (r.count) meta.push(`${r.count} сообщ.`); }
      if (r.cwd && (r.source !== 'app' ? !r.here || !this.onlyHere : r.cwd !== this.inst.cwd)) meta.push(`📁 ${baseName(r.cwd)}`);
      const item = h('div', { class: `hist-item ${active ? 'active' : ''}`, title: r.cwd ? `${r.title}\n${r.cwd}` : r.title, onclick: () => this.openItem(r) },
        h('div', { class: 'hist-title' }, r.title || 'Без названия'),
        h('div', { class: 'hist-meta' }, meta.join(' · ')));
      if (r.source === 'app') {
        item.append(h('button', { class: 'hist-del', title: 'Удалить из истории', html: icon('trash', 12), onclick: async (e) => { e.stopPropagation(); await native.history.remove(r.id); this.items = this.items.filter((x) => x !== r); this.render(); } }));
      }
      this.list.append(item);
    }
    this.foot.replaceChildren();
    if (this.tab === 'cli' && cliHere && cliHere.length && cliHere.length < (this.items || []).length) {
      this.foot.append(h('label', { class: 'hist-check' },
        h('input', { type: 'checkbox', checked: this.onlyHere, onchange: (e) => { this.onlyHere = e.target.checked; this.render(); } }),
        `Только папка ${baseName(this.inst.cwd)}`));
    } else if (this.tab === 'cli') {
      this.foot.append(h('div', { class: 'muted small' }, 'Сессия продолжится в своей папке'));
    }
  }

  async openItem(r) {
    if (this.inst.isBusy()) { toast('Дождитесь ответа или остановите его'); return; }
    saveConversation(this.inst);
    try {
      if (r.source === 'app') {
        const rec = await native.history.get(r.id);
        if (!rec) { toast('Чат не найден'); return; }
        this.inst.loadConversation({ convId: rec.id, messages: rec.messages, title: rec.title, sessionId: rec.sessionId, cwd: rec.cwd, model: rec.model, provider: rec.provider });
      } else {
        const s = await native.sessions.read(this.kind, r.file);
        if (!s.messages.length) { toast('В этой сессии нет сообщений'); return; }
        this.inst.loadConversation({ convId: uid('cv'), messages: s.messages, title: r.title, sessionId: s.sessionId || r.sessionId, cwd: s.cwd || r.cwd, actualModel: s.model });
        toast(`Сессия ${this.cliName} открыта — следующее сообщение продолжит её`);
      }
      this.close();
    } catch (e) { toast('Не удалось открыть: ' + (e.message || e), 'error'); }
  }

  newChat() {
    if (this.inst.isBusy()) { toast('Дождитесь ответа или остановите его'); return; }
    saveConversation(this.inst);
    this.inst.loadConversation({ convId: null, messages: [], title: '', sessionId: null });
    this.close();
    this.inst.edit?.();
  }
}

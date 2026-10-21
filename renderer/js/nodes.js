// Node type definitions for the canvas.
import { h, icon, badge, esc, bus, toast, prompt, debounce, throttle, uid, readFileAsDataURL, keyName } from './util.js';
import { cssColor, BAR_COLORS } from './pentools.js';
import { sanitizeHtml, htmlText } from './sanitize.js';
import { WIDGETS, mountWidget } from './widgets.js';
import { state, native, PROVIDER_META } from './state.js';
import { renderChatMarkdown } from './md.js';
import { RichEditor } from './editor.js';
import { vaultIndex } from './vaultIndex.js';
import { mountHub } from './hub.js';
import { ChatHistory, saveConversation } from './chathistory.js';
import { AttachBar, renderAttachments } from './attach.js';

// ---------------- routers for main-process events ----------------
const ptyRoutes = new Map();
native.pty.onData(({ id, data }) => ptyRoutes.get(id)?.onData(data));
native.pty.onExit(({ id, code, error }) => ptyRoutes.get(id)?.onExit(code, error));
const chatRoutes = new Map();
native.chat.onEvent((ev) => chatRoutes.get(ev.reqId)?.(ev));
native.agentChat.onEvent((ev) => chatRoutes.get(ev.reqId)?.(ev));

export const STICKY_COLORS = ['#ffe58a', '#ffcd9e', '#ffb8d1', '#d6c2ff', '#a8d8ff', '#b5f0c0', '#e2e5ea'];
const SHAPE_COLORS = ['#7c8cff', '#4fd1a5', '#f6a04d', '#e86a92', '#5bc0eb', '#e3c565', '#9aa3b2'];
// pencil: 'auto' follows the theme (light lines on dark, dark lines on light)
export const PEN_COLORS = BAR_COLORS;
const r1 = (v) => Math.round(v * 10) / 10;
// smooth line through the points (quadratic curves via midpoints)
export function strokePath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${r1(pts[0][0])} ${r1(pts[0][1])}l0.01 0`;
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += `Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const l = pts[pts.length - 1];
  return `${d}L${r1(l[0])} ${r1(l[1])}`;
}
const FRAME_COLORS = ['#5566d6', '#3aa6b9', '#3fae7c', '#d08a3a', '#cf5a86', '#8a5cd6', '#6b7385'];

const TERM_THEME = {
  background: '#12141a', foreground: '#d7dae0', cursor: '#9aa8ff', cursorAccent: '#12141a',
  selectionBackground: 'rgba(124,140,255,0.32)',
  black: '#1d2028', red: '#f0736f', green: '#7fd49a', yellow: '#e8c66f', blue: '#7c9cff', magenta: '#c49cff', cyan: '#6fd0e0', white: '#d7dae0',
  brightBlack: '#5c6370', brightRed: '#ff8f8a', brightGreen: '#9be8b2', brightYellow: '#f5d98b', brightBlue: '#9db5ff', brightMagenta: '#d7b8ff', brightCyan: '#8fe3f0', brightWhite: '#ffffff',
};

const TERM_THEME_LIGHT = {
  background: '#fbfbfd', foreground: '#1d2129', cursor: '#4757e0', cursorAccent: '#fbfbfd',
  selectionBackground: 'rgba(91,108,240,0.25)',
  black: '#1d2129', red: '#c9302c', green: '#21875a', yellow: '#a26b00', blue: '#3a55d6', magenta: '#8a3fc7', cyan: '#127f94', white: '#c9cdd6',
  brightBlack: '#6b7280', brightRed: '#e0453f', brightGreen: '#2aa36d', brightYellow: '#c08400', brightBlue: '#5068e8', brightMagenta: '#a254dd', brightCyan: '#1597ad', brightWhite: '#ffffff',
};
const termTheme = () => (document.documentElement.dataset.theme === 'light' ? TERM_THEME_LIGHT : TERM_THEME);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-B]/g, '').replace(/\r/g, '');


// ---------------- canvas context shared by chat windows ----------------
const CTX_TYPES = ['note', 'sticky', 'text', 'chat', 'agentchat', 'terminal', 'shape', 'web'];
function ctxNodes(view, id) { return view.connected(id).filter((n) => CTX_TYPES.includes(n.type)); }
function renderCtxRow(row, view, id) {
  const nodes = ctxNodes(view, id);
  row.innerHTML = '';
  if (!nodes.length) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.append(h('span', { class: 'muted' }, 'Контекст:'));
  for (const n of nodes) {
    const t = NODE_TYPES[n.type];
    const label = t.title ? t.title(n) : n.type;
    row.append(h('span', { class: 'ctx-chip', title: label, onclick: () => view.focusNode(n.id) }, label.slice(0, 26)));
  }
}
async function buildContextText(view, id) {
  const parts = [];
  for (const n of ctxNodes(view, id)) {
    try {
      if (n.type === 'note' && n.data.path) parts.push(`### Заметка «${n.data.path.replace(/\.md$/, '')}»\n${await native.vault.read(n.data.path)}`);
      else if (n.type === 'sticky' || n.type === 'shape') { if (n.data.text) parts.push(`### Стикер\n${n.data.text}`); }
      else if (n.type === 'text') { const t = htmlText(n.data.html); if (t.trim()) parts.push(`### Текст\n${t}`); }
      else if (n.type === 'chat' || n.type === 'agentchat') { const last = [...(n.data.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content); if (last) parts.push(`### Ответ из чата «${NODE_TYPES[n.type].title(n)}»\n${last.content}`); }
      else if (n.type === 'terminal') { const inst = view.views.get(n.id)?.inst; const t = inst?.tailText?.(); if (t) parts.push(`### Вывод терминала «${NODE_TYPES.terminal.title(n)}» (последние строки)\n\`\`\`\n${t}\n\`\`\``); }
      else if (n.type === 'web' && n.data.url) parts.push(`### Ссылка\n${n.data.url}`);
    } catch {}
  }
  return parts.join('\n\n');
}

// =====================================================================
// Terminal / agent
// =====================================================================
const WAIT_RE = /(Do you want to|Would you like to|Allow (this|command|once)|Approve|approval|\(y\/n\)|\[y\/N\]|\[Y\/n\]|Proceed\?|Press Enter to continue|❯\s*1\.\s*Yes|Yes, and don't ask|Разрешить|Подтвердите)/i;

class TerminalInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view; this.body = body;
    this.sessionId = node.data.sessionId || null;
    this.state = 'starting';
    this.lastOutput = 0;
    this.wrap = h('div', { class: 'term-wrap' });
    this.banner = h('div', { class: 'term-banner', style: { display: 'none' } });
    body.append(this.banner, this.wrap);
    const { Terminal } = window.XtermModule;
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 8000, allowProposedApi: true, theme: termTheme(),
      macOptionIsMeta: true, rightClickSelectsWord: false, convertEol: false,
    });
    this.fit = new window.XtermFit.FitAddon();
    this.term.loadAddon(this.fit);
    try { this.term.loadAddon(new window.XtermLinks.WebLinksAddon((e, uri) => native.shell.open(uri))); } catch {}
    this.term.open(this.wrap);
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && keyName(e) === 'c' && (this.term.hasSelection() || e.shiftKey)) { native.clipboard.write(this.term.getSelection()); return false; }
      if (mod && e.shiftKey && keyName(e) === 'v') return false; // browser paste event will handle
      if (mod && keyName(e) === 'v') return false;
      // let app-wide shortcuts through (Ctrl+Shift+P/O/N, Ctrl+\\, Ctrl+`)
      if (mod && e.shiftKey && ['p', 'o', 'n'].includes(keyName(e))) return false;
      if (mod && (keyName(e) === '\\' || keyName(e) === '`')) return false;
      return true;
    });
    this.term.onData((d) => { if (this.sessionId && this.state !== 'exited') native.pty.write(this.sessionId, d); });
    this.term.onTitleChange?.((t) => { this.osTitle = t; });
    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(this.wrap);
    this.offTheme = bus.on('theme', () => { this.term.options.theme = termTheme(); });
    this.start();
  }

  get agent() { return state.agent(this.node.data.agentId); }

  // Refit only when the window itself changed size. Zooming the canvas (CSS zoom at rest) also
  // fires the ResizeObserver and rounds the cell size a little differently, which would resize the
  // pty by a column and make TUIs (Claude Code, Codex) redraw on every zoom.
  doFit = throttle(() => {
    if (!this.wrap.offsetWidth || !this.wrap.offsetHeight) return;
    const n = this.view.node(this.node.id) || this.node;
    const key = `${n.w}x${n.h}x${n.data.fontSize || ''}`;
    if (!this._forceFit && key === this._fitKey && this.term.cols) return;
    this._forceFit = false;
    try {
      this.fit.fit();
      this._fitKey = key;
      if (this.sessionId) native.pty.resize(this.sessionId, this.term.cols, this.term.rows);
    } catch {}
  }, 60);
  refit() { this._forceFit = true; this.doFit(); }

  async start() {
    if (this.sessionId) {
      const att = await native.pty.attach(this.sessionId);
      if (att) {
        ptyRoutes.set(this.sessionId, this);
        if (att.buffer) this.term.write(att.buffer);
        this.lastOutput = att.lastOutput || 0;
        this.notFound = att.notFound;
        this.state = att.exited ? 'exited' : 'running';
        if (att.exited) this.showEnded(att.exitCode);
        setTimeout(() => this.refit(), 30);
        this.syncHead();
        return;
      }
      // session gone (app restarted)
      this.sessionId = null;
      this.state = 'stopped';
      this.showStopped();
      this.syncHead();
      return;
    }
    await this.spawn();
  }

  async spawn(resume = false) {
    this.hideBanner();
    const a = this.agent;
    const project = state.project;
    const cwd = this.node.data.cwd || project.cwd || state.info.home;
    const args = [resume && a.resumeArgs ? a.resumeArgs : a.args, this.node.data.extraArgs].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
    this.state = 'starting';
    this.syncHead();
    await new Promise((r) => requestAnimationFrame(r));
    try { this.fit.fit(); } catch {}
    const res = await native.pty.spawn({ cmd: a.cmd, args, cwd, cols: this.term.cols || 100, rows: this.term.rows || 30 });
    // the window was closed while the terminal was starting: don't leave the process behind
    if (this.disposed || this.destroyed) { native.pty.kill(res.id); return; }
    this.sessionId = res.id;
    this.notFound = res.notFound;
    ptyRoutes.set(res.id, this);
    this.view.setData(this.node.id, { sessionId: res.id });
    this.state = res.error ? 'exited' : 'running';
    if (res.notFound && a.cmd) {
      this.term.write(`\x1b[33m⚠ Команда «${a.cmd}» не найдена в PATH.\x1b[0m\r\n${a.install ? `  Установите: \x1b[36m${a.install}\x1b[0m\r\n` : ''}  Или укажите полный путь в Настройки → Агенты.\r\n\r\n`);
    }
    setTimeout(() => this.refit(), 50);
    this.syncHead();
  }

  onData(data) {
    this.term.write(data);
    this.lastOutput = Date.now();
    if (this.state !== 'running') { this.state = 'running'; this.syncHead(); }
  }
  onExit(code, error) {
    this.state = 'exited';
    this.exitCode = code;
    this.showEnded(code, error);
    this.syncHead();
  }

  showEnded(code) {
    this.banner.replaceChildren(
      h('span', {}, `Сессия завершена${code != null ? ` (код ${code})` : ''}`),
      h('button', { class: 'btn sm', onclick: () => this.restart() }, '↻ Перезапустить'),
    );
    this.banner.style.display = 'flex';
  }
  showStopped() {
    const a = this.agent;
    this.banner.replaceChildren(
      h('span', {}, 'Сессия не запущена'),
      h('button', { class: 'btn sm primary', onclick: () => { this.term.reset(); this.spawn(false); } }, '▶ Запустить'),
      a.resumeArgs ? h('button', { class: 'btn sm', onclick: () => { this.term.reset(); this.spawn(true); } }, '⟲ Продолжить прошлую сессию') : null,
    );
    this.banner.style.display = 'flex';
  }
  hideBanner() { this.banner.style.display = 'none'; }

  async restart() {
    if (this.sessionId) { ptyRoutes.delete(this.sessionId); await native.pty.kill(this.sessionId); }
    this.sessionId = null;
    this.term.reset();
    await this.spawn(false);
  }
  async stop() {
    if (this.sessionId) { await native.pty.kill(this.sessionId); ptyRoutes.delete(this.sessionId); }
    this.sessionId = null;
    this.view.setData(this.node.id, { sessionId: null });
    this.state = 'stopped';
    this.showStopped();
    this.syncHead();
  }

  sendText(text, enter = false) {
    if (!this.sessionId) return;
    // bracketed paste keeps multi-line text together for TUIs
    native.pty.write(this.sessionId, `\x1b[200~${text}\x1b[201~${enter ? '\r' : ''}`);
    this.term.focus();
  }

  tailText(chars = 4000) {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) || '');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(-chars);
  }

  statusInfo() {
    if (this.notFound && this.agent.cmd) return { label: 'Статус недоступен', kind: 'na' };
    if (this.state === 'starting') return { label: 'Запуск…', kind: 'idle' };
    if (this.state === 'stopped') return { label: 'Остановлен', kind: 'off' };
    if (this.state === 'exited') return { label: 'Завершён', kind: 'off' };
    if (Date.now() - this.lastOutput < 2500) return { label: 'Работает', kind: 'busy' };
    // an agent CLI asking for approval / a choice (Claude Code, Codex, Gemini…)
    if (this.agent.cmd && this.term) {
      if (this._waitAt !== this.lastOutput) {
        this._waitAt = this.lastOutput;
        const tail = this.tailText(1500).split('\n').slice(-16).join('\n');
        this._waiting = WAIT_RE.test(tail);
      }
      if (this._waiting) return { label: 'Ждёт ответа', kind: 'wait' };
    }
    return { label: 'Ожидает', kind: 'idle' };
  }

  syncHead() { this.view.syncHead(this.view.node(this.node.id) || this.node); bus.emit('agents'); }
  update(n) { this.node = n; }
  onLod(lod) { if (!lod) setTimeout(() => this.doFit(), 30); }
  onVisible() { setTimeout(() => this.doFit(), 30); }
  onResize() { this.doFit(); }
  edit() { this.term.focus(); }
  destroy() { this.destroyed = true; this.ro.disconnect(); this.offTheme?.(); if (this.sessionId) ptyRoutes.delete(this.sessionId); this.term.dispose(); }
  dispose() { this.disposed = true; if (this.sessionId) native.pty.kill(this.sessionId); }
}

// =====================================================================
// API chat
// =====================================================================
// A running chat can outlive its canvas being on screen (the user switched canvas):
// its results are then written straight into that canvas' file.
const activeRuns = new Map(); // node id → instance that owns the run
async function patchNodeData(inst, patch) {
  inst.node = { ...inst.node, data: { ...inst.node.data, ...patch } };
  const view = inst.view;
  if (view.doc?.id === inst.docId && view.node(inst.node.id)) {
    view.setData(inst.node.id, patch);
    const live = view.views.get(inst.node.id)?.inst;
    if (live && live !== inst) live.renderAll?.(); // the window was re-created meanwhile
    return;
  }
  try {
    const doc = await native.canvas.load(inst.docId);
    const n = doc?.nodes?.find((x) => x.id === inst.node.id);
    if (!n) return;
    n.data = { ...n.data, ...patch };
    await native.canvas.save(inst.docId, doc);
  } catch (e) { console.error('patchNodeData', e); }
}
// an answer left "running" by a previous run that no longer exists (app closed mid-answer)
function settleStale(inst) {
  const msgs = inst.node.data.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last?.running || activeRuns.has(inst.node.id)) return;
  const fixed = [...msgs.slice(0, -1), { ...last, running: false, ...(last.parts ? { parts: [...last.parts, { type: 'notice', text: 'Прервано' }] } : { content: last.content || '_(прервано)_' }) }];
  inst.view.setData(inst.node.id, { messages: fixed });
  inst.node = inst.view.node(inst.node.id) || inst.node;
}

// Long conversations render only the newest messages; older ones load on demand
// (a chat with hundreds of answers would otherwise create tens of thousands of DOM nodes).
const MSG_PAGE = 40;
function renderWindowed(inst) {
  const msgs = inst.messages;
  inst.shown = Math.min(msgs.length, Math.max(inst.shown || MSG_PAGE, MSG_PAGE));
  const from = msgs.length - inst.shown;
  if (from > 0) {
    inst.list.append(h('button', { class: 'msg-more no-drag', onclick: (e) => {
      e.stopPropagation();
      const before = inst.list.scrollHeight;
      inst.shown += MSG_PAGE;
      inst._keepScroll = true;
      inst.renderAll();
      inst.list.scrollTop = inst.list.scrollHeight - before; // stay where the reader was
      inst._keepScroll = false;
    } }, `Показать предыдущие сообщения (${from})`));
  }
  for (let i = Math.max(0, from); i < msgs.length; i++) inst.list.append(inst.renderMsg(msgs[i], i));
}

class ChatInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view;
    settleStale(this);
    this.streaming = null;
    this.root = h('div', { class: 'chat' });
    this.bar = h('div', { class: 'chat-bar' });
    this.providerSel = h('select', { class: 'select sm no-drag' });
    this.modelInput = h('input', { class: 'input sm no-drag model-input', placeholder: 'модель', list: `models-${node.id}` });
    this.modelList = h('datalist', { id: `models-${node.id}` });
    this.loadModelsBtn = h('button', { class: 'icon-btn sm', title: 'Загрузить список моделей', html: icon('refresh', 13), onclick: () => this.loadModels() });
    this.bar.append(this.providerSel, this.modelInput, this.modelList, this.loadModelsBtn);
    this.list = h('div', { class: 'chat-list scrollable' });
    this.ctxRow = h('div', { class: 'chat-ctx' });
    this.input = h('textarea', { class: 'chat-input', rows: 2, placeholder: 'Сообщение… (Enter — отправить, Shift+Enter — новая строка)' });
    this.sendBtn = h('button', { class: 'chat-send', title: 'Отправить', html: icon('send', 16), onclick: () => this.streaming ? this.stop() : this.send() });
    this.attach = new AttachBar({ root: this.root, input: this.input });
    this.list.addEventListener('load', (e) => { if (e.target.tagName === 'IMG' && this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 400) this.list.scrollTop = this.list.scrollHeight; }, true);
    this.foot = h('div', { class: 'chat-foot' }, this.attach.button, this.input, this.sendBtn);
    this.usage = h('div', { class: 'chat-usage' });
    this.root.append(this.bar, this.list, this.ctxRow, this.attach.chips, this.foot, this.usage);
    this.hist = new ChatHistory(this);
    this.bar.prepend(this.hist.button);
    body.append(this.root);
    this.fillProviders();
    this.providerSel.addEventListener('change', () => { const p = this.providerSel.value; this.view.setData(node.id, { provider: p, model: '' }); this.modelInput.value = ''; this.modelInput.placeholder = this.providers?.[p]?.model || 'модель'; this.view.syncHead(this.view.node(node.id)); });
    this.modelInput.addEventListener('change', () => this.view.setData(node.id, { model: this.modelInput.value.trim() }));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`; });
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) { const code = btn.closest('.code-block').querySelector('code').textContent; native.clipboard.write(code); btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1200); }
      const act = e.target.closest('[data-act]');
      if (act) this.msgAction(act.dataset.act, +act.dataset.i);
    });
    this.offEdges = view.on('edges', () => this.renderCtx());
    this.renderAll();
    this.renderCtx();
  }

  async fillProviders() {
    this.providers = await native.chat.providers();
    this.providerSel.innerHTML = '';
    for (const [id, p] of Object.entries(this.providers)) this.providerSel.append(h('option', { value: id }, p.name));
    this.providerSel.value = this.node.data.provider || 'openai';
    this.modelInput.value = this.node.data.model || '';
    this.modelInput.placeholder = this.providers[this.providerSel.value]?.model || 'модель';
  }

  async loadModels() {
    try {
      const list = await native.chat.models(this.node.data.provider, state.settings);
      this.modelList.innerHTML = '';
      for (const m of list) this.modelList.append(h('option', { value: m }));
      toast(`Загружено моделей: ${list.length}`);
      this.modelInput.focus();
    } catch (e) { toast('Не удалось получить модели: ' + e.message, 'error'); }
  }

  get messages() { return this.node.data.messages || []; }

  renderAll() {
    this.list.innerHTML = '';
    if (!this.messages.length) {
      this.list.append(h('div', { class: 'chat-empty' },
        h('div', { class: 'chat-empty-title' }, 'Новый чат'),
        h('div', { class: 'muted' }, 'Соедините заметки, стикеры или терминалы с этим чатом стрелкой — они попадут в контекст.')));
    }
    renderWindowed(this);
    if (!this._keepScroll) this.scrollDown(true);
  }

  renderMsg(m, i) {
    const el = h('div', { class: `msg ${m.role}${m.error ? ' error' : ''}` });
    if (m.role === 'user') { const atts = renderAttachments(m.attachments); if (atts) el.append(atts); if (m.content) el.append(h('div', { class: 'msg-text' }, m.content)); }
    else {
      if (m.reasoning) el.append(h('details', { class: 'msg-reason' }, h('summary', {}, 'Размышления'), h('div', { class: 'reason-text' }, m.reasoning)));
      el.append(h('div', { class: 'msg-text md', html: m.error ? esc(m.content) : renderChatMarkdown(m.content) }));
    }
    el.append(h('div', { class: 'msg-actions' },
      h('button', { 'data-act': 'copy', 'data-i': i, title: 'Копировать', html: icon('copy', 12) }),
      m.role === 'assistant' ? h('button', { 'data-act': 'note', 'data-i': i, title: 'В заметку', html: icon('note', 12) }) : null,
      m.role === 'assistant' ? h('button', { 'data-act': 'term', 'data-i': i, title: 'Отправить в связанный терминал', html: icon('terminal', 12) }) : null,
      h('button', { 'data-act': 'del', 'data-i': i, title: 'Удалить', html: icon('trash', 12) }),
    ));
    return el;
  }

  async msgAction(act, i) {
    const m = this.messages[i];
    if (!m) return;
    if (act === 'copy') { native.clipboard.write(m.content); toast('Скопировано'); }
    if (act === 'del') { const msgs = this.messages.filter((_, j) => j !== i); this.view.setData(this.node.id, { messages: msgs }); this.renderAll(); }
    if (act === 'note') {
      const title = (m.content.match(/^#+\s+(.+)$/m)?.[1] || m.content.split('\n')[0]).slice(0, 60).replace(/[*_`#]/g, '').trim() || 'Ответ';
      const p = await native.vault.create('Из чатов', title, m.content + '\n');
      await vaultIndex.refresh();
      const n = this.view.node(this.node.id);
      const note = this.view.addNode('note', { x: n.x + n.w + 60, y: n.y, data: { path: p } }, { center: false });
      this.view.addEdge(this.node.id, note.id);
      toast('Заметка создана');
    }
    if (act === 'term') {
      const t = this.view.connected(this.node.id).find((x) => x.type === 'terminal');
      if (!t) { toast('Соедините чат стрелкой с терминалом', 'warn'); return; }
      this.view.views.get(t.id)?.inst?.sendText(m.content, false);
      toast('Текст вставлен в терминал — проверьте и нажмите Enter');
    }
  }

  scrollDown(force) {
    const l = this.list;
    if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 120) l.scrollTop = l.scrollHeight;
  }

  contextNodes() { return ctxNodes(this.view, this.node.id); }
  renderCtx() { renderCtxRow(this.ctxRow, this.view, this.node.id); }
  buildContext() { return buildContextText(this.view, this.node.id); }

  async send() {
    const text = this.input.value.trim();
    if ((!text && !this.attach.items.length) || this.streaming) return;
    if (this.attach.busy) { toast('Файлы ещё загружаются…'); return; }
    const attachments = this.attach.take();
    this.input.value = ''; this.input.style.height = 'auto';
    const msgs = [...this.messages, { role: 'user', content: text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) }];
    const ctx = await this.buildContext();
    const system = [this.node.data.system, ctx ? `Ниже контекст, связанный с этим чатом на canvas пользователя:\n\n${ctx}` : ''].filter(Boolean).join('\n\n');
    const asst = { role: 'assistant', content: '', ts: Date.now() };
    const all = [...msgs, asst];
    this.view.setData(this.node.id, { messages: all });
    if (!this.node.data.title || this.node.data.title === 'Новый чат') this.view.setData(this.node.id, { title: (text || attachments[0]?.name || 'Чат').slice(0, 40) });
    this.renderAll();
    const el = this.list.lastElementChild;
    const textEl = el.querySelector('.msg-text');
    textEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    const reqId = uid('req');
    this.docId = this.view.doc.id; activeRuns.set(this.node.id, this);
    this.streaming = reqId;
    this.sendBtn.innerHTML = icon('stop', 15); this.sendBtn.classList.add('stop');
    this.view.syncHead(this.view.node(this.node.id));
    let lastPaint = 0, pending = 0;
    const paintNow = () => { pending = 0; lastPaint = performance.now(); textEl.innerHTML = renderChatMarkdown(asst.content); this.scrollDown(); };
    // long answers: markdown is re-parsed less often (60 ms … 250 ms)
    const paint = () => { if (pending) return; const gap = Math.min(250, Math.max(60, asst.content.length / 40)); const wait = Math.max(0, gap - (performance.now() - lastPaint)); pending = setTimeout(paintNow, wait); };
    chatRoutes.set(reqId, (ev) => {
      if (ev.type === 'delta') { asst.content += ev.text; paint(); }
      else if (ev.type === 'reasoning') { asst.reasoning = (asst.reasoning || '') + ev.text; }
      else if (ev.type === 'error') { asst.content = `⚠ ${ev.message}`; asst.error = true; this.finish(reqId, all); }
      else if (ev.type === 'done') { if (ev.usage) { asst.usage = ev.usage; } if (!asst.content && ev.aborted) asst.content = '_(остановлено)_'; this.finish(reqId, all); }
    });
    await native.chat.send({ reqId, provider: this.node.data.provider || 'openai', model: this.node.data.model, system, messages: msgs.map(({ role, content, attachments: a }) => ({ role, content, ...(a?.length ? { attachments: a } : {}) })), settings: state.settings });
  }

  async finish(reqId, all) {
    chatRoutes.delete(reqId);
    this.streaming = null;
    this.sendBtn.innerHTML = icon('send', 16); this.sendBtn.classList.remove('stop');
    activeRuns.delete(this.node.id);
    await patchNodeData(this, { messages: [...all] });
    saveConversation(this);
    this.renderAll();
    const tot = all.reduce((t, m) => t + (m.usage ? m.usage.input + m.usage.output : 0), 0);
    this.usage.textContent = tot ? `${tot.toLocaleString('ru-RU')} токенов в этом чате` : '';
    this.view.syncHead(this.view.node(this.node.id));
    bus.emit('limits:refresh');
  }

  stop() { if (this.streaming) native.chat.abort(this.streaming); }
  isBusy() { return !!this.streaming; }
  loadConversation({ convId = null, messages = [], title = '', provider, model }) {
    const patch = { convId, messages, title: title || 'Новый чат' };
    if (provider) { patch.provider = provider; patch.model = model || ''; }
    this.view.setData(this.node.id, patch);
    this.node = this.view.node(this.node.id) || this.node;
    this.providerSel.value = this.node.data.provider || 'openai';
    this.modelInput.value = this.node.data.model || '';
    this.usage.textContent = '';
    this.renderAll();
    this.view.syncHead(this.node);
  }

  statusInfo() {
    if (this.streaming) return { label: 'Отвечает…', kind: 'busy' };
    const m = this.messages[this.messages.length - 1];
    if (m?.error) return { label: 'Ошибка', kind: 'na' };
    return { label: this.messages.length ? `${this.messages.length} сообщ.` : 'Готов', kind: 'idle' };
  }

  update(n) { this.node = n; if (!this.streaming) { this.providerSel.value = n.data.provider || 'openai'; this.modelInput.value = n.data.model || ''; this.renderAll(); } }
  edit() { this.input.focus(); }
  destroy() { this.offEdges?.(); }
  dispose() { this.stop(); }
}

// =====================================================================
// CLI agent in a chat window (Claude Code / Codex, like their own apps)
// =====================================================================
export const AGENT_MODES = {
  claude: [['acceptEdits', 'Правки файлов'], ['plan', 'План, без изменений'], ['bypassPermissions', 'Полный доступ'], ['default', 'Только чтение']],
  codex: [['write', 'Правки в папке'], ['read', 'Только чтение'], ['full', 'Полный доступ']],
};

// group label → [value, label]; aliases always point to the newest model of a family
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };

export const AGENT_MODELS = {
  claude: [
    ['Последняя версия', [['opus', 'Opus (последний)'], ['sonnet', 'Sonnet (последний)'], ['haiku', 'Haiku (последний)']]],
    ['Fable', [['claude-fable-5-1', 'Fable 5.1'], ['claude-fable-5', 'Fable 5']]],
    ['Opus', [['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'], ['claude-opus-4-5-20251101', 'Opus 4.5']]],
    ['Sonnet', [['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-sonnet-4-5-20250929', 'Sonnet 4.5']]],
    ['Haiku', [['claude-haiku-5-5', 'Haiku 5.5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']]],
  ],
  codex: [
    ['Модели', [['gpt-5-codex', 'GPT-5 Codex'], ['gpt-5', 'GPT-5'], ['gpt-5-codex-mini', 'GPT-5 Codex mini']]],
  ],
};
const modelLabel = (kind, v) => { for (const [, items] of AGENT_MODELS[kind] || []) for (const [mv, ml] of items) if (mv === v) return ml; return v; };
export const AGENT_EFFORTS = {
  claude: [['low', 'Низкий'], ['medium', 'Средний'], ['high', 'Высокий'], ['xhigh', 'Очень высокий'], ['max', 'Максимальный']],
  codex: [['minimal', 'Минимальный'], ['low', 'Низкий'], ['medium', 'Средний'], ['high', 'Высокий'], ['xhigh', 'Очень высокий']],
};
let agentDefaultsP = null;
const agentDefaults = () => (agentDefaultsP = agentDefaultsP || (native.agentChat.defaults ? native.agentChat.defaults().catch(() => ({})) : Promise.resolve({})));

class AgentChatInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view;
    settleStale(this);
    this.running = null;
    this.root = h('div', { class: 'chat agent-chat' });
    this.modeSel = h('select', { class: 'select sm no-drag', title: 'Что агенту разрешено делать' });
    this.modelSel = h('select', { class: 'select sm no-drag', title: 'Модель' });
    this.effortSel = h('select', { class: 'select sm no-drag', title: 'Уровень размышления (reasoning effort)' });
    this.cwdBtn = h('button', { class: 'cwd-path no-drag', title: 'Рабочая папка агента — нажмите, чтобы сменить', onclick: () => this.pickCwd() });
    this.modelInfo = h('span', { class: 'model-info' });
    this.newBtn = h('button', { class: 'icon-btn sm', title: 'Новый чат (текущий останется в истории)', html: icon('plus', 14), onclick: () => this.newSession() });
    const field = (label, ctrl) => h('label', { class: 'bar-field' }, h('span', { class: 'bar-label' }, label), ctrl);
    this.bar = h('div', { class: 'chat-bar agent-bar' },
      field('Модель', this.modelSel), field('Размышление', this.effortSel), field('Доступ', this.modeSel), this.newBtn);
    this.infoBar = h('div', { class: 'agent-info' }, this.cwdBtn, this.modelInfo);
    this.list = h('div', { class: 'chat-list scrollable' });
    this.ctxRow = h('div', { class: 'chat-ctx' });
    this.input = h('textarea', { class: 'chat-input', rows: 2, placeholder: 'Задача для агента… (Enter — отправить, Shift+Enter — новая строка)' });
    this.sendBtn = h('button', { class: 'chat-send', title: 'Отправить', html: icon('send', 16), onclick: () => (this.running ? this.stop() : this.send()) });
    this.usage = h('div', { class: 'chat-usage' });
    this.attach = new AttachBar({ root: this.root, input: this.input });
    this.list.addEventListener('load', (e) => { if (e.target.tagName === 'IMG' && this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 400) this.list.scrollTop = this.list.scrollHeight; }, true);
    this.root.append(this.bar, this.infoBar, this.list, this.ctxRow, this.attach.chips, h('div', { class: 'chat-foot' }, this.attach.button, this.input, this.sendBtn), this.usage);
    this.hist = new ChatHistory(this);
    this.bar.prepend(this.hist.button);
    body.append(this.root);
    for (const [v, l] of AGENT_MODES[this.kind] || []) this.modeSel.append(h('option', { value: v }, l));
    this.fillModelOptions();
    this.modelSel.addEventListener('change', async () => {
      let v = this.modelSel.value;
      if (v === '__custom') {
        v = (await prompt('Название модели', this.node.data.model || '', this.kind === 'claude' ? 'например claude-opus-5-5' : 'например gpt-5-codex')) || '';
      }
      this.view.setData(this.node.id, { model: v.trim(), actualModel: null });
      this.fillModelOptions();
    });
    this.effortSel.addEventListener('change', () => { this.view.setData(this.node.id, { effort: this.effortSel.value }); this.renderInfo(); });
    this.modeSel.value = node.data.mode || (AGENT_MODES[this.kind] || [[]])[0][0];
    this.modeSel.addEventListener('change', () => this.view.setData(this.node.id, { mode: this.modeSel.value }));
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); } e.stopPropagation(); });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`; });
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) { native.clipboard.write(btn.closest('.code-block').querySelector('code').textContent); btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1200); }
      const act = e.target.closest('[data-act]');
      if (act) this.msgAction(act.dataset.act, +act.dataset.i);
    });
    this.offEdges = view.on('edges', () => this.renderCtx());
    this.renderCwd();
    this.renderAll();
    this.renderCtx();
  }

  get agent() { return state.agent(this.node.data.agentId); }
  get kind() { return this.node.data.kind || this.agent.chat || 'claude'; }
  get messages() { return this.node.data.messages || []; }
  get cwd() { return this.node.data.cwd || state.project.cwd || state.info.home; }

  async fillModelOptions() {
    const d = (await agentDefaults())[this.kind] || {};
    this.defaults = d;
    const cur = this.node.data.model || '';
    const groups = (AGENT_MODELS[this.kind] || []).map(([g, items]) => [g, [...items]]);
    const known = new Set(groups.flatMap(([, items]) => items.map(([v]) => v)));
    const extra = [...(d.models || []), cur].filter((m) => m && !known.has(m) && m !== '__custom');
    if (extra.length) groups.push(['Другие', [...new Set(extra)].map((m) => [m, m])]);
    this.modelSel.innerHTML = '';
    this.modelSel.append(h('option', { value: '' }, d.model ? `Авто (${d.model})` : 'Авто'));
    for (const [g, items] of groups) this.modelSel.append(h('optgroup', { label: g }, ...items.map(([v, l]) => h('option', { value: v }, l))));
    this.modelSel.append(h('option', { value: '__custom' }, 'Другая…'));
    this.modelSel.value = cur;
    const eff = this.node.data.effort || '';
    this.effortSel.innerHTML = '';
    this.effortSel.append(h('option', { value: '' }, d.effort ? `Авто (${((AGENT_EFFORTS[this.kind] || []).find(([v]) => v === d.effort)?.[1] || d.effort).toLowerCase()})` : 'Авто'));
    for (const [v, l] of AGENT_EFFORTS[this.kind] || []) this.effortSel.append(h('option', { value: v }, l));
    this.effortSel.value = eff;
    this.renderInfo();
  }
  renderInfo() {
    const d = this.defaults || {};
    const n = this.node.data;
    const model = n.actualModel || (n.model ? modelLabel(this.kind, n.model) : d.model && modelLabel(this.kind, d.model));
    const effL = (AGENT_EFFORTS[this.kind] || []).find(([v]) => v === (n.effort || d.effort))?.[1];
    this.modelInfo.textContent = model ? `${model}${effL ? ` · размышл.: ${effL.toLowerCase()}` : ''}` : 'модель из настроек агента';
    this.modelInfo.title = n.actualModel ? 'Модель, которую агент сообщил в последней сессии' : 'Модель из настроек агента или выбранная сверху';
  }
  renderCwd() {
    const c = this.cwd || '';
    this.cwdBtn.replaceChildren(h('span', { html: icon('folder', 12) }), h('span', { class: 'cwd-text' }, !c ? 'выберите папку' : c.length > 46 ? '…' + c.slice(-45) : c));
    this.cwdBtn.title = `Рабочая папка агента:\n${c}\n\nНажмите, чтобы сменить`;
  }
  async pickCwd() { const p = await native.dialog.folder('Рабочая папка агента'); if (p) { this.view.setData(this.node.id, { cwd: p }); this.renderCwd(); } }
  newSession() { if (this.isBusy()) return; this.hist.newChat(); toast('Новый чат: прошлый сохранён в истории'); }
  isBusy() { return !!this.running; }
  loadConversation({ convId = null, messages = [], title = '', sessionId = null, cwd, model, actualModel }) {
    const patch = { convId, messages, title: title || '', sessionId, ctxHash: null, actualModel: actualModel || model || null };
    if (cwd) patch.cwd = cwd;
    this.view.setData(this.node.id, patch);
    this.node = this.view.node(this.node.id) || this.node;
    this.usage.textContent = sessionId ? `сессия ${String(sessionId).slice(0, 8)}` : '';
    this.renderCwd(); this.renderInfo(); this.renderAll(); this.syncHead();
  }
  renderCtx() { renderCtxRow(this.ctxRow, this.view, this.node.id); }

  renderAll() {
    this.list.innerHTML = '';
    if (!this.messages.length) {
      const a = this.agent;
      this.list.append(h('div', { class: 'chat-empty' },
        badge(a.mono, a.color, 34, a.dark),
        h('div', { class: 'chat-empty-title' }, `${a.name} — чат`),
        h('div', { class: 'muted' }, 'Работает по вашей подписке и входу в CLI, без API-ключа. Агент действует в папке, показанной сверху; его команды и правки появятся в ленте.'),
        h('div', { class: 'muted small' }, 'Соедините стрелкой заметку или стикер с этим окном — они уйдут агенту как контекст.')));
    }
    renderWindowed(this);
    if (!this._keepScroll) this.list.scrollTop = this.list.scrollHeight;
  }

  // incremental: unchanged parts keep their DOM (so an expanded tool call stays open and long
  // answers don't re-parse all their markdown on every streamed token)
  renderParts(m, el) {
    const parts = (m.parts || [{ type: 'text', text: m.content }]).filter((p) => !((p.type === 'text' || p.type === 'reasoning') && !p.text));
    const cache = el._parts || (el._parts = []);
    const keyOf = (p) => `${p.type}|${(p.text || '').length}|${p.status || ''}|${(p.output || '').length}|${(p.input || '').length}`;
    const make = (p) => {
      if (p.type === 'text') return h('div', { class: 'msg-text md', html: renderChatMarkdown(p.text) });
      if (p.type === 'reasoning') return h('details', { class: 'msg-reason' }, h('summary', {}, 'Размышления'), h('div', { class: 'reason-text' }, p.text));
      if (p.type === 'tool') {
        const d = h('details', { class: `tool-call ${p.status || ''}` },
          h('summary', {}, h('span', { class: 'tool-dot' }), h('b', {}, p.name), h('span', { class: 'tool-input' }, (p.input || '').split('\n')[0])));
        if (p.input && p.input.includes('\n')) d.append(h('pre', { class: 'tool-in' }, p.input));
        if (p.output) d.append(h('pre', { class: 'tool-out' }, p.output));
        return d;
      }
      if (p.type === 'error') return h('div', { class: 'msg-error' }, `⚠ ${p.text}`);
      if (p.type === 'notice') return h('div', { class: 'muted small' }, p.text);
      return null;
    };
    el.querySelector(':scope > .typing')?.remove();
    parts.forEach((p, i) => {
      const key = keyOf(p);
      const c = cache[i];
      if (c && c.key === key) return;
      const node = make(p);
      if (!node) return;
      if (c?.node?.open && node.tagName === 'DETAILS') node.open = true; // keep it expanded
      if (c?.node?.parentNode === el) c.node.replaceWith(node); else el.append(node);
      cache[i] = { key, node };
    });
    for (let i = parts.length; i < cache.length; i++) cache[i]?.node?.remove();
    cache.length = Math.min(cache.length, parts.length);
    if (m.running && !parts.length) el.append(h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  }

  renderMsg(m, i) {
    const el = h('div', { class: `msg ${m.role}` });
    if (m.role === 'user') { const atts = renderAttachments(m.attachments); if (atts) el.append(atts); if (m.content) el.append(h('div', { class: 'msg-text' }, m.content)); }
    else { const body = h('div', { class: 'msg-body' }); this.renderParts(m, body); el.append(body); }
    if (!m.running) el.append(h('div', { class: 'msg-actions' },
      h('button', { 'data-act': 'copy', 'data-i': i, title: 'Копировать', html: icon('copy', 12) }),
      m.role === 'assistant' ? h('button', { 'data-act': 'note', 'data-i': i, title: 'В заметку', html: icon('note', 12) }) : null));
    return el;
  }

  async msgAction(act, i) {
    const m = this.messages[i];
    if (!m) return;
    if (act === 'copy') { native.clipboard.write(m.content || ''); toast('Скопировано'); }
    if (act === 'note') {
      const title = (m.content.split('\n').find((l) => l.trim()) || 'Ответ агента').replace(/[#*_`]/g, '').slice(0, 60).trim();
      const p = await native.vault.create('Из чатов', title, m.content + '\n');
      await vaultIndex.refresh();
      const n = this.view.node(this.node.id);
      const note = this.view.addNode('note', { x: n.x + n.w + 60, y: n.y, data: { path: p } }, { center: false });
      this.view.addEdge(this.node.id, note.id);
    }
  }

  async send() {
    const text = this.input.value.trim();
    if ((!text && !this.attach.items.length) || this.running) return;
    if (this.attach.busy) { toast('Файлы ещё загружаются…'); return; }
    const attachments = this.attach.take();
    this.input.value = ''; this.input.style.height = 'auto';
    let prompt = text;
    const ctx = await buildContextText(this.view, this.node.id);
    const hash = ctx ? String(ctx.length) + ctx.slice(0, 200) + ctx.slice(-200) : null;
    if (ctx && hash !== this.node.data.ctxHash) {
      prompt = `Контекст с canvas пользователя (заметки и связанные окна):\n\n${ctx}\n\n---\n\n${text}`;
      this.view.setData(this.node.id, { ctxHash: hash });
    }
    const user = { role: 'user', content: text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) };
    const asst = { role: 'assistant', content: '', parts: [], running: true, ts: Date.now() };
    const all = [...this.messages, user, asst];
    this.view.setData(this.node.id, { messages: all });
    if (!this.node.data.title) this.view.setData(this.node.id, { title: (text || attachments[0]?.name || 'Задача').slice(0, 40) });
    this.renderAll();
    const body = this.list.lastElementChild.querySelector('.msg-body');
    const reqId = uid('ag');
    this.docId = this.view.doc.id; activeRuns.set(this.node.id, this);
    this.running = reqId;
    this.sendBtn.innerHTML = icon('stop', 15); this.sendBtn.classList.add('stop');
    this.syncHead();
    let newText = true;
    const paint = throttle(() => { const l = this.list; const stick = l.scrollHeight - l.scrollTop - l.clientHeight < 120; this.renderParts(asst, body); if (stick) l.scrollTop = l.scrollHeight; }, 70);
    const lastText = () => { const l = asst.parts[asst.parts.length - 1]; if (newText || !l || l.type !== 'text') { const p = { type: 'text', text: '' }; asst.parts.push(p); newText = false; return p; } return l; };
    chatRoutes.set(reqId, (ev) => {
      switch (ev.type) {
        case 'session': patchNodeData(this, { sessionId: ev.sessionId }); break;
        case 'info': if (ev.model) { this.view.setData(this.node.id, { actualModel: ev.model }); this.renderInfo(); } break;
        case 'delta': lastText().text += ev.text; break;
        case 'break': newText = true; break;
        case 'reasoning': { const l = asst.parts[asst.parts.length - 1]; if (l && l.type === 'reasoning') l.text += ev.text; else asst.parts.push({ type: 'reasoning', text: ev.text }); break; }
        case 'tool': if (!asst.parts.some((p) => p.type === 'tool' && p.id === ev.id)) asst.parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'run' }); newText = true; break;
        case 'toolResult': { const t = asst.parts.find((p) => p.type === 'tool' && p.id === ev.id); if (t) { t.output = ev.output; t.status = ev.isError ? 'err' : 'ok'; } break; }
        case 'notice': asst.parts.push({ type: 'notice', text: ev.text }); if (ev.needsInput) asst.needsInput = true; break;
        case 'error': asst.parts.push({ type: 'error', text: ev.message }); break;
        case 'done': this.finish(reqId, all, asst, ev); return;
        default: break;
      }
      paint();
    });
    await native.agentChat.run({ reqId, kind: this.kind, cmd: this.agent.cmd || this.kind, prompt, sessionId: this.node.data.sessionId, mode: this.modeSel.value, model: this.node.data.model || '', effort: this.node.data.effort || '', cwd: this.cwd, attachments });
  }

  async finish(reqId, all, asst, ev) {
    chatRoutes.delete(reqId);
    this.running = null;
    asst.running = false;
    for (const p of asst.parts) if (p.type === 'tool' && p.status === 'run') p.status = ev.aborted ? 'err' : 'ok';
    if (ev.aborted) asst.parts.push({ type: 'notice', text: 'Остановлено' });
    asst.content = asst.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
    activeRuns.delete(this.node.id);
    await patchNodeData(this, { messages: [...all], ...(ev.sessionId ? { sessionId: ev.sessionId } : {}) });
    this.sendBtn.innerHTML = icon('send', 16); this.sendBtn.classList.remove('stop');
    const bits = [];
    if (ev.usage) bits.push(`${(ev.usage.input + ev.usage.output).toLocaleString('ru-RU')} ток.`);
    if (ev.cost) bits.push(`$${ev.cost.toFixed(4)}`);
    if (this.node.data.sessionId) bits.push(`сессия ${String(this.node.data.sessionId).slice(0, 8)}`);
    this.usage.textContent = bits.join(' · ');
    saveConversation(this);
    this.renderAll();
    this.syncHead();
    bus.emit('limits:refresh');
  }

  stop() { if (this.running) native.agentChat.abort(this.running); }
  syncHead() { this.view.syncHead(this.view.node(this.node.id) || this.node); bus.emit('agents'); }
  statusInfo() {
    if (this.running) return { label: 'Работает', kind: 'busy' };
    const m = this.messages[this.messages.length - 1];
    if (m && (m.parts || []).some((p) => p.type === 'error')) return { label: 'Ошибка', kind: 'na' };
    if (m && m.needsInput) return { label: 'Нужно разрешение', kind: 'wait' };
    return { label: this.messages.length ? 'Ожидает' : 'Готов', kind: 'idle' };
  }
  update(n) { this.node = n; if (!this.running) { this.modeSel.value = n.data.mode || this.modeSel.value; this.fillModelOptions(); this.renderCwd(); this.renderAll(); } }
  edit() { this.input.focus(); }
  destroy() { this.offEdges?.(); }
  dispose() { this.stop(); }
}

// =====================================================================
// Note (vault markdown file)
// =====================================================================
class NoteInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view; this.body = body;
    this.editor = new RichEditor({
      compact: true,
      extraButtons: [{ icon: 'sidebarRight', title: 'Открыть в боковом редакторе', onClick: () => bus.emit('openNotePath', this.node.data.path) }],
    });
    this.missing = h('div', { class: 'note-missing', style: { display: 'none' } });
    body.append(this.editor.el, this.missing);
    this.editor.content.classList.add('scrollable');
    this.editor.on('openLink', (name) => this.openLinked(name));
    this.editor.on('openTag', (tag) => bus.emit('searchTag', tag));
    this.editor.on('saved', () => vaultIndex.refreshSoon());
    this.offIdx = vaultIndex.on('change', () => { this.editor.refreshFromDisk(); this.view.syncHead(this.view.node(this.node.id) || this.node); });
    this.load();
  }
  async load() {
    const p = this.node.data.path;
    try {
      await native.vault.read(p);
      this.missing.style.display = 'none'; this.editor.el.style.display = '';
      await this.editor.load(p);
    } catch {
      this.editor.el.style.display = 'none';
      this.missing.style.display = 'flex';
      this.missing.replaceChildren(h('div', {}, `Заметка «${p}» не найдена`), h('button', { class: 'btn sm', onclick: async () => { await native.vault.write(p, `# ${p.split('/').pop().replace(/\.md$/, '')}\n\n`); await vaultIndex.refresh(); this.load(); } }, 'Создать'));
    }
  }
  async openLinked(name) {
    let note = vaultIndex.byName(name);
    if (!note) {
      const p = await native.vault.create('', name, '');
      await vaultIndex.refresh();
      note = vaultIndex.byPath(p);
    }
    const existing = this.view.doc.nodes.find((n) => n.type === 'note' && n.data.path === note.path);
    if (existing) { this.view.focusNode(existing.id); return; }
    const me = this.view.node(this.node.id);
    const siblings = this.view.connected(me.id).length;
    const n = this.view.addNode('note', { x: me.x + me.w + 80, y: me.y + siblings * 60, data: { path: note.path } }, { center: false });
    this.view.addEdge(me.id, n.id);
  }
  // compare with the path actually loaded: this.node is the same object that was just patched
  update(n) {
    this.node = n;
    const ed = this.editor;
    if (n.data.path === ed.path) return;
    // edits not yet written go to the new file (rename / duplicate), never back to the old one
    if (ed.path && ed.getMarkdown() !== ed.lastSaved) { ed.save.cancel?.(); ed.path = n.data.path; ed.saveNow(); return; }
    this.load();
  }
  edit() { this.editor.focus(); }
  destroy() { this.offIdx(); this.editor.destroy(); }
}

// =====================================================================
// Simple editable bare nodes
// =====================================================================
function editableText(el, { html = false, onCommit }) {
  let before = '';
  const commit = () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    const v = html ? el.innerHTML : el.innerText.replace(/\n$/, '');
    if (v !== before) onCommit(v);
  };
  el.addEventListener('blur', commit);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
  });
  el.addEventListener('paste', (e) => {
    if (html) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  return (e) => {
    if (el.isContentEditable) return;
    before = html ? el.innerHTML : el.innerText;
    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();
    // caret where the user clicked; otherwise at the end (empty text: select all)
    let r = null;
    if (e && e.clientX != null && before.trim()) {
      const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (at && el.contains(at.startContainer)) r = at;
    }
    if (!r) { r = document.createRange(); r.selectNodeContents(el); if (before.trim()) r.collapse(false); }
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
}

function fitText(el, box) {
  // shrink font so text fits the sticky
  let size = 22;
  el.style.fontSize = `${size}px`;
  while (size > 11 && (el.scrollHeight > box.clientHeight - 8 || el.scrollWidth > box.clientWidth - 4)) { size -= 1; el.style.fontSize = `${size}px`; }
}

// =====================================================================
// Registry
// =====================================================================
export const NODE_TYPES = {
  terminal: {
    chrome: 'window', defaultSize: { w: 760, h: 460 }, minSize: { w: 300, h: 160 },
    defaultData: () => ({ agentId: 'shell' }),
    title: (n) => n.data.title || `${state.project.name.toLowerCase().replace(/\s+/g, '')} · ${state.agent(n.data.agentId).name}`,
    badge: (n, size) => { const a = state.agent(n.data.agentId); return badge(a.mono, a.color, size, a.dark); },
    status: (n, inst) => inst?.statusInfo?.() || { label: 'Остановлен', kind: 'off' },
    mount: (ctx) => new TerminalInstance(ctx),
    rename: async (n, view) => { const t = await prompt('Название окна', NODE_TYPES.terminal.title(n)); if (t != null) view.updateNode(n.id, { data: { title: t } }, { checkpoint: true }); },
    menu: (n, view, inst) => [
      { label: 'Перезапустить', icon: 'refresh', onClick: () => inst?.restart() },
      { label: 'Остановить', icon: 'stop', onClick: () => inst?.stop() },
      state.agent(n.data.agentId).resumeArgs ? { label: 'Продолжить прошлую сессию', icon: 'play', onClick: async () => { await inst?.stop(); inst?.term.reset(); inst?.spawn(true); } } : null,
      { label: 'Вставить связанные заметки', icon: 'note', onClick: async () => {
        const parts = [];
        for (const c of view.connected(n.id)) {
          if (c.type === 'note') parts.push(await native.vault.read(c.data.path).catch(() => ''));
          if (c.type === 'sticky' || c.type === 'shape') parts.push(c.data.text || '');
          if (c.type === 'chat') { const last = [...(c.data.messages || [])].reverse().find((m) => m.role === 'assistant'); if (last) parts.push(last.content); }
        }
        if (!parts.filter(Boolean).length) { toast('Соедините терминал стрелкой с заметкой или стикером', 'warn'); return; }
        inst?.sendText(parts.filter(Boolean).join('\n\n'));
      } },
      { label: 'Переименовать', icon: 'pen', onClick: () => NODE_TYPES.terminal.rename(n, view) },
    ].filter(Boolean),
  },

  chat: {
    chrome: 'window', defaultSize: { w: 460, h: 560 }, minSize: { w: 300, h: 260 },
    defaultData: () => ({ provider: state.settings.defaultProvider || 'openai', model: '', messages: [], title: 'Новый чат' }),
    title: (n) => n.data.title || 'Новый чат',
    badge: (n, size) => { const m = PROVIDER_META[n.data.provider] || PROVIDER_META.custom; return badge(m.mono, m.color, size, m.dark); },
    status: (n, inst) => inst?.statusInfo?.() || { label: 'Готов', kind: 'idle' },
    mount: (ctx) => new ChatInstance(ctx),
    rename: async (n, view) => { const t = await prompt('Название чата', n.data.title); if (t != null) view.updateNode(n.id, { data: { title: t } }, { checkpoint: true }); },
    menu: (n, view, inst) => [
      { label: 'Системный промпт…', icon: 'settings', onClick: async () => { const t = await prompt('Системный промпт', n.data.system || '', 'Ты — опытный разработчик…'); if (t != null) view.setData(n.id, { system: t }); } },
      { label: 'Сохранить чат в заметку', icon: 'save', onClick: async () => {
        const md = `# ${n.data.title || 'Чат'}\n\n` + (n.data.messages || []).map((m) => `**${m.role === 'user' ? 'Я' : 'AI'}:**\n\n${m.content}`).join('\n\n---\n\n') + '\n';
        const p = await native.vault.create('Чаты', n.data.title || 'Чат', md);
        await vaultIndex.refresh(); toast(`Сохранено: ${p}`);
      } },
      { label: 'История чатов', icon: 'sidebar', onClick: () => inst?.hist.open() },
      { label: 'Новый чат', icon: 'plus', onClick: () => inst?.hist.newChat() },
      { label: 'Переименовать', icon: 'pen', onClick: () => NODE_TYPES.chat.rename(n, view) },
    ],
  },

  agentchat: {
    chrome: 'window', defaultSize: { w: 500, h: 620 }, minSize: { w: 320, h: 280 },
    defaultData: () => ({ agentId: 'claude', kind: 'claude', messages: [], sessionId: null }),
    title: (n) => n.data.title || `${state.agent(n.data.agentId).name} · чат`,
    badge: (n, size) => { const a = state.agent(n.data.agentId); return badge(a.mono, a.color, size, a.dark); },
    status: (n, inst) => inst?.statusInfo?.() || { label: 'Готов', kind: 'idle' },
    mount: (ctx) => new AgentChatInstance(ctx),
    rename: async (n, view) => { const t = await prompt('Название окна', NODE_TYPES.agentchat.title(n)); if (t != null) view.updateNode(n.id, { data: { title: t } }, { checkpoint: true }); },
    menu: (n, view, inst) => [
      { label: 'История чатов', icon: 'sidebar', onClick: () => inst?.hist.open() },
      { label: 'Новый чат', icon: 'plus', onClick: () => inst?.newSession() },
      { label: 'Сменить рабочую папку…', icon: 'folder', onClick: () => inst?.pickCwd() },
      { label: 'Открыть эту сессию в терминале', icon: 'terminal', onClick: () => {
        const a = state.agent(n.data.agentId);
        const sid = n.data.sessionId;
        const extra = sid ? (n.data.kind === 'codex' ? `resume ${sid}` : `--resume ${sid}`) : '';
        native.trust?.add([[a.cmd, a.args, extra].filter(Boolean).join(' ')]); // started by the user here
        const t = view.addNode('terminal', { x: n.x + n.w + 60, y: n.y, data: { agentId: a.id, extraArgs: extra, cwd: n.data.cwd } }, { center: false });
        view.addEdge(n.id, t.id);
      } },
      { label: 'Сохранить переписку в заметку', icon: 'save', onClick: async () => {
        const md = `# ${NODE_TYPES.agentchat.title(n)}\n\n` + (n.data.messages || []).map((m) => `**${m.role === 'user' ? 'Я' : state.agent(n.data.agentId).name}:**\n\n${m.content}`).join('\n\n---\n\n') + '\n';
        const p = await native.vault.create('Чаты', NODE_TYPES.agentchat.title(n), md);
        await vaultIndex.refresh(); toast(`Сохранено: ${p}`);
      } },
      { label: 'Переименовать', icon: 'pen', onClick: () => NODE_TYPES.agentchat.rename(n, view) },
    ],
  },

  note: {
    chrome: 'window', defaultSize: { w: 420, h: 380 }, minSize: { w: 240, h: 140 },
    defaultData: () => ({ path: '' }),
    title: (n) => (n.data.path || 'Заметка').split('/').pop().replace(/\.md$/, ''),
    badge: (n, size) => { const s = h('span', { class: 'note-badge', style: { width: `${size}px`, height: `${size}px` }, html: icon('note', Math.round(size * 0.8)) }); return s; },
    mount: (ctx) => new NoteInstance(ctx),
    rename: async (n, view) => {
      const old = n.data.path; const name = await prompt('Переименовать заметку', NODE_TYPES.note.title(n));
      if (!name) return;
      const np = old.includes('/') ? old.replace(/[^/]+$/, `${name}.md`) : `${name}.md`;
      try { await native.vault.rename(old, np); for (const x of view.doc.nodes) if (x.type === 'note' && x.data.path === old) view.updateNode(x.id, { data: { path: np } }); await vaultIndex.refresh(); }
      catch (e) { toast(e.message, 'error'); }
    },
    menu: (n, view) => [
      { label: 'Открыть в редакторе', icon: 'sidebarRight', onClick: () => bus.emit('openNotePath', n.data.path) },
      { label: 'Добавить связанные заметки', icon: 'graph', onClick: () => bus.emit('expandNote', n.id) },
      { label: 'Отправить в связанный терминал', icon: 'terminal', onClick: async () => {
        const t = view.connected(n.id).find((x) => x.type === 'terminal');
        if (!t) { toast('Соедините заметку стрелкой с терминалом', 'warn'); return; }
        view.views.get(t.id)?.inst?.sendText(await native.vault.read(n.data.path));
      } },
      { label: 'Переименовать', icon: 'pen', onClick: () => NODE_TYPES.note.rename(n, view) },
      { label: 'Показать в папке', icon: 'folder', onClick: () => native.vault.reveal(n.data.path) },
    ],
  },

  web: {
    chrome: 'window', defaultSize: { w: 900, h: 600 }, minSize: { w: 320, h: 200 },
    defaultData: () => ({ url: 'https://www.google.com' }),
    title: (n) => { try { return new URL(n.data.url).host; } catch { return 'Веб-страница'; } },
    badge: (n, size) => { const s = h('span', { class: 'note-badge web', style: { width: `${size}px`, height: `${size}px` }, html: icon('globe', Math.round(size * 0.8)) }); return s; },
    mount: ({ node, view, body }) => {
      const url = h('input', { class: 'input sm no-drag', value: node.data.url });
      const isEl = native.isElectron;
      const frame = isEl ? h('webview', { src: node.data.url, class: 'web-frame', allowpopups: true }) : h('iframe', { src: node.data.url, class: 'web-frame' });
      const go = () => { let u = url.value.trim(); if (!/^[a-z]+:\/\//i.test(u)) u = /\s|^[^.]+$/.test(u) ? `https://www.google.com/search?q=${encodeURIComponent(u)}` : `https://${u}`; url.value = u; frame.src = u; view.setData(node.id, { url: u }); };
      url.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
      if (isEl) frame.addEventListener('did-navigate', (e) => { url.value = e.url; view.setData(node.id, { url: e.url }); });
      body.append(h('div', { class: 'web-bar' },
        h('button', { class: 'icon-btn sm', html: icon('undo', 13), title: 'Назад', onclick: () => isEl && frame.canGoBack() && frame.goBack() }),
        h('button', { class: 'icon-btn sm', html: icon('refresh', 13), title: 'Обновить', onclick: () => (isEl ? frame.reload() : (frame.src = frame.src)) }),
        url,
        h('button', { class: 'icon-btn sm', html: icon('external', 13), title: 'Открыть в браузере', onclick: () => native.shell.open(url.value) })),
        frame);
      return { edit: () => url.focus(), update: (n) => { if (n.data.url !== url.value) { url.value = n.data.url; frame.src = n.data.url; } } };
    },
  },

  sticky: {
    chrome: 'bare', defaultSize: { w: 220, h: 220 }, minSize: { w: 80, h: 60 }, colors: STICKY_COLORS,
    defaultData: () => ({ text: '', color: STICKY_COLORS[0] }),
    title: (n) => (n.data.text || 'Стикер').split('\n')[0].slice(0, 30),
    mount: ({ node, view, body }) => {
      const box = h('div', { class: 'sticky' });
      const txt = h('div', { class: 'txt', 'data-placeholder': 'Напишите что-нибудь…' });
      box.append(txt); body.append(box);
      let cur = node;
      const paint = () => { box.style.background = cur.data.color || STICKY_COLORS[0]; txt.innerText = cur.data.text || ''; txt.classList.toggle('empty', !cur.data.text); requestAnimationFrame(() => fitText(txt, box)); };
      const edit = editableText(txt, { onCommit: (v) => view.updateNode(cur.id, { data: { text: v } }, { checkpoint: true, silent: true }) });
      txt.addEventListener('input', () => { txt.classList.toggle('empty', !txt.innerText.trim()); fitText(txt, box); });
      paint();
      return { edit, update: (n) => { cur = n; if (!txt.isContentEditable) paint(); }, onResize: () => fitText(txt, box) };
    },
  },

  text: {
    chrome: 'bare', defaultSize: { w: 320, h: 60 }, minSize: { w: 40, h: 24 },
    defaultData: () => ({ html: '', size: 20 }),
    title: (n) => htmlText(n.data.html).slice(0, 30) || 'Текст',
    mount: ({ node, view, body }) => {
      const txt = h('div', { class: 'free-text txt', 'data-placeholder': 'Текст' });
      body.append(txt);
      let cur = node;
      const paint = () => { txt.innerHTML = sanitizeHtml(cur.data.html || ''); txt.style.fontSize = `${cur.data.size || 20}px`; txt.classList.toggle('empty', !txt.textContent.trim()); };
      const grow = () => { const n = view.node(cur.id); if (n && txt.scrollHeight > n.h) { n.h = txt.scrollHeight + 4; view.syncView(n); view.updateOverlay(); } };
      const edit = editableText(txt, { html: true, onCommit: (v) => { view.updateNode(cur.id, { data: { html: sanitizeHtml(v) } }, { checkpoint: true, silent: true }); txt.classList.toggle('empty', !txt.textContent.trim()); } });
      txt.addEventListener('input', () => { txt.classList.remove('empty'); grow(); });
      paint();
      // a new font size: fit the box height to the text (both ways)
      const fitH = () => { const n = view.node(cur.id); if (!n) return; txt.style.minHeight = '0'; const need = Math.max(24, txt.scrollHeight + 4); txt.style.minHeight = ''; if (Math.abs(need - n.h) > 1) { n.h = need; view.syncView(n); view.updateOverlay(); } };
      let lastSize = node.data.size;
      return { edit, update: (n) => { const resized = (n.data.size || 20) !== (lastSize || 20); lastSize = n.data.size; cur = n; if (!txt.isContentEditable) { paint(); resized ? fitH() : grow(); } else if (resized) { txt.style.fontSize = `${n.data.size || 20}px`; fitH(); } } };
    },
  },

  drawing: {
    chrome: 'bare', defaultSize: { w: 100, h: 100 }, minSize: { w: 6, h: 6 },
    defaultData: () => ({ pts: [], color: 'auto', width: 3, opacity: 1, tool: 'pen' }),
    title: (n) => ({ marker: 'Маркер', pencil: 'Карандаш' })[n.data.tool] || 'Рисунок',
    mount: ({ node, body }) => {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'draw-svg');
      const hit = document.createElementNS(NS, 'path'); hit.setAttribute('class', 'draw-hit');
      const line = document.createElementNS(NS, 'path'); line.setAttribute('class', 'draw-line');
      svg.append(hit, line);
      body.append(svg);
      let cur = node;
      // points are stored relative to the box (0..1), so resizing scales the drawing but not the line width
      const paint = (n = cur) => {
        const w = Math.max(1, n.w), hh = Math.max(1, n.h);
        svg.setAttribute('viewBox', `0 0 ${w} ${hh}`);
        const d = strokePath((n.data.pts || []).map(([u, v]) => [u * w, v * hh]));
        const sw = n.data.width || 4;
        line.setAttribute('d', d); hit.setAttribute('d', d);
        line.setAttribute('stroke-width', sw); hit.setAttribute('stroke-width', sw + 12);
        line.style.stroke = cssColor(n.data.color || 'auto');
        line.style.strokeOpacity = String(n.data.opacity ?? 1);
      };
      paint();
      return { update: (n) => { cur = n; paint(); }, onResize: (n) => paint(n || cur) };
    },
  },

  shape: {
    chrome: 'bare', defaultSize: { w: 200, h: 140 }, minSize: { w: 30, h: 30 }, colors: SHAPE_COLORS,
    defaultData: () => ({ kind: 'rect', color: SHAPE_COLORS[0], text: '' }),
    title: (n) => n.data.text || ({ rect: 'Прямоугольник', ellipse: 'Эллипс', diamond: 'Ромб' })[n.data.kind] || 'Фигура',
    mount: ({ node, view, body }) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'shape-svg'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('viewBox', '0 0 100 100');
      const txt = h('div', { class: 'shape-text txt' });
      body.append(svg, txt);
      let cur = node;
      const paint = () => {
        const c = cur.data.color || SHAPE_COLORS[0];
        const shape = cur.data.kind === 'ellipse' ? '<ellipse cx="50" cy="50" rx="49" ry="49"/>' : cur.data.kind === 'diamond' ? '<path d="M50 1 L99 50 L50 99 L1 50 Z"/>' : '<rect x="1" y="1" width="98" height="98" rx="6" ry="6"/>';
        svg.innerHTML = `<g fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke" style="vector-effect:non-scaling-stroke">${shape.replace('/>', ' vector-effect="non-scaling-stroke"/>')}</g>`;
        txt.innerText = cur.data.text || '';
      };
      const edit = editableText(txt, { onCommit: (v) => view.updateNode(cur.id, { data: { text: v } }, { checkpoint: true, silent: true }) });
      paint();
      return { edit, update: (n) => { cur = n; if (!txt.isContentEditable) paint(); } };
    },
  },

  frame: {
    chrome: 'bare', defaultSize: { w: 800, h: 520 }, minSize: { w: 120, h: 80 }, colors: FRAME_COLORS,
    defaultData: () => ({ title: 'Область', color: FRAME_COLORS[0] }),
    title: (n) => n.data.title || 'Область',
    mount: ({ node, view, body }) => {
      const title = h('div', { class: 'frame-title txt' });
      const area = h('div', { class: 'frame-area' });
      const count = h('div', { class: 'frame-count' });
      body.append(title, count, area);
      let cur = node;
      const paint = () => { title.textContent = cur.data.title || 'Область'; area.style.setProperty('--fc', cur.data.color || FRAME_COLORS[0]); title.style.setProperty('--fc', cur.data.color || FRAME_COLORS[0]); count.style.setProperty('--fc', cur.data.color || FRAME_COLORS[0]); };
      const edit = editableText(title, { onCommit: (v) => view.updateNode(cur.id, { data: { title: v.trim() || 'Область' } }, { checkpoint: true, silent: true }) });
      paint();
      let ck = '';
      const setCount = (k, grouped) => {
        const key = `${k}|${grouped}`;
        if (key === ck) return; ck = key;
        count.replaceChildren(...(grouped ? [h('span', { html: icon('link', 11) })] : []), document.createTextNode(k ? `${k} ${plural(k, 'объект', 'объекта', 'объектов')}` : (grouped ? 'группа' : '')));
        count.style.display = k || grouped ? '' : 'none';
        count.title = grouped ? 'Группа: область и содержимое двигаются вместе. Ctrl + клик — выбрать объект внутри' : 'Объекты внутри области двигаются вместе с ней';
      };
      return { edit: (e) => { if (!e || e.target === title) edit(); }, update: (n) => { cur = n; if (!title.isContentEditable) paint(); }, setCount };
    },
    menu: (n, view) => [
      { label: 'Ввести название…', icon: 'text', onClick: async () => {
        const t = await prompt('Название области', n.data.title || 'Область', 'например Фото проекта 1');
        if (t != null) view.updateNode(n.id, { data: { title: t.trim() || 'Область' } }, { checkpoint: true });
      } },
      '-',
      { label: n.data.grouped ? 'Разрешить выбирать объекты по отдельности' : 'Сгруппировать: двигать как одно целое', icon: 'link', onClick: () => view.toggleGrouped(n) },
      { label: 'Выделить содержимое', icon: 'squares', onClick: () => view.selectContents(n) },
      { label: 'Разгруппировать (убрать область)', icon: 'area', onClick: () => view.ungroupFrame(n) },
      { label: 'Удалить вместе с содержимым', icon: 'trash', danger: true, onClick: () => view.removeFrameWithContents(n) },
    ],
  },

  widget: {
    chrome: 'bare', defaultSize: { w: 300, h: 240 }, minSize: { w: 150, h: 110 },
    defaultData: () => ({ kind: 'clock' }),
    title: (n) => WIDGETS[n.data.kind]?.name || 'Виджет',
    mount: (ctx) => mountWidget(ctx),
    menu: (n, view, inst) => inst?.menu?.() || [],
  },

  image: {
    chrome: 'bare', defaultSize: { w: 360, h: 240 }, minSize: { w: 40, h: 40 }, keepRatio: true,
    defaultData: () => ({ src: '' }),
    title: (n) => n.data.name || (n.data.vault || 'Изображение').split('/').pop(),
    mount: ({ node, body }) => {
      const img = h('img', { class: 'image-node', draggable: 'false' });
      body.append(img);
      const load = async (n) => { if (n.data.vault) { try { img.src = await native.vault.readAsset(n.data.vault); } catch { img.alt = 'не найдено'; } } else img.src = n.data.src || ''; };
      load(node);
      return { update: load };
    },
  },

  hub: {
    chrome: 'bare', defaultSize: { w: 540, h: 320 }, minSize: { w: 420, h: 260 },
    defaultData: () => ({}),
    title: () => 'Пульт агентов',
    mount: (ctx) => mountHub(ctx),
  },
};

export async function imageNodeFromFile(view, file, world) {
  const dataUrl = await readFileAsDataURL(file);
  const rel = await native.vault.saveAsset(dataUrl, file.name);
  vaultIndex.addAsset(rel);
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.onerror = r; img.src = dataUrl; });
  let w = img.naturalWidth || 360, hh = img.naturalHeight || 240;
  const k = Math.min(1, 520 / Math.max(w, hh));
  w = Math.round(w * k); hh = Math.round(hh * k);
  return view.addNode('image', { x: world.x, y: world.y, w, h: hh, data: { vault: rel } });
}

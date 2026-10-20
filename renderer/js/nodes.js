// Node type definitions for the canvas.
import { h, icon, badge, esc, bus, toast, prompt, debounce, throttle, uid, readFileAsDataURL } from './util.js';
import { state, native, PROVIDER_META } from './state.js';
import { renderChatMarkdown } from './md.js';
import { RichEditor } from './editor.js';
import { vaultIndex } from './vaultIndex.js';
import { mountHub } from './hub.js';

// ---------------- routers for main-process events ----------------
const ptyRoutes = new Map();
native.pty.onData(({ id, data }) => ptyRoutes.get(id)?.onData(data));
native.pty.onExit(({ id, code, error }) => ptyRoutes.get(id)?.onExit(code, error));
const chatRoutes = new Map();
native.chat.onEvent((ev) => chatRoutes.get(ev.reqId)?.(ev));
native.agentChat.onEvent((ev) => chatRoutes.get(ev.reqId)?.(ev));

export const STICKY_COLORS = ['#ffe58a', '#ffcd9e', '#ffb8d1', '#d6c2ff', '#a8d8ff', '#b5f0c0', '#e2e5ea'];
const SHAPE_COLORS = ['#7c8cff', '#4fd1a5', '#f6a04d', '#e86a92', '#5bc0eb', '#e3c565', '#9aa3b2'];
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
      else if (n.type === 'text') { const d = h('div', { html: n.data.html || '' }); if (d.textContent.trim()) parts.push(`### Текст\n${d.textContent}`); }
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
      if (mod && e.key.toLowerCase() === 'c' && (this.term.hasSelection() || e.shiftKey)) { native.clipboard.write(this.term.getSelection()); return false; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'v') return false; // browser paste event will handle
      if (mod && e.key.toLowerCase() === 'v') return false;
      // let app-wide shortcuts through (Ctrl+Shift+P/O/N, Ctrl+\\, Ctrl+`)
      if (mod && e.shiftKey && ['p', 'o', 'n'].includes(e.key.toLowerCase())) return false;
      if (mod && (e.key === '\\' || e.key === '`')) return false;
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

  doFit = throttle(() => {
    if (!this.wrap.offsetWidth || !this.wrap.offsetHeight) return;
    try {
      this.fit.fit();
      if (this.sessionId) native.pty.resize(this.sessionId, this.term.cols, this.term.rows);
    } catch {}
  }, 60);

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
        setTimeout(() => this.doFit(), 30);
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
    this.sessionId = res.id;
    this.notFound = res.notFound;
    ptyRoutes.set(res.id, this);
    this.view.setData(this.node.id, { sessionId: res.id });
    this.state = res.error ? 'exited' : 'running';
    if (res.notFound && a.cmd) {
      this.term.write(`\x1b[33m⚠ Команда «${a.cmd}» не найдена в PATH.\x1b[0m\r\n${a.install ? `  Установите: \x1b[36m${a.install}\x1b[0m\r\n` : ''}  Или укажите полный путь в Настройки → Агенты.\r\n\r\n`);
    }
    setTimeout(() => this.doFit(), 50);
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
    return { label: 'Ожидает', kind: 'idle' };
  }

  syncHead() { this.view.syncHead(this.view.node(this.node.id) || this.node); bus.emit('agents'); }
  update(n) { this.node = n; }
  onLod(lod) { if (!lod) setTimeout(() => this.doFit(), 30); }
  onVisible() { setTimeout(() => this.doFit(), 30); }
  onResize() { this.doFit(); }
  edit() { this.term.focus(); }
  destroy() { this.ro.disconnect(); this.offTheme?.(); if (this.sessionId) ptyRoutes.delete(this.sessionId); this.term.dispose(); }
  dispose() { if (this.sessionId) native.pty.kill(this.sessionId); }
}

// =====================================================================
// API chat
// =====================================================================
class ChatInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view;
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
    this.foot = h('div', { class: 'chat-foot' }, this.input, this.sendBtn);
    this.usage = h('div', { class: 'chat-usage' });
    this.root.append(this.bar, this.list, this.ctxRow, this.foot, this.usage);
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
    this.messages.forEach((m, i) => this.list.append(this.renderMsg(m, i)));
    this.scrollDown(true);
  }

  renderMsg(m, i) {
    const el = h('div', { class: `msg ${m.role}${m.error ? ' error' : ''}` });
    if (m.role === 'user') el.append(h('div', { class: 'msg-text' }, m.content));
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
    if (!text || this.streaming) return;
    this.input.value = ''; this.input.style.height = 'auto';
    const msgs = [...this.messages, { role: 'user', content: text, ts: Date.now() }];
    const ctx = await this.buildContext();
    const system = [this.node.data.system, ctx ? `Ниже контекст, связанный с этим чатом на canvas пользователя:\n\n${ctx}` : ''].filter(Boolean).join('\n\n');
    const asst = { role: 'assistant', content: '', ts: Date.now() };
    const all = [...msgs, asst];
    this.view.setData(this.node.id, { messages: all });
    if (!this.node.data.title || this.node.data.title === 'Новый чат') this.view.setData(this.node.id, { title: text.slice(0, 40) });
    this.renderAll();
    const el = this.list.lastElementChild;
    const textEl = el.querySelector('.msg-text');
    textEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    const reqId = uid('req');
    this.streaming = reqId;
    this.sendBtn.innerHTML = icon('stop', 15); this.sendBtn.classList.add('stop');
    this.view.syncHead(this.view.node(this.node.id));
    const paint = throttle(() => { textEl.innerHTML = renderChatMarkdown(asst.content); this.scrollDown(); }, 60);
    chatRoutes.set(reqId, (ev) => {
      if (ev.type === 'delta') { asst.content += ev.text; paint(); }
      else if (ev.type === 'reasoning') { asst.reasoning = (asst.reasoning || '') + ev.text; }
      else if (ev.type === 'error') { asst.content = `⚠ ${ev.message}`; asst.error = true; this.finish(reqId, all); }
      else if (ev.type === 'done') { if (ev.usage) { asst.usage = ev.usage; } if (!asst.content && ev.aborted) asst.content = '_(остановлено)_'; this.finish(reqId, all); }
    });
    await native.chat.send({ reqId, provider: this.node.data.provider || 'openai', model: this.node.data.model, system, messages: msgs.map(({ role, content }) => ({ role, content })), settings: state.settings });
  }

  finish(reqId, all) {
    chatRoutes.delete(reqId);
    this.streaming = null;
    this.sendBtn.innerHTML = icon('send', 16); this.sendBtn.classList.remove('stop');
    this.view.setData(this.node.id, { messages: [...all] });
    this.renderAll();
    const tot = all.reduce((t, m) => t + (m.usage ? m.usage.input + m.usage.output : 0), 0);
    this.usage.textContent = tot ? `${tot.toLocaleString('ru-RU')} токенов в этом чате` : '';
    this.view.syncHead(this.view.node(this.node.id));
    bus.emit('limits:refresh');
  }

  stop() { if (this.streaming) native.chat.abort(this.streaming); }

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

class AgentChatInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view;
    this.running = null;
    this.root = h('div', { class: 'chat agent-chat' });
    this.modeSel = h('select', { class: 'select sm no-drag', title: 'Что агенту разрешено делать' });
    this.modelInput = h('input', { class: 'input sm no-drag model-input', placeholder: 'модель по умолчанию', title: node.data.kind === 'claude' ? 'Например: sonnet, opus' : 'Например: gpt-5-codex' });
    this.cwdBtn = h('button', { class: 'cwd-btn no-drag', title: 'Рабочая папка агента — нажмите, чтобы сменить', onclick: () => this.pickCwd() });
    this.newBtn = h('button', { class: 'icon-btn sm', title: 'Новая сессия (агент забудет переписку)', html: icon('plus', 14), onclick: () => this.newSession() });
    this.bar = h('div', { class: 'chat-bar' }, this.modeSel, this.modelInput, this.cwdBtn, this.newBtn);
    this.list = h('div', { class: 'chat-list scrollable' });
    this.ctxRow = h('div', { class: 'chat-ctx' });
    this.input = h('textarea', { class: 'chat-input', rows: 2, placeholder: 'Задача для агента… (Enter — отправить, Shift+Enter — новая строка)' });
    this.sendBtn = h('button', { class: 'chat-send', title: 'Отправить', html: icon('send', 16), onclick: () => (this.running ? this.stop() : this.send()) });
    this.usage = h('div', { class: 'chat-usage' });
    this.root.append(this.bar, this.list, this.ctxRow, h('div', { class: 'chat-foot' }, this.input, this.sendBtn), this.usage);
    body.append(this.root);
    for (const [v, l] of AGENT_MODES[this.kind] || []) this.modeSel.append(h('option', { value: v }, l));
    this.modeSel.value = node.data.mode || (AGENT_MODES[this.kind] || [[]])[0][0];
    this.modeSel.addEventListener('change', () => this.view.setData(this.node.id, { mode: this.modeSel.value }));
    this.modelInput.value = node.data.model || '';
    this.modelInput.addEventListener('change', () => this.view.setData(this.node.id, { model: this.modelInput.value.trim() }));
    this.modelInput.addEventListener('keydown', (e) => e.stopPropagation());
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

  renderCwd() { const c = this.cwd || ''; this.cwdBtn.replaceChildren(h('span', { html: icon('folder', 12) }), h('span', {}, c.split(/[\\/]/).filter(Boolean).pop() || c || 'папка')); this.cwdBtn.title = `Рабочая папка: ${c}\nНажмите, чтобы сменить`; }
  async pickCwd() { const p = await native.dialog.folder('Рабочая папка агента'); if (p) { this.view.setData(this.node.id, { cwd: p }); this.renderCwd(); } }
  newSession() { this.view.setData(this.node.id, { sessionId: null, messages: [], ctxHash: null }); this.renderAll(); toast('Начата новая сессия'); }
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
    this.messages.forEach((m, i) => this.list.append(this.renderMsg(m, i)));
    this.list.scrollTop = this.list.scrollHeight;
  }

  renderParts(m, el) {
    el.innerHTML = '';
    for (const p of m.parts || [{ type: 'text', text: m.content }]) {
      if (p.type === 'text' && p.text) el.append(h('div', { class: 'msg-text md', html: renderChatMarkdown(p.text) }));
      else if (p.type === 'reasoning' && p.text) el.append(h('details', { class: 'msg-reason' }, h('summary', {}, 'Размышления'), h('div', { class: 'reason-text' }, p.text)));
      else if (p.type === 'tool') {
        const d = h('details', { class: `tool-call ${p.status || ''}` },
          h('summary', {}, h('span', { class: 'tool-dot' }), h('b', {}, p.name), h('span', { class: 'tool-input' }, (p.input || '').split('\n')[0])));
        if (p.input && p.input.includes('\n')) d.append(h('pre', { class: 'tool-in' }, p.input));
        if (p.output) d.append(h('pre', { class: 'tool-out' }, p.output));
        el.append(d);
      } else if (p.type === 'error') el.append(h('div', { class: 'msg-error' }, `⚠ ${p.text}`));
      else if (p.type === 'notice') el.append(h('div', { class: 'muted small' }, p.text));
    }
    if (m.running && !(m.parts || []).length) el.append(h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  }

  renderMsg(m, i) {
    const el = h('div', { class: `msg ${m.role}` });
    if (m.role === 'user') el.append(h('div', { class: 'msg-text' }, m.content));
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
    if (!text || this.running) return;
    this.input.value = ''; this.input.style.height = 'auto';
    let prompt = text;
    const ctx = await buildContextText(this.view, this.node.id);
    const hash = ctx ? String(ctx.length) + ctx.slice(0, 200) + ctx.slice(-200) : null;
    if (ctx && hash !== this.node.data.ctxHash) {
      prompt = `Контекст с canvas пользователя (заметки и связанные окна):\n\n${ctx}\n\n---\n\n${text}`;
      this.view.setData(this.node.id, { ctxHash: hash });
    }
    const user = { role: 'user', content: text, ts: Date.now() };
    const asst = { role: 'assistant', content: '', parts: [], running: true, ts: Date.now() };
    const all = [...this.messages, user, asst];
    this.view.setData(this.node.id, { messages: all });
    if (!this.node.data.title) this.view.setData(this.node.id, { title: text.slice(0, 40) });
    this.renderAll();
    const body = this.list.lastElementChild.querySelector('.msg-body');
    const reqId = uid('ag');
    this.running = reqId;
    this.sendBtn.innerHTML = icon('stop', 15); this.sendBtn.classList.add('stop');
    this.syncHead();
    let newText = true;
    const paint = throttle(() => { this.renderParts(asst, body); this.list.scrollTop = this.list.scrollHeight; }, 70);
    const lastText = () => { const l = asst.parts[asst.parts.length - 1]; if (newText || !l || l.type !== 'text') { const p = { type: 'text', text: '' }; asst.parts.push(p); newText = false; return p; } return l; };
    chatRoutes.set(reqId, (ev) => {
      switch (ev.type) {
        case 'session': this.view.setData(this.node.id, { sessionId: ev.sessionId }); break;
        case 'delta': lastText().text += ev.text; break;
        case 'break': newText = true; break;
        case 'reasoning': { const l = asst.parts[asst.parts.length - 1]; if (l && l.type === 'reasoning') l.text += ev.text; else asst.parts.push({ type: 'reasoning', text: ev.text }); break; }
        case 'tool': if (!asst.parts.some((p) => p.type === 'tool' && p.id === ev.id)) asst.parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'run' }); newText = true; break;
        case 'toolResult': { const t = asst.parts.find((p) => p.type === 'tool' && p.id === ev.id); if (t) { t.output = ev.output; t.status = ev.isError ? 'err' : 'ok'; } break; }
        case 'notice': asst.parts.push({ type: 'notice', text: ev.text }); break;
        case 'error': asst.parts.push({ type: 'error', text: ev.message }); break;
        case 'done': this.finish(reqId, all, asst, ev); return;
        default: break;
      }
      paint();
    });
    await native.agentChat.run({ reqId, kind: this.kind, cmd: this.agent.cmd || this.kind, prompt, sessionId: this.node.data.sessionId, mode: this.modeSel.value, model: this.modelInput.value.trim(), cwd: this.cwd });
  }

  finish(reqId, all, asst, ev) {
    chatRoutes.delete(reqId);
    this.running = null;
    asst.running = false;
    for (const p of asst.parts) if (p.type === 'tool' && p.status === 'run') p.status = ev.aborted ? 'err' : 'ok';
    if (ev.aborted) asst.parts.push({ type: 'notice', text: 'Остановлено' });
    asst.content = asst.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
    if (ev.sessionId) this.view.setData(this.node.id, { sessionId: ev.sessionId });
    this.view.setData(this.node.id, { messages: [...all] });
    this.sendBtn.innerHTML = icon('send', 16); this.sendBtn.classList.remove('stop');
    const bits = [];
    if (ev.usage) bits.push(`${(ev.usage.input + ev.usage.output).toLocaleString('ru-RU')} ток.`);
    if (ev.cost) bits.push(`$${ev.cost.toFixed(4)}`);
    if (this.node.data.sessionId) bits.push(`сессия ${String(this.node.data.sessionId).slice(0, 8)}`);
    this.usage.textContent = bits.join(' · ');
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
    return { label: this.messages.length ? 'Ожидает' : 'Готов', kind: 'idle' };
  }
  update(n) { this.node = n; if (!this.running) { this.modeSel.value = n.data.mode || this.modeSel.value; this.modelInput.value = n.data.model || ''; this.renderCwd(); this.renderAll(); } }
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
  update(n) { const changed = n.data.path !== this.node.data.path; this.node = n; if (changed) this.load(); }
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
  return () => {
    before = html ? el.innerHTML : el.innerText;
    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    if (before.trim()) r.collapse(false);
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
// Photo gallery area
// =====================================================================
const assetCache = new Map();
async function loadAsset(rel) {
  if (!rel) return '';
  if (assetCache.has(rel)) return assetCache.get(rel);
  const p = native.vault.readAsset(rel).catch(() => '');
  assetCache.set(rel, p);
  if (assetCache.size > 400) assetCache.delete(assetCache.keys().next().value);
  return p;
}

async function makeThumb(dataUrl, max = 480) {
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.onerror = r; img.src = dataUrl; });
  const w = img.naturalWidth || 1, hh = img.naturalHeight || 1;
  const k = Math.min(1, max / Math.max(w, hh));
  if (k >= 1) return { url: dataUrl, w, h: hh, same: true };
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(hh * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/jpeg', 0.86), w, h: hh };
}

export async function imageEntryFromFile(file) {
  const dataUrl = await readFileAsDataURL(file);
  const rel = await native.vault.saveAsset(dataUrl, file.name);
  vaultIndex.addAsset(rel);
  const t = await makeThumb(dataUrl);
  let thumb = rel;
  if (!t.same) { thumb = await native.vault.saveAsset(t.url, `thumb ${file.name.replace(/\.[^.]+$/, '')}.jpg`); vaultIndex.addAsset(thumb); }
  assetCache.set(thumb, Promise.resolve(t.url));
  return { id: uid('ph'), vault: rel, thumb, w: t.w, h: t.h, name: file.name };
}

function lightbox(images, idx, { onExtract } = {}) {
  const back = h('div', { class: 'lightbox' });
  const img = h('img', { class: 'lb-img' });
  const cap = h('div', { class: 'lb-cap' });
  const show = async () => { const it = images[idx]; cap.textContent = `${idx + 1} / ${images.length}${it.name ? ' · ' + it.name : ''}`; img.src = await loadAsset(it.thumb); img.src = await loadAsset(it.vault); };
  const close = () => { back.remove(); document.removeEventListener('keydown', key, true); };
  const go = (d) => { idx = (idx + d + images.length) % images.length; show(); };
  const key = (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
  back.append(
    img, cap,
    h('button', { class: 'lb-btn lb-prev', html: icon('chevronRight', 26), onclick: (e) => { e.stopPropagation(); go(-1); } }),
    h('button', { class: 'lb-btn lb-next', html: icon('chevronRight', 26), onclick: (e) => { e.stopPropagation(); go(1); } }),
    h('div', { class: 'lb-tools' },
      onExtract ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); onExtract(images[idx]); close(); } }, 'Вынести на canvas') : null,
      h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); close(); } }, 'Закрыть')),
  );
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', key, true);
  document.body.append(back);
  show();
}

class GalleryInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view;
    this.root = h('div', { class: 'gallery' });
    this.title = h('div', { class: 'gal-title txt' });
    this.count = h('span', { class: 'gal-count' });
    this.addBtn = h('button', { class: 'gal-add no-drag', html: `${icon('plus', 14)}<span>Фото</span>`, title: 'Добавить фото', onclick: (e) => { e.stopPropagation(); this.pick(); } });
    this.grid = h('div', { class: 'gal-grid scrollable' });
    this.root.append(h('div', { class: 'gal-head' }, this.title, this.count, h('span', { class: 'flex' }), this.addBtn), this.grid);
    body.append(this.root);
    this.editTitle = editableText(this.title, { onCommit: (v) => view.updateNode(this.node.id, { data: { title: v.trim() || 'Галерея' } }, { checkpoint: true, silent: true }) });
    this.grid.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); this.remove(del.dataset.del); return; }
      const cell = e.target.closest('.gal-cell');
      if (cell && !this.view.justMoved()) { const imgs = this.images; const i = imgs.findIndex((x) => x.id === cell.dataset.id); if (i >= 0) lightbox(imgs, i, { onExtract: (it) => this.extract(it) }); }
    });
    this.paint();
  }
  get images() { return this.node.data.images || []; }
  paint() {
    const n = this.node;
    this.root.style.setProperty('--fc', n.data.color || FRAME_COLORS[0]);
    if (!this.title.isContentEditable) this.title.textContent = n.data.title || 'Галерея';
    const imgs = this.images;
    this.count.textContent = imgs.length ? `${imgs.length} фото` : '';
    const key = imgs.map((x) => x.id).join(',');
    if (key === this.gridKey) return;
    this.gridKey = key;
    this.grid.innerHTML = '';
    if (!imgs.length) { this.grid.append(h('div', { class: 'gal-empty' }, h('span', { html: icon('image', 28) }), h('div', {}, 'Перетащите сюда фото'), h('div', { class: 'muted small' }, 'или нажмите «+ Фото», вставьте из буфера, перетащите картинку с canvas'))); return; }
    for (const it of imgs) {
      const im = h('img', { loading: 'lazy', decoding: 'async', draggable: 'false', alt: '' });
      loadAsset(it.thumb || it.vault).then((u) => { im.src = u; });
      this.grid.append(h('div', { class: 'gal-cell', 'data-id': it.id, title: it.name || '' }, im, h('button', { class: 'gal-del no-drag', 'data-del': it.id, title: 'Убрать из галереи', html: icon('x', 12) })));
    }
  }
  async pick() {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
    input.onchange = () => this.addFiles([...input.files]);
    input.click();
  }
  async addFiles(files) {
    const list = files.filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    toast(`Добавляю фото: ${list.length}`);
    const entries = [];
    for (const f of list) { try { entries.push(await imageEntryFromFile(f)); } catch (e) { toast(`Не удалось: ${f.name}`, 'error'); } }
    this.addEntries(entries);
  }
  addEntries(entries) {
    if (!entries.length) return;
    this.view.updateNode(this.node.id, { data: { images: [...this.images, ...entries] } }, { checkpoint: true });
    this.autoGrow();
  }
  remove(id) { this.view.updateNode(this.node.id, { data: { images: this.images.filter((x) => x.id !== id) } }, { checkpoint: true }); }
  extract(it) {
    const n = this.view.node(this.node.id);
    const k = Math.min(1, 420 / Math.max(it.w || 420, it.h || 300));
    this.view.addNode('image', { x: n.x + n.w + 40, y: n.y, w: Math.round((it.w || 420) * k), h: Math.round((it.h || 300) * k), data: { vault: it.vault } }, { center: false });
    this.remove(it.id);
  }
  autoGrow() {
    requestAnimationFrame(() => {
      const n = this.view.node(this.node.id); if (!n) return;
      const need = this.grid.scrollHeight + this.grid.offsetTop + 16;
      if (need > n.h) this.view.updateNode(n.id, { h: Math.min(need, 4000) });
    });
  }
  update(n) { this.node = n; this.paint(); }
  edit(e) { if (!e || e.target.closest('.gal-title') || e.target.closest('.gal-head')) this.editTitle(); }
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
      { label: 'Очистить историю', icon: 'trash', onClick: () => { view.setData(n.id, { messages: [] }); inst?.renderAll(); } },
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
      { label: 'Новая сессия', icon: 'plus', onClick: () => inst?.newSession() },
      { label: 'Сменить рабочую папку…', icon: 'folder', onClick: () => inst?.pickCwd() },
      { label: 'Открыть эту сессию в терминале', icon: 'terminal', onClick: () => {
        const a = state.agent(n.data.agentId);
        const sid = n.data.sessionId;
        const extra = sid ? (n.data.kind === 'codex' ? `resume ${sid}` : `--resume ${sid}`) : '';
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
    title: (n) => h('div', { html: n.data.html || '' }).textContent.slice(0, 30) || 'Текст',
    mount: ({ node, view, body }) => {
      const txt = h('div', { class: 'free-text txt', 'data-placeholder': 'Текст' });
      body.append(txt);
      let cur = node;
      const paint = () => { txt.innerHTML = cur.data.html || ''; txt.style.fontSize = `${cur.data.size || 20}px`; txt.classList.toggle('empty', !txt.textContent.trim()); };
      const grow = () => { const n = view.node(cur.id); if (n && txt.scrollHeight > n.h) { n.h = txt.scrollHeight + 4; view.syncView(n); view.updateOverlay(); } };
      const edit = editableText(txt, { html: true, onCommit: (v) => { view.updateNode(cur.id, { data: { html: v } }, { checkpoint: true, silent: true }); txt.classList.toggle('empty', !txt.textContent.trim()); } });
      txt.addEventListener('input', () => { txt.classList.remove('empty'); grow(); });
      paint();
      return { edit, update: (n) => { cur = n; if (!txt.isContentEditable) { paint(); grow(); } } };
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
      body.append(title, area);
      let cur = node;
      const paint = () => { title.textContent = cur.data.title || 'Область'; area.style.setProperty('--fc', cur.data.color || FRAME_COLORS[0]); title.style.setProperty('--fc', cur.data.color || FRAME_COLORS[0]); };
      const edit = editableText(title, { onCommit: (v) => view.updateNode(cur.id, { data: { title: v.trim() || 'Область' } }, { checkpoint: true, silent: true }) });
      paint();
      return { edit: (e) => { if (!e || e.target === title) edit(); }, update: (n) => { cur = n; if (!title.isContentEditable) paint(); } };
    },
  },

  gallery: {
    chrome: 'bare', defaultSize: { w: 660, h: 440 }, minSize: { w: 260, h: 180 }, colors: FRAME_COLORS,
    defaultData: () => ({ title: 'Фото проекта', color: FRAME_COLORS[0], images: [] }),
    title: (n) => n.data.title || 'Галерея',
    mount: (ctx) => new GalleryInstance(ctx),
    menu: (n, view, inst) => [
      { label: 'Добавить фото…', icon: 'image', onClick: () => inst?.pick() },
      { label: 'Переименовать', icon: 'pen', onClick: () => inst?.editTitle() },
    ],
  },

  image: {
    chrome: 'bare', defaultSize: { w: 360, h: 240 }, minSize: { w: 40, h: 40 }, keepRatio: true,
    defaultData: () => ({ src: '' }),
    title: (n) => (n.data.vault || 'Изображение').split('/').pop(),
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

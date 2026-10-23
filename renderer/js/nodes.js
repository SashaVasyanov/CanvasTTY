// Node type definitions for the canvas.
import { h, icon, badge, esc, bus, toast, prompt, confirmBox, menu, modal, debounce, throttle, uid, readFileAsDataURL, keyName } from './util.js';
import { cssColor, wantsWhiteText, BAR_COLORS, OBJECT_COLORS, STICKY_COLORS } from './pentools.js';
import { sanitizeHtml, htmlText } from './sanitize.js';
import { WIDGETS, mountWidget } from './widgets.js';
import { state, native, PROVIDER_META, providerName, editCanvasFile } from './state.js';
import { renderChatMarkdown } from './md.js';
import { RichEditor } from './editor.js';
import { vaultIndex } from './vaultIndex.js';
import { mountHub } from './hub.js';
import { ChatHistory, saveConversation } from './chathistory.js';
import { AttachBar, renderAttachments, viewImages } from './attach.js';
import { chatContext, imagesToAttachments, renderContextRow, renderContextNote, attachMentions } from './context.js';
import { explainError, ERROR_ACTIONS } from './errors.js';
import { inbox } from './inbox.js';

// ---------------- routers for main-process events ----------------
const ptyRoutes = new Map();
native.pty.onData(({ id, data }) => ptyRoutes.get(id)?.onData(data));
native.pty.onExit(({ id, code, error }) => ptyRoutes.get(id)?.onExit(code, error));
const chatRoutes = new Map();
native.chat.onEvent((ev) => chatRoutes.get(ev.reqId)?.(ev));
native.agentChat.onEvent((ev) => chatRoutes.get(ev.reqId)?.(ev));

export { STICKY_COLORS };
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


// ---------------- following the newest message ----------------
// The list stays at the bottom while an answer streams, unless the reader scrolled up: then it
// stays where they are (reading history during a long answer) and a "to the newest" button shows.
function bindFollow(inst) {
  const l = inst.list;
  inst.follow = true;
  let ours = 0;
  inst.jumpBtn = h('button', { class: 'chat-jump no-drag', title: 'К последнему сообщению', html: icon('chevronDown', 15), onclick: (e) => { e.stopPropagation(); inst.follow = true; inst.toEnd(); } });
  const paintJump = () => inst.jumpBtn.classList.toggle('show', !inst.follow && l.scrollHeight - l.scrollTop - l.clientHeight > 60);
  inst.toEnd = () => {
    if (!inst.follow) { paintJump(); return; }
    if (!l.clientHeight) return; // hidden (zoomed out, off screen, not laid out yet): done when it shows
    ours = performance.now(); l.scrollTop = l.scrollHeight; paintJump();
  };
  // a list that just became visible or changed size keeps showing the newest message; refollow():
  // the same after the text got bigger or smaller (text size, zoom)
  inst.refollow = () => { if (inst.follow && l.clientHeight) { ours = performance.now(); l.scrollTop = l.scrollHeight; } };
  new ResizeObserver(() => inst.refollow()).observe(l);
  l.addEventListener('scroll', () => {
    if (performance.now() - ours < 120 || !l.clientHeight) return; // our own jump to the bottom / hidden
    inst.follow = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
    paintJump();
  }, { passive: true });
  l.addEventListener('wheel', (e) => { if (e.deltaY < 0 && l.scrollTop > 0) { inst.follow = false; paintJump(); } }, { passive: true });
  // pictures that finish loading make the list taller
  l.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') inst.toEnd(); }, true);
  inst.listWrap = h('div', { class: 'chat-list-wrap' }, l, inst.jumpBtn);
}

// ---------------- text size of the chat windows ----------------
// Settings → Агенты: the size for all chat windows and «readable when zoomed out» (styles.css: the
// text is then never smaller than 12 px on screen); a window can have its own size (menu, Ctrl + / −).
export const CHAT_FONT = { min: 10, max: 28, def: 14 };
const clampFont = (f) => Math.max(CHAT_FONT.min, Math.min(CHAT_FONT.max, Math.round(Number(f) || CHAT_FONT.def)));
export function applyChatText(view) {
  const st = state.settings || {};
  view.root.style.setProperty('--chat-fs', `${clampFont(st.chatFontSize || CHAT_FONT.def)}px`);
  view.root.style.setProperty('--chat-min', st.chatReadable === false ? '0px' : '12px');
  requestAnimationFrame(() => { for (const v of view.views.values()) v.inst?.refollow?.(); });
}
function applyWindowFont(inst) {
  const f = inst.node.data.fontSize;
  if (f) inst.root.style.setProperty('--chat-fs', `${clampFont(f)}px`); else inst.root.style.removeProperty('--chat-fs');
  requestAnimationFrame(() => inst.refollow?.());
}
const windowFont = (inst) => clampFont(inst.node.data.fontSize || state.settings.chatFontSize || CHAT_FONT.def);
// null: back to the size from the settings
function setWindowFont(inst, f) {
  const v = f == null ? null : clampFont(f);
  inst.view.setData(inst.node.id, { fontSize: v && v !== clampFont(state.settings.chatFontSize || CHAT_FONT.def) ? v : null });
  inst.node = inst.view.node(inst.node.id) || inst.node;
  applyWindowFont(inst);
}
function fontItems(inst) {
  return [
    { label: 'Крупнее', icon: 'plus', kbd: 'Ctrl +', onClick: () => setWindowFont(inst, windowFont(inst) + 1) },
    { label: 'Мельче', icon: 'minus', kbd: 'Ctrl −', onClick: () => setWindowFont(inst, windowFont(inst) - 1) },
    { label: 'Как в настройках', icon: 'refresh', kbd: 'Ctrl 0', disabled: !inst.node.data.fontSize, onClick: () => setWindowFont(inst, null) },
  ];
}
// Ctrl + / Ctrl − / Ctrl 0 in the input of a chat window (any keyboard layout)
function fontKeys(inst, e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.code;
  if (k === 'Equal' || k === 'NumpadAdd') setWindowFont(inst, windowFont(inst) + 1);
  else if (k === 'Minus' || k === 'NumpadSubtract') setWindowFont(inst, windowFont(inst) - 1);
  else if (k === 'Digit0' || k === 'Numpad0') setWindowFont(inst, null);
  else return false;
  e.preventDefault();
  return true;
}

// ---------------- canvas context shared by chat windows (see context.js) ----------------
// keeps the chips under the input current: arrows, @ in the text, what is inside linked areas
function bindContext(inst) {
  const { view } = inst;
  inst.mentions = attachMentions(inst.input, { view, selfId: inst.node.id });
  const soon = debounce(() => inst.renderCtx(), 250);
  inst.input.addEventListener('input', soon);
  const offs = [view.on('edges', () => inst.renderCtx()), view.on('changed', soon)];
  return () => { offs.forEach((f) => f?.()); inst.mentions.close(); };
}
const CTX_HINT = 'Соедините стрелкой с этим окном область, заметку, картинку или другой объект — или упомяните его в сообщении через @. Всё это уйдёт как контекст: текст в запрос, картинки — вложениями.';

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
// The window can be re-created while an answer streams (canvas switched and back, the canvas
// reloaded after sync): the new window must show that the agent is working, follow the text and
// be able to stop it, even though the old instance owns the run.
function runOf(inst) {
  const r = activeRuns.get(inst.node.id);
  return r && r !== inst && (r.running || r.streaming) && r.docId === inst.view.doc?.id ? r : null;
}
function twinOf(inst) {
  if (inst.view.doc?.id !== inst.docId) return null;
  const live = inst.view.views.get(inst.node.id)?.inst;
  return live && live !== inst ? live : null;
}
async function patchNodeData(inst, patch) {
  inst.node = { ...inst.node, data: { ...inst.node.data, ...patch } };
  const view = inst.view;
  if (view.doc?.id === inst.docId && view.node(inst.node.id)) {
    view.setData(inst.node.id, patch);
    // keep following the canvas' own node: a copy would go stale with the next setData
    // (the next question would not show until its answer ended)
    inst.node = view.node(inst.node.id);
    const live = view.views.get(inst.node.id)?.inst;
    if (live && live !== inst) { live.renderAll?.(); live.syncRunUi?.(); } // the window was re-created meanwhile
    return;
  }
  try {
    await editCanvasFile(inst.docId, (doc) => {
      const n = doc.nodes?.find((x) => x.id === inst.node.id);
      if (!n) return false;
      n.data = { ...n.data, ...patch };
    });
  } catch (e) { console.error('patchNodeData', e); }
}
const INTERRUPTED = 'Ответ прервался: приложение или компьютер закрылись, пока агент работал.';
const CONTINUE_PROMPT = 'Продолжи с того места, где остановился: твой предыдущий ответ прервался.';
// an answer that is being written on another computer (synced canvas) is not ours to settle
const runsElsewhere = (m) => !!(m?.running && m.host && state.info.host && m.host !== state.info.host);
// an answer left "running" by a run that no longer exists (app or computer closed mid-answer)
function settleStale(inst) {
  const msgs = inst.node.data.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last?.running || activeRuns.has(inst.node.id) || runsElsewhere(last)) return;
  const fixed = [...msgs.slice(0, -1), { ...last, running: false, interrupted: true, ...(last.parts ? { parts: [...last.parts, { type: 'notice', text: INTERRUPTED }] } : { content: last.content || '_(прервано)_' }) }];
  inst.view.setData(inst.node.id, { messages: fixed });
  inst.node = inst.view.node(inst.node.id) || inst.node;
}
// Is the user looking at this window right now (app in focus, its canvas open, most of the window
// on screen and not a card)? Then a finished answer needs no entry in «Ждут вас».
function watched(inst) {
  const view = inst.view;
  if (!document.hasFocus() || document.hidden || view.doc?.id !== inst.docId) return false;
  const n = view.node(inst.node.id), v = view.views.get(inst.node.id);
  if (!n || !v || v.culled || view.isCard(n)) return false;
  const r = view.rect(), z = view.vp.z;
  const x1 = r.left + view.vp.x + n.x * z, y1 = r.top + view.vp.y + n.y * z, x2 = x1 + n.w * z, y2 = y1 + n.h * z;
  const seen = Math.max(0, Math.min(x2, r.right) - Math.max(x1, r.left)) * Math.max(0, Math.min(y2, r.bottom) - Math.max(y1, r.top));
  return seen >= 0.3 * (x2 - x1) * (y2 - y1);
}
// an answer ended: «Ждут вас» gets an entry unless the user watched it end
function reportEnd(inst, kind, text) {
  if (!kind) return;
  if (watched(inst)) { inbox.remove(inst.node.id); return; }
  const view = inst.view;
  const n = (view.doc?.id === inst.docId && view.node(inst.node.id)) || inst.node;
  inbox.add({ nodeId: n.id, docId: inst.docId, kind, title: NODE_TYPES[n.type].title(n), text, type: n.type, agentId: n.data.agentId, provider: n.data.provider });
}

// a starter prompt from a layout template (data.draft): waits in the input until the first message
function applyDraft(inst) {
  const d = inst.node.data.draft;
  if (!d || inst.input.value || inst.messages.length) return;
  inst.input.value = d;
  requestAnimationFrame(() => inst.input.dispatchEvent(new Event('input')));
}

// the last question once more, without the answer that failed or broke off
function retryLast(inst) {
  const msgs = inst.messages;
  let u = msgs.length - 1;
  while (u >= 0 && msgs[u].role !== 'user') u--;
  if (u < 0 || inst.isBusy()) return;
  const { content, attachments } = msgs[u];
  inst.view.setData(inst.node.id, { messages: msgs.slice(0, u) });
  inst.node = inst.view.node(inst.node.id) || inst.node;
  inst.send({ text: content || '', attachments: attachments || [] });
}
// an error in plain words with what to do about it (buttons only under the last message)
function renderError(raw, ctx) {
  const e = explainError(raw, ctx);
  const other = e.kind === 'other';
  const hint = other ? e.raw.slice(0, 400) : e.hint;
  return h('div', { class: `msg-error err-${e.kind}` },
    h('div', { class: 'err-title' }, `⚠ ${e.title}`),
    hint ? h('div', { class: 'err-hint' }, hint) : null,
    e.actions.length ? h('div', { class: 'msg-cta err-actions' }, ...e.actions.map((a, k) => h('button', { class: `btn sm no-drag${k === 0 ? ' primary' : ''}`, 'data-act': `err-${a}` }, ERROR_ACTIONS[a]))) : null,
    e.raw && (!other || e.raw.length > 400) ? h('details', { class: 'err-raw' }, h('summary', {}, 'Подробности'), h('pre', {}, e.raw)) : null);
}
// the agent's CLI in a terminal next to the chat (login, or this session to see more)
function openAgentTerminal(inst, extra) {
  const a = inst.agent, view = inst.view, n = view.node(inst.node.id);
  if (!n) return;
  native.trust?.add([[a.cmd, a.args, extra].filter(Boolean).join(' ')]); // started by the user here
  const t = view.addNode('terminal', { x: n.x + n.w + 60, y: n.y, data: { agentId: a.id, extraArgs: extra, cwd: inst.cwd } }, { center: false });
  view.select([t.id]);
}
function errAction(inst, act) {
  const agent = !!inst.continueRun;
  const pick = (el) => { if (!el) return; el.focus(); try { el.showPicker?.(); } catch {} };
  switch (act) {
    case 'err-retry': retryLast(inst); break;
    case 'err-login':
      openAgentTerminal(inst, inst.kind === 'codex' ? 'login' : '');
      toast(inst.kind === 'codex' ? 'Войдите в Codex в терминале справа, затем нажмите «Повторить»' : 'В терминале справа введите /login, войдите и нажмите «Повторить»');
      break;
    case 'err-model-auto': inst.view.setData(inst.node.id, { model: '', actualModel: null }); inst.node = inst.view.node(inst.node.id) || inst.node; inst.fillModelOptions?.(); retryLast(inst); break;
    case 'err-model': if (agent) pick(inst.modelSel); else { inst.modelInput?.focus(); inst.modelInput?.select(); } break;
    case 'err-providers': bus.emit('openSettings', 'providers'); break;
    case 'err-limits': bus.emit('openSettings', 'limits'); break;
    case 'err-access': pick(inst.modeSel); break;
    case 'err-new-chat': if (agent) inst.newSession(); else { inst.hist.newChat(); toast('Новый чат: прошлый сохранён в истории'); } break;
    case 'err-install': if (inst.agent?.install) { native.clipboard.write(inst.agent.install); toast(`Скопировано: ${inst.agent.install} — выполните в терминале`); } break;
    case 'err-terminal': {
      const sid = inst.node.data.sessionId;
      openAgentTerminal(inst, sid ? (inst.kind === 'codex' ? `resume ${sid}` : `--resume ${sid}`) : '');
      break;
    }
    default: break;
  }
}

// ---------------- passing answers along arrows (agent → agent) ----------------
// An arrow between two chat windows in «Передавать ответ» mode: when the source finishes an answer,
// the target gets it as its next message (with the arrow's note before it). Each passed message
// counts the steps since the user last wrote; after RELAY_MAX steps the chain stops. «Стоп» in any
// window of a chain stops the whole chain.
export const RELAY_MAX = 5;
export const RELAY_TYPES = ['agentchat', 'chat'];
const relayLabel = (title) => `Ответ от «${title}»:`;
function relayAnswer(inst, user, answer) {
  const view = inst.view;
  if (!answer) return;
  const depth = (user?.relay?.depth || 0) + 1;
  const chain = user?.relay?.chain || uid('chain');
  // the source's canvas is not open (the user went to another one): the targets get the answer
  // in their canvas file and send it when that canvas opens
  if (view.doc?.id !== inst.docId) { relayInFile(inst, answer, depth, chain); return; }
  const src = view.node(inst.node.id);
  if (!src) return;
  const edges = view.doc.edges.filter((e) => e.relay && e.from === src.id && e.to !== src.id);
  if (!edges.length) return;
  const title = NODE_TYPES[src.type].title(src);
  if (depth > RELAY_MAX) { toast(`Цепочка передач остановлена после ${RELAY_MAX} шагов без вас — продолжите сами`, 'warn'); return; }
  for (const e of edges) {
    const target = view.node(e.to);
    if (!target || !RELAY_TYPES.includes(target.type)) continue;
    const msg = { text: `${e.relay.note || relayLabel(title)}\n\n${answer}`, attachments: [], relay: { from: src.id, title, depth, chain } };
    view.flashEdge?.(e.id);
    const t = view.views.get(target.id)?.inst;
    if (!t) continue;
    if (t.isBusy()) (t.relayQueue ||= []).push(msg); // after its current answer
    else t.send(msg);
  }
}
async function relayInFile(inst, answer, depth, chain) {
  if (depth > RELAY_MAX) return;
  try {
    await editCanvasFile(inst.docId, (doc) => {
      const src = doc.nodes?.find((n) => n.id === inst.node.id);
      if (!src) return false;
      const title = NODE_TYPES[src.type].title(src);
      let changed = false;
      for (const e of doc.edges || []) {
        if (!e.relay || e.from !== src.id || e.to === src.id) continue;
        const t = doc.nodes.find((n) => n.id === e.to);
        if (!t || !RELAY_TYPES.includes(t.type)) continue;
        t.data = { ...t.data, pendingRelay: [...(t.data.pendingRelay || []), { text: `${e.relay.note || relayLabel(title)}\n\n${answer}`, attachments: [], relay: { from: src.id, title, depth, chain } }] };
        changed = true;
      }
      return changed;
    });
  } catch (e) { console.error('relay', e); }
}
// passes that arrived while this window's canvas was closed
function takePendingRelay(inst) {
  const q = inst.node.data.pendingRelay;
  if (!q?.length) return;
  inst.view.setData(inst.node.id, { pendingRelay: null });
  inst.node = inst.view.node(inst.node.id) || inst.node;
  inst.relayQueue = [...(inst.relayQueue || []), ...q];
  nextRelay(inst);
}
// the next passed answer waiting for this window
function nextRelay(inst) {
  const m = inst.relayQueue?.shift();
  if (m) setTimeout(() => { if (!inst.isBusy()) inst.send(m); else (inst.relayQueue ||= []).unshift(m); }, 0);
}
// «Стоп» in one window of a chain: the others stop too, waiting passes are dropped
function bindRelayStop(inst) {
  return bus.on('relay:stop', (chain) => {
    if (inst.relayQueue) inst.relayQueue = inst.relayQueue.filter((m) => m.relay?.chain !== chain);
    if (inst.chain === chain && inst.isBusy()) inst.stop(true);
  });
}
const renderRelayNote = (m) => (m.relay ? h('div', { class: 'msg-relay', title: `Передано по стрелке, шаг ${m.relay.depth} из ${RELAY_MAX}` }, h('span', { html: icon('arrow', 11) }), `от «${m.relay.title}»`) : null);

// ---------------- what the agent changed (main/changes.js) ----------------
// files the agent's tools wrote, for folders without git (no diff, no rollback there)
function touchedFiles(parts) {
  const out = new Set();
  for (const p of parts || []) {
    if (p.type !== 'tool' || !p.input) continue;
    if (p.name === 'Файлы') for (const l of p.input.split('\n')) { const f = l.trim().split(/\s+/).slice(1).join(' '); if (f) out.add(f); }
    else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.name)) out.add(p.input.split('\n')[0]);
  }
  return [...out].slice(0, 50);
}
const changeTotals = (c) => c.files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
const filesWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'файл' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'файла' : 'файлов');
// the line under an answer: "Изменено 3 файла +42 −7 · Показать · Откатить"
function renderChanges(m, i) {
  const c = m.changes;
  if (c?.files?.length) {
    const t = changeTotals(c), rev = !!c.reverted;
    return h('div', { class: `msg-changes${rev ? ' reverted' : ''}` },
      h('span', { class: 'mc-ic', html: icon('diff', 13) }),
      h('span', { class: 'mc-text' }, rev ? `Изменения откачены (${c.reverted.files.length} ${filesWord(c.reverted.files.length)})` : `Изменено ${c.files.length} ${filesWord(c.files.length)}`),
      rev ? null : h('span', { class: 'mc-add' }, `+${t.add}`), rev ? null : h('span', { class: 'mc-del' }, `−${t.del}`),
      h('span', { class: 'mc-sp' }),
      h('button', { class: 'btn sm no-drag', 'data-act': 'changes-show', 'data-i': i }, 'Показать'),
      h('button', { class: 'btn sm no-drag', 'data-act': rev ? 'changes-reapply' : 'changes-revert', 'data-i': i }, rev ? 'Вернуть' : 'Откатить'));
  }
  if (m.touched?.length) {
    return h('div', { class: 'msg-changes plain', title: m.touched.join('\n') },
      h('span', { class: 'mc-ic', html: icon('diff', 13) }),
      h('span', { class: 'mc-text' }, `Агент менял ${m.touched.length} ${filesWord(m.touched.length)}: ${m.touched.slice(0, 3).map((f) => f.split(/[\\/]/).pop()).join(', ')}${m.touched.length > 3 ? '…' : ''}`),
      h('span', { class: 'mc-note muted' }, 'папка не под git — без diff и отката'));
  }
  return null;
}
// the message (by its time) in a chat window's data
// (an answer and its question are created in the same millisecond: match the answer only)
const msgByTs = (view, chatId, ts) => (view.node(chatId)?.data.messages || []).find((x) => x.ts === ts && x.role === 'assistant') || null;
function setMsgChanges(view, chatId, ts, changes) {
  const n = view.node(chatId);
  if (!n) return;
  view.setData(chatId, { messages: n.data.messages.map((x) => (x.ts === ts && x.role === 'assistant' ? { ...x, changes } : x)) });
  view.views.get(chatId)?.inst?.renderAll?.();
}
// Rollback (or taking it back): only files still as the other side left them; after confirmation.
async function revertChanges(view, chatId, ts, reapply = false, fallback = null) {
  const m = msgByTs(view, chatId, ts);
  const c = m?.changes || fallback?.changes;
  if (!c) return null;
  const files = reapply ? (c.reverted?.files || []) : c.files.map((f) => f.path);
  if (!files.length) return null;
  if (!reapply) {
    const inFiles = files.length % 10 === 1 && files.length % 100 !== 11 ? 'файле' : 'файлах';
    const ok = await confirmBox(`Откатить изменения агента в ${files.length} ${inFiles}?`, 'Файлы вернутся к состоянию до этого ответа. Файлы, которые после ответа правили вы или другой агент, не тронутся. Созданные агентом файлы уйдут в корзину. Откат можно вернуть кнопкой «Вернуть».', 'Откатить');
    if (!ok) return null;
  }
  let r;
  try { r = await native.changes.restore({ root: c.root, from: reapply ? c.after : c.before, expect: reapply ? c.before : c.after, files }); } catch (e) { toast(`Не удалось: ${e.message || e}`, 'error'); return null; }
  const next = { ...c };
  if (reapply) { const left = (c.reverted?.files || []).filter((f) => !r.done.includes(f)); if (left.length) next.reverted = { ...c.reverted, files: left }; else delete next.reverted; }
  else if (r.done.length) next.reverted = { files: r.done, at: Date.now() };
  if (m) setMsgChanges(view, chatId, ts, next);
  if (fallback) fallback.save(next);
  bus.emit('changes:updated', { chatId, ts, changes: next });
  const skipped = r.skipped.length ? ` Не тронуты: ${r.skipped.map((x) => `${x.path} (${x.reason})`).join(', ')}.` : '';
  toast(`${reapply ? 'Возвращено' : 'Откачено'}: ${r.done.length} ${filesWord(r.done.length)}.${skipped}`, r.skipped.length ? 'warn' : 'ok');
  return next;
}
// a unified diff as lines: + added, − removed, @@ a new piece; the git header lines are left out
function diffLines(patch) {
  const out = [];
  for (const line of String(patch || '').split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
    const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : '';
    out.push(h('div', { class: `dl ${cls}` }, line || ' '));
  }
  if (!out.length) out.push(h('div', { class: 'dl meta' }, 'Нет текстовых изменений'));
  return out;
}
// the card with the diff next to the chat (or the existing one for this answer)
function showChanges(view, chatId, m) {
  const ex = view.doc.nodes.find((n) => n.type === 'diff' && n.data.chatId === chatId && n.data.ts === m.ts);
  if (ex) { view.focusNode(ex.id); return; }
  const chatNode = view.node(chatId);
  const title = `Изменения: ${NODE_TYPES[chatNode.type].title(chatNode)}`.slice(0, 80);
  // no arrow: an arrow into a chat window would make the card context for the agent
  const card = view.addNode('diff', { x: chatNode.x + chatNode.w + 60, y: chatNode.y, data: { chatId, ts: m.ts, title, changes: m.changes } }, { center: false });
  view.fit?.([chatId, card.id]); // the card and its buttons on screen, next to the chat
}

// "Продолжить" / "Повторить" under an answer that broke off
function renderResume(inst, m, i) {
  if (!m.interrupted || m.running || i !== inst.messages.length - 1) return null;
  const canContinue = inst.continueRun && inst.node.data.sessionId;
  return h('div', { class: 'msg-cta' },
    h('button', { class: 'btn sm primary no-drag', 'data-act': canContinue ? 'continue' : 'retry', 'data-i': i }, canContinue ? 'Продолжить' : 'Повторить'),
    canContinue ? h('button', { class: 'btn sm no-drag', 'data-act': 'retry', 'data-i': i }, 'Начать ответ заново') : null);
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
    this.sendBtn = h('button', { class: 'chat-send', title: 'Отправить', html: icon('send', 16), onclick: () => (this.isBusy() ? this.stop() : this.send()) });
    this.attach = new AttachBar({ root: this.root, input: this.input });
    bindFollow(this);
    this.foot = h('div', { class: 'chat-foot' }, this.attach.button, this.input, this.sendBtn);
    this.usage = h('div', { class: 'chat-usage' });
    this.root.append(this.bar, this.listWrap, this.ctxRow, this.attach.chips, this.foot, this.usage);
    this.hist = new ChatHistory(this);
    this.bar.prepend(this.hist.button);
    body.append(this.root);
    this.fillProviders();
    this.providerSel.addEventListener('change', () => { const p = this.providerSel.value; this.view.setData(node.id, { provider: p, model: '' }); this.modelInput.value = ''; this.modelInput.placeholder = this.providers?.[p]?.model || 'модель'; this.view.syncHead(this.view.node(node.id)); });
    this.modelInput.addEventListener('change', () => this.view.setData(node.id, { model: this.modelInput.value.trim() }));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (fontKeys(this, e)) return;
      if (this.mentions?.handleKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = `${this.input.scrollHeight + 2}px`; }); // CSS max-height (in lines) stops it
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) { const code = btn.closest('.code-block').querySelector('code').textContent; native.clipboard.write(code); btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1200); }
      const act = e.target.closest('[data-act]');
      if (act) this.msgAction(act.dataset.act, +act.dataset.i);
    });
    this.offEdges = bindContext(this);
    this.offRelay = bindRelayStop(this);
    setTimeout(() => takePendingRelay(this), 0); // after the window (and a picked-up run) is set up
    this.renderAll();
    this.renderCtx();
    this.syncRunUi();
    applyDraft(this);
    applyWindowFont(this);
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
        h('div', { class: 'muted small' }, CTX_HINT)));
    }
    renderWindowed(this);
    if (!this._keepScroll) this.toEnd();
  }

  renderMsg(m, i) {
    const el = h('div', { class: `msg ${m.role}${m.error ? ' error' : ''}${i === this.messages.length - 1 ? ' is-last' : ''}` });
    if (m.role === 'user') { const rl = renderRelayNote(m); if (rl) el.append(rl); const atts = renderAttachments(m.attachments); if (atts) el.append(atts); if (m.content) el.append(h('div', { class: 'msg-text' }, m.content)); const ctx = renderContextNote(m.context); if (ctx) el.append(ctx); }
    else {
      if (m.reasoning) el.append(h('details', { class: 'msg-reason' }, h('summary', {}, 'Размышления'), h('div', { class: 'reason-text' }, m.reasoning)));
      if (m.error) el.append(renderError(m.errorText || m.content, { source: 'api', provider: this.providers?.[this.node.data.provider]?.name || providerName(this.node.data.provider || 'openai'), model: this.node.data.model }));
      else el.append(h('div', { class: 'msg-text md', html: renderChatMarkdown(m.content) }));
      const cta = renderResume(this, m, i); if (cta) el.append(cta);
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
    if (act.startsWith('err-')) { errAction(this, act); return; }
    const m = this.messages[i];
    if (!m) return;
    if (act === 'retry') { retryLast(this); return; }
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
    if (force) this.follow = true;
    this.toEnd();
  }

  renderCtx() { renderContextRow(this.ctxRow, this.view, this.node.id, this.input.value); }

  // again = { text, attachments }: a question sent once more (retry), the input stays as it is
  async send(again = null) {
    const text = again ? again.text : this.input.value.trim();
    if ((!text && !(again ? again.attachments.length : this.attach.items.length)) || this.isBusy()) return;
    if (!again && this.attach.busy) { toast('Файлы ещё загружаются…'); return; }
    const attachments = again ? again.attachments : this.attach.take();
    if (!again) { this.input.value = ''; this.input.style.height = 'auto'; }
    this.mentions?.close();
    // the message and "answering" show at once, the canvas context is collected after that
    inbox.remove(this.node.id); // a new question: the previous answer has been seen
    const user = { role: 'user', content: text, ts: Date.now(), ...(attachments.length ? { attachments } : {}), ...(again?.relay ? { relay: again.relay } : {}) };
    this.chain = again?.relay?.chain || null;
    const msgs = [...this.messages, user];
    const asst = { role: 'assistant', content: '', running: true, host: state.info.host, ts: Date.now() };
    const all = [...msgs, asst];
    this.view.setData(this.node.id, { messages: all, ...(this.node.data.draft ? { draft: null } : {}) });
    if (!this.node.data.title || this.node.data.title === 'Новый чат') this.view.setData(this.node.id, { title: (text || attachments[0]?.name || 'Чат').slice(0, 40) });
    const reqId = uid('req');
    this.docId = this.view.doc.id; activeRuns.set(this.node.id, this);
    this.streaming = reqId; this.preparing = reqId; this._prep = { all, asst };
    this.follow = true; // a new question: show it and the answer
    const typing = () => { this.renderAll(); const t = this.list.lastElementChild.querySelector('.msg-text'); t.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; return t; };
    let textEl = typing();
    this.syncRunUi();
    this.view.syncHead(this.view.node(this.node.id));
    // an API chat remembers nothing between requests: the canvas context goes with every one
    let system = this.node.data.system || '', ctxAtts = [];
    try {
      const ctx = await chatContext(this.view, this.node.id, text, null);
      if (ctx.images.length) ctxAtts = await imagesToAttachments(ctx.images);
      system = [this.node.data.system, ctx.text ? `Ниже контекст с canvas пользователя: объекты, соединённые с этим чатом стрелкой или упомянутые через @${ctxAtts.length ? ' (картинки приложены к последнему сообщению)' : ''}.\n\n${ctx.text}` : ''].filter(Boolean).join('\n\n');
      if (ctx.labels.length) { user.context = ctx.labels; textEl = typing(); }
    } catch (e) { console.warn('canvas context', e); }
    this.renderCtx();
    this.preparing = null;
    if (this.streaming !== reqId) return; // stopped while the context was being collected
    let lastPaint = 0, pending = 0;
    const paintNow = () => { pending = 0; lastPaint = performance.now(); textEl.innerHTML = renderChatMarkdown(asst.content); this.scrollDown(); twinOf(this)?.showLive(asst); };
    // long answers: markdown is re-parsed less often (60 ms … 250 ms)
    const paint = () => { if (pending) return; const gap = Math.min(250, Math.max(60, asst.content.length / 40)); const wait = Math.max(0, gap - (performance.now() - lastPaint)); pending = setTimeout(paintNow, wait); };
    chatRoutes.set(reqId, (ev) => {
      if (ev.type === 'delta') { asst.content += ev.text; paint(); }
      else if (ev.type === 'reasoning') { asst.reasoning = (asst.reasoning || '') + ev.text; }
      else if (ev.type === 'error') { asst.content = `⚠ ${ev.message}`; asst.errorText = String(ev.message || ''); asst.error = true; this.finish(reqId, all, { error: true }); }
      else if (ev.type === 'done') { if (ev.usage) { asst.usage = ev.usage; } if (!asst.content && ev.aborted) asst.content = '_(остановлено)_'; this.finish(reqId, all, ev); }
    });
    const req = msgs.map(({ role, content, attachments: a }, i) => { const all = i === msgs.length - 1 ? [...(a || []), ...ctxAtts] : a || []; return { role, content, ...(all.length ? { attachments: all } : {}) }; });
    await native.chat.send({ reqId, provider: this.node.data.provider || 'openai', model: this.node.data.model, system, messages: req, settings: state.settings });
  }

  async finish(reqId, all, ev = {}) {
    chatRoutes.delete(reqId);
    this.streaming = null;
    const last = all[all.length - 1];
    if (last?.running) delete last.running;
    reportEnd(this, ev.aborted ? null : ev.error ? 'error' : 'done', ev.error ? last?.errorText : last?.content);
    this.sendBtn.innerHTML = icon('send', 16); this.sendBtn.classList.remove('stop');
    activeRuns.delete(this.node.id);
    await patchNodeData(this, { messages: [...all] });
    // after the answer is saved (a closed canvas' file is written by both)
    if (!ev.aborted && !ev.error) relayAnswer(this, all[all.length - 2], last?.content);
    this.chain = null;
    nextRelay(this);
    saveConversation(this);
    this.renderAll();
    const tot = all.reduce((t, m) => t + (m.usage ? m.usage.input + m.usage.output : 0), 0);
    this.usage.textContent = tot ? `${tot.toLocaleString('ru-RU')} токенов в этом чате` : '';
    this.view.syncHead(this.view.node(this.node.id));
    bus.emit('limits:refresh');
  }

  stop(fromChain = false) {
    if (this.chain && !fromChain) bus.emit('relay:stop', this.chain);
    if (this.preparing && this.streaming === this.preparing) { const { all, asst } = this._prep; asst.content = '_(остановлено)_'; this.preparing = null; this.finish(this.streaming, all, { aborted: true }); return; }
    const r = this.streaming || runOf(this)?.streaming; if (r) native.chat.abort(r);
  }
  isBusy() { return !!(this.streaming || runOf(this)); }
  // send button and header follow a run owned by an earlier instance of this window
  syncRunUi() { const busy = this.isBusy(); this.sendBtn.innerHTML = icon(busy ? 'stop' : 'send', busy ? 15 : 16); this.sendBtn.classList.toggle('stop', busy); }
  // the streaming answer, painted into this window by the instance that owns the run
  showLive(asst) {
    let el = this.list.querySelector(':scope > .msg.assistant:last-child .msg-text');
    if (!el) { this.renderAll(); el = this.list.querySelector(':scope > .msg.assistant:last-child .msg-text'); }
    if (!el) return;
    el.innerHTML = renderChatMarkdown(asst.content || '') || '<span class="typing"><i></i><i></i><i></i></span>';
    this.syncRunUi();
    this.scrollDown();
  }
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
    if (this.streaming || runOf(this)) return { label: 'Отвечает…', kind: 'busy' };
    const m = this.messages[this.messages.length - 1];
    if (runsElsewhere(m)) return { label: 'Отвечает на другом компьютере', kind: 'busy' };
    if (m?.interrupted) return { label: 'Прервано', kind: 'wait' };
    if (m?.error) return { label: 'Ошибка', kind: 'na' };
    return { label: this.messages.length ? `${this.messages.length} сообщ.` : 'Готов', kind: 'idle' };
  }

  update(n) { this.node = n; if (!this.streaming) { this.providerSel.value = n.data.provider || 'openai'; this.modelInput.value = n.data.model || ''; this.renderAll(); } }
  edit() { this.input.focus({ preventScroll: true }); }
  destroy() { this.offEdges?.(); this.offRelay?.(); }
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
    this.running = null;
    this.continueRun = true;
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
    this.wtChip = h('button', { class: 'wt-chip no-drag', hidden: true, onclick: (e) => { e.stopPropagation(); this.worktreeMenu(e.currentTarget); } });
    this.infoBar = h('div', { class: 'agent-info' }, this.wtChip, this.cwdBtn, this.modelInfo);
    this.list = h('div', { class: 'chat-list scrollable' });
    this.ctxRow = h('div', { class: 'chat-ctx' });
    this.input = h('textarea', { class: 'chat-input', rows: 2, placeholder: 'Задача для агента… (Enter — отправить, Shift+Enter — новая строка)' });
    this.sendBtn = h('button', { class: 'chat-send', title: 'Отправить', html: icon('send', 16), onclick: () => (this.isBusy() ? this.stop() : this.send()) });
    this.usage = h('div', { class: 'chat-usage' });
    this.attach = new AttachBar({ root: this.root, input: this.input });
    bindFollow(this);
    this.root.append(this.bar, this.infoBar, this.listWrap, this.ctxRow, this.attach.chips, h('div', { class: 'chat-foot' }, this.attach.button, this.input, this.sendBtn), this.usage);
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
    this.input.addEventListener('keydown', (e) => { e.stopPropagation(); if (fontKeys(this, e)) return; if (this.mentions?.handleKey(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); } });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = `${this.input.scrollHeight + 2}px`; }); // CSS max-height (in lines) stops it
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) { native.clipboard.write(btn.closest('.code-block').querySelector('code').textContent); btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1200); }
      const act = e.target.closest('[data-act]');
      if (act) this.msgAction(act.dataset.act, +act.dataset.i);
    });
    this.offEdges = bindContext(this);
    this.offRelay = bindRelayStop(this);
    setTimeout(() => takePendingRelay(this), 0); // after the window (and a picked-up run) is set up
    this.renderCwd();
    this.renderAll();
    this.renderCtx();
    this.syncRunUi();
    this.reattach();
    if (this.node.data.worktree) this.refreshWorktree();
    applyDraft(this);
    applyWindowFont(this);
  }

  // An answer saved as "running" while no run of this app owns it: the app was closed or reloaded
  // mid-answer. The agent keeps working in the background (main/agent-runner.js), so the run is
  // picked up again: main replays its journal from the start and the answer is rebuilt. When there
  // is no journal (older version, the computer was restarted before…) the answer is marked as
  // broken off, with «Продолжить».
  reattach() {
    const msgs = this.messages, last = msgs[msgs.length - 1];
    if (!last?.running || activeRuns.has(this.node.id) || runsElsewhere(last)) return;
    const reqId = uid('ag');
    const asst = { ...last, content: '', parts: [], running: true };
    const all = [...msgs.slice(0, -1), asst];
    this.docId = this.view.doc.id; activeRuns.set(this.node.id, this);
    this.running = reqId;
    this.listen(reqId, all, asst);
    this.syncRunUi();
    const giveUp = () => {
      if (this.running !== reqId) return;
      chatRoutes.delete(reqId); activeRuns.delete(this.node.id); this.running = null;
      settleStale(this);
      this.renderAll(); this.syncRunUi(); this.syncHead();
    };
    Promise.resolve(native.agentChat.attach ? native.agentChat.attach({ nodeId: this.node.id, reqId }) : null)
      .then((r) => { if (!r) giveUp(); else this.syncHead(); }, giveUp);
  }

  get agent() { return state.agent(this.node.data.agentId); }
  get kind() { return this.node.data.kind || this.agent.chat || 'claude'; }
  get messages() { return this.node.data.messages || []; }
  // in a separate copy (git worktree) the agent works in the copy's folder
  get cwd() { const w = this.node.data.worktree; return (w?.cwd && this.wtStatus?.exists !== false && w.cwd) || this.node.data.cwd || state.project.cwd || state.info.home; }

  // ---------------- separate copy of the project (main/worktrees.js) ----------------
  async refreshWorktree() {
    const w = this.node.data.worktree;
    if (!w || !native.wt) { this.wtStatus = null; this.wtChip.hidden = true; this.renderCwd(); return; }
    try { this.wtStatus = await native.wt.status(w); } catch { this.wtStatus = { exists: false }; }
    const st = this.wtStatus;
    const bits = !st.exists ? ['копии нет на этом компьютере'] : st.merged && !st.dirty ? ['влито'] : [
      st.ahead ? `${st.ahead} ${st.ahead % 10 === 1 && st.ahead % 100 !== 11 ? 'коммит' : st.ahead % 10 >= 2 && st.ahead % 10 <= 4 && (st.ahead % 100 < 10 || st.ahead % 100 >= 20) ? 'коммита' : 'коммитов'}` : '',
      st.dirty ? `${st.dirty} ${filesWord(st.dirty)} без коммита` : '',
    ].filter(Boolean);
    this.wtChip.replaceChildren(h('span', { html: icon('branch', 12) }), h('span', { class: 'wt-branch' }, String(w.branch || 'копия').replace(/^vibetabula\//, '')), bits.length ? h('span', { class: 'wt-bits' }, bits.join(' · ')) : null);
    this.wtChip.title = `Агент работает в отдельной копии проекта\nВетка: ${w.branch}\nПапка: ${w.path}${st.into ? `\nВливается в: ${st.into}` : ''}\n\nНажмите для действий`;
    this.wtChip.classList.toggle('missing', !st.exists);
    this.wtChip.hidden = false;
    this.renderCwd();
  }
  worktreeMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    menu(this.worktreeItems(), r.left, r.bottom + 4);
  }
  worktreeItems() {
    const w = this.node.data.worktree, st = this.wtStatus || {};
    if (!w) return [{ label: 'Работать в отдельной копии (git worktree)…', icon: 'branch', onClick: () => this.enableWorktree() }];
    if (!st.exists) return [{ label: 'Убрать копию из окна', icon: 'x', onClick: () => this.removeWorktree() }];
    return [
      { label: 'Изменения копии', icon: 'diff', onClick: () => this.showWorktreeChanges() },
      { label: `Влить в «${st.into || 'основную ветку'}»…`, icon: 'check', onClick: () => this.mergeWorktree() },
      { label: 'Открыть папку копии', icon: 'folder', onClick: () => native.shell.openPath(w.path) },
      { label: 'Удалить копию…', icon: 'trash', onClick: () => this.removeWorktree() },
    ];
  }
  async enableWorktree() {
    if (this.isBusy()) { toast('Дождитесь, пока агент закончит', 'warn'); return; }
    const ok = await confirmBox('Работать в отдельной копии проекта?', `Агент получит свою ветку vibetabula/… и свою папку рядом с проектом (git worktree). Ваша папка не меняется, пока вы не нажмёте «Влить». В копию попадает последний коммит — незакоммиченные правки остаются у вас.${this.messages.length ? ' Агент начнёт в копии новую сессию.' : ''}`, 'Создать копию');
    if (!ok) return;
    let w;
    try { w = await native.wt.create({ cwd: this.cwd, name: this.node.data.title || NODE_TYPES.agentchat.title(this.node) }); }
    catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); return; }
    this.view.setData(this.node.id, { worktree: w, sessionId: null });
    this.node = this.view.node(this.node.id) || this.node;
    await this.refreshWorktree();
    toast(`Копия создана: ветка ${w.branch}`, 'ok');
  }
  async showWorktreeChanges(p) {
    const w = this.node.data.worktree;
    if (!w) return;
    if (!p) { try { p = await native.wt.preview(w); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); return; } }
    const ex = this.view.doc.nodes.find((n) => n.type === 'diff' && n.data.worktreeOf === this.node.id);
    if (ex) { this.view.setData(ex.id, { changes: p, title: `Копия: ${w.branch}` }); this.view.focusNode(ex.id); return; }
    const me = this.view.node(this.node.id);
    this.view.addNode('diff', { x: me.x + me.w + 60, y: me.y, data: { title: `Копия: ${w.branch}`, changes: p, noRevert: true, worktreeOf: this.node.id } }, { center: false });
  }
  async mergeWorktree() {
    const w = this.node.data.worktree;
    if (!w) return;
    if (this.isBusy()) { toast('Дождитесь, пока агент закончит', 'warn'); return; }
    let p;
    try { p = await native.wt.preview(w); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); return; }
    await this.refreshWorktree();
    if (!p.files.length) { toast('В копии нет изменений, которых нет у вас'); return; }
    await this.showWorktreeChanges(p);
    const into = this.wtStatus?.into || 'основную ветку';
    const ok = await confirmBox(`Влить изменения агента в «${into}»?`, `${p.files.length} ${filesWord(p.files.length)} — они видны в карточке «Копия». То, что агент не закоммитил, сначала станет коммитом на его ветке. Если изменения конфликтуют с вашими или мешают ваши незакоммиченные правки, ничего не изменится.`, 'Влить');
    if (!ok) return;
    let r;
    try { r = await native.wt.merge(w); } catch (e) { toast(String(e.message || e), 'error'); return; }
    await this.refreshWorktree();
    if (r.ok) { toast(r.commits ? `Влито в «${r.into}». Копию можно удалить в её меню.` : 'Нечего вливать', 'ok'); return; }
    modal({ title: 'Не влито', width: 460, body: h('div', {}, h('p', {}, r.reason), r.files?.length ? h('ul', { class: 'wt-files' }, ...r.files.slice(0, 20).map((f) => h('li', {}, h('code', {}, f)))) : null), actions: [{ label: 'Понятно', primary: true }] });
  }
  async removeWorktree() {
    const w = this.node.data.worktree;
    if (!w) return;
    if (this.isBusy()) { toast('Дождитесь, пока агент закончит', 'warn'); return; }
    const st = this.wtStatus || {};
    const done = () => { this.view.setData(this.node.id, { worktree: null, sessionId: null }); this.node = this.view.node(this.node.id) || this.node; this.refreshWorktree(); };
    if (st.exists === false) { done(); return; }
    const clean = st.merged || (!st.ahead && !st.dirty);
    const ok = await confirmBox('Удалить копию?', clean ? 'Папка копии и её ветка будут удалены: изменений, которых нет у вас, в ней нет.' : 'Изменения агента не влиты. Папка копии будет удалена, а ветка с коммитами агента останется — её можно влить позже средствами git.', 'Удалить');
    if (!ok) return;
    let r = await native.wt.remove(w);
    if (!r.ok && r.dirty) {
      const ok2 = await confirmBox('В копии есть несохранённые изменения агента', 'Они не влиты и пропадут вместе с папкой копии. Удалить всё равно?', 'Удалить');
      if (!ok2) return;
      r = await native.wt.remove(w, { force: true });
    }
    if (!r.ok) { toast(r.reason || 'Не удалось удалить копию', 'error'); return; }
    done();
    toast(r.branchKept ? `Копия удалена, ветка ${w.branch} осталась` : 'Копия удалена', 'ok');
  }

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
    this.cwdBtn.classList.toggle('in-copy', !!(this.node.data.worktree && this.wtStatus?.exists !== false));
    this.cwdBtn.replaceChildren(h('span', { html: icon('folder', 12) }), h('span', { class: 'cwd-text' }, !c ? 'выберите папку' : c.length > 46 ? '…' + c.slice(-45) : c));
    this.cwdBtn.title = `Рабочая папка агента:\n${c}\n\nНажмите, чтобы сменить`;
  }
  async pickCwd() { const p = await native.dialog.folder('Рабочая папка агента'); if (p) { this.view.setData(this.node.id, { cwd: p }); this.renderCwd(); } }
  newSession() { if (this.isBusy()) return; this.hist.newChat(); toast('Новый чат: прошлый сохранён в истории'); }
  isBusy() { return !!(this.running || runOf(this)); }
  syncRunUi() { const busy = this.isBusy(); this.sendBtn.innerHTML = icon(busy ? 'stop' : 'send', busy ? 15 : 16); this.sendBtn.classList.toggle('stop', busy); }
  // the streaming answer, painted into this window by the instance that owns the run
  showLive(asst) {
    const find = () => this.list.querySelector(':scope > .msg.assistant:last-child .msg-body');
    let body = find();
    if (!body) { this.renderAll(); body = find(); }
    if (!body) return;
    this.renderParts(asst, body);
    this.toEnd();
    this.syncRunUi();
  }
  loadConversation({ convId = null, messages = [], title = '', sessionId = null, cwd, model, actualModel }) {
    const patch = { convId, messages, title: title || '', sessionId, ctxHash: null, actualModel: actualModel || model || null };
    if (cwd) patch.cwd = cwd;
    this.view.setData(this.node.id, patch);
    this.node = this.view.node(this.node.id) || this.node;
    this.usage.textContent = sessionId ? `сессия ${String(sessionId).slice(0, 8)}` : '';
    this.renderCwd(); this.renderInfo(); this.renderAll(); this.syncHead();
  }
  renderCtx() { renderContextRow(this.ctxRow, this.view, this.node.id, this.input.value); }

  renderAll() {
    this.list.innerHTML = '';
    if (!this.messages.length) {
      const a = this.agent;
      this.list.append(h('div', { class: 'chat-empty' },
        badge(a.mono, a.color, 34, a.dark),
        h('div', { class: 'chat-empty-title' }, `${a.name} — чат`),
        h('div', { class: 'muted' }, 'Работает по вашей подписке и входу в CLI, без API-ключа. Агент действует в папке, показанной сверху; его команды и правки появятся в ленте.'),
        h('div', { class: 'muted small' }, CTX_HINT)));
    }
    renderWindowed(this);
    if (!this._keepScroll) this.toEnd();
  }

  // incremental: unchanged parts keep their DOM (so an expanded tool call stays open and long
  // answers don't re-parse all their markdown on every streamed token)
  renderParts(m, el) {
    const parts = (m.parts || [{ type: 'text', text: m.content }]).filter((p) => !((p.type === 'text' || p.type === 'reasoning') && !p.text));
    const cache = el._parts || (el._parts = []);
    const keyOf = (p) => (p.type === 'notice' ? `notice|${p.text}` : p.type === 'image' ? `image|${p.att?.file}` : `${p.type}|${(p.text || '').length}|${p.status || ''}|${(p.output || '').length}|${(p.input || '').length}`);
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
      if (p.type === 'error') return renderError(p.text, { source: this.kind, name: this.agent.name, model: this.node.data.model, install: this.agent.install, cmd: this.agent.cmd, exitCode: p.code });
      if (p.type === 'notice') return h('div', { class: `muted small${p.reconnect ? ' msg-retry' : ''}`, title: p.detail || '' }, p.text);
      if (p.type === 'image' && p.att) {
        // a picture the agent generated: open it, put it on the canvas, show the file
        const a = p.att;
        const img = h('img', { src: a.url || a.thumb || '', alt: a.name || '', loading: 'lazy' });
        img.onerror = () => { img.replaceWith(h('div', { class: 'muted small' }, `Картинка «${a.name}» недоступна на этом компьютере`)); };
        return h('figure', { class: 'msg-gen' },
          h('button', { class: 'msg-gen-img no-drag', title: 'Открыть на весь экран', onclick: (e) => { e.stopPropagation(); viewImages([a], 0); } }, img),
          h('figcaption', {},
            h('button', { class: 'btn sm no-drag', onclick: (e) => { e.stopPropagation(); this.imageToCanvas(a); } }, 'На холст'),
            h('button', { class: 'btn sm no-drag', onclick: (e) => { e.stopPropagation(); native.attach?.reveal?.(a.file); } }, 'Показать в папке')));
      }
      return null;
    };
    el.querySelector(':scope > .typing, :scope > .typing-else')?.remove();
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
    if (m.running && !parts.length) el.append(runsElsewhere(m) ? h('div', { class: 'muted small typing-else' }, 'Ответ пишется на другом компьютере — появится здесь после синхронизации.') : h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  }

  renderMsg(m, i) {
    const el = h('div', { class: `msg ${m.role}${i === this.messages.length - 1 ? ' is-last' : ''}` });
    if (m.role === 'user') { const rl = renderRelayNote(m); if (rl) el.append(rl); const atts = renderAttachments(m.attachments); if (atts) el.append(atts); if (m.content) el.append(h('div', { class: 'msg-text' }, m.content)); const ctx = renderContextNote(m.context); if (ctx) el.append(ctx); }
    else {
      const body = h('div', { class: 'msg-body' }); this.renderParts(m, body); el.append(body);
      const ch = renderChanges(m, i); if (ch) el.append(ch);
      const cta = renderResume(this, m, i); if (cta) el.append(cta);
      // a window of «Спросить нескольких»: keep this answer, close the others
      if (this.node.data.compare && !m.running && !m.interrupted && i === this.messages.length - 1) el.append(h('div', { class: 'msg-cta' }, h('button', { class: 'btn sm primary no-drag', 'data-act': 'choose', 'data-i': i }, 'Выбрать этот ответ')));
    }
    if (!m.running) el.append(h('div', { class: 'msg-actions' },
      h('button', { 'data-act': 'copy', 'data-i': i, title: 'Копировать', html: icon('copy', 12) }),
      m.role === 'assistant' ? h('button', { 'data-act': 'note', 'data-i': i, title: 'В заметку', html: icon('note', 12) }) : null));
    return el;
  }

  // a generated picture → an image object next to this window (saved in the notes vault)
  async imageToCanvas(a) {
    try {
      const blob = await (await fetch(a.url)).blob();
      const me = this.view.node(this.node.id);
      const n = await imageNodeFromFile(this.view, new File([blob], a.name || 'Картинка.png', { type: blob.type || a.mime || 'image/png' }), { x: me.x + me.w + 60, y: me.y }, { center: false });
      this.view.select([n.id]);
      toast('Картинка на холсте');
    } catch (e) { toast(`Не удалось вынести картинку: ${e.message || e}`, 'error'); }
  }

  async msgAction(act, i) {
    if (act.startsWith('err-')) { errAction(this, act); return; }
    const m = this.messages[i];
    if (!m) return;
    if (act === 'retry') { retryLast(this); return; }
    if (act === 'changes-show') { showChanges(this.view, this.node.id, m); return; }
    if (act === 'choose') { const { chooseAnswer } = await import('./askmany.js'); await chooseAnswer(this.view, this.node.id); return; }
    if (act === 'changes-revert' || act === 'changes-reapply') { await revertChanges(this.view, this.node.id, m.ts, act === 'changes-reapply'); return; }
    if (act === 'continue') { this.send({ text: CONTINUE_PROMPT, attachments: [] }); return; }
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

  // again = { text, attachments }: sent from «Продолжить» / «Повторить», the input stays as it is
  async send(again = null) {
    const text = again ? again.text : this.input.value.trim();
    if ((!text && !(again ? again.attachments.length : this.attach.items.length)) || this.isBusy()) return;
    if (!again && this.attach.busy) { toast('Файлы ещё загружаются…'); return; }
    // the copy is gone (another computer, deleted by hand): never let the agent fall back to another folder
    if (this.node.data.worktree && this.wtStatus?.exists === false) { toast('Отдельной копии нет на этом компьютере — уберите её в меню окна или создайте заново', 'warn'); return; }
    const attachments = again ? again.attachments : this.attach.take();
    if (!again) { this.input.value = ''; this.input.style.height = 'auto'; }
    this.mentions?.close();
    // the message and "working" show at once; collecting the canvas context (pictures of a big
    // area) may take a moment and happens after that
    inbox.remove(this.node.id); // a new question: the previous answer has been seen
    const user = { role: 'user', content: text, ts: Date.now(), ...(attachments.length ? { attachments } : {}), ...(again?.relay ? { relay: again.relay } : {}) };
    this.chain = again?.relay?.chain || null;
    const asst = { role: 'assistant', content: '', parts: [], running: true, host: state.info.host, ts: Date.now() };
    const all = [...this.messages, user, asst];
    this.view.setData(this.node.id, { messages: all, ...(this.node.data.draft ? { draft: null } : {}) });
    if (!this.node.data.title && text !== CONTINUE_PROMPT) this.view.setData(this.node.id, { title: (text || attachments[0]?.name || 'Задача').slice(0, 40) });
    const reqId = uid('ag');
    this.docId = this.view.doc.id; activeRuns.set(this.node.id, this);
    this.running = reqId; this.preparing = reqId; this._prep = { all, asst };
    this.follow = true; // a new question: show it and the answer
    this.renderAll();
    this.syncRunUi();
    this.syncHead();
    // the agent keeps its session: linked objects go again only when they changed (a new chat
    // starts without ctxHash), objects named with @ always go with their message
    let prompt = text, ctxAtts = [], sig;
    // the working folder before the agent starts (git): what it changed is shown under the answer
    const readOnly = ['read', 'plan', 'default'].includes(this.modeSel.value); // these modes do not edit files
    const snapP = native.changes?.snapshot && !readOnly ? native.changes.snapshot(this.cwd).catch(() => null) : Promise.resolve(null);
    try {
      const ctx = await chatContext(this.view, this.node.id, text, this.node.data.ctxHash);
      if (ctx.images.length) ctxAtts = await imagesToAttachments(ctx.images);
      if (ctx.text) prompt = `Контекст с canvas пользователя: объекты, соединённые с этим чатом стрелкой или упомянутые через @${ctxAtts.length ? '. Картинки из контекста приложены к сообщению' : ''}.\n\n${ctx.text}\n\n---\n\n${text}`;
      sig = ctx.linkedSig;
      if (ctx.labels.length) { user.context = ctx.labels; this.renderAll(); }
    } catch (e) { console.warn('canvas context', e); }
    // «Спросить нескольких»: the context of the window the question came from
    if (again?.extra) prompt = `${again.extra}\n\n---\n\n${prompt}`;
    if (again?.extraLabels?.length) { user.context = [...(user.context || []), ...again.extraLabels]; this.renderAll(); }
    this.renderCtx();
    this.preparing = null;
    if (this.running !== reqId) return; // stopped while the context was being collected: nothing was sent
    // remembered only once the context really goes to the agent
    if (sig !== undefined && sig !== (this.node.data.ctxHash || null)) this.view.setData(this.node.id, { ctxHash: sig });
    const snap = await snapP;
    if (this.running !== reqId) return;
    if (snap) { asst.snap = snap; this.view.setData(this.node.id, { messages: [...all] }); } // kept for a run picked up after a restart
    this.listen(reqId, all, asst);
    await native.agentChat.run({ reqId, kind: this.kind, cmd: this.agent.cmd || this.kind, prompt, sessionId: this.node.data.sessionId, mode: this.modeSel.value, model: this.node.data.model || '', effort: this.node.data.effort || '', cwd: this.cwd, attachments: [...attachments, ...ctxAtts], nodeId: this.node.id, docId: this.docId, keepRunning: state.settings.agentsKeepRunning !== false, canvasTools: state.settings.canvasTools !== false });
  }

  // events of a run → the answer; also replays a run picked up after a restart (reattach)
  listen(reqId, all, asst) {
    let body = null, newText = true;
    const paint = throttle(() => {
      if (!body?.isConnected) body = this.list.lastElementChild?.querySelector('.msg-body');
      if (body) this.renderParts(asst, body);
      this.toEnd(); twinOf(this)?.showLive(asst);
    }, 70);
    const dropRetry = () => { for (let i = asst.parts.length - 1; i >= 0; i--) if (asst.parts[i].reconnect) asst.parts.splice(i, 1); };
    const lastText = () => { const l = asst.parts[asst.parts.length - 1]; if (newText || !l || l.type !== 'text') { const p = { type: 'text', text: '' }; asst.parts.push(p); newText = false; return p; } return l; };
    chatRoutes.set(reqId, (ev) => {
      switch (ev.type) {
        case 'session': patchNodeData(this, { sessionId: ev.sessionId }); break;
        case 'info': if (ev.model) { this.view.setData(this.node.id, { actualModel: ev.model }); this.renderInfo(); } break;
        case 'delta': dropRetry(); lastText().text += ev.text; break;
        case 'break': newText = true; break;
        case 'image': dropRetry(); asst.parts.push({ type: 'image', att: ev.att }); newText = true; break;
        case 'reasoning': { dropRetry(); const l = asst.parts[asst.parts.length - 1]; if (l && l.type === 'reasoning') l.text += ev.text; else asst.parts.push({ type: 'reasoning', text: ev.text }); break; }
        case 'tool': dropRetry(); if (!asst.parts.some((p) => p.type === 'tool' && p.id === ev.id)) asst.parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'run' }); newText = true; break;
        case 'toolResult': { const t = asst.parts.find((p) => p.type === 'tool' && p.id === ev.id); if (t) { t.output = ev.output; t.status = ev.isError ? 'err' : 'ok'; } break; }
        case 'notice': {
          // Codex reconnecting: one line that counts up instead of a pile of red errors
          const last = asst.parts[asst.parts.length - 1];
          if (ev.reconnect && last?.reconnect) { last.text = ev.text; last.detail = ev.detail; } else asst.parts.push({ type: 'notice', text: ev.text, ...(ev.reconnect ? { reconnect: true, detail: ev.detail } : {}) });
          if (ev.needsInput) asst.needsInput = true;
          break;
        }
        case 'error': dropRetry(); asst.parts.push({ type: 'error', text: ev.message, ...(ev.code != null ? { code: ev.code } : {}) }); break;
        case 'done': this.finish(reqId, all, asst, ev); return;
        default: break;
      }
      paint();
    });
  }

  async finish(reqId, all, asst, ev) {
    chatRoutes.delete(reqId);
    // what the agent changed in its folder (while the window still says «Работает»)
    if (asst.snap) {
      try { const c = await native.changes.since(asst.snap); if (c?.files?.length) asst.changes = c; } catch (e) { console.warn('changes', e); }
      delete asst.snap;
    } else {
      const touched = touchedFiles(asst.parts);
      if (touched.length) asst.touched = touched;
    }
    this.running = null;
    asst.running = false;
    for (const p of asst.parts) if (p.type === 'tool' && p.status === 'run') p.status = ev.aborted ? 'err' : 'ok';
    if (ev.aborted) asst.parts.push({ type: 'notice', text: 'Остановлено' });
    if (ev.interrupted) { asst.interrupted = true; asst.parts.push({ type: 'notice', text: INTERRUPTED }); }
    asst.content = asst.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
    const err = asst.parts.find((p) => p.type === 'error');
    reportEnd(this, ev.aborted ? null : ev.interrupted ? 'interrupted' : err ? 'error' : asst.needsInput ? 'wait' : 'done', err ? err.text : asst.content);
    activeRuns.delete(this.node.id);
    await patchNodeData(this, { messages: [...all], ...(ev.sessionId ? { sessionId: ev.sessionId } : {}) });
    // after the answer is saved (a closed canvas' file is written by both)
    if (!ev.aborted && !ev.interrupted && !err && !asst.needsInput) relayAnswer(this, all[all.length - 2], asst.content);
    this.chain = null;
    nextRelay(this);
    native.agentChat.release?.(reqId); // the answer is saved: main may delete the run's journal
    if (this.node.data.worktree) this.refreshWorktree();
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

  stop(fromChain = false) {
    if (this.chain && !fromChain) bus.emit('relay:stop', this.chain);
    // stopped before the agent even started (still collecting the context): nothing to abort
    if (this.preparing && this.running === this.preparing) { const { all, asst } = this._prep; this.preparing = null; this.finish(this.running, all, asst, { aborted: true }); return; }
    const r = this.running || runOf(this)?.running; if (r) native.agentChat.abort(r);
  }
  syncHead() { this.view.syncHead(this.view.node(this.node.id) || this.node); bus.emit('agents'); }
  statusInfo() {
    if (this.running || runOf(this)) return { label: 'Работает', kind: 'busy' };
    const m = this.messages[this.messages.length - 1];
    if (runsElsewhere(m)) return { label: 'Работает на другом компьютере', kind: 'busy' };
    if (m?.interrupted) return { label: 'Прервано', kind: 'wait' };
    if (m && (m.parts || []).some((p) => p.type === 'error')) return { label: 'Ошибка', kind: 'na' };
    if (m && m.needsInput) return { label: 'Нужно разрешение', kind: 'wait' };
    return { label: this.messages.length ? 'Ожидает' : 'Готов', kind: 'idle' };
  }
  update(n) { this.node = n; if (!this.running) { this.modeSel.value = n.data.mode || this.modeSel.value; this.fillModelOptions(); this.renderCwd(); this.renderAll(); } }
  edit() { this.input.focus({ preventScroll: true }); }
  destroy() { this.offEdges?.(); this.offRelay?.(); }
  dispose() { this.stop(); }
}

// =====================================================================
// Note (vault markdown file)
// =====================================================================
class NoteInstance {
  constructor({ node, view, body }) {
    this.node = node; this.view = view; this.body = body;
    this.editor = new RichEditor({
      compact: true, bubble: true,
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
    chrome: 'window', farLod: true, defaultSize: { w: 460, h: 560 }, minSize: { w: 300, h: 260 },
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
      ...(inst ? [{ label: 'Размер текста', icon: 'text', children: fontItems(inst) }] : []),
      { label: 'Переименовать', icon: 'pen', onClick: () => NODE_TYPES.chat.rename(n, view) },
    ],
  },

  agentchat: {
    chrome: 'window', farLod: true, defaultSize: { w: 500, h: 620 }, minSize: { w: 320, h: 280 },
    defaultData: () => ({ agentId: 'claude', kind: 'claude', messages: [], sessionId: null }),
    title: (n) => n.data.title || `${state.agent(n.data.agentId).name} · чат`,
    badge: (n, size) => { const a = state.agent(n.data.agentId); return badge(a.mono, a.color, size, a.dark); },
    status: (n, inst) => inst?.statusInfo?.() || { label: 'Готов', kind: 'idle' },
    mount: (ctx) => new AgentChatInstance(ctx),
    rename: async (n, view) => { const t = await prompt('Название окна', NODE_TYPES.agentchat.title(n)); if (t != null) view.updateNode(n.id, { data: { title: t } }, { checkpoint: true }); },
    menu: (n, view, inst) => [
      { label: 'История чатов', icon: 'sidebar', onClick: () => inst?.hist.open() },
      { label: 'Новый чат', icon: 'plus', onClick: () => inst?.newSession() },
      { label: 'Спросить нескольких…', icon: 'chat', onClick: async () => { const { openAskMany } = await import('./askmany.js'); openAskMany(view, { sourceId: n.id, text: inst?.input.value || '' }); } },
      { label: 'Сменить рабочую папку…', icon: 'folder', onClick: () => inst?.pickCwd() },
      ...(n.data.worktree ? [{ label: 'Отдельная копия', icon: 'branch', children: inst?.worktreeItems() || [] }] : [{ label: 'Работать в отдельной копии (git worktree)…', icon: 'branch', onClick: () => inst?.enableWorktree() }]),
      ...(n.data.kind === 'codex' ? [{ label: 'Папка с картинками Codex', icon: 'image', onClick: async () => {
        const dir = await native.agentChat.imagesDir?.(n.data.sessionId);
        if (!dir) { toast('Codex ещё не сохранял картинки на этом компьютере', 'warn'); return; }
        const r = await native.shell.openPath(dir); if (r) toast(String(r), 'warn');
      } }] : []),
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
      ...(inst ? [{ label: 'Размер текста', icon: 'text', children: fontItems(inst) }] : []),
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
      return { edit: () => url.focus({ preventScroll: true }), update: (n) => { if (n.data.url !== url.value) { url.value = n.data.url; frame.src = n.data.url; } } };
    },
  },

  // what an agent changed during one answer: files with their diff, rollback (see showChanges)
  diff: {
    chrome: 'window', defaultSize: { w: 640, h: 560 }, minSize: { w: 360, h: 220 },
    defaultData: () => ({ changes: null }),
    title: (n) => n.data.title || 'Изменения',
    badge: (n, size) => h('span', { class: 'note-badge diff', style: { width: `${size}px`, height: `${size}px` }, html: icon('diff', Math.round(size * 0.8)) }),
    mount: ({ node, view, body }) => {
      let cur = node;
      const head = h('div', { class: 'diff-head' });
      const list = h('div', { class: 'diff-files scrollable' });
      body.append(h('div', { class: 'diff-view' }, head, list));
      // the chat message is the source of truth (rollback state); the card's own copy if it is gone
      const changesOf = () => msgByTs(view, cur.data.chatId, cur.data.ts)?.changes || cur.data.changes;
      const save = (c) => view.setData(cur.id, { changes: c });
      const render = () => {
        const c = changesOf();
        head.replaceChildren(); list.replaceChildren();
        if (!c?.files?.length) { list.append(h('div', { class: 'muted diff-empty' }, 'Изменений нет')); return; }
        const t = changeTotals(c), rev = !!c.reverted;
        head.append(
          h('span', { class: 'diff-sum' }, `${c.files.length} ${filesWord(c.files.length)}`),
          h('span', { class: 'mc-add' }, `+${t.add}`), h('span', { class: 'mc-del' }, `−${t.del}`),
          rev ? h('span', { class: 'diff-rev' }, 'откачено') : null,
          h('span', { class: 'mc-sp' }),
          h('span', { class: 'diff-root muted', title: c.root }, c.root.split(/[\\/]/).pop()),
          cur.data.noRevert ? null : h('button', { class: 'btn sm no-drag', onclick: async (e) => { e.stopPropagation(); await revertChanges(view, cur.data.chatId, cur.data.ts, rev, { changes: changesOf(), save }); render(); } }, rev ? 'Вернуть' : 'Откатить'));
        const reverted = new Set(c.reverted?.files || []);
        c.files.forEach((f, k) => {
          const code = h('div', { class: 'diff-code' });
          const d = h('details', { class: `diff-file no-drag${reverted.has(f.path) ? ' rev' : ''}` },
            h('summary', {},
              h('span', { class: `diff-st st-${f.status}` }, f.status === 'A' ? 'новый' : f.status === 'D' ? 'удалён' : 'изменён'),
              h('span', { class: 'diff-path', title: f.path }, f.path),
              ...(f.binary ? [h('span', { class: 'muted small' }, 'двоичный')] : [h('span', { class: 'mc-add' }, `+${f.add}`), h('span', { class: 'mc-del' }, `−${f.del}`)]),
              reverted.has(f.path) ? h('span', { class: 'diff-rev' }, 'откачен') : null,
              h('button', { class: 'icon-btn sm', title: 'Показать в папке', html: icon('folder', 12), onclick: (e) => { e.preventDefault(); e.stopPropagation(); native.changes.reveal({ root: c.root, file: f.path }); } })),
            code);
          let loaded = false;
          d.addEventListener('toggle', async () => {
            if (!d.open || loaded) return;
            loaded = true;
            code.textContent = 'Загрузка…';
            try { code.replaceChildren(...diffLines(await native.changes.patch({ root: c.root, before: c.before, after: c.after, file: f.path }))); }
            catch { code.textContent = 'Не удалось показать: папка или версия недоступна на этом компьютере.'; }
          });
          list.append(d);
          if (k === 0) d.open = true;
        });
      };
      render();
      const off = bus.on('changes:updated', (e) => { if (e.chatId === cur.data.chatId && e.ts === cur.data.ts) render(); });
      return { update: (n) => { const changed = n.data.changes !== cur.data.changes; cur = n; if (changed) render(); }, destroy: () => off() };
    },
  },

  sticky: {
    chrome: 'bare', defaultSize: { w: 220, h: 220 }, minSize: { w: 80, h: 60 }, colors: STICKY_COLORS,
    defaultData: () => ({ text: '', color: 'yellow' }),
    title: (n) => (n.data.text || 'Стикер').split('\n')[0].slice(0, 30),
    mount: ({ node, view, body }) => {
      const box = h('div', { class: 'sticky' });
      const txt = h('div', { class: 'txt', 'data-placeholder': 'Напишите что-нибудь…' });
      box.append(txt); body.append(box);
      let cur = node;
      const paint = () => { const c = cur.data.color || 'yellow'; box.style.background = cssColor(c, 'yellow'); box.classList.toggle('dark', wantsWhiteText(c)); txt.innerText = cur.data.text || ''; txt.classList.toggle('empty', !cur.data.text); requestAnimationFrame(() => fitText(txt, box)); };
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
    chrome: 'bare', defaultSize: { w: 100, h: 100 }, minSize: { w: 6, h: 6 }, colors: BAR_COLORS,
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
    chrome: 'bare', defaultSize: { w: 200, h: 140 }, minSize: { w: 30, h: 30 }, colors: OBJECT_COLORS,
    defaultData: () => ({ kind: 'rect', color: 'blue', text: '' }),
    title: (n) => n.data.text || ({ rect: 'Прямоугольник', ellipse: 'Эллипс', diamond: 'Ромб' })[n.data.kind] || 'Фигура',
    mount: ({ node, view, body }) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'shape-svg'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('viewBox', '0 0 100 100');
      const txt = h('div', { class: 'shape-text txt' });
      body.append(svg, txt);
      let cur = node;
      const paint = () => {
        svg.style.setProperty('--sc', cssColor(cur.data.color || 'blue', 'blue'));
        const shape = cur.data.kind === 'ellipse' ? '<ellipse cx="50" cy="50" rx="49" ry="49"/>' : cur.data.kind === 'diamond' ? '<path d="M50 1 L99 50 L50 99 L1 50 Z"/>' : '<rect x="1" y="1" width="98" height="98" rx="6" ry="6"/>';
        svg.innerHTML = `<g fill-opacity="0.22" stroke-width="2" style="fill:var(--sc);stroke:var(--sc);vector-effect:non-scaling-stroke">${shape.replace('/>', ' vector-effect="non-scaling-stroke"/>')}</g>`;
        txt.innerText = cur.data.text || '';
      };
      const edit = editableText(txt, { onCommit: (v) => view.updateNode(cur.id, { data: { text: v } }, { checkpoint: true, silent: true }) });
      paint();
      return { edit, update: (n) => { cur = n; if (!txt.isContentEditable) paint(); } };
    },
  },

  frame: {
    chrome: 'bare', defaultSize: { w: 800, h: 520 }, minSize: { w: 120, h: 80 }, colors: OBJECT_COLORS,
    defaultData: () => ({ title: 'Область', color: 'blue' }),
    title: (n) => n.data.title || 'Область',
    mount: ({ node, view, body }) => {
      const title = h('div', { class: 'frame-title txt' });
      const area = h('div', { class: 'frame-area' });
      const count = h('div', { class: 'frame-count' });
      body.append(title, count, area);
      let cur = node;
      const paint = () => { title.textContent = cur.data.title || 'Область'; const fc = cssColor(cur.data.color || 'blue', 'blue'); for (const el of [area, title, count]) el.style.setProperty('--fc', fc); };
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

// world: where the picture goes — its centre (a drop under the cursor) or, with { center: false },
// its top-left corner
export async function imageNodeFromFile(view, file, world, opts = {}) {
  const dataUrl = await readFileAsDataURL(file);
  const rel = await native.vault.saveAsset(dataUrl, file.name);
  vaultIndex.addAsset(rel);
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.onerror = r; img.src = dataUrl; });
  let w = img.naturalWidth || 360, hh = img.naturalHeight || 240;
  const k = Math.min(1, 520 / Math.max(w, hh));
  w = Math.round(w * k); hh = Math.round(hh * k);
  return view.addNode('image', { x: world.x, y: world.y, w, h: hh, data: { vault: rel } }, opts);
}

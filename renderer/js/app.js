import { h, icon, badge, bus, menu, prompt, confirmBox, toast, modal, isEditable, esc, debounce, keyName } from './util.js';
import { renderChatMarkdown } from './md.js';
import { state, native, PROVIDER_META, DEFAULT_AGENTS, providerName } from './state.js';
import { CanvasView } from './canvas.js';
import { NODE_TYPES, imageNodeFromFile } from './nodes.js';
import { clipboardFiles } from './attach.js';
import { PenBar, cssColor, colorRow, openColorPicker, toHex, swatch, OBJECT_COLORS } from './pentools.js';
import { WIDGETS, openWidgetPicker } from './widgets.js';
import { vaultIndex } from './vaultIndex.js';
import { Sidebar, NotePanel, openGraph } from './notes.js';
import { setFpsMeter, toggleFpsMeter, runPerfTest } from './perf.js';
import { AgentWatch, Companion, loadCodexPets, codexPetFor } from './companion.js';
import { inbox, INBOX_KINDS, badgeOf, ago, projectOf } from './inbox.js';
import { bindCanvasTools } from './canvasTools.js';
import { openTemplates, saveTemplate, allTemplates, placeTemplate } from './templates.js';
import { limits, limitsPanel, petSvg, LIMIT_SOURCES, PETS, openPetPicker, openPetCatalog, CLOCK_PRESETS, CLOCK_DEFAULT, clockColors, paintClock, clockMarkup } from './hub.js';

const VERSION = '1.4.0';

class App {
  async start() {
    await state.init();
    this.applyTheme();
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.settings.theme === 'system') this.applyTheme(); });
    await vaultIndex.refresh();
    this.buildShell();
    this.canvas = new CanvasView(this.canvasHost);
    this.applyTheme();
    this.buildToolbar();
    this.sidebar = new Sidebar(this.sidebarHost, this);
    this.notePanel = new NotePanel(this.panelHost, this);
    this.bindCanvas();
    this.bindBus();
    this.bindKeys();
    this.agentWatch = new AgentWatch(this);
    this.startPet();
    loadCodexPets().then(() => this.updatePet());
    if (state.settings.fps) setFpsMeter(true);
    this.bindSync();
    native.app?.onFlush?.(async () => { try { await state.flushAll(); } finally { native.app.flushed(); } });
    state.on('canvas', () => { this.canvas.load(); this.renderTabs(); });
    state.on('projects', () => this.renderTabs());
    this.canvas.load();
    this.renderTabs();
    limits.refresh();
    setInterval(() => this.canvas.refreshStatuses(), 1000);
    if (localStorage.getItem('sidebar') === '1') this.toggleSidebar(true);
    this.bindInbox();
    bindCanvasTools(this.canvas);
    document.getElementById('boot')?.remove();
  }

  // ---------------- «Ждут вас» ----------------
  bindInbox() {
    const paint = () => {
      const n = inbox.count;
      this.inboxCount.textContent = n > 9 ? '9+' : n ? String(n) : '';
      this.inboxBtn.classList.toggle('has', n > 0);
      this.inboxBtn.title = n ? `Ждут вас: ${n}` : 'Ждут вас: агенты, которые закончили или ждут разрешения';
    };
    bus.on('inbox', paint);
    bus.on('inbox:open', (it) => this.openInboxItem(it));
    paint();
    // a click into a window means it has been seen
    this.canvas.root.addEventListener('pointerdown', (e) => { const el = e.target.closest?.('.node[data-id]'); if (el) inbox.remove(el.dataset.id); }, true);
    // answers agents finished in the background while their canvas was not open (or the app closed)
    const add = async (r) => {
      if (r.state === 'running' || !r.docId) return;
      if (state.doc?.id === r.docId && this.canvas.views.has(r.nodeId)) return; // the window picks it up itself
      let title = 'Чат агента', n = null;
      try { n = (await native.canvas.load(r.docId))?.nodes?.find((x) => x.id === r.nodeId); } catch {}
      if (!n) return; // the window was deleted
      title = NODE_TYPES[n.type]?.title(n) || title;
      inbox.add({ nodeId: r.nodeId, docId: r.docId, kind: r.state === 'lost' ? 'interrupted' : 'background', title, text: r.state === 'lost' ? 'Агент остановился, не закончив ответ' : 'Агент закончил, пока окно было закрыто', type: n.type, agentId: n.data.agentId }, { notify: true });
    };
    native.agentChat.background?.().then((list) => { for (const r of list || []) add(r); }).catch(() => {});
    native.agentChat.onBackground?.((r) => add(r));
  }
  async openInboxItem(it) {
    inbox.remove(it.nodeId);
    const p = projectOf(it.docId);
    if (!p) { toast('Этого canvas больше нет', 'warn'); return; }
    if (state.doc?.id !== it.docId) await state.openCanvas(p.id, it.docId);
    if (!this.canvas.node(it.nodeId)) { toast('Окно уже удалено', 'warn'); return; }
    this.canvas.focusNode(it.nodeId);
  }
  showInbox(anchor) {
    document.querySelector('.inbox-pop')?.remove();
    const list = h('div', { class: 'inbox-list' });
    const clearBtn = h('button', { class: 'btn sm', onclick: () => inbox.clear() }, 'Очистить');
    const pop = h('div', { class: 'popover inbox-pop' },
      h('div', { class: 'inbox-head' }, h('b', {}, 'Ждут вас'), clearBtn), list);
    const close = () => { pop.remove(); off(); document.removeEventListener('pointerdown', away, true); };
    const render = () => {
      clearBtn.disabled = !inbox.count;
      list.replaceChildren();
      if (!inbox.count) { list.append(h('div', { class: 'inbox-empty muted' }, 'Здесь появятся агенты и чаты, которые закончили, ждут разрешения или упали с ошибкой, пока вы были в другом месте.')); return; }
      for (const it of inbox.items) {
        const b = badgeOf(it), k = INBOX_KINDS[it.kind];
        list.append(h('button', { class: 'inbox-item', title: 'Открыть окно', onclick: () => { close(); this.openInboxItem(it); } },
          badge(b.mono, b.color, 22, b.dark),
          h('div', { class: 'inbox-main' },
            h('div', { class: 'inbox-top' }, h('span', { class: 'inbox-title' }, it.title), h('span', { class: `inbox-kind ${k.cls}` }, k.label)),
            it.text ? h('div', { class: 'inbox-text' }, it.text) : null,
            h('div', { class: 'inbox-meta' }, [it.where, ago(it.ts)].filter(Boolean).join(' · ')))));
      }
    };
    const off = bus.on('inbox', render);
    render();
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect();
    pop.style.left = `${Math.min(innerWidth - pr.width - 10, Math.max(10, r.right - pr.width))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    const away = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  }

  // ---------------- shell ----------------
  buildShell() {
    const app = document.getElementById('app');
    const isEl = native.isElectron;
    this.projBtn = h('button', { class: 'proj-btn', onclick: (e) => this.projectMenu(e) });
    this.tabs = h('div', { class: 'canvas-tabs' });
    this.limitsBtn = h('button', { class: 'tb-icon', title: 'Лимиты нейросетей', html: icon('gauge', 16), onclick: (e) => this.showLimits(e.currentTarget) });
    this.inboxCount = h('span', { class: 'inbox-count' });
    this.inboxBtn = h('button', { class: 'tb-icon inbox-btn', title: 'Ждут вас: агенты, которые закончили или ждут разрешения', html: icon('bell', 16), onclick: (e) => this.showInbox(e.currentTarget) });
    this.inboxBtn.append(this.inboxCount);
    const title = h('header', { class: 'titlebar' },
      h('div', { class: 'tb-left' },
        h('img', { class: 'app-logo', src: 'assets/logo64.png', alt: '' }),
        h('span', { class: 'app-name', title: `VibeTabula ${state.info.version || VERSION}` }, 'VibeTabula'),
      ),
      h('div', { class: 'tb-center' }, this.projBtn, this.tabs),
      h('div', { class: 'tb-right' },
        h('button', { class: 'tb-icon', title: 'Заметки и canvas (Ctrl+\\)', html: icon('sidebar', 16), onclick: () => this.toggleSidebar() }),
        this.inboxBtn,
        h('button', { class: 'tb-icon', title: 'Поиск команд (Ctrl+P)', html: icon('search', 16), onclick: () => this.palette() }),
        this.themeBtn = h('button', { class: 'tb-icon', title: 'Светлая / тёмная тема', onclick: () => this.toggleTheme() }),
        h('button', { class: 'tb-icon', title: 'Инструкция (F1)', html: icon('help', 16), onclick: () => this.openHelp() }),
        this.limitsBtn,
        h('button', { class: 'tb-icon', title: 'Настройки', html: icon('settings', 16), onclick: () => this.openSettings() }),
        isEl && state.info.platform !== 'darwin' ? h('div', { class: 'win-ctrls' },
          h('button', { class: 'win-btn', title: 'Свернуть', html: icon('minus', 15), onclick: () => native.win.minimize() }),
          this.maxBtn = h('button', { class: 'win-btn', title: 'Развернуть', html: icon('square', 13), onclick: () => native.win.maximize() }),
          h('button', { class: 'win-btn close', title: 'Закрыть', html: icon('x', 15), onclick: () => native.win.close() })) : null,
      ),
    );
    document.documentElement.dataset.platform = state.info.platform || 'web';
    if (isEl && this.maxBtn) native.win.onState(({ maximized }) => { this.maxBtn.innerHTML = icon(maximized ? 'squares' : 'square', 13); });
    this.sidebarHost = h('div', { class: 'sidebar-host' });
    this.canvasHost = h('div', { class: 'canvas-host' });
    this.panelHost = h('div', { class: 'panel-host' });
    this.main = h('div', { class: 'main' }, this.sidebarHost, this.canvasHost, this.panelHost);
    app.append(title, this.main);
  }

  resolvedTheme() {
    const t = state.settings.theme || 'dark';
    return t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  }
  applyTheme() {
    const t = this.resolvedTheme();
    document.documentElement.dataset.theme = t;
    native.setBg?.(t === 'light' ? '#f3f4f7' : '#14161c');
    if (this.themeBtn) { this.themeBtn.innerHTML = icon(t === 'light' ? 'moon' : 'sun', 16); this.themeBtn.title = t === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'; }
    bus.emit('theme', t);
    this.canvas?.updateGridTile();
    this.canvas?.drawMinimap();
  }
  toggleTheme() { state.setSetting('theme', this.resolvedTheme() === 'light' ? 'dark' : 'light'); this.applyTheme(); }

  async openHelp() {
    let md = '';
    try { md = await (await fetch('help.md')).text(); } catch { md = '# Инструкция\n\nФайл справки не найден. Откройте README.md в папке приложения.'; }
    modal({ title: 'Инструкция VibeTabula', body: h('div', { class: 'md', html: renderChatMarkdown(md) }), width: 'min(860px, 94vw)', className: 'help-modal' });
  }

  renderTabs() {
    const p = state.project;
    this.projBtn.replaceChildren(h('span', { class: 'proj-dot', style: { background: cssColor(p.color, 'blue') } }), h('span', {}, p.name), h('span', { html: icon('chevronDown', 13) }));
    this.tabs.innerHTML = '';
    for (const c of p.canvases) {
      const active = c.id === state.ws.activeCanvasId;
      const tab = h('div', { class: `ctab${active ? ' active' : ''}`, title: c.name, onclick: () => !active && state.openCanvas(p.id, c.id) }, h('span', {}, c.name));
      tab.addEventListener('dblclick', async () => { const n = await prompt('Переименовать canvas', c.name); if (n) state.renameCanvas(p.id, c.id, n); });
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); this.canvasMenu(p, c, e.clientX, e.clientY); });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) this.deleteCanvas(p, c); });
      this.tabs.append(tab);
    }
    this.tabs.append(h('button', { class: 'ctab-add', title: 'Новый canvas', html: icon('plus', 13), onclick: async () => { const n = await prompt('Название canvas', `Canvas ${p.canvases.length + 1}`); if (n) state.createCanvas(p.id, n); } }));
  }

  canvasMenu(p, c, x, y) {
    menu([
      { label: 'Открыть', icon: 'grid', onClick: () => state.openCanvas(p.id, c.id) },
      { label: 'Переименовать', icon: 'pen', onClick: async () => { const n = await prompt('Переименовать canvas', c.name); if (n) state.renameCanvas(p.id, c.id, n); } },
      { label: 'Дублировать', icon: 'copy', onClick: () => state.duplicateCanvas(p.id, c.id) },
      { label: 'Переместить в проект', icon: 'folder', children: state.ws.projects.filter((x) => x.id !== p.id).map((x) => ({ label: x.name, onClick: () => this.moveCanvas(p, c, x) })) },
      '-',
      { label: 'Удалить canvas', icon: 'trash', danger: true, disabled: p.canvases.length <= 1, onClick: () => this.deleteCanvas(p, c) },
    ], x, y);
  }
  async deleteCanvas(p, c) {
    if (p.canvases.length <= 1) { toast('В проекте должен остаться хотя бы один canvas', 'warn'); return; }
    if (await confirmBox('Удалить canvas?', `«${c.name}» и все объекты на нём будут удалены. Заметки в хранилище останутся.`)) state.deleteCanvas(p.id, c.id);
  }
  async moveCanvas(from, c, to) {
    from.canvases = from.canvases.filter((x) => x.id !== c.id);
    to.canvases.push(c);
    state.saveWs();
    await state.openCanvas(to.id, c.id);
    state.emit('projects');
  }

  projectMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    menu([
      { header: 'Проекты' },
      ...state.ws.projects.map((p) => ({ label: `${p.name}  ·  ${p.canvases.length}`, badge: h('span', { class: 'proj-dot', style: { background: cssColor(p.color, 'blue') } }), checked: p.id === state.project.id, onClick: () => state.openCanvas(p.id, p.canvases[0].id) })),
      '-',
      { label: 'Новый проект…', icon: 'plus', onClick: () => this.projectDialog() },
      { label: 'Настройки проекта…', icon: 'settings', onClick: () => this.projectDialog(state.project) },
      { label: 'Удалить проект', icon: 'trash', danger: true, disabled: state.ws.projects.length <= 1, onClick: async () => { if (await confirmBox('Удалить проект?', `Проект «${state.project.name}» и все его canvas будут удалены. Заметки останутся.`)) state.deleteProject(state.project.id); } },
    ], r.left, r.bottom + 6, { minWidth: 240 });
  }

  projectDialog(project) {
    let color = project?.color || OBJECT_COLORS[state.ws.projects.length % 7];
    const name = h('input', { class: 'input', value: project?.name || '', placeholder: 'Название проекта' });
    const cwd = h('input', { class: 'input', value: project?.cwd || state.info.home || '', placeholder: 'Рабочая папка для агентов' });
    const sw = h('div', { class: 'swatches apple' });
    const paintSw = () => sw.replaceChildren(...colorRow({ colors: OBJECT_COLORS, current: color, onPick: (c) => { color = c; paintSw(); }, onLive: (c) => { color = c; } }));
    paintSw();
    const body = h('div', { class: 'form' },
      h('label', {}, 'Название'), name,
      h('label', {}, 'Рабочая папка (агенты запускаются в ней)'),
      h('div', { class: 'row' }, cwd, h('button', { class: 'btn', onclick: async () => { const p = await native.dialog.folder('Рабочая папка проекта'); if (p) cwd.value = p; } }, 'Выбрать…')),
      h('label', {}, 'Цвет'), sw);
    modal({
      title: project ? 'Настройки проекта' : 'Новый проект', body, width: 520,
      actions: [{ label: 'Отмена' }, { label: project ? 'Сохранить' : 'Создать', primary: true, onClick: () => {
        if (project) state.updateProject(project.id, { name: name.value.trim() || project.name, cwd: cwd.value.trim(), color });
        else state.createProject(name.value.trim() || 'Новый проект', cwd.value.trim()).then((p) => state.updateProject(p.id, { color }));
      } }],
    });
    setTimeout(() => name.focus(), 50);
  }

  toggleSidebar(force) {
    const open = force ?? !this.main.classList.contains('sb-open');
    this.main.classList.toggle('sb-open', open);
    try { localStorage.setItem('sidebar', open ? '1' : '0'); } catch {}
  }

  // ---------------- bottom toolbar (canvas tools) ----------------
  buildToolbar() {
    const tb = h('div', { class: 'toolbar' });
    const tools = {};
    const tool = (id, ic, title) => { const b = h('button', { class: 'tool', title, html: icon(ic, 19), onclick: () => this.canvas.setTool(id) }); tools[id] = b; return b; };
    const action = (ic, title, fn, cls = '') => h('button', { class: `tool ${cls}`, title, html: icon(ic, 19), onclick: fn });
    this.shapeBtn = h('button', { class: 'tool', title: 'Фигура (R / O)', html: icon('rect', 19), onclick: () => this.canvas.setTool(this.lastShape || 'rect') });
    this.shapeBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); this.shapeMenu(e); });
    const caret = h('button', { class: 'tool caret', title: 'Выбрать фигуру', html: icon('chevronDown', 11), onclick: (e) => this.shapeMenu(e) });
    tb.append(
      tool('select', 'cursor', 'Выделение (V)'), tool('hand', 'hand', 'Рука (H, или пробел)'),
      h('span', { class: 'tsep' }),
      tool('sticky', 'sticky', 'Стикер (S)'), tool('text', 'text', 'Текст (T)'), tool('pencil', 'pencil', 'Карандаш (P). Shift — прямая линия'),
      h('span', { class: 'tool-group' }, this.shapeBtn, caret),
      tool('arrow', 'arrow', 'Стрелка-связь (A)'), tool('frame', 'area', 'Область с названием (F)'),
      this.commentBtn = tool('comment', 'comment', 'Комментарий (C). ПКМ — показать / скрыть комментарии'),
      h('span', { class: 'tsep' }),
      action('note', 'Заметка', (e) => this.noteMenu(e)),
      action('image', 'Изображение', () => this.pickImage()),
      this.widgetBtn = action('gallery', 'Виджеты на canvas (W): часы, таймер, чек-лист, календарь…', () => this.widgetPicker()),
      h('span', { class: 'tsep' }),
      h('button', { class: 'tool agent-btn', title: 'Позвать нейросеть', onclick: (e) => this.launchMenu(e) }, h('span', { html: icon('sparkle', 17) }), h('span', {}, 'Агент')),
    );
    this.canvasHost.append(tb);
    this.commentBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const cm = this.canvas.comments;
      menu([
        { label: cm.visible ? 'Скрыть комментарии' : 'Показать комментарии', icon: 'comment', kbd: 'Shift+C', onClick: () => cm.toggleVisible() },
        { label: 'Показывать решённые', checked: !!state.settings.showResolvedComments, onClick: () => cm.toggleResolved() },
        '-',
        { label: `Подпись: ${state.settings.userName || 'не задана'}…`, icon: 'pen', onClick: async () => { const n = await prompt('Имя в комментариях', state.settings.userName || ''); if (n != null && n.trim()) state.setSetting('userName', n.trim()); } },
      ], e.clientX, e.clientY - 120);
    });
    // drawing tools (Apple Notes style), shown while the pencil is active
    this.penBar = new PenBar({ host: this.canvasHost, canvas: this.canvas });
    this.canvas.on('penTool', () => this.penBar.paint());
    const sync = (t) => {
      this.penBar.show(t === 'pencil');
      for (const [id, b] of Object.entries(tools)) b.classList.toggle('active', id === t);
      const shapeActive = ['rect', 'ellipse', 'diamond'].includes(t);
      this.shapeBtn.classList.toggle('active', shapeActive);
      if (shapeActive) { this.lastShape = t; this.shapeBtn.innerHTML = icon(t, 19); }
    };
    this.canvas.on('tool', sync);
    this.canvas.setTool('select');
  }
  shapeMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    menu([
      { label: 'Прямоугольник', icon: 'rect', kbd: 'R', onClick: () => this.canvas.setTool('rect') },
      { label: 'Эллипс', icon: 'ellipse', kbd: 'O', onClick: () => this.canvas.setTool('ellipse') },
      { label: 'Ромб', icon: 'diamond', onClick: () => this.canvas.setTool('diamond') },
    ], r.left, r.top - 120);
  }
  noteMenu(e, world) {
    const r = e.currentTarget?.getBoundingClientRect?.() || { left: e.clientX, top: e.clientY };
    const recent = [...vaultIndex.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
    menu([
      { label: 'Новая заметка', icon: 'plus', kbd: 'Ctrl+N', onClick: () => this.newNoteOnCanvas(world) },
      { label: 'Найти заметку…', icon: 'search', kbd: 'Ctrl+O', onClick: () => this.quickOpen(true) },
      recent.length ? '-' : null,
      recent.length ? { header: 'Недавние' } : null,
      ...recent.map((n) => ({ label: n.name, icon: 'file', onClick: () => this.addNoteToCanvas(n.path, world) })),
    ], r.left, Math.max(10, r.top - 60 - recent.length * 32), { minWidth: 240 });
  }
  launchMenu(e, world) {
    const r = e.currentTarget?.getBoundingClientRect?.() || { left: e.clientX, top: e.clientY };
    menu(this.launchItems(world), r.left, Math.max(10, r.top - 520), { minWidth: 280 });
  }
  launchItems(world, from) {
    const agents = state.settings.agents.filter((a) => !a.hidden);
    return [
      { header: 'Окно чата агента (по подписке)' },
      ...agents.filter((a) => a.chat).map((a) => ({ label: `${a.name} — чат`, badge: badge(a.mono, a.color, 16, a.dark), onClick: () => this.launchAgentChat({ agentId: a.id, world, from }) })),
      '-',
      { header: 'Агент в терминале' },
      ...agents.map((a) => ({ label: a.name, badge: badge(a.mono, a.color, 16, a.dark), kbd: a.cmd || 'shell', onClick: () => this.launchAgent({ agentId: a.id, world, from }) })),
      '-',
      { header: 'Чат по API-ключу' },
      ...Object.entries(PROVIDER_META).map(([id, m]) => ({ label: providerName(id), badge: badge(m.mono, m.color, 16, m.dark), kbd: state.settings.providers?.[id]?.key || ['ollama', 'custom'].includes(id) ? '' : 'нет ключа', onClick: () => this.launchChat({ provider: id, world, from }) })),
      '-',
      { label: 'Веб-страница', icon: 'globe', onClick: () => this.launchWeb({ world, from }) },
    ];
  }
  agentMenu(agentId, x, y, near) {
    const a = state.agent(agentId);
    const items = [{ header: a.name }];
    if (a.chat) items.push({ label: 'Окно чата', icon: 'chat', kbd: 'по подписке', onClick: () => this.launchAgentChat({ agentId, near }) });
    items.push({ label: 'Терминал', icon: 'terminal', kbd: a.cmd || 'shell', onClick: () => this.launchAgent({ agentId, near }) });
    if (agentId === 'claude') items.push({ label: 'Чат по API-ключу', icon: 'sparkle', kbd: state.settings.providers?.anthropic?.key ? '' : 'нужен ключ', onClick: () => this.launchChat({ provider: 'anthropic', near }) });
    if (agentId === 'codex') items.push({ label: 'Чат по API-ключу OpenAI', icon: 'sparkle', kbd: state.settings.providers?.openai?.key ? '' : 'нужен ключ', onClick: () => this.launchChat({ provider: 'openai', near }) });
    if (agentId === 'kimi') items.push({ label: 'Чат по API-ключу Moonshot', icon: 'sparkle', onClick: () => this.launchChat({ provider: 'moonshot', near }) });
    if (agentId === 'gemini') items.push({ label: 'Чат по API-ключу Gemini', icon: 'sparkle', onClick: () => this.launchChat({ provider: 'gemini', near }) });
    if (items.length === 2) { items[1].onClick(); return; }
    menu(items, x, y, { minWidth: 230 });
  }

  // ---------------- placement ----------------
  freeSpot(w, hh, near) {
    const nodes = state.doc.nodes;
    const overlaps = (x, y) => nodes.some((n) => x < n.x + n.w + 24 && x + w + 24 > n.x && y < n.y + n.h + 24 && y + hh + 24 > n.y);
    let cx, cy;
    if (near) { cx = near.x + near.w / 2; cy = near.y + near.h / 2; }
    else { const c = this.canvas.centerWorld(); cx = c.x; cy = c.y; }
    if (!near && !overlaps(cx - w / 2, cy - hh / 2)) return { x: cx - w / 2, y: cy - hh / 2 };
    const startR = near ? Math.max(near.w, near.h) / 2 + 60 : 0;
    for (let r = startR; r < 6000; r += 80) {
      const steps = Math.max(8, Math.floor(r / 40));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(a) * (r + w / 2) - w / 2, y = cy + Math.sin(a) * (r + hh / 2) - hh / 2;
        if (!overlaps(x, y)) return { x: Math.round(x / 8) * 8, y: Math.round(y / 8) * 8 };
      }
    }
    return { x: cx, y: cy };
  }
  widgetPicker() { openWidgetPicker(this.widgetBtn, (kind) => this.addWidget(kind)); }
  addWidget(kind, world) {
    const d = WIDGETS[kind];
    if (!d) return null;
    const n = this.place('widget', { world, data: { kind, ...(d.defaults?.() || {}) }, w: d.size?.w, h: d.size?.h });
    this.canvas.select([n.id]);
    return n;
  }
  place(type, { world, from, near, data, w, h: hh } = {}) {
    const def = NODE_TYPES[type];
    const size = { w: w || def.defaultSize.w, h: hh || def.defaultSize.h };
    let pos;
    if (world) pos = { x: world.x - size.w / 2, y: world.y - size.h / 2 };
    else {
      const nearNode = near ? state.doc.nodes.find((n) => n.id === near) : null;
      pos = this.freeSpot(size.w, size.h, nearNode);
    }
    const n = this.canvas.addNode(type, { ...pos, ...size, data }, { center: false });
    if (from) this.canvas.addEdge(from.id, n.id);
    const anchor = from || (near && state.doc.nodes.find((x) => x.id === near));
    this.ensureVisible(n, anchor);
    return n;
  }
  ensureVisible(n, anchor) {
    const r = this.canvas.rect();
    const a = this.canvas.toScreen(n.x, n.y), b = this.canvas.toScreen(n.x + n.w, n.y + n.h);
    if (a.x < 0 || a.y < 0 || b.x > r.width || b.y > r.height) {
      const nodes = anchor ? [n, anchor] : [n];
      this.canvas.animateTo(this.canvas.fitRect(this.canvas.bounds(nodes), 70, Math.min(1, Math.max(this.canvas.vp.z, 0.3))));
    }
  }

  launchAgent({ agentId, world, from, near }) {
    const n = this.place('terminal', { world, from, near, data: { agentId } });
    setTimeout(() => this.canvas.views.get(n.id)?.inst?.edit?.(), 300);
    return n;
  }
  launchAgentChat({ agentId, world, from, near }) {
    const a = state.agent(agentId);
    const n = this.place('agentchat', { world, from, near, data: { agentId, kind: a.chat || 'claude' } });
    setTimeout(() => this.canvas.views.get(n.id)?.inst?.edit?.(), 100);
    return n;
  }
  launchChat({ provider, world, from, near }) {
    const n = this.place('chat', { world, from, near, data: { provider } });
    setTimeout(() => this.canvas.views.get(n.id)?.inst?.edit?.(), 100);
    return n;
  }
  async launchWeb({ world, from, near }) {
    const url = await prompt('Адрес страницы', 'https://', 'https://example.com');
    if (!url) return;
    this.place('web', { world, from, near, data: { url: /^[a-z]+:\/\//i.test(url) ? url : `https://${url}` } });
  }

  // ---------------- notes ↔ canvas ----------------
  async openNote(path, opts) {
    this.main.classList.add('np-open');
    await this.notePanel.open(path, opts);
    this.sidebar.renderTree();
  }
  closeNote() { this.notePanel.close(); this.main.classList.remove('np-open'); this.sidebar.renderTree(); }
  async openNoteByName(name) {
    let n = vaultIndex.byName(name);
    if (!n) { const p = await native.vault.create('', name, ''); await vaultIndex.refresh(); n = vaultIndex.byPath(p); }
    this.openNote(n.path);
  }
  addNoteToCanvas(path, world) {
    if (!path) return;
    const ex = state.doc.nodes.find((n) => n.type === 'note' && n.data.path === path);
    if (ex && !world) { this.canvas.focusNode(ex.id); return ex; }
    const n = this.place('note', { world, data: { path } });
    this.sidebar.renderTree();
    return n;
  }
  // several notes at once: a neat grid on free space (near the drop point), nothing overlaps
  addNotesToCanvas(paths, world) {
    const fresh = paths.filter((p) => !state.doc.nodes.some((n) => n.type === 'note' && n.data.path === p));
    const already = paths.length - fresh.length;
    if (!fresh.length) { const ids = state.doc.nodes.filter((n) => n.type === 'note' && paths.includes(n.data.path)).map((n) => n.id); this.canvas.select(ids); this.canvas.fit(ids); toast('Эти заметки уже на canvas'); return []; }
    const { w, h: hh } = NODE_TYPES.note.defaultSize;
    const gap = 40;
    const cols = Math.min(fresh.length, Math.ceil(Math.sqrt(fresh.length)));
    const rows = Math.ceil(fresh.length / cols);
    const bw = cols * w + (cols - 1) * gap, bh = rows * hh + (rows - 1) * gap;
    const at = world ? this.freeSpotAt(bw, bh, world) : this.freeSpot(bw, bh, null);
    this.canvas.checkpoint();
    const ids = fresh.map((p, i) => this.canvas.addNode('note', { x: at.x + (i % cols) * (w + gap), y: at.y + Math.floor(i / cols) * (hh + gap), w, h: hh, data: { path: p } }, { center: false, select: false, checkpoint: false }).id);
    this.canvas.select(ids);
    this.canvas.fit(ids);
    this.sidebar.renderTree();
    if (already) toast(`Уже были на canvas: ${already}`);
    return ids;
  }
  // like freeSpot, but the search starts at a given point (the block is centred on it if it fits)
  freeSpotAt(w, hh, c) {
    const nodes = state.doc.nodes;
    const overlaps = (x, y) => nodes.some((n) => x < n.x + n.w + 24 && x + w + 24 > n.x && y < n.y + n.h + 24 && y + hh + 24 > n.y);
    for (let r = 0; r < 8000; r += 60) {
      const steps = r ? Math.max(8, Math.floor(r / 30)) : 1;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round((c.x - w / 2 + Math.cos(a) * r) / 8) * 8, y = Math.round((c.y - hh / 2 + Math.sin(a) * r) / 8) * 8;
        if (!overlaps(x, y)) return { x, y };
      }
    }
    return { x: c.x - w / 2, y: c.y - hh / 2 };
  }
  async newNoteOnCanvas(world, from) {
    const name = await prompt('Новая заметка', '', 'Название');
    if (name == null) return;
    const p = await native.vault.create('', name || 'Без названия', '');
    await vaultIndex.refresh();
    this.canvas.forks.add(p);
    const n = this.place('note', { world, from, data: { path: p } });
    setTimeout(() => this.canvas.views.get(n.id)?.inst?.edit?.(), 150);
  }
  addNoteWithLinks(path) {
    const center = this.addNoteToCanvas(path);
    if (!center) return;
    this.expandNote(center.id);
  }
  expandNote(nodeId) {
    const c = this.canvas.node(nodeId);
    if (!c) return;
    const related = [...new Map([...vaultIndex.outgoing(c.data.path), ...vaultIndex.backlinks(c.data.path)].map((n) => [n.path, n])).values()];
    if (!related.length) { toast('У заметки нет связей', 'warn'); return; }
    const R = Math.max(c.w, c.h) + 160;
    related.slice(0, 12).forEach((note, i, arr) => {
      let ex = state.doc.nodes.find((n) => n.type === 'note' && n.data.path === note.path);
      if (!ex) {
        const a = (i / arr.length) * Math.PI * 2 - Math.PI / 2;
        ex = this.canvas.addNode('note', { x: c.x + c.w / 2 + Math.cos(a) * R, y: c.y + c.h / 2 + Math.sin(a) * R * 0.8, w: 340, h: 260, data: { path: note.path } }, { select: false });
      }
      const outgoing = vaultIndex.outgoing(c.data.path).some((n) => n.path === note.path);
      outgoing ? this.canvas.addEdge(c.id, ex.id) : this.canvas.addEdge(ex.id, c.id);
    });
    this.canvas.fit([c.id, ...state.doc.nodes.filter((n) => related.some((r) => r.path === n.data?.path)).map((n) => n.id)]);
  }
  placeNotesGraph(items, links) {
    const c = this.canvas.centerWorld();
    const ids = {};
    for (const it of items) {
      let ex = state.doc.nodes.find((n) => n.type === 'note' && n.data.path === it.path);
      if (!ex) ex = this.canvas.addNode('note', { x: c.x + it.x, y: c.y + it.y, w: 320, h: 240, data: { path: it.path } }, { select: false });
      ids[it.path] = ex.id;
    }
    for (const [a, b] of links) this.canvas.addEdge(ids[a], ids[b]);
    this.canvas.fit(Object.values(ids));
  }

  async chooseVault() {
    const p = await native.dialog.folder('Папка хранилища заметок (можно выбрать хранилище Obsidian)');
    if (!p) return;
    await native.vault.setRoot(p);
    state.setSetting('vaultPath', p);
    await vaultIndex.refresh();
    toast(`Хранилище: ${p}`);
  }



  pickImage(world) {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
    input.onchange = async () => { const w = world || this.canvas.centerWorld(); let i = 0; for (const f of input.files) await imageNodeFromFile(this.canvas, f, { x: w.x + i * 40, y: w.y + i++ * 40 }); };
    input.click();
  }

  // ---------------- canvas events ----------------
  bindCanvas() {
    const cv = this.canvas;
    cv.on('fresh', () => { cv.addNode('hub', { x: 0, y: 0 }, { select: false, checkpoint: false }); });
    cv.on('changed', debounce(() => this.sidebar.renderTree(), 500));
    cv.on('bgMenu', ({ x, y, world }) => {
      menu([
        { label: 'Вставить', icon: 'copy', kbd: 'Ctrl+V', disabled: !cv.clipboard, onClick: () => cv.pastePayload(cv.clipboard, world) },
        '-',
        { label: 'Стикер', icon: 'sticky', kbd: 'S', onClick: () => { const n = cv.addNode('sticky', { x: world.x, y: world.y }); setTimeout(() => cv.views.get(n.id)?.inst?.edit?.(), 30); } },
        { label: 'Текст', icon: 'text', kbd: 'T', onClick: () => { const n = cv.addNode('text', { x: world.x, y: world.y }); setTimeout(() => cv.views.get(n.id)?.inst?.edit?.(), 30); } },
        { label: 'Фигура', icon: 'rect', children: [['rect', 'Прямоугольник'], ['ellipse', 'Эллипс'], ['diamond', 'Ромб']].map(([k, l]) => ({ label: l, icon: k, onClick: () => cv.addNode('shape', { x: world.x, y: world.y, data: { kind: k } }) })) },
        { label: 'Область с названием', icon: 'area', kbd: 'F', onClick: () => cv.addNode('frame', { x: world.x, y: world.y }) },
        { label: 'Заметка', icon: 'note', children: [{ label: 'Новая заметка', icon: 'plus', onClick: () => this.newNoteOnCanvas(world) }, { label: 'Из хранилища…', icon: 'search', onClick: () => this.quickOpen(true, world) }] },
        { label: 'Изображение…', icon: 'image', onClick: () => this.pickImage(world) },
        { label: 'Виджет', icon: 'gallery', children: Object.entries(WIDGETS).map(([k, d]) => ({ label: d.name, icon: d.icon, onClick: () => this.addWidget(k, world) })) },
        { label: 'Шаблон раскладки…', icon: 'squares', onClick: () => openTemplates(cv, { at: world }) },
        '-',
        { label: 'Чат с агентом', icon: 'chat', children: state.settings.agents.filter((a) => a.chat).map((a) => ({ label: a.name, badge: badge(a.mono, a.color, 16, a.dark), onClick: () => this.launchAgentChat({ agentId: a.id, world }) })) },
        { label: 'Агент в терминале', icon: 'terminal', children: state.settings.agents.map((a) => ({ label: a.name, badge: badge(a.mono, a.color, 16, a.dark), onClick: () => this.launchAgent({ agentId: a.id, world }) })) },
        { label: 'API-чат', icon: 'sparkle', children: Object.keys(PROVIDER_META).map((id) => ({ label: providerName(id), badge: badge(PROVIDER_META[id].mono, PROVIDER_META[id].color, 16, PROVIDER_META[id].dark), onClick: () => this.launchChat({ provider: id, world }) })) },
        { label: 'Веб-страница', icon: 'globe', onClick: () => this.launchWeb({ world }) },
        { label: 'Пульт агентов', icon: 'gauge', onClick: () => cv.addNode('hub', { x: world.x, y: world.y }) },
        '-',
        { label: 'Выделить всё', icon: 'cursor', kbd: 'Ctrl+A', onClick: () => cv.select(state.doc.nodes.map((n) => n.id)) },
        { label: 'Показать всё', icon: 'home', kbd: 'Shift+1', onClick: () => cv.fit() },
      ], x, y, { minWidth: 230 });
    });
    cv.on('connectToEmpty', ({ from, world, clientX, clientY }) => {
      menu([
        { header: 'Создать и соединить' },
        { label: 'Стикер', icon: 'sticky', onClick: () => { const n = cv.addNode('sticky', { x: world.x, y: world.y }); cv.addEdge(from.id, n.id); setTimeout(() => cv.views.get(n.id)?.inst?.edit?.(), 30); } },
        { label: 'Новая заметка', icon: 'note', onClick: () => this.newNoteOnCanvas(world, from) },
        { label: 'Чат с агентом', icon: 'chat', children: state.settings.agents.filter((a) => a.chat).map((a) => ({ label: a.name, badge: badge(a.mono, a.color, 16, a.dark), onClick: () => this.launchAgentChat({ agentId: a.id, world, from }) })) },
        { label: 'API-чат', icon: 'sparkle', onClick: () => this.launchChat({ provider: state.settings.defaultProvider || 'openai', world, from }) },
        { label: 'Агент', icon: 'terminal', children: state.settings.agents.map((a) => ({ label: a.name, badge: badge(a.mono, a.color, 16, a.dark), onClick: () => this.launchAgent({ agentId: a.id, world, from }) })) },
        { label: 'Фигура', icon: 'rect', onClick: () => { const n = cv.addNode('shape', { x: world.x, y: world.y }); cv.addEdge(from.id, n.id); } },
      ], clientX, clientY);
    });
    cv.on('editEdge', async (id) => {
      const e = state.doc.edges.find((x) => x.id === id);
      if (!e) return;
      const t = await prompt('Подпись связи', e.label || '');
      if (t == null) return;
      cv.checkpoint(); e.label = t; cv.renderEdges(); cv.changed();
    });
    cv.on('drop', (e) => this.onDrop(e));
    cv.on('widgets', () => this.widgetPicker());
    cv.on('saveTemplate', () => saveTemplate(cv));
    cv.on('dropToChat', ({ chatId, nodes }) => this.attachImagesToChat(chatId, nodes));
    document.addEventListener('paste', (e) => this.onPaste(e));
  }

  async onDrop(e) {
    e.preventDefault();
    const world = this.canvas.toWorld(e.clientX, e.clientY);
    let notePaths = [];
    try { notePaths = JSON.parse(e.dataTransfer.getData('application/x-vibetabula-notes') || '[]'); } catch {}
    if (notePaths.length > 1) { this.addNotesToCanvas(notePaths, world); return; }
    const notePath = e.dataTransfer.getData('application/x-vibetabula-note');
    if (notePath) { this.addNoteToCanvas(notePath, world); return; }
    const files = [...e.dataTransfer.files];
    if (files.length) {
      let i = 0;
      for (const f of files) {
        const at = { x: world.x + i * 30, y: world.y + i * 30 }; i++;
        if (f.type.startsWith('image/')) await imageNodeFromFile(this.canvas, f, at);
        else if (/\.(md|markdown|txt)$/i.test(f.name)) {
          const text = await f.text();
          const p = await native.vault.create('', f.name.replace(/\.(md|markdown|txt)$/i, ''), text);
          await vaultIndex.refresh();
          this.canvas.addNode('note', { ...at, data: { path: p } });
        } else toast(`Неподдерживаемый файл: ${f.name}`, 'warn');
      }
      return;
    }
    const url = e.dataTransfer.getData('text/uri-list');
    if (url) { this.canvas.addNode('web', { x: world.x, y: world.y, data: { url: url.split('\n')[0] } }); return; }
    const text = e.dataTransfer.getData('text/plain');
    if (text) this.canvas.addNode('sticky', { x: world.x, y: world.y, data: { text } });
  }

  async onPaste(e) {
    if (e.defaultPrevented || document.querySelector('.modal-back')) return;
    const cd = e.clipboardData;
    // a chat window is selected (or has the focus, but not in its input): a picture or file goes
    // to its attachments and text into its input — not onto the canvas next to it
    const chat = this.pasteChatTarget();
    const ae = document.activeElement;
    if (chat && (!isEditable(ae) || chat.root.contains(ae))) {
      const files = clipboardFiles(cd);
      if (files.length) { e.preventDefault(); chat.attach.addFiles(files); chat.input.focus(); return; }
      const t = cd.getData('text/plain');
      if (t && !isEditable(ae) && !/^\{"(vibetabula|canvastty)"/.test(t)) { e.preventDefault(); chat.input.focus(); document.execCommand('insertText', false, t); return; }
    }
    if (isEditable(ae)) return;
    const text = cd.getData('text/plain');
    const world = this.canvas.lastPointer && this.pointerInCanvas() ? this.canvas.toWorld(this.canvas.lastPointer.x, this.canvas.lastPointer.y) : this.canvas.centerWorld();
    if (text && (text.startsWith('{"vibetabula"') || text.startsWith('{"canvastty"'))) { try { e.preventDefault(); this.canvas.pastePayload(JSON.parse(text), { x: world.x, y: world.y }); return; } catch {} }
    const img = [...cd.items].find((i) => i.type.startsWith('image/'));
    if (img) { e.preventDefault(); await imageNodeFromFile(this.canvas, img.getAsFile(), world); return; }
    if (text) {
      e.preventDefault();
      if (/^https?:\/\/\S+$/.test(text.trim())) this.canvas.addNode('web', { x: world.x, y: world.y, data: { url: text.trim() } });
      else if (text.length > 400 || /^#|\n#{1,3} |\n- /.test(text)) {
        const title = (text.match(/^#\s+(.+)$/m)?.[1] || text.split('\n')[0]).slice(0, 50).replace(/[#*_`]/g, '').trim() || 'Вставка';
        const p = await native.vault.create('', title, text);
        await vaultIndex.refresh();
        this.canvas.addNode('note', { x: world.x, y: world.y, data: { path: p } });
      } else this.canvas.addNode('sticky', { x: world.x, y: world.y, data: { text } });
    }
  }
  // pictures from the canvas → attachments of a chat window (dragged onto it)
  async attachImagesToChat(chatId, nodes) {
    const inst = this.canvas.views.get(chatId)?.inst;
    if (!inst?.attach) return;
    const files = [];
    for (const n of nodes) {
      try {
        const url = n.data.vault ? await native.vault.readAsset(n.data.vault) : n.data.src;
        if (!url) continue;
        const blob = await (await fetch(url)).blob();
        const base = (n.data.name || (n.data.vault || '').split('/').pop() || 'Изображение').replace(/[\\/:*?"<>|]/g, '_');
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        files.push(new File([blob], /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`, { type: blob.type || 'image/png' }));
      } catch (e) { toast(`Не удалось приложить картинку: ${e.message || e}`, 'error'); }
    }
    if (!files.length) return;
    this.canvas.select([chatId]);
    await inst.attach.addFiles(files);
    inst.input.focus();
  }
  pasteChatTarget() {
    const inst = (id) => { const n = id && this.canvas.node(id); const i = n && (n.type === 'chat' || n.type === 'agentchat') ? this.canvas.views.get(id)?.inst : null; return i?.attach && i.input ? i : null; };
    return inst(document.activeElement?.closest?.('.node')?.dataset.id) || (this.canvas.selection.size === 1 ? inst([...this.canvas.selection][0]) : null);
  }
  pointerInCanvas() { const r = this.canvas.rect(); const p = this.canvas.lastPointer; return p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom; }

  bindBus() {
    bus.on('launchAgent', (o) => this.launchAgent(o));
    bus.on('pet:changed', () => this.updatePet());
    bus.on('openPetPicker', () => openPetPicker());
    bus.on('openPetCatalog', () => openPetCatalog());
    bus.on('agentMenu', ({ agentId, x, y, near }) => this.agentMenu(agentId, x, y, near));
    bus.on('launchChatMenu', ({ near, x, y }) => menu(Object.keys(PROVIDER_META).map((id) => ({ label: providerName(id), badge: badge(PROVIDER_META[id].mono, PROVIDER_META[id].color, 16, PROVIDER_META[id].dark), onClick: () => this.launchChat({ provider: id, near }) })), x, y - 280));
    bus.on('launchWeb', (o) => this.launchWeb(o));
    bus.on('openSettings', (tab, anchor) => this.openSettings(tab || 'general', anchor));
    bus.on('openNotePath', (p) => this.openNote(p));
    bus.on('searchTag', (t) => this.sidebar.filterByTag(t));
    bus.on('expandNote', (id) => this.expandNote(id));
    bus.on('showLimits', (anchor) => this.showLimits(anchor));
  }

  showLimits(anchor) {
    const r = anchor.getBoundingClientRect();
    const p = limitsPanel();
    const pop = h('div', { class: 'popover' }, p.el);
    document.body.append(pop);
    const pr = pop.getBoundingClientRect();
    pop.style.left = `${Math.min(innerWidth - pr.width - 10, Math.max(10, r.left + r.width / 2 - pr.width / 2))}px`;
    pop.style.top = `${r.bottom + pr.height + 8 > innerHeight ? Math.max(10, r.top - pr.height - 8) : r.bottom + 8}px`;
    const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); p.destroy(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
    limits.refresh();
  }

  // ---------------- keyboard ----------------
  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-back')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = keyName(e);
      if (mod && k === 'p') { e.preventDefault(); this.palette(); return; }
      if (mod && e.shiftKey && k === 'f') { e.preventDefault(); toggleFpsMeter(); return; }
      if (mod && k === 'o') { e.preventDefault(); this.quickOpen(false); return; }
      if (mod && k === 'n') { e.preventDefault(); this.sidebar.newNote(); return; }
      if (mod && k === '\\') { e.preventDefault(); this.toggleSidebar(); return; }
      if (mod && k === '`') { e.preventDefault(); this.launchAgent({ agentId: 'shell' }); return; }
      if (mod && k === ',') { e.preventDefault(); this.openSettings(); return; }
      if (e.key === 'F1') { e.preventDefault(); this.openHelp(); return; }
      if (mod && k === 's') { e.preventDefault(); state.saveDoc.flush(); toast('Сохранено'); return; }
      this.canvas.handleKey(e);
    });
  }

  // ---------------- command palette / quick open ----------------
  palette(initial = '') {
    const cmds = [
      ...state.settings.agents.filter((a) => a.chat).map((a) => ({ label: `${a.name} — окно чата`, hint: 'по подписке', badge: badge(a.mono, a.color, 16, a.dark), run: () => this.launchAgentChat({ agentId: a.id }) })),
      ...state.settings.agents.map((a) => ({ label: `${a.name} — терминал`, hint: a.cmd || 'shell', badge: badge(a.mono, a.color, 16, a.dark), run: () => this.launchAgent({ agentId: a.id }) })),
      ...Object.keys(PROVIDER_META).map((id) => ({ label: `Чат: ${providerName(id)}`, hint: 'API', badge: badge(PROVIDER_META[id].mono, PROVIDER_META[id].color, 16, PROVIDER_META[id].dark), run: () => this.launchChat({ provider: id }) })),
      { label: 'Новая заметка', icon: 'plus', hint: 'Ctrl+N', run: () => this.sidebar.newNote() },
      { label: 'Новая заметка на canvas', icon: 'note', run: () => this.newNoteOnCanvas() },
      { label: 'Граф заметок', icon: 'graph', run: () => openGraph(this) },
      { label: 'Новый canvas', icon: 'grid', run: async () => { const n = await prompt('Название canvas', ''); if (n) state.createCanvas(state.project.id, n); } },
      { label: 'Новый проект', icon: 'folder', run: () => this.projectDialog() },
      { label: 'Пульт агентов на canvas', icon: 'gauge', run: () => this.canvas.addNode('hub', {}) },
      { label: 'Показать всё', icon: 'home', hint: 'Shift+1', run: () => this.canvas.fit() },
      { label: 'Лимиты нейросетей', icon: 'gauge', run: () => this.showLimits(this.limitsBtn) },
      { label: 'Ждут вас — агенты, которые закончили', icon: 'bell', run: () => this.showInbox(this.inboxBtn) },
      { label: 'Спросить нескольких агентов…', icon: 'chat', run: async () => { const { openAskMany } = await import('./askmany.js'); openAskMany(this.canvas, {}); } },
      { label: 'Шаблоны раскладки…', icon: 'squares', run: () => openTemplates(this.canvas) },
      { label: 'Сохранить выделенное как шаблон…', icon: 'squares', run: () => saveTemplate(this.canvas) },
      ...allTemplates().map((t) => ({ label: `Шаблон: ${t.name}`, hint: t.builtIn ? 'встроенный' : 'ваш', icon: 'squares', run: () => placeTemplate(this.canvas, t) })),
      { label: 'Настройки', icon: 'settings', hint: 'Ctrl+,', run: () => this.openSettings() },
      { label: 'Сменить питомца', icon: 'refresh', run: () => openPetPicker() },
      { label: 'Каталог Codex Pets', icon: 'globe', hint: 'codex-pets.net', run: () => openPetCatalog() },
      { label: 'Тест плавности (FPS)', icon: 'gauge', run: () => runPerfTest(this) },
      { label: 'Показать / скрыть счётчик FPS', icon: 'gauge', hint: 'Ctrl+Shift+F', run: () => toggleFpsMeter() },
      { label: 'Выбрать хранилище заметок', icon: 'folderOpen', run: () => this.chooseVault() },
      ...state.ws.projects.flatMap((p) => p.canvases.map((c) => ({ label: `${p.name} / ${c.name}`, hint: 'canvas', icon: 'grid', run: () => state.openCanvas(p.id, c.id) }))),
      ...vaultIndex.notes.map((n) => ({ label: n.name, hint: n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : 'заметка', icon: 'file', run: () => this.openNote(n.path) })),
    ];
    this.picker('Команда, заметка или canvas…', cmds, initial);
  }
  quickOpen(toCanvas, world) {
    const items = [...vaultIndex.notes].sort((a, b) => b.mtime - a.mtime).map((n) => ({ label: n.name, hint: n.path, icon: 'file', run: () => (toCanvas ? this.addNoteToCanvas(n.path, world) : this.openNote(n.path)) }));
    this.picker(toCanvas ? 'Вывести заметку на canvas…' : 'Открыть заметку…', items, '', async (q) => {
      if (!q) return;
      const p = await native.vault.create('', q, '');
      await vaultIndex.refresh();
      toCanvas ? this.addNoteToCanvas(p, world) : this.openNote(p, { focus: true });
    });
  }
  picker(placeholder, items, initial = '', onCreate) {
    const input = h('input', { class: 'input palette-input', placeholder, value: initial });
    const list = h('div', { class: 'palette-list' });
    const m = modal({ title: '', body: h('div', {}, input, list), width: 620, className: 'palette' });
    let idx = 0, shown = [];
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = (q ? items.filter((it) => it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q)).sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q)) : items).slice(0, 60);
      if (onCreate && q && !items.some((i) => i.label.toLowerCase() === q)) shown.push({ label: `Создать заметку «${input.value.trim()}»`, icon: 'plus', run: () => onCreate(input.value.trim()) });
      idx = Math.min(idx, Math.max(0, shown.length - 1));
      list.innerHTML = '';
      shown.forEach((it, i) => {
        const ic = h('span', { class: 'pl-ic' });
        if (it.badge) ic.append(it.badge); else ic.innerHTML = icon(it.icon || 'chevronRight', 15);
        const row = h('div', { class: `pl-row${i === idx ? ' active' : ''}`, onclick: () => { m.close(); it.run(); } }, ic, h('span', { class: 'pl-label' }, it.label), h('span', { class: 'pl-hint' }, it.hint || ''));
        list.append(row);
      });
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { idx = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(shown.length - 1, idx + 1); render(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); render(); }
      if (e.key === 'Enter') { e.preventDefault(); const it = shown[idx]; if (it) { m.close(); it.run(); } }
    });
    render();
    setTimeout(() => input.focus(), 30);
  }

  // ---------------- settings ----------------
  openSettings(tab = 'general', anchor = null) {
    const s = state.settings;
    const tabs = [['general', 'Общие'], ['agents', 'Агенты'], ['providers', 'API-провайдеры'], ['limits', 'Лимиты'], ['sync', 'Синхронизация'], ['keys', 'Горячие клавиши']];
    const nav = h('div', { class: 'set-nav' });
    const pane = h('div', { class: 'set-pane' });
    const body = h('div', { class: 'settings' }, nav, pane);
    const show = (id) => {
      nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      pane.innerHTML = '';
      pane.append(this[`settings_${id}`](s));
    };
    for (const [id, l] of tabs) nav.append(h('button', { 'data-id': id, onclick: () => show(id) }, l));
    modal({ title: 'Настройки', body, width: 'min(860px, 94vw)', className: 'settings-modal', onClose: () => { state.saveWs(); state.emit('settings', 'all'); limits.refresh(); } });
    show(tab);
    if (anchor) requestAnimationFrame(() => pane.querySelector(`[data-anchor="${anchor}"]`)?.scrollIntoView({ block: 'start' }));
  }

  settings_general(s) {
    const row = (label, ctrl, hint) => h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-label' }, label), hint ? h('div', { class: 'muted small' }, hint) : null), ctrl);
    const toggle = (key) => { const i = h('input', { type: 'checkbox', class: 'switch' }); i.checked = !!s[key]; i.onchange = () => { state.setSetting(key, i.checked); this.canvas.applyViewport(); if (key === 'pet') this.updatePet(); }; return i; };
    const wheel = h('select', { class: 'select' }, h('option', { value: 'zoom' }, 'Масштаб'), h('option', { value: 'scroll' }, 'Прокрутка'));
    wheel.value = s.wheel; wheel.onchange = () => state.setSetting('wheel', wheel.value);
    // zoom threshold slider with its value in percent
    const zoomSlider = (key, min, def) => {
      const out = h('span', { class: 'muted small range-val' });
      const show = () => { out.textContent = `${Math.round(+i.value * 100)} %`; };
      const i = h('input', { type: 'range', min: String(min), max: '0.9', step: '0.05', value: s[key] || def });
      i.oninput = () => { state.setSetting(key, +i.value); show(); this.canvas.resetLod(); };
      show();
      return h('div', { class: 'row range-row' }, i, out);
    };
    const lod = zoomSlider('lodZoom', 0.2, 0.3), chatLod = zoomSlider('chatLodZoom', 0.1, 0.2);
    const vault = h('div', { class: 'row' }, h('code', { class: 'path' }, vaultIndex.root || s.vaultPath || ''), h('button', { class: 'btn', onclick: async () => { await this.chooseVault(); vault.querySelector('code').textContent = vaultIndex.root; } }, 'Изменить…'));
    const theme = h('select', { class: 'select' }, h('option', { value: 'dark' }, 'Тёмная'), h('option', { value: 'light' }, 'Светлая'), h('option', { value: 'system' }, 'Как в системе'));
    theme.value = s.theme || 'dark'; theme.onchange = () => { state.setSetting('theme', theme.value); this.applyTheme(); };
    const petBtn = h('button', { class: 'btn', onclick: () => openPetPicker() }, 'Выбрать питомца…');
    const mm = h('input', { type: 'checkbox', class: 'switch' }); mm.checked = s.minimap !== false;
    mm.onchange = () => { state.setSetting('minimap', mm.checked); this.canvas.applyMinimapSetting(); };
    return h('div', {},
      h('h3', {}, 'Вид'),
      row('Тема', theme),
      row('Миникарта', mm, 'Также кнопка с картой у масштаба или клавиша M'),
      h('h3', {}, 'Canvas'),
      row('Колесо мыши', wheel, 'Ctrl + колесо всегда масштабирует, Shift + колесо — горизонтальная прокрутка'),
      row('Сетка из точек', toggle('grid')),
      row('Привязка к сетке', toggle('snap'), 'Умные направляющие работают всегда. Alt — временно без привязки'),
      row('Карточки при отдалении', lod, 'Ниже какого масштаба окна (заметки, терминалы, браузер) заменяются компактными карточками. Левее — окна видны дальше, правее — быстрее при большом количестве окон'),
      row('Чаты нейросетей при отдалении', chatLod, 'Чаты с агентами и API-чаты остаются полными окнами до этого масштаба, даже когда остальные окна уже карточки'),
      h('h3', { 'data-anchor': 'clock' }, 'Часы в пульте'),
      this.clockSettings(s),
      row('Питомец', petBtn, 'Готовые питомцы или своя картинка. Также: ПКМ по питомцу в пульте'),
      row('Питомец на экране', toggle('pet'), 'Встроенные питомцы бегают за курсором, питомцы Codex сидят в углу и показывают, что делают агенты'),
      h('h3', {}, 'Производительность'),
      row('Счётчик FPS', (() => { const i = h('input', { type: 'checkbox', class: 'switch' }); i.checked = !!s.fps; i.onchange = () => { state.setSetting('fps', i.checked); setFpsMeter(i.checked); }; return i; })(), 'Также Ctrl+Shift+F'),
      row('Тест плавности', h('button', { class: 'btn', onclick: () => { document.querySelector('.modal-back')?.remove(); runPerfTest(this); } }, 'Запустить'), 'Canvas сам подвигается 10 секунд и покажет FPS, видеокарту и экран'),
      h('h3', {}, 'Заметки'),
      row('Хранилище (папка с .md)', vault, 'Можно указать существующее хранилище Obsidian'),
    );
  }

  // ---------------- sync between computers ----------------
  bindSync() {
    if (!native.sync) return;
    let lastToast = 0;
    native.sync.onChanged(async (ev) => {
      if (ev.kind === 'chat') return; // the history panel reads fresh data when opened
      const busy = (what) => (what === 'drag' ? !!this.canvas.dragging : [...this.canvas.views.values()].some((v) => v.inst?.isBusy?.()));
      const applied = await state.applyRemote(ev, busy);
      if (!applied) return;
      if (ev.kind === 'workspace') { this.applyTheme(); this.canvas.applyMinimapSetting(); this.renderTabs(); }
      if (Date.now() - lastToast > 8000) { lastToast = Date.now(); toast(`Синхронизировано с «${ev.from || 'другим устройством'}»`); }
    });
    state.on('docMerged', () => { this.canvas.renderAll(); this.canvas.recomputeGroups(); });
    native.sync.ready?.();
  }

  settings_sync() {
    const box = h('div', {});
    const render = async () => {
      const info = await native.sync.info();
      const st = info.status || {};
      const row = (label, ctrl, hint) => h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-label' }, label), hint ? h('div', { class: 'muted small' }, hint) : null), ctrl);
      const pick = async () => { const d = await native.dialog.folder('Папка для синхронизации (в iCloud Drive, Dropbox, Google Drive, OneDrive…)'); if (d) { await native.sync.configure({ dir: d, enabled: true }); render(); } };
      const onT = h('input', { type: 'checkbox', class: 'switch' }); onT.checked = !!info.enabled;
      onT.onchange = async () => { if (onT.checked && !info.dir) { onT.checked = false; return pick(); } await native.sync.configure({ enabled: onT.checked }); render(); };
      const keysT = h('input', { type: 'checkbox', class: 'switch' }); keysT.checked = !!info.keys;
      keysT.onchange = async () => { await native.sync.configure({ keys: keysT.checked }); render(); };
      const stateText = !info.enabled ? 'выключена' : st.state === 'error' ? `ошибка: ${st.error}` : st.last ? `работает, последняя проверка ${new Date(st.last).toLocaleTimeString('ru-RU')}` : 'запускается…';
      const inVault = info.root && (state.settings.vaultPath || '').replace(/\\/g, '/').startsWith(info.root.replace(/\\/g, '/'));
      box.replaceChildren(
        h('p', { class: 'muted' }, 'Проекты, canvas, окна и история чатов синхронизируются между компьютерами через общую папку: iCloud Drive, Dropbox, Google Drive, OneDrive, Яндекс Диск или Syncthing. Сервер и регистрация не нужны: выберите одну и ту же облачную папку на каждом компьютере. Правки с разных компьютеров объединяются: если меняли разные объекты, сохранятся все, если один и тот же — более позднее изменение.'),
        row('Синхронизация', onT, `Это устройство: ${info.device}`),
        row('Папка', h('div', { class: 'row' }, h('code', { class: 'path' }, info.root || 'не выбрана'), h('button', { class: 'btn', onclick: pick }, info.dir ? 'Изменить…' : 'Выбрать…')),
          'Например: Windows — C:\\Users\\вы\\iCloudDrive или папка Dropbox; macOS — iCloud Drive (~/Library/Mobile Documents/com~apple~CloudDocs).'),
        row('Состояние', h('div', { class: 'row' }, h('span', { class: st.state === 'error' ? 'perf-warn' : 'muted' }, stateText),
          info.enabled ? h('button', { class: 'btn', onclick: async () => { await native.sync.now(); render(); toast('Синхронизировано'); } }, 'Сейчас') : null),
          info.enabled ? `Отправлено изменений: ${st.pushed || 0}, получено: ${st.pulled || 0}` : null),
        row('Заметки', inVault ? h('span', { class: 'muted' }, 'хранятся в папке синхронизации') : h('button', { class: 'btn', disabled: !info.dir, onclick: async () => {
          const dest = await native.sync.adoptVault(); state.setSetting('vaultPath', dest); await vaultIndex.refresh(); this.sidebar?.refresh?.(); toast('Заметки теперь в папке синхронизации'); render();
        } }, 'Перенести в папку синхронизации'), 'Заметки — обычные .md файлы, облако синхронизирует их само. Существующие заметки будут скопированы.'),
        row('API-ключи', keysT, 'По умолчанию ключи остаются только на этом компьютере. Включайте, только если доверяете облачной папке.'),
      );
    };
    render();
    const off = native.sync.onStatus?.(() => { if (box.isConnected) render(); else off?.(); });
    return box;
  }

  clockSettings(s) {
    const wrap = h('div', { class: 'clock-set' });
    const col = (theme) => {
      const key = theme === 'light' ? 'clockLight' : 'clockDark';
      const ckey = theme === 'light' ? 'clockCustomLight' : 'clockCustomDark';
      const box = h('div', { class: 'clock-col' });
      const sel = h('select', { class: 'select sm' }, ...Object.entries(CLOCK_PRESETS).map(([id, c]) => h('option', { value: id }, c.name)), h('option', { value: 'custom' }, 'Свои цвета'));
      sel.value = s[key] || CLOCK_DEFAULT[theme];
      const prev = h('div', { class: 'sb-preview', html: clockMarkup('19', '08', theme === 'light' ? 'Светлая тема' : 'Тёмная тема') });
      const picks = h('div', { class: 'clock-picks' });
      const paint = () => {
        const c = clockColors(theme);
        paintClock(prev, c);
        picks.style.display = sel.value === 'custom' ? '' : 'none';
        picks.replaceChildren(...[['bg', 'Фон'], ['d0', 'Цифра 1'], ['d1', 'Цифра 2'], ['d2', 'Цифра 3'], ['d3', 'Цифра 4'], ['colon', 'Точки'], ['date', 'Дата']].map(([k, label]) => {
          const val = k.startsWith('d') && k.length === 2 ? c.d[+k[1]] : c[k];
          const inp = h('input', { type: 'color', value: val });
          inp.oninput = () => {
            const cur = { ...clockColors(theme) }; delete cur.blend; delete cur.name;
            if (k.length === 2 && k.startsWith('d')) { cur.d = [...cur.d]; cur.d[+k[1]] = inp.value; } else cur[k] = inp.value;
            state.setSetting(ckey, cur);
            paintClock(prev, clockColors(theme));
          };
          return h('label', { class: 'clock-pick' }, inp, label);
        }));
      };
      sel.onchange = () => {
        if (sel.value === 'custom' && !s[ckey]) { const base = { ...clockColors(theme) }; delete base.blend; delete base.name; state.setSetting(ckey, base); }
        state.setSetting(key, sel.value); paint();
      };
      paint();
      box.append(h('div', { class: 'clock-col-head' }, h('span', {}, theme === 'light' ? 'Светлая тема' : 'Тёмная тема'), sel), prev, picks);
      return box;
    };
    wrap.append(col('dark'), col('light'));
    return h('div', {}, wrap, h('div', { class: 'muted small' }, 'Также ПКМ по часам в пульте. В «Свои цвета» можно задать фон, каждую цифру, точки и дату.'));
  }

  settings_agents(s) {
    const wrap = h('div', {});
    // commands typed here on this computer are allowed to run without asking (synced changes are asked about)
    const trustAgent = (a) => native.trust?.add([[a.cmd, a.args].filter(Boolean).join(' '), [a.cmd, a.resumeArgs].filter(Boolean).join(' '), a.cmd ? `agentchat:${a.cmd}` : ''].filter(Boolean));
    const render = () => {
      wrap.innerHTML = '';
      wrap.append(h('p', { class: 'muted' }, 'Агенты запускаются в терминале внутри окна на canvas, в рабочей папке проекта. На Windows команда выполняется через PowerShell, поэтому подходят npm-команды вроде codex, claude, gemini.'));
      for (const a of s.agents) {
        const f = (key, ph, w) => { const i = h('input', { class: 'input sm', value: a[key] || '', placeholder: ph, style: { width: w } }); i.onchange = () => { a[key] = i.value; if (['cmd', 'args', 'resumeArgs'].includes(key)) trustAgent(a); state.saveWs(); state.emit('settings', 'agents'); if (key === 'mono' || key === 'color') render(); }; return i; };
        // the badge colour: the Apple colour window (system colours, Spectrum, eyedropper, HEX)
        const bdg = badge(a.mono || '?', a.color, 26, a.dark);
        const color = swatch(a.color || '#007aff', false, () => {}, 'Цвет значка');
        color.classList.add('agent-color');
        color.onclick = (e) => { e.stopPropagation(); let changed = false; openColorPicker(color, a.color || '#007aff', (v) => { a.color = toHex(v); changed = true; bdg.style.setProperty('--b', a.color); color.firstChild.style.background = a.color; state.saveWs(); }, { above: false, onClose: () => { if (changed) { state.emit('settings', 'agents'); render(); } } }); };
        const check = h('span', { class: 'muted small agent-check' }, '');
        if (a.cmd) native.pty.which(a.cmd).then((p) => { check.textContent = p ? '✓ найден' : '✗ не найден'; check.className = `small agent-check ${p ? 'ok' : 'bad'}`; check.title = p || a.install || ''; });
        wrap.append(h('div', { class: 'agent-row' },
          bdg, f('name', 'Название', '130px'), f('cmd', 'команда', '110px'), f('args', 'аргументы', '120px'), f('resumeArgs', 'продолжить', '110px'), f('mono', 'Аб', '44px'), color, check,
          h('button', { class: 'icon-btn sm', title: a.hidden ? 'Показать в доке' : 'Скрыть из дока', html: icon(a.hidden ? 'unlock' : 'lock', 13), onclick: () => { a.hidden = !a.hidden; state.saveWs(); state.emit('settings', 'agents'); render(); } }),
          !DEFAULT_AGENTS.find((d) => d.id === a.id) ? h('button', { class: 'icon-btn sm danger', title: 'Удалить', html: icon('trash', 13), onclick: () => { s.agents = s.agents.filter((x) => x !== a); state.saveWs(); state.emit('settings', 'agents'); render(); } }) : h('span', { style: { width: '26px' } }),
        ));
      }
      wrap.append(h('button', { class: 'btn', onclick: () => { s.agents.push({ id: `custom_${Date.now().toString(36)}`, name: 'Мой агент', cmd: '', args: '', mono: 'A', color: '#34c759' }); state.saveWs(); render(); } }, '+ Добавить агента'));
      // chat windows: the agent keeps answering when the app is closed (main/agent-runner.js)
      const keep = h('input', { type: 'checkbox', class: 'switch' }); keep.checked = s.agentsKeepRunning !== false;
      keep.onchange = () => state.setSetting('agentsKeepRunning', keep.checked);
      const notify = h('input', { type: 'checkbox', class: 'switch' }); notify.checked = s.notifyAgents !== false;
      notify.onchange = () => state.setSetting('notifyAgents', notify.checked);
      // the agents see and add to the canvas of their window (renderer/js/canvasTools.js)
      const tools = h('input', { type: 'checkbox', class: 'switch' }); tools.checked = s.canvasTools !== false;
      tools.onchange = () => state.setSetting('canvasTools', tools.checked);
      wrap.append(h('h3', {}, 'Окна чатов с агентами'),
        h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-label' }, 'Уведомлять, когда агент закончил'),
          h('div', { class: 'muted small' }, 'Системное уведомление и мигающая кнопка на панели задач, если VibeTabula не в фокусе. Список таких чатов — колокольчик «Ждут вас» вверху.')), notify),
        h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-label' }, 'Агент продолжает работать после закрытия приложения'),
          h('div', { class: 'muted small' }, 'Ответ дописывается в фоне и появляется в окне чата при следующем запуске. Если выключить, закрытие приложения останавливает агента, а в чате появляется кнопка «Продолжить».')), keep),
        h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-label' }, 'Инструменты холста для агентов'),
          h('div', { class: 'muted small' }, 'Агент видит объекты холста своего окна и может добавить рядом стикеры, заметки, текст, области и стрелки — например разложить план по шагам. Менять он может только то, что добавил сам, удалять — ничего; всё добавленное за один ответ убирается одним Ctrl+Z. Действует со следующего сообщения.')), tools));
    };
    render();
    return wrap;
  }

  settings_providers(s) {
    const wrap = h('div', {});
    s.providers = s.providers || {};
    const def = h('select', { class: 'select' }, ...Object.keys(PROVIDER_META).map((id) => h('option', { value: id }, providerName(id))));
    def.value = s.defaultProvider || 'openai';
    def.onchange = () => state.setSetting('defaultProvider', def.value);
    wrap.append(h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, 'Провайдер по умолчанию'), def));
    wrap.append(h('p', { class: 'muted small' }, 'Ключи хранятся локально в файле настроек приложения. «Суточный бюджет» — сколько токенов в день показывать как 100% в виджете лимитов.'));
    native.chat.providers().then((P) => {
      for (const [id, p] of Object.entries(P)) {
        const cfg = s.providers[id] = s.providers[id] || {};
        const m = PROVIDER_META[id] || PROVIDER_META.custom;
        const inp = (key, ph, type = 'text') => { const i = h('input', { class: 'input sm', type, value: cfg[key] || '', placeholder: ph }); i.onchange = () => { cfg[key] = i.value.trim(); state.saveWs(); }; return i; };
        wrap.append(h('div', { class: 'prov-card' },
          h('div', { class: 'prov-head' }, badge(m.mono, m.color, 22, m.dark), h('b', {}, p.name)),
          h('div', { class: 'prov-grid' },
            h('label', {}, 'API-ключ'), p.noKey ? h('span', { class: 'muted small' }, 'не требуется') : inp('key', 'sk-…', 'password'),
            h('label', {}, 'Базовый URL'), inp('baseUrl', p.baseUrl || ''),
            h('label', {}, 'Модель'), inp('model', p.model || ''),
            h('label', {}, 'Суточный бюджет, ток.'), inp('dailyBudget', 'например 200000'),
          )));
      }
    });
    return wrap;
  }

  settings_limits(s) {
    const wrap = h('div', {});
    wrap.append(h('p', { class: 'muted' }, 'Какие лимиты показывать в пульте на canvas (до 4). Полный список — по кнопке ⌁ в заголовке.'));
    const rows = new Set(s.limitRows || []);
    for (const [k, v] of Object.entries(LIMIT_SOURCES)) {
      const c = h('input', { type: 'checkbox', class: 'switch' }); c.checked = rows.has(k);
      c.onchange = () => { c.checked ? rows.add(k) : rows.delete(k); state.setSetting('limitRows', [...rows]); };
      wrap.append(h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, v.name), c));
    }
    return wrap;
  }

  settings_keys() {
    const keys = [
      ['V / H', 'Выделение / рука'], ['Пробел + тянуть, средняя кнопка', 'Перемещение по canvas'], ['Колесо, Ctrl + колесо', 'Масштаб'],
      ['S, T, R, O, F, A', 'Стикер, текст, прямоугольник, эллипс, область, стрелка'], ['W', 'Виджеты'],
      ['Shift + клик, рамка', 'Множественное выделение'], ['Shift при перемещении', 'Только по оси'], ['Alt при перемещении', 'Без привязки'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+C / X / V / D', 'Копировать / вырезать / вставить / дублировать'],
      ['Ctrl+G', 'Сгруппировать в область'], ['Ctrl+L', 'Закрепить'], ['[ / ]', 'Назад / вперёд по слоям'], ['Стрелки (+Shift)', 'Сдвиг на 1 (10) px'],
      ['Shift+1 / Shift+2 / Shift+0', 'Показать всё / выделенное / 100%'], ['Ctrl+P (в терминале Ctrl+Shift+P)', 'Палитра команд'], ['Ctrl+O / Ctrl+Shift+O', 'Открыть заметку'], ['Ctrl+N / Ctrl+Shift+N', 'Новая заметка'],
      ['Ctrl+`', 'Новый терминал'], ['Ctrl+\\', 'Боковая панель'], ['M', 'Скрыть / показать миникарту'], ['Ctrl+Shift+F', 'Счётчик FPS'], ['F1', 'Инструкция'], ['Ctrl+K (в заметке)', 'Ссылка'], ['[[ (в заметке)', 'Ссылка на заметку с автодополнением'],
      ['Ctrl+Shift+L (в заметке)', 'Чек-лист'], ['# , - , 1. , [] , > (в заметке)', 'Markdown-сокращения'],
    ];
    return h('div', { class: 'keys' }, ...keys.map(([k, d]) => h('div', { class: 'key-row' }, h('kbd', {}, k), h('span', {}, d))));
  }

  // ---------------- cat companion ----------------
  refreshPet() { this.updatePet(); }
  // built-in pets follow the cursor; Codex pets sit on the canvas like in the Codex app
  updatePet() {
    if (!this.pet) return;
    const cp = codexPetFor(state.settings.petKind);
    const on = state.settings.pet !== false;
    this.followerOn = on && !cp;
    if (cp && on) {
      this.pet.style.display = 'none';
      if (!this.companion || this.companion.pet.url !== cp.url) { this.companion?.destroy(); this.companion = new Companion(this, cp); }
    } else {
      this.companion?.destroy(); this.companion = null;
      this.pet.style.display = on ? '' : 'none';
      this.pet.innerHTML = petSvg('idle');
    }
  }
  startPet() {
    const pet = h('div', { class: 'pet-follower', html: petSvg('idle') });
    this.pet = pet;
    this.canvasHost.append(pet);
    if (!state.settings.pet) pet.style.display = 'none';
    let tx = 200, ty = 200, x = 200, y = 200, last = Date.now(), raf = 0, walking = false, sleeping = false, flip = 1;
    const setCls = (w, sl) => {
      if (w !== walking) { walking = w; pet.classList.toggle('walking', w); }
      if (sl !== sleeping) { sleeping = sl; pet.classList.toggle('sleeping', sl); }
    };
    const step = () => {
      raf = 0;
      const dx = tx - x, dy = ty - y;
      const d = Math.hypot(dx, dy);
      if (d > 2) { const sp = Math.min(d, 2.2 + d * 0.04); x += (dx / d) * sp; y += (dy / d) * sp; if (Math.abs(dx) > 1) flip = dx < 0 ? -1 : 1; }
      pet.style.transform = `translate3d(${x}px, ${y}px, 0) scaleX(${flip})`;
      setCls(d > 4, false);
      if (d > 2) raf = requestAnimationFrame(step); // stop the loop once the pet has arrived
    };
    this.followerOn = !!state.settings.pet;
    this.canvasHost.addEventListener('pointermove', (e) => {
      if (!this.followerOn) return;
      const r = this.canvasHost.getBoundingClientRect();
      tx = e.clientX - r.left + 14; ty = e.clientY - r.top + 16; last = Date.now();
      if (!raf) raf = requestAnimationFrame(step);
    }, { passive: true });
    setInterval(() => setCls(walking, Date.now() - last > 15000), 5000);
    step();
  }
}

const app = new App();
window.__app = app;
app.start().catch((e) => {
  console.error(e);
  document.getElementById('boot').innerHTML = `<div style="padding:40px;color:#f88;font-family:monospace;white-space:pre-wrap">Ошибка запуска:\n${esc(e.stack || e.message)}</div>`;
});

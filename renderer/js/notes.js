// Obsidian-like notes: sidebar (canvases, file tree, search, tags), side editor with backlinks, graph view.
import { h, icon, bus, menu, prompt, confirmBox, toast, debounce, modal, esc, badge } from './util.js';
import { state, native } from './state.js';
import { vaultIndex } from './vaultIndex.js';
import { RichEditor } from './editor.js';
import { LayersPanel } from './layers.js';
import { cssColor } from './pentools.js';

// =====================================================================
// Sidebar
// =====================================================================
export class Sidebar {
  constructor(host, app) {
    this.app = app;
    this.collapsed = new Set(JSON.parse(localStorageGet('collapsedFolders') || '[]'));
    this.filterTag = null;
    this.query = '';
    this.picked = new Set(); // notes chosen with Ctrl / Shift
    this.anchor = null;
    this.visibleFiles = [];
    this.el = h('aside', { class: 'sidebar' });
    host.append(this.el);
    this.build();
    vaultIndex.on('change', () => this.renderTree());
    state.on('projects', () => this.renderCanvases());
    state.on('canvas', () => this.renderCanvases());
  }

  build() {
    // canvases of the current project
    this.canvasSec = h('div', { class: 'sb-section' });
    // notes
    this.search = h('input', { class: 'input sb-search', placeholder: 'Поиск по заметкам…' });
    this.search.addEventListener('input', debounce(() => { this.query = this.search.value.trim(); this.renderTree(); }, 180));
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { this.search.value = ''; this.query = ''; this.renderTree(); } });
    this.notesTools = h('div', { class: 'sb-tools' },
      h('button', { class: 'icon-btn sm', title: 'Новая заметка (Ctrl+N)', html: icon('plus', 14), onclick: () => this.newNote() }),
      h('button', { class: 'icon-btn sm', title: 'Новая папка', html: icon('folder', 14), onclick: () => this.newFolder() }),
      h('button', { class: 'icon-btn sm', title: 'Граф связей', html: icon('graph', 14), onclick: () => openGraph(this.app) }),
      h('button', { class: 'icon-btn sm', title: 'Хранилище…', html: icon('more', 14), onclick: (e) => this.vaultMenu(e) }),
    );
    this.layersTools = h('div', { class: 'sb-tools' },
      h('button', { class: 'icon-btn sm', title: 'Показать все объекты', html: icon('maximize', 14), onclick: () => this.app.canvas.fit() }),
    );
    // notes and layers share the space as two tabs, so they never overlap or squeeze each other
    this.tabNotes = h('button', { class: 'sb-tab', onclick: () => this.setTab('notes') }, 'Заметки');
    this.layersCount = h('span', { class: 'sb-tab-n' });
    this.tabLayers = h('button', { class: 'sb-tab', title: 'Объекты этого холста', onclick: () => this.setTab('layers') }, 'Слои', this.layersCount);
    const head = h('div', { class: 'sb-head sb-tabs-row' }, h('div', { class: 'sb-tabs' }, this.tabNotes, this.tabLayers), h('span', { class: 'flex' }), this.notesTools, this.layersTools);
    this.tree = h('div', { class: 'sb-tree scrollable' });
    this.tree.addEventListener('click', (e) => { if (e.target === this.tree) this.setPicked([]); });
    this.tagsBox = h('div', { class: 'sb-tags' });
    this.notesPane = h('div', { class: 'sb-pane' }, this.search, this.tree, this.tagsBox);
    this.layers = new LayersPanel(this.app);
    this.el.append(this.canvasSec, h('div', { class: 'sb-section grow' }, head, this.notesPane, this.layers.el));
    const count = debounce(() => { this.layersCount.textContent = String(this.layers.count() || ''); }, 150);
    this.app.canvas.on('changed', count);
    state.on('canvas', count);
    count();
    this.renderCanvases();
    this.renderTree();
    this.setTab(localStorageGet('sidebarTab') === 'layers' ? 'layers' : 'notes');
  }
  setTab(tab) {
    this.tab = tab;
    localStorageSet('sidebarTab', tab);
    const notes = tab === 'notes';
    this.tabNotes.classList.toggle('on', notes); this.tabLayers.classList.toggle('on', !notes);
    this.notesPane.style.display = notes ? '' : 'none'; this.notesTools.style.display = notes ? '' : 'none';
    this.layers.el.style.display = notes ? 'none' : ''; this.layersTools.style.display = notes ? 'none' : '';
    this.layers.show(!notes);
  }

  renderCanvases() {
    const p = state.project;
    if (!p) return;
    const sec = this.canvasSec;
    sec.innerHTML = '';
    sec.append(h('div', { class: 'sb-head' },
      h('span', { class: 'proj-dot', style: { background: cssColor(p.color, 'blue') } }),
      h('span', { class: 'sb-title' }, p.name),
      h('span', { class: 'flex' }),
      h('button', { class: 'icon-btn sm', title: 'Новый canvas', html: icon('plus', 14), onclick: async () => { const n = await prompt('Название canvas', `Canvas ${p.canvases.length + 1}`); if (n) state.createCanvas(p.id, n); } }),
    ));
    for (const c of p.canvases) {
      const active = c.id === state.ws.activeCanvasId;
      const row = h('div', { class: `sb-item canvas-item${active ? ' active' : ''}`, onclick: () => state.openCanvas(p.id, c.id) },
        h('span', { class: 'sb-ic', html: icon('grid', 14) }), h('span', { class: 'sb-label' }, c.name));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.canvasMenu(p, c, e.clientX, e.clientY); });
      row.addEventListener('dblclick', async () => { const n = await prompt('Переименовать canvas', c.name); if (n) state.renameCanvas(p.id, c.id, n); });
      sec.append(row);
    }
  }

  async renderTree() {
    const tree = this.tree;
    tree.innerHTML = '';
    this.visibleFiles = [];
    if (this.query) {
      const res = await native.vault.search(this.query);
      if (!res.length) tree.append(h('div', { class: 'muted sb-empty' }, 'Ничего не найдено'));
      for (const r of res) {
        const item = this.fileRow({ path: r.path, name: r.name }, 0);
        for (const m of r.matches.slice(0, 2)) item.append(h('div', { class: 'sb-match', html: `${esc(m.before)}<mark>${esc(m.hit)}</mark>${esc(m.after)}` }));
        tree.append(item);
      }
      return;
    }
    let notes = vaultIndex.notes;
    if (this.filterTag) {
      notes = notes.filter((n) => n.tags.includes(this.filterTag));
      tree.append(h('div', { class: 'sb-filter' }, h('span', { class: 'tag' }, `#${this.filterTag}`), h('button', { class: 'icon-btn sm', html: icon('x', 12), onclick: () => { this.filterTag = null; this.renderTree(); } })));
      for (const n of notes) tree.append(this.fileRow(n, 0));
    } else {
      // build folder tree
      const root = { folders: {}, files: [] };
      const ensure = (path) => { let cur = root; if (!path) return cur; for (const part of path.split('/')) { cur.folders[part] = cur.folders[part] || { folders: {}, files: [], path: cur.path ? `${cur.path}/${part}` : part }; cur = cur.folders[part]; } return cur; };
      for (const f of vaultIndex.folders) if (!f.split('/').some((p) => p === 'attachments')) ensure(f);
      for (const n of notes) ensure(n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : '').files.push(n);
      const walk = (node, depth) => {
        for (const [name, f] of Object.entries(node.folders).sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
          const open = !this.collapsed.has(f.path);
          const row = h('div', { class: 'sb-item folder', style: { paddingLeft: `${8 + depth * 14}px` }, onclick: () => { open ? this.collapsed.add(f.path) : this.collapsed.delete(f.path); localStorageSet('collapsedFolders', JSON.stringify([...this.collapsed])); this.renderTree(); } },
            h('span', { class: 'sb-ic', html: icon(open ? 'chevronDown' : 'chevronRight', 12) }), h('span', { class: 'sb-ic', html: icon(open ? 'folderOpen' : 'folder', 14) }), h('span', { class: 'sb-label' }, name));
          row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.folderMenu(f.path, e.clientX, e.clientY); });
          this.dropTarget(row, f.path);
          tree.append(row);
          if (open) walk(f, depth + 1);
        }
        for (const n of node.files.sort((a, b) => a.name.localeCompare(b.name, 'ru'))) tree.append(this.fileRow(n, depth));
      };
      walk(root, 0);
      if (!notes.length) tree.append(h('div', { class: 'muted sb-empty' }, 'Пока нет заметок'));
    }
    // tags
    this.tagsBox.innerHTML = '';
    const tags = vaultIndex.tags().slice(0, 30);
    if (tags.length) {
      this.tagsBox.append(h('div', { class: 'sb-title small' }, 'Теги'));
      const wrap = h('div', { class: 'tag-cloud' });
      for (const [t, c] of tags) wrap.append(h('span', { class: `tag${this.filterTag === t ? ' on' : ''}`, onclick: () => { this.filterTag = this.filterTag === t ? null : t; this.renderTree(); } }, `#${t}`, h('small', {}, ` ${c}`)));
      this.tagsBox.append(wrap);
    }
  }

  fileRow(n, depth) {
    this.visibleFiles.push(n.path);
    const active = this.app.notePanel?.path === n.path;
    const onCanvas = state.doc?.nodes.some((x) => x.type === 'note' && x.data.path === n.path);
    const row = h('div', { class: `sb-item file${active ? ' active' : ''}${this.picked.has(n.path) ? ' picked' : ''}`, draggable: 'true', style: { paddingLeft: `${22 + depth * 14}px` }, title: `${n.path}\nCtrl — выбрать несколько, Shift — диапазон. Перетащите на canvas`, dataset: { path: n.path } },
      h('span', { class: 'sb-ic', html: icon('file', 14) }), h('span', { class: 'sb-label' }, n.name), onCanvas ? h('span', { class: 'on-canvas', title: 'Есть на canvas' }) : null);
    row.addEventListener('click', (e) => this.clickFile(n, e));
    row.addEventListener('dragstart', (e) => {
      const paths = this.picked.has(n.path) && this.picked.size > 1 ? this.pickedInOrder() : [n.path];
      e.dataTransfer.setData('application/x-vibetabula-note', paths[0]);
      if (paths.length > 1) e.dataTransfer.setData('application/x-vibetabula-notes', JSON.stringify(paths));
      e.dataTransfer.setData('text/plain', paths.map((p) => `[[${p.split('/').pop().replace(/\.md$/i, '')}]]`).join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
      if (paths.length > 1) { const ghost = h('div', { class: 'drag-count' }, `${paths.length} заметки`); document.body.append(ghost); e.dataTransfer.setDragImage(ghost, 10, 10); setTimeout(() => ghost.remove()); }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.picked.has(n.path)) this.setPicked([n.path]);
      if (this.picked.size > 1) this.multiMenu(e.clientX, e.clientY); else this.fileMenu(n, e.clientX, e.clientY);
    });
    return row;
  }
  // dropping notes on a folder moves them there
  dropTarget(row, folder) {
    const isNote = (e) => [...(e.dataTransfer?.types || [])].includes('application/x-vibetabula-note');
    row.addEventListener('dragover', (e) => { if (!isNote(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drop-into'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
    row.addEventListener('drop', (e) => {
      if (!isNote(e)) return;
      e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-into');
      let paths = [];
      try { paths = JSON.parse(e.dataTransfer.getData('application/x-vibetabula-notes') || '[]'); } catch {}
      if (!paths.length) paths = [e.dataTransfer.getData('application/x-vibetabula-note')].filter(Boolean);
      this.moveNotes(paths, folder);
    });
  }
  pickedInOrder() { const order = this.visibleFiles; return [...this.picked].sort((a, b) => order.indexOf(a) - order.indexOf(b)); }
  setPicked(paths) {
    this.picked = new Set(paths);
    for (const r of this.tree.querySelectorAll('.sb-item.file')) r.classList.toggle('picked', this.picked.has(r.dataset.path));
  }
  clickFile(n, e) {
    if (e.shiftKey && this.anchor && this.visibleFiles.includes(this.anchor)) {
      const a = this.visibleFiles.indexOf(this.anchor), b = this.visibleFiles.indexOf(n.path);
      const range = this.visibleFiles.slice(Math.min(a, b), Math.max(a, b) + 1);
      this.setPicked(e.ctrlKey || e.metaKey ? [...this.picked, ...range] : range);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(this.picked);
      // the note that is open counts as the first chosen one
      if (!next.size && this.app.notePanel?.path && this.app.notePanel.path !== n.path && this.visibleFiles.includes(this.app.notePanel.path)) next.add(this.app.notePanel.path);
      next.has(n.path) ? next.delete(n.path) : next.add(n.path);
      this.setPicked([...next]);
      this.anchor = n.path;
      return;
    }
    this.setPicked([n.path]);
    this.anchor = n.path;
    this.app.openNote(n.path);
  }
  multiMenu(x, y) {
    const paths = this.pickedInOrder();
    const k = paths.length;
    const folders = ['', ...vaultIndex.folders.filter((f) => !f.split('/').includes('attachments')).sort((a, b) => a.localeCompare(b, 'ru'))];
    menu([
      { header: `Выбрано заметок: ${k}` },
      { label: 'Вывести на canvas', icon: 'plus', onClick: () => this.app.addNotesToCanvas(paths) },
      { label: 'Переместить в папку', icon: 'folder', children: folders.map((f) => ({ label: f || 'Корень хранилища', onClick: () => this.moveNotes(paths, f) })) },
      '-',
      { label: 'Снять выбор', icon: 'x', onClick: () => this.setPicked([]) },
      { label: `Удалить (${k})`, icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmBox(`Удалить ${k} заметки?`, 'Они будут перемещены в корзину.'))) return;
        for (const p of paths) { try { await native.vault.remove(p); } catch {} if (this.app.notePanel?.path === p) this.app.closeNote(); }
        this.setPicked([]); vaultIndex.refresh();
      } },
    ], x, y, { minWidth: 220 });
  }
  async moveNotes(paths, folder) {
    let moved = 0;
    for (const p of paths) {
      const name = p.split('/').pop();
      const np = folder ? `${folder}/${name}` : name;
      if (np === p) continue;
      try {
        await native.vault.rename(p, np);
        for (const x of state.doc.nodes) if (x.type === 'note' && x.data.path === p) this.app.canvas.updateNode(x.id, { data: { path: np } });
        if (this.app.notePanel?.path === p) this.app.openNote(np);
        moved++;
      } catch (e) { toast(`«${name}»: ${e.message}`, 'error'); }
    }
    this.setPicked([]);
    await vaultIndex.refresh();
    if (moved) toast(`Перемещено: ${moved}`);
  }

  fileMenu(n, x, y) {
    menu([
      { label: 'Открыть', icon: 'sidebarRight', onClick: () => this.app.openNote(n.path) },
      { label: 'Вывести на canvas', icon: 'plus', onClick: () => this.app.addNoteToCanvas(n.path) },
      { label: 'Вывести со связями', icon: 'graph', onClick: () => this.app.addNoteWithLinks(n.path) },
      '-',
      { label: 'Переименовать', icon: 'pen', onClick: () => this.renameNote(n) },
      { label: 'Показать в папке', icon: 'folder', onClick: () => native.vault.reveal(n.path) },
      '-',
      { label: 'Удалить', icon: 'trash', danger: true, onClick: async () => { if (await confirmBox('Удалить заметку?', `«${n.name}» будет перемещена в корзину.`)) { await native.vault.remove(n.path); if (this.app.notePanel?.path === n.path) this.app.closeNote(); vaultIndex.refresh(); } } },
    ], x, y);
  }
  folderMenu(path, x, y) {
    menu([
      { label: 'Новая заметка здесь', icon: 'plus', onClick: () => this.newNote(path) },
      { label: 'Новая папка', icon: 'folder', onClick: () => this.newFolder(path) },
      { label: 'Переименовать', icon: 'pen', onClick: async () => { const nn = await prompt('Имя папки', path.split('/').pop()); if (nn) { const np = path.includes('/') ? path.replace(/[^/]+$/, nn) : nn; try { await native.vault.rename(path, np); vaultIndex.refresh(); } catch (e) { toast(e.message, 'error'); } } } },
      { label: 'Показать в проводнике', icon: 'external', onClick: () => native.vault.reveal(path) },
      '-',
      { label: 'Удалить папку', icon: 'trash', danger: true, onClick: async () => { if (await confirmBox('Удалить папку?', `Папка «${path}» и её содержимое будут перемещены в корзину.`)) { await native.vault.remove(path); vaultIndex.refresh(); } } },
    ], x, y);
  }
  vaultMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    menu([
      { header: vaultIndex.root || '' },
      { label: 'Открыть папку хранилища', icon: 'folderOpen', onClick: () => native.vault.reveal('') },
      { label: 'Выбрать другое хранилище…', icon: 'folder', onClick: () => this.app.chooseVault() },
      { label: 'Обновить', icon: 'refresh', onClick: () => vaultIndex.refresh() },
    ], r.left, r.bottom + 4);
  }

  async renameNote(n) {
    const name = await prompt('Переименовать заметку', n.name);
    if (!name || name === n.name) return;
    const np = n.path.includes('/') ? n.path.replace(/[^/]+$/, `${name}.md`) : `${name}.md`;
    try {
      await native.vault.rename(n.path, np);
      for (const x of state.doc.nodes) if (x.type === 'note' && x.data.path === n.path) this.app.canvas.updateNode(x.id, { data: { path: np } });
      if (this.app.notePanel?.path === n.path) this.app.openNote(np);
      await vaultIndex.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async newNote(folder = '') {
    const name = await prompt('Новая заметка', '', 'Название');
    if (name == null) return;
    const p = await native.vault.create(folder, name || 'Без названия', '');
    await vaultIndex.refresh();
    this.app.openNote(p, { focus: true });
  }
  async newFolder(parent = '') {
    const name = await prompt('Новая папка', '', 'Название папки');
    if (!name) return;
    await native.vault.mkdir(parent ? `${parent}/${name}` : name);
    vaultIndex.refresh();
  }
  filterByTag(tag) { this.filterTag = tag; this.query = ''; this.search.value = ''; this.renderTree(); this.app.toggleSidebar(true); }
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// =====================================================================
// Side editor panel
// =====================================================================
export class NotePanel {
  constructor(host, app) {
    this.app = app;
    this.path = null;
    this.el = h('section', { class: 'note-panel' });
    this.titleInput = h('input', { class: 'np-title', spellcheck: 'false' });
    this.titleInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); this.titleInput.blur(); } });
    this.titleInput.addEventListener('blur', () => this.rename());
    this.crumb = h('div', { class: 'np-crumb' });
    this.editor = new RichEditor({
      extraButtons: [
        { icon: 'plus', title: 'Вывести на canvas', label: 'На canvas', cls: 'accent', onClick: () => app.addNoteToCanvas(this.path) },
        { icon: 'x', title: 'Закрыть', onClick: () => app.closeNote() },
      ],
    });
    this.editor.content.classList.add('scrollable');
    this.links = h('div', { class: 'np-links' });
    const scroll = h('div', { class: 'np-scroll' }, this.crumb, this.titleInput, this.editor.content, this.links);
    this.el.append(this.editor.toolbar, scroll);
    host.append(this.el);
    this.editor.on('openLink', (name) => app.openNoteByName(name));
    this.editor.on('openTag', (tag) => app.sidebar.filterByTag(tag));
    this.editor.on('saved', () => vaultIndex.refreshSoon());
    vaultIndex.on('change', () => { if (this.path) { this.renderLinks(); this.editor.refreshFromDisk(); } });
  }

  async open(path, { focus = false } = {}) {
    this.path = path;
    this.el.classList.add('open');
    this.titleInput.value = path.split('/').pop().replace(/\.md$/, '');
    const folder = path.includes('/') ? path.split('/').slice(0, -1).join(' / ') : '';
    this.crumb.textContent = folder;
    await this.editor.load(path);
    this.renderLinks();
    if (focus) { const c = this.editor.content; c.focus(); const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  close() { this.editor.save.flush(); this.path = null; this.el.classList.remove('open'); }

  async rename() {
    if (!this.path) return;
    const name = this.titleInput.value.trim().replace(/[\\/:*?"<>|]/g, '-');
    const cur = this.path.split('/').pop().replace(/\.md$/, '');
    if (!name || name === cur) { this.titleInput.value = cur; return; }
    const np = this.path.includes('/') ? this.path.replace(/[^/]+$/, `${name}.md`) : `${name}.md`;
    try {
      await this.editor.saveNow();
      await native.vault.rename(this.path, np);
      for (const x of state.doc.nodes) if (x.type === 'note' && x.data.path === this.path) this.app.canvas.updateNode(x.id, { data: { path: np } });
      this.path = np; this.editor.path = np;
      await vaultIndex.refresh();
    } catch (e) { toast(e.message, 'error'); this.titleInput.value = cur; }
  }

  renderLinks() {
    const back = vaultIndex.backlinks(this.path);
    const out = vaultIndex.outgoing(this.path);
    this.links.innerHTML = '';
    const sec = (title, list) => {
      const box = h('div', { class: 'np-link-sec' }, h('div', { class: 'np-link-title' }, `${title} · ${list.length}`));
      if (!list.length) box.append(h('div', { class: 'muted small' }, 'нет'));
      for (const n of list) box.append(h('div', { class: 'np-link', onclick: () => this.app.openNote(n.path) }, h('span', { html: icon('file', 13) }), h('span', {}, n.name), h('span', { class: 'muted small' }, n.preview?.slice(0, 60) || '')));
      return box;
    };
    this.links.append(sec('Обратные ссылки', back), sec('Исходящие ссылки', out));
  }
}

// =====================================================================
// Graph view
// =====================================================================
export function openGraph(app) {
  const canvas = h('canvas', { class: 'graph-canvas' });
  const info = h('div', { class: 'graph-info muted' }, 'Колесо — масштаб, перетаскивание — перемещение, клик — открыть заметку');
  const toCanvasBtn = h('button', { class: 'btn' }, 'Вывести граф на canvas');
  const body = h('div', { class: 'graph-wrap' }, canvas, info);
  const m = modal({ title: 'Граф заметок', body, width: 'min(1100px, 92vw)', className: 'graph-modal', actions: [], onClose: () => cancelAnimationFrame(raf) });
  m.box.querySelector('.modal-head').insertBefore(toCanvasBtn, m.box.querySelector('.modal-head .icon-btn'));

  const notes = vaultIndex.notes;
  const nodes = notes.map((n, i) => ({ id: n.path, name: n.name, x: Math.cos(i * 2.4) * 120 * Math.sqrt(i + 1), y: Math.sin(i * 2.4) * 120 * Math.sqrt(i + 1), vx: 0, vy: 0, deg: 0, tags: n.tags }));
  const byName = new Map(notes.map((n, i) => [n.name.toLowerCase(), nodes[i]]));
  const links = [];
  notes.forEach((n, i) => n.links.forEach((l) => { const t = byName.get(l.toLowerCase()); if (t && t !== nodes[i]) { links.push([nodes[i], t]); nodes[i].deg++; t.deg++; } }));
  let cam = { x: 0, y: 0, z: 1 };
  let hover = null, drag = null, raf = 0, alpha = 1;
  const ctx = canvas.getContext('2d');
  const resize = () => { const r = body.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = (r.height - 0) * devicePixelRatio; canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`; };
  setTimeout(resize, 0);

  const tick = () => {
    if (alpha > 0.02) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]; let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy || 1;
          if (d2 > 250000) continue;
          const f = 2200 / d2; const d = Math.sqrt(d2); dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
        a.vx -= a.x * 0.002; a.vy -= a.y * 0.002;
      }
      for (const [a, b] of links) { const dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1; const f = (d - 90) * 0.01; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; }
      for (const n of nodes) { if (n === drag?.node) continue; n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx * alpha; n.y += n.vy * alpha; }
      alpha *= 0.995;
    }
    draw();
    raf = requestAnimationFrame(tick);
  };
  const W = () => canvas.width / devicePixelRatio, H = () => canvas.height / devicePixelRatio;
  const scr = (n) => ({ x: W() / 2 + (n.x + cam.x) * cam.z, y: H() / 2 + (n.y + cam.y) * cam.z });
  const light = document.documentElement.dataset.theme === 'light';
  const draw = () => {
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, W(), H());
    const nb = new Set();
    if (hover) { nb.add(hover); for (const [a, b] of links) { if (a === hover) nb.add(b); if (b === hover) nb.add(a); } }
    ctx.lineWidth = 1;
    for (const [a, b] of links) {
      const p = scr(a), q = scr(b);
      ctx.strokeStyle = hover && (a === hover || b === hover) ? 'rgba(110,125,245,0.9)' : light ? 'rgba(60,70,90,0.25)' : 'rgba(150,160,180,0.25)';
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    for (const n of nodes) {
      const p = scr(n);
      const r = (4 + Math.sqrt(n.deg) * 2.2) * Math.max(0.6, Math.min(1.6, cam.z));
      const dim = hover && !nb.has(n);
      ctx.fillStyle = n === hover ? '#7c8cff' : dim ? 'rgba(140,150,170,0.25)' : n.deg ? (light ? '#5b6475' : '#b9c1d3') : (light ? '#a0a7b6' : '#6b7385');
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (cam.z > 0.6 || n === hover || nb.has(n)) {
        ctx.fillStyle = light ? (dim ? 'rgba(40,46,60,0.3)' : 'rgba(30,36,48,0.9)') : (dim ? 'rgba(200,205,215,0.3)' : 'rgba(225,229,236,0.9)');
        ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(n.name, p.x, p.y + r + 13);
      }
    }
  };
  const pick = (cx, cy) => { const r = canvas.getBoundingClientRect(); const x = cx - r.left, y = cy - r.top; let best = null, bd = 14; for (const n of nodes) { const p = scr(n); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = n; } } return best; };
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      if (drag.node) { drag.node.x += e.movementX / cam.z; drag.node.y += e.movementY / cam.z; alpha = Math.max(alpha, 0.3); drag.moved = true; }
      else { cam.x += e.movementX / cam.z; cam.y += e.movementY / cam.z; drag.moved = true; }
      return;
    }
    hover = pick(e.clientX, e.clientY); canvas.style.cursor = hover ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerdown', (e) => { drag = { node: pick(e.clientX, e.clientY), moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { if (drag && !drag.moved && drag.node) { m.close(); app.openNote(drag.node.id); } drag = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.z = Math.max(0.2, Math.min(4, cam.z * Math.exp(-e.deltaY * 0.0015))); }, { passive: false });
  toCanvasBtn.addEventListener('click', () => {
    const sel = (hover ? [hover, ...links.filter(([a, b]) => a === hover || b === hover).map(([a, b]) => (a === hover ? b : a))] : nodes.filter((n) => n.deg).sort((a, b) => b.deg - a.deg)).slice(0, 24);
    if (!sel.length) { toast('Нет связанных заметок', 'warn'); return; }
    m.close();
    app.placeNotesGraph(sel.map((n) => ({ path: n.id, x: n.x * 3.2, y: n.y * 2.6 })), links.filter(([a, b]) => sel.includes(a) && sel.includes(b)).map(([a, b]) => [a.id, b.id]));
  });
  raf = requestAnimationFrame(tick);
}

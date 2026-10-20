// Rich markdown editor with an Apple Notes–style toolbar. Files stay plain Markdown (Obsidian compatible).
import { h, icon, debounce, menu, prompt, toast, esc, readFileAsDataURL, Emitter } from './util.js';
import { mdToHtml, htmlToMd, splitFrontmatter } from './md.js';
import { native } from './state.js';
import { vaultIndex } from './vaultIndex.js';

document.execCommand('defaultParagraphSeparator', false, 'p');

const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,div';

export class RichEditor extends Emitter {
  constructor({ compact = false, extraButtons = [], placeholder = 'Начните писать…' } = {}) {
    super();
    this.compact = compact;
    this.path = null;
    this.fm = '';
    this.lastSaved = null;
    this.el = h('div', { class: `rich-editor${compact ? ' compact' : ''}` });
    this.toolbar = this.buildToolbar(extraButtons);
    this.content = h('div', { class: 'rich-content md', contenteditable: 'true', spellcheck: 'false', 'data-placeholder': placeholder });
    this.el.append(this.toolbar, this.content);
    this.save = debounce(() => this.saveNow(), 450);
    this.bind();
  }

  // ---------------- toolbar ----------------
  buildToolbar(extra) {
    const tb = h('div', { class: 'note-toolbar' });
    const btn = (name, title, fn, cls = '') => {
      const b = h('button', { class: `tb-btn ${cls}`, title, html: icon(name, 17) });
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
      b.addEventListener('click', (e) => { this.content.focus(); fn(e, b); });
      return b;
    };
    const aa = h('button', { class: 'tb-btn tb-aa', title: 'Стиль текста' }, h('span', { class: 'aa' }, 'Aa'));
    aa.addEventListener('mousedown', (e) => e.preventDefault());
    aa.addEventListener('click', () => this.formatPopover(aa));
    tb.append(
      aa,
      btn('checklist', 'Чек-лист (Ctrl+Shift+L)', () => this.toggleChecklist()),
      btn('table', 'Таблица', (e, b) => this.tableMenu(b)),
      btn('paperclip', 'Вложение (изображение)', () => this.attach()),
      h('span', { class: 'tb-sep' }),
      btn('bold', 'Жирный (Ctrl+B)', () => this.cmd('bold'), 'tb-inline'),
      btn('italic', 'Курсив (Ctrl+I)', () => this.cmd('italic'), 'tb-inline'),
      btn('underline', 'Подчёркнутый (Ctrl+U)', () => this.cmd('underline'), 'tb-inline'),
      btn('strike', 'Зачёркнутый', () => this.cmd('strikeThrough'), 'tb-inline'),
      btn('highlight', 'Выделение маркером', () => this.toggleMark(), 'tb-inline'),
      btn('link', 'Ссылка или [[заметка]] (Ctrl+K)', () => this.insertLink()),
      h('span', { class: 'tb-sep tb-inline' }),
      btn('undo', 'Отменить', () => this.cmd('undo'), 'tb-inline'),
      btn('redo', 'Повторить', () => this.cmd('redo'), 'tb-inline'),
      h('span', { class: 'tb-flex' }),
      ...extra.map((x) => { const b = btn(x.icon, x.title, x.onClick, x.cls || ''); if (x.label) b.append(h('span', { class: 'tb-label' }, x.label)); return b; }),
    );
    return tb;
  }

  formatPopover(anchor) {
    const r = anchor.getBoundingClientRect();
    const blk = this.currentBlock();
    const cur = blk ? blk.tagName : 'P';
    const pop = h('div', { class: 'menu aa-pop' });
    const styles = [
      ['Заголовок', 'h1', 'aa-h1'], ['Подзаголовок', 'h2', 'aa-h2'], ['Подзаголовок 2', 'h3', 'aa-h3'],
      ['Основной текст', 'p', 'aa-p'], ['Моноширинный', 'pre', 'aa-mono'],
    ];
    for (const [label, tag, cls] of styles) {
      const row = h('div', { class: `menu-item aa-style ${cls} ${cur.toLowerCase() === tag ? 'checked' : ''}` }, h('span', { class: 'menu-ic', html: cur.toLowerCase() === tag ? '✓' : '' }), h('span', { class: 'menu-label' }, label));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => { this.block(tag); pop.remove(); });
      pop.append(row);
    }
    const strip = (items) => {
      const s = h('div', { class: 'aa-strip' });
      for (const [ic, title, fn] of items) {
        const b = h('button', { class: 'tb-btn', title, html: icon(ic, 16) });
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => { fn(); });
        s.append(b);
      }
      return s;
    };
    pop.append(h('div', { class: 'menu-sep' }));
    pop.append(strip([
      ['bold', 'Жирный', () => this.cmd('bold')], ['italic', 'Курсив', () => this.cmd('italic')],
      ['underline', 'Подчёркнутый', () => this.cmd('underline')], ['strike', 'Зачёркнутый', () => this.cmd('strikeThrough')],
      ['highlight', 'Маркер', () => this.toggleMark()], ['code', 'Код', () => this.inlineCode()],
    ]));
    const listRow = (label, glyph, fn) => {
      const row = h('div', { class: 'menu-item' }, h('span', { class: 'menu-ic list-glyph' }, glyph), h('span', { class: 'menu-label' }, label));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => { fn(); pop.remove(); });
      return row;
    };
    pop.append(h('div', { class: 'menu-sep' }),
      listRow('Маркированный список', '•', () => this.cmd('insertUnorderedList')),
      listRow('Нумерованный список', '1.', () => this.cmd('insertOrderedList')),
      listRow('Чек-лист', '○', () => this.toggleChecklist()),
      listRow('Цитата', '❝', () => this.block('blockquote')),
      listRow('Разделитель', '—', () => this.cmd('insertHTML', '<hr><p><br></p>')),
    );
    pop.append(h('div', { class: 'menu-sep' }), strip([
      ['alignL', 'Уменьшить отступ', () => this.cmd('outdent')], ['alignR', 'Увеличить отступ', () => this.cmd('indent')],
    ]));
    document.body.append(pop);
    pop.style.left = `${Math.min(r.left, innerWidth - 260)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  }

  tableMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const cell = this.selectionNode()?.closest?.('td,th');
    if (!cell) { this.insertTable(); return; }
    menu([
      { label: 'Строка ниже', icon: 'plus', onClick: () => this.tableOp('rowBelow', cell) },
      { label: 'Столбец справа', icon: 'plus', onClick: () => this.tableOp('colRight', cell) },
      '-',
      { label: 'Удалить строку', icon: 'minus', onClick: () => this.tableOp('delRow', cell) },
      { label: 'Удалить столбец', icon: 'minus', onClick: () => this.tableOp('delCol', cell) },
      { label: 'Удалить таблицу', icon: 'trash', danger: true, onClick: () => this.tableOp('delTable', cell) },
    ], r.left, r.bottom + 4);
  }

  // ---------------- commands ----------------
  cmd(name, value = null) { document.execCommand(name, false, value); this.changed(); }

  block(tag) {
    const blk = this.currentBlock();
    if (blk && blk.tagName.toLowerCase() === tag && tag !== 'p') tag = 'p';
    // leave lists before changing block type
    if (blk && blk.tagName === 'LI') {
      const list = blk.parentElement;
      document.execCommand(list.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
    }
    document.execCommand('formatBlock', false, tag);
    this.changed();
  }

  toggleChecklist() {
    let li = this.selectionNode()?.closest?.('li');
    if (li && li.parentElement.classList.contains('checklist')) {
      document.execCommand('insertUnorderedList');
      this.changed(); return;
    }
    if (!li || li.parentElement.tagName !== 'UL') document.execCommand('insertUnorderedList');
    li = this.selectionNode()?.closest?.('li');
    const ul = li && li.closest('ul');
    if (ul) { ul.classList.add('checklist'); ul.querySelectorAll(':scope > li').forEach((x) => { if (x.dataset.checked == null) x.dataset.checked = 'false'; }); }
    this.changed();
  }

  toggleMark() {
    const sel = getSelection();
    const node = this.selectionNode();
    const mark = node?.closest?.('mark');
    if (mark) { const p = mark.parentNode; while (mark.firstChild) p.insertBefore(mark.firstChild, mark); mark.remove(); this.changed(); return; }
    if (!sel.rangeCount || sel.isCollapsed) return;
    const frag = sel.getRangeAt(0).cloneContents();
    const tmp = h('div'); tmp.append(frag);
    document.execCommand('insertHTML', false, `<mark>${tmp.innerHTML}</mark>`);
    this.changed();
  }

  inlineCode() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { document.execCommand('insertHTML', false, '<code>код</code>&nbsp;'); }
    else document.execCommand('insertHTML', false, `<code>${esc(sel.toString())}</code>`);
    this.changed();
  }

  insertTable(rows = 3, cols = 3) {
    const head = `<tr>${'<th>Заголовок</th>'.repeat(cols)}</tr>`;
    const body = Array.from({ length: rows - 1 }, () => `<tr>${'<td><br></td>'.repeat(cols)}</tr>`).join('');
    document.execCommand('insertHTML', false, `<table><thead>${head}</thead><tbody>${body}</tbody></table><p><br></p>`);
    this.changed();
  }

  tableOp(op, cell) {
    const tr = cell.parentElement;
    const table = cell.closest('table');
    const idx = [...tr.children].indexOf(cell);
    if (op === 'rowBelow') { const n = tr.cloneNode(true); n.querySelectorAll('th,td').forEach((c) => { const td = document.createElement('td'); td.innerHTML = '<br>'; c.replaceWith(td); }); if (tr.parentElement.tagName === 'THEAD') { let tb = table.querySelector('tbody'); if (!tb) { tb = document.createElement('tbody'); table.append(tb); } tb.prepend(n); } else tr.after(n); }
    if (op === 'colRight') table.querySelectorAll('tr').forEach((r) => { const c = r.children[idx]; const n = document.createElement(c && c.tagName === 'TH' ? 'th' : 'td'); n.innerHTML = '<br>'; (c ? c.after(n) : r.append(n)); });
    if (op === 'delRow') { tr.remove(); if (!table.querySelector('tr')) table.remove(); }
    if (op === 'delCol') { table.querySelectorAll('tr').forEach((r) => r.children[idx]?.remove()); if (!table.querySelector('td,th')) table.remove(); }
    if (op === 'delTable') table.remove();
    this.changed();
  }

  async attach() {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
    input.onchange = async () => { for (const f of input.files) await this.insertImageFile(f); };
    input.click();
  }

  async insertImageFile(file) {
    try {
      const dataUrl = await readFileAsDataURL(file);
      const rel = await native.vault.saveAsset(dataUrl, file.name);
      const name = rel.split('/').pop();
      vaultIndex.addAsset(rel);
      document.execCommand('insertHTML', false, `<img class="embed" data-embed="${esc(name)}" src="${dataUrl}"><p><br></p>`);
      this.changed();
    } catch (e) { toast('Не удалось вставить изображение: ' + e.message, 'error'); }
  }

  async insertLink() {
    const sel = getSelection();
    const text = sel.toString();
    const v = await prompt('Ссылка: URL или название заметки', '', 'https://…  или  Название заметки');
    if (!v) return;
    this.content.focus();
    if (/^(https?:|mailto:)/i.test(v)) {
      if (text) document.execCommand('createLink', false, v);
      else document.execCommand('insertHTML', false, `<a href="${esc(v)}" target="_blank">${esc(v)}</a>&nbsp;`);
    } else {
      document.execCommand('insertHTML', false, `<a class="wikilink" data-target="${esc(v)}">${esc(text || v)}</a>&nbsp;`);
    }
    this.changed();
  }

  // ---------------- selection helpers ----------------
  selectionNode() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    if (!n || !this.content.contains(n)) return null;
    return n.nodeType === 3 ? n.parentElement : n;
  }
  currentBlock() {
    const n = this.selectionNode();
    if (!n) return null;
    const b = n.closest(BLOCK_SEL);
    return b && this.content.contains(b) && b !== this.content ? b : null;
  }

  // ---------------- events ----------------
  bind() {
    const c = this.content;
    c.addEventListener('input', (e) => { this.normalizeInline(); this.markdownShortcuts(e); this.inlineShortcuts(e); this.wikiAutocomplete(); this.changed(); });
    c.addEventListener('keydown', (e) => this.onKey(e));
    c.addEventListener('click', (e) => this.onClick(e));
    c.addEventListener('paste', (e) => this.onPaste(e));
    c.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); e.stopPropagation(); files.forEach((f) => this.insertImageFile(f)); }
    });
    c.addEventListener('blur', () => { setTimeout(() => this.closeAc(), 150); this.save.flush(); });
    c.addEventListener('focus', () => this.emit('focus'));
  }

  onKey(e) {
    if (this.ac && this.acKey(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this.insertLink(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); this.toggleChecklist(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); this.toggleMark(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.save.flush(); return; }
    if (e.key === 'Tab') {
      const li = this.selectionNode()?.closest?.('li');
      if (li) { e.preventDefault(); document.execCommand(e.shiftKey ? 'outdent' : 'indent'); this.changed(); return; }
      const cell = this.selectionNode()?.closest?.('td,th');
      if (cell) {
        e.preventDefault();
        const cells = [...cell.closest('table').querySelectorAll('td,th')];
        const next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
        if (next) { const r = document.createRange(); r.selectNodeContents(next); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        else if (!e.shiftKey) this.tableOp('rowBelow', cell);
        return;
      }
      e.preventDefault(); document.execCommand('insertText', false, '    ');
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const blk = this.currentBlock();
      // ``` + Enter → code block, --- + Enter → hr
      if (blk && blk.tagName === 'P') {
        const t = blk.textContent.trim();
        if (/^```\w*$/.test(t)) { e.preventDefault(); blk.innerHTML = '<br>'; document.execCommand('formatBlock', false, 'pre'); this.changed(); return; }
        if (t === '---' || t === '***') { e.preventDefault(); blk.outerHTML = '<hr><p><br></p>'; this.placeCaretIn(this.content.querySelector('hr + p')); this.changed(); return; }
      }
      // exit code block on empty last line
      if (blk && blk.tagName === 'PRE' && /\n\n?$/.test(blk.textContent) && this.caretAtEnd(blk)) {
        e.preventDefault(); blk.textContent = blk.textContent.replace(/\n+$/, '');
        const p = h('p', {}, h('br')); blk.after(p); this.placeCaretIn(p); this.changed(); return;
      }
      if (blk && blk.tagName === 'PRE') { e.preventDefault(); document.execCommand('insertText', false, '\n'); return; }
      // new checklist items start unchecked
      if (blk && blk.tagName === 'LI' && blk.dataset.checked != null) {
        setTimeout(() => { const li = this.selectionNode()?.closest?.('li'); if (li && li !== blk) li.dataset.checked = 'false'; this.changed(); }, 0);
      }
    }
  }

  caretAtEnd(el) {
    const sel = getSelection(); if (!sel.rangeCount) return false;
    const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setStart(sel.anchorNode, sel.anchorOffset);
    return r.toString().replace(/\n/g, '') === '';
  }
  placeCaretIn(el) {
    if (!el) return;
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  // keep tags from swallowing text typed after them (contenteditable extends inline elements)
  normalizeInline() {
    const sel = getSelection();
    const caretNode = sel.rangeCount ? sel.anchorNode : null;
    for (const span of this.content.querySelectorAll('span.tag')) {
      const t = span.textContent;
      const m = /^#[\p{L}\p{N}_\-/]+/u.exec(t);
      if (m && m[0] === t) continue;
      const hadCaret = caretNode && span.contains(caretNode);
      const rest = document.createTextNode(m ? t.slice(m[0].length) : t);
      if (m) { span.textContent = m[0]; span.dataset.tag = m[0].slice(1); span.after(rest); }
      else span.replaceWith(rest);
      if (hadCaret) { const r = document.createRange(); r.setStart(rest, rest.length); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    }
    for (const a of this.content.querySelectorAll('a.wikilink')) if (!a.textContent) a.remove();
  }

  // **bold**, *italic*, ~~strike~~, `code`, ==mark== typed inline
  inlineShortcuts(e) {
    if (e.inputType !== 'insertText' || !/[*_~`=]/.test(e.data || '')) return;
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || node.parentElement.closest('pre,code')) return;
    const before = node.textContent.slice(0, sel.anchorOffset);
    const rules = [
      [/\*\*([^*\n]+)\*\*$/, 'strong', 2], [/__([^_\n]+)__$/, 'strong', 2], [/~~([^~\n]+)~~$/, 's', 2],
      [/==([^=\n]+)==$/, 'mark', 2], [/`([^`\n]+)`$/, 'code', 1],
      [/(?:^|[^*])\*([^*\s][^*\n]*)\*$/, 'em', 1], [/(?:^|[\s(])_([^_\s][^_\n]*)_$/, 'em', 1],
    ];
    for (const [re, tag, d] of rules) {
      const m = re.exec(before);
      if (!m) continue;
      const len = m[1].length + d * 2;
      const r = document.createRange();
      r.setStart(node, sel.anchorOffset - len);
      r.setEnd(node, sel.anchorOffset);
      sel.removeAllRanges(); sel.addRange(r);
      // zero-width space lets the caret leave the new element; it is stripped on save
      document.execCommand('insertHTML', false, `<${tag}>${esc(m[1])}</${tag}>\u200b`);
      return;
    }
  }

  markdownShortcuts(e) {
    if (e.inputType !== 'insertText' || e.data !== ' ') return;
    const blk = this.currentBlock();
    if (!blk) return;
    const text = blk.textContent.replace(/ /g, ' ');
    if (blk.tagName === 'LI') {
      if (/^(\[\]|\[ \]) $/.test(text)) { blk.innerHTML = '<br>'; blk.dataset.checked = 'false'; blk.parentElement.classList.add('checklist'); this.placeCaretIn(blk); return; }
      const hm = /^(#{1,3}|>) $/.exec(text);
      if (hm) { blk.innerHTML = '<br>'; this.placeCaretIn(blk); document.execCommand(blk.parentElement.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList'); document.execCommand('formatBlock', false, hm[1] === '>' ? 'blockquote' : `h${hm[1].length}`); }
      return;
    }
    if (!/^(P|DIV)$/.test(blk.tagName)) return;
    const m = /^(#{1,3}|[-*+]|1[.)]|\[\]|\[ \]|- \[ \]|>)\s$/.exec(text);
    if (!m) return;
    const tok = m[1];
    blk.innerHTML = '<br>';
    this.placeCaretIn(blk);
    if (tok.startsWith('#')) document.execCommand('formatBlock', false, `h${tok.length}`);
    else if (tok === '>') document.execCommand('formatBlock', false, 'blockquote');
    else if (/^1/.test(tok)) document.execCommand('insertOrderedList');
    else if (/\[/.test(tok)) this.toggleChecklist();
    else document.execCommand('insertUnorderedList');
  }

  onClick(e) {
    const li = e.target.closest('li[data-checked]');
    if (li) {
      const r = li.getBoundingClientRect();
      const scale = r.width / (li.offsetWidth || r.width) || 1;
      if ((e.clientX - r.left) / scale < 26) { li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'; e.preventDefault(); this.changed(); return; }
    }
    const a = e.target.closest('a');
    if (a) {
      if (!getSelection().isCollapsed) return;
      e.preventDefault();
      if (a.classList.contains('wikilink')) this.emit('openLink', a.dataset.target);
      else if (a.href) native.shell.open(a.href);
      return;
    }
    const tag = e.target.closest('.tag');
    if (tag) this.emit('openTag', tag.dataset.tag || tag.textContent.replace(/^#/, ''));
  }

  async onPaste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.type.startsWith('image/'));
    if (img) { e.preventDefault(); e.stopPropagation(); await this.insertImageFile(img.getAsFile()); return; }
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault(); e.stopPropagation();
    const blk = this.currentBlock();
    if (blk && blk.tagName === 'PRE') { document.execCommand('insertText', false, text); return; }
    if (!/\n/.test(text) && !/[*_#`\[\]>|-]/.test(text)) { document.execCommand('insertText', false, text); return; }
    let html = mdToHtml(text);
    if (!/\n/.test(text)) html = html.replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1');
    document.execCommand('insertHTML', false, html);
    this.resolveEmbeds();
    this.changed();
  }

  // ---------------- wikilink autocomplete ----------------
  wikiAutocomplete() {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return this.closeAc();
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3) return this.closeAc();
    const before = node.textContent.slice(0, sel.anchorOffset);
    const m = /\[\[([^\]\n]*)$/.exec(before);
    if (!m) return this.closeAc();
    const q = m[1].toLowerCase();
    const names = vaultIndex.notes.map((n) => n.name);
    let list = names.filter((n) => n.toLowerCase().includes(q)).sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q)).slice(0, 8);
    if (q && !names.some((n) => n.toLowerCase() === q)) list.push(`+ Создать «${m[1]}»`);
    if (!list.length) return this.closeAc();
    const range = document.createRange();
    range.setStart(node, sel.anchorOffset - m[0].length);
    range.setEnd(node, sel.anchorOffset);
    const rect = range.getBoundingClientRect();
    if (!this.ac) { this.ac = h('div', { class: 'menu ac-pop' }); document.body.append(this.ac); }
    this.acState = { range, list, idx: 0, query: m[1] };
    this.renderAc();
    this.ac.style.left = `${rect.left}px`;
    this.ac.style.top = `${rect.bottom + 4}px`;
  }
  renderAc() {
    const { list, idx } = this.acState;
    this.ac.innerHTML = '';
    list.forEach((name, i) => {
      const row = h('div', { class: `menu-item${i === idx ? ' active' : ''}` }, h('span', { class: 'menu-ic', html: icon(name.startsWith('+ ') ? 'plus' : 'file', 14) }), h('span', { class: 'menu-label' }, name));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this.acState.idx = i; this.acPick(); });
      this.ac.append(row);
    });
  }
  acKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.acState.idx = (this.acState.idx + 1) % this.acState.list.length; this.renderAc(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.acState.idx = (this.acState.idx - 1 + this.acState.list.length) % this.acState.list.length; this.renderAc(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.acPick(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeAc(); return true; }
    return false;
  }
  acPick() {
    const { range, list, idx, query } = this.acState;
    let name = list[idx];
    if (name.startsWith('+ ')) name = query;
    const sel = getSelection();
    // extend over a trailing "]]" if the user already typed it
    const node = range.endContainer;
    let end = range.endOffset;
    if (node.nodeType === 3 && node.textContent.slice(end, end + 2) === ']]') end += 2;
    range.setEnd(node, end);
    sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('insertHTML', false, `<a class="wikilink" data-target="${esc(name)}">${esc(name)}</a>&nbsp;`);
    this.closeAc();
    this.changed();
  }
  closeAc() { if (this.ac) { this.ac.remove(); this.ac = null; } }

  // ---------------- io ----------------
  async load(path) {
    this.path = path;
    let md = '';
    try { md = await native.vault.read(path); } catch { md = ''; }
    this.setMarkdown(md);
  }

  setMarkdown(md) {
    const { fm } = splitFrontmatter(md);
    this.fm = fm;
    this.lastSaved = md;
    this.content.innerHTML = mdToHtml(md) || '<p><br></p>';
    this.resolveEmbeds();
    this.updateEmpty();
  }

  async resolveEmbeds() {
    for (const img of this.content.querySelectorAll('img[data-embed]:not([src])')) {
      const p = vaultIndex.resolveAsset(img.dataset.embed);
      if (!p) { img.alt = `⚠ ${img.dataset.embed}`; continue; }
      try { img.src = await native.vault.readAsset(p); } catch {}
    }
  }

  getMarkdown() { return htmlToMd(this.content, this.fm); }

  changed() { this.updateEmpty(); this.save(); this.emit('change'); }
  updateEmpty() { this.content.classList.toggle('is-empty', !this.content.textContent.trim() && !this.content.querySelector('img,table,hr,li')); }

  async saveNow() {
    if (!this.path) return;
    const md = this.getMarkdown();
    if (md === this.lastSaved) return;
    this.lastSaved = md;
    try { await native.vault.write(this.path, md); this.emit('saved', md); }
    catch (e) { toast('Ошибка сохранения: ' + e.message, 'error'); }
  }

  async refreshFromDisk() {
    if (!this.path || document.activeElement === this.content) return;
    let md;
    try { md = await native.vault.read(this.path); } catch { return; }
    if (md !== this.lastSaved) this.setMarkdown(md);
  }

  focus() { this.content.focus(); }
  destroy() { this.save.flush(); this.closeAc(); this.el.remove(); }
}

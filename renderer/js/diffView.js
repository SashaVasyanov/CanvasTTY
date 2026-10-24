// The lines of one file in the «Изменения» card with comments under their lines and the open
// editor (the comments themselves: diffComments.js; the card: nodes.js diff).
import { h, icon } from './util.js';

const same = (c, file, r) => c.file === file && c.line === r.line && (c.kind === 'del') === (r.kind === 'del');

// the lines of one file with the comments under theirs and the open editor
//   ui: { file, comments, editing: { file, kind, line, id? } | null, open(row|comment), save(text), cancel(), remove(comment) }
export function diffRows(rows, ui) {
  const out = [];
  const mine = ui.comments.filter((c) => c.file === ui.file);
  const placed = new Set();
  const editor = (initial) => {
    const ta = h('textarea', { class: 'dl-ta no-drag', rows: 3, placeholder: 'Что исправить в этой строке?' });
    ta.value = initial || '';
    const save = () => { const v = ta.value.trim(); if (v) ui.save(v); else ui.cancel(); };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the canvas and the app keys stay out of the text
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); ui.cancel(); }
    });
    setTimeout(() => ta.focus({ preventScroll: false }), 0);
    return h('div', { class: 'dl-edit no-drag' }, ta,
      h('div', { class: 'dl-edit-btns' },
        h('span', { class: 'muted small' }, 'Ctrl+Enter — сохранить, Esc — отмена'),
        h('span', { class: 'flex' }),
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); ui.cancel(); } }, 'Отмена'),
        h('button', { class: 'btn sm primary', onclick: (e) => { e.stopPropagation(); save(); } }, initial ? 'Сохранить' : 'Добавить')));
  };
  const comment = (c) => {
    if (ui.editing?.id === c.id) return editor(c.text);
    return h('div', { class: `dl-cmt${c.sent ? ' sent' : ''}` },
      h('div', { class: 'dl-cmt-text' }, c.text),
      h('div', { class: 'dl-cmt-meta' },
        h('span', {}, c.sent ? 'отправлено агенту' : 'ещё не отправлено'),
        h('span', { class: 'flex' }),
        c.sent ? null : h('button', { class: 'icon-btn sm', title: 'Изменить', html: icon('pencil', 12), onclick: (e) => { e.stopPropagation(); ui.open(c); } }),
        h('button', { class: 'icon-btn sm', title: 'Удалить замечание', html: icon('trash', 12), onclick: (e) => { e.stopPropagation(); ui.remove(c); } })));
  };
  // comments whose line is not in this diff any more (the file changed again)
  const orphans = mine.filter((c) => !rows.some((r) => r.line != null && same(c, ui.file, r)));
  for (const c of orphans) { out.push(h('div', { class: 'dl-orphan muted small' }, `К строке ${c.line}:`), comment(c)); placed.add(c.id); }
  for (const r of rows) {
    const can = r.line != null;
    out.push(h('div', { class: `dl ${r.kind === 'ctx' ? '' : r.kind}`, ...(can ? { 'data-no': r.line } : {}) },
      can ? h('button', { class: 'dl-plus no-drag', title: 'Замечание к строке', html: icon('plus', 11), onclick: (e) => { e.stopPropagation(); ui.open(r); } }) : null,
      r.text || ' '));
    if (!can) continue;
    for (const c of mine) if (!placed.has(c.id) && same(c, ui.file, r)) { out.push(comment(c)); placed.add(c.id); }
    const ed = ui.editing;
    if (ed && !ed.id && ed.file === ui.file && ed.line === r.line && (ed.kind === 'del') === (r.kind === 'del')) out.push(editor(''));
  }
  if (!rows.length) out.push(h('div', { class: 'dl meta' }, 'Нет текстовых изменений'));
  return out;
}

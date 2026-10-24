// Widgets: small live tools placed right on the canvas (clock, timer, checklist, calendar,
// agents, limits…). Each widget is a canvas object of type "widget" with data.kind; its state
// lives in node data, so it is saved, synced, duplicated and undone like any other object.
// One shared 1-second ticker drives every visible widget (off-screen ones are skipped).
import { h, icon, uid, toast, relTime, bus } from './util.js';
import { state } from './state.js';
import { popover, colorRow, cssColor, OBJECT_COLORS } from './pentools.js';
import { paintActivity } from './activity.js';

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return hh ? `${hh}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`; };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
function notify(title, body) {
  try { new Notification(title, { body, silent: false }); } catch {}
  toast(`${title}${body ? ': ' + body : ''}`);
}

// ---------- shared ticker ----------
const live = new Set();
setInterval(() => {
  const now = Date.now();
  for (const w of live) { if (!w.isCulled()) { try { w.tick?.(now); } catch (e) { console.error(e); } } }
}, 1000);

// ---------- widget kinds ----------
export const WIDGETS = {
  clock: {
    name: 'Часы', icon: 'clock', desc: 'Время и дата в стиле StandBy, можно выбрать часовой пояс', size: { w: 360, h: 200 },
    defaults: () => ({ tz: '' }),
    async mount(w) {
      const { clockMarkup, paintClock } = await import('./hub.js');
      const face = h('div', { class: 'wg-face hub-clock' });
      const zone = h('div', { class: 'wg-zone' });
      w.body.append(face, zone);
      let key = '';
      const render = () => {
        const tz = w.data.tz || undefined;
        let d = new Date(), hh, mm, date;
        try {
          const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
          hh = parts.find((p) => p.type === 'hour').value.padStart(2, '0').replace('24', '00'); mm = parts.find((p) => p.type === 'minute').value;
          date = d.toLocaleDateString('ru-RU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
        } catch { hh = pad2(d.getHours()); mm = pad2(d.getMinutes()); date = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }); }
        const k = hh + mm + date + (tz || '');
        if (k !== key) { key = k; face.innerHTML = clockMarkup(hh, mm, date); }
        zone.textContent = tz ? tz.split('/').pop().replace(/_/g, ' ') : '';
      };
      const repaint = () => paintClock(face);
      repaint();
      const mo = new MutationObserver(repaint); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const offS = state.on('settings', (k) => { if (String(k).startsWith('clock')) repaint(); });
      render();
      return {
        tick: render, update: render,
        destroy: () => { mo.disconnect(); offS?.(); },
        menu: () => [{ label: 'Часовой пояс…', icon: 'globe', onClick: async () => {
          const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['Europe/Moscow', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
          const { prompt } = await import('./util.js');
          const v = await prompt('Часовой пояс (пусто — как на компьютере)', w.data.tz || '', 'Например: Europe/London, Asia/Tokyo, America/New_York');
          if (v == null) return;
          const t = v.trim(); const found = !t ? '' : zones.find((z) => z.toLowerCase() === t.toLowerCase()) || zones.find((z) => z.toLowerCase().includes(t.toLowerCase()));
          if (t && !found) { toast('Такой часовой пояс не найден', 'warn'); return; }
          w.set({ tz: found || '' });
        } }],
      };
    },
  },

  timer: {
    name: 'Таймер', icon: 'hourglass', desc: 'Обратный отсчёт и помодоро, уведомит по окончании', size: { w: 260, h: 260 },
    defaults: () => ({ duration: 25 * 60000, endAt: 0, left: 25 * 60000, label: 'Фокус' }),
    mount(w) {
      const ring = h('div', { class: 'wg-ring' });
      const time = h('div', { class: 'wg-time' });
      const label = h('div', { class: 'wg-label txt' });
      const play = h('button', { class: 'wg-btn primary', title: 'Старт / пауза' });
      const reset = h('button', { class: 'wg-btn', title: 'Сбросить', html: icon('refresh', 15) });
      const presets = h('div', { class: 'wg-presets' }, ...[5, 15, 25, 50].map((m) => h('button', { class: 'wg-chip', onclick: (e) => { e.stopPropagation(); w.set({ duration: m * 60000, left: m * 60000, endAt: 0 }); } }, `${m}`)));
      w.body.append(h('div', { class: 'wg-timer' }, ring, h('div', { class: 'wg-center' }, label, time)), h('div', { class: 'wg-row' }, reset, play), presets);
      let fired = false;
      const left = () => (w.data.endAt ? Math.max(0, w.data.endAt - Date.now()) : w.data.left ?? w.data.duration);
      const render = () => {
        const l = left(), d = w.data.duration || 1, running = !!w.data.endAt;
        time.textContent = fmtDur(l);
        label.textContent = w.data.label || '';
        ring.style.setProperty('--p', String(1 - l / d));
        play.innerHTML = icon(running ? 'stop' : 'play', 16);
        w.el.classList.toggle('running', running);
        if (running && l <= 0 && !fired) { fired = true; w.set({ endAt: 0, left: 0 }); notify('Таймер', `${w.data.label || 'Время вышло'}`); w.el.classList.add('ring-done'); setTimeout(() => w.el.classList.remove('ring-done'), 4000); }
      };
      play.addEventListener('click', (e) => { e.stopPropagation(); fired = false; if (w.data.endAt) w.set({ left: left(), endAt: 0 }); else w.set({ endAt: Date.now() + (left() || w.data.duration), left: left() || w.data.duration }); });
      reset.addEventListener('click', (e) => { e.stopPropagation(); fired = false; w.set({ endAt: 0, left: w.data.duration }); });
      render();
      return {
        tick: render, update: render,
        edit: async () => { const { prompt } = await import('./util.js'); const v = await prompt('Подпись таймера', w.data.label || ''); if (v != null) w.set({ label: v.trim() }); },
        menu: () => [
          { label: 'Своё время…', icon: 'clock', onClick: async () => { const { prompt } = await import('./util.js'); const v = await prompt('Минут', String(Math.round((w.data.duration || 0) / 60000))); const m = Number(String(v || '').replace(',', '.')); if (m > 0) w.set({ duration: Math.round(m * 60000), left: Math.round(m * 60000), endAt: 0 }); } },
          { label: 'Подпись…', icon: 'pen', onClick: () => w.inst.edit() },
        ],
      };
    },
  },

  stopwatch: {
    name: 'Секундомер', icon: 'stopwatch', desc: 'Засечь, сколько заняла задача', size: { w: 260, h: 150 },
    defaults: () => ({ startAt: 0, acc: 0 }),
    mount(w) {
      const time = h('div', { class: 'wg-time big' });
      const play = h('button', { class: 'wg-btn primary' });
      const reset = h('button', { class: 'wg-btn', title: 'Сбросить', html: icon('refresh', 15) });
      w.body.append(time, h('div', { class: 'wg-row' }, reset, play));
      const total = () => (w.data.acc || 0) + (w.data.startAt ? Date.now() - w.data.startAt : 0);
      const render = () => { time.textContent = fmtDur(total()); play.innerHTML = icon(w.data.startAt ? 'stop' : 'play', 16); w.el.classList.toggle('running', !!w.data.startAt); };
      play.addEventListener('click', (e) => { e.stopPropagation(); if (w.data.startAt) w.set({ acc: total(), startAt: 0 }); else w.set({ startAt: Date.now() }); });
      reset.addEventListener('click', (e) => { e.stopPropagation(); w.set({ acc: 0, startAt: 0 }); });
      render();
      return { tick: render, update: render };
    },
  },

  checklist: {
    name: 'Чек-лист', icon: 'checklist', desc: 'Список дел с прогрессом', size: { w: 300, h: 320 },
    defaults: () => ({ title: 'Задачи', items: [] }),
    mount(w) {
      const title = h('div', { class: 'wg-title txt', contenteditable: 'false' });
      const bar = h('div', { class: 'wg-progress' }, h('i'));
      const list = h('div', { class: 'wg-list scrollable' });
      const add = h('input', { class: 'wg-add', placeholder: '+ Новая задача' });
      w.body.append(h('div', { class: 'wg-head' }, title, h('span', { class: 'wg-count' })), bar, list, add);
      const items = () => w.data.items || [];
      const render = () => {
        title.textContent = w.data.title || 'Задачи';
        const done = items().filter((x) => x.done).length;
        w.body.querySelector('.wg-count').textContent = items().length ? `${done}/${items().length}` : '';
        bar.firstChild.style.width = `${items().length ? (done / items().length) * 100 : 0}%`;
        list.replaceChildren(...items().map((it) => {
          const cb = h('button', { class: `wg-check${it.done ? ' on' : ''}`, html: it.done ? icon('check', 12) : '' });
          cb.addEventListener('click', (e) => { e.stopPropagation(); w.set({ items: items().map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) }, true); });
          const txt = h('span', { class: `wg-item-text${it.done ? ' done' : ''}` }, it.text);
          const del = h('button', { class: 'wg-del', title: 'Удалить', html: icon('x', 11) });
          del.addEventListener('click', (e) => { e.stopPropagation(); w.set({ items: items().filter((x) => x.id !== it.id) }, true); });
          return h('div', { class: 'wg-item' }, cb, txt, del);
        }));
      };
      add.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && add.value.trim()) { w.set({ items: [...items(), { id: uid('t'), text: add.value.trim(), done: false }] }, true); add.value = ''; }
        if (e.key === 'Escape') add.blur();
      });
      add.addEventListener('pointerdown', (e) => e.stopPropagation());
      render();
      return {
        update: render,
        edit: async () => { const { prompt } = await import('./util.js'); const v = await prompt('Название списка', w.data.title || ''); if (v != null) w.set({ title: v.trim() || 'Задачи' }, true); },
        menu: () => [
          { label: 'Переименовать…', icon: 'pen', onClick: () => w.inst.edit() },
          { label: 'Убрать выполненные', icon: 'checklist', onClick: () => w.set({ items: items().filter((x) => !x.done) }, true) },
        ],
      };
    },
  },

  calendar: {
    name: 'Календарь', icon: 'calendar', desc: 'Месяц с сегодняшним днём, заметки и цвет у дней', size: { w: 320, h: 320 },
    defaults: () => ({ offset: 0, notes: {} }),
    mount(w) {
      const head = h('div', { class: 'wg-cal-head' });
      const grid = h('div', { class: 'wg-cal' });
      w.body.append(head, grid);
      let dayKey = '';
      const notes = () => w.data.notes || {};
      // one day: { text, color }; an empty day is removed
      const setNote = (key, patch, undoable = true) => {
        const all = { ...notes() };
        const next = { ...(all[key] || {}), ...patch };
        if (!String(next.text || '').trim() && !next.color) delete all[key];
        else all[key] = { text: String(next.text || '').replace(/\s+$/, ''), color: next.color || null };
        w.set({ notes: all }, undoable);
      };
      const render = () => {
        const now = new Date();
        const base = new Date(now.getFullYear(), now.getMonth() + (w.data.offset || 0), 1);
        dayKey = now.toDateString() + (w.data.offset || 0);
        const prev = h('button', { class: 'wg-nav', html: icon('chevronRight', 14), title: 'Предыдущий месяц' });
        const next = h('button', { class: 'wg-nav', html: icon('chevronRight', 14), title: 'Следующий месяц' });
        prev.style.transform = 'scaleX(-1)';
        prev.addEventListener('click', (e) => { e.stopPropagation(); w.set({ offset: (w.data.offset || 0) - 1 }, false, true); });
        next.addEventListener('click', (e) => { e.stopPropagation(); w.set({ offset: (w.data.offset || 0) + 1 }, false, true); });
        const title = h('button', { class: 'wg-cal-title', title: 'К сегодняшнему дню' }, base.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, ''));
        title.addEventListener('click', (e) => { e.stopPropagation(); w.set({ offset: 0 }, false, true); });
        head.replaceChildren(prev, title, next);
        const cells = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d, i) => h('div', { class: `wg-dow${i > 4 ? ' we' : ''}` }, d));
        const first = (base.getDay() + 6) % 7, days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        for (let i = 0; i < first; i++) cells.push(h('div', { class: 'wg-day empty' }));
        for (let d = 1; d <= days; d++) {
          const isToday = d === now.getDate() && base.getMonth() === now.getMonth() && base.getFullYear() === now.getFullYear();
          const wd = (first + d - 1) % 7;
          const key = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
          const note = notes()[key];
          const cell = h('button', { class: `wg-day drag-ok${isToday ? ' today' : ''}${wd > 4 ? ' we' : ''}${note?.color ? ' marked' : ''}${note?.text ? ' has-note' : ''}` }, h('span', { class: 'wg-dn' }, String(d)));
          if (note?.color) cell.style.setProperty('--dc', cssColor(note.color, 'blue'));
          if (note?.text) cell.append(h('span', { class: 'wg-dot' }), h('span', { class: 'wg-dtext' }, note.text));
          const date = new Date(base.getFullYear(), base.getMonth(), d);
          const label = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
          cell.title = note?.text ? `${label}\n${note.text}` : `${label}: нажмите, чтобы добавить заметку или цвет`;
          cell.addEventListener('click', (e) => { e.stopPropagation(); openDayNote(cell, label, key); });
          cells.push(cell);
        }
        grid.replaceChildren(...cells);
      };
      // Apple-style popover: the day's note and its colour; the colour applies at once,
      // the text is saved when the popover closes (one undo step)
      const openDayNote = (anchor, label, key) => {
        const r = anchor.getBoundingClientRect();
        let finish = null;
        popover(anchor, 'wg-daypop', (pop, close) => {
          const start = notes()[key] || {};
          let color = start.color || null;
          const text = h('textarea', { class: 'wg-daytext', placeholder: 'Заметка на этот день…', rows: 3 });
          text.value = start.text || '';
          text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); close(); } });
          const colors = h('div', { class: 'wg-daycolors' });
          let picking = false;
          const pick = (c, undoable = true) => { color = c; setNote(key, { text: text.value, color: c }, undoable); paintColors(); if (!document.querySelector('.pb-picker')) text.focus(); };
          const paintColors = () => {
            const none = h('button', { class: `pb-swatch wg-nocolor${color ? '' : ' on'}`, title: 'Без цвета' }, h('span', { class: 'pb-dot' }));
            none.addEventListener('click', (e) => { e.stopPropagation(); pick(null); });
            colors.replaceChildren(none, ...colorRow({ colors: OBJECT_COLORS, current: color, onPick: (c) => pick(c), onLive: (c) => { pick(c, !picking); picking = true; }, onOpen: () => { picking = false; } }));
          };
          paintColors();
          const del = h('button', { class: 'btn sm danger', onclick: () => { text.value = ''; color = null; pop._deleted = true; close(); } }, 'Удалить');
          pop.append(
            h('div', { class: 'wg-dayhead' }, h('span', { class: 'wg-daylabel' }, label), h('span', { class: 'flex' }), h('button', { class: 'pk-tool', title: 'Закрыть', html: icon('x', 15), onclick: close })),
            text, colors,
            h('div', { class: 'wg-dayfoot' }, start.text || start.color ? del : h('span'), h('span', { class: 'flex' }), h('button', { class: 'btn sm primary', onclick: close }, 'Готово')));
          finish = () => {
            if (pop._deleted) { if (notes()[key]) setNote(key, { text: '', color: null }); return; }
            if (text.value.replace(/\s+$/, '') !== String(notes()[key]?.text || '')) setNote(key, { text: text.value, color });
          };
          setTimeout(() => { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }, 30);
        }, { above: r.top > innerHeight / 2, onClose: () => finish?.() });
      };
      render();
      return {
        update: render,
        tick: () => { const now = new Date(); if (now.toDateString() + (w.data.offset || 0) !== dayKey) render(); },
        menu: () => {
          const now = new Date(), base = new Date(now.getFullYear(), now.getMonth() + (w.data.offset || 0), 1);
          const prefix = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-`;
          const n = Object.keys(notes()).filter((k) => k.startsWith(prefix)).length;
          return [{ label: 'Очистить заметки месяца', icon: 'trash', disabled: !n, onClick: () => { const all = { ...notes() }; for (const k of Object.keys(all)) if (k.startsWith(prefix)) delete all[k]; w.set({ notes: all }, true); } }];
        },
      };
    },
  },

  countdown: {
    name: 'До события', icon: 'flag', desc: 'Сколько дней осталось до даты (релиз, дедлайн)', size: { w: 280, h: 170 },
    defaults: () => { const d = new Date(); d.setDate(d.getDate() + 14); return { title: 'Релиз', date: d.toISOString().slice(0, 10) }; },
    mount(w) {
      const num = h('div', { class: 'wg-time big' });
      const unit = h('div', { class: 'wg-label' });
      const title = h('div', { class: 'wg-title txt' });
      w.body.append(title, num, unit);
      const render = () => {
        const target = new Date(`${w.data.date}T00:00:00`);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const days = Math.round((target - today) / 86400000);
        title.textContent = w.data.title || 'Событие';
        num.textContent = isNaN(days) ? '—' : String(Math.abs(days));
        unit.textContent = isNaN(days) ? 'укажите дату' : days === 0 ? 'сегодня!' : `${plural(Math.abs(days), 'день', 'дня', 'дней')} ${days > 0 ? 'осталось' : 'прошло'} · ${target.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
        w.el.classList.toggle('soon', days >= 0 && days <= 3);
      };
      render();
      const edit = async () => {
        const { prompt } = await import('./util.js');
        const t = await prompt('Название события', w.data.title || ''); if (t == null) return;
        const d = await prompt('Дата (ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)', w.data.date || ''); if (d == null) return;
        let iso = d.trim(); const m = iso.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || isNaN(new Date(iso))) { toast('Не понял дату', 'warn'); return; }
        w.set({ title: t.trim() || 'Событие', date: iso }, true);
      };
      return { update: render, tick: render, edit, menu: () => [{ label: 'Изменить событие…', icon: 'pen', onClick: edit }] };
    },
  },

  counter: {
    name: 'Счётчик', icon: 'plus', desc: 'Число с кнопками − и +', size: { w: 220, h: 170 },
    defaults: () => ({ title: 'Счётчик', value: 0, step: 1 }),
    mount(w) {
      const title = h('div', { class: 'wg-title txt' });
      const val = h('div', { class: 'wg-time big' });
      const minus = h('button', { class: 'wg-btn', html: icon('minus', 16) });
      const plus = h('button', { class: 'wg-btn primary', html: icon('plus', 16) });
      w.body.append(title, val, h('div', { class: 'wg-row' }, minus, plus));
      const render = () => { title.textContent = w.data.title || 'Счётчик'; val.textContent = String(w.data.value || 0); };
      minus.addEventListener('click', (e) => { e.stopPropagation(); w.set({ value: (w.data.value || 0) - (w.data.step || 1) }, true); });
      plus.addEventListener('click', (e) => { e.stopPropagation(); w.set({ value: (w.data.value || 0) + (w.data.step || 1) }, true); });
      render();
      const edit = async () => { const { prompt } = await import('./util.js'); const v = await prompt('Название', w.data.title || ''); if (v != null) w.set({ title: v.trim() || 'Счётчик' }, true); };
      return { update: render, edit, menu: () => [{ label: 'Переименовать…', icon: 'pen', onClick: edit }, { label: 'Обнулить', icon: 'refresh', onClick: () => w.set({ value: 0 }, true) }] };
    },
  },

  agents: {
    name: 'Агенты', icon: 'sparkle', desc: 'Кто из агентов на этом canvas работает, ждёт ответа или закончил', size: { w: 320, h: 260 },
    defaults: () => ({}),
    mount(w) {
      const list = h('div', { class: 'wg-list scrollable' });
      w.body.append(h('div', { class: 'wg-head' }, h('div', { class: 'wg-title' }, 'Агенты'), h('span', { class: 'wg-count' })), list);
      let key = '';
      const render = async () => {
        const { NODE_TYPES } = await import('./nodes.js');
        const view = w.view;
        const nodes = view.doc.nodes.filter((n) => ['terminal', 'agentchat', 'chat'].includes(n.type));
        const rows = nodes.map((n) => { const def = NODE_TYPES[n.type]; const st = def.status?.(n, view.views.get(n.id)?.inst) || {}; return { n, title: def.title(n), st }; });
        const k = rows.map((r) => `${r.n.id}:${r.title}:${r.st.kind}:${r.st.label}`).join('|');
        // the same rows: only «what it is doing» changes (the time counts up), in place
        if (k === key) { list.querySelectorAll('.wg-agent-st').forEach((el, i) => paintActivity(el, rows[i]?.st)); return; }
        key = k;
        const busy = rows.filter((r) => r.st.kind === 'busy').length;
        w.body.querySelector('.wg-count').textContent = rows.length ? `${busy} из ${rows.length} работают` : '';
        list.replaceChildren(...(rows.length ? rows.map((r) => {
          const row = h('button', { class: `wg-agent st-${r.st.kind || 'idle'}`, title: 'Показать на canvas' }, h('span', { class: 'wg-dot' }), h('span', { class: 'wg-agent-name' }, r.title), h('span', { class: 'wg-agent-st' }));
          paintActivity(row.lastChild, r.st);
          row.addEventListener('click', (e) => { e.stopPropagation(); view.focusNode(r.n.id); });
          return row;
        }) : [h('div', { class: 'wg-empty' }, 'На этом canvas пока нет агентов')]));
      };
      render();
      return { tick: render, update: render };
    },
  },

  limits: {
    name: 'Лимиты', icon: 'gauge', desc: 'Сколько осталось в подписках и у API-ключей', size: { w: 340, h: 300 },
    defaults: () => ({}),
    async mount(w) {
      const { limits, limitsPanel } = await import('./hub.js');
      const panel = limitsPanel();
      panel.el.classList.add('scrollable');
      w.body.append(panel.el);
      if (!limits.at) limits.refresh();
      return { destroy: () => panel.destroy?.() };
    },
  },
};

export const WIDGET_ORDER = ['clock', 'timer', 'checklist', 'calendar', 'countdown', 'agents', 'limits', 'stopwatch', 'counter'];

// ---------- the canvas object ----------
export function mountWidget({ node, view, body, el }) {
  const def = WIDGETS[node.data.kind];
  const root = h('div', { class: `widget wk-${node.data.kind || 'unknown'}` });
  const head = h('div', { class: 'wg-chrome' }, h('span', { html: icon(def?.icon || 'grid', 12) }), h('span', {}, def?.name || 'Виджет'));
  const wbody = h('div', { class: 'wg-body' });
  root.append(head, wbody);
  body.append(root);
  // dragging the widget by a button (a day, a checkbox) must not press that button on release
  let downAt = null;
  root.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; }, true);
  root.addEventListener('click', (e) => { if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { e.stopPropagation(); e.preventDefault(); } }, true);
  const w = {
    get data() { return (view.node(node.id) || node).data; },
    body: wbody, el: root, view, node,
    isCulled: () => !!view.views.get(node.id)?.culled,
    // set(patch, undoable, local): local-only changes (calendar page) are still saved but quietly
    set(patch, undoable = false) { view.updateNode(node.id, { data: patch }, { checkpoint: undoable }); },
    inst: null,
  };
  if (!def) { wbody.append(h('div', { class: 'wg-empty' }, `Виджет «${node.data.kind}» недоступен в этой версии`)); return {}; }
  const api = { update() {}, destroy() { live.delete(w); w.inst?.destroy?.(); }, menu: () => w.inst?.menu?.() || [], edit: (e) => w.inst?.edit?.(e) };
  Promise.resolve(def.mount(w)).then((inst) => {
    w.inst = inst || {};
    api.update = (n) => { try { w.inst.update?.(n); } catch (e) { console.error(e); } };
    w.tick = (now) => w.inst.tick?.(now);
    if (w.inst.tick) live.add(w);
  }).catch((e) => { console.error(e); wbody.append(h('div', { class: 'wg-empty' }, `Ошибка виджета: ${e.message}`)); });
  return api;
}

// ---------- picker ----------
export function openWidgetPicker(anchor, onPick) {
  document.querySelector('.wg-picker')?.remove();
  const pop = h('div', { class: 'menu wg-picker' });
  pop.append(h('div', { class: 'wg-picker-head' }, 'Виджеты'));
  const grid = h('div', { class: 'wg-picker-grid' });
  for (const kind of WIDGET_ORDER) {
    const d = WIDGETS[kind];
    const b = h('button', { class: 'wg-card' }, h('span', { class: 'wg-card-ic', html: icon(d.icon, 20) }), h('span', { class: 'wg-card-name' }, d.name), h('span', { class: 'wg-card-desc' }, d.desc));
    b.addEventListener('click', () => { close(); onPick(kind); });
    grid.append(b);
  }
  pop.append(grid);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 10)}px`;
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', key, true); };
  const off = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', key, true); }, 0);
}

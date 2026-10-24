// «Пока вас не было»: you come back after a while away and agents finished meanwhile — a card says
// who finished and how (how long it took, how many files changed), who failed or waits for a
// decision; a click flies to the window. Away means: the app was in the background or minimized,
// nobody touched the mouse and keys (you walked off with the app in front), or the app was closed.
// Every answer that ends is logged here (nodes.js reportEnd — also the ones that ended on screen:
// nobody may have been looking) together with runs that finished while the app was closed (app.js).
// Settings → Агенты → «Сводка «Пока вас не было»»: after 5 / 15 / 30 / 60 minutes or never
// (state.settings.awayMinutes, 5 by default).
import { h, icon, badge, bus } from './util.js';
import { state } from './state.js';
import { INBOX_KINDS, where, badgeOf } from './inbox.js';
import { elapsed, filesWord } from './activity.js';

const SEEN_KEY = 'vt:lastSeen';
const RANK = { wait: 0, error: 1, interrupted: 2, done: 3, background: 4 };
const KEEP = 24 * 3600_000;
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'pointermove'];

export const awayMs = () => { const m = Number(state.settings?.awayMinutes ?? 5); return m > 0 ? m * 60_000 : 0; };
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const writeSeen = (t = Date.now()) => { try { localStorage.setItem(SEEN_KEY, String(t)); } catch {} };

class Away {
  constructor() {
    this.log = []; // answers that ended: { nodeId, docId, kind, title, text, detail, files, type, agentId, provider, at }
    this.since = null; // when the current absence began
    this.last = Date.now(); // the last mouse / key activity in the focused app
    this.card = null;
  }
  // an answer ended (kind as in «Ждут вас»: done / wait / error / interrupted / background)
  record(e) {
    if (!e?.nodeId || !INBOX_KINDS[e.kind]) return;
    const now = Date.now();
    this.log = [...this.log.filter((x) => now - x.at < KEEP), { ...e, at: now }].slice(-300);
    bus.emit('away');
  }
  // one row per window (its newest answer; how many answers there were), most important first
  entries(since, until = Infinity) {
    const by = new Map();
    for (const e of this.log) {
      if (e.at < since || e.at > until) continue;
      const prev = by.get(e.nodeId);
      by.set(e.nodeId, { ...e, answers: (prev?.answers || 0) + 1 });
    }
    return [...by.values()].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || b.at - a.at);
  }
  leave(at = Date.now()) { if (this.since == null) this.since = at; }
  // you are back: a card when you were away long enough and something ended meanwhile
  back(now = Date.now()) {
    if (this.hold && now < this.hold) return false; // just started: answers picked up from before come in first
    const since = this.since;
    this.since = null;
    this.last = now;
    const ms = awayMs();
    if (since == null || !ms || now - since < ms) return false;
    if (!this.entries(since).length) return false;
    this.show(since, now);
    return true;
  }

  // listeners: focus and visibility of the window, activity, the time the app was last open
  start(app) {
    this.app = app;
    const activeNow = () => document.hasFocus() && !document.hidden;
    // focus moved into a web page object (an iframe) is still the app
    window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus() && !/^(IFRAME|WEBVIEW)$/.test(document.activeElement?.tagName || '')) this.leave(); }, 0));
    window.addEventListener('focus', () => this.back());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.leave(); else if (document.hasFocus()) this.back(); });
    let tick = 0;
    const active = () => {
      if (!activeNow()) return;
      const now = Date.now();
      if (this.since != null) { this.back(now); return; }
      if (now - tick >= 1000) { tick = now; this.last = now; } // the time of the last touch, cheaply
    };
    for (const ev of ACTIVITY) window.addEventListener(ev, active, { capture: true, passive: true });
    // nobody touched anything for a while with the app in front: away since the last touch
    setInterval(() => {
      const ms = awayMs();
      if (ms && this.since == null && activeNow() && Date.now() - this.last >= ms) this.leave(this.last);
      if (activeNow()) writeSeen();
    }, 15_000);
    window.addEventListener('pagehide', () => writeSeen());
    // the app was closed: away since it was last open; answers picked up after the start (and runs
    // finished while it was closed) are logged in the first seconds, then the card
    const seen = readSeen();
    writeSeen();
    if (seen && awayMs() && Date.now() - seen >= awayMs()) {
      this.since = seen;
      this.hold = Date.now() + 5000;
      // the app has just been opened, so you are here (even if another window has the focus)
      setTimeout(() => { this.hold = 0; if (this.since === seen && !document.hidden) this.back(); }, 5000);
    }
  }

  // ---------------- the card ----------------
  show(since, until) {
    this.close();
    this.shown = { since, until };
    const list = h('div', { class: 'away-list' });
    const sum = h('div', { class: 'away-sum' });
    const close = () => this.close();
    const card = h('div', { class: 'popover away-card', role: 'dialog' },
      h('div', { class: 'away-head' },
        h('span', { class: 'away-ic', html: icon('bell', 15) }),
        h('b', {}, `Пока вас не было · ${elapsed(until - since)}`),
        h('span', { class: 'flex' }),
        h('button', { class: 'icon-btn sm', title: 'Закрыть (Esc)', html: icon('x', 13), onclick: close })),
      sum, list,
      h('div', { class: 'away-foot' },
        h('button', { class: 'btn sm', title: 'Включить снова: Настройки → Агенты', onclick: () => { state.setSetting('awayMinutes', 0); close(); } }, 'Больше не показывать'),
        h('span', { class: 'flex' }),
        h('button', { class: 'btn sm primary', onclick: close }, 'Понятно')));
    const render = () => {
      const rows = this.entries(since); // answers that end while the card is open are added too
      const n = (k) => rows.filter((r) => r.kind === k).length;
      const files = rows.reduce((t, r) => t + (r.files || 0), 0);
      const done = n('done') + n('background');
      sum.textContent = [
        done ? `закончили: ${done}` : '',
        files ? `изменено ${files} ${filesWord(files)}` : '',
        n('error') ? `ошибки: ${n('error')}` : '',
        n('wait') ? `ждут решения: ${n('wait')}` : '',
        n('interrupted') ? `прервались: ${n('interrupted')}` : '',
      ].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase());
      list.replaceChildren(...rows.slice(0, 8).map((r) => {
        const b = badgeOf(r), k = INBOX_KINDS[r.kind];
        const place = r.docId !== state.doc?.id ? where(r.docId) : '';
        const line = r.kind === 'error' || r.kind === 'wait' || r.kind === 'interrupted' ? r.text || r.detail : r.detail || r.text;
        return h('button', { class: 'away-row', title: 'Показать окно', onclick: () => { close(); this.app?.openInboxItem({ nodeId: r.nodeId, docId: r.docId }); } },
          badge(b.mono, b.color, 22, b.dark),
          h('div', { class: 'away-main' },
            h('div', { class: 'away-top' }, h('span', { class: 'away-title' }, r.title), h('span', { class: `inbox-kind ${k.cls}` }, k.label)),
            line ? h('div', { class: 'away-line' }, line) : null,
            h('div', { class: 'away-meta' }, [place, r.answers > 1 ? `ответов: ${r.answers}` : ''].filter(Boolean).join(' · '))));
      }), ...(rows.length > 8 ? [h('div', { class: 'away-more muted small' }, `и ещё ${rows.length - 8} — в «Ждут вас» (колокольчик)`)] : []));
    };
    render();
    const off = bus.on('away', render);
    // Esc closes it even from a chat input (which keeps its keys to itself), not over a dialog
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-back')) close(); };
    document.addEventListener('keydown', esc, true);
    this.card = { el: card, off: () => { off(); document.removeEventListener('keydown', esc, true); } };
    document.body.append(card);
  }
  close() { if (!this.card) return; this.card.off(); this.card.el.remove(); this.card = null; }
  // the last card again (command palette)
  showLast() {
    if (this.shown) { this.show(this.shown.since, this.shown.until); return true; }
    return false;
  }
}

export const away = new Away();

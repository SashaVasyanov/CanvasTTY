// FPS meter and the built-in smoothness test.
import { h, modal, toast } from './util.js';
import { state, native } from './state.js';

// ---------------- FPS meter (corner chip) ----------------
let meter = null;
export function setFpsMeter(on) {
  if (!on) { if (meter) { cancelAnimationFrame(meter.raf); meter.el.remove(); meter = null; } return; }
  if (meter) return;
  const el = h('div', { class: 'fps-meter', title: 'Кадров в секунду (Ctrl+Shift+F — скрыть)' });
  document.body.append(el);
  const m = { el, raf: 0, frames: 0, worst: 0, last: performance.now(), t0: performance.now() };
  const tick = (t) => {
    const d = t - m.last; m.last = t; m.frames++;
    if (d > m.worst) m.worst = d;
    if (t - m.t0 >= 500) {
      const fps = Math.round((m.frames * 1000) / (t - m.t0));
      el.textContent = `${fps} FPS · худший кадр ${Math.round(m.worst)} мс`;
      el.className = `fps-meter ${fps >= 58 ? 'good' : fps >= 45 ? 'mid' : 'bad'}`;
      m.frames = 0; m.worst = 0; m.t0 = t;
    }
    m.raf = requestAnimationFrame(tick);
  };
  m.raf = requestAnimationFrame(tick);
  meter = m;
}
export function toggleFpsMeter() {
  const on = !state.settings.fps;
  state.setSetting('fps', on);
  setFpsMeter(on);
  toast(on ? 'Счётчик FPS включён (Ctrl+Shift+F)' : 'Счётчик FPS выключен');
}

// ---------------- smoothness test ----------------
const frameLoop = (ms, step) => new Promise((res) => {
  const times = [];
  let t0 = 0, last = 0;
  const f = (t) => {
    if (!t0) { t0 = last = t; }
    else { times.push(t - last); last = t; }
    step((t - t0) / 1000);
    if (t - t0 < ms) requestAnimationFrame(f); else res(times);
  };
  requestAnimationFrame(f);
});
const stats = (times) => {
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  return { fps: Math.round(1000 / avg), low1: Math.round(1000 / Math.max(p99, 1)), worst: Math.round(sorted[sorted.length - 1] || 0), janky: times.filter((t) => t > 20).length, frames: times.length };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runPerfTest(app) {
  const c = app.canvas;
  const saved = { ...c.vp };
  const m = modal({ title: 'Тест плавности', body: h('div', { class: 'perf-run' }, 'Идёт тест: canvas будет двигаться сам примерно 12 секунд. Не трогайте мышь.'), width: 460 });
  await wait(400);
  m.box.parentElement.style.visibility = 'hidden';
  const results = {};
  try {
    c.clearSelection(); c.fit(); await wait(600);
    const base = { ...c.vp };
    // 1. panning
    results.pan = stats(await frameLoop(2500, (k) => { c.vp.x = base.x + Math.sin(k * 3) * 400; c.vp.y = base.y + Math.cos(k * 2) * 200; c.requestViewport(); }));
    await wait(400);
    // 2. zoom in and out around the centre
    const r = c.rect();
    results.zoom = stats(await frameLoop(2500, (k) => { const target = base.z * (1 + 0.9 * Math.sin(k * 2.4) ** 2); c.zoomAt(r.left + r.width / 2, r.top + r.height / 2, target / c.vp.z); }));
    await wait(500);
    // 3. dragging an object (real pointer events through the normal code path)
    c.zoomTo(1); await wait(300);
    let tmp = null;
    let n = c.doc.nodes.find((q) => q.type === 'sticky' && !q.locked);
    if (!n) { const cw = c.centerWorld(); tmp = n = c.addNode('sticky', { x: cw.x, y: cw.y, data: { text: 'тест' } }, { select: false, checkpoint: false }); }
    c.focusNode?.(n.id); await wait(700);
    const el = c.views.get(n.id).el;
    const box = el.getBoundingClientRect();
    const sx = box.left + box.width / 2, sy = box.top + Math.min(30, box.height / 2);
    const ev = (type, x, y, buttons) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    el.dispatchEvent(ev('pointerdown', sx, sy, 1));
    let px = sx, py = sy;
    results.drag = stats(await frameLoop(2500, (k) => { px = sx + Math.sin(k * 3) * 300; py = sy + Math.sin(k * 4.5) * 160; window.dispatchEvent(ev('pointermove', px, py, 1)); }));
    window.dispatchEvent(ev('pointerup', px, py, 0));
    c.undo();
    if (tmp) c.removeNodes([tmp.id], { checkpoint: false });
  } catch (e) { console.error(e); results.error = String(e.message || e); }
  Object.assign(c.vp, saved); c.applyViewport();
  m.box.parentElement.style.visibility = '';
  let info = {};
  try { info = (await native.perf?.info?.()) || {}; } catch {}
  const report = { date: new Date().toISOString(), version: state.info?.version, window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, nodes: c.doc.nodes.length, results, ...info };
  let savedTo = '';
  try { savedTo = (await native.perf?.save?.(report)) || ''; } catch {}
  showReport(m, report, savedTo);
}

function showReport(m, rep, savedTo) {
  const names = { pan: 'Перемещение по canvas', zoom: 'Масштаб', drag: 'Перетаскивание объекта' };
  const rows = Object.entries(names).filter(([k]) => rep.results[k]).map(([k, label]) => {
    const r = rep.results[k];
    const cls = r.fps >= 58 && r.low1 >= 45 ? 'good' : r.fps >= 45 ? 'mid' : 'bad';
    return h('tr', {}, h('td', {}, label), h('td', { class: `perf-num ${cls}` }, `${r.fps}`), h('td', { class: 'perf-num' }, `${r.low1}`), h('td', { class: 'perf-num' }, `${r.worst} мс`));
  });
  const g = rep.gpu || {};
  const hw = g.gpu_compositing === 'enabled' && /enabled/.test(g.rasterization || '');
  const gpuName = rep.gpuInfo?.gpuDevice?.find?.((d) => d.active)?.deviceString || rep.gpuInfo?.gpuDevice?.[0]?.deviceString || '';
  const disp = (rep.displays || []).map((d) => `${d.size.width}×${d.size.height} @${d.scale}x, ${Math.round(d.hz || 0)} Гц`).join('; ');
  const body = h('div', { class: 'perf-report' },
    h('table', { class: 'perf-table' },
      h('tr', {}, h('th', {}, ''), h('th', {}, 'FPS'), h('th', {}, '1% low'), h('th', {}, 'Худший кадр')),
      ...rows),
    rep.results.error ? h('div', { class: 'perf-warn' }, `Ошибка теста: ${rep.results.error}`) : null,
    h('div', { class: 'perf-meta' },
      h('div', {}, h('b', {}, 'Видеокарта: '), gpuName || 'неизвестно', hw ? ' — ускорение включено' : ''),
      !hw && rep.gpu ? h('div', { class: 'perf-warn' }, 'Аппаратное ускорение выключено или недоступно: интерфейс рисуется процессором. Обновите драйвер видеокарты.') : null,
      disp ? h('div', {}, h('b', {}, 'Экран: '), disp) : null,
      h('div', {}, h('b', {}, 'Окно: '), `${rep.window.w}×${rep.window.h}, масштаб ${rep.window.dpr}, объектов на canvas: ${rep.nodes}`),
      savedTo ? h('div', { class: 'muted small' }, `Отчёт сохранён: ${savedTo}`) : null),
  );
  m.content.replaceChildren(body);
}

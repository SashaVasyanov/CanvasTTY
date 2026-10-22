// Helpers for the canvas specs (objects, zoom, drawing, colours). Coordinates are taken from the
// page (boxes, the canvas viewport), never hard-coded screen pixels, so the tests hold at any DPI.
import { expect } from '../fixtures.mjs';

// world point → page point
export const toPage = (page, x, y) => page.evaluate(([x, y]) => {
  const c = window.__app.canvas; const r = c.rect(); const s = c.toScreen(x, y);
  return { x: r.left + s.x, y: r.top + s.y };
}, [x, y]);

// a page point on empty canvas: the bottom-right corner of the canvas, away from objects and panels
export const emptySpot = (page) => page.evaluate(() => {
  const r = window.__app.canvas.rect();
  return { x: r.right - 40, y: r.top + r.height * 0.55 };
});

// the view is at rest: contents laid out at the current zoom (crisp text), no gesture running
export async function waitRest(page) {
  await expect.poll(() => page.evaluate(() => {
    const c = window.__app.canvas;
    return !c.root.classList.contains('vp-moving') && c.layoutZoom === c.vp.z && !c._vpRaf;
  })).toBe(true);
}

// set the viewport (world (0,0) at canvas point x,y; zoom z) and wait until it is at rest
export async function view(page, { x = 300, y = 150, z = 1 } = {}) {
  await page.evaluate(({ x, y, z }) => { const c = window.__app.canvas; c.vp.x = x; c.vp.y = y; c.vp.z = z; c.applyViewport(); }, { x, y, z });
  await waitRest(page);
}

export async function center(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element is not visible');
  return { ...b, x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export const menuItem = (page, label) => page.locator('.menu .menu-item', { hasText: label }).first();

// a freehand stroke through page points
export async function stroke(page, points, { modifiers = [] } = {}) {
  const m = page.mouse;
  for (const k of modifiers) await page.keyboard.down(k);
  await m.move(points[0].x, points[0].y); await m.down();
  for (const p of points.slice(1)) await m.move(p.x, p.y);
  await m.up();
  for (const k of modifiers) await page.keyboard.up(k);
}
// a wavy line from a page point to the right
export const wave = (x, y, { dx = 300, amp = 30, n = 30 } = {}) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x + (i * dx) / n, y: y + Math.sin(i / 4) * amp }));

// vault helpers (the mock vault in the browser)
export const vault = {
  create: (page, folder, name, text) => page.evaluate(async ([folder, name, text]) => {
    const { native } = await import('/js/state.js');
    const p = await native.vault.create(folder, name, text);
    await (await import('/js/vaultIndex.js')).vaultIndex.refresh();
    return p;
  }, [folder, name, text]),
  paths: (page, prefix = '') => page.evaluate(async (prefix) => {
    const { native } = await import('/js/state.js');
    return (await native.vault.index()).notes.map((n) => n.path).filter((p) => p.startsWith(prefix)).sort();
  }, prefix),
  read: (page, p) => page.evaluate(async (p) => (await import('/js/state.js')).native.vault.read(p), p),
  write: (page, p, text) => page.evaluate(async ([p, text]) => (await import('/js/state.js')).native.vault.write(p, text), [p, text]),
};

// a setting of the app
export const setting = (page, k) => page.evaluate(async (k) => (await import('/js/state.js')).state.settings[k], k);
export const setSetting = (page, k, v) => page.evaluate(async ([k, v]) => (await import('/js/state.js')).state.setSetting(k, v), [k, v]);

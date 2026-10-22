// Drawing (P): pen, marker, pencil and eraser with their own colour / width / opacity, the
// Spectrum colour window, straight lines with Shift; a drawing is an ordinary canvas object.
import { test, expect } from './fixtures.mjs';
import { toPage, stroke, wave, waitRest, setting } from './helpers/canvas.mjs';

test.beforeEach(async ({ app, page }) => { await waitRest(page); });

const drawings = (app) => app.nodes('drawing');
const summary = (n) => `${n.data.tool} ${n.data.color} w${n.data.width} o${n.data.opacity}`;
// a wavy line starting at a world point
const drawAt = async (page, x, y, opts) => { const p = await toPage(page, x, y); await stroke(page, wave(p.x, p.y, opts)); };

test('P: панель рисования, линия, красный цвет и толщина, точка, прямая с Shift', async ({ app, page }) => {
  await page.keyboard.press('p');
  await expect(page.locator('.pen-bar')).toHaveClass(/\bshow\b/);
  expect(await page.evaluate(() => window.__app.canvas.tool)).toBe('pencil');

  await drawAt(page, -100, 50, { dx: 360, amp: 60, n: 60 });
  let list = await drawings(app);
  expect(list).toHaveLength(1);
  expect(summary(list[0])).toBe('pen auto w3 o1');
  expect(list[0].data.pts.length, 'линия, а не две точки').toBeGreaterThan(5);

  await page.locator('.pen-bar .pb-swatch[title="Красный"]').click();
  await page.locator('.pen-bar .pb-tool.t-pen').click();
  await expect(page.locator('.pb-width'), 'повторное нажатие на инструмент — толщина').toBeVisible();
  await page.locator('.pb-width .pw-dot').nth(3).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pb-width')).toHaveCount(0);
  await drawAt(page, -80, 250, { dx: 300, amp: 20, n: 30 });
  list = await drawings(app);
  expect(summary(list[1])).toBe('pen red w8 o1');

  const dot = await toPage(page, 500, 0);
  await page.mouse.click(dot.x, dot.y);
  list = await drawings(app);
  expect(list).toHaveLength(3);
  expect(list[2].data.pts, 'клик ставит точку').toHaveLength(1);

  const a = await toPage(page, -100, 380);
  await stroke(page, Array.from({ length: 21 }, (_, i) => ({ x: a.x + i * 20, y: a.y + (i % 3) * 7 })), { modifiers: ['Shift'] });
  list = await drawings(app);
  expect(list).toHaveLength(4);
  expect(list[3].data.pts, 'с Shift — прямая из двух точек').toHaveLength(2);
  expect(await page.evaluate(() => window.__app.canvas.tool), 'инструмент остаётся включённым').toBe('pencil');
});

test('рисунок — обычный объект: клик по линии выделяет её, мимо — то, что под ней; толщина, перенос, удаление', async ({ app, page }) => {
  const st = await app.add('sticky', { x: -100, y: -100, w: 200, h: 200, data: { text: 'под рисунком' } });
  await page.keyboard.press('p');
  await drawAt(page, -200, 0, { dx: 360, amp: 60, n: 60 });
  await page.keyboard.press('v');
  const d = (await drawings(app))[0];
  const pts = d.data.pts.map(([u, v]) => [d.x + u * d.w, d.y + v * d.h]);
  // on the line, over the sticky
  const on = pts.reduce((best, p) => (Math.abs(p[0]) + Math.abs(p[1]) < Math.abs(best[0]) + Math.abs(best[1]) ? p : best));
  // inside the drawing's box and over the sticky, as far from the line as possible
  const segDist = (x, y) => Math.min(...pts.slice(1).map((b, i) => { const a = pts[i]; const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }));
  let off = null, far = 0;
  for (let x = Math.max(d.x, -90); x <= Math.min(d.x + d.w, 90); x += 5) for (let y = Math.max(d.y, -90); y <= Math.min(d.y + d.h, 90); y += 5) { const k = segDist(x, y); if (k > far) { far = k; off = [x, y]; } }
  expect(far, 'есть место в рамке рисунка вдали от линии').toBeGreaterThan(25);

  const onP = await toPage(page, ...on), offP = await toPage(page, ...off);
  await page.mouse.click(onP.x, onP.y);
  expect(await app.selection()).toEqual([d.id]);
  await page.mouse.click(offP.x, offP.y);
  expect(await app.selection(), 'клик в рамке рисунка мимо линии берёт стикер под ним').toEqual([st]);

  await page.mouse.click(onP.x, onP.y);
  await page.locator('.sel-toolbar .st-wdot').last().click();
  expect((await app.node(d.id)).data.width).toBe(14);
  await page.keyboard.press('Control+z');
  expect((await app.node(d.id)).data.width).toBe(3);

  await app.drag(onP, { x: onP.x + 50, y: onP.y + 50 });
  const moved = await app.node(d.id);
  expect(Math.abs(moved.x - d.x - 50)).toBeLessThanOrEqual(8);
  expect(Math.abs(moved.y - d.y - 50)).toBeLessThanOrEqual(8);
  expect(moved.w).toBe(d.w);
  await page.keyboard.press('Delete');
  expect(await drawings(app)).toEqual([]);
  expect(await app.node(st)).toBeTruthy();
});

test('ручка, маркер и карандаш помнят свои цвет, толщину и прозрачность', async ({ app, page }) => {
  await page.keyboard.press('p');
  await drawAt(page, -100, 0);
  await page.locator('.pen-bar .pb-swatch[title="Синий"]').click();
  await drawAt(page, -100, 60);
  await page.locator('.pen-bar .pb-tool.t-marker').click();
  await drawAt(page, -100, 120);
  await page.locator('.pen-bar .pb-tool.t-pencil').click();
  await page.locator('.pen-bar .pb-swatch[title="Красный"]').click();
  await drawAt(page, -100, 180);
  await page.locator('.pen-bar .pb-tool.t-pencil').click();
  await page.locator('.pb-width .pw-dot').nth(4).click();
  await page.keyboard.press('Escape');
  await drawAt(page, -100, 240);
  expect((await drawings(app)).map(summary)).toEqual([
    'pen auto w3 o1', 'pen blue w3 o1', 'marker yellow w20 o0.4', 'pencil red w2 o0.85', 'pencil red w8 o0.85',
  ]);
  await expect(page.locator('.pen-bar .pb-tool.t-pencil')).toHaveClass(/\bon\b/);
});

test('спектр: выбранный цвет идёт в линию и сохраняется в «Мои цвета»', async ({ app, page }) => {
  await page.keyboard.press('p');
  await page.locator('.pen-bar .pb-spectrum').click();
  await expect(page.locator('.pb-picker')).toBeVisible();
  const area = await page.locator('.pk-spectrum').boundingBox();
  await page.mouse.click(area.x + area.width * 0.75, area.y + area.height * 0.4);
  const hex = await page.locator('.pk-hex').inputValue();
  expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  expect((await setting(page, 'pens')).pen.color).toBe(hex.toLowerCase());
  await page.locator('.pk-add').click();
  expect(await setting(page, 'penFavorites')).toEqual([hex.toLowerCase()]);
  await expect(page.locator('.pk-favs .pb-swatch')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pb-picker')).toHaveCount(0);
  await expect(page.locator('.pen-bar .pb-spectrum'), 'свой цвет отмечен на радужном кружке').toHaveClass(/\bon\b/);
  await drawAt(page, -100, 100);
  expect((await drawings(app))[0].data.color).toBe(hex.toLowerCase());
});

test('ластик (E) стирает целиком линии, которых коснулся; Ctrl+Z возвращает их', async ({ app, page }) => {
  await page.keyboard.press('p');
  for (const y of [0, 80, 220]) await drawAt(page, -100, y, { dx: 300, amp: 0, n: 20 });
  expect(await drawings(app)).toHaveLength(3);
  await page.keyboard.press('e');
  expect(await setting(page, 'penTool')).toBe('eraser');
  await expect(page.locator('.pen-bar .pb-tool.t-eraser')).toHaveClass(/\bon\b/);
  const a = await toPage(page, 50, -40), b = await toPage(page, 50, 130);
  await stroke(page, Array.from({ length: 13 }, (_, i) => ({ x: a.x, y: a.y + ((b.y - a.y) * i) / 12 })));
  const left = await drawings(app);
  expect(left).toHaveLength(1);
  expect(left[0].y, 'осталась только нетронутая нижняя линия').toBeGreaterThan(150);
  await page.keyboard.press('Control+z');
  expect(await drawings(app)).toHaveLength(3);
});

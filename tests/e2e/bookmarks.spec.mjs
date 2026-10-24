// View bookmarks (renderer/js/bookmarks.js): Ctrl+Shift+1…9 remembers the place and zoom of this
// canvas, Ctrl+1…9 flies back; named after the area in the middle of the screen; renamed and deleted
// from the menu; every canvas has its own; kept in the canvas file (also after a reload); listed in
// the command palette. Merging between computers: tests/unit/sync.test.mjs.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat } from './helpers/chat.mjs';
import { reloadApp, setViewport } from './helpers/notes.mjs';

// the world point in the middle of the screen and the zoom
const view = (page) => page.evaluate(() => { const c = window.__app.canvas, r = c.rect(); return { x: Math.round((r.width / 2 - c.vp.x) / c.vp.z), y: Math.round((r.height / 2 - c.vp.y) / c.vp.z), z: Math.round(c.vp.z * 100) / 100 }; });
// look at the world point (x, y) at zoom z
const lookAt = (page, x, y, z = 1) => page.evaluate(([x, y, z]) => { const c = window.__app.canvas, r = c.rect(); c.vp.z = z; c.vp.x = r.width / 2 - x * z; c.vp.y = r.height / 2 - y * z; c.applyViewport(); }, [x, y, z]);
const marks = (page) => page.evaluate(() => (window.__app.canvas.doc.bookmarks || []).map((b) => ({ slot: b.slot, name: b.name })));
const lastToast = (page) => page.locator('.toast').last();
const near = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.z - b.z) <= 0.01;

test('Ctrl+Shift+1 запоминает место и масштаб, Ctrl+1 возвращает; имя — по области в центре экрана', async ({ app, page }) => {
  await app.add('frame', { x: 1800, y: 900, w: 900, h: 600, data: { title: 'Сборка' } });
  await lookAt(page, 2200, 1200, 0.6);
  await app.idle();
  await page.keyboard.press('Control+Shift+Digit1');
  expect(await marks(page)).toEqual([{ slot: 1, name: 'Сборка' }]);
  await expect(lastToast(page)).toContainText('Закладка 1 «Сборка» запомнена — вернуться: Ctrl+1');

  await lookAt(page, -3000, 400, 1.5);
  await page.keyboard.press('Control+Digit1');
  await expect.poll(async () => near(await view(page), { x: 2200, y: 1200, z: 0.6 }), { message: 'вернулись к закладке' }).toBe(true);

  // nothing in the middle: «Вид 2»; a window nearby: its title
  await lookAt(page, -5000, -5000);
  await page.keyboard.press('Control+Shift+Digit2');
  await addAgentChat(app, { x: 400, y: 300, data: { title: 'Ночная задача' } });
  await lookAt(page, 600, 600);
  await page.keyboard.press('Control+Shift+Digit3');
  expect(await marks(page)).toEqual([{ slot: 1, name: 'Сборка' }, { slot: 2, name: 'Вид 2' }, { slot: 3, name: 'Ночная задача' }]);

  // an empty slot says how to fill it
  await page.keyboard.press('Control+Digit7');
  await expect(lastToast(page)).toContainText('Закладки 7 на этом холсте нет. Запомнить этот вид — Ctrl+Shift+7');
});

test('та же точка в центре на экране другого размера; после перезагрузки закладки на месте', async ({ app, page }) => {
  await lookAt(page, 1000, -700, 0.8);
  await page.keyboard.press('Control+Shift+Digit4');
  await page.evaluate(async () => (await import('/js/state.js')).state.saveDoc.flush()); // the canvas file is written
  await page.setViewportSize({ width: 900, height: 640 });
  await reloadApp(page);
  await lookAt(page, 0, 0, 1);
  await page.keyboard.press('Control+Digit4');
  await expect.poll(async () => near(await view(page), { x: 1000, y: -700, z: 0.8 })).toBe(true);
  expect((await marks(page)).map((b) => b.slot)).toEqual([4]);
});

test('у каждого холста свои закладки', async ({ app, page }) => {
  await lookAt(page, 500, 500);
  await page.keyboard.press('Control+Shift+Digit1');
  const first = await page.evaluate(() => window.__app.canvas.doc.id);
  await page.evaluate(async () => { const { state } = await import('/js/state.js'); await state.createCanvas(state.project.id, 'Второй'); });
  expect(await marks(page)).toEqual([]);
  await page.keyboard.press('Control+Digit1');
  await expect(lastToast(page)).toContainText('Закладки 1 на этом холсте нет');
  await page.evaluate(async (id) => { const { state } = await import('/js/state.js'); await state.openCanvas(state.project.id, id); }, first);
  await lookAt(page, 0, 0);
  await page.keyboard.press('Control+Digit1');
  await expect.poll(async () => near(await view(page), { x: 500, y: 500, z: 1 })).toBe(true);
});

test('меню «Закладки вида»: перейти, запомнить в слот, переименовать (имя остаётся при новом сохранении), удалить', async ({ app, page }) => {
  await lookAt(page, 300, 300);
  await page.keyboard.press('Control+Shift+Digit1');
  // the bookmark button by the zoom buttons
  await page.locator('.zoom-bar .bm-btn').click();
  const m = page.locator('.menu:not(.sub)').last();
  await expect(m.locator(':scope > .menu-item').first()).toContainText('1 · Вид 1');
  await expect(m.locator(':scope > .menu-item').first()).toContainText('Ctrl+1');

  const sub = async (parent, item) => {
    const p = m.locator(':scope > .menu-item', { hasText: parent });
    await p.hover();
    await p.locator('.sub .menu-item', { hasText: item }).click();
  };
  await sub('Переименовать', '1 · Вид 1');
  await page.locator('.modal input').fill('Главное');
  await page.locator('.modal input').press('Enter');
  expect(await marks(page)).toEqual([{ slot: 1, name: 'Главное' }]);
  // saved again somewhere else: the name the user gave stays
  await lookAt(page, -800, 100);
  await page.keyboard.press('Control+Shift+Digit1');
  expect(await marks(page)).toEqual([{ slot: 1, name: 'Главное' }]);

  // right click on the canvas → «Закладки вида» → «Запомнить этот вид» → slot 5
  await app.idle();
  await page.mouse.click(700, 500, { button: 'right' });
  const bg = page.locator('.menu:not(.sub)').last();
  const marksItem = bg.locator(':scope > .menu-item', { hasText: 'Закладки вида' });
  await marksItem.hover();
  const save = marksItem.locator('.sub .menu-item', { hasText: 'Запомнить этот вид' }).first();
  await save.hover();
  await save.locator('.sub .menu-item', { hasText: '5 · свободна' }).click();
  expect((await marks(page)).map((b) => b.slot)).toEqual([1, 5]);

  await page.locator('.zoom-bar .bm-btn').click();
  await sub('Удалить', '5 ·');
  expect((await marks(page)).map((b) => b.slot)).toEqual([1]);
});

test('поиск команд: «Закладка 1: …» переходит, «Запомнить вид в закладку» берёт свободный слот', async ({ app, page }) => {
  await lookAt(page, 1200, 0, 0.5);
  await page.keyboard.press('Control+Shift+Digit1');
  await lookAt(page, 0, 0);
  await page.keyboard.press('Control+p');
  const input = page.locator('.modal input').first();
  await input.fill('Закладка 1');
  await input.press('Enter');
  await expect.poll(async () => near(await view(page), { x: 1200, y: 0, z: 0.5 })).toBe(true);

  await page.keyboard.press('Control+p');
  await input.fill('Запомнить вид в закладку');
  await input.press('Enter');
  expect((await marks(page)).map((b) => b.slot)).toEqual([1, 2]);
});

test('в поле ввода чата клавиши работают, в терминале — остаются терминалу', async ({ app, page }) => {
  await lookAt(page, 2000, 2000);
  await page.keyboard.press('Control+Shift+Digit1');
  await setViewport(page, { x: 300, y: 150, z: 1 });
  const a = await addAgentChat(app, { x: 0, y: 0, w: 460, h: 400 });
  await chat(app, a).input.click();
  await page.keyboard.press('Control+Digit1');
  await expect.poll(async () => near(await view(page), { x: 2000, y: 2000, z: 1 })).toBe(true);

  await setViewport(page, { x: 300, y: 150, z: 1 });
  const t = await app.add('terminal', { x: 600, y: 0, w: 500, h: 300 });
  await expect(page.locator(`.node[data-id="${t}"] .xterm-rows`)).toContainText('demo shell');
  await page.locator(`.node[data-id="${t}"] .xterm-screen`).click();
  const before = await view(page);
  await page.keyboard.press('Control+Digit1');
  await page.waitForTimeout(500);
  expect(await view(page)).toEqual(before);
});

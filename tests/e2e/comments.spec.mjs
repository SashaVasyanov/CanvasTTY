// Comments on the canvas (like Figma): author name on first use, pin attached to an object,
// hover preview, thread with replies, resolve, hide / show, empty drafts vanish, saved with the canvas.
import { test, expect } from './fixtures.mjs';
import { canvasIdle, reloadApp, setViewport } from './helpers/notes.mjs';

const comments = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__app.canvas.doc.comments || [])));
const pinBox = async (page) => { const b = await page.locator('.cmt-bubble').first().boundingBox(); return { x: b.x + 14, y: b.y + 14, w: Math.round(b.width), h: Math.round(b.height) }; };
// size of the pin once its hover transition (expanding into the preview) has finished
const restingPinSize = async (page) => {
  await page.locator('.cmt-bubble').first().evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  const b = await pinBox(page);
  return [b.w, b.h];
};

test('комментарий: имя автора, ответ в ветке, едет с объектом, скрывается, решается и сохраняется', async ({ app, page }) => {
  test.slow();
  const sticky = await app.add('sticky', { x: 0, y: 0, w: 240, h: 240, data: { text: 'Объект' } });
  await canvasIdle(page);

  // C → click on the sticky → the app asks once how to sign comments
  await page.keyboard.press('c');
  expect(await page.evaluate(() => window.__app.canvas.tool)).toBe('comment');
  const sb = await app.box(sticky);
  await page.mouse.click(sb.x + 100, sb.y + 100);
  const nameInput = page.locator('.modal input');
  await expect(nameInput).toBeVisible();
  await expect(nameInput, 'подсказка из имени пользователя').toHaveValue('User');
  await nameInput.fill('Себастьян Тор');
  await page.keyboard.press('Enter');
  const thread = page.locator('.cmt-thread');
  await expect(thread.locator('.cmt-title')).toHaveText('Новый комментарий');
  await expect(thread.locator('.cmt-input')).toBeFocused();
  const draft = await comments(page);
  expect(draft).toHaveLength(1);
  expect(draft[0]).toMatchObject({ node: sticky, rx: 100, ry: 100, messages: [] });

  await page.keyboard.type('Поправить подпись');
  await page.keyboard.press('Enter');
  await expect(thread).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.canvas.tool), 'после отправки — снова выделение').toBe('select');
  let list = await comments(page);
  expect(list[0].messages.map((m) => [m.author, m.text])).toEqual([['Себастьян Тор', 'Поправить подпись']]);
  expect(await page.evaluate(async () => (await import('/js/state.js')).state.settings.userName)).toBe('Себастьян Тор');
  await expect(page.locator('.cmt-pin')).toHaveCount(1);
  await expect(page.locator('.cmt-av').first()).toHaveText('С');

  // hover: author, time and text
  const pin = await pinBox(page);
  await page.mouse.move(pin.x, pin.y);
  const prev = page.locator('.cmt-prev');
  await expect(prev).toBeVisible();
  await expect(prev.locator('.cmt-name')).toHaveText('Себастьян Тор');
  await expect(prev.locator('.cmt-time')).toHaveText('только что');
  await expect(prev.locator('.cmt-prev-text')).toHaveText('Поправить подпись');

  // click: the thread with a reply
  await page.mouse.click(pin.x, pin.y);
  await expect(thread.locator('.cmt-title')).toHaveText('Комментарий');
  await expect(thread.locator('.cmt-msg-text')).toHaveText(['Поправить подпись']);
  await expect(thread.locator('.cmt-input')).toBeFocused();
  await page.keyboard.type('Ответ на комментарий');
  await page.keyboard.press('Enter');
  await expect(thread.locator('.cmt-msg-text')).toHaveText(['Поправить подпись', 'Ответ на комментарий']);
  await expect(page.locator('.cmt-count').first()).toHaveText('2');
  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);

  // the comment travels with its object; the pin keeps its size at any zoom
  await page.evaluate((id) => { const c = window.__app.canvas; c.updateNode(id, { x: 300, y: 100 }); c.updateOverlay(); }, sticky);
  list = await comments(page);
  expect([list[0].x, list[0].y]).toEqual([400, 200]);
  await page.mouse.move(1350, 820); // not hovering the pin (hover expands it)
  const at1 = await restingPinSize(page);
  await setViewport(page, { x: 300, y: 150, z: 0.4 });
  expect(await restingPinSize(page)).toEqual(at1);
  await setViewport(page, { x: 300, y: 150, z: 1 });
  expect(await app.node(sticky), 'стикер на месте').toBeTruthy();

  // Shift+C hides and shows the comments
  await page.keyboard.press('Shift+C');
  await expect(page.locator('.cmt-pin')).toHaveCount(0);
  await page.keyboard.press('Shift+C');
  await expect(page.locator('.cmt-pin')).toHaveCount(1);

  // resolved comments are hidden
  await canvasIdle(page);
  const pin2 = await pinBox(page);
  await page.mouse.click(pin2.x, pin2.y);
  await thread.locator('.cmt-hbtn[title="Решено"]').click();
  await expect(thread).toHaveCount(0);
  expect((await comments(page))[0].resolved).toBe(true);
  await expect(page.locator('.cmt-pin')).toHaveCount(0);

  // a new comment that was never sent disappears
  await page.keyboard.press('c');
  await page.mouse.click(900, 600);
  await expect(thread.locator('.cmt-title')).toHaveText('Новый комментарий');
  expect(await comments(page)).toHaveLength(2);
  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);
  expect(await comments(page)).toHaveLength(1);

  // saved with the canvas
  // (the canvas is written 0.5 s after the last change; wait for the resolved state on "disk")
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem(`mock:canvas:${window.__app.canvas.doc.id}`) || '{}');
    return (saved.comments || []).map((c) => `${c.messages.length}:${!!c.resolved}`);
  })).toEqual(['2:true']);
  await reloadApp(page);
  const after = await comments(page);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ resolved: true, node: sticky });
  expect(after[0].messages.map((m) => m.text)).toEqual(['Поправить подпись', 'Ответ на комментарий']);
});

test('значок комментария можно перетащить: он прикрепляется к тому, на что его бросили', async ({ app, page }) => {
  test.slow();
  await page.evaluate(async () => { const { state } = await import('/js/state.js'); state.setSetting('userName', 'Аня'); });
  const a = await app.add('sticky', { x: 0, y: 0, w: 200, h: 200, data: { text: 'A' } });
  const b = await app.add('sticky', { x: 500, y: 0, w: 200, h: 200, data: { text: 'B' } });
  await canvasIdle(page);
  await page.keyboard.press('c');
  await page.mouse.click(350, 200);
  await expect(page.locator('.cmt-thread .cmt-input')).toBeFocused();
  await page.keyboard.type('куда это?');
  await page.keyboard.press('Enter');
  expect((await comments(page))[0].node).toBe(a);

  const pin = await pinBox(page);
  await app.drag({ x: pin.x, y: pin.y }, { x: pin.x + 500, y: pin.y + 20 });
  await expect(page.locator('.cmt-thread'), 'перетаскивание не открывает ветку').toHaveCount(0);
  let c = (await comments(page))[0];
  expect(c.node).toBe(b);
  await app.drag({ x: pin.x + 500, y: pin.y + 20 }, { x: pin.x + 500, y: pin.y + 400 });
  c = (await comments(page))[0];
  expect(c.node, 'брошенный на пустое место — свободный').toBeUndefined();
  expect(c.messages.map((m) => m.text)).toEqual(['куда это?']);
});

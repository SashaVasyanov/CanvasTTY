// Agents waiting for you: Ctrl+J flies to the next one (decisions first, then errors, then finished
// ones; any canvas), waiting windows have a frame on the canvas, and a window you look at for a
// moment leaves «Ждут вас». renderer/js/app.js nextWaiting / paintAttention / markSeen
import { test, expect } from './fixtures.mjs';
import { addAgentChat } from './helpers/chat.mjs';

const add = (page, item) => page.evaluate(async (item) => { const { inbox } = await import('/js/inbox.js'); const { state } = await import('/js/state.js'); inbox.add({ docId: state.doc.id, type: 'agentchat', agentId: 'codex', ...item }, { notify: false }); }, item);
const count = (page) => page.evaluate(async () => (await import('/js/inbox.js')).inbox.count);
const attn = (page, id) => page.locator(`.node[data-id="${id}"]`).getAttribute('data-attn');
const hasAttn = (page, id) => page.locator(`.node[data-id="${id}"]`).evaluate((el) => el.classList.contains('attn'));

test('рамка у ждущих окон, Ctrl+J по очереди: сначала нужно разрешение, потом готовые; просмотренные уходят', async ({ app, page }) => {
  const done = await addAgentChat(app, { x: 4000, y: 0, data: { title: 'Готовый' } });
  const wait = await addAgentChat(app, { x: 0, y: 3000, data: { title: 'Ждёт разрешения' } });
  await add(page, { nodeId: done, kind: 'done', title: 'Готовый', text: 'Готово' });
  await add(page, { nodeId: wait, kind: 'wait', title: 'Ждёт разрешения', text: 'Нужно разрешение' });
  expect([await attn(page, done), await attn(page, wait)]).toEqual(['ok', 'wait']);

  await page.keyboard.press('Control+j');
  await expect.poll(() => app.selection()).toEqual([wait]);
  expect(await hasAttn(page, wait)).toBe(false);
  expect(await hasAttn(page, done)).toBe(true);
  await expect(page.locator('.toast').last()).toContainText('ещё ждут: 1 — Ctrl+J');
  await app.idle();
  await page.keyboard.press('Control+j');
  await expect.poll(() => app.selection()).toEqual([done]);
  expect(await count(page)).toBe(0);
  await app.idle();
  await page.keyboard.press('Control+j');
  await expect(page.locator('.toast').last()).toContainText('Никто не ждёт');
});

test('ждущий агент на другом холсте: Ctrl+J открывает тот холст', async ({ app, page }) => {
  const first = await page.evaluate(() => window.__app.canvas.doc.id);
  await page.evaluate(async () => { const { state } = await import('/js/state.js'); await state.createCanvas(state.project.id, 'Фоновые агенты'); });
  const w = await addAgentChat(app, { x: 0, y: 0, data: { title: 'Ночная задача' } });
  const other = await page.evaluate(() => window.__app.canvas.doc.id);
  await add(page, { nodeId: w, kind: 'done', title: 'Ночная задача', text: 'Готово' });
  await page.evaluate(async (id) => { const { state } = await import('/js/state.js'); await state.openCanvas(state.project.id, id); }, first);
  await page.keyboard.press('Control+j');
  await expect.poll(() => page.evaluate(() => window.__app.canvas.doc.id)).toBe(other);
  await expect.poll(() => app.selection()).toEqual([w]);
});

test('окно, на котором остановился взгляд, уходит из «Ждут вас»; за краем экрана и издалека — нет', async ({ app, page }) => {
  const near = await addAgentChat(app, { x: 0, y: 0, w: 460, h: 400 });
  const far = await addAgentChat(app, { x: 5000, y: 0 });
  await app.idle();
  await page.waitForTimeout(1700); // the rest after adding the windows has passed
  await add(page, { nodeId: near, kind: 'done', title: 'Рядом' });
  await add(page, { nodeId: far, kind: 'done', title: 'Далеко' });
  // zoomed out: windows are small — not «looked at»
  await page.evaluate(() => { const c = window.__app.canvas; c.vp.z = 0.3; c.applyViewport(); });
  await page.waitForTimeout(2000);
  expect(await count(page)).toBe(2);
  await page.evaluate(() => { const c = window.__app.canvas; c.vp.z = 1; c.vp.x = 300; c.vp.y = 150; c.applyViewport(); });
  await expect.poll(() => count(page), { timeout: 5000 }).toBe(1);
  expect(await hasAttn(page, near)).toBe(false);
  expect(await hasAttn(page, far)).toBe(true);
});

test('Ctrl+J в поле ввода не перехватывается', async ({ app, page }) => {
  const s = await app.add('sticky', { x: 0, y: 0, data: { text: '' } });
  await page.evaluate((id) => window.__app.canvas.views.get(id).inst.edit(), s);
  await page.keyboard.press('Control+j');
  await expect(page.locator('.toast')).toHaveCount(0);
});

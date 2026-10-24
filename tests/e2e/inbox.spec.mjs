// «Ждут вас»: chats that finished, wait for a permission, failed or broke off while you were not
// looking — a bell with a counter in the title bar, a list, a jump to the window (on any canvas),
// a system notification when the app is not in focus. renderer/js/inbox.js
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat, recordAgentRuns, recordApiChats, agentRun, apiRun, emitAgent, emitApi, sendMessage, idle } from './helpers/chat.mjs';

const bell = (page) => page.locator('.inbox-btn');
const count = (page) => page.locator('.inbox-btn .inbox-count');
const items = (page) => page.locator('.inbox-pop .inbox-item');
// the app loses focus (another program in front): document.hasFocus() is what the app checks
const blur = (page) => page.evaluate(() => { document.hasFocus = () => false; });
const focus = (page) => page.evaluate(() => { document.hasFocus = () => true; });
// system notifications are recorded instead of shown
const recordNotifications = (page) => page.evaluate(() => {
  window.__notes = [];
  window.Notification = class { constructor(title, o) { this.title = title; this.body = o?.body; window.__notes.push(this); } close() {} };
});
const notes = (page) => page.evaluate(() => window.__notes.map((n) => ({ title: n.title, body: n.body })));

async function finishAgent(page, text = 'Готово: поправил README.') {
  await emitAgent(page, { type: 'delta', text });
  await emitAgent(page, { type: 'done', sessionId: 's1' });
}

// A window the view rests on for a moment leaves the list by itself (app.js markSeen, tested in
// waiting.spec.mjs); here it would race with the checks of what got into the list.
const noSeenByLooking = (page) => page.evaluate(() => { window.__app.markSeen = () => {}; });
test.beforeEach(async ({ app, page }) => { await recordNotifications(page); await noSeenByLooking(page); });

test('агент закончил, пока приложение не в фокусе: колокольчик, уведомление, переход к окну', async ({ app, page }) => {
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { data: { title: 'Ревью README' } });
  const c = chat(app, id);
  await expect(count(page)).toBeHidden();
  await sendMessage(c, 'Проверь README');
  await agentRun(page);
  await blur(page);
  await finishAgent(page);

  await expect(count(page)).toHaveText('1');
  expect(await notes(page)).toEqual([{ title: 'Ревью README: готово', body: 'Готово: поправил README.' }]);
  expect(await page.evaluate(() => window.__attention), 'мигает кнопка на панели задач').toBe(1);

  await focus(page);
  // the canvas moved away meanwhile: the list brings the window back
  await page.evaluate(() => { const v = window.__app.canvas; v.vp.x = -4000; v.applyViewport(); });
  await idle(page);
  await bell(page).click();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first().locator('.inbox-title')).toHaveText('Ревью README');
  await expect(items(page).first().locator('.inbox-kind')).toHaveText('Готово');
  await expect(items(page).first().locator('.inbox-text')).toHaveText('Готово: поправил README.');
  await expect(items(page).first().locator('.inbox-meta')).toContainText('только что');
  await items(page).first().click();
  await expect(page.locator('.inbox-pop')).toHaveCount(0);
  expect(await app.selection()).toEqual([id]);
  await expect.poll(() => page.evaluate((id) => { const v = window.__app.canvas, n = v.node(id), r = v.rect(); const x = r.left + v.vp.x + (n.x + n.w / 2) * v.vp.z; return x > r.left && x < r.right; }, id), { message: 'камера у окна' }).toBe(true);
  await expect(count(page)).toBeHidden();
});

test('ответ, который видно на экране, в список не попадает', async ({ app, page }) => {
  await recordAgentRuns(page);
  const id = await addAgentChat(app);
  await focus(page);
  await sendMessage(chat(app, id), 'Задача');
  await agentRun(page);
  await finishAgent(page);
  await expect(chat(app, id).lastAnswer).toContainText('Готово');
  await expect(count(page)).toBeHidden();
  expect(await notes(page)).toEqual([]);
});

test('окно на другом canvas: в списке видно где, клик открывает тот canvas', async ({ app, page }) => {
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { data: { title: 'Тесты' } });
  await sendMessage(chat(app, id), 'Прогони тесты');
  await agentRun(page);
  const home = await page.evaluate(async () => { const { state } = await import('/js/state.js'); const id = state.doc.id; await state.createCanvas(state.project.id, 'Второй'); return id; });
  await focus(page);
  await finishAgent(page, 'Все тесты прошли');
  await expect(count(page)).toHaveText('1');
  expect(await notes(page), 'приложение в фокусе — без системного уведомления').toEqual([]);
  await bell(page).click();
  await expect(items(page).first().locator('.inbox-meta')).toContainText('Главный');
  await items(page).first().click();
  await expect.poll(() => page.evaluate(async () => (await import('/js/state.js')).state.doc.id)).toBe(home);
  expect(await app.selection()).toEqual([id]);
  expect((await app.node(id)).data.messages.at(-1).content, 'ответ записан в canvas, пока он был закрыт').toBe('Все тесты прошли');
});

test('клик в окно или новое сообщение убирают его из списка', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0 });
  const b = await addAgentChat(app, { x: 620 });
  for (const id of [a, b]) {
    await sendMessage(chat(app, id), 'Задача');
  }
  await blur(page);
  await emitAgent(page, { type: 'done' }, 0);
  await emitAgent(page, { type: 'done' }, 1);
  await expect(count(page)).toHaveText('2');
  await focus(page);
  await chat(app, a).list.click();
  await expect(count(page)).toHaveText('1');
  await chat(app, b).input.fill('ещё');
  await page.evaluate(() => { document.hasFocus = () => true; });
  await chat(app, b).input.press('Enter');
  await expect(count(page)).toBeHidden();
});

test('ошибка, нужно разрешение, прервано; «Стоп» — без записи', async ({ app, page }) => {
  await recordAgentRuns(page);
  await app.reset({ x: 40, y: 40, z: 0.6 });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await addAgentChat(app, { x: (i % 2) * 600, y: Math.floor(i / 2) * 660, data: { title: `Окно ${i + 1}` } }));
  for (const id of ids) await sendMessage(chat(app, id), 'Задача');
  await blur(page);
  await emitAgent(page, { type: 'error', message: 'stream disconnected before completion' }, 0);
  await emitAgent(page, { type: 'done' }, 0);
  await emitAgent(page, { type: 'notice', text: 'Агенту не хватило прав (Write).', needsInput: true }, 1);
  await emitAgent(page, { type: 'done' }, 1);
  await emitAgent(page, { type: 'done', interrupted: true }, 2);
  await emitAgent(page, { type: 'done', aborted: true }, 3);
  await focus(page);
  await bell(page).click();
  const rows = await items(page).evaluateAll((els) => els.map((e) => [e.querySelector('.inbox-title').textContent, e.querySelector('.inbox-kind').textContent]));
  expect(rows).toEqual([['Окно 3', 'Прервано'], ['Окно 2', 'Нужно разрешение'], ['Окно 1', 'Ошибка']]);
  await expect(items(page).nth(2).locator('.inbox-text')).toHaveText('stream disconnected before completion');
  await page.locator('.inbox-pop .inbox-head button', { hasText: 'Очистить' }).click();
  await expect(items(page)).toHaveCount(0);
  await expect(page.locator('.inbox-pop .inbox-empty')).toBeVisible();
});

test('API-чат и сохранение списка после перезапуска', async ({ app, page }) => {
  await recordApiChats(page);
  const id = await addApiChat(app, { data: { title: 'Перевод' } });
  await sendMessage(chat(app, id), 'Переведи');
  await apiRun(page);
  await blur(page);
  await emitApi(page, { type: 'delta', text: 'Hello' });
  await emitApi(page, { type: 'done' });
  await expect(count(page)).toHaveText('1');
  await page.reload();
  await page.waitForFunction(() => window.__app?.canvas?.doc);
  await noSeenByLooking(page);
  await expect(count(page)).toHaveText('1');
  await bell(page).click();
  await expect(items(page).first().locator('.inbox-title')).toHaveText('Перевод');
  await expect(items(page).first().locator('.inbox-text')).toHaveText('Hello');
});

test('без уведомлений в настройках — только колокольчик', async ({ app, page }) => {
  await recordAgentRuns(page);
  await page.evaluate(async () => (await import('/js/state.js')).state.setSetting('notifyAgents', false));
  const id = await addAgentChat(app);
  await sendMessage(chat(app, id), 'Задача');
  await agentRun(page);
  await blur(page);
  await finishAgent(page);
  await expect(count(page)).toHaveText('1');
  expect(await notes(page)).toEqual([]);
});

test('агент закончил в фоне, пока его canvas был закрыт: запись при запуске', async ({ app, page }) => {
  // a chat on another canvas, then the app starts again with a finished background run for it
  const { other, node } = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const home = state.doc.id;
    await state.createCanvas(state.project.id, 'Фон');
    const n = window.__app.canvas.addNode('agentchat', { x: 0, y: 0, data: { agentId: 'claude', kind: 'claude', title: 'Долгая задача', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', parts: [], running: true }] } }, { center: false, select: false });
    const other = state.doc.id;
    await state.flushAll();
    await state.openCanvas(state.project.id, home);
    await state.flushAll();
    return { other, node: n.id };
  });
  await page.addInitScript(([docId, nodeId]) => { window.__mockBackground = [{ nodeId, docId, kind: 'claude', state: 'done' }]; }, [other, node]);
  await page.reload();
  await page.waitForFunction(() => window.__app?.canvas?.doc);
  await noSeenByLooking(page);
  await expect(count(page)).toHaveText('1');
  await bell(page).click();
  await expect(items(page).first().locator('.inbox-title')).toHaveText('Долгая задача');
  await expect(items(page).first().locator('.inbox-kind')).toHaveText('Готово в фоне');
  await expect(items(page).first().locator('.inbox-meta')).toContainText('Фон');
});

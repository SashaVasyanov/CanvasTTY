// Actions with one message of a chat window live in the right-click menu: a toolbar that popped up
// on hover made the conversation jump (it stuck out below the last message and changed the
// scroll height). renderer/js/nodes.js contextItems, renderer/js/canvas.js nodeMenu
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat } from './helpers/chat.mjs';
import { menuItem } from './helpers/canvas.mjs';

const MSGS = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Сообщение ${i + 1}` }));
const scrollState = (page, id) => page.evaluate((id) => { const l = document.querySelector(`.node[data-id="${id}"] .chat-list`); return [l.scrollTop, l.scrollHeight]; }, id);

test('наведение на сообщение ничего не показывает и не сдвигает переписку', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 460, h: 420, data: { messages: MSGS } });
  const c = chat(app, a);
  await expect.poll(() => scrollState(page, a).then(([t]) => t)).toBeGreaterThan(0);
  const before = await scrollState(page, a);
  for (const k of [11, 10, 9]) {
    await c.el.locator('.chat-list > .msg').nth(k).hover();
    await page.waitForTimeout(150);
    expect(await scrollState(page, a)).toEqual(before);
  }
  await expect(c.el.locator('.msg-actions')).toHaveCount(0);
});

test('правый клик по ответу API-чата: копировать, в заметку, удалить сообщение', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const b = await addApiChat(app, { x: 0, w: 460, h: 520, data: { messages: MSGS.slice(0, 4) } });
  const c = chat(app, b);
  const answer = c.el.locator('.chat-list > .msg.assistant').last();
  await answer.click({ button: 'right' });
  await expect(page.locator('.menu > .menu-item').first()).toContainText('Копировать ответ');
  await menuItem(page, 'Копировать ответ').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Сообщение 4');

  await c.el.locator('.chat-list > .msg.user').first().click({ button: 'right' });
  await expect(menuItem(page, 'Ответ в заметку')).toHaveCount(0);
  await menuItem(page, 'Удалить сообщение').click();
  expect((await app.node(b)).data.messages.map((m) => m.content)).toEqual(['Сообщение 2', 'Сообщение 3', 'Сообщение 4']);

  // outside messages: only the window's menu
  const head = await app.box(b, '.node-head');
  await page.mouse.click(head.x + 80, head.cy, { button: 'right' });
  await expect(menuItem(page, 'Копировать ответ')).toHaveCount(0);
  await expect(menuItem(page, 'Новый чат')).toBeVisible();
});

test('правый клик по ответу агента: копировать ответ и ответ в заметку рядом с окном', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 460, h: 520, data: { messages: [{ role: 'user', content: 'Вопрос' }, { role: 'assistant', content: '# План\n\n- шаг', parts: [{ type: 'text', text: '# План\n\n- шаг' }] }] } });
  await chat(app, a).el.locator('.chat-list > .msg.assistant').click({ button: 'right' });
  await menuItem(page, 'Ответ в заметку').click();
  await expect.poll(async () => (await app.nodes('note')).length).toBe(1);
  expect((await app.edges())[0]).toMatchObject({ from: a });
});

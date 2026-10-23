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

// ---------------- files the agent made: shown in Explorer ----------------
const PY = 'C:\\Users\\vasya\\AppData\\Local\\Temp\\test_tmk_export.py';
const ZIP = 'C:\\Users\\vasya\\Desktop\\tmk_export.zip';
const ANSWER = [
  { type: 'tool', name: 'Команда', input: 'python test.py', output: 'ok', status: 'ok' },
  { type: 'tool', name: 'Файлы', input: `add ${PY}\ndelete C:\\tmp\\old.txt`, status: 'ok' },
  { type: 'text', text: `Готово. [Скачать архив с кодом](${ZIP})\n\nИнструкция в [README](out/README.md), отчёт: \`C:\\data\\report.xlsx\`` },
];
const revealed = (page) => page.evaluate(() => window.__revealed || []);
async function agentWithFiles(app) {
  return addAgentChat(app, { x: 0, w: 520, h: 560, data: { cwd: 'C:\\work\\proj', messages: [{ role: 'user', content: 'Сделай выгрузку' }, { role: 'assistant', content: 'Готово.', parts: ANSWER }] } });
}

test('клик по ссылке на файл в ответе показывает его в проводнике; относительная — от папки агента', async ({ app, page }) => {
  const a = await agentWithFiles(app);
  const c = chat(app, a);
  await c.el.locator('a.file-link', { hasText: 'Скачать архив с кодом' }).click();
  await c.el.locator('a.file-link', { hasText: 'README' }).click();
  expect(await revealed(page)).toEqual([{ path: ZIP, cwd: 'C:\\work\\proj' }, { path: 'out/README.md', cwd: 'C:\\work\\proj' }]);
  // web links stay web links
  expect(await c.el.locator('a.file-link').count()).toBe(2);
});

test('правый клик по вызову «Файлы»: показать созданный файл в проводнике, удалённые не предлагаются', async ({ app, page }) => {
  const a = await agentWithFiles(app);
  await chat(app, a).el.locator('.tool-call', { hasText: 'test_tmk_export.py' }).click({ button: 'right' });
  await expect(page.locator('.menu > .menu-item').first()).toContainText('Показать «test_tmk_export.py» в проводнике');
  await menuItem(page, 'Показать «test_tmk_export.py» в проводнике').click();
  expect(await revealed(page)).toEqual([{ path: PY, cwd: 'C:\\work\\proj' }]);

  await chat(app, a).el.locator('.tool-call', { hasText: 'test_tmk_export.py' }).click({ button: 'right' });
  await menuItem(page, 'Копировать путь к файлу').click();
  await expect(page.locator('.toast').last()).toContainText('Путь скопирован');
});

test('правый клик по тексту ответа: все файлы ответа списком; ошибка — понятным сообщением', async ({ app, page }) => {
  const a = await agentWithFiles(app);
  await chat(app, a).el.locator('.msg.assistant .msg-text p').first().click({ button: 'right', position: { x: 4, y: 6 } });
  const parent = menuItem(page, 'Файлы ответа — показать в проводнике');
  await parent.hover();
  const items = parent.locator('.sub .menu-item');
  await expect(items.locator('.menu-label')).toHaveText(['test_tmk_export.py', 'tmk_export.zip', 'README.md', 'report.xlsx']);
  await page.evaluate(() => { window.__revealResult = 'Файл не найден на этом компьютере'; });
  await items.filter({ hasText: 'report.xlsx' }).click();
  expect((await revealed(page)).at(-1)).toEqual({ path: 'C:\\data\\report.xlsx', cwd: 'C:\\work\\proj' });
  await expect(page.locator('.toast').last()).toContainText('Файл не найден на этом компьютере');
});

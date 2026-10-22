// Canvas context of AI chat windows: objects joined to the chat by an arrow and objects named
// with @ in the message (see renderer/js/context.js and help.md «Контекст: стрелки и @»).
import { test, expect } from './fixtures.mjs';
import {
  addAgentChat, addApiChat, addSrcImage, vaultNote, addEdge, title, chat, sendMessage, expectStatus,
  recordAgentRuns, agentRun, agentRuns, emitAgent, recordApiChats, apiRun, emitApi,
} from './helpers/chat.mjs';

const NOTE = '# Рельеф\n\nТри континента, горы на севере.';

// an area «Карты мира» with two pictures and a note, a sticky outside it, and a chat window
async function mapsBoard(app, page, { api = false } = {}) {
  await vaultNote(page, 'Описание рельефа и континентов', NOTE);
  const frame = await app.add('frame', { x: 0, y: 0, w: 520, h: 440, data: { title: 'Карты мира' } });
  const ref1 = await app.addImage({ x: 100, y: 120, w: 160, h: 110, color: '#33aa77' }); // a picture from the vault
  const ref2 = await addSrcImage(app, { x: 240, y: 65, name: 'Референс 2.png', color: '#3377aa' });
  const note = await app.add('note', { x: 20, y: 200, w: 300, h: 200, data: { path: 'Описание рельефа и континентов.md' } });
  const sticky = await app.add('sticky', { x: 0, y: 480, w: 200, h: 150, data: { text: 'Стиль: акварель' } });
  await page.evaluate(() => window.__app.canvas.recomputeGroups('all'));
  const chatId = api ? await addApiChat(app, { x: 560, y: 0 }) : await addAgentChat(app, { x: 560, y: 0, w: 500, h: 600 });
  return { frame, ref1, ref2, note, sticky, chat: chatId };
}

test.describe('стрелка к чату', () => {
  test('область: чип показывает содержимое, агент получает её один раз и снова — после изменений или в новом чате', async ({ app, page }) => {
    const b = await mapsBoard(app, page);
    await addEdge(page, b.frame, b.chat);
    await recordAgentRuns(page);
    const c = chat(app, b.chat);
    await expect(c.ctxRow).toBeVisible();
    await expect(c.ctxRow).toContainText('Контекст:');
    await expect(c.ctxChips).toHaveText(['Карты мира · 2 картинки, 1 заметка']);

    await sendMessage(c, 'Сделай карту мира по референсам');
    const r0 = await agentRun(page, 0);
    expect(r0.prompt).toContain('## Область «Карты мира»');
    expect(r0.prompt).toContain(`#### Заметка «Описание рельефа и континентов»\n${NOTE}`);
    expect(r0.prompt).toContain('#### Картинка «Референс 2.png» — приложена к сообщению');
    expect(r0.prompt).toContain(`#### Картинка «${await title(page, b.ref1)}» — приложена к сообщению`);
    expect(r0.prompt, 'стикер вне области не связан и не упомянут').not.toContain('Стиль: акварель');
    expect(r0.prompt.endsWith('\n\n---\n\nСделай карту мира по референсам')).toBe(true);
    expect(r0.attachments.map((a) => a.kind)).toEqual(['image', 'image']);
    expect(r0.attachments.map((a) => a.name)).toContain('Референс 2.png');
    await expect(c.userMsgs.last().locator('.msg-ctx')).toHaveText('Контекст: Карты мира (2 картинки, 1 заметка)');
    await emitAgent(page, { type: 'delta', text: 'Готово.' });
    await emitAgent(page, { type: 'done', sessionId: 's1' });
    await expectStatus(c, 'Ожидает', 'idle');

    // the agent keeps the session: the unchanged area is not sent again
    await sendMessage(c, 'Сделай светлее');
    const r1 = await agentRun(page, 1);
    expect(r1.prompt).toBe('Сделай светлее');
    expect(r1.attachments).toEqual([]);
    await emitAgent(page, { type: 'done', sessionId: 's1' });
    await expectStatus(c, 'Ожидает');
    // (checked once the answer is done: during it the window shows stale messages, see chat-run.spec)
    await expect(c.userMsgs).toHaveCount(2);
    await expect(c.userMsgs.nth(1).locator('.msg-ctx')).toHaveCount(0);

    // a sticky added to the area: the area goes again
    await app.add('sticky', { x: 360, y: 220, w: 140, h: 120, data: { text: 'Добавь реки' } });
    await expect(c.ctxChips).toHaveText(['Карты мира · 2 картинки, 1 заметка, 1 стикер']);
    await sendMessage(c, 'Ещё раз');
    const r2 = await agentRun(page, 2);
    expect(r2.prompt).toContain('#### Стикер\nДобавь реки');
    expect(r2.attachments).toHaveLength(2);
    await emitAgent(page, { type: 'done', sessionId: 's1' });
    await expectStatus(c, 'Ожидает');
    await expect(c.userMsgs.nth(2).locator('.msg-ctx')).toHaveText('Контекст: Карты мира (2 картинки, 1 заметка, 1 стикер)');

    // a new chat starts without the agent knowing anything: the area goes again
    await c.el.locator('.agent-bar button[title^="Новый чат"]').click();
    await expect(c.msgs).toHaveCount(0);
    await sendMessage(c, 'Новая задача');
    const r3 = await agentRun(page, 3);
    expect(r3.sessionId, 'новая сессия агента').toBeFalsy();
    expect(r3.prompt).toContain('## Область «Карты мира»');
    expect(r3.attachments).toHaveLength(2);
  });

  test('API-чат: заметка по стрелке уходит с каждым запросом, картинка по @ — только со своим сообщением', async ({ app, page }) => {
    const b = await mapsBoard(app, page, { api: true });
    await addEdge(page, b.note, b.chat);
    await recordApiChats(page);
    const c = chat(app, b.chat);
    await c.input.click();
    await c.input.fill('Что за рельеф? И глянь @Референс 2.png, пожалуйста');
    await expect(c.ctxChips).toHaveText(['Описание рельефа и континен…', '@Референс 2.png']); // long names are cut
    await c.input.press('Escape'); // the @ list, if open
    await c.input.press('Enter');

    const r0 = await apiRun(page);
    expect(r0.system).toContain('Ниже контекст с canvas пользователя');
    expect(r0.system).toContain('(картинки приложены к последнему сообщению)');
    expect(r0.system).toContain(`### Заметка «Описание рельефа и континентов»\n${NOTE}`);
    expect(r0.system).toContain('### Картинка «Референс 2.png» — приложена к сообщению');
    expect(r0.messages).toHaveLength(1);
    expect(r0.messages[0].content).toBe('Что за рельеф? И глянь @Референс 2.png, пожалуйста');
    expect(r0.messages[0].attachments.map((a) => [a.name, a.kind])).toEqual([['Референс 2.png', 'image']]);
    await expect(c.userMsgs.last().locator('.msg-ctx')).toHaveText('Контекст: Описание рельефа и континентов, Референс 2.png');
    await emitApi(page, { type: 'delta', text: 'Три континента.' });
    await emitApi(page, { type: 'done', usage: { input: 10, output: 5 } });
    await expect(c.lastAnswer.locator('.msg-text')).toHaveText('Три континента.');
    await expectStatus(c, '2 сообщ.', 'idle');

    await sendMessage(c, 'А горы где?');
    const r1 = await apiRun(page, 1);
    await emitApi(page, { type: 'delta', text: 'На севере.' }, 1);
    await emitApi(page, { type: 'done' }, 1);
    await expect(c.userMsgs).toHaveText(['Что за рельеф? И глянь @Референс 2.png, пожалуйстаКонтекст: Описание рельефа и континентов, Референс 2.png', 'А горы где?Контекст: Описание рельефа и континентов']);
    expect(r1.system, 'API-чат ничего не помнит: заметка уходит снова').toContain('Три континента, горы на севере.');
    expect(r1.system).not.toContain('Референс 2.png');
    expect(r1.messages.map((m) => [m.role, m.content, (m.attachments || []).length])).toEqual([
      ['user', 'Что за рельеф? И глянь @Референс 2.png, пожалуйста', 0],
      ['assistant', 'Три континента.', 0],
      ['user', 'А горы где?', 0],
    ]);
  });
});

// App bug: patchNodeData() (called on 'session' and when an answer ends) replaces the window's
// inst.node with a copy, while later view.setData() calls (ctxHash, messages) only update the canvas
// node. After the area changed once, the window compares against a stale ctxHash, so every following
// message sends the unchanged area and its pictures again.
test('после изменения области она уходит один раз, а не с каждым следующим сообщением', async ({ app, page }) => {
  const b = await mapsBoard(app, page);
  await addEdge(page, b.frame, b.chat);
  await recordAgentRuns(page);
  const c = chat(app, b.chat);
  const turn = async (text, i) => {
    await sendMessage(c, text);
    const r = await agentRun(page, i);
    await emitAgent(page, { type: 'session', sessionId: 's1' }, i);
    await emitAgent(page, { type: 'done', sessionId: 's1' }, i);
    await expectStatus(c, 'Ожидает');
    return r;
  };
  expect((await turn('Первая', 0)).prompt).toContain('## Область «Карты мира»');
  expect((await turn('Вторая', 1)).prompt).toBe('Вторая');
  await app.add('sticky', { x: 360, y: 220, w: 140, h: 120, data: { text: 'Добавь реки' } });
  await expect(c.ctxChips).toHaveText(['Карты мира · 2 картинки, 1 заметка, 1 стикер']);
  expect((await turn('Третья', 2)).prompt).toContain('Добавь реки');
  const r3 = await turn('Четвёртая', 3);
  expect(r3.prompt, 'область не менялась после третьего сообщения').toBe('Четвёртая');
  expect(r3.attachments).toEqual([]);
});

test.describe('упоминание через @', () => {
  test('список не закрывается при наборе, Enter выбирает объект, он уходит только с этим сообщением', async ({ app, page }) => {
    const b = await mapsBoard(app, page);
    await recordAgentRuns(page);
    const c = chat(app, b.chat);
    const pop = page.locator('.mention-pop');
    const labels = pop.locator('.menu-item .menu-label');
    await expect(c.ctxRow).toBeHidden();

    await c.input.click();
    await page.keyboard.type('Сделай карту, стиль как в @');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.mention-head')).toHaveText('Упомянуть объект с холста');
    // nearest to the chat first
    await expect(labels).toHaveText(['Референс 2.png', 'Карты мира', 'Описание рельефа и континентов', await title(page, b.ref1), 'Стиль: акварель']);
    await expect(pop.locator('.menu-item .menu-kbd')).toHaveText(['Картинка', 'Область', 'Заметка', 'Картинка', 'Стикер']);

    // typing on filters the list and keeps it open (it used to vanish on the next letter)
    await page.keyboard.type('Сти');
    await expect(labels).toHaveText(['Стиль: акварель']);
    await expect(c.input).toBeFocused();
    await page.waitForTimeout(300); // longer than the 120 ms the list waits after the input loses focus
    await expect(pop).toBeVisible();
    await expect(c.input).toBeFocused();

    await page.keyboard.press('Enter'); // picks the object, does not send
    await expect(c.input).toHaveValue('Сделай карту, стиль как в @Стиль: акварель ');
    await expect(c.ctxChips).toHaveText(['@Стиль: акварель']);
    await expect(c.ctxChips.first()).toHaveClass(/(^|\s)at(\s|$)/);
    expect(await agentRuns(page)).toHaveLength(0);

    await page.keyboard.press('Enter'); // now it sends
    const r0 = await agentRun(page);
    expect(r0.prompt).toContain('### Стикер\nСтиль: акварель');
    expect(r0.prompt.endsWith('---\n\nСделай карту, стиль как в @Стиль: акварель')).toBe(true);
    expect(r0.attachments).toEqual([]);
    await expect(c.userMsgs.last().locator('.msg-ctx')).toHaveText('Контекст: Стиль: акварель');
    await expect(c.input).toHaveValue('');
    await expect(c.ctxRow).toBeHidden();
    await emitAgent(page, { type: 'done', sessionId: 's1' });
    await expectStatus(c, 'Ожидает');

    await sendMessage(c, 'А теперь крупнее');
    const r1 = await agentRun(page, 1);
    expect(r1.prompt, 'упомянутый объект ушёл только с тем сообщением').toBe('А теперь крупнее');
  });

  test('стрелки ↑/↓ выбирают, Tab вставляет, Esc закрывает без отправки; название можно набрать вручную', async ({ app, page }) => {
    const b = await mapsBoard(app, page);
    await recordAgentRuns(page);
    const c = chat(app, b.chat);
    const pop = page.locator('.mention-pop');
    const items = pop.locator('.menu-item');

    await c.input.click();
    await page.keyboard.type('@');
    await expect(items.first()).toHaveClass(/active/);
    await page.keyboard.press('ArrowUp'); // wraps to the last one
    await expect(items.last()).toHaveClass(/active/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toHaveClass(/active/);
    await page.keyboard.press('Tab');
    await expect(c.input).toHaveValue('@Карты мира ');
    await expect(c.ctxChips).toHaveText(['@Карты мира · 2 картинки, 1 заметка']);

    await page.keyboard.type('и @');
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(c.input).toHaveValue('@Карты мира и @');
    expect(await agentRuns(page)).toHaveLength(0);

    // typed by hand, without the list
    await c.input.fill('Опиши @Описание рельефа и континентов подробно');
    await expect(c.ctxChips).toHaveText(['@Описание рельефа и континен…']);
    await c.input.press('Escape');
    await c.input.press('Enter');
    const r0 = await agentRun(page);
    expect(r0.prompt).toContain(`### Заметка «Описание рельефа и континентов»\n${NOTE}`);
  });

  // App bug: pick() closes the list and then dispatches 'input' on the textarea; the text before the
  // caret now ends with «@Название » (the query may contain spaces), so the list opens again at once
  // and stays over the chat showing «Ничего не найдено» until the user types more or presses Esc.
  test('после выбора объекта (Enter или Tab) список @ закрывается', async ({ app, page }) => {
    const b = await mapsBoard(app, page);
    const c = chat(app, b.chat);
    const pop = page.locator('.mention-pop');
    await c.input.click();
    await page.keyboard.type('как в @Сти');
    await expect(pop.locator('.menu-label')).toHaveText(['Стиль: акварель']);
    await page.keyboard.press('Enter');
    await expect(c.input).toHaveValue('как в @Стиль: акварель ');
    await expect(pop).toHaveCount(0);
    await page.keyboard.type('и @Карт');
    await expect(pop.locator('.menu-label')).toHaveText(['Карты мира']);
    await page.keyboard.press('Tab');
    await expect(c.input).toHaveValue('как в @Стиль: акварель и @Карты мира ');
    await expect(pop).toHaveCount(0);
  });
});

// End-to-end scenarios around the canvas: a clean start, launching agents from the hub dock,
// the pet picker, theme / minimap / help / launch menu, a note from the sidebar, long chats.
import { test, expect } from './fixtures.mjs';
import { menuItem, waitRest, setting } from './helpers/canvas.mjs';

test.beforeEach(async ({ app, page }) => { await waitRest(page); });

test('чистый запуск: загрузка без ошибок, на холсте пульт агентов', async ({ page }) => {
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload();
  await page.waitForFunction(() => window.__app?.canvas?.doc);
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.locator('.node-hub .hub')).toBeVisible();
  await expect(page.locator('.hub .dock-btn')).not.toHaveCount(0);
});

test.describe('пульт агентов', () => {
  let hub;
  test.beforeEach(async ({ app }) => { hub = await app.add('hub', { x: 0, y: 0 }); });

  test('из дока: терминал отвечает на команду, чат агента и API-чат получают ответ', async ({ app, page }) => {
    await page.locator('.dock-btn[title="Терминал"]').click();
    await expect.poll(async () => (await app.nodes('terminal')).length).toBe(1);
    const term = (await app.nodes('terminal'))[0].id;
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.xterm')), 'терминал сразу в фокусе').toBe(true);
    await page.keyboard.type('hello agent');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate((id) => window.__app.canvas.views.get(id).inst.tailText(), term), { timeout: 10_000 }).toContain('Принято: «hello agent»');
    expect(await app.edges(), 'окна из дока ставятся рядом без стрелок').toEqual([]);

    await page.locator('.dock-btn[title^="Claude Code"]').click();
    await expect(page.locator('.menu .menu-label')).toContainText(['Окно чата', 'Терминал', 'Чат по API-ключу']);
    await menuItem(page, 'Окно чата').click();
    await expect.poll(async () => (await app.nodes('agentchat')).length).toBe(1);
    const agent = app.el((await app.nodes('agentchat'))[0].id);
    await expect(agent.locator('.chat-input')).toBeFocused();
    await page.keyboard.type('Добавь README в проект');
    await page.keyboard.press('Enter');
    await expect(agent.locator('.msg.assistant').last()).toContainText('демо-ответ', { timeout: 15_000 });

    await page.locator('.dock-btn[title="API-чат с нейросетью"]').click();
    await page.locator('.menu .menu-item').first().click();
    await expect.poll(async () => (await app.nodes('chat')).length).toBe(1);
    const chat = app.el((await app.nodes('chat'))[0].id);
    await expect(chat.locator('.chat-input')).toBeFocused();
    await page.keyboard.type('Напиши функцию сортировки');
    await page.keyboard.press('Enter');
    await expect(chat.locator('.msg.assistant').last()).toContainText('демо-ответ', { timeout: 15_000 });
    expect((await app.nodes('chat'))[0].data.title, 'чат называется по первому вопросу').toBe('Напиши функцию сортировки');
  });

  const choosePet = async (page, name) => {
    await page.locator('.hub-pet').click({ button: 'right' });
    const modal = page.locator('.modal.pet-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.pet-card', { hasText: name }).click();
    await expect(modal.locator('.pet-card.on')).toHaveText(name);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  };

  // App bug: with no agent windows on the canvas the hub keeps showing the previous pet (and its
  // data-mood becomes empty) until an agent appears. On 'pet:changed' the hub resets statusSig to ''
  // and calls renderStatus(), but with no agents the new signature is also '' and the status box is
  // not empty, so renderStatus() returns before repainting the pet (renderer/js/hub.js, renderStatus).
  test.fixme('питомец на пульте меняется сразу, даже когда агентов на холсте нет', async ({ page }) => {
    const pet = page.locator('.hub-pet');
    await expect(pet).toHaveAttribute('data-mood', 'sleep');
    await choosePet(page, 'Лисёнок');
    await expect(pet.locator('img')).toHaveAttribute('src', /fox\.png$/);
    await expect(pet).toHaveAttribute('data-mood', 'sleep');
  });

  test('питомец: ПКМ открывает выбор, «Лисёнок» становится питомцем и работает вместе с агентом', async ({ page }) => {
    const pet = page.locator('.hub-pet');
    await expect(pet).toHaveAttribute('data-mood', 'sleep');
    await choosePet(page, 'Лисёнок');
    expect(await setting(page, 'petKind')).toBe('fox');

    await page.evaluate(() => window.__app.launchAgent({ agentId: 'shell' }));
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true);
    await page.keyboard.type('hi');
    await page.keyboard.press('Enter');
    await expect(pet, 'агент работает — питомец тоже').toHaveAttribute('data-mood', 'busy', { timeout: 10_000 });
    await expect(pet.locator('img')).toHaveAttribute('src', /fox\.png$/);
  });
});

test('тема, миникарта (M), справка (F1) и меню «Агент»', async ({ page }) => {
  const themeBtn = page.locator('.titlebar .tb-icon[title="Включить светлую тему"]');
  await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.titlebar .tb-icon[title="Включить тёмную тему"]')).toHaveCount(1);

  await page.keyboard.press('m');
  await expect(page.locator('.nav-box')).toHaveClass(/no-map/);
  await page.keyboard.press('m');
  await expect(page.locator('.nav-box')).not.toHaveClass(/no-map/);

  await page.keyboard.press('F1');
  const help = page.locator('.modal.help-modal');
  await expect(help).toBeVisible();
  await expect(help.locator('.modal-title')).toHaveText('Инструкция VibeTabula');
  await expect(help.locator('.md')).toContainText('пространственный рабочий стол');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  await page.locator('.toolbar .agent-btn').click();
  await expect(page.locator('.menu .menu-header')).toHaveText(['Окно чата агента (по подписке)', 'Агент в терминале', 'Чат по API-ключу']);
});

test('боковая панель: клик по заметке открывает её справа', async ({ page }) => {
  await page.evaluate(() => window.__app.toggleSidebar(true));
  const file = page.locator('.sb-tree .sb-item.file').first();
  const name = (await file.textContent()).trim();
  await file.click();
  await expect(page.locator('.main')).toHaveClass(/np-open/);
  await expect(file).toHaveClass(/active/);
  expect(await page.evaluate(() => window.__app.notePanel.path)).toContain(name);
});

test('длинная переписка: видны последние сообщения, «Показать предыдущие» добавляет ещё; раскрытый шаг агента не сворачивается', async ({ app, page }) => {
  const msgs = [];
  for (let k = 0; k < 100; k++) msgs.push({ role: 'user', content: `Q${k}` }, { role: 'assistant', content: `A${k}`, parts: [{ type: 'text', text: `A${k}` }] });
  const id = await app.add('agentchat', { x: 0, y: 0, w: 500, h: 620, data: { agentId: 'claude', kind: 'claude', messages: msgs } });
  const list = app.el(id).locator('.chat-list');
  await expect(list.locator('.msg')).toHaveCount(40);
  await expect(list.locator('.msg').last()).toContainText('A99');
  const more = list.locator('.msg-more');
  await expect(more).toHaveText('Показать предыдущие сообщения (160)');
  await more.click();
  await expect(list.locator('.msg')).toHaveCount(80);
  await expect(list.locator('.msg-more')).toHaveText('Показать предыдущие сообщения (120)');

  // a streamed answer is re-rendered part by part: a tool call the reader opened stays open
  const r = await page.evaluate((id) => {
    const inst = window.__app.canvas.views.get(id).inst;
    const m = { role: 'assistant', parts: [{ type: 'tool', id: 't', name: 'Bash', input: 'ls', status: 'run' }], running: true };
    const body = document.createElement('div');
    inst.renderParts(m, body);
    body.querySelector('details').open = true;
    m.parts.push({ type: 'text', text: 'привет' }); inst.renderParts(m, body);
    m.parts[1].text += ' мир'; inst.renderParts(m, body);
    m.parts[0].status = 'ok'; m.parts[0].output = 'a\nb'; inst.renderParts(m, body);
    return { open: body.querySelector('details').open, kids: body.children.length, text: body.querySelector('.msg-text').textContent.trim(), out: body.querySelector('.tool-out')?.textContent };
  }, id);
  expect(r).toEqual({ open: true, kids: 2, text: 'привет мир', out: 'a\nb' });
});

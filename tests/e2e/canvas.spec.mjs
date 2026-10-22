// Canvas basics: hotkeys in any keyboard layout, grouping into areas, duplicates, pinned objects,
// copying text versus objects.
import { test, expect } from './fixtures.mjs';

// a keydown as the app sees it (the Russian layout gives other e.key values for the same e.code)
const key = (page, k, code, mods = {}) => page.evaluate(([k, code, mods]) => {
  document.activeElement?.blur?.();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...mods }));
}, [k, code, mods]);

test.describe('горячие клавиши и области', () => {
  test.beforeEach(async ({ app }) => {
    const f = await app.add('frame', { x: 0, y: 0, w: 500, h: 400, data: { title: 'Фото' } });
    await app.add('sticky', { x: 40, y: 80, w: 120, h: 120, data: { text: 'ф1' } });
    await app.add('sticky', { x: 200, y: 80, w: 120, h: 120, data: { text: 'ф2' } });
    await app.add('sticky', { x: 700, y: 80, w: 120, h: 120, data: { text: 'снаружи' } });
    await app.page.evaluate(() => { window.__app.canvas.recomputeGroups('all'); });
    test.info().annotations.push({ type: 'frame', description: f });
  });

  test('Ctrl+Ф выделяет всё, Ctrl+П добавляет в выделенную область, Ctrl+Я отменяет', async ({ app, page }) => {
    await key(page, 'ф', 'KeyA', { ctrlKey: true });
    expect(await app.selection()).toHaveLength(4);
    await key(page, 'п', 'KeyG', { ctrlKey: true });
    const frames = await app.nodes('frame');
    expect(frames, 'новая область не создаётся, если в выделении уже есть область').toHaveLength(1);
    const inside = (await app.nodes('sticky')).filter((n) => n.parent === frames[0].id).map((n) => n.data.text).sort();
    expect(inside).toEqual(['ф1', 'ф2', 'снаружи'].sort());
    expect(frames[0].w, 'область растягивается под добавленный стикер').toBeGreaterThan(500);
    await key(page, 'я', 'KeyZ', { ctrlKey: true });
    expect((await app.nodes('frame'))[0].w).toBe(500);
  });

  test('Ctrl+G без области в выделении создаёт новую', async ({ app, page }) => {
    const out = (await app.nodes('sticky')).find((n) => n.data.text === 'снаружи');
    await app.select([out.id]);
    await key(page, 'п', 'KeyG', { ctrlKey: true });
    expect(await app.nodes('frame')).toHaveLength(2);
  });

  test('инструменты и дублирование в русской раскладке', async ({ app, page }) => {
    await key(page, 'ы', 'KeyS');
    expect(await page.evaluate(() => window.__app.canvas.tool)).toBe('sticky');
    await key(page, 'м', 'KeyV');
    expect(await page.evaluate(() => window.__app.canvas.tool)).toBe('select');
    const f1 = (await app.nodes('sticky')).find((n) => n.data.text === 'ф1');
    await app.select([f1.id]);
    await key(page, 'в', 'KeyD', { ctrlKey: true });
    await expect.poll(async () => (await app.nodes('sticky')).length).toBe(4);
    await key(page, 'z', 'KeyZ', { ctrlKey: true });
    await expect.poll(async () => (await app.nodes('sticky')).length).toBe(3);
  });
});

test('дубли нумеруются как в Figma: 1 → 2 → 3 → 4', async ({ app, page }) => {
  await page.evaluate(async () => {
    const { native } = await import('/js/state.js');
    await native.vault.create('', 'Изображение 1', 'текст');
  });
  const note = await app.add('note', { x: 0, y: 0, data: { path: 'Изображение 1.md' } });
  const fr = await app.add('frame', { x: 600, y: 0, w: 300, h: 200, data: { title: 'Изображение 1' } });
  for (let i = 0; i < 3; i++) {
    await app.select([note, fr]);
    await page.evaluate(() => window.__app.canvas.duplicate());
    await expect.poll(async () => (await app.nodes('note')).length).toBe(i + 2);
  }
  await expect.poll(async () => (await app.nodes('note')).map((n) => n.data.path).sort())
    .toEqual(['Изображение 1.md', 'Изображение 2.md', 'Изображение 3.md', 'Изображение 4.md']);
  expect((await app.nodes('frame')).map((n) => n.data.title).sort()).toEqual(['Изображение 1', 'Изображение 2', 'Изображение 3', 'Изображение 4']);
});

test.describe('закреплённые объекты', () => {
  test('клик и набор в закреплённом чате не выделяют его; замок открепляет', async ({ app, page }) => {
    await page.evaluate(() => window.__app.launchAgentChat({ agentId: 'codex', world: { x: 450, y: 150 } }));
    const chat = (await app.nodes('agentchat'))[0].id;
    await app.select([chat]);
    await page.evaluate(() => window.__app.canvas.toggleLock());
    await app.clearSelection();

    await page.locator('.agent-chat .chat-input').click();
    await page.keyboard.type('Нужно добавить');
    await expect(page.locator('.agent-chat .chat-input')).toHaveValue('Нужно добавить');
    expect(await app.selection(), 'закреплённый чат не выделяется').toEqual([]);

    const before = await app.node(chat);
    const head = await app.box(chat, '.head-title');
    await app.drag({ x: head.x + 10, y: head.cy }, { x: head.x + 110, y: head.cy + 60 });
    expect((await app.node(chat)).x, 'не двигается за заголовок').toBe(before.x);

    await app.el(chat).locator('.head-lock').click();
    expect((await app.node(chat)).locked).toBeFalsy();
    await app.undo();
    expect((await app.node(chat)).locked).toBe(true);
  });

  test('рамка выделения не берёт закреплённый стикер, Ctrl+клик берёт', async ({ app, page }) => {
    const pinned = await app.add('sticky', { x: 0, y: 300, w: 200, h: 160, data: { text: 'закреплён' } });
    const free = await app.add('sticky', { x: 260, y: 300, w: 200, h: 160, data: { text: 'обычный' } });
    await app.select([pinned]);
    await page.evaluate(() => window.__app.canvas.toggleLock());
    await app.clearSelection();
    const a = await app.box(pinned), b = await app.box(free);
    await page.mouse.click(a.cx, a.cy);
    expect(await app.selection()).toEqual([]);
    await app.drag({ x: a.x - 20, y: a.y - 20 }, { x: b.x + b.width + 10, y: b.y + b.height + 10 });
    expect(await app.selection()).toEqual([free]);
    await page.keyboard.down('Control'); await page.mouse.click(a.cx, a.cy); await page.keyboard.up('Control');
    expect(await app.selection()).toContain(pinned);
    await page.mouse.move(a.cx, a.cy);
    await expect(app.el(pinned).locator('.lock-badge')).toBeVisible();
  });
});

test.describe('копирование', () => {
  const answer = 'Добавьте выражение:\n\n```sql\nCASE l.[status]\n    WHEN 0 THEN N\'Черновик\'\n    WHEN 1 THEN N\'Подана\'\nEND AS [status_description]\n```\n\nГотово.';

  test('Ctrl+C по выделенному тексту ответа копирует текст, а не окно', async ({ app, page }) => {
    await app.add('agentchat', { x: 300, y: 0, w: 760, h: 600, data: { agentId: 'codex', kind: 'codex', messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: answer }] } }, { select: true });
    const sticky = await app.add('sticky', { x: 0, y: 420, w: 200, h: 160, data: { text: 'Стикер' } });
    const pre = await page.locator('.agent-chat pre').first().boundingBox();
    await app.drag({ x: pre.x + 8, y: pre.y + 10 }, { x: pre.x + pre.width - 10, y: pre.y + pre.height - 8 });
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("WHEN 1 THEN N'Подана'");
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('"vibetabula"');

    // the text stays selected in the chat, but a newly selected sticky is what gets copied
    const s = await app.box(sticky);
    await page.mouse.click(s.cx, s.cy);
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('"vibetabula"');

    // Ctrl+X with text selected never deletes the chat
    await app.drag({ x: pre.x + 8, y: pre.y + 10 }, { x: pre.x + pre.width - 10, y: pre.y + pre.height - 8 });
    await page.keyboard.press('Control+x');
    expect(await app.nodes('agentchat')).toHaveLength(1);
  });

  test('ПКМ по выделенному тексту предлагает скопировать его', async ({ app, page }) => {
    await app.add('agentchat', { x: 300, y: 0, w: 760, h: 600, data: { agentId: 'codex', kind: 'codex', messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: answer }] } }, { select: true });
    const pre = await page.locator('.agent-chat pre').first().boundingBox();
    await app.drag({ x: pre.x + 8, y: pre.y + 10 }, { x: pre.x + pre.width - 10, y: pre.y + pre.height - 8 });
    await page.mouse.click(pre.x + 40, pre.y + 20, { button: 'right' });
    await expect(page.locator('.menu .menu-label').first()).toHaveText('Копировать выделенный текст');
    await page.locator('.menu .menu-item').first().click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('CASE l.[status]');
  });
});

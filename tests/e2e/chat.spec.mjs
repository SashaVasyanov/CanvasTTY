// Attachments in AI chat windows: pasting from the clipboard, dragging a picture from the canvas,
// the paperclip, files dropped on the window, and what the sent message and the request carry.
import { test, expect } from './fixtures.mjs';
import {
  PNG_1PX, addAgentChat, addApiChat, chat, addSrcImage, title, undoDepth, screenAt,
  recordAgentRuns, agentRun, agentRuns, recordApiChats, apiRun,
} from './helpers/chat.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILES = [
  { name: 'photo.png', mimeType: 'image/png', buffer: PNG_1PX },
  { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Заметки\n\nтекст\n') },
  { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%демо\n') },
];

test.describe('вставка из буфера', () => {
  for (const [type, add] of [['agentchat', addAgentChat], ['chat', addApiChat]]) {
    test(`${type}: выделенное окно получает картинку во вложения и текст в поле ввода`, async ({ app, page }) => {
      const id = await add(app);
      const c = chat(app, id);
      const head = await app.box(id, '.head-title');
      await page.mouse.click(head.cx, head.cy);
      expect(await app.selection()).toEqual([id]);
      await expect(c.input).not.toBeFocused();

      // a screenshot pasted while the window is selected goes into its attachments, not onto the canvas
      await app.paste({ image: true });
      await expect(c.chips).toHaveCount(1);
      await expect(c.chips.first()).toHaveClass(/\bimg\b/);
      await expect(c.chips.first()).not.toHaveClass(/pending/);
      await expect(c.chips.first(), 'безымянный скриншот получает понятное имя').toHaveAttribute('title', /^Скриншот \d\d-\d\d-\d\d\.png/);
      await expect(c.input).toBeFocused();
      expect(await app.nodes('image')).toHaveLength(0);

      // pasted into the input itself: attached as well
      await app.paste({ image: '#ff3b30' });
      await expect(c.chips).toHaveCount(2);
      expect(await app.nodes('image')).toHaveLength(0);

      // text with the window selected and the focus elsewhere goes into the input
      await page.mouse.click(head.cx, head.cy);
      await page.evaluate(() => document.activeElement?.blur());
      await app.paste({ text: 'текст из буфера' });
      await expect(c.input).toHaveValue('текст из буфера');
      await expect(c.input).toBeFocused();
      expect(await app.nodes('sticky'), 'текст не становится стикером').toHaveLength(0);
    });
  }

  test('ничего не выделено: картинка ложится на холст, а не в чат', async ({ app, page }) => {
    const id = await addAgentChat(app);
    const c = chat(app, id);
    const empty = await screenAt(page, -150, 500);
    await page.mouse.click(empty.x, empty.y);
    expect(await app.selection()).toEqual([]);
    await app.paste({ image: true });
    await expect.poll(async () => (await app.nodes('image')).length).toBe(1);
    await expect(c.chips).toHaveCount(0);
  });
});

test.describe('картинка с холста в чат', () => {
  // the mouse goes down on the picture and is held over the chat; returns a function that drops it
  async function dragOver(app, page, imgId, chatId) {
    const from = await app.box(imgId), to = await app.box(chatId, '.chat-list');
    const m = page.mouse;
    await m.move(from.cx, from.cy); await m.down();
    for (let i = 1; i <= 16; i++) await m.move(from.cx + ((to.cx - from.cx) * i) / 16, from.cy + ((to.cy - from.cy) * i) / 16);
    return () => m.up();
  }

  test('перетащенная картинка прикладывается к сообщению и возвращается на место без записи в отмену', async ({ app, page }) => {
    const id = await addAgentChat(app, { x: 500 });
    const img = await app.addImage({ x: -250, y: 100 });
    const c = chat(app, id);
    const before = await app.node(img);
    const undo0 = await undoDepth(page);

    const drop = await dragOver(app, page, img, id);
    await expect(app.el(id), 'окно чата подсвечено').toHaveClass(/chat-drop/);
    await expect(c.el.locator('.chat')).toHaveClass(/att-drop/);
    await expect(page.locator('.canvas-root')).toHaveClass(/chat-dropping/);
    await drop();

    await expect(c.chips).toHaveCount(1);
    await expect(c.chips.first()).not.toHaveClass(/pending/);
    await expect(c.chips.first()).toHaveAttribute('title', new RegExp(`^${esc(await title(page, img))}`));
    const after = await app.node(img);
    expect({ x: after.x, y: after.y }, 'картинка осталась на своём месте').toEqual({ x: before.x, y: before.y });
    await expect(app.el(img)).toHaveCSS('left', `${before.x}px`);
    await expect(app.el(img)).toHaveCSS('top', `${before.y}px`);
    expect(await undoDepth(page), 'в истории отмены ничего не появилось').toBe(undo0);
    await expect(page.locator('.node.chat-drop, .chat.att-drop, .canvas-root.chat-dropping'), 'подсветка снята').toHaveCount(0);
    expect(await app.selection()).toEqual([id]);
    await expect(c.input).toBeFocused();
  });

  test('две выделенные картинки уходят в чат вместе', async ({ app, page }) => {
    const id = await addAgentChat(app, { x: 500 });
    const a = await app.addImage({ x: -250, y: 0 });
    const b = await addSrcImage(app, { x: -250, y: 300, name: 'Вторая.png' });
    const c = chat(app, id);
    const before = await app.node(a);
    await app.select([a, b]);
    const drop = await dragOver(app, page, a, id);
    await drop();
    await expect(c.chips).toHaveCount(2);
    await expect(c.el.locator('.att-chip.pending')).toHaveCount(0);
    await expect(c.chips.nth(1)).toHaveAttribute('title', /^Вторая\.png/);
    expect((await app.node(a)).x, 'картинки остались на месте').toBe(before.x);
    expect((await app.node(b)).y).toBe(300);
  });

  test('обычное перемещение картинки мимо чата двигает её и отменяется', async ({ app, page }) => {
    const id = await addAgentChat(app, { x: 500 });
    const img = await app.addImage({ x: -250, y: 100 });
    const c = chat(app, id);
    const before = await app.node(img);
    const from = await app.box(img);
    await app.drag({ x: from.cx, y: from.cy }, { x: from.cx + 80, y: from.cy + 40 });
    // moved by the drag (snapping to the grid may shift it by a few pixels)
    await expect.poll(async () => { const n = await app.node(img); return Math.max(Math.abs(n.x - before.x - 80), Math.abs(n.y - before.y - 40)); }).toBeLessThanOrEqual(8);
    await expect(c.chips).toHaveCount(0);
    await app.undo();
    const n = await app.node(img);
    expect([n.x, n.y]).toEqual([before.x, before.y]);
  });
});

test.describe('файлы: скрепка и перетаскивание', () => {
  test('картинки и файлы показываются превью, уходят агенту с сообщением и открываются', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { data: { agentId: 'claude', kind: 'claude' } });
    const c = chat(app, id);
    await c.fileInput.setInputFiles(FILES);
    await expect(c.chips).toHaveCount(3);
    await expect(c.el.locator('.att-chip.pending')).toHaveCount(0);
    await expect(c.el.locator('.att-chip.img')).toHaveCount(1);
    await expect(c.el.locator('.att-chip.file .att-name')).toHaveText(['notes.md', 'doc.pdf']);
    await expect(c.el.locator('.att-chip.file .att-ficon')).toHaveText(['MD', 'PDF']);

    // a screenshot pasted into the input joins them; the cross removes one
    await c.input.focus();
    await app.paste({ image: true });
    await expect(c.chips).toHaveCount(4);
    await c.el.locator('.att-chip.file', { hasText: 'notes.md' }).locator('.att-x').click();
    await expect(c.chips).toHaveCount(3);
    await expect(c.el.locator('.att-chip.pending')).toHaveCount(0);

    await c.input.fill('Что на этих файлах?');
    await c.input.press('Enter');
    const user = c.userMsgs.last();
    await expect(user.locator('.msg-text')).toHaveText('Что на этих файлах?');
    await expect(user.locator('.msg-img')).toHaveCount(2);
    await expect(user.locator('.msg-file .att-name')).toHaveText(['doc.pdf']);
    await expect(c.chips, 'вложения ушли с сообщением').toHaveCount(0);

    const run = await agentRun(page);
    expect(run.attachments.map((a) => a.kind)).toEqual(['image', 'file', 'image']);
    expect(run.attachments[0].name).toBe('photo.png');
    expect(run.attachments[1].name).toBe('doc.pdf');
    expect(run.attachments[2].name).toMatch(/^Скриншот /);
    // the message keeps a small preview of every picture (shown where the file itself isn't)
    const stored = (await app.node(id)).data.messages[0].attachments;
    expect(stored.filter((a) => a.kind === 'image').map((a) => a.thumb.slice(0, 23))).toEqual(['data:image/jpeg;base64,', 'data:image/jpeg;base64,']);

    // a click opens the pictures of the message full screen
    await user.locator('.msg-img').first().click();
    await expect(page.locator('.lightbox .lb-img')).toBeVisible();
    await expect(page.locator('.lightbox .lb-cap')).toHaveText('1 / 2 · photo.png');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.lightbox .lb-cap')).toHaveText(/^2 \/ 2 · Скриншот /);
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);
  });

  test('файл, перетащенный на окно чата, прикладывается к сообщению, а не ложится на холст', async ({ app, page }) => {
    const id = await addAgentChat(app);
    const c = chat(app, id);
    const root = c.el.locator('.chat');
    const dataTransfer = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['# План\n'], 'план.md', { type: 'text/markdown' })); return d; });
    await root.dispatchEvent('dragover', { dataTransfer });
    await expect(root, 'окно подсвечено').toHaveClass(/att-drop/);
    await root.dispatchEvent('drop', { dataTransfer });
    await expect(root).not.toHaveClass(/att-drop/);
    await expect(c.el.locator('.att-chip.file:not(.pending) .att-name')).toHaveText(['план.md']);
    expect(await app.nodes('note'), 'файл не стал заметкой на холсте').toHaveLength(0);
  });

  test('пока файл загружается, сообщение не отправляется', async ({ app, page }) => {
    await recordAgentRuns(page);
    await page.evaluate(async () => {
      const { native } = await import('/js/state.js');
      const save = native.attach.saveBytes;
      window.__saveGate = new Promise((r) => { window.__releaseSave = r; });
      native.attach.saveBytes = async (o) => { await window.__saveGate; return save(o); };
    });
    const id = await addAgentChat(app);
    const c = chat(app, id);
    await c.fileInput.setInputFiles([FILES[2]]);
    await expect(c.el.locator('.att-chip.pending .att-size')).toHaveText('загрузка…');
    await c.input.fill('Прочитай документ');
    await c.input.press('Enter');
    await expect(page.locator('.toast', { hasText: 'Файлы ещё загружаются…' })).toBeVisible();
    await expect(c.input).toHaveValue('Прочитай документ');
    expect(await agentRuns(page)).toHaveLength(0);

    await page.evaluate(() => window.__releaseSave());
    await expect(c.el.locator('.att-chip.pending')).toHaveCount(0);
    await c.input.press('Enter');
    const run = await agentRun(page);
    expect(run.attachments.map((a) => a.name)).toEqual(['doc.pdf']);
  });

  test('API-чат отправляет вложения в последнем сообщении', async ({ app, page }) => {
    await recordApiChats(page);
    const id = await addApiChat(app, { data: { provider: 'anthropic' } });
    const c = chat(app, id);
    await c.fileInput.setInputFiles([FILES[0]]);
    await expect(c.el.locator('.att-chip.img:not(.pending)')).toHaveCount(1);
    await c.send.click(); // a message with only a picture

    const req = await apiRun(page);
    expect(req.provider).toBe('anthropic');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]).toMatchObject({ role: 'user', content: '' });
    expect(req.messages[0].attachments.map((a) => [a.name, a.kind])).toEqual([['photo.png', 'image']]);
    await expect(c.userMsgs.last().locator('.msg-img')).toHaveCount(1);
    await expect(c.chips).toHaveCount(0);
    await expect(app.el(id).locator('.head-title'), 'чат назван по вложению').toHaveText('photo.png');
  });
});

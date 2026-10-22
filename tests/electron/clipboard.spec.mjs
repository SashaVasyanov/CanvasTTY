// The system clipboard (Electron's clipboard module, the real paste command). All clipboard tests
// live in this one file: files run in parallel, the clipboard is shared by the whole OS session.
import { test, expect } from './fixtures.mjs';

test.beforeEach(async ({ app }) => { await app.reset({ x: 40, y: 40, z: 1 }); });

// an orange 60×40 picture on the system clipboard, then Edit → Paste of the window (Ctrl+V)
async function pastePicture(app) {
  const url = await app.page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 60; c.height = 40;
    const g = c.getContext('2d'); g.fillStyle = '#ff9500'; g.fillRect(0, 0, 60, 40);
    return c.toDataURL('image/png');
  });
  await app.main(({ clipboard, nativeImage, BrowserWindow }, url) => {
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromDataURL(url));
    BrowserWindow.getAllWindows()[0].webContents.paste();
  }, url);
}
const imageSize = (app, file) => app.main(({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(), file);

test('картинка из системного буфера: в выделенный чат — вложением, на пустой холст — объектом', async ({ app }) => {
  const chat = await app.openAgentChat('codex', { x: 560, y: 330 });
  const box = app.el(chat);
  // the chat window selected by its title bar
  await box.locator('.node-head').click({ position: { x: 60, y: 10 } });
  expect(await app.selection()).toEqual([chat]);
  await pastePicture(app);
  await expect(box.locator('.att-chip.img:not(.pending)')).toHaveCount(1);
  // the input focused
  await box.locator('.chat-input').click();
  await pastePicture(app);
  await expect(box.locator('.att-chip.img:not(.pending)')).toHaveCount(2);
  expect(await app.nodes('image'), 'на холст ничего не попало').toEqual([]);

  await app.send(chat, 'Что на картинках?');
  await app.waitAnswer(chat);
  const argv = app.calls('codex')[0].argv;
  const files = argv.filter((a, i) => argv[i - 1] === '-i');
  expect(files).toHaveLength(2);
  for (const f of files) expect(await imageSize(app, f)).toEqual({ width: 60, height: 40 });

  // nothing selected, the pointer over the canvas: the picture becomes an object in the vault
  await app.clearSelection();
  await app.page.mouse.click(200, 600);
  await pastePicture(app);
  await expect.poll(async () => (await app.nodes('image')).length).toBe(1);
  const [img] = await app.nodes('image');
  const vault = await app.page.evaluate(() => window.native.vault.root());
  expect(await imageSize(app, `${vault}/${img.data.vault}`)).toEqual({ width: 60, height: 40 });
});

test('код из ответа агента попадает в системный буфер: Ctrl+C по выделению и кнопка «Копировать»', async ({ app }) => {
  const code = "SELECT N'Подана' AS s";
  const chat = await app.add('agentchat', { x: 0, y: 0, w: 760, h: 520, data: { agentId: 'codex', kind: 'codex', messages: [{ role: 'user', content: 'запрос?' }, { role: 'assistant', content: `Вот:\n\n\`\`\`sql\n${code}\n\`\`\`` }] } });
  const clipboardText = () => app.main(({ clipboard }) => clipboard.readText());
  const pre = await app.box(chat, 'pre');
  await app.drag({ x: pre.x + 8, y: pre.y + 8 }, { x: pre.x + pre.width - 10, y: pre.y + pre.height - 6 });
  await app.main(({ clipboard }) => clipboard.writeText('старое'));
  await app.page.keyboard.press('Control+c');
  await expect.poll(clipboardText).toBe(code);
  expect(await app.nodes('agentchat'), 'окно не скопировано и не удалено').toHaveLength(1);

  await app.main(({ clipboard }) => clipboard.writeText('старое'));
  await app.el(chat).locator('.code-copy').click();
  await expect.poll(clipboardText).toBe(code);
  await expect(app.el(chat).locator('.code-copy')).toHaveText('Скопировано');
});

// Files between the canvas, the chat windows and the agents: what lands in <profile>/attachments,
// what the CLI gets on its command line, pictures Codex generates.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

const argAfter = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
// 2×2 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEIGBgY/v9nAAA/9AL+Zk6cQQAAAABJRU5ErkJggg==', 'base64');
const vaultRoot = (app) => app.page.evaluate(() => window.native.vault.root());
const loaded = (img) => img.evaluate((i) => i.complete && i.naturalWidth);

test.beforeEach(async ({ app }) => { await app.reset({ x: 40, y: 40, z: 1 }); });

test('картинки, созданные Codex, появляются в ответе и выносятся на холст', async ({ app, home }) => {
  app.scenario({ codex: 'images' });
  const chat = await app.openAgentChat('codex', { x: 300, y: 330 });
  await app.send(chat, 'Нарисуй карту');
  const answer = await app.waitAnswer(chat);
  expect(answer.content).toBe('Готово — карта сгенерирована.');
  const tid = await app.page.evaluate((id) => window.__app.canvas.node(id).data.sessionId, chat);
  const generated = path.join(home, '.codex', 'generated_images', tid);

  // only the new picture of the session, copied into the profile
  const images = answer.parts.filter((p) => p.type === 'image');
  expect(images.map((p) => p.att.name)).toEqual(['ig_map.png']);
  expect(fs.readFileSync(path.join(app.userData, 'attachments', images[0].att.file))).toEqual(fs.readFileSync(path.join(generated, 'ig_map.png')));
  const img = app.el(chat).locator('.msg-gen img');
  await expect.poll(() => loaded(img)).toBe(2);
  expect(await app.page.evaluate((sid) => window.native.agentChat.imagesDir(sid), tid)).toBe(generated);

  await app.el(chat).locator('.msg-gen button', { hasText: 'На холст' }).click();
  await expect.poll(async () => (await app.nodes('image')).length).toBe(1);
  const [node] = await app.nodes('image');
  expect(fs.readFileSync(path.join(await vaultRoot(app), node.data.vault))).toEqual(PNG);
});

test('картинка из связанной области уходит агенту файлом (-i), текст области — в промпт', async ({ app }) => {
  const frame = await app.add('frame', { x: 0, y: 0, w: 420, h: 300, data: { title: 'Карты мира' } });
  const image = await app.addImage({ x: 30, y: 70, name: 'Референс.png', w: 160, h: 110 });
  await app.add('sticky', { x: 230, y: 70, w: 160, h: 120, data: { text: 'Северное полушарие' } });
  await app.page.evaluate(() => window.__app.canvas.recomputeGroups('all'));
  const chat = await app.openAgentChat('codex', { x: 750, y: 330 });
  await app.page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b), [frame, chat]);

  await app.send(chat, 'Сделай карту');
  await app.waitAnswer(chat);
  const [call] = app.calls('codex');
  const file = argAfter(call.argv, '-i');
  expect(path.dirname(file)).toBe(path.join(app.userData, 'attachments'));
  expect(path.basename(file)).toMatch(/^[0-9a-f]{10}-Референс\.png$/);
  expect(fs.readFileSync(file)).toEqual(fs.readFileSync(path.join(await vaultRoot(app), (await app.node(image)).data.vault)));
  expect(call.prompt).toMatch(/^Контекст с canvas пользователя: .*\. Картинки из контекста приложены к сообщению\.\n\n/);
  expect(call.prompt).toContain('Карты мира');
  expect(call.prompt).toContain('Северное полушарие');
  expect(call.prompt.endsWith('\n\n---\n\nСделай карту')).toBe(true);
  await expect(app.el(chat).locator('.msg-ctx')).toContainText('Карты мира');

  // unchanged context is not sent again: the session already has it
  await app.send(chat, 'Ещё одну');
  await app.waitAnswer(chat);
  const second = app.calls('codex')[1];
  expect(second.prompt).toBe('Ещё одну');
  expect(second.argv).not.toContain('-i');
});

test('файлы с диска через скрепку: копия в профиле; Codex получает картинку через -i, Claude Code — пути', async ({ app, home }) => {
  const attachments = path.join(app.userData, 'attachments');
  const png = path.join(home, 'Схема экрана.png');
  const txt = path.join(home, 'заметки к задаче.txt');
  fs.writeFileSync(png, PNG);
  fs.writeFileSync(txt, 'текст заметки');

  const codex = await app.openAgentChat('codex', { x: 300, y: 330 });
  await app.el(codex).locator('input[type=file]').setInputFiles([png, txt]);
  await expect(app.el(codex).locator('.att-chip:not(.pending)')).toHaveCount(2);
  await app.send(codex, 'Посмотри');
  await app.waitAnswer(codex);
  const [call] = app.calls('codex');
  const img = argAfter(call.argv, '-i');
  expect(path.dirname(img)).toBe(attachments);
  expect(path.basename(img)).toMatch(/^[0-9a-f]{10}-Схема экрана\.png$/);
  expect(fs.readFileSync(img)).toEqual(PNG);
  // other files are listed in the prompt for the agent to open
  const listed = /^Посмотри\n\nПользователь приложил файлы:\n- (.+)  \(заметки к задаче\.txt\)$/.exec(call.prompt);
  expect(listed, call.prompt).not.toBeNull();
  expect(path.dirname(listed[1])).toBe(attachments);
  expect(fs.readFileSync(listed[1], 'utf8')).toBe('текст заметки');
  // the sent message shows the picture from the profile through the app:// protocol
  const shown = app.el(codex).locator('.msg.user .msg-imgs img');
  expect(await shown.getAttribute('src')).toMatch(/^app:\/\/vibetabula\/__attach\/[0-9a-f]{10}-/);
  await expect.poll(() => loaded(shown)).toBe(2);

  // Claude Code opens every file with its Read tool: the folder is allowed with --add-dir
  const claude = await app.openAgentChat('claude', { x: 850, y: 330 });
  await app.el(claude).locator('input[type=file]').setInputFiles([png]);
  await expect(app.el(claude).locator('.att-chip:not(.pending)')).toHaveCount(1);
  await app.send(claude, 'А ты что видишь?');
  await app.waitAnswer(claude);
  const [c2] = app.calls('claude');
  expect(argAfter(c2.argv, '--add-dir')).toBe(attachments);
  const file = /\n- (.+)  \(Схема экрана\.png\)$/.exec(c2.prompt)?.[1];
  expect(c2.prompt.startsWith('А ты что видишь?\n\nПользователь приложил файлы. Открой их инструментом Read')).toBe(true);
  expect(fs.readFileSync(file)).toEqual(PNG);
});

test('картинка с холста, брошенная на чат, становится вложением и уходит агенту', async ({ app }) => {
  const chat = await app.openAgentChat('codex', { x: 560, y: 330 });
  const image = await app.addImage({ x: 0, y: 100, name: 'Схема.png', w: 200, h: 140 });
  const before = await app.node(image);
  const from = await app.box(image);
  const to = await app.box(chat, '.chat-list');
  await app.drag({ x: from.cx, y: from.cy }, { x: to.cx, y: to.cy }, { steps: 20 });
  await expect(app.el(chat).locator('.att-chip.img:not(.pending)')).toHaveCount(1);
  expect(await app.node(image), 'картинка вернулась на место').toMatchObject({ x: before.x, y: before.y });

  await app.send(chat, 'Что на схеме?');
  await app.waitAnswer(chat);
  const file = argAfter(app.calls('codex')[0].argv, '-i');
  expect(path.dirname(file)).toBe(path.join(app.userData, 'attachments'));
  expect(fs.readFileSync(file)).toEqual(fs.readFileSync(path.join(await vaultRoot(app), before.data.vault)));
});

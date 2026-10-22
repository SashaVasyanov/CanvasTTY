// The app as a whole: where it keeps its data, saving when the window closes, what happens to a
// running agent on quit, and moving the data of the old CanvasTTY version.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, isAlive } from './fixtures.mjs';

test('первый запуск: профиль, рабочее пространство и хранилище заметок — в папке профиля', async ({ launchApp, home }) => {
  const app = await launchApp();
  const info = await app.page.evaluate(() => window.native.info());
  expect(info.home).toBe(home);
  expect(info.userData).toBe(app.userData);

  // the vault is a plain folder with two welcome notes linked to each other
  const vault = await app.page.evaluate(() => window.native.vault.root());
  expect(vault).toBe(path.join(home, 'Documents', 'VibeTabula Vault'));
  expect(fs.readdirSync(vault).sort()).toEqual(['Добро пожаловать в VibeTabula.md', 'Идеи.md']);
  const index = await app.page.evaluate(() => window.native.vault.index());
  const ideas = index.notes.find((n) => n.name === 'Идеи');
  expect(ideas.links).toEqual(['Добро пожаловать в VibeTabula']);
  expect(ideas.tags).toEqual(['идея']);

  // workspace and the open canvas are written to the profile
  const wsFile = path.join(app.userData, 'workspace.json');
  await expect.poll(() => fs.existsSync(wsFile)).toBe(true);
  const ws = app.readJson(wsFile);
  expect(ws.projects.map((p) => p.name)).toEqual(['Мой проект']);
  expect(ws.projects[0].cwd).toBe(home);
  expect(ws.settings.vaultPath).toBe(vault);
  const canvasFile = path.join(app.userData, 'canvases', `${ws.activeCanvasId}.json`);
  await expect.poll(() => fs.existsSync(canvasFile) && app.readJson(canvasFile).nodes.map((n) => n.type)).toEqual(['hub']);
});

test('объект, добавленный перед самым закрытием окна, сохраняется и восстанавливается', async ({ app }) => {
  await app.add('sticky', { x: 0, y: 0, data: { text: 'ДОЛЖНО_СОХРАНИТЬСЯ' } });
  const canvasId = await app.page.evaluate(() => window.__app.canvas.doc.id);
  // closed well inside the 500 ms save delay: the window asks the page to flush first
  await app.closeWindow();
  const saved = app.readJson(path.join(app.userData, 'canvases', `${canvasId}.json`));
  expect(saved.nodes.map((n) => n.data?.text)).toEqual(['ДОЛЖНО_СОХРАНИТЬСЯ']);

  await app.launch();
  expect((await app.nodes()).map((n) => [n.type, n.data.text])).toEqual([['sticky', 'ДОЛЖНО_СОХРАНИТЬСЯ']]);
});

// BUG: main.js writeJson() writes every save of a file to the same "<file>.tmp" and renames it.
// Two saves of one canvas that overlap (the debounced save, a running chat writing its answer into
// a canvas that is not open, a slow disk) write into the same temp file at once: the later rename
// fails with ENOENT, and the file can end up as two JSON documents glued together, which
// readJsonSync() then reads as null — the canvas opens empty. A per-call temp name (pid + counter)
// or a per-file write queue fixes it.
test.fixme('одновременные сохранения одного canvas не теряют и не портят файл', async ({ app }) => {
  const results = await app.page.evaluate(async () => {
    const doc = (n) => ({ id: 'c_race', nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: 'sticky', x: i * 10, y: 0, w: 10, h: 10, data: { text: 'текст '.repeat(50) } })), edges: [] });
    const saves = [400, 3, 200].map((n) => window.native.canvas.save('c_race', doc(n)));
    return (await Promise.allSettled(saves)).map((r) => r.status);
  });
  expect(results).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  const saved = JSON.parse(fs.readFileSync(path.join(app.userData, 'canvases', 'c_race.json'), 'utf8'));
  expect(saved.nodes).toHaveLength(200); // the last save wins
});

test('выход во время ответа агента завершает его процессы, а ответ после перезапуска помечен «Прервано»', async ({ app }) => {
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'Долгая задача');
  await expect(app.el(chat).locator('.tool-call')).toContainText('sleep 600');
  const [run] = app.calls('codex');
  expect(isAlive(run.pid) && isAlive(run.childPid), 'агент и его команда работают').toBe(true);

  await app.closeWindow();
  await expect.poll(() => [isAlive(run.pid), isAlive(run.childPid)], { message: 'процессы агента завершены вместе с приложением' }).toEqual([false, false]);

  await app.launch();
  const [user, answer] = await app.messages(chat);
  expect(user.content).toBe('Долгая задача');
  expect(answer.running).toBeFalsy();
  expect(answer.parts.map((p) => p.text || p.type)).toEqual(['Думаю над задачей\n', 'tool', 'Прервано']);
  expect(await app.status(chat)).toBe('Ожидает');
});

test.describe('переход со старого названия CanvasTTY', () => {
  // the profile of the old version, and Electron's own folder that may already exist under the new name
  function seedOldProfile(home) {
    const old = path.join(home, 'AppData', 'CanvasTTY');
    fs.mkdirSync(path.join(old, 'canvases'), { recursive: true });
    fs.mkdirSync(path.join(old, 'chats'), { recursive: true });
    fs.mkdirSync(path.join(old, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(old, 'workspace.json'), JSON.stringify({
      projects: [{ id: 'p_old', name: 'Старый проект', color: 'blue', canvases: [{ id: 'c_old', name: 'Главный' }] }],
      activeProjectId: 'p_old', activeCanvasId: 'c_old', settings: { theme: 'dark' },
    }));
    fs.writeFileSync(path.join(old, 'canvases', 'c_old.json'), JSON.stringify({ id: 'c_old', nodes: [{ id: 'st1', type: 'sticky', x: 0, y: 0, w: 200, h: 200, data: { text: 'Из старой версии' } }], edges: [], viewport: { x: 300, y: 200, z: 1 } }));
    fs.writeFileSync(path.join(old, 'trusted-commands.json'), JSON.stringify(['my-agent --fast']));
    fs.writeFileSync(path.join(old, 'chats', 'cv_old.json'), JSON.stringify({ id: 'cv_old', kind: 'agentchat', agent: 'codex', title: 'Старый разговор', messages: [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'здравствуйте' }], created: 1, updated: 2 }));
    fs.writeFileSync(path.join(old, 'attachments', '0a1b2c3d4e-Схема.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const vault = path.join(home, 'Documents', 'CanvasTTY Vault');
    fs.mkdirSync(path.join(vault, '.canvastty'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Старая заметка.md'), '# Старая заметка\n\nтекст');
    fs.writeFileSync(path.join(vault, '.canvastty', 'note-styles.json'), JSON.stringify({ 'Старая заметка.md': { font: 'Georgia', size: 18 } }));
    fs.mkdirSync(path.join(home, 'AppData', 'VibeTabula', 'Crashpad'), { recursive: true });
    return { old, vault };
  }

  test('проект, canvas, история, разрешённые команды и хранилище остаются', async ({ launchApp, home }) => {
    const { old, vault } = seedOldProfile(home);
    const app = await launchApp();
    expect(await app.main(({ app }) => app.getName())).toBe('VibeTabula');
    await expect(app.page.locator('.proj-btn')).toHaveText('Старый проект');
    expect((await app.nodes()).map((n) => n.data.text)).toEqual(['Из старой версии']);
    expect((await app.page.evaluate(() => window.native.history.list({}))).map((c) => c.title)).toEqual(['Старый разговор']);

    // the old vault stays in use (it may be open in Obsidian too), with its note styles
    expect(await app.page.evaluate(() => window.native.vault.root())).toBe(vault);
    expect(await app.page.evaluate(() => window.native.vault.styles())).toEqual({ 'Старая заметка.md': { font: 'Georgia', size: 18 } });

    // a command approved in the old version runs without asking again
    await app.stubDialogs(1);
    const spawned = await app.page.evaluate(() => window.native.pty.spawn({ cmd: 'my-agent', args: ['--fast'], cols: 80, rows: 24 }));
    expect(spawned.error).toBeUndefined();
    expect(await app.dialogs()).toEqual([]);
    await app.page.evaluate((id) => window.native.pty.kill(id), spawned.id);

    for (const f of ['workspace.json', 'trusted-commands.json', path.join('canvases', 'c_old.json'), path.join('chats', 'cv_old.json')]) {
      expect(fs.existsSync(path.join(app.userData, f)), `${f} в новом профиле`).toBe(true);
    }
    expect(fs.existsSync(path.join(old, 'workspace.json')), 'старый workspace.json перенесён, а не скопирован').toBe(false);
  });

  // BUG: main.js creates <userData>/attachments (new Attachments(...)) before migrateUserData()
  // runs, so the old "attachments" folder is skipped as "already exists" and pictures attached in
  // CanvasTTY chats show as unavailable.
  test.fixme('вложения чатов старой версии открываются после переезда', async ({ launchApp, home }) => {
    seedOldProfile(home);
    const app = await launchApp();
    const status = await app.page.evaluate(() => fetch('app://vibetabula/__attach/0a1b2c3d4e-%D0%A1%D1%85%D0%B5%D0%BC%D0%B0.png').then((r) => r.status, (e) => String(e)));
    expect(status).toBe(200);
  });
});

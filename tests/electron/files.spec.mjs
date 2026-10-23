// Files an agent made, shown in Explorer / Finder from the chat (main/main.js shell:reveal): the
// file is only selected in its folder, nothing is opened or run. With the real app and a fake Codex
// that edits files in its folder.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures.mjs';

const reveal = (app, o) => app.page.evaluate((o) => window.native.shell.reveal(o), o);

test('показать в проводнике: файл выделяется в папке, папка открывается, относительный путь — от папки агента', async ({ app, home }) => {
  await app.stubShell();
  const dir = path.join(home, 'Выгрузка (тест)');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const file = path.join(dir, 'out', 'report.xlsx');
  fs.writeFileSync(file, 'x');
  expect(await reveal(app, { path: file })).toBe('');
  expect(await reveal(app, { path: 'out/report.xlsx', cwd: dir })).toBe('');
  expect(await reveal(app, { path: `${file}:12` })).toBe(''); // file.py:12 as agents write it
  expect(await reveal(app, { path: pathToFileURL(file).href })).toBe('');
  expect(await reveal(app, { path: path.join(dir, 'out') })).toBe('');
  expect(await app.opened()).toEqual([['showItemInFolder', file], ['showItemInFolder', file], ['showItemInFolder', file], ['showItemInFolder', file], ['openPath', path.join(dir, 'out')]]);

  expect(await reveal(app, { path: path.join(dir, 'out', 'gone.txt') })).toBe('Файла уже нет — открыта папка, где он был');
  expect((await app.opened()).at(-1)).toEqual(['openPath', path.join(dir, 'out')]);
  expect(await reveal(app, { path: path.join(home, 'нет', 'такой', 'x.txt') })).toBe('Файл не найден на этом компьютере');
  expect(await reveal(app, { path: 'out/report.xlsx' })).toMatch(/относительно папки/);
  expect((await app.opened()).length, 'файлы не открываются и не запускаются').toBe(6);
});

test('правый клик по вызову «Файлы» в ответе Codex: созданный файл показывается в проводнике', async ({ app, home }) => {
  await app.stubShell();
  const dir = path.join(home, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'Привет\n');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'старое\n');
  app.scenario({ codex: 'edit' });
  const a = await app.add('agentchat', { x: 0, y: 0, w: 520, h: 520, data: { agentId: 'codex', kind: 'codex', cwd: dir, messages: [] } });
  await app.send(a, 'Поправь файлы');
  await app.waitAnswer(a);
  await app.reveal(a);
  await app.el(a).locator('.tool-call', { has: app.page.locator('summary b', { hasText: 'Файлы' }) }).click({ button: 'right' });
  const parent = app.page.locator('.menu .menu-item', { hasText: 'Показать в проводнике' }).first();
  await parent.hover();
  await expect(parent.locator('.sub .menu-item .menu-label')).toHaveText(['README.md', 'notes.txt']); // old.txt was deleted
  await parent.locator('.sub .menu-item', { hasText: 'notes.txt' }).click();
  await expect.poll(() => app.opened()).toEqual([['showItemInFolder', path.join(dir, 'notes.txt')]]);
});

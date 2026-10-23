// A separate copy for an agent in a real repository: the agent edits only its copy, the user's
// folder changes on «Влить», «Удалить копию» removes the folder and the merged branch.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures.mjs';

test('агент в отдельной копии: правки только в копии, «Влить» переносит их, «Удалить» убирает копию', async ({ app, home }) => {
  const repo = path.join(home, 'project');
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
  const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Привет, мир\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'старый файл\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');

  const chat = await app.openAgentChat('codex');
  await app.page.evaluate(([id, cwd]) => window.__app.canvas.setData(id, { cwd, title: 'Обновить README' }), [chat, repo]);
  const head = await app.box(chat, '.node-head');
  await app.page.mouse.click(head.x + 60, head.cy, { button: 'right' });
  await app.page.locator('.menu .menu-item', { hasText: 'Работать в отдельной копии' }).click();
  await app.page.locator('.modal button', { hasText: 'Создать копию' }).click();
  const chip = app.el(chat).locator('.wt-chip');
  await expect(chip.locator('.wt-branch')).toHaveText(/^obnovit-readme-[0-9a-f]{4}$/);
  const w = (await app.node(chat)).data.worktree;
  expect(fs.existsSync(path.join(w.path, 'README.md'))).toBe(true);

  app.scenario({ codex: 'edit' });
  await app.send(chat, 'Обнови README');
  await app.waitAnswer(chat);
  expect(app.calls('codex').at(-1).cwd.replace(/\\/g, '/').toLowerCase()).toBe(w.path.replace(/\\/g, '/').toLowerCase());
  expect(read(repo, 'README.md'), 'своя папка не тронута').toBe('Привет, мир\n');
  expect(read(w.path, 'README.md')).toBe('Привет, мир\nСтрока от агента\n');
  await expect(chip.locator('.wt-bits')).toHaveText('3 файла без коммита');

  await chip.click();
  await app.page.locator('.menu .menu-item', { hasText: 'Влить в «main»' }).click();
  await expect(app.page.locator('.node-diff .diff-path')).toHaveText(['README.md', 'notes.txt', 'old.txt']);
  await app.page.locator('.modal button', { hasText: 'Влить' }).click();
  await expect(app.page.locator('.toast').last()).toContainText('Влито в «main»');
  expect(read(repo, 'README.md')).toBe('Привет, мир\nСтрока от агента\n');
  expect(read(repo, 'notes.txt')).toBe('файл агента\n');
  expect(fs.existsSync(path.join(repo, 'old.txt'))).toBe(false);
  expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  await expect(chip.locator('.wt-bits')).toHaveText('влито');

  await chip.click();
  await app.page.locator('.menu .menu-item', { hasText: 'Удалить копию' }).click();
  await app.page.locator('.modal button', { hasText: 'Удалить' }).click();
  await expect(chip).toBeHidden();
  expect(fs.existsSync(w.path)).toBe(false);
  expect(git(repo, 'branch', '--list', w.branch)).toBe('');
});

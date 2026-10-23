// What an agent changed in a real git folder during one answer: the line under the answer, the
// diff card, rollback and taking it back — the user's own uncommitted work and index stay as they are.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures.mjs';

test('агент поменял файлы: строка под ответом, diff, откат и возврат', async ({ app, home }) => {
  const repo = path.join(home, 'project');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8').replace(/\r\n/g, '\n');
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Привет, мир\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'старый файл\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'моя незакоммиченная работа\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'в индексе\n'); git('add', 'staged.txt');

  app.scenario({ codex: 'edit' });
  const chat = await app.openAgentChat('codex');
  await app.page.evaluate(([id, cwd]) => window.__app.canvas.setData(id, { cwd }), [chat, repo]);
  await app.send(chat, 'Обнови README');
  const answer = await app.waitAnswer(chat);
  expect(answer.changes.files.map((f) => [f.path, f.status]).sort()).toEqual([['README.md', 'M'], ['notes.txt', 'A'], ['old.txt', 'D']]);
  const line = app.el(chat).locator('.msg-changes');
  await expect(line.locator('.mc-text')).toHaveText('Изменено 3 файла');
  await expect(line.locator('.mc-add')).toHaveText('+2');
  await expect(line.locator('.mc-del')).toHaveText('−1');

  await line.locator('button', { hasText: 'Показать' }).click();
  const card = app.page.locator('.node-diff');
  await expect(card.locator('.diff-path')).toHaveText(['README.md', 'notes.txt', 'old.txt']);
  await expect(card.locator('.diff-file').first().locator('.dl.add')).toHaveText(['+Строка от агента']);

  await line.locator('button', { hasText: 'Откатить' }).click();
  await app.page.locator('.modal button', { hasText: 'Откатить' }).click();
  await expect(line.locator('.mc-text')).toHaveText('Изменения откачены (3 файла)');
  expect(read('README.md')).toBe('Привет, мир\n');
  expect(read('old.txt')).toBe('старый файл\n');
  expect(fs.existsSync(path.join(repo, 'notes.txt'))).toBe(false);
  expect(read('wip.txt'), 'своя работа не тронута').toBe('моя незакоммиченная работа\n');
  expect(git('diff', '--cached', '--name-only').trim(), 'индекс не тронут').toBe('staged.txt');

  await card.locator('.diff-head button', { hasText: 'Вернуть' }).click();
  await expect(line.locator('.mc-text')).toHaveText('Изменено 3 файла');
  expect(read('README.md')).toBe('Привет, мир\nСтрока от агента\n');
  expect(read('notes.txt')).toBe('файл агента\n');
  expect(fs.existsSync(path.join(repo, 'old.txt'))).toBe(false);
});

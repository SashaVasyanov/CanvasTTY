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
  // the header says how the answer went (renderer/js/activity.js)
  await expect(app.el(chat).locator('.node-head .head-activity')).toHaveText(/^Готово за \d+ с · 3 файла$/);
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

test('замечание к строке в карточке уходит настоящему агенту следующим сообщением, после перезапуска оно на месте', async ({ app, home }) => {
  const repo = path.join(home, 'project2');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Привет, мир\n');
  git('add', '-A'); git('commit', '-qm', 'init');

  app.scenario({ codex: 'edit' });
  const chat = await app.openAgentChat('codex');
  await app.page.evaluate(([id, cwd]) => window.__app.canvas.setData(id, { cwd }), [chat, repo]);
  await app.send(chat, 'Обнови README');
  await app.waitAnswer(chat);
  await app.el(chat).locator('.msg-changes button', { hasText: 'Показать' }).click();
  const card = app.page.locator('.node-diff');
  const added = card.locator('.diff-file').first().locator('.dl.add');
  await expect(added).toHaveText(['+Строка от агента']);
  expect(await added.getAttribute('data-no')).toBe('2');
  await added.hover();
  await added.locator('.dl-plus').click();
  await card.locator('.dl-ta').fill('Напиши строку по-английски');
  await card.locator('.dl-ta').press('Control+Enter');

  app.scenario({ codex: 'basic' });
  await card.locator('.diff-send').click();
  await expect.poll(() => app.calls('codex').length).toBe(2);
  expect(app.calls('codex')[1].prompt).toContain('README.md, строка 2 (добавлена):\n> Строка от агента\nНапиши строку по-английски');
  await app.waitAnswer(chat);

  await app.restart();
  await expect(app.page.locator('.node-diff .dl-cmt')).toContainText('Напиши строку по-английски');
  await expect(app.page.locator('.node-diff .dl-cmt')).toHaveClass(/sent/);
});

test('пул-реквест из карточки: ветка, коммит и push в настоящий git, PR через gh; упавшие проверки уходят агенту', async ({ app, home }) => {
  const repo = path.join(home, 'project3'), remote = path.join(home, 'remote3.git');
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Привет, мир\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'старый файл\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const gh = (cfg) => fs.writeFileSync(path.join(app.state, 'gh.json'), JSON.stringify(cfg));
  gh({ checks: [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending', link: '' }] });

  app.scenario({ codex: 'edit' });
  const chat = await app.openAgentChat('codex');
  await app.page.evaluate(([id, cwd]) => window.__app.canvas.setData(id, { cwd }), [chat, repo]);
  await app.send(chat, 'Обнови README');
  await app.waitAnswer(chat);
  await app.el(chat).locator('.msg-changes button', { hasText: 'Показать' }).click();
  const bar = app.page.locator('.node-diff .diff-git');
  await bar.locator('.dg-prbtn').click();
  const dialog = app.page.locator('.modal');
  await expect(dialog.locator('.modal-title')).toHaveText('Новый пул-реквест');
  await expect(dialog.locator('input').nth(1)).toHaveValue('agent/obnovi-readme');
  await dialog.locator('.modal-foot button', { hasText: 'Создать PR' }).click();
  await expect(bar.locator('.dg-pr')).toHaveText('PR #1', { timeout: 20_000 });
  await expect(bar.locator('.dg-checks')).toHaveText('проверки идут…');

  expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('agent/obnovi-readme');
  expect(git(remote, 'log', '-1', '--format=%s', 'agent/obnovi-readme')).toBe('Обнови README');
  expect(git(remote, 'show', '--name-status', '--format=', 'agent/obnovi-readme').split('\n').sort()).toEqual(['A\tnotes.txt', 'D\told.txt', 'M\tREADME.md']);
  expect(git(remote, 'rev-parse', 'main'), 'main на удалённом не тронута').toBe(git(repo, 'rev-parse', 'main'));
  const [pr] = JSON.parse(fs.readFileSync(path.join(app.state, 'gh-prs.json'), 'utf8'));
  expect(pr).toMatchObject({ headRefName: 'agent/obnovi-readme', baseRefName: 'main', title: 'Обнови README' });

  gh({ checks: [{ name: 'test', state: 'FAILURE', bucket: 'fail', link: '' }], runs: [{ databaseId: 9, conclusion: 'failure', workflowName: 'CI', headSha: 'x' }], log: 'test\tRun tests\t2026-10-24T10:00:00.0000000Z README must be in English\n' });
  await bar.locator('[title="Обновить проверки"]').click();
  await expect(bar.locator('.dg-checks')).toHaveText('упали: test');
  app.scenario({ codex: 'basic' });
  await bar.locator('.dg-fix').click();
  await expect.poll(() => app.calls('codex').length).toBe(2);
  expect(app.calls('codex')[1].prompt).toContain('Проверки CI в пул-реквесте #1 упали: test.\n\nКонец логов упавших шагов:\n```\n### CI\nREADME must be in English\n```');
  await app.waitAnswer(chat);

  await app.restart();
  await expect(app.page.locator('.node-diff .diff-git .dg-pr')).toHaveText('PR #1');
});

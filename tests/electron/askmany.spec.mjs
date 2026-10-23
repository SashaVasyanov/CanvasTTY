// «Спросить нескольких» with real CLIs in a real repository: Codex and Claude Code answer the same
// question in their own copies; choosing Codex merges its edits and removes the other copy.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures.mjs';

test('два агента в своих копиях, выбор Codex вливает его правки', async ({ app, home }) => {
  const repo = path.join(home, 'project');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Привет, мир\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'старый файл\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  app.scenario({ codex: 'edit', claude: 'basic' });

  const src = await app.add('agentchat', { x: 0, y: 0, w: 420, h: 480, data: { agentId: 'codex', kind: 'codex', title: 'Исходный', cwd: repo, messages: [] } });
  await app.page.evaluate(async (src) => { const { openAskMany } = await import('./js/askmany.js'); openAskMany(window.__app.canvas, { sourceId: src, text: 'Обнови README' }); }, src);
  await expect(app.page.locator('.ask-modal .ask-wt input')).toBeChecked();
  await app.page.locator('.modal button', { hasText: 'Спросить' }).click();
  await expect.poll(() => app.calls().length, { timeout: 30_000 }).toBe(2);
  const wins = () => app.page.evaluate(() => window.__app.canvas.doc.nodes.filter((n) => n.data?.compare).map((n) => ({ id: n.id, kind: n.data.kind, wt: n.data.worktree })));
  const all = await wins();
  const codexWin = all.find((w) => w.kind === 'codex'), claudeWin = all.find((w) => w.kind === 'claude');
  for (const w of [codexWin, claudeWin]) await app.waitAnswer(w.id);
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'до выбора своя папка не тронута').toBe('Привет, мир\n');
  expect(fs.existsSync(claudeWin.wt.path)).toBe(true);

  await app.idle();
  await app.reveal(codexWin.id);
  await app.el(codexWin.id).locator('.msg-cta button', { hasText: 'Выбрать этот ответ' }).click();
  await app.page.locator('.modal button', { hasText: 'Выбрать' }).click();
  await expect(app.page.locator('.toast').last()).toContainText('изменения влиты');
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('Привет, мир\nСтрока от агента\n');
  expect(fs.existsSync(path.join(repo, 'notes.txt'))).toBe(true);
  expect(fs.existsSync(claudeWin.wt.path), 'копия второго удалена').toBe(false);
  expect(fs.existsSync(codexWin.wt.path), 'копия выбранного тоже убрана после вливания').toBe(false);
  expect(await wins()).toEqual([]);
  expect(await app.node(claudeWin.id)).toBeFalsy();
});

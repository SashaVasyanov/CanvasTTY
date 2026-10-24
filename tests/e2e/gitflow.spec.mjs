// Commit, pull request and CI checks in the «Изменения» card (renderer/js/gitbar.js). The git and
// GitHub work itself (main/gitflow.js) is tested on real repositories in tests/unit/gitflow.test.mjs
// and in the real app (tests/electron/changes.spec.mjs); here the mock answers (window.__mockGit).
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat, recordAgentRuns, agentRun, emitAgent, sendMessage } from './helpers/chat.mjs';

const CHANGES = { root: '/demo/repo', before: 'b', after: 'a', files: [{ path: 'src/app.js', status: 'M', add: 1, del: 1 }, { path: 'src/new.js', status: 'A', add: 1, del: 0 }, { path: 'old.txt', status: 'D', add: 0, del: 2 }] };
const card = (page) => page.locator('.node-diff');
const bar = (page) => card(page).locator('.diff-git');
const calls = (page, name) => page.evaluate((n) => (window.__gitCalls || []).filter((c) => c[0] === n).map((c) => c[1]), name);
const dialog = (page) => page.locator('.modal');

async function openCard(app, page, git = {}) {
  await page.evaluate(([since, git]) => { window.__mockChanges = { since, patches: {} }; window.__mockGit = git; }, [CHANGES, git]);
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { x: 0, data: { title: 'Логи' } });
  await sendMessage(chat(app, id), 'Поправь логирование в app.js');
  await agentRun(page);
  await emitAgent(page, { type: 'delta', text: 'Заменил console.log на console.info.' });
  await emitAgent(page, { type: 'done', sessionId: 's1' });
  await chat(app, id).el.locator('.msg-changes button', { hasText: 'Показать' }).click();
  await expect(bar(page)).toBeVisible();
  return id;
}

test('«Закоммитить…»: сообщение из вопроса, только файлы ответа; в полосе — хеш и ветка', async ({ app, page }) => {
  await openCard(app, page);
  await expect(bar(page).locator('.dg-status')).toHaveText('не закоммичено');
  await bar(page).locator('.dg-commit').click();
  await expect(dialog(page).locator('.modal-title')).toHaveText('Коммит изменений агента');
  await expect(dialog(page).locator('textarea')).toHaveValue('Поправь логирование в app.js');
  await expect(dialog(page)).toContainText('src/app.js, src/new.js, old.txt');
  await dialog(page).locator('textarea').fill('Логи через console.info');
  await dialog(page).locator('.modal-foot button', { hasText: 'Закоммитить' }).click();
  await expect(bar(page).locator('.dg-status')).toHaveText('✓ abc1234 в main');
  expect(await calls(page, 'commit')).toEqual([{ root: '/demo/repo', files: ['src/app.js', 'src/new.js', 'old.txt'], message: 'Логи через console.info' }]);
  expect((await app.nodes('diff'))[0].data.git.commit).toMatchObject({ hash: 'abc1234', branch: 'main' });
});

test('«Создать PR…» с основной ветки: новая ветка из названия, коммит, PR; проверки упали → «Починить» отправляет агенту логи', async ({ app, page }) => {
  await openCard(app, page, { logs: '### CI\nFAIL tests/app.test.js\nexpected info, got log' });
  await bar(page).locator('.dg-prbtn').click();
  await expect(dialog(page).locator('.modal-title')).toHaveText('Новый пул-реквест');
  const [title, branch] = [dialog(page).locator('input').nth(0), dialog(page).locator('input').nth(1)];
  await expect(title).toHaveValue('Поправь логирование в app.js');
  await expect(branch).toHaveValue('agent/poprav-logirovanie-v-app-js');
  await title.fill('Логи: console.info');
  await expect(branch).toHaveValue('agent/logi-console-info'); // follows the title until edited by hand
  await expect(dialog(page).locator('textarea')).toHaveValue(/Заменил console\.log на console\.info\.[\s\S]*Файлы: src\/app\.js, src\/new\.js, old\.txt/);
  await expect(dialog(page)).toContainText('Сейчас папка на основной ветке «main»');
  await dialog(page).locator('.modal-foot button', { hasText: 'Создать PR' }).click();

  await expect(bar(page).locator('.dg-pr')).toHaveText('PR #7');
  await expect(bar(page).locator('.dg-status')).toHaveText('✓ abc1234 в agent/logi-console-info');
  await expect(bar(page).locator('.dg-checks')).toHaveText('проверки идут…');
  await expect(bar(page).locator('.dg-commit')).toBeHidden();
  await expect(bar(page).locator('.dg-prbtn')).toHaveText('Отправить в PR');
  const [pr] = await calls(page, 'pr');
  expect(pr).toMatchObject({ root: '/demo/repo', title: 'Логи: console.info', branch: 'agent/logi-console-info', commit: { files: ['src/app.js', 'src/new.js', 'old.txt'], message: 'Логи: console.info' } });

  // the PR link opens the browser
  await page.evaluate(async () => { const { native } = await import('/js/state.js'); native.shell.open = async (u) => { window.__opened = u; }; });
  await bar(page).locator('.dg-pr').click();
  expect(await page.evaluate(() => window.__opened)).toBe('https://github.com/demo/repo/pull/7');

  // checks failed
  await page.evaluate(() => { window.__mockGit.checks = { state: 'fail', checks: [{ name: 'test (windows)', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }] }; });
  await bar(page).locator('[title="Обновить проверки"]').click();
  await expect(bar(page).locator('.dg-checks')).toHaveText('упали: test (windows)');
  await bar(page).locator('.dg-fix').click();
  const run = await agentRun(page, 1);
  expect(run.prompt).toContain('Проверки CI в пул-реквесте #7 упали: test (windows).\n\nКонец логов упавших шагов:\n```\n### CI\nFAIL tests/app.test.js\nexpected info, got log\n```\n\nПочини, пожалуйста.');
  expect(await calls(page, 'failedLogs')).toEqual([{ root: '/demo/repo', number: 7 }]);

  // kept in the card: after a reload the PR and its checks are still there
  await page.evaluate(async () => (await import('/js/state.js')).state.saveDoc.flush());
  await page.reload();
  await page.waitForFunction(() => window.__app?.canvas?.doc && !document.querySelector('#boot'));
  await expect(bar(page).locator('.dg-pr')).toHaveText('PR #7');
  await expect(bar(page).locator('.dg-checks')).toHaveText('упали: test (windows)');
});

test('у ветки уже есть PR — «Отправить в PR #3»: коммит и push туда', async ({ app, page }) => {
  await openCard(app, page, { info: { branch: 'agent/logs', pr: { number: 3, url: 'https://github.com/demo/repo/pull/3' } }, checks: { state: 'pass', checks: [{ name: 'test', bucket: 'pass' }] } });
  await bar(page).locator('.dg-prbtn').click();
  await expect(dialog(page).locator('.modal-title')).toHaveText('Отправить в PR #3');
  await expect(dialog(page)).toContainText('Ветка «agent/logs» уже в пул-реквесте #3');
  await dialog(page).locator('.modal-foot button', { hasText: 'Отправить' }).click();
  await expect(bar(page).locator('.dg-pr')).toHaveText('PR #3');
  await expect(bar(page).locator('.dg-checks')).toHaveText('проверки прошли');
  const [pr] = await calls(page, 'pr');
  expect(pr.branch, 'без новой ветки').toBeFalsy();
  expect(pr.commit.files).toEqual(['src/app.js', 'src/new.js', 'old.txt']);
});

test('нет GitHub CLI или remote — объяснение без действий; ошибка git — в уведомлении; откаченные — кнопки неактивны', async ({ app, page }) => {
  await openCard(app, page, { info: { gh: 'missing' } });
  await bar(page).locator('.dg-prbtn').click();
  await expect(dialog(page).locator('.modal-title')).toHaveText('Пул-реквест не создать');
  await expect(dialog(page)).toContainText('cli.github.com');
  await dialog(page).locator('button', { hasText: 'Понятно' }).click();
  await page.evaluate(() => { window.__mockGit.info = { remote: null }; });
  await bar(page).locator('.dg-prbtn').click();
  await expect(dialog(page)).toContainText('нет удалённого репозитория');
  await dialog(page).locator('button', { hasText: 'Понятно' }).click();
  expect(await calls(page, 'pr')).toEqual([]);

  await page.evaluate(() => { window.__mockGit.error = { commit: 'Нечего коммитить: эти файлы уже в последнем коммите.' }; });
  await bar(page).locator('.dg-commit').click();
  await dialog(page).locator('.modal-foot button', { hasText: 'Закоммитить' }).click();
  await expect(page.locator('.toast').last()).toContainText('Коммит: Нечего коммитить: эти файлы уже в последнем коммите.');
  await expect(bar(page).locator('.dg-status')).toHaveText('не закоммичено');

  // rolled back: nothing to commit
  await card(page).locator('.diff-head button', { hasText: 'Откатить' }).click();
  await page.locator('.modal button', { hasText: 'Откатить' }).click();
  await expect(bar(page).locator('.dg-status')).toHaveText('изменения откачены');
  await expect(bar(page).locator('.dg-commit')).toBeDisabled();
  await expect(bar(page).locator('.dg-prbtn')).toBeDisabled();
});

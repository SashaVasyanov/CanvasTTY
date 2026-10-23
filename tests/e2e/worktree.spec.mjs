// A separate copy of the project for an agent chat (git worktree): the switch in the window menu,
// the branch chip with its state, the copy's changes, merging with a conflict, removing. The git
// side (main/worktrees.js) is tested in tests/unit/worktrees.test.mjs and in the real app.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat, recordAgentRuns, agentRun, emitAgent, sendMessage } from './helpers/chat.mjs';

const chip = (c) => c.el.locator('.wt-chip');
const calls = (page) => page.evaluate(() => (window.__wtCalls || []).map(([k, v]) => [k, v]));
async function openMenu(app, page, id) {
  const head = await app.box(id, '.node-head');
  await page.mouse.click(head.x + 60, head.cy, { button: 'right' });
}
async function enable(app, page, id) {
  await openMenu(app, page, id);
  await page.locator('.menu .menu-item', { hasText: 'Работать в отдельной копии' }).click();
  await expect(page.locator('.modal')).toContainText('Работать в отдельной копии проекта?');
  await page.locator('.modal button', { hasText: 'Создать копию' }).click();
}

test('включение копии: ветка в окне, агент работает в папке копии с новой сессией', async ({ app, page }) => {
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { data: { title: 'Задача', cwd: '/demo/repo', sessionId: 'old-session', messages: [{ role: 'user', content: 'раньше' }, { role: 'assistant', content: 'ок' }] } });
  const c = chat(app, id);
  await expect(chip(c)).toBeHidden();
  await enable(app, page, id);
  await expect(chip(c).locator('.wt-branch')).toHaveText('zadacha-ab12');
  await expect(page.locator('.toast').last()).toContainText('Копия создана: ветка vibetabula/zadacha-ab12');
  expect(await calls(page)).toEqual([['create', { cwd: '/demo/repo', name: 'Задача' }]]);
  const data = (await app.node(id)).data;
  expect(data.worktree.path).toBe('/demo/repo.worktrees/zadacha-ab12');
  expect(data.sessionId, 'новая сессия в копии').toBeNull();
  expect(data.cwd, 'своя папка остаётся в настройках окна').toBe('/demo/repo');
  await expect(c.el.locator('.cwd-path')).toHaveClass(/in-copy/);
  await sendMessage(c, 'Почини логин');
  const run = await agentRun(page);
  expect(run.cwd).toBe('/demo/repo.worktrees/zadacha-ab12');
  expect(run.sessionId).toBeNull();
});

test('состояние копии после ответа: коммиты и файлы без коммита', async ({ app, page }) => {
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { data: { cwd: '/demo/repo' } });
  const c = chat(app, id);
  await enable(app, page, id);
  await expect(chip(c)).toBeVisible();
  await page.evaluate(() => { window.__mockWt = { status: { exists: true, ahead: 2, dirty: 3, into: 'main', merged: false } }; });
  await sendMessage(c, 'Сделай');
  await agentRun(page);
  await emitAgent(page, { type: 'done' });
  await expect(chip(c).locator('.wt-bits')).toHaveText('2 коммита · 3 файла без коммита');
});

test('влить: сначала видно изменения копии, после подтверждения — вливание', async ({ app, page }) => {
  const id = await addAgentChat(app, { data: { cwd: '/demo/repo' } });
  const c = chat(app, id);
  await enable(app, page, id);
  await page.evaluate(() => { window.__mockWt = { status: { exists: true, ahead: 1, dirty: 1, into: 'main', merged: false }, preview: { root: '/demo/repo.worktrees/zadacha-ab12', before: 't0', after: 't1', files: [{ path: 'src/login.js', status: 'M', add: 4, del: 1 }] } }; });
  await chip(c).click();
  await page.locator('.menu .menu-item', { hasText: 'Влить в «main»' }).click();
  const card = page.locator('.node-diff');
  await expect(card.locator('.node-head .head-title')).toHaveText('Копия: vibetabula/zadacha-ab12');
  await expect(card.locator('.diff-path')).toHaveText(['src/login.js']);
  await expect(card.locator('.diff-head button'), 'в карточке копии нет «Откатить»').toHaveCount(0);
  await expect(page.locator('.modal')).toContainText('Влить изменения агента в «main»?');
  await page.locator('.modal button', { hasText: 'Влить' }).click();
  await expect(page.locator('.toast').last()).toContainText('Влито в «main»');
  expect((await calls(page)).map(([k]) => k)).toEqual(['create', 'preview', 'merge']);
});

test('конфликт при вливании: окно с причиной и файлами, ничего не изменено', async ({ app, page }) => {
  const id = await addAgentChat(app, { data: { cwd: '/demo/repo' } });
  const c = chat(app, id);
  await enable(app, page, id);
  await page.evaluate(() => { window.__mockWt = { preview: { root: '/x', before: 't0', after: 't1', files: [{ path: 'README.md', status: 'M', add: 1, del: 1 }] }, merge: { ok: false, reason: 'Изменения агента конфликтуют с вашими — ничего не влито.', files: ['README.md'] } }; });
  await chip(c).click();
  await page.locator('.menu .menu-item', { hasText: 'Влить' }).click();
  await page.locator('.modal button', { hasText: 'Влить' }).click();
  await expect(page.locator('.modal')).toContainText('Не влито');
  await expect(page.locator('.modal')).toContainText('конфликтуют с вашими');
  await expect(page.locator('.modal .wt-files li')).toHaveText(['README.md']);
});

test('удалить копию с несохранёнными изменениями: второе предупреждение, потом удаление', async ({ app, page }) => {
  const id = await addAgentChat(app, { data: { cwd: '/demo/repo' } });
  const c = chat(app, id);
  await enable(app, page, id);
  await page.evaluate(() => { let n = 0; window.__mockWt = { status: { exists: true, ahead: 0, dirty: 2, into: 'main', merged: false }, remove: (o) => (o.force ? { ok: true, branchKept: false } : (n++, { ok: false, dirty: true, reason: 'В копии есть несохранённые изменения агента.' })) }; });
  await page.evaluate((id) => window.__app.canvas.views.get(id).inst.refreshWorktree(), id); // as after an answer
  await expect(chip(c).locator('.wt-bits')).toHaveText('2 файла без коммита');
  await chip(c).click();
  await page.locator('.menu .menu-item', { hasText: 'Удалить копию' }).click();
  await expect(page.locator('.modal')).toContainText('Изменения агента не влиты');
  await page.locator('.modal button', { hasText: 'Удалить' }).click();
  await expect(page.locator('.modal')).toContainText('В копии есть несохранённые изменения агента');
  await page.locator('.modal button', { hasText: 'Удалить' }).click();
  await expect(chip(c)).toBeHidden();
  expect((await app.node(id)).data.worktree).toBeNull();
  expect((await calls(page)).filter(([k]) => k === 'remove').map(([, v]) => v)).toEqual([{}, { force: true }]);
});

test('копии нет на этом компьютере: предупреждение, агент не запускается в чужой папке', async ({ app, page }) => {
  await recordAgentRuns(page);
  await page.evaluate(() => { window.__mockWt = { status: { exists: false } }; });
  const id = await addAgentChat(app, { data: { cwd: '/demo/repo', worktree: { repo: '/other/repo', path: '/other/repo.worktrees/a-1', cwd: '/other/repo.worktrees/a-1', branch: 'vibetabula/a-1', baseCommit: 'c' } } });
  const c = chat(app, id);
  await expect(chip(c)).toHaveClass(/missing/);
  await expect(chip(c).locator('.wt-bits')).toHaveText('копии нет на этом компьютере');
  await c.input.fill('сделай'); await c.input.press('Enter');
  await expect(page.locator('.toast').last()).toContainText('Отдельной копии нет на этом компьютере');
  expect(await page.evaluate(() => window.__agentRuns.length)).toBe(0);
  await chip(c).click();
  await page.locator('.menu .menu-item', { hasText: 'Убрать копию из окна' }).click();
  await expect(chip(c)).toBeHidden();
});

test('папка не под git: понятная ошибка, окно без копии', async ({ app, page }) => {
  await page.evaluate(() => { window.__mockWt = { createError: 'Папка агента не в git-репозитории — отдельная копия возможна только для git.' }; });
  const id = await addAgentChat(app, { data: { cwd: '/demo/plain' } });
  await enable(app, page, id);
  await expect(page.locator('.toast').last()).toContainText('не в git-репозитории');
  expect((await app.node(id)).data.worktree).toBeUndefined();
});

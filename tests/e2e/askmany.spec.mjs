// «Спросить нескольких»: the dialog, windows side by side in an area with the same question and
// context, a copy (git worktree) for each in a git folder, «Выбрать этот ответ» keeps one window
// (its copy merged), closes the others and removes their copies. renderer/js/askmany.js
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat, recordAgentRuns, agentRun, agentRuns, emitAgent } from './helpers/chat.mjs';

const wtCalls = (page) => page.evaluate(() => (window.__wtCalls || []).map(([k, v]) => [k, v]));
async function openFromWindow(app, page, id) {
  const head = await app.box(id, '.node-head');
  await page.mouse.click(head.x + 60, head.cy, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Спросить нескольких' }).click();
  await expect(page.locator('.modal.ask-modal')).toBeVisible();
}
const options = (page) => page.locator('.ask-modal .ask-opt');

test('вопрос двум агентам из окна: окна рядом в области, тот же вопрос и контекст, своя копия у каждого', async ({ app, page }) => {
  await recordAgentRuns(page);
  const note = await app.add('sticky', { x: -300, y: 0, w: 200, h: 160, data: { text: 'Требование: без внешних библиотек' } });
  const src = await addAgentChat(app, { x: 0, w: 420, data: { cwd: '/demo/repo', title: 'Исходный', mode: 'write' } });
  await page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b), [note, src]);
  await chat(app, src).input.fill('Напиши парсер CSV');
  await openFromWindow(app, page, src);
  await expect(page.locator('.ask-modal .ask-q')).toHaveValue('Напиши парсер CSV');
  // by default: two different agents, «авто»
  await expect(page.locator('.ask-modal .ask-opt.on')).toHaveText(['Codex · авто', 'Claude Code · авто']);
  await expect(page.locator('.ask-modal .ask-wt input')).toBeChecked();
  await page.locator('.modal button', { hasText: 'Спросить' }).click();

  await expect.poll(async () => (await agentRuns(page)).length).toBe(2);
  const runs = await agentRuns(page);
  expect(runs.map((r) => r.kind).sort()).toEqual(['claude', 'codex']);
  for (const r of runs) {
    expect(r.prompt).toContain('Требование: без внешних библиотек');
    expect(r.prompt).toMatch(/Напиши парсер CSV$/);
  }
  expect(new Set(runs.map((r) => r.cwd)).size, 'у каждого своя папка').toBe(2);
  expect(runs.every((r) => r.cwd.startsWith('/demo/repo.worktrees/'))).toBe(true);
  const [frame] = await app.nodes('frame');
  expect(frame.data.title).toBe('Сравнение: Напиши парсер CSV');
  const windows = (await app.nodes('agentchat')).filter((n) => n.data.compare);
  expect(windows).toHaveLength(2);
  expect(windows.every((n) => n.parent === frame.id), 'окна внутри области').toBe(true);
  expect(windows.every((n) => n.data.mode === 'write' || n.data.kind === 'claude')).toBe(true);
  expect((await wtCalls(page)).filter(([k]) => k === 'create')).toHaveLength(2);
});

test('выбор: не больше трёх, меньше двух нельзя', async ({ app, page }) => {
  const src = await addAgentChat(app, { data: { cwd: '/demo/plain' } });
  await openFromWindow(app, page, src);
  await expect(page.locator('.ask-modal .ask-wt input'), 'не git — без копий').toBeDisabled();
  await options(page).filter({ hasText: 'GPT-5 Codex' }).first().locator('input').check();
  await expect(page.locator('.ask-modal .ask-count')).toHaveText('Выбрано: 3 из 3');
  await expect(options(page).filter({ hasText: 'Sonnet 5.5' }).locator('input')).toBeDisabled();
  for (const t of ['Codex · авто', 'Claude Code · авто']) await options(page).filter({ hasText: t }).locator('input').uncheck();
  await page.locator('.ask-modal .ask-q').fill('вопрос');
  await page.locator('.modal button', { hasText: 'Спросить' }).click();
  await expect(page.locator('.toast').last()).toContainText('Выберите хотя бы 2 варианта');
  await expect(page.locator('.modal.ask-modal')).toBeVisible();
});

test('«Выбрать этот ответ»: копия выбранного вливается, остальные окна и копии убираются', async ({ app, page }) => {
  await recordAgentRuns(page);
  const src = await addAgentChat(app, { x: 0, w: 420, data: { cwd: '/demo/repo' } });
  await chat(app, src).input.fill('Сделай фичу');
  await openFromWindow(app, page, src);
  await page.locator('.modal button', { hasText: 'Спросить' }).click();
  await expect.poll(async () => (await agentRuns(page)).length).toBe(2);
  for (const i of [0, 1]) { await emitAgent(page, { type: 'delta', text: `вариант ${i + 1}` }, i); await emitAgent(page, { type: 'done' }, i); }
  await app.idle(); // the camera flew to the new area
  const runs = await agentRuns(page);
  const winOf = async (reqIdx) => (await app.nodes('agentchat')).find((n) => n.data.compare && n.data.worktree?.cwd === runs[reqIdx].cwd);
  const chosen = await winOf(1), other = await winOf(0);
  const cc = chat(app, chosen.id);
  await cc.el.locator('.msg-cta button', { hasText: 'Выбрать этот ответ' }).click();
  await expect(page.locator('.modal')).toContainText('изменения его копии вольются в вашу ветку');
  await page.locator('.modal button', { hasText: 'Выбрать' }).click();
  await expect(page.locator('.toast').last()).toContainText('изменения влиты');
  expect(await app.node(other.id), 'второе окно закрыто').toBeFalsy();
  expect((await app.nodes('frame')).length, 'область убрана').toBe(0);
  const left = await app.node(chosen.id);
  expect(left.data.compare).toBeNull();
  expect(left.data.worktree).toBeNull();
  await expect(cc.el.locator('.msg-cta button', { hasText: 'Выбрать этот ответ' })).toHaveCount(0);
  const calls = await wtCalls(page);
  expect(calls.filter(([k]) => k === 'merge').map(([, w]) => w.path)).toEqual([chosen.data.worktree.path]);
  expect(calls.filter(([k]) => k === 'remove').map(([, o]) => o)).toEqual([{}, { force: true }]);
});

test('конфликт при вливании выбранного: окна остаются как были', async ({ app, page }) => {
  await recordAgentRuns(page);
  const src = await addAgentChat(app, { x: 0, w: 420, data: { cwd: '/demo/repo' } });
  await chat(app, src).input.fill('Сделай');
  await openFromWindow(app, page, src);
  await page.locator('.modal button', { hasText: 'Спросить' }).click();
  await expect.poll(async () => (await agentRuns(page)).length).toBe(2);
  for (const i of [0, 1]) await emitAgent(page, { type: 'done' }, i);
  await app.idle();
  await page.evaluate(() => { window.__mockWt = { merge: { ok: false, reason: 'Изменения агента конфликтуют с вашими — ничего не влито.', files: ['a.js'] } }; });
  const win = (await app.nodes('agentchat')).find((n) => n.data.compare);
  await chat(app, win.id).el.locator('.msg-cta button', { hasText: 'Выбрать этот ответ' }).click();
  await page.locator('.modal button', { hasText: 'Выбрать' }).click();
  await expect(page.locator('.modal')).toContainText('Изменения не влиты');
  expect((await app.nodes('agentchat')).filter((n) => n.data.compare)).toHaveLength(2);
});

test('из поиска команд — с папкой проекта, без контекста', async ({ app, page }) => {
  await recordAgentRuns(page);
  await page.keyboard.press('Control+p');
  const search = page.locator('.modal input').first();
  await search.fill('Спросить нескольких');
  await search.press('Enter');
  await expect(page.locator('.modal.ask-modal')).toBeVisible();
  await page.locator('.ask-modal .ask-q').fill('Сравни подходы');
  await page.locator('.modal button', { hasText: 'Спросить' }).click();
  await expect.poll(async () => (await agentRuns(page)).length).toBe(2);
  expect((await agentRuns(page)).every((r) => r.prompt === 'Сравни подходы')).toBe(true);
});

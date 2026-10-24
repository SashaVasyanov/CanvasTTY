// The first start (renderer/js/onboarding.js): which agents are installed and signed in, signing
// in from a terminal, the project folder, what to start with; once per computer and only for a new
// workspace; later from the command palette. The detection itself: tests/unit/agentsetup.test.mjs
// and the real app (tests/electron/app.spec.mjs). The tests run with state.info.test (no window by
// itself), so here the start is called as the app does.
import { test, expect } from './fixtures.mjs';

const AGENTS = [
  { id: 'claude', found: true, version: '2.1.310 (Claude Code)', login: true, account: 'me@example.com' },
  { id: 'codex', found: true, version: 'codex-cli 0.130.0', login: false },
  { id: 'gemini', found: false },
  { id: 'kimi', found: true, version: 'kimi 1.2', login: null },
];
const box = (page) => page.locator('.ob-modal');
const agent = (page, id) => box(page).locator(`.ob-agent[data-id="${id}"]`);
async function firstStart(page, agents = AGENTS) {
  return page.evaluate(async (agents) => {
    window.__mockAgents = agents;
    localStorage.removeItem('vt:onboarded');
    const { state } = await import('/js/state.js');
    state.info.test = false;
    const { maybeOnboard } = await import('/js/onboarding.js');
    return maybeOnboard(window.__app);
  }, agents);
}
const flag = (page) => page.evaluate(() => localStorage.getItem('vt:onboarded'));

test('первый запуск: агенты с версией и входом, «Войти» открывает терминал, команда установки, папка; «Начать» — окно чата', async ({ app, page }) => {
  expect(await firstStart(page)).toBe(true);
  await expect(box(page).locator('.modal-title')).toHaveText('Добро пожаловать в VibeTabula');
  await expect(agent(page, 'claude')).toContainText('2.1.310 (Claude Code)');
  await expect(agent(page, 'claude').locator('.ob-st')).toHaveText('✓ готов · me@example.com');
  await expect(agent(page, 'codex').locator('.ob-st')).toHaveText('установлен, вход не выполнен');
  await expect(agent(page, 'gemini').locator('.ob-st')).toHaveText('не установлен');
  await expect(agent(page, 'gemini').locator('.ob-cmd')).toHaveText('npm i -g @google/gemini-cli');
  await expect(agent(page, 'kimi')).toContainText('Вход проверится при первом запуске агента');

  await page.evaluate(async () => { const { native } = await import('/js/state.js'); native.clipboard.write = async (t) => { window.__copied = t; }; });
  await agent(page, 'gemini').locator('button', { hasText: 'Скопировать команду установки' }).click();
  expect(await page.evaluate(() => window.__copied)).toBe('npm i -g @google/gemini-cli');

  await agent(page, 'codex').locator('button', { hasText: 'Войти' }).click();
  await expect.poll(async () => (await app.nodes('terminal')).map((n) => [n.data.agentId, n.data.extraArgs])).toEqual([['codex', 'login']]);

  await box(page).locator('.ob-folder button', { hasText: 'Выбрать…' }).click();
  await expect(box(page).locator('.ob-cwd')).toHaveText('/demo/project');
  expect(await page.evaluate(async () => (await import('/js/state.js')).state.project.cwd)).toBe('/demo/project');

  await expect(box(page).locator('.ob-opt.on')).toContainText('Окно чата с Claude Code');
  await box(page).locator('.modal-foot button', { hasText: 'Начать' }).click();
  await expect(box(page)).toHaveCount(0);
  await expect.poll(async () => (await app.nodes('agentchat')).map((n) => n.data.agentId)).toEqual(['claude']);
  expect(await flag(page)).toBeTruthy();
  // once per computer
  expect(await page.evaluate(async () => (await import('/js/onboarding.js')).maybeOnboard(window.__app))).toBe(false);
});

test('шаблон «Фича» вместо чата; без агентов — подсказка и без варианта чата', async ({ app, page }) => {
  await firstStart(page);
  await box(page).locator('.ob-opt', { hasText: 'Шаблон «Фича»' }).click();
  await box(page).locator('.modal-foot button', { hasText: 'Начать' }).click();
  await expect.poll(async () => (await app.nodes('frame')).map((n) => n.data.title)).toContain('Фича');
  expect(await app.nodes('agentchat')).toHaveLength(2);

  await page.evaluate(async () => {
    window.__mockAgents = [{ id: 'claude', found: false }, { id: 'codex', found: false }, { id: 'gemini', found: false }, { id: 'kimi', found: false }];
    const { openOnboarding } = await import('/js/onboarding.js');
    openOnboarding(window.__app, { first: true });
  });
  await expect(box(page).locator('.ob-none')).toContainText('Ни одного агента не нашлось');
  await expect(box(page).locator('.ob-opt')).toHaveText([/Шаблон «Фича»/, /Пустой холст/]);
});

test('рабочий холст уже не новый — окна нет, отмечено как пройдено; из поиска команд — проверка без «С чего начать»', async ({ app, page }) => {
  await app.add('sticky', { x: 0, y: 0, data: { text: 'моё' } });
  expect(await firstStart(page)).toBe(false);
  await expect(box(page)).toHaveCount(0);
  expect(await flag(page)).toBeTruthy();

  await page.keyboard.press('Control+p');
  await page.locator('.modal input').first().fill('Проверить агентов');
  await page.locator('.modal input').first().press('Enter');
  await expect(box(page).locator('.modal-title')).toHaveText('Агенты на этом компьютере');
  await expect(agent(page, 'claude')).toBeVisible();
  await expect(box(page).locator('.ob-start')).toHaveCount(0);
  await box(page).locator('.modal-foot button', { hasText: 'Готово' }).click();
  await expect(box(page)).toHaveCount(0);
});

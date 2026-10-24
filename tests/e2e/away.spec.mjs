// «Пока вас не было» (renderer/js/away.js): you come back after a while away and agents finished
// meanwhile — a card with who finished, how many files changed, errors and decisions first; a click
// flies to the window. Not after a short absence, not when nothing ended, not when turned off; after
// the app was closed for a while the card lists runs that finished meanwhile.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat, sendMessage, recordAgentRuns, agentRun, emitAgent, recordApiChats, apiRun, emitApi } from './helpers/chat.mjs';
import { reloadApp } from './helpers/notes.mjs';

const card = (page) => page.locator('.away-card');
const setAwayMinutes = (page, m) => page.evaluate(async (m) => { const { state } = await import('/js/state.js'); state.setSetting('awayMinutes', m); }, m);
// the app goes to the background / comes back (minimized, another program in front)
const hide = (page) => page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
const show = (page) => page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });

async function finishAgent(app, page, { x = 0, title, files = [] } = {}) {
  const id = await addAgentChat(app, { x, y: 0, w: 420, h: 360, data: { title } });
  await sendMessage(chat(app, id), 'Сделай');
  await agentRun(page, (await page.evaluate(() => window.__agentRuns.length)) - 1);
  for (const [i, f] of files.entries()) { await emitAgent(page, { type: 'tool', id: `t${i}`, name: 'Edit', input: f }); await emitAgent(page, { type: 'toolResult', id: `t${i}`, output: 'ok' }); }
  await emitAgent(page, { type: 'delta', text: 'Готово' });
  await emitAgent(page, { type: 'done' });
  await expect(chat(app, id).send).not.toHaveClass(/stop/);
  return id;
}

test('приложение было в фоне, агенты закончили: сводка — сначала ошибка, потом готовые с файлами; клик ведёт к окну', async ({ app, page }) => {
  await recordAgentRuns(page);
  await recordApiChats(page);
  await setAwayMinutes(page, 0.01); // 0.6 s instead of 5 minutes
  await hide(page);
  const done = await finishAgent(app, page, { title: 'Рефакторинг', files: ['/p/a.js', '/p/b.js'] });
  const api = await addApiChat(app, { x: 500, y: 0 });
  await sendMessage(chat(app, api), 'Вопрос');
  await apiRun(page);
  await emitApi(page, { type: 'error', message: 'Сервер перегружен' });
  await page.waitForTimeout(800);
  await expect(card(page)).toHaveCount(0); // not while you are away
  await show(page);

  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.away-head b')).toHaveText(/^Пока вас не было · \d+ с$/);
  await expect(card(page).locator('.away-sum')).toHaveText('Закончили: 1 · изменено 2 файла · ошибки: 1');
  const rows = card(page).locator('.away-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.inbox-kind')).toHaveText('Ошибка');
  await expect(rows.nth(0).locator('.away-line')).toContainText('Сервер перегружен');
  await expect(rows.nth(1).locator('.away-title')).toHaveText('Рефакторинг');
  await expect(rows.nth(1).locator('.away-line')).toHaveText(/^Готово за \d+ с · 2 файла$/);

  await page.evaluate(() => { const c = window.__app.canvas; c.vp.x = -4000; c.applyViewport(); });
  await rows.nth(1).click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(() => app.selection()).toEqual([done]);

  // the palette shows the last card again
  await page.keyboard.press('Control+p');
  await page.locator('.modal input').first().fill('Пока вас не было');
  await page.locator('.modal input').first().press('Enter');
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
});

test('коротко отошли, ничего не закончилось или сводка выключена — карточки нет', async ({ app, page }) => {
  await recordAgentRuns(page);
  // 5 minutes (default): a short absence is not «away»
  await hide(page);
  await finishAgent(app, page, { title: 'Быстро' });
  await show(page);
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);

  // away long enough, but nothing ended meanwhile
  await setAwayMinutes(page, 0.01);
  await hide(page);
  await page.waitForTimeout(800);
  await show(page);
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);

  // «Больше не показывать» turns it off (Settings → Агенты)
  await hide(page);
  await finishAgent(app, page, { x: 500, title: 'Второй' });
  await page.waitForTimeout(800);
  await show(page);
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Больше не показывать' }).click();
  expect(await page.evaluate(async () => (await import('/js/state.js')).state.settings.awayMinutes)).toBe(0);
  await hide(page);
  await finishAgent(app, page, { x: 1000, title: 'Третий' });
  await page.waitForTimeout(800);
  await show(page);
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);
});

test('никто не трогал мышь и клавиатуру при открытом приложении — тоже «не было»', async ({ app, page }) => {
  await recordAgentRuns(page);
  await setAwayMinutes(page, 0.01);
  const id = await addAgentChat(app, { x: 0, y: 0, w: 420, h: 360, data: { title: 'Ночная задача' } });
  await sendMessage(chat(app, id), 'Сделай');
  await agentRun(page);
  // what the 15-second check does when nothing was touched for a while (away.js start)
  await page.evaluate(async () => { const { away } = await import('/js/away.js'); away.leave(Date.now() - 60_000); });
  await emitAgent(page, { type: 'delta', text: 'Готово' });
  await emitAgent(page, { type: 'done' });
  await expect(chat(app, id).send).not.toHaveClass(/stop/);
  await page.mouse.move(300, 300);
  await page.mouse.move(320, 320);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.away-head b')).toHaveText(/^Пока вас не было · 1 мин$/);
});

test('приложение было закрыто: при запуске — агенты, закончившие в фоне', async ({ app, page }) => {
  // a chat window on another canvas, whose run finished while the app was closed
  const first = await page.evaluate(() => window.__app.canvas.doc.id);
  const other = await page.evaluate(async () => { const { state } = await import('/js/state.js'); return (await state.createCanvas(state.project.id, 'Ночные задачи')).id; });
  const w = await addAgentChat(app, { x: 0, y: 0, data: { title: 'Отчёт за неделю' } });
  await page.evaluate(async (id) => { const { state } = await import('/js/state.js'); await state.openCanvas(state.project.id, id); }, first);
  await setAwayMinutes(page, 5);
  await page.evaluate(async () => (await import('/js/state.js')).state.flushAll());
  // closed an hour ago
  await page.addInitScript(([nodeId, docId]) => {
    localStorage.setItem('vt:lastSeen', String(Date.now() - 3600_000));
    window.__mockBackground = [{ nodeId, docId, state: 'done' }];
  }, [w, other]);
  await reloadApp(page);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
  await expect(card(page).locator('.away-head b')).toHaveText(/^Пока вас не было · 1 ч$/);
  const row = card(page).locator('.away-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.away-title')).toHaveText('Отчёт за неделю');
  await expect(row.locator('.inbox-kind')).toHaveText('Готово в фоне');
  await expect(row.locator('.away-meta')).toHaveText('Ночные задачи');
  await row.click();
  await expect.poll(() => page.evaluate(() => window.__app.canvas.doc.id)).toBe(other);
  await expect.poll(() => app.selection()).toEqual([w]);
});

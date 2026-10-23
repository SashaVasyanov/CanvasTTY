// «Ждут вас» with real background runs: an agent that keeps working after the app is closed is
// reported when it finishes, even though its canvas is not open; the entry opens that canvas and
// the chat picks the answer up from the run's journal.
import { test, expect } from './fixtures.mjs';

test('агент закончил в фоне на закрытом canvas: запись в «Ждут вас», клик открывает ответ', async ({ app }) => {
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  await app.page.evaluate((id) => window.__app.canvas.setData(id, { title: 'Фоновая задача' }), chat);
  await app.send(chat, 'Долгая задача');
  await expect(app.el(chat).locator('.tool-call')).toContainText('sleep 600');
  const home = await app.page.evaluate(async () => {
    const { state } = await import('./js/state.js');
    const id = state.doc.id;
    await state.createCanvas(state.project.id, 'Другой');
    return id;
  });
  await app.closeWindow();

  // the app starts on the other canvas: the chat is not on screen, its run goes on in the background
  await app.launch();
  await expect(app.page.locator('.inbox-btn .inbox-count')).toBeHidden();
  app.release('codex');
  await expect(app.page.locator('.inbox-btn .inbox-count'), 'агент закончил — запись появилась').toHaveText('1', { timeout: 20_000 });
  await app.page.locator('.inbox-btn').click();
  const item = app.page.locator('.inbox-pop .inbox-item').first();
  await expect(item.locator('.inbox-title')).toHaveText('Фоновая задача');
  await expect(item.locator('.inbox-kind')).toHaveText('Готово в фоне');
  await item.click();

  await expect.poll(() => app.page.evaluate(async () => (await import('./js/state.js')).state.doc.id)).toBe(home);
  const answer = await app.waitAnswer(chat);
  expect(answer.content).toBe('Codex: Долгая задача');
  await expect(app.page.locator('.inbox-btn .inbox-count'), 'ответ виден — записи нет').toBeHidden();
});

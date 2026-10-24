// «Пока вас не было» in the real app: the agent finished while the app was closed; on the next start
// the card lists it (the answer picked up from the run's journal) and a click goes to the window.
import { test, expect, isAlive } from './fixtures.mjs';

test('агент закончил при закрытом приложении: при запуске сводка «Пока вас не было»', async ({ app }) => {
  await app.page.evaluate(async () => { const { state } = await import('./js/state.js'); state.setSetting('awayMinutes', 0.02); }); // 1.2 s instead of 5 minutes
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  await app.page.evaluate((id) => window.__app.canvas.setData(id, { title: 'Ночная сборка' }), chat);
  await app.send(chat, 'Собери всё');
  await expect(app.el(chat).locator('.tool-call')).toContainText('sleep 600');
  const [run] = app.calls('codex');
  await app.closeWindow();
  app.release('codex');
  await expect.poll(() => isAlive(run.pid), { message: 'агент закончил без приложения' }).toBe(false);
  await new Promise((r) => setTimeout(r, 1500));

  await app.launch();
  const card = app.page.locator('.away-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.away-head b')).toHaveText(/^Пока вас не было · \d+ с$/);
  const row = card.locator('.away-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.away-title')).toHaveText('Ночная сборка');
  await expect(row.locator('.away-line')).toHaveText(/^Готово за \d+ с$/);
  await row.click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => app.selection()).toEqual([chat]);
});

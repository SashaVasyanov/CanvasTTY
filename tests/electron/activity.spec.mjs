// The line «what the agent is doing» with real CLI processes: the tool names Codex and Claude Code
// really send, the same line after the app was restarted while the agent worked (the window follows
// the run from its journal), and the outcome after the answer. renderer/js/activity.js
import { test, expect, isAlive } from './fixtures.mjs';

const head = (app, id) => app.el(id).locator('.node-head .head-activity');

test('Codex: «Запускает sleep 600 · …», после перезапуска приложения то же, потом «Готово за …»', async ({ app }) => {
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'Долгая задача');
  await expect(head(app, chat)).toHaveText(/^Запускает sleep 600 · \d+ с$/);
  const started = await app.page.evaluate((id) => window.__app.canvas.node(id).data.messages.at(-1).ts, chat);

  await app.closeWindow();
  await app.launch();
  await expect(head(app, chat)).toHaveText(/^Запускает sleep 600 · \d+ с$/);
  // the time counts from the start of the answer, not from the restart
  expect(await app.page.evaluate((id) => window.__app.canvas.node(id).data.messages.at(-1).ts, chat)).toBe(started);

  app.release('codex');
  const answer = await app.waitAnswer(chat);
  expect(answer.end).toBeGreaterThanOrEqual(started);
  await expect(head(app, chat)).toHaveText(/^Готово за \d+ с$/);
  await app.restart();
  await expect(head(app, chat)).toHaveText(/^Готово за \d+ с$/);
});

test('ответ закончился при закрытом приложении: «Готово за …» без времени, пока приложение было закрыто', async ({ app }) => {
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'Сделай пока меня нет');
  await expect(head(app, chat)).toHaveText(/^Запускает sleep 600/);
  const [run] = app.calls('codex');
  await app.closeWindow();
  app.release('codex');
  await expect.poll(() => isAlive(run.pid), { message: 'агент закончил без приложения' }).toBe(false);
  const exited = Date.now();
  await new Promise((r) => setTimeout(r, 2500));

  await app.launch();
  const answer = await app.waitAnswer(chat);
  expect(answer.end, 'конец ответа — когда агент закончил, а не когда окно его увидело').toBeLessThanOrEqual(exited + 500);
  await expect(head(app, chat)).toHaveText(/^Готово за \d+ с$/);
});

test('Claude Code: строка по шагам настоящего потока, после ответа — итог', async ({ app }) => {
  app.scenario({ claude: 'slow' });
  const chat = await app.openAgentChat('claude');
  await app.send(chat, 'Подожди');
  await expect(head(app, chat)).toHaveText(/^Запускает sleep 600 · \d+ с$/);
  app.release('claude');
  await app.waitAnswer(chat);
  await expect(head(app, chat)).toHaveText(/^Готово за \d+ с$/);
});

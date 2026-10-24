// What an agent is doing right now: a line in the window header, on the card of a far-away window,
// in the agents hub and the «Агенты» widget — «Запускает npm test · 2 мин», «Правит README.md»,
// «Думает…»; after the answer «Готово за 2 мин · 1 файл» (also after a reload).
// The wording itself: tests/unit/activity.test.mjs. renderer/js/activity.js, nodes.js statusInfo
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat, sendMessage, recordAgentRuns, agentRun, emitAgent, recordApiChats, apiRun, emitApi, setZoom } from './helpers/chat.mjs';
import { reloadApp } from './helpers/notes.mjs';

const head = (app, id) => app.el(id).locator('.node-head .head-activity');
const card = (app, id) => app.el(id).locator('.node-card .card-status');
// the answer started this long ago (instead of waiting minutes)
const startedAgo = (page, id, ms) => page.evaluate(([id, ms]) => { window.__app.canvas.views.get(id).inst.live.ts -= ms; }, [id, ms]);

test('чат агента: строка в шапке меняется по шагам, время идёт; после ответа — итог', async ({ app, page }) => {
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { x: 0, y: 0, data: { title: 'Сборка' } });
  const c = chat(app, id);
  await expect(head(app, id)).toBeHidden(); // nothing yet
  await sendMessage(c, 'Почини тесты');
  await agentRun(page);
  await expect(head(app, id)).toHaveText(/^Думает… · \d+ с$/);
  await expect(head(app, id)).toHaveClass(/busy/);

  await emitAgent(page, { type: 'tool', id: 't1', name: 'Команда', input: "bash -lc 'cd /home/u/app && npm test'" });
  await expect(head(app, id)).toHaveText(/^Запускает npm test · \d+ с$/);
  await startedAgo(page, id, 125_000);
  await expect(head(app, id)).toHaveText('Запускает npm test · 2 мин');
  await expect(head(app, id)).toHaveAttribute('title', 'Запускает npm test · 2 мин');

  await emitAgent(page, { type: 'toolResult', id: 't1', output: 'ok' });
  await expect(head(app, id)).toHaveText('Думает… · 2 мин');
  await emitAgent(page, { type: 'tool', id: 't2', name: 'Файлы', input: 'update C:\\proj\\README.md' });
  await expect(head(app, id)).toHaveText('Правит README.md · 2 мин');
  await emitAgent(page, { type: 'toolResult', id: 't2', output: 'ok' });
  await emitAgent(page, { type: 'delta', text: 'Готово, тесты проходят.' });
  await expect(head(app, id)).toHaveText('Пишет ответ… · 2 мин');

  await emitAgent(page, { type: 'done', sessionId: 's1' });
  await expect(head(app, id)).toHaveText('Готово за 2 мин · 1 файл');
  await expect(head(app, id)).toHaveClass(/idle/);
  const m = (await app.node(id)).data.messages.at(-1);
  expect(m.end - m.ts).toBeGreaterThanOrEqual(125_000);

  // saved with the answer: the same after a reload
  await page.waitForTimeout(700); // the canvas save
  await reloadApp(page);
  await expect(head(app, id)).toHaveText('Готово за 2 мин · 1 файл');
});

test('карточка далёкого окна, пульт агентов и виджет «Агенты» показывают то же', async ({ app, page }) => {
  await recordAgentRuns(page);
  await app.add('hub', { x: -900, y: 0 });
  await app.add('widget', { x: 600, y: 0, w: 320, h: 260, data: { kind: 'agents' } }); // on screen: hidden widgets do not tick
  const id = await addAgentChat(app, { x: 0, y: 0, data: { title: 'Ночная задача' } });
  await sendMessage(chat(app, id), 'Сделай отчёт');
  await agentRun(page);
  await emitAgent(page, { type: 'tool', id: 't1', name: 'Read', input: '/home/u/app/package.json' });
  await startedAgo(page, id, 61_000);
  const line = 'Читает package.json · 1 мин';
  await expect(page.locator('.hs-row .hs-st').filter({ hasText: 'Читает' })).toHaveText(line, { timeout: 5000 });
  await expect(page.locator('.wg-agent').filter({ hasText: 'Ночная задача' }).locator('.wg-agent-st')).toHaveText(line);

  await setZoom(page, 0.15); // far away: the window is a card
  await expect(card(app, id)).toBeVisible();
  await expect(card(app, id)).toHaveText(line);
  await emitAgent(page, { type: 'tool', id: 't2', name: 'Grep', input: 'TODO' });
  await expect(card(app, id)).toHaveText('Ищет «TODO» · 1 мин');
  await emitAgent(page, { type: 'done' });
  await expect(card(app, id)).toHaveText('Готово за 1 мин');
  await expect(page.locator('.wg-agent').filter({ hasText: 'Ночная задача' }).locator('.wg-agent-st')).toHaveText('Готово за 1 мин');
});

test('остановили — «Остановлено через …»; API-чат: пишет ответ, потом «Готово за …»', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, y: 0 });
  await sendMessage(chat(app, a), 'Долгая задача');
  await agentRun(page);
  await emitAgent(page, { type: 'tool', id: 't1', name: 'Bash', input: 'sleep 100' });
  await expect(head(app, a)).toHaveText(/^Запускает sleep 100/);
  await chat(app, a).send.click(); // the send button is «stop» while it works
  await expect(head(app, a)).toHaveText(/^Остановлено через \d+ с$/);

  await recordApiChats(page);
  const b = await addApiChat(app, { x: 700, y: 0 });
  await sendMessage(chat(app, b), 'Привет');
  await apiRun(page);
  await expect(head(app, b)).toHaveText(/^Думает… · \d+ с$/);
  await emitApi(page, { type: 'delta', text: 'Здравствуйте' });
  await expect(head(app, b)).toHaveText(/^Пишет ответ… · \d+ с$/);
  await emitApi(page, { type: 'done' });
  await expect(head(app, b)).toHaveText(/^Готово за \d+ с$/);
});

test('ошибка — красная строка «Ошибка через …»; старые ответы без времени — без строки', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, y: 0 });
  await sendMessage(chat(app, a), 'Сделай');
  await agentRun(page);
  await emitAgent(page, { type: 'error', message: 'boom' });
  await emitAgent(page, { type: 'done' });
  await expect(head(app, a)).toHaveText(/^Ошибка через \d+ с$/);
  await expect(head(app, a)).toHaveClass(/na/);

  const old = await addAgentChat(app, { x: 700, y: 0, data: { messages: [{ role: 'user', content: 'x', ts: 1 }, { role: 'assistant', content: 'y', parts: [{ type: 'text', text: 'y' }], ts: 2 }] } });
  await page.waitForTimeout(1200);
  await expect(head(app, old)).toBeHidden();
  await expect(card(app, old)).toHaveText('Ожидает');
});

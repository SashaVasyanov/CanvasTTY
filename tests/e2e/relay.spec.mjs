// An arrow between chat windows in «Передавать ответ» mode: the source's answer becomes the
// target's next message (with the arrow's note), the arrow lights up, a busy target gets it after
// its own answer, the chain stops after RELAY_MAX steps without the user, «Стоп» stops the chain,
// a closed canvas gets the answer when it opens.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat, recordAgentRuns, recordApiChats, agentRun, agentRuns, apiRun, emitAgent, sendMessage } from './helpers/chat.mjs';

const relayEdge = (page, from, to, note = '') => page.evaluate(([from, to, note]) => {
  const c = window.__app.canvas;
  c.addEdge(from, to, { relay: { note } });
  return c.doc.edges.at(-1).id;
}, [from, to, note]);
const answer = async (page, i, text) => { await emitAgent(page, { type: 'delta', text }, i); await emitAgent(page, { type: 'done', sessionId: `s${i}` }, i); };

test('меню стрелки между чатами: «Передавать ответ», подпись, стрелка не контекст', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 420, data: { title: 'План' } });
  const b = await addAgentChat(app, { x: 560, w: 420, data: { title: 'Код' } });
  await page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b), [a, b]);
  // an ordinary arrow: A is context for B
  await expect(chat(app, b).ctxChips).toHaveCount(1);
  const line = page.locator('.edge .edge-hit').first();
  const box = await line.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Передавать ответ' }).click();
  const [e] = await app.edges();
  expect(e.relay).toEqual({ note: '' });
  await expect(page.locator('.edge.relay .edge-label')).toHaveText('передаёт ответ');
  await expect(chat(app, b).ctxChips, 'стрелка с передачей — не контекст').toHaveCount(0);
  // the note before the passed answer
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Приписка к ответу' }).click();
  await page.locator('.modal input').fill('Проверь этот план');
  await page.locator('.modal input').press('Enter');
  expect((await app.edges())[0].relay).toEqual({ note: 'Проверь этот план' });
  await app.undo();
  expect((await app.edges())[0].relay).toEqual({ note: '' });
});

test('A ответил — B получает ответ с припиской и сам начинает работать', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, w: 420, data: { title: 'План' } });
  const b = await addAgentChat(app, { x: 560, w: 420, data: { title: 'Код' } });
  await relayEdge(page, a, b, 'Реализуй этот план:');
  await sendMessage(chat(app, a), 'Составь план');
  await agentRun(page, 0);
  await answer(page, 0, '1. Модель\n2. API');
  const run = await agentRun(page, 1);
  expect(run.prompt).toBe('Реализуй этот план:\n\n1. Модель\n2. API');
  await expect(page.locator('.edge.relaying')).toHaveCount(1);
  const userB = chat(app, b).userMsgs.last();
  await expect(userB.locator('.msg-relay')).toHaveText('от «План»');
  const saved = (await app.node(b)).data.messages[0];
  expect(saved.relay).toMatchObject({ from: a, title: 'План', depth: 1 });
  // errors and stopped answers are not passed on
  await sendMessage(chat(app, a), 'Ещё');
  await agentRun(page, 2);
  await emitAgent(page, { type: 'error', message: 'fetch failed' }, 2);
  await emitAgent(page, { type: 'done' }, 2);
  await expect(chat(app, a).lastAnswer).toContainText('Нет связи');
  expect((await agentRuns(page)).length).toBe(3);
});

test('B занят — ответ A уходит после его текущего ответа', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, w: 420 });
  const b = await addAgentChat(app, { x: 560, w: 420 });
  await relayEdge(page, a, b);
  await sendMessage(chat(app, b), 'Своя задача B'); // run 0
  await sendMessage(chat(app, a), 'Задача A'); // run 1
  await agentRun(page, 1);
  await answer(page, 1, 'Ответ A');
  await page.waitForTimeout(200);
  expect((await agentRuns(page)).length, 'B ещё занят').toBe(2);
  await answer(page, 0, 'Ответ B');
  const run = await agentRun(page, 2);
  expect(run.prompt).toMatch(/Ответ A$/);
});

test('цепочка по кругу останавливается после 5 передач без вас', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, w: 420, data: { title: 'A' } });
  const b = await addAgentChat(app, { x: 560, w: 420, data: { title: 'B' } });
  await relayEdge(page, a, b);
  await relayEdge(page, b, a);
  await sendMessage(chat(app, a), 'Начни');
  for (let i = 0; i <= 5; i++) { await agentRun(page, i); await answer(page, i, `шаг ${i}`); }
  await expect(page.locator('.toast').last()).toContainText('Цепочка передач остановлена после 5 шагов');
  expect((await agentRuns(page)).length, 'вопрос пользователя + 5 передач').toBe(6);
  // the user writes again: the count starts over
  await sendMessage(chat(app, a), 'Ещё круг');
  await agentRun(page, 6);
  await answer(page, 6, 'снова');
  await agentRun(page, 7);
});

test('«Стоп» в одном окне цепочки останавливает и остальные', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, y: 0, w: 380, h: 420 });
  const b = await addAgentChat(app, { x: 480, y: 0, w: 380, h: 420 });
  const c = await addAgentChat(app, { x: 480, y: 480, w: 380, h: 420 });
  await relayEdge(page, a, b);
  await relayEdge(page, a, c);
  await sendMessage(chat(app, a), 'Раздай');
  await agentRun(page, 0);
  await answer(page, 0, 'задание');
  await agentRun(page, 2);
  const runs = await agentRuns(page);
  await chat(app, b).send.click(); // «Стоп»
  await expect.poll(() => page.evaluate(() => window.__agentAborts.slice().sort())).toEqual([runs[1].reqId, runs[2].reqId].sort());
});

test('ответ пришёл, пока canvas окна закрыт: B отправит его, когда canvas откроют', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await addAgentChat(app, { x: 0, w: 420, data: { title: 'План' } });
  const b = await addAgentChat(app, { x: 560, w: 420, data: { title: 'Код' } });
  await relayEdge(page, a, b);
  await sendMessage(chat(app, a), 'План');
  await agentRun(page, 0);
  const home = await page.evaluate(async () => { const { state } = await import('/js/state.js'); const id = state.doc.id; await state.flushAll(); await state.createCanvas(state.project.id, 'Другой'); return id; });
  await answer(page, 0, 'готовый план');
  await expect.poll(async () => page.evaluate(async ([home, b]) => { const { native } = await import('/js/state.js'); const d = await native.canvas.load(home); return d.nodes.find((n) => n.id === b).data.pendingRelay?.length || 0; }, [home, b])).toBe(1);
  expect((await agentRuns(page)).length).toBe(1);
  await page.evaluate(async (home) => { const { state } = await import('/js/state.js'); await state.openCanvas(state.project.id, home); }, home);
  const run = await agentRun(page, 1);
  expect(run.prompt).toMatch(/готовый план$/);
  expect((await app.node(b)).data.pendingRelay).toBeNull();
});

test('в API-чат тоже можно передавать', async ({ app, page }) => {
  await recordAgentRuns(page);
  await recordApiChats(page);
  const a = await addAgentChat(app, { x: 0, w: 420, data: { title: 'Агент' } });
  const b = await addApiChat(app, { x: 560, w: 420 });
  await relayEdge(page, a, b, 'Переведи на английский:');
  await sendMessage(chat(app, a), 'Напиши текст');
  await agentRun(page, 0);
  await answer(page, 0, 'Привет');
  const r = await apiRun(page, 0);
  expect(r.messages.at(-1).content).toBe('Переведи на английский:\n\nПривет');
});

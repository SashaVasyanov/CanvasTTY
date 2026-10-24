// A running answer in AI chat windows: status, stopping (also before the agent started and from a
// re-created window), streaming into the list, Codex reconnects and generated pictures.
import { test, expect } from './fixtures.mjs';
import {
  idle, addAgentChat, addApiChat, addEdge, chat, sendMessage, expectStatus, setZoom, listScroll, expectAtBottom,
  recordAgentRuns, agentRun, agentRuns, agentAborts, emitAgent, recordApiChats, apiRun, apiRuns, emitApi,
} from './helpers/chat.mjs';

// a finished conversation: pairs of «вопрос k» / answer
const history = (pairs, answer = (k) => `ответ ${k}`) => {
  const msgs = [];
  for (let k = 0; k < pairs; k++) {
    msgs.push({ role: 'user', content: `вопрос ${k}`, ts: 1 });
    msgs.push({ role: 'assistant', content: answer(k), parts: [{ type: 'text', text: answer(k) }], ts: 1 });
  }
  return msgs;
};

// pictures from the vault are read for the context only when the test lets them
async function gateAssets(page) {
  await page.evaluate(async () => {
    const { native } = await import('/js/state.js');
    const read = native.vault.readAsset, save = native.attach.saveBytes;
    window.__assetGate = new Promise((r) => { window.__releaseAssets = r; });
    window.__ctxSaved = 0;
    native.vault.readAsset = async (p) => { await window.__assetGate; return read(p); };
    native.attach.saveBytes = async (o) => { const r = await save(o); window.__ctxSaved++; return r; };
  });
}
// lets them go and waits until the context of the message is collected
async function releaseAssets(page) {
  await page.evaluate(() => window.__releaseAssets());
  await expect.poll(() => page.evaluate(() => window.__ctxSaved)).toBeGreaterThan(0);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0))); // the rest of send() runs in microtasks
}

// opens a new canvas (the chat window is destroyed) and returns a function that comes back to this one
const openOtherCanvas = async (page) => {
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    window.__cv0 = state.doc.id;
    await state.createCanvas(state.project.id, 'Второй');
  });
  return async () => {
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      await state.openCanvas(state.project.id, window.__cv0);
      const c = window.__app.canvas; c.vp.x = 300; c.vp.y = 150; c.vp.z = 1; c.applyViewport();
    });
    await idle(page);
  };
};

test.describe('статус и остановка', () => {
  test('«Работает» в заголовке, карточке и виджете; после пересоздания окна тоже, и Стоп из нового окна работает', async ({ app, page }) => {
    await recordAgentRuns(page);
    await page.evaluate(() => window.__app.addWidget('agents', { x: 0, y: 0 }));
    const id = await addAgentChat(app, { x: 400 });
    const c = chat(app, id);
    const row = page.locator('.wg-agent');
    await expect(row.locator('.wg-agent-st')).toHaveText('Готов');
    await expectStatus(c, 'Готов', 'idle');

    await sendMessage(c, 'Сделай карту');
    await agentRun(page);
    await expectStatus(c, 'Работает', 'busy');
    await expect(c.send).toHaveClass(/stop/);
    await expect(row.locator('.wg-agent-st')).toHaveText(/^Думает… · \d+ с$/); // what it is doing (activity.spec)
    await expect(row).toHaveClass(/st-busy/);
    await expect(page.locator('.wg-count')).toHaveText('1 из 1 работают');
    await emitAgent(page, { type: 'delta', text: ' слово1' });
    await expect(c.lastAnswer).toContainText('слово1');

    // far out the chat becomes a card with the status
    await setZoom(page, 0.15);
    await expect(c.cardStatus).toBeVisible();
    await expect(c.cardStatus).toHaveText(/^Пишет ответ… · \d+ с$/);
    await setZoom(page, 1);

    // another canvas and back: the window is created anew while the answer goes on
    const back = await openOtherCanvas(page);
    await expect(app.el(id)).toHaveCount(0);
    await emitAgent(page, { type: 'delta', text: ' слово2' });
    await back();
    await expect(app.el(id)).toBeVisible();
    await expectStatus(c, 'Работает', 'busy');
    await expect(c.send).toHaveClass(/stop/);
    await expect(c.userMsgs).toHaveText(['Сделай карту']);
    await emitAgent(page, { type: 'delta', text: ' слово3' });
    await expect(c.lastAnswer, 'новое окно показывает идущий ответ').toContainText('слово1 слово2 слово3');
    await expect(page.locator('.wg-agent .wg-agent-st'), 'новое окно знает, что делает агент').toHaveText(/^Пишет ответ… · \d+ с$/);

    await c.send.click();
    const { reqId } = (await agentRuns(page))[0];
    await expect.poll(() => agentAborts(page), { message: 'остановлен идущий запуск' }).toEqual([reqId]);
    await expectStatus(c, 'Ожидает', 'idle');
    await expect(c.send).not.toHaveClass(/stop/);
    await expect(c.lastAnswer).toContainText('слово1 слово2 слово3');
    await expect(c.lastAnswer).toContainText('Остановлено');
    await expect(page.locator('.wg-agent .wg-agent-st')).toHaveText(/^Остановлено через \d+ с$/);
  });

  test('сообщение и «Работает» видны сразу, пока собирается контекст; Стоп до запуска агента ничего не запускает', async ({ app, page }) => {
    await recordAgentRuns(page);
    const img = await app.addImage({ x: 0, y: 200 });
    await gateAssets(page);
    const id = await addAgentChat(app, { x: 400 });
    await addEdge(page, img, id);
    const c = chat(app, id);

    await sendMessage(c, 'Опиши картинку');
    await expect(c.userMsgs).toHaveText(['Опиши картинку']);
    await expect(c.lastAnswer.locator('.typing')).toBeVisible();
    await expect(c.input).toHaveValue('');
    await expectStatus(c, 'Работает', 'busy');
    await expect(c.send).toHaveClass(/stop/);
    expect(await agentRuns(page), 'агент ещё не запущен: собирается контекст').toHaveLength(0);

    await c.send.click();
    await expectStatus(c, 'Ожидает', 'idle');
    await expect(c.send).not.toHaveClass(/stop/);
    await expect(c.lastAnswer).toContainText('Остановлено');
    await expect(c.lastAnswer.locator('.typing')).toHaveCount(0);

    await releaseAssets(page); // the context is ready now, but nobody waits for the answer any more
    expect(await agentRuns(page)).toHaveLength(0);
    expect(await agentAborts(page), 'останавливать было нечего').toEqual([]);
    await expectStatus(c, 'Ожидает');

    // the next message starts the agent as usual, with the picture linked by the arrow (send() still
    // records ctxHash after a stop; today the stale inst.node copy hides that — see the fixme below)
    await sendMessage(c, 'Опиши картинку ещё раз');
    const run = await agentRun(page);
    expect(run.prompt).toContain('Картинка «');
    expect(run.prompt.endsWith('---\n\nОпиши картинку ещё раз')).toBe(true);
    expect(run.attachments).toHaveLength(1);
  });

  test('API-чат: «Отвечает…» сразу; Стоп во время сбора контекста не отправляет запрос', async ({ app, page }) => {
    await recordApiChats(page);
    const img = await app.addImage({ x: 0, y: 200 });
    await gateAssets(page);
    const id = await addApiChat(app, { x: 400 });
    await addEdge(page, img, id);
    const c = chat(app, id);

    await sendMessage(c, 'Что на картинке?');
    await expect(c.userMsgs).toHaveText(['Что на картинке?']);
    await expect(c.lastAnswer.locator('.typing')).toBeVisible();
    await expectStatus(c, 'Отвечает…', 'busy');
    await expect(c.send).toHaveClass(/stop/);

    await c.send.click();
    await expect(c.lastAnswer.locator('.msg-text')).toHaveText('(остановлено)');
    await expectStatus(c, '2 сообщ.', 'idle');
    await expect(c.send).not.toHaveClass(/stop/);
    await releaseAssets(page);
    expect(await apiRuns(page)).toHaveLength(0);
  });

  test('API-чат: Стоп во время ответа оставляет уже написанное', async ({ app, page }) => {
    await recordApiChats(page);
    const id = await addApiChat(app);
    const c = chat(app, id);
    await sendMessage(c, 'Расскажи историю');
    const req = await apiRun(page);
    await emitApi(page, { type: 'delta', text: 'Жил-был **агент**' });
    await expect(c.lastAnswer.locator('.msg-text')).toHaveText('Жил-был агент');
    await expectStatus(c, 'Отвечает…', 'busy');
    await c.send.click();
    await expect.poll(() => page.evaluate(() => window.__apiAborts)).toEqual([req.reqId]);
    await expectStatus(c, '2 сообщ.', 'idle');
    await expect(c.lastAnswer.locator('.msg-text')).toHaveText('Жил-был агент');
    await expect(c.lastAnswer.locator('.msg-text strong')).toHaveText('агент');
  });

  // Regression (fixed): patchNodeData() replaces the window's inst.node with a copy when an answer ends (and on
  // 'session'). The next send() stores the new messages on the canvas node but renders this.messages
  // from that stale copy: the new question is missing and the streaming answer is painted into the
  // previous answer until the run ends. Agent chats and API chats alike (both use patchNodeData).
  test('агент: второй вопрос и ответ на него видны сразу, прошлый ответ не затирается', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app);
    const c = chat(app, id);
    await sendMessage(c, 'Первый вопрос');
    await agentRun(page, 0);
    await emitAgent(page, { type: 'session', sessionId: 's1' });
    await emitAgent(page, { type: 'delta', text: 'Первый ответ' });
    await emitAgent(page, { type: 'done', sessionId: 's1' });
    await expectStatus(c, 'Ожидает');

    await sendMessage(c, 'Второй вопрос');
    await expect(c.userMsgs).toHaveText(['Первый вопрос', 'Второй вопрос']);
    await expect(c.lastAnswer.locator('.typing')).toBeVisible();
    await agentRun(page, 1);
    await emitAgent(page, { type: 'delta', text: 'Второй ответ' });
    await expect(c.lastAnswer).toContainText('Второй ответ');
    await expect(c.el.locator('.chat-list > .msg.assistant').first()).toContainText('Первый ответ');
  });

  test('API-чат: второй вопрос и ответ на него видны сразу, прошлый ответ не затирается', async ({ app, page }) => {
    await recordApiChats(page);
    const id = await addApiChat(app);
    const c = chat(app, id);
    await sendMessage(c, 'Первый вопрос');
    await apiRun(page, 0);
    await emitApi(page, { type: 'delta', text: 'Первый ответ' });
    await emitApi(page, { type: 'done' });
    await expectStatus(c, '2 сообщ.');

    await sendMessage(c, 'Второй вопрос');
    await expect(c.userMsgs).toHaveText(['Первый вопрос', 'Второй вопрос']);
    await expect(c.lastAnswer.locator('.typing')).toBeVisible();
    await apiRun(page, 1);
    await emitApi(page, { type: 'delta', text: 'Второй ответ' });
    await expect(c.lastAnswer.locator('.msg-text')).toHaveText('Второй ответ');
    await expect(c.el.locator('.chat-list > .msg.assistant').first().locator('.msg-text')).toHaveText('Первый ответ');
  });
});

test.describe('Codex', () => {
  const reconnect = (k) => ({ type: 'notice', reconnect: true, text: `Связь с сервером OpenAI прервалась, Codex переподключается (${k} из 5)…`, detail: `Reconnecting... ${k}/5 (stream disconnected)` });

  test('переподключение — одна жёлтая строка; нарисованная картинка видна в ответе, открывается и кладётся на холст', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { x: 400 });
    const c = chat(app, id);
    const retry = c.el.locator('.msg-retry');
    await sendMessage(c, 'Нарисуй карту');
    await agentRun(page);
    await emitAgent(page, { type: 'session', sessionId: '01a15fb3-test' });
    await emitAgent(page, { type: 'delta', text: 'Генерирую карту.' });
    await emitAgent(page, { type: 'break' });
    await emitAgent(page, reconnect(2));
    await expect(retry).toHaveText(['Связь с сервером OpenAI прервалась, Codex переподключается (2 из 5)…']);
    await emitAgent(page, reconnect(3));
    await expect(retry, 'одна строка, которая считает попытки').toHaveText(['Связь с сервером OpenAI прервалась, Codex переподключается (3 из 5)…']);
    await expect(retry).toHaveAttribute('title', 'Reconnecting... 3/5 (stream disconnected)');
    const colors = await retry.evaluate((el) => {
      const probe = (v) => { const p = document.createElement('span'); p.style.color = `var(${v})`; el.parentNode.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
      return { got: getComputedStyle(el).color, amber: probe('--amber'), red: probe('--red') };
    });
    expect(colors.got, 'жёлтая строка').toBe(colors.amber);
    expect(colors.got).not.toBe(colors.red);
    await expect(c.el.locator('.msg-error'), 'никаких красных ошибок').toHaveCount(0);
    await expectStatus(c, 'Работает', 'busy');

    // Codex is back and saved a picture: the notice goes, the picture shows in the answer
    const url = await page.evaluate(() => { const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200; const g = cv.getContext('2d'); g.fillStyle = '#22aa66'; g.fillRect(0, 0, 300, 200); return cv.toDataURL('image/png'); });
    await emitAgent(page, { type: 'image', att: { name: 'map.png', kind: 'image', file: 'x-map.png', url, size: 1000 }, path: '/x/map.png' });
    await emitAgent(page, { type: 'delta', text: 'Готово — карта выше.' });
    await expect(retry).toHaveCount(0);
    const fig = c.el.locator('.msg-gen');
    await expect(fig.locator('img')).toBeVisible();
    await expect(fig.locator('img')).toHaveAttribute('src', url);
    await expect.poll(() => fig.locator('img').evaluate((i) => i.naturalWidth)).toBe(300);
    await emitAgent(page, { type: 'done', sessionId: '01a15fb3-test' });
    await expectStatus(c, 'Ожидает', 'idle');
    await expect(fig.locator('img'), 'картинка осталась в готовом ответе').toBeVisible();
    await expect(c.lastAnswer.locator('.msg-text')).toHaveText(['Генерирую карту.', 'Готово — карта выше.']);
    expect((await app.node(id)).data.messages.at(-1).parts.map((p) => p.type)).toEqual(['text', 'image', 'text']);

    await fig.locator('.msg-gen-img').click();
    await expect(page.locator('.lightbox .lb-cap')).toHaveText('map.png');
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);

    await fig.getByRole('button', { name: 'На холст' }).click();
    await expect.poll(async () => (await app.nodes('image')).length).toBe(1);
    const [img] = await app.nodes('image');
    expect([img.w, img.h]).toEqual([300, 200]);
    expect(await app.selection()).toEqual([img.id]);
    await expect(page.locator('.toast', { hasText: 'Картинка на холсте' })).toBeVisible();
  });

  // Regression (fixed): imageToCanvas() passes the point 60 px right of the chat's top-right corner, meant as the
  // picture's top-left corner (like «В заметку» does with center: false), but imageNodeFromFile() adds
  // the node centred on that point, so the picture covers the right part of the chat window
  // (a 300×200 picture by 90 px, a big generated one — up to 520 px wide — by 200 px).
  test('«На холст» кладёт картинку рядом с чатом, не закрывая его', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { x: 400 });
    const c = chat(app, id);
    await sendMessage(c, 'Нарисуй карту');
    await agentRun(page);
    const url = await page.evaluate(() => { const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200; return cv.toDataURL('image/png'); });
    await emitAgent(page, { type: 'image', att: { name: 'map.png', kind: 'image', file: 'x-map.png', url, size: 1000 } });
    await emitAgent(page, { type: 'done', sessionId: 's1' });
    await c.el.locator('.msg-gen').getByRole('button', { name: 'На холст' }).click();
    await expect.poll(async () => (await app.nodes('image')).length).toBe(1);
    const [img] = await app.nodes('image');
    const me = await app.node(id);
    expect(img.x, 'левый край картинки правее чата').toBeGreaterThanOrEqual(me.x + me.w);
    expect(img.x - (me.x + me.w), 'и недалеко от него').toBeLessThanOrEqual(100);
    expect(img.y, 'на уровне верха чата').toBe(me.y);
  });

  test('если переподключиться не удалось — строка сменяется ошибкой, статус «Ошибка»', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { x: 400 });
    const c = chat(app, id);
    await sendMessage(c, 'Нарисуй карту');
    await agentRun(page);
    await emitAgent(page, reconnect(5));
    await expect(c.el.locator('.msg-retry')).toHaveCount(1);
    await emitAgent(page, { type: 'error', message: 'stream disconnected before completion' });
    await emitAgent(page, { type: 'done' });
    await expect(c.el.locator('.msg-retry')).toHaveCount(0);
    // the error in plain words; the original text stays under «Подробности»
    await expect(c.el.locator('.msg-error .err-title')).toHaveText(['⚠ Нет связи с сервером']);
    await expect(c.el.locator('.msg-error .err-actions button')).toHaveText(['Повторить']);
    await expect(c.el.locator('.msg-error .err-raw pre')).toHaveText('stream disconnected before completion');
    await expectStatus(c, 'Ошибка', 'na');
  });
});

test.describe('лента сообщений', () => {
  test('пока ответ идёт, прокрутка вверх сохраняет место и показывает «К последнему сообщению»', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { x: 300, y: -100, w: 600, h: 700, data: { messages: history(8, (k) => `ответ ${k} `.repeat(40)), sessionId: 's', title: 'Чат' } });
    const c = chat(app, id);
    const stream = (from, to) => page.evaluate(([from, to]) => {
      const r = window.__agentRuns.at(-1);
      for (let i = from; i <= to; i++) window.__mockEmit('agentchat:event', { reqId: r.reqId, type: 'delta', text: ` слово${i}${i % 8 ? '' : '\n\n'}` });
    }, [from, to]);
    await expectAtBottom(c);
    await expect(c.jump).toBeHidden();

    await sendMessage(c, 'новый вопрос');
    await agentRun(page);
    await stream(1, 24);
    await expect(c.lastAnswer).toContainText('слово24');
    await expectAtBottom(c);
    await expect(c.jump).toBeHidden();

    // the reader scrolls up into the history
    const box = await c.list.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.wheel(0, -600);
    await expect(c.jump).toBeVisible();
    await expect.poll(async () => (await listScroll(c)).dist).toBeGreaterThan(300);
    let before = await listScroll(c);
    await expect.poll(async () => { const now = await listScroll(c); const same = now.top === before.top; before = now; return same; }).toBe(true); // scrolling settled

    await stream(25, 60);
    await expect(c.lastAnswer).toContainText('слово60');
    expect(Math.abs((await listScroll(c)).top - before.top), 'место чтения не сдвинулось').toBeLessThanOrEqual(2);
    await expect(c.jump).toBeVisible();
    await expect(c.jump).toHaveAttribute('title', 'К последнему сообщению');

    // the button brings the newest back, and the list follows again
    await c.jump.click();
    await expectAtBottom(c);
    await expect(c.jump).toBeHidden();
    await stream(61, 90);
    await expect(c.lastAnswer).toContainText('слово90');
    await expectAtBottom(c);
    await emitAgent(page, { type: 'done', sessionId: 's' });
    await expectStatus(c, 'Ожидает');
    await expectAtBottom(c);
  });

  test('старые сообщения не пропадают, пока идёт ответ; разговор попадает в историю', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { x: 300, y: -100, w: 600, h: 700, data: { messages: history(6), sessionId: 'sess-1', title: 'Старый чат' } });
    const c = chat(app, id);
    const old = Array.from({ length: 6 }, (_, k) => `вопрос ${k}`);
    await expect(c.msgs).toHaveCount(12);

    await sendMessage(c, 'новый вопрос');
    await expect(c.msgs).toHaveCount(14);
    await agentRun(page);
    await emitAgent(page, { type: 'session', sessionId: 'sess-1' });
    for (let i = 1; i <= 5; i++) {
      await emitAgent(page, { type: 'delta', text: ` w${i}` });
      await expect(c.lastAnswer).toContainText(`w${i}`);
      await expect(c.msgs).toHaveCount(14);
    }
    await expect(c.userMsgs).toHaveText([...old, 'новый вопрос']);
    await emitAgent(page, { type: 'done', sessionId: 'sess-1' });
    await expectStatus(c, 'Ожидает');
    await expect(c.msgs).toHaveCount(14);
    await expect(c.userMsgs).toHaveText([...old, 'новый вопрос']);
    await expect(c.lastAnswer).toContainText('w1 w2 w3 w4 w5');

    await c.el.locator('.hist-btn').click();
    await expect(c.el.locator('.hist-panel .hist-item.active .hist-title')).toHaveText('Старый чат');
  });

  test('длинный чат показывает последние 40 сообщений, предыдущие подгружаются и остаются во время ответа', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { x: 300, y: -100, w: 600, h: 700, data: { messages: history(23), sessionId: 's' } });
    const c = chat(app, id);
    const more = c.el.locator('.msg-more');
    await expect(c.msgs).toHaveCount(40);
    await expect(c.userMsgs.first()).toHaveText('вопрос 3');
    await expect(more).toHaveText('Показать предыдущие сообщения (6)');
    await more.click();
    await expect(c.msgs).toHaveCount(46);
    await expect(more).toHaveCount(0);
    await expect(c.userMsgs.first()).toHaveText('вопрос 0');

    await sendMessage(c, 'новый вопрос');
    await agentRun(page);
    await emitAgent(page, { type: 'delta', text: 'ответ' });
    await expect(c.lastAnswer).toContainText('ответ');
    // the loaded history stays (the window keeps its size: the two oldest move behind the button again)
    await expect.poll(() => c.msgs.count(), { message: 'подгруженные сообщения не пропадают' }).toBeGreaterThanOrEqual(46);
    await expect(c.userMsgs.filter({ hasText: /^вопрос 1$/ })).toHaveCount(1);
    await expect(c.userMsgs.last()).toHaveText('новый вопрос');
  });
});

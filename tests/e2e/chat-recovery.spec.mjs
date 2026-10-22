// Errors in plain words with what to do, and answers that broke off (the app or the computer closed
// mid-answer): «Продолжить» / «Повторить», a run picked up again after a restart, an answer that is
// being written on another computer. The journal of background runs itself is tested in
// tests/unit/agentchat.test.mjs and the real app in tests/electron.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat, recordAgentRuns, recordApiChats, agentRun, apiRun, emitAgent, expectStatus } from './helpers/chat.mjs';

const question = { role: 'user', content: 'Сделай задачу' };
const agentError = (text, data = {}) => ({ sessionId: 'sess-1', ...data, messages: [question, { role: 'assistant', content: '', parts: [{ type: 'error', text }] }] });
const errorBox = (c) => ({ title: c.el.locator('.msg-error .err-title'), hint: c.el.locator('.msg-error .err-hint'), buttons: c.el.locator('.msg-error .err-actions button'), raw: c.el.locator('.msg-error .err-raw pre') });

test.describe('понятные ошибки', () => {
  test('Codex без входа: «Войти» открывает терминал с codex login', async ({ app, page }) => {
    const id = await addAgentChat(app, { data: agentError('unexpected status 401 Unauthorized: Your authentication token has expired.') });
    const c = chat(app, id), e = errorBox(c);
    await expect(e.title).toHaveText('⚠ Нужно войти в Codex');
    await expect(e.buttons).toHaveText(['Войти', 'Повторить']);
    await expect(e.raw).toHaveText(/401 Unauthorized/);
    await e.buttons.filter({ hasText: 'Войти' }).click();
    await expect.poll(async () => (await app.nodes('terminal')).map((n) => [n.data.agentId, n.data.extraArgs])).toEqual([['codex', 'login']]);
    const [t] = await app.nodes('terminal'), me = await app.node(id);
    expect(t.x, 'терминал справа от чата, не поверх').toBeGreaterThanOrEqual(me.x + me.w);
    expect(await app.edges(), 'терминал не становится контекстом чата').toEqual([]);
  });

  test('лимит подписки: когда снова можно, кнопки «Лимиты» и «Повторить»', async ({ app }) => {
    const ts = Math.floor(Date.now() / 1000) + 2 * 3600;
    const id = await addAgentChat(app, { data: { agentId: 'claude', kind: 'claude', ...agentError(`Claude AI usage limit reached|${ts}`) } });
    const c = chat(app, id), e = errorBox(c);
    await expect(e.title).toHaveText('⚠ Лимит подписки исчерпан');
    await expect(e.hint).toContainText(/снова можно (сегодня|\d+ \S+) в \d\d:\d\d/);
    await expect(e.buttons).toHaveText(['Лимиты', 'Повторить']);
  });

  test('недоступная модель: «Модель «Авто»» сбрасывает модель и повторяет вопрос', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { data: agentError('400 Bad Request: {"detail":"The \'gpt-9\' model is not supported when using Codex with a ChatGPT account."}', { model: 'gpt-9' }) });
    const c = chat(app, id), e = errorBox(c);
    await expect(e.hint).toContainText('«gpt-9»');
    await e.buttons.filter({ hasText: 'Модель «Авто»' }).click();
    const run = await agentRun(page);
    expect(run.model).toBe('');
    expect(run.prompt).toBe('Сделай задачу');
    expect((await app.node(id)).data.messages.map((m) => m.role), 'вопрос не задублирован').toEqual(['user', 'assistant']);
  });

  test('сеть: «Повторить» отправляет тот же вопрос с теми же вложениями', async ({ app, page }) => {
    await recordAgentRuns(page);
    const att = { id: 'a1', file: 'plan.png', name: 'plan.png', kind: 'image', size: 10 };
    const id = await addAgentChat(app, { data: { sessionId: 's', messages: [{ ...question, attachments: [att] }, { role: 'assistant', content: '', parts: [{ type: 'error', text: 'stream disconnected before completion: error sending request' }] }] } });
    const c = chat(app, id), e = errorBox(c);
    await expect(e.title).toHaveText('⚠ Нет связи с сервером');
    await e.buttons.filter({ hasText: 'Повторить' }).click();
    const run = await agentRun(page);
    expect(run.attachments.map((a) => a.file)).toEqual(['plan.png']);
    await expect(c.userMsgs).toHaveCount(1);
  });

  test('кнопки действий только под последним ответом', async ({ app }) => {
    const err = { role: 'assistant', content: '', parts: [{ type: 'error', text: 'fetch failed' }] };
    const id = await addAgentChat(app, { data: { messages: [question, err, { role: 'user', content: 'ещё' }, { role: 'assistant', content: 'ok', parts: [{ type: 'text', text: 'ok' }] }] } });
    const c = chat(app, id);
    await expect(c.el.locator('.msg-error .err-title')).toHaveText('⚠ Нет связи с сервером');
    await expect(c.el.locator('.msg-error .err-actions')).toBeHidden();
  });

  test('API-чат: неверный ключ ведёт в настройки ключей, неизвестная ошибка показана как есть', async ({ app, page }) => {
    const id = await addApiChat(app, { data: { messages: [{ role: 'user', content: 'Привет' }, { role: 'assistant', content: '⚠ 401: Incorrect API key provided: sk-abc***.', error: true }] } });
    const c = chat(app, id), e = errorBox(c);
    await expect(e.title).toHaveText('⚠ API-ключ не подходит');
    await expect(e.hint).toContainText('«OpenAI»');
    await e.buttons.filter({ hasText: 'Настройки ключей' }).click();
    await expect(page.locator('.modal, .settings').getByText('API-провайдеры').first()).toBeVisible();
    await page.keyboard.press('Escape');

    const odd = await addApiChat(app, { x: 950, data: { messages: [{ role: 'user', content: 'Привет' }, { role: 'assistant', content: '⚠ Что-то совсем новое', error: true }] } });
    const e2 = errorBox(chat(app, odd));
    await expect(e2.title).toHaveText('⚠ Ошибка');
    await expect(e2.hint).toHaveText('Что-то совсем новое');
    await expect(e2.raw).toHaveCount(0);
  });

  test('API-чат: ошибка во время ответа сохраняет исходный текст для подсказки', async ({ app, page }) => {
    await recordApiChats(page);
    const id = await addApiChat(app);
    const c = chat(app, id);
    await c.input.fill('Вопрос'); await c.input.press('Enter');
    const r = await apiRun(page);
    await page.evaluate((reqId) => window.__mockEmit('chat:event', { reqId, type: 'error', message: '503: Service Unavailable' }), r.reqId);
    await expect(errorBox(c).title).toHaveText('⚠ Сервис перегружен');
    expect((await app.node(id)).data.messages.at(-1).errorText).toBe('503: Service Unavailable');
  });
});

test.describe('прерванные ответы', () => {
  const running = (extra = {}) => ({ role: 'assistant', content: '', parts: [{ type: 'text', text: 'Начал' }], running: true, host: 'demo-pc', ...extra });

  test('ответ агента прервался: «Продолжить» продолжает ту же сессию', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { data: { sessionId: 'sess-7', messages: [question, running()] } });
    const c = chat(app, id);
    await expectStatus(c, 'Прервано', 'wait');
    await expect(c.lastAnswer).toContainText('Ответ прервался');
    await expect(c.el.locator('.msg-cta button')).toHaveText(['Продолжить', 'Начать ответ заново']);
    const title = (await app.node(id)).data.title;
    await c.el.locator('.msg-cta button', { hasText: 'Продолжить' }).click();
    const run = await agentRun(page);
    expect(run.sessionId).toBe('sess-7');
    expect(run.prompt).toMatch(/^Продолжи с того места/);
    expect((await app.node(id)).data.title, 'название окна не меняется на «Продолжи…»').toBe(title);
    await expectStatus(c, 'Работает', 'busy');
  });

  test('без сессии — «Повторить» задаёт вопрос заново', async ({ app, page }) => {
    await recordAgentRuns(page);
    const id = await addAgentChat(app, { data: { messages: [question, running()] } });
    const c = chat(app, id);
    await expect(c.el.locator('.msg-cta button')).toHaveText(['Повторить']);
    await c.el.locator('.msg-cta button').click();
    expect((await agentRun(page)).prompt).toBe('Сделай задачу');
    expect((await app.node(id)).data.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  test('API-чат, закрытый во время ответа: «Повторить»', async ({ app, page }) => {
    await recordApiChats(page);
    const id = await addApiChat(app, { data: { messages: [{ role: 'user', content: 'Сколько будет 2+2?' }, { role: 'assistant', content: 'Считаю', running: true, host: 'demo-pc' }] } });
    const c = chat(app, id);
    await expectStatus(c, 'Прервано', 'wait');
    await c.el.locator('.msg-cta button', { hasText: 'Повторить' }).click();
    const r = await apiRun(page);
    expect(r.messages.map((m) => m.content)).toEqual(['Сколько будет 2+2?']);
  });

  test('ответ, который пишется на другом компьютере, не помечается прерванным', async ({ app }) => {
    const id = await addAgentChat(app, { data: { sessionId: 's', messages: [question, running({ host: 'laptop', parts: [] })] } });
    const c = chat(app, id);
    await expectStatus(c, 'Работает на другом компьютере', 'busy');
    await expect(c.lastAnswer).toContainText('пишется на другом компьютере');
    expect((await app.node(id)).data.messages.at(-1).running).toBe(true);
  });

  test('агент ещё работает в фоне после перезапуска: окно подхватывает ответ', async ({ app, page }) => {
    await page.evaluate(() => { window.__mockAttach = ({ nodeId, reqId }) => { window.__attached = { nodeId, reqId }; return { startedAt: Date.now() - 5000, running: true }; }; });
    const id = await addAgentChat(app, { data: { sessionId: 's4', messages: [question, running({ parts: [] })] } });
    const c = chat(app, id);
    await expectStatus(c, 'Работает', 'busy');
    const { reqId, nodeId } = await page.evaluate(() => window.__attached);
    expect(nodeId).toBe(id);
    // the journal is replayed from the start
    await page.evaluate((reqId) => { for (const t of ['Часть 1. ', 'Часть 2.']) window.__mockEmit('agentchat:event', { reqId, type: 'delta', text: t }); }, reqId);
    await expect(c.lastAnswer).toContainText('Часть 1. Часть 2.');
    await page.evaluate((reqId) => window.__mockEmit('agentchat:event', { reqId, type: 'done', sessionId: 's4' }), reqId);
    await expectStatus(c, 'Ожидает', 'idle');
    expect((await app.node(id)).data.messages.at(-1)).toMatchObject({ content: 'Часть 1. Часть 2.' });
    expect((await app.node(id)).data.messages.at(-1).running).toBeFalsy();
  });

  test('фоновый агент остановился сам: «Прервано» с тем, что успел написать', async ({ app, page }) => {
    await page.evaluate(() => { window.__mockAttach = ({ reqId }) => { window.__attached = reqId; return { startedAt: Date.now(), running: false }; }; });
    const id = await addAgentChat(app, { data: { sessionId: 's5', messages: [question, running({ parts: [] })] } });
    const c = chat(app, id);
    const reqId = await expect.poll(() => page.evaluate(() => window.__attached)).toBeTruthy().then(() => page.evaluate(() => window.__attached));
    await page.evaluate((reqId) => { window.__mockEmit('agentchat:event', { reqId, type: 'delta', text: 'Успел.' }); window.__mockEmit('agentchat:event', { reqId, type: 'done', sessionId: 's5', interrupted: true }); }, reqId);
    await expectStatus(c, 'Прервано', 'wait');
    await expect(c.lastAnswer).toContainText('Успел.');
    await expect(c.el.locator('.msg-cta button').first()).toHaveText('Продолжить');
  });
});

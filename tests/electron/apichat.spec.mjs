// API chat windows: the request is made by the main process with the key from the settings and
// streamed back over IPC; attachments become API parts there; token usage is kept in the profile.
// A local OpenAI-compatible server stands in for the provider.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

// 2×2 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEIGBgY/v9nAAA/9AL+Zk6cQQAAAABJRU5ErkJggg==', 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReply(app, id) {
  await app.page.waitForFunction((id) => {
    const c = window.__app.canvas;
    const m = c.node(id)?.data.messages || [];
    return m.length >= 2 && m.at(-1).role === 'assistant' && !c.views.get(id)?.inst?.isBusy();
  }, id, { timeout: 20_000 });
  return (await app.messages(id)).at(-1);
}

test('API-чат: потоковый ответ через main-процесс, картинка — частью запроса, расход в профиле; без ключа — ошибка', async ({ app, home }) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '250' });
    for (const t of ['Привет', ', ', 'мир!']) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`); await sleep(30); }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await app.page.evaluate(async (baseUrl) => {
      const { state } = await import('/js/state.js');
      state.setSetting('providers', { openai: { key: 'sk-local-123', baseUrl } });
    }, `http://127.0.0.1:${server.address().port}/v1`);
    const chat = await app.page.evaluate(() => window.__app.launchChat({ provider: 'openai', world: { x: 420, y: 300 } }).id);
    const png = path.join(home, 'Схема.png');
    fs.writeFileSync(png, PNG);
    await app.el(chat).locator('input[type=file]').setInputFiles(png);
    await expect(app.el(chat).locator('.att-chip:not(.pending)')).toHaveCount(1);
    await app.send(chat, 'Что на картинке?');
    const answer = await waitReply(app, chat);
    expect(answer.content).toBe('Привет, мир!');
    expect(answer.usage).toEqual({ input: 12, output: 5 });
    await expect(app.el(chat).locator('.msg.assistant .msg-text').last()).toHaveText('Привет, мир!');
    await expect(app.el(chat).locator('.chat-usage')).toHaveText('17 токенов в этом чате');

    expect(requests.map((r) => [r.url, r.auth])).toEqual([['/v1/chat/completions', 'Bearer sk-local-123']]);
    const { body } = requests[0];
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Что на картинке?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] });

    const usageFile = path.join(app.userData, 'usage.json');
    await expect.poll(() => fs.existsSync(usageFile) && Object.values(app.readJson(usageFile))).toEqual([{ openai: { input: 12, output: 5, requests: 1 } }]);

    // no key for this provider: the main process refuses before any request
    const other = await app.page.evaluate(() => window.__app.launchChat({ provider: 'anthropic', world: { x: 1000, y: 300 } }).id);
    await app.send(other, 'привет');
    const refused = await waitReply(app, other);
    expect(refused).toMatchObject({ error: true, content: '⚠ Нет API-ключа для «Anthropic». Добавьте его в Настройки → Провайдеры.' });
    expect(await app.status(other)).toBe('Ошибка');
    expect(requests).toHaveLength(1);
  } finally {
    server.close();
  }
});

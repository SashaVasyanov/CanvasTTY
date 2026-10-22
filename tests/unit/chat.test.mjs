// API chats (main/chat.js): provider settings and the streaming answer of OpenAI-compatible and
// Anthropic APIs, parsed from server-sent events. fetch is replaced with a fake server.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatManager, PROVIDERS, cfgFor } = require('../../main/chat.js');

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// a streamed response; chunks deliberately cut lines in the middle
function sse(lines, { status = 200, headers = {}, chunk = 7 } = {}) {
  const text = lines.join('\n') + '\n';
  const enc = new TextEncoder();
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += chunk) c.enqueue(enc.encode(text.slice(i, i + chunk))); c.close(); } });
  return new Response(stream, { status, headers });
}
const server = (fn) => { globalThis.fetch = async (url, opts) => { calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null }); return fn(url, opts); }; };
async function run(mgr, args) {
  const events = [];
  const done = new Promise((resolve) => { mgr.send = (ch, ev) => { events.push(ev); if (ev.type === 'done' || ev.type === 'error') resolve(); }; });
  await mgr.send_({ reqId: 'r1', messages: [{ role: 'user', content: 'Привет' }], ...args });
  await done;
  return { events, text: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), reasoning: events.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), last: events.at(-1) };
}

test('настройки провайдера: значения по умолчанию, свои адрес и модель, неизвестный — как «Свой»', () => {
  assert.deepEqual(cfgFor('openai', {}), { id: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: '', model: 'gpt-5', noKey: false });
  assert.deepEqual(cfgFor('anthropic', { providers: { anthropic: { key: 'sk-ant', model: 'claude-opus-5-5', baseUrl: 'https://proxy.local/anthropic///' } } }),
    { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://proxy.local/anthropic', key: 'sk-ant', model: 'claude-opus-5-5', noKey: false });
  const odd = cfgFor('my-lab', null);
  assert.deepEqual([odd.id, odd.kind, odd.baseUrl, odd.noKey], ['my-lab', 'openai', PROVIDERS.custom.baseUrl, true]);
  assert.equal(cfgFor('ollama').noKey, true);
});

test('OpenAI-совместимый поток: текст, размышления, токены, заголовки и параметры запроса', async () => {
  server(() => sse([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    '',
    'data: {"choices":[{"delta":{"reasoning_content":"думаю…"}}]}',
    'data: {"choices":[{"delta":{"content":"При"}}]}',
    ': keep-alive comment',
    'data: {"choices":[{"delta":{"content":"вет!"}}]}\r',
    'data: не json',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
    'data: [DONE]',
  ], { headers: { 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '250', 'x-ratelimit-reset-tokens': '1m30s' } }));
  const usage = [];
  const mgr = new ChatManager({ send: () => {}, onUsage: (p, u) => usage.push([p, u]) });
  const t0 = Date.now();
  const r = await run(mgr, { provider: 'openai', system: 'Ты помощник', temperature: 0.2, settings: { providers: { openai: { key: 'sk-1' } } } });
  assert.equal(r.text, 'Привет!');
  assert.equal(r.reasoning, 'думаю…');
  assert.deepEqual(r.last, { reqId: 'r1', type: 'done', usage: { input: 12, output: 3 }, model: 'gpt-5' });
  assert.deepEqual(usage, [['openai', { input: 12, output: 3 }]]);
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.opts.headers.Authorization, 'Bearer sk-1');
  assert.deepEqual(c.body, { model: 'gpt-5', stream: true, messages: [{ role: 'system', content: 'Ты помощник' }, { role: 'user', content: 'Привет' }], temperature: 0.2, stream_options: { include_usage: true } });
  const rl = mgr.rateLimits.openai;
  assert.equal(rl.used, 75);
  assert.ok(rl.resetsAt >= t0 + 90_000 && rl.resetsAt <= Date.now() + 90_000, 'сброс через 1 мин 30 с');
  assert.equal(mgr.inflight.size, 0);
});

test('OpenRouter и локальная Ollama: свои заголовки, без ключа можно, если он не нужен', async () => {
  server(() => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']));
  const mgr = new ChatManager({ send: () => {} });
  await run(mgr, { provider: 'openrouter', model: 'meta/llama', settings: { providers: { openrouter: { key: 'or-1' } } } });
  assert.equal(calls[0].opts.headers['X-Title'], 'VibeTabula');
  assert.equal(calls[0].body.model, 'meta/llama');
  const r = await run(mgr, { provider: 'ollama', settings: {} });
  assert.equal(r.text, 'ok');
  assert.equal(calls[1].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[1].opts.headers.Authorization, undefined);
  assert.equal(calls[1].body.stream_options, undefined);
});

test('поток Anthropic: текст, размышления, токены из message_start / message_delta, системный промпт отдельно', async () => {
  server(() => sse([
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":40}}}',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"хм"}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Здравствуйте"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":5}}',
    'data: {"type":"message_stop"}',
  ], { headers: { 'anthropic-ratelimit-tokens-limit': '200', 'anthropic-ratelimit-tokens-remaining': '150', 'anthropic-ratelimit-tokens-reset': '2026-10-22T12:00:00Z' } }));
  const mgr = new ChatManager({ send: () => {} });
  const r = await run(mgr, { provider: 'anthropic', system: 'Будь краток', settings: { providers: { anthropic: { key: 'sk-ant' } } }, messages: [{ role: 'system', content: 'лишнее' }, { role: 'user', content: 'Привет' }] });
  assert.equal(r.text, 'Здравствуйте');
  assert.equal(r.reasoning, 'хм');
  assert.deepEqual(r.last.usage, { input: 40, output: 5 });
  const c = calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.opts.headers['x-api-key'], 'sk-ant');
  assert.equal(c.opts.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(c.body, { model: 'claude-sonnet-5-5', max_tokens: 8192, stream: true, system: 'Будь краток', messages: [{ role: 'user', content: 'Привет' }] });
  assert.deepEqual(mgr.rateLimits.anthropic && { used: mgr.rateLimits.anthropic.used, resetsAt: mgr.rateLimits.anthropic.resetsAt }, { used: 25, resetsAt: Date.parse('2026-10-22T12:00:00Z') });
});

test('ошибки: нет ключа, ответ сервера с JSON-ошибкой, ошибка посреди потока', async () => {
  server(() => { throw new Error('запроса быть не должно'); });
  const mgr = new ChatManager({ send: () => {} });
  let r = await run(mgr, { provider: 'deepseek', settings: {} });
  assert.deepEqual(r.last, { reqId: 'r1', type: 'error', message: 'Нет API-ключа для «DeepSeek». Добавьте его в Настройки → Провайдеры.' });
  assert.equal(calls.length, 0);

  server(() => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }));
  r = await run(mgr, { provider: 'openai', settings: { providers: { openai: { key: 'bad' } } } });
  assert.equal(r.last.message, '401: Incorrect API key provided');

  server(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  r = await run(mgr, { provider: 'openai', settings: { providers: { openai: { key: 'k' } } } });
  assert.equal(r.last.message, '502: <html>Bad gateway</html>');

  server(() => sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"начало"}}', 'data: {"type":"error","error":{"message":"Overloaded"}}']));
  r = await run(mgr, { provider: 'anthropic', settings: { providers: { anthropic: { key: 'k' } } } });
  assert.equal(r.text, 'начало');
  assert.deepEqual(r.last, { reqId: 'r1', type: 'error', message: 'Overloaded' });
});

test('остановка ответа: done с пометкой aborted', async () => {
  server((url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }));
  const mgr = new ChatManager({ send: () => {} });
  const events = [];
  mgr.send = (ch, ev) => events.push(ev);
  const p = mgr.send_({ reqId: 'stop-me', provider: 'openai', messages: [{ role: 'user', content: 'долго' }], settings: { providers: { openai: { key: 'k' } } } });
  await new Promise((r) => setImmediate(r));
  mgr.abort('stop-me');
  await p;
  assert.deepEqual(events, [{ reqId: 'stop-me', type: 'done', usage: { input: 0, output: 0 }, aborted: true }]);
  assert.equal(mgr.inflight.size, 0);
});

test('вложения превращаются в части сообщения нужного API', async () => {
  server(() => sse(['data: [DONE]']));
  const seen = [];
  const attachments = { toParts: async (text, atts, kind) => { seen.push([text, atts.map((a) => a.name), kind]); return [{ type: 'text', text }]; } };
  const mgr = new ChatManager({ send: () => {}, attachments });
  await run(mgr, { provider: 'anthropic', settings: { providers: { anthropic: { key: 'k' } } }, messages: [{ role: 'user', content: 'смотри', attachments: [{ name: 'a.png' }] }, { role: 'assistant', content: 'вижу', attachments: [{ name: 'x' }] }] });
  assert.deepEqual(seen, [['смотри', ['a.png'], 'anthropic']]);
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: [{ type: 'text', text: 'смотри' }] }, { role: 'assistant', content: 'вижу' }]);
});

test('список моделей провайдера, отсортированный', async () => {
  server((url) => new Response(JSON.stringify(url.includes('anthropic') ? { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }] } : { models: [{ name: 'llama3.1' }, { name: 'gemma' }, {}] })));
  const mgr = new ChatManager({ send: () => {} });
  assert.deepEqual(await mgr.listModels('anthropic', { providers: { anthropic: { key: 'k' } } }), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.deepEqual(await mgr.listModels('ollama', {}), ['gemma', 'llama3.1']);
  server(() => new Response('nope', { status: 403 }));
  await assert.rejects(mgr.listModels('openai', {}), /^Error: 403 nope/);
});

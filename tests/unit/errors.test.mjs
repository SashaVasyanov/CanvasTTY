// Agent and API errors in plain words (renderer/js/errors.js): real messages of Codex, Claude Code
// and API providers → the right kind, title and buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainError } from '../../renderer/js/errors.js';

const codex = { source: 'codex', name: 'Codex', install: 'npm i -g @openai/codex', cmd: 'codex' };
const claude = { source: 'claude', name: 'Claude Code' };
const api = { source: 'api', provider: 'OpenAI', model: 'gpt-5' };

const cases = [
  // [raw, ctx, kind, first action]
  ['Команда «codex» не найдена. Установите Codex: npm i -g @openai/codex и войдите в аккаунт.', codex, 'notfound', 'install'],
  ["'codex' is not recognized as an internal or external command,", codex, 'notfound', 'install'],
  ['Нет API-ключа для «OpenAI». Добавьте его в Настройки → Провайдеры.', api, 'nokey', 'providers'],
  ['Запуск отменён: программа агента не разрешена.', codex, 'trust', 'retry'],
  ['unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again.', codex, 'auth', 'login'],
  ['Invalid API key · Please run /login', claude, 'auth', 'login'],
  ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}', claude, 'auth', 'login'],
  ['401: Incorrect API key provided: sk-abc***.', api, 'auth', 'providers'],
  ['429: You exceeded your current quota, please check your plan and billing details. insufficient_quota', api, 'quota', 'providers'],
  ['Credit balance is too low', claude, 'quota', 'limits'],
  ["You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 3:05 PM.", codex, 'limit', 'limits'],
  ['Claude AI usage limit reached|1760000000', claude, 'limit', 'limits'],
  ['429: Rate limit reached for gpt-5 in organization org-x on tokens per min.', api, 'limit', 'retry'],
  ['unexpected status 400 Bad Request: {"detail":"The \'gpt-9\' model is not supported when using Codex with a ChatGPT account."}', { ...codex, model: 'gpt-9' }, 'model', 'model-auto'],
  ["There's an issue with the selected model (claude-x). It may not exist or you may not have access to it. Run /model to pick a different model.", claude, 'model', 'model-auto'],
  ['404: The model `gpt-9` does not exist or you do not have access to it.', api, 'model', 'model'],
  ["Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying.", codex, 'context', 'new-chat'],
  ['Prompt is too long', claude, 'context', 'new-chat'],
  ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', claude, 'overloaded', 'retry'],
  ['503: Service Unavailable', api, 'overloaded', 'retry'],
  ['stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)', codex, 'network', 'retry'],
  ['fetch failed', api, 'network', 'retry'],
  ['API Error: Request timed out.', claude, 'network', 'retry'],
  ['failed in sandbox: Operation not permitted (os error 1)', codex, 'access', 'access'],
  ['Процесс завершился с кодом 1', codex, 'crash', 'retry'],
  ['Что-то совсем новое', claude, 'other', 'retry'],
];

for (const [raw, ctx, kind, action] of cases) {
  test(`${kind}: ${raw.slice(0, 60)}`, () => {
    const e = explainError(raw, ctx);
    assert.equal(e.kind, kind);
    assert.equal(e.actions[0], action);
    assert.ok(e.title && !/undefined/.test(e.title + e.hint), 'понятный заголовок без пропусков');
    assert.equal(e.raw, raw.replace(/^⚠\s*/, '').trim(), 'исходный текст остаётся в «Подробностях»');
  });
}

test('когда снова можно — из текста ошибки', () => {
  assert.match(explainError('You\'ve hit your usage limit. Try again in 2 days 3 hours.', codex).hint, /через 2 days 3 hours/);
  const ts = Math.floor(Date.now() / 1000) + 3600;
  assert.match(explainError(`Claude AI usage limit reached|${ts}`, claude).hint, /сегодня в \d\d:\d\d|в \d\d:\d\d/);
});

test('неизвестная ошибка CLI с кодом выхода — «завершился с ошибкой»', () => {
  assert.equal(explainError('claude: внутренняя ошибка', { ...claude, exitCode: 3 }).kind, 'crash');
  assert.equal(explainError('claude: внутренняя ошибка', claude).kind, 'other');
  assert.equal(explainError('что-то', { ...api, exitCode: 1 }).kind, 'other');
});

test('знак ⚠ из старых сообщений не мешает', () => {
  assert.equal(explainError('⚠ 503: Service Unavailable', api).kind, 'overloaded');
});

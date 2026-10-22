// Usage limits (main/limits.js): Codex windows from its session logs, Claude Code from the account,
// balances of API keys, API rate-limit headers and the local token budget. fetch is faked.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getLimits } = require('../../main/limits.js');

const realFetch = globalThis.fetch;
let tmp, calls, routes;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-limits-')); });
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  calls = []; routes = {};
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); const r = Object.entries(routes).find(([k]) => url.startsWith(k)); if (!r) throw new Error(`неожиданный запрос ${url}`); return r[1](url, opts); };
  process.env.CODEX_HOME = path.join(tmp, 'no-codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'no-claude');
});
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const today = () => new Date().toISOString().slice(0, 10);

test('Codex: окна 5 часов и неделя из последней строки rate_limits в свежих сессиях', async () => {
  const home = path.join(tmp, 'codex1');
  process.env.CODEX_HOME = home;
  const now = Date.now();
  const weekReset = Math.round(now / 1000) + 3 * 86400;
  const line = (p, s, ts = new Date(now).toISOString()) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: p, secondary: s } } });
  // older day: other numbers; newest day: the newest file has no limits, the one before has
  const older = write(path.join(home, 'sessions', '2026', '10', '20', 'rollout-a.jsonl'), line({ used_percent: 99, window_minutes: 300 }, null) + '\n');
  fs.utimesSync(older, new Date(now - 2 * 86400_000), new Date(now - 2 * 86400_000));
  const withLimits = write(path.join(home, 'sessions', '2026', '10', '22', 'rollout-b.jsonl'), [
    line({ used_percent: 5, window_minutes: 300, resets_in_seconds: 60 }, null),
    '{"type":"event_msg","payload":{"type":"agent_message"}}',
    line({ used_percent: 42.4, window_minutes: 300, resets_in_seconds: 3600 }, { used_percent: 10.2, window_minutes: 10080, resets_at: weekReset }),
    '{"rate_limits": не json',
  ].join('\n'));
  const noLimits = write(path.join(home, 'sessions', '2026', '10', '22', 'rollout-c.jsonl'), '{"type":"session_meta"}\n');
  fs.utimesSync(withLimits, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(noLimits, new Date(now), new Date(now));
  const { codex } = await getLimits({ settings: {} });
  assert.equal(codex.status, 'ok');
  assert.equal(codex.source, 'сессии ~/.codex');
  assert.deepEqual(codex.windows.map((w) => [w.label, w.used]), [['5ч', 42], ['Неделя', 10]]);
  assert.ok(Math.abs(codex.windows[0].resetsAt - (Date.parse(new Date(now).toISOString()) + 3600_000)) < 2000);
  assert.equal(codex.windows[1].resetsAt, weekReset * 1000);
});

test('Codex: окно, которое уже сбросилось, показывается пустым; подписи суток', async () => {
  const home = path.join(tmp, 'codex2');
  process.env.CODEX_HOME = home;
  const old = new Date(Date.now() - 6 * 3600_000).toISOString();
  write(path.join(home, 'sessions', '2026', '10', '22', 'rollout-x.jsonl'),
    JSON.stringify({ timestamp: old, payload: { info: { rate_limits: { primary: { used_percent: 80, window_minutes: 2880, resets_in_seconds: 3600 } } } } }) + '\n');
  const { codex } = await getLimits({ settings: {} });
  assert.deepEqual(codex.windows.map((w) => [w.label, w.used]), [['2д', 0]]);
});

test('Codex: не установлен, нет сессий, ещё не было запросов', async () => {
  assert.deepEqual((await getLimits({ settings: {} })).codex, { status: 'na', note: 'Codex не установлен' });
  const home = path.join(tmp, 'codex3');
  fs.mkdirSync(home);
  process.env.CODEX_HOME = home;
  assert.deepEqual((await getLimits({ settings: {} })).codex, { status: 'na', note: 'Нет сессий Codex' });
  write(path.join(home, 'sessions', '2026', '10', '22', 'rollout-y.jsonl'), '{"type":"session_meta"}\n');
  assert.deepEqual((await getLimits({ settings: {} })).codex, { status: 'na', note: 'Лимиты появятся после первого запроса в Codex' });
});

test('Claude Code: не установлен, не выполнен вход, токен истёк, ошибка сервера', async () => {
  assert.deepEqual((await getLimits({ settings: {} })).claude, { status: 'na', note: 'Claude Code не установлен' });
  const dir = path.join(tmp, 'claude1');
  fs.mkdirSync(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  assert.deepEqual((await getLimits({ settings: {} })).claude, { status: 'na', note: 'Войдите в Claude Code (/login)' });
  write(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1000 } }));
  assert.deepEqual((await getLimits({ settings: {} })).claude, { status: 'na', note: 'Токен истёк — запустите claude' });
  write(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }));
  assert.deepEqual((await getLimits({ settings: {} })).claude, { status: 'na', note: 'Нет OAuth-токена' });
  write(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } }));
  routes['https://api.anthropic.com/api/oauth/usage'] = () => json({}, 401);
  assert.deepEqual((await getLimits({ settings: {} })).claude, { status: 'error', note: 'HTTP 401' });
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
});

test('API-ключи: баланс Kimi (¥ для .cn), лимит и траты OpenRouter, баланс DeepSeek', async () => {
  routes['https://api.moonshot.cn/v1/users/me/balance'] = () => json({ data: { available_balance: 12.5 } });
  routes['https://openrouter.ai/api/v1/key'] = (u, o) => json({ data: o.headers.Authorization === 'Bearer or-limit' ? { limit: 20, usage: 5 } : { usage: 3.25 } });
  routes['https://api.deepseek.com/user/balance'] = () => json({ balance_infos: [{ total_balance: '7.10', currency: 'CNY' }] });
  const settings = { providers: { moonshot: { key: 'mk', baseUrl: 'https://api.moonshot.cn/v1/' }, openrouter: { key: 'or-limit' }, deepseek: { key: 'dk' } } };
  const r = await getLimits({ settings });
  assert.deepEqual(r.kimi.balance, { amount: 12.5, currency: '¥' });
  assert.deepEqual(r.openrouter.windows, [{ label: 'Лимит', used: 25, resetsAt: null }]);
  assert.deepEqual(r.openrouter.balance, { amount: 15, currency: '$' });
  assert.deepEqual(r.deepseek.balance, { amount: 7.1, currency: '¥' });
  settings.providers.openrouter.key = 'or-payg';
  assert.deepEqual((await getLimits({ settings })).openrouter.balance, { amount: -3.25, currency: '$', spent: true });
  routes['https://api.deepseek.com/user/balance'] = () => json({}, 500);
  assert.deepEqual((await getLimits({ settings })).deepseek, { status: 'error', note: 'HTTP 500' });
});

test('без ключа Kimi — подсказка; провайдеры без ключей не запрашиваются', async () => {
  const r = await getLimits({ settings: {} });
  assert.deepEqual(r.kimi, { status: 'na', note: 'Добавьте ключ Moonshot' });
  assert.equal('openrouter' in r, false);
  assert.equal('deepseek' in r, false);
  assert.equal(calls.length, 0);
});

test('заголовки последних ответов API (10 минут), потом — локальный учёт токенов по суточному бюджету', async () => {
  const now = Date.now();
  const usageLog = { [today()]: { openai: { input: 1500, output: 500 }, gemini: { input: 1000, output: 234 }, moonshot: { input: 10, output: 10 } } };
  const settings = { providers: { openai: { dailyBudget: '1000' }, moonshot: { dailyBudget: 100 } } };
  const r = await getLimits({ settings, usageLog, rateLimits: { anthropic: { used: 30, resetsAt: now + 60_000, at: now }, openai: { used: 90, resetsAt: null, at: now - 11 * 60_000 } } });
  assert.deepEqual(r.anthropic, { status: 'ok', windows: [{ label: 'Rate', used: 30, resetsAt: now + 60_000 }], source: 'заголовки API', updatedAt: now });
  assert.equal(r.openai.source, 'локальный учёт', 'устаревшие заголовки не показываются');
  assert.deepEqual([r.openai.windows[0].label, r.openai.windows[0].used, r.openai.tokens], ['День', 100, 2000]);
  const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
  assert.equal(r.openai.windows[0].resetsAt, midnight.getTime());
  assert.deepEqual(r.gemini.windows, []);
  assert.match(r.gemini.note, /^1\s234 ток\. сегодня$/u);
  assert.equal(r.kimi.windows[0].used, 20, 'Kimi без ключа, но с бюджетом — по локальному учёту');
  assert.equal('ollama' in r, false);
});

test('Claude Code: использование аккаунта (5 часов, неделя, Opus) и кэш на минуту', async () => {
  const dir = path.join(tmp, 'claude2');
  write(path.join(dir, '.credentials.json'), JSON.stringify({ claude_ai_oauth: { accessToken: 'tok2' } }));
  process.env.CLAUDE_CONFIG_DIR = dir;
  routes['https://api.anthropic.com/api/oauth/usage'] = () => json({ five_hour: { utilization: 37.6, resets_at: '2026-10-22T15:00:00Z' }, seven_day: { utilization: 12 }, seven_day_opus: null });
  const { claude } = await getLimits({ settings: {} });
  assert.equal(claude.status, 'ok');
  assert.deepEqual(claude.windows, [{ label: '5ч', used: 38, resetsAt: Date.parse('2026-10-22T15:00:00Z') }, { label: 'Неделя', used: 12, resetsAt: null }]);
  assert.equal(calls[0].opts.headers['anthropic-beta'], 'oauth-2025-04-20');
  await getLimits({ settings: {} });
  assert.equal(calls.length, 1, 'второй раз за минуту — из кэша');
});

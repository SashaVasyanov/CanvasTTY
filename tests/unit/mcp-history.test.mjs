// The MCP server that lets agents search old chats (main/mcp-history.js): started as a child process
// over stdio, like Claude Code / Codex start it, with a fake history and fake agent sessions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeSessions, writeHistory, CODEX_SESSION } from './fixtures/sessions.mjs';

const SERVER = fileURLToPath(new URL('../../main/mcp-history.js', import.meta.url));
let tmp, sessions, child, pending, seq;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-mcp-'));
  sessions = writeSessions(path.join(tmp, 'agents'));
  const long = 'длинный ответ '.repeat(6000); // > 60 000 characters: read_chat pages it
  writeHistory(path.join(tmp, 'userData'), [
    { id: 'cv_ud', kind: 'agentchat', agent: 'claude', title: 'Список таблиц UD', cwd: '/home/user/proj', created: Date.parse('2026-10-22T08:00:00Z'), updated: Date.parse('2026-10-22T08:00:00Z'),
      messages: [{ role: 'user', content: 'Покажи таблицы UD', attachments: [{ name: 'schema.png' }] }, { role: 'assistant', content: 'UD_ORDERS', parts: [{ type: 'tool', name: 'Bash', input: 'psql -c \\dt', output: 'ud_orders' }, { type: 'text', text: 'Таблицы: UD_ORDERS' }] }] },
    { id: 'cv_long', kind: 'chat', agent: 'openai', title: 'Длинный чат', created: Date.parse('2026-10-01T08:00:00Z'), updated: Date.parse('2026-10-01T08:00:00Z'),
      messages: [{ role: 'user', content: 'расскажи подробно' }, { role: 'assistant', content: long }] },
  ]);
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CANVASTTY_USERDATA: path.join(tmp, 'userData'), CLAUDE_CONFIG_DIR: sessions.claudeDir, CODEX_HOME: sessions.codexDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  pending = new Map(); seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
});
after(() => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

function rpc(method, params, { notify = false } = {}) {
  const id = notify ? undefined : ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, params }) + '\n');
  if (notify) return null;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 10_000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  });
}
const call = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { text: r.content[0].text, isError: !!r.isError }; };

test('рукопожатие MCP и список инструментов', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  assert.deepEqual(init.result, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vibetabula-history', version: '1.0.0' } });
  assert.equal(rpc('notifications/initialized', {}, { notify: true }), null);
  const tools = (await rpc('tools/list', {})).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['search_chats', 'read_chat', 'list_chats']);
  assert.deepEqual(tools.find((t) => t.name === 'read_chat').inputSchema.required, ['source', 'ref']);
  assert.deepEqual((await rpc('ping', {})).result, {});
});

test('поиск: все слова, без учёта регистра, по истории приложения и сессиям агентов, новые первыми', async () => {
  const r = await call('search_chats', { query: 'таблиц ud' });
  assert.equal(r.isError, false);
  const hits = r.text.split('\n\n').filter((b) => /^\d+\. /.test(b));
  assert.equal(hits.length, 2);
  assert.match(hits[0], /^1\. \[vibetabula\] Список таблиц UD\n {3}дата: 2026-10-22 08:00 · папка: \/home\/user\/proj\n {3}source="vibetabula" ref="cv_ud"/);
  assert.match(hits[1], /^2\. \[claude\] Найди список таблиц по UD\n/);
  assert.match(hits[1], new RegExp(`ref="${sessions.files.claude.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}"`));
  assert.match(r.text, /read_chat с этими source и ref/);

  const codexOnly = await call('search_chats', { query: 'тесты', source: 'codex' });
  assert.match(codexOnly.text, /^1\. \[codex\] Почини тесты UD/);
  assert.doesNotMatch(codexOnly.text, /\[claude\]|\[vibetabula\]/);
  // text found only in the metadata of a session file is not a hit
  assert.match((await call('search_chats', { query: CODEX_SESSION, source: 'codex' })).text, /^Ничего не найдено/);
  // attachments and tool calls are searchable too
  assert.match((await call('search_chats', { query: 'schema.png' })).text, /\[vibetabula\] Список таблиц UD/);
  assert.equal((await call('search_chats', { query: '   ' })).isError, true);
});

test('чтение переписки целиком: приложение и сессии, длинная — по частям', async () => {
  const app = await call('read_chat', { source: 'vibetabula', ref: 'cv_ud' });
  assert.equal(app.text, '# Список таблиц UD\nПапка: /home/user/proj\n\n### Пользователь\nПокажи таблицы UD\n[вложение: schema.png]\n\n### Ассистент\n[Bash: psql -c \\dt]\nud_orders\nТаблицы: UD_ORDERS');
  assert.equal((await call('read_chat', { source: 'canvastty', ref: 'cv_ud' })).text, app.text, 'старое название приложения тоже понимается');

  const claude = await call('read_chat', { source: 'claude', ref: sessions.files.claude });
  assert.match(claude.text, /^# Найди {3}список таблиц по UD\nПапка: \/home\/user\/proj\n\n### Пользователь\n/);
  assert.match(claude.text, /\[Bash: ls db\]\ntables\.sql\nТаблицы: UD_ORDERS, UD_USERS$/);

  const first = await call('read_chat', { source: 'vibetabula', ref: 'cv_long' });
  assert.equal(first.text.split('\n\n[обрезано')[0].length, 60000);
  const m = /\[обрезано: показано 60000 из (\d+) символов, продолжение — read_chat с offset=60000\]$/.exec(first.text);
  assert.ok(m, 'подсказка, как читать дальше');
  const rest = await call('read_chat', { source: 'vibetabula', ref: 'cv_long', offset: 60000 });
  assert.equal(rest.text.length, Number(m[1]) - 60000);
  assert.doesNotMatch(rest.text, /обрезано/);
});

test('ошибки возвращаются агенту текстом, а не роняют сервер', async () => {
  assert.deepEqual(await call('read_chat', { source: 'vibetabula', ref: 'нет' }), { text: 'Ошибка: чат не найден', isError: true });
  assert.deepEqual(await call('read_chat', { source: 'gpt', ref: 'x' }), { text: 'Ошибка: source должен быть vibetabula, claude или codex', isError: true });
  const outside = await call('read_chat', { source: 'claude', ref: path.join(tmp, 'userData', 'chats', 'cv_ud.json') });
  assert.deepEqual(outside, { text: 'Ошибка: файл вне папки сессий', isError: true });
  assert.deepEqual(await call('delete_chats', {}), { text: 'Нет инструмента delete_chats', isError: true });
  const unknown = await rpc('resources/list', {});
  assert.deepEqual(unknown.error, { code: -32601, message: 'Method not found: resources/list' });
  child.stdin.write('это не json\n');
  assert.deepEqual((await rpc('ping', {})).result, {}, 'после мусора сервер отвечает дальше');
});

test('список последних чатов из всех источников', async () => {
  const r = await call('list_chats', {});
  const rows = r.text.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(rows.map((l) => l.replace(/ — .*$/, '')), ['1. [vibetabula] Список таблиц UD', '2. [codex] Почини тесты UD', '3. [claude] Таблицы UD в базе', '4. [vibetabula] Длинный чат']);
  const two = await call('list_chats', { source: 'vibetabula', limit: 1 });
  assert.equal(two.text, '1. [vibetabula] Список таблиц UD — 2026-10-22 08:00 · /home/user/proj\n   source="vibetabula" ref="cv_ud"');
});

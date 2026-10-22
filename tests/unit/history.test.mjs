// Chat history (main/history.js): VibeTabula's own conversations on disk and read-only access to
// the sessions Claude Code and Codex keep (~/.claude/projects, ~/.codex/sessions).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeSessions, CLAUDE_SESSION, CODEX_SESSION } from './fixtures/sessions.mjs';

const require = createRequire(import.meta.url);
const { HistoryStore, listSessions, readSession, sessionFiles } = require('../../main/history.js');
process.setMaxListeners(50); // every writable HistoryStore adds an "exit" listener

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-hist-')); });
after(async () => { await sleep(400); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('HistoryStore: история чатов VibeTabula', () => {
  const msgs = (q, a) => [{ role: 'user', content: q }, { role: 'assistant', content: a }];

  test('сохраняет разговор, список новых сверху с фильтром по виду и агенту', async () => {
    const dir = path.join(tmp, 'h1');
    const h = new HistoryStore(dir);
    const changes = [];
    h.onChange = (what, x) => changes.push([what, x.id || x]);
    assert.equal(await h.save({ id: 'c1', kind: 'agentchat', agent: 'claude', messages: msgs('Разбери\n\nструктуру   проекта', 'ок') }), true);
    await sleep(5);
    assert.equal(await h.save({ id: 'c2', kind: 'chat', agent: 'openai', title: 'Идеи', model: 'gpt-5', messages: msgs('Придумай название', 'VibeTabula') }), true);
    await sleep(5);
    assert.equal(await h.save({ id: 'c3', kind: 'agentchat', agent: 'codex', messages: msgs('x'.repeat(200), 'y') }), true);

    assert.deepEqual(h.list({}).map((r) => r.id), ['c3', 'c2', 'c1']);
    assert.deepEqual(h.list({ kind: 'agentchat' }).map((r) => r.id), ['c3', 'c1']);
    assert.deepEqual(h.list({ kind: 'agentchat', agent: 'claude' }).map((r) => r.id), ['c1']);
    const c1 = h.list({ agent: 'claude' })[0];
    assert.equal(c1.title, 'Разбери структуру проекта', 'название — первый вопрос в одну строку');
    assert.equal(c1.count, 2);
    assert.equal(h.list({ agent: 'openai' })[0].title, 'Идеи');
    assert.equal(h.list({ agent: 'codex' })[0].title.length, 90);
    assert.deepEqual(changes.map((c) => c.join(':')), ['save:c1', 'save:c2', 'save:c3']);
  });

  test('не хранит недописанный ответ, сохраняет дату создания при пересохранении', async () => {
    const h = new HistoryStore(path.join(tmp, 'h2'));
    await h.save({ id: 'r1', kind: 'chat', agent: 'openai', messages: [{ role: 'user', content: 'вопрос' }] });
    const created = (await h.get('r1')).created;
    await sleep(5);
    await h.save({ id: 'r1', kind: 'chat', agent: 'openai', messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: 'час', running: true }] });
    const rec = await h.get('r1');
    assert.equal(rec.created, created);
    assert.ok(rec.updated > created);
    assert.equal('running' in rec.messages[1], false);
    assert.equal(await h.save({ id: 'r2', messages: [] }), false, 'пустой разговор не сохраняется');
    assert.equal(await h.save({ messages: [{ role: 'user', content: 'x' }] }), false, 'без id не сохраняется');
    assert.equal(await h.get('нет такого'), null);
  });

  test('индекс пишется на диск и переживает перезапуск; потерянные записи восстанавливаются', async () => {
    const dir = path.join(tmp, 'h3');
    const h = new HistoryStore(dir);
    await h.save({ id: 'a', kind: 'chat', agent: 'openai', messages: [{ role: 'user', content: 'первый' }] });
    await sleep(400);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))), ['a']);
    // a conversation file that never made it into the index (crash while saving)
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ id: 'b', kind: 'agentchat', agent: 'codex', created: 1, updated: 2, messages: [{ role: 'user', content: 'второй' }] }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ не json');
    const h2 = new HistoryStore(dir);
    assert.deepEqual(h2.list({}).map((r) => r.title).sort(), ['второй', 'первый']);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).sort(), ['a', 'b'], 'восстановленная запись сразу попадает в индекс');
  });

  test('импорт с другого компьютера и удаление', async () => {
    const h = new HistoryStore(path.join(tmp, 'h4'));
    const removed = [];
    h.onChange = (what, id) => removed.push(`${what}:${id}`);
    await h.importRecord({ id: 'far', kind: 'chat', agent: 'anthropic', title: 'С ноутбука', created: 10, updated: 20, messages: [{ role: 'user', content: 'привет' }] });
    await h.importRecord({ id: 'bad' }); // not a conversation
    assert.deepEqual(h.list({}).map((r) => [r.id, r.title, r.updated]), [['far', 'С ноутбука', 20]], 'время с другого компьютера сохраняется');
    assert.equal(removed.length, 0, 'импорт не отправляется обратно в синхронизацию');
    await h.remove('far');
    assert.deepEqual(h.list({}), []);
    assert.equal(await h.get('far'), null);
    assert.deepEqual(removed, ['remove:far']);
  });

  test('имя файла из id не выходит за папку истории', () => {
    const h = new HistoryStore(path.join(tmp, 'h5'), { readOnly: true });
    assert.equal(h.file('../../etc/passwd'), path.join(tmp, 'h5', 'etcpasswd.json'));
    assert.equal(path.dirname(h.file('..\\..\\win')), path.join(tmp, 'h5'));
  });

  test('режим только для чтения не пишет индекс (MCP-сервер читает историю приложения)', async () => {
    const dir = path.join(tmp, 'h6');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ id: 'x', kind: 'chat', agent: 'openai', messages: [{ role: 'user', content: 'q' }] }));
    const h = new HistoryStore(dir, { readOnly: true });
    assert.deepEqual(h.list({}).map((r) => r.id), ['x']);
    await sleep(350);
    assert.equal(fs.existsSync(path.join(dir, 'index.json')), false);
  });
});

describe('сессии Claude Code и Codex на этом компьютере', () => {
  let s;
  before(() => {
    s = writeSessions(path.join(tmp, 'agents'));
    process.env.CLAUDE_CONFIG_DIR = s.claudeDir;
    process.env.CODEX_HOME = s.codexDir;
  });

  test('список сессий Claude Code: сводка как название, служебные сессии пропускаются', async () => {
    const list = await listSessions('claude');
    assert.equal(list.length, 1);
    assert.deepEqual({ ...list[0], file: path.basename(list[0].file) }, {
      source: 'claude', id: CLAUDE_SESSION, sessionId: CLAUDE_SESSION, file: `${CLAUDE_SESSION}.jsonl`, cwd: '/home/user/proj',
      title: 'Таблицы UD в базе', created: Date.parse('2026-10-20T10:00:00Z'), updated: Date.parse('2026-10-20T10:05:00Z'), size: fs.statSync(s.files.claude).size,
    });
  });

  test('сессия Claude Code целиком: вопросы, ответы, размышления, команды с выводом', async () => {
    const r = await readSession('claude', s.files.claude);
    assert.equal(r.cwd, '/home/user/proj');
    assert.equal(r.sessionId, CLAUDE_SESSION);
    assert.equal(r.model, 'claude-opus-5-5');
    assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(r.messages[0].content, 'Найди   список таблиц по UD');
    const a = r.messages[1];
    assert.deepEqual(a.parts.map((p) => p.type), ['reasoning', 'text', 'tool', 'text']);
    assert.deepEqual(a.parts[2], { type: 'tool', id: 'tu1', name: 'Bash', input: 'ls db', status: 'ok', output: 'tables.sql' });
    assert.equal(a.content, 'Смотрю схему.\n\nТаблицы: UD_ORDERS, UD_USERS');
  });

  test('сессия Codex: служебный контекст пропущен, вызов команды с выводом', async () => {
    const [x] = await listSessions('codex');
    assert.equal(x.id, CODEX_SESSION);
    assert.equal(x.title, 'Почини тесты UD');
    assert.equal(x.cwd, 'C:\\Users\\vasya\\proj');
    const r = await readSession('codex', x.file);
    assert.equal(r.model, 'gpt-5-codex');
    assert.equal(r.sessionId, CODEX_SESSION);
    assert.deepEqual(r.messages.map((m) => [m.role, m.content]), [['user', 'Почини тесты UD'], ['assistant', 'Тесты проходят.']]);
    assert.deepEqual(r.messages[1].parts.map((p) => p.type), ['reasoning', 'tool', 'text']);
    assert.deepEqual(r.messages[1].parts[1], { type: 'tool', id: 'c1', name: 'shell', input: 'npm test', status: 'ok', output: 'ok 3 tests' });
  });

  test('«сессии этой папки» сравнивают пути без учёта регистра, слэшей и слэша в конце', async () => {
    const [x] = await listSessions('codex', { cwd: 'c:/users/VASYA/proj/' });
    assert.equal(x.here, true);
    const [y] = await listSessions('codex', { cwd: 'C:\\Users\\vasya\\other' });
    assert.equal(y.here, false);
    const [z] = await listSessions('claude', { cwd: '/home/user/proj' });
    assert.equal(z.here, true);
  });

  test('читать можно только файлы из папки сессий', async () => {
    const outside = path.join(tmp, 'secret.jsonl');
    fs.writeFileSync(outside, '{}\n');
    await assert.rejects(readSession('claude', outside), /вне папки сессий/);
    await assert.rejects(readSession('claude', path.join(s.claudeDir, 'projects', '..', '..', 'secret.jsonl')), /вне папки сессий/);
    await assert.rejects(readSession('codex', s.files.claude), /вне папки сессий/, 'сессия Claude не читается как сессия Codex');
  });

  test('файлы для полнотекстового поиска: только сессии, новые первыми', async () => {
    assert.deepEqual((await sessionFiles('claude')).map((f) => path.basename(f.f)).sort(), [`${CLAUDE_SESSION}.jsonl`, 'empty.jsonl']);
    assert.deepEqual((await sessionFiles('codex')).map((f) => path.basename(f.f)), [path.basename(s.files.codex)]);
  });

  test('нет папок агентов — пустые списки, а не ошибка', async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'нет');
    process.env.CODEX_HOME = path.join(tmp, 'нет');
    try {
      assert.deepEqual(await listSessions('claude'), []);
      assert.deepEqual(await listSessions('codex', { cwd: '/x' }), []);
    } finally { process.env.CLAUDE_CONFIG_DIR = s.claudeDir; process.env.CODEX_HOME = s.codexDir; }
  });
});

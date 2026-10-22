// Chat history: VibeTabula's own conversations in the profile, Claude Code / Codex sessions read
// from ~/.claude and ~/.codex, resuming such a session, and the MCP server through which the
// agents search old chats (the app's own binary started as Node.js by the CLI).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

const argAfter = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const CLAUDE_SID = '7d3f1c2a-0b4e-4f5a-9c8d-1e2f3a4b5c6d';
const CODEX_SID = '0199c0de-1234-7abc-8def-0123456789ab';
// 2×2 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEIGBgY/v9nAAA/9AL+Zk6cQQAAAABJRU5ErkJggg==', 'base64');

// a Claude Code session and a Codex rollout as the CLIs write them, both made in <home>/proj
function seedSessions(home) {
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const claudeDir = path.join(home, '.claude', 'projects', proj.replace(/[^\w]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  const at = { cwd: proj, sessionId: CLAUDE_SID, timestamp: '2026-10-20T10:00:00.000Z' };
  fs.writeFileSync(path.join(claudeDir, `${CLAUDE_SID}.jsonl`), jsonl([
    { type: 'user', ...at, message: { role: 'user', content: 'Как устроен парсер?' } },
    { type: 'assistant', ...at, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Парсер читает JSON-строки.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'main/history.js' } }] } },
    { type: 'user', ...at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: "const fs = require('fs');" }] } },
  ]));
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '20');
  fs.mkdirSync(codexDir, { recursive: true });
  const ts = '2026-10-20T11:00:00.000Z';
  fs.writeFileSync(path.join(codexDir, `rollout-2026-10-20T11-00-00-${CODEX_SID}.jsonl`), jsonl([
    { timestamp: ts, type: 'session_meta', payload: { id: CODEX_SID, timestamp: ts, cwd: proj } },
    { timestamp: ts, type: 'turn_context', payload: { cwd: proj, model: 'gpt-5-codex' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Почини сборку' }] } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Сборка починена.' }] } },
  ]));
  return { proj };
}

test('история: разговоры в профиле и сессии CLI с диска; файлы вне папок сессий не читаются', async ({ app, home }) => {
  const { proj } = seedSessions(home);
  const r = await app.page.evaluate(async (proj) => {
    const n = window.native;
    await n.history.save({ id: 'cv_test', kind: 'agentchat', agent: 'claude', messages: [{ role: 'user', content: 'тест истории' }, { role: 'assistant', content: 'ок', running: true }] });
    return {
      list: await n.history.list({ kind: 'agentchat', agent: 'claude' }),
      rec: await n.history.get('cv_test'),
      claude: await n.sessions.list('claude', { cwd: proj }),
      codex: await n.sessions.list('codex', { cwd: `${proj}-другая` }),
    };
  }, proj);
  expect(r.list.map((x) => [x.id, x.title, x.count])).toEqual([['cv_test', 'тест истории', 2]]);
  expect(r.rec.messages[1], 'недописанный ответ не хранится как «running»').toEqual({ role: 'assistant', content: 'ок' });
  expect(fs.existsSync(path.join(app.userData, 'chats', 'cv_test.json'))).toBe(true);
  expect(r.claude.map((s) => [s.sessionId, s.title, s.cwd, s.here])).toEqual([[CLAUDE_SID, 'Как устроен парсер?', proj, true]]);
  expect(r.codex.map((s) => [s.sessionId, s.title, s.here])).toEqual([[CODEX_SID, 'Почини сборку', false]]);

  const read = await app.page.evaluate((f) => window.native.sessions.read('claude', f), r.claude[0].file);
  expect(read).toMatchObject({ sessionId: CLAUDE_SID, cwd: proj, model: 'claude-sonnet-5-5' });
  expect(read.messages.map((m) => [m.role, m.content])).toEqual([['user', 'Как устроен парсер?'], ['assistant', 'Парсер читает JSON-строки.']]);
  expect(read.messages[1].parts[1]).toMatchObject({ type: 'tool', name: 'Read', input: 'main/history.js', output: "const fs = require('fs');" });

  // the renderer can only read files inside the session folders
  app.allowErrors(/handler for 'sessions:read'/);
  fs.writeFileSync(path.join(home, 'secret.jsonl'), '{"type":"user","message":{"content":"секрет"}}\n');
  for (const f of [path.join(home, 'secret.jsonl'), path.join(home, '.claude', 'projects', '..', '..', 'secret.jsonl')]) {
    const res = await app.page.evaluate((f) => window.native.sessions.read('claude', f).then(() => 'прочитано', (e) => e.message), f);
    expect(res).toContain('файл вне папки сессий');
  }
});

test('сессию Claude Code с диска можно открыть в окне чата и продолжить в её папке', async ({ app, home }) => {
  const { proj } = seedSessions(home);
  const chat = await app.openAgentChat('claude');
  const box = app.el(chat);
  await box.locator('.hist-btn').click();
  const panel = box.locator('.hist-panel');
  await panel.locator('.hist-tab', { hasText: 'Сессии Claude Code' }).click();
  await panel.locator('.hist-item', { hasText: 'Как устроен парсер?' }).click();
  await expect(box.locator('.msg.assistant .msg-text').first()).toHaveText('Парсер читает JSON-строки.');
  await expect(box.locator('.cwd-text')).toHaveText(proj.length > 46 ? `…${proj.slice(-45)}` : proj);

  await app.send(chat, 'Продолжим');
  expect((await app.waitAnswer(chat)).content).toContain('Claude: Продолжим');
  const [call] = app.calls('claude');
  expect(argAfter(call.argv, '--resume')).toBe(CLAUDE_SID);
  expect(call.cwd).toBe(proj);
});

// both agents look for "комета" / "сборку" with search_chats of the vibetabula MCP server
async function searchOldChats(app, home) {
  seedSessions(home);
  await app.page.evaluate(() => window.native.history.save({ id: 'cv_comet', kind: 'agentchat', agent: 'codex', title: 'Обсуждение кометы', messages: [{ role: 'user', content: 'расскажи про комету Галлея' }, { role: 'assistant', content: 'Комета Галлея возвращается раз в 76 лет' }] }));
  app.scenario({ claude: 'mcp', codex: 'mcp' });

  const claude = await app.openAgentChat('claude', { x: 300, y: 300 });
  await app.send(claude, 'комета');
  const a = await app.waitAnswer(claude);
  const tool = a.parts.find((p) => p.type === 'tool');
  expect(tool, JSON.stringify(a.parts)).toMatchObject({ name: 'mcp__vibetabula__search_chats', status: 'ok' });
  expect(tool.output).toContain('1. [vibetabula] Обсуждение кометы');
  expect(tool.output).toContain('ref="cv_comet"');
  const config = app.readJson(argAfter(app.calls('claude')[0].argv, '--mcp-config'));
  expect(config.mcpServers.vibetabula).toMatchObject({ type: 'stdio', command: await app.main(() => process.execPath), env: { ELECTRON_RUN_AS_NODE: '1', CANVASTTY_USERDATA: app.userData } });

  // Codex gets the server as -c mcp_servers.vibetabula.* and finds its own session on disk
  const codex = await app.openAgentChat('codex', { x: 850, y: 300 });
  await app.send(codex, 'сборку');
  const b = await app.waitAnswer(codex);
  expect(b.content).toMatch(/^Нашёл в истории:\n1\. \[codex\] Почини сборку\n/);
  return { claude, codex };
}

test('агенты находят прошлые разговоры через MCP-сервер истории', async ({ app, home }) => {
  await searchOldChats(app, home);
});

test.describe('кириллица, пробелы и скобки в пути профиля', () => {
  test.use({ homePrefix: 'vibetabula e2e (Тест) ' });

  test('агенты запускаются в папке профиля, получают вложения и историю чатов', async ({ app, home }) => {
    expect(path.basename(home)).toMatch(/^vibetabula e2e \(Тест\) /);
    const { codex } = await searchOldChats(app, home);
    expect(app.calls('codex')[0].cwd).toBe(home);

    // a picture attached in a chat goes through the command line (cmd.exe quoting on Windows)
    const png = path.join(home, 'Скрин (1).png');
    fs.writeFileSync(png, PNG);
    app.scenario({ codex: 'basic' });
    await app.page.evaluate((id) => window.__app.canvas.views.get(id).inst.newSession(), codex);
    await app.el(codex).locator('input[type=file]').setInputFiles(png);
    await expect(app.el(codex).locator('.att-chip:not(.pending)')).toHaveCount(1);
    await app.send(codex, 'Что на скрине?');
    expect((await app.waitAnswer(codex)).content).toBe('Codex: Что на скрине?');
    const file = argAfter(app.calls('codex')[1].argv, '-i');
    expect(path.dirname(file)).toBe(path.join(app.userData, 'attachments'));
    expect(path.basename(file)).toMatch(/^[0-9a-f]{10}-Скрин _1_\.png$/); // the name is made safe, the folder keeps "(Тест)"
    expect(file).toContain(' (Тест) ');
    expect(fs.readFileSync(file)).toEqual(PNG);
  });
});

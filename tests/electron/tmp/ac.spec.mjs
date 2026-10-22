// Agent chat windows with real CLI processes: the main process finds the fake Codex / Claude Code
// from tests/electron/bin on PATH (the .cmd shim on Windows), writes the prompt to stdin and turns
// their JSON events into the chat. What each fake was started with is in app.calls().
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, isAlive } from '../fixtures.mjs';

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionOf = (app, id) => app.page.evaluate((id) => window.__app.canvas.node(id).data.sessionId, id);

test('Claude Code: потоковый ответ с инструментом, сессия продолжается, разговор сохранён в истории', async ({ app, home }) => {
  const chat = await app.openAgentChat('claude');
  const question = 'Что в проекте? «кавычки» "двойные" & | < > ^ % !';
  await app.send(chat, question);
  const answer = await app.waitAnswer(chat);

  // the prompt went through stdin untouched; the command line is the one the app builds
  const [first] = app.calls('claude');
  expect(first.prompt).toBe(question);
  expect(first.cwd).toBe(home);
  expect(first.argv.slice(0, 7)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits']);
  expect(path.dirname(argAfter(first.argv, '--mcp-config'))).toBe(app.userData);
  expect(argAfter(first.argv, '--allowedTools')).toBe('mcp__vibetabula__search_chats,mcp__vibetabula__read_chat,mcp__vibetabula__list_chats');
  expect(first.argv).not.toContain('--resume');

  expect(answer.parts.map((p) => p.type)).toEqual(['text', 'tool', 'text']);
  expect(answer.parts[1]).toMatchObject({ name: 'Bash', input: 'ls -la', output: 'README.md\nmain\nrenderer', status: 'ok' });
  expect(answer.content).toBe(`Смотрю файлы.\n\nClaude: ${question}`);
  const box = app.el(chat);
  await expect(box.locator('.msg.assistant .msg-text').last()).toHaveText(`Claude: ${question}`);
  await expect(box.locator('.tool-call summary')).toContainText('Bashls -la');
  expect(await app.page.evaluate((id) => window.__app.canvas.node(id).data.actualModel, chat), 'модель из system/init').toBe('claude-fake-5');
  const sid = await sessionOf(app, chat);
  expect(sid).toMatch(UUID);
  await expect(box.locator('.chat-usage')).toContainText(`$0.0123 · сессия ${sid.slice(0, 8)}`);
  expect(await app.status(chat)).toBe('Ожидает');

  // the next message resumes the session
  await app.send(chat, 'А теперь тесты');
  expect((await app.waitAnswer(chat)).content).toContain('Claude: А теперь тесты');
  const second = app.calls('claude')[1];
  expect(argAfter(second.argv, '--resume')).toBe(sid);
  expect(second.prompt).toBe('А теперь тесты');

  // every answer is written to the chat history in the profile
  const index = path.join(app.userData, 'chats', 'index.json');
  await expect.poll(() => fs.existsSync(index) && Object.values(app.readJson(index)).map((r) => [r.kind, r.agent, r.model, r.sessionId, r.count, r.title])).toEqual([['agentchat', 'claude', 'claude-fake-5', sid, 4, question.slice(0, 40)]]);
});

// BUG: the 'session' event (it comes before 'info') replaces inst.node with a copy in
// patchNodeData(); 'info' then writes actualModel to the canvas node, but renderInfo() reads the
// stale copy, so the window keeps showing "модель из настроек агента" until it is re-rendered.
test('модель, о которой сообщил Claude Code, сразу видна в окне чата', async ({ app }) => {
  const chat = await app.openAgentChat('claude');
  await app.send(chat, 'Привет');
  await app.waitAnswer(chat);
  await expect(app.el(chat).locator('.model-info')).toHaveText('claude-fake-5');
});

test('Codex: команда и размышления в ленте, продолжение через exec resume', async ({ app, home }) => {
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'Обнови README');
  const answer = await app.waitAnswer(chat);

  const [first] = app.calls('codex');
  expect(first.prompt).toBe('Обнови README');
  expect(first.cwd).toBe(home);
  expect(first.argv.slice(0, 5)).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write']);
  // the chat-history MCP server: the app's own binary as Node.js, reading this profile
  expect(first.argv).toContain(`mcp_servers.vibetabula.command='${await app.main(() => process.execPath)}'`);
  expect(first.argv.find((a) => a.startsWith('mcp_servers.vibetabula.env='))).toContain(`CANVASTTY_USERDATA='${app.userData}'`);
  expect(first.argv).not.toContain('resume');

  expect(answer.parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'text']);
  expect(answer.parts[1]).toMatchObject({ name: 'Команда', input: 'ls', output: 'README.md\nmain\nrenderer\n', status: 'ok' });
  expect(answer.content).toBe('Codex: Обнови README');
  const box = app.el(chat);
  await expect(box.locator('.msg-reason summary')).toHaveText('Размышления');
  const tid = await sessionOf(app, chat);
  expect(tid).toMatch(UUID);
  await expect(box.locator('.chat-usage')).toContainText(`ток. · сессия ${tid.slice(0, 8)}`);

  await app.send(chat, 'Ещё');
  await app.waitAnswer(chat);
  const second = app.calls('codex')[1];
  expect(second.argv.slice(-2)).toEqual(['resume', tid]);
  expect(await sessionOf(app, chat)).toBe(tid);
});

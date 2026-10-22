// Agent chat windows with real CLI processes: the main process finds the fake Codex / Claude Code
// from tests/electron/bin on PATH (the .cmd shim on Windows), writes the prompt to stdin and turns
// their JSON events into the chat. What each fake was started with is in app.calls().
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, isAlive } from './fixtures.mjs';

const argAfter = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
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

// Regression (fixed): the 'session' event (it comes before 'info') replaces inst.node with a copy in
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

test('Codex переподключается: одна строка со счётчиком вместо ошибок, потом ответ', async ({ app }) => {
  app.scenario({ codex: 'reconnect' });
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'Нарисуй схему');
  const box = app.el(chat);
  // the fake waits after "Reconnecting... 2/5" until released
  await expect(box.locator('.msg-retry')).toHaveText('Связь с сервером OpenAI прервалась, Codex переподключается (2 из 5)…');
  await expect(box.locator('.msg-retry')).toHaveCount(1);
  await expect(box.locator('.msg-error')).toHaveCount(0);
  expect(await app.status(chat)).toBe('Работает');

  app.release('codex');
  const answer = await app.waitAnswer(chat);
  expect(answer.parts.map((p) => p.type)).toEqual(['text']);
  expect(answer.content).toBe('Codex: Нарисуй схему');
  await expect(box.locator('.msg-retry')).toHaveCount(0);
});

test('«Стоп» завершает процесс агента вместе с запущенной им командой', async ({ app }) => {
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'Долгая задача');
  const box = app.el(chat);
  await expect(box.locator('.tool-call')).toContainText('sleep 600');
  const [run] = app.calls('codex');
  expect([isAlive(run.pid), isAlive(run.childPid)]).toEqual([true, true]);

  // on Windows the CLI runs as cmd.exe → node → child: the whole tree must go (taskkill /T)
  await box.locator('.chat-send.stop').click();
  const answer = await app.waitAnswer(chat);
  expect(answer.parts.at(-1)).toEqual({ type: 'notice', text: 'Остановлено' });
  expect(answer.parts.find((p) => p.type === 'tool').status).toBe('err');
  await expect.poll(() => [isAlive(run.pid), isAlive(run.childPid)], { message: 'процессы агента завершены' }).toEqual([false, false]);
  await expect(box.locator('.chat-send')).not.toHaveClass(/stop/);
});

test('сессия с другого компьютера не найдена: Codex и Claude Code начинают новую', async ({ app }) => {
  app.scenario({ codex: 'stale', claude: 'stale' });
  const old = [{ role: 'user', content: 'старый вопрос' }, { role: 'assistant', content: 'старый ответ', parts: [{ type: 'text', text: 'старый ответ' }] }];
  const codex = await app.add('agentchat', { x: 0, y: 0, w: 520, h: 520, data: { agentId: 'codex', kind: 'codex', sessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', messages: old } });
  const claude = await app.add('agentchat', { x: 560, y: 0, w: 520, h: 520, data: { agentId: 'claude', kind: 'claude', sessionId: '11111111-2222-3333-4444-555555555555', messages: old } });

  await app.send(codex, 'продолжим');
  const a1 = await app.waitAnswer(codex);
  expect(a1.parts[0]).toEqual({ type: 'notice', text: 'Не удалось продолжить прошлую сессию Codex — начинаю новую.' });
  expect(a1.content).toBe('Codex: продолжим');
  expect(app.calls('codex').map((c) => c.argv.includes('resume'))).toEqual([true, false]);
  expect(await sessionOf(app, codex)).not.toBe('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000');

  await app.send(claude, 'продолжим');
  const a2 = await app.waitAnswer(claude);
  expect(a2.parts[0]).toEqual({ type: 'notice', text: 'Прошлая сессия Claude Code на этом компьютере не найдена — начинаю новую.' });
  expect(a2.content).toBe('Смотрю файлы.\n\nClaude: продолжим');
  expect(app.calls('claude').map((c) => argAfter(c.argv, '--resume') || null)).toEqual(['11111111-2222-3333-4444-555555555555', null]);
  const sid = await sessionOf(app, claude);
  expect(sid).toMatch(UUID);
  expect(sid).not.toBe('11111111-2222-3333-4444-555555555555');
  for (const id of [codex, claude]) expect(await app.status(id)).toBe('Ожидает');
});

test('старые версии CLI: без --effort, без --include-partial-messages, без одобрения MCP-инструментов', async ({ app }) => {
  app.scenario({ codex: 'old-mcp', claude: 'old' });
  const claude = await app.add('agentchat', { x: 0, y: 0, w: 520, h: 560, data: { agentId: 'claude', kind: 'claude', effort: 'high', messages: [] } });
  await app.send(claude, 'Привет');
  const a1 = await app.waitAnswer(claude);
  expect(a1.parts[0].text).toMatch(/^Эта версия Claude Code не поддерживает выбор уровня размышления/);
  expect(a1.content).toBe('Смотрю файлы.\n\nClaude: Привет');
  const runs = app.calls('claude').map((c) => [c.argv.includes('--effort'), c.argv.includes('--include-partial-messages')]);
  expect(runs).toEqual([[true, true], [false, true], [false, false]]);

  const codex = await app.add('agentchat', { x: 560, y: 0, w: 520, h: 560, data: { agentId: 'codex', kind: 'codex', messages: [] } });
  await app.send(codex, 'Привет');
  expect((await app.waitAnswer(codex)).content).toBe('Codex: Привет');
  const calls = app.calls('codex');
  expect(calls.map((c) => c.argv.some((a) => a.includes('default_tools_approval_mode')))).toEqual([true, false]);
  expect(calls[1].argv.some((a) => a.startsWith('mcp_servers.vibetabula.command=')), 'история чатов осталась').toBe(true);
});

test('ошибки агента и нехватка прав видны в окне и в статусе', async ({ app }) => {
  app.scenario({ codex: 'fail', claude: 'crash' });
  const codex = await app.add('agentchat', { x: 0, y: 0, w: 480, h: 480, data: { agentId: 'codex', kind: 'codex', messages: [] } });
  await app.send(codex, 'Сделай');
  const a1 = await app.waitAnswer(codex);
  // five reconnects end in turn.failed: one error, no leftover retry line
  expect(a1.parts).toEqual([{ type: 'error', text: 'stream disconnected before completion: связь потеряна' }]);
  // in plain words with what to do; the original text under «Подробности»
  await expect(app.el(codex).locator('.msg-error .err-title')).toHaveText('⚠ Нет связи с сервером');
  await expect(app.el(codex).locator('.msg-error .err-raw pre')).toHaveText('stream disconnected before completion: связь потеряна');
  await expect(app.el(codex).locator('.msg-retry')).toHaveCount(0);
  expect(await app.status(codex)).toBe('Ошибка');

  // the CLI died without output: its stderr is shown
  const claude = await app.add('agentchat', { x: 520, y: 0, w: 480, h: 480, data: { agentId: 'claude', kind: 'claude', messages: [] } });
  await app.send(claude, 'Сделай');
  await app.waitAnswer(claude);
  await expect(app.el(claude).locator('.msg-error .err-title')).toHaveText('⚠ Claude Code завершился с ошибкой');
  await expect(app.el(claude).locator('.msg-error .err-raw pre')).toHaveText('claude: внутренняя ошибка (fake crash)');
  expect(await app.status(claude)).toBe('Ошибка');

  // the agent was not allowed to write: it waits for the user
  app.scenario({ claude: 'denied' });
  const denied = await app.add('agentchat', { x: 1040, y: 0, w: 480, h: 480, data: { agentId: 'claude', kind: 'claude', messages: [] } });
  await app.send(denied, 'Поправь README');
  const a3 = await app.waitAnswer(denied);
  expect(a3.parts.at(-1).text).toBe('Агенту не хватило прав (Write). Выберите режим «Доступ» шире и повторите или ответьте ему.');
  expect(await app.status(denied)).toBe('Нужно разрешение');
});

test('длинный разговор: старые сообщения не пропадают, пока агент отвечает', async ({ app }) => {
  app.scenario({ codex: 'reconnect' });
  const old = [];
  for (let k = 0; k < 6; k++) {
    old.push({ role: 'user', content: `вопрос ${k}` });
    old.push({ role: 'assistant', content: `ответ ${k} `.repeat(30).trim(), parts: [{ type: 'text', text: `ответ ${k} `.repeat(30).trim() }] });
  }
  const chat = await app.add('agentchat', { x: 0, y: 0, w: 600, h: 620, data: { agentId: 'codex', kind: 'codex', sessionId: '01a1ffff-0000-7000-8000-000000000001', title: 'Старый чат', messages: old } });
  const box = app.el(chat);
  await expect(box.locator('.msg')).toHaveCount(12);
  await app.send(chat, 'новый вопрос');
  await expect(box.locator('.msg-retry')).toBeVisible(); // the agent is working now
  const during = await app.messages(chat);
  expect(during.slice(0, 12).map((m) => m.content)).toEqual(old.map((m) => m.content));
  expect(during.slice(12).map((m) => [m.role, m.content, !!m.running])).toEqual([['user', 'новый вопрос', false], ['assistant', '', true]]);
  await expect(box.locator('.msg')).toHaveCount(14);
  await expect(box.locator('.msg.user .msg-text').first()).toHaveText('вопрос 0');

  app.release('codex');
  await app.waitAnswer(chat);
  expect((await app.messages(chat)).map((m) => m.content)).toEqual([...old.map((m) => m.content), 'новый вопрос', 'Codex: новый вопрос']);
  await expect(box.locator('.msg')).toHaveCount(14);
  expect(app.calls('codex')[0].argv.slice(-2)).toEqual(['resume', '01a1ffff-0000-7000-8000-000000000001']);
});

test('ответ дописывается в файл canvas, даже если пользователь переключился на другой', async ({ app }) => {
  app.scenario({ codex: 'slow' });
  const chat = await app.openAgentChat('codex');
  const first = await app.page.evaluate(() => window.__app.canvas.doc.id);
  await app.send(chat, 'Долгая задача');
  await expect(app.el(chat).locator('.tool-call')).toBeVisible();

  await app.page.evaluate(async () => { const { state } = await import('/js/state.js'); await state.createCanvas(state.project.id, 'Второй'); });
  await expect(app.page.locator('.ctab.active')).toHaveText('Второй');
  app.release('codex');
  // written straight into the first canvas' file by the main process (the window is gone)
  const file = path.join(app.userData, 'canvases', `${first}.json`);
  await expect.poll(() => {
    const n = app.readJson(file).nodes.find((x) => x.id === chat);
    const last = n?.data.messages.at(-1);
    return last && [last.content, !!last.running];
  }, { timeout: 15_000 }).toEqual(['Codex: Долгая задача', false]);

  await app.page.locator('.ctab', { hasText: 'Главный' }).click();
  await expect(app.el(chat).locator('.msg.assistant .msg-text').last()).toHaveText('Codex: Долгая задача');
  expect(await app.status(chat)).toBe('Ожидает');
});

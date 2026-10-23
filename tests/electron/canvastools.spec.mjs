// Canvas tools with real processes: the fake Codex / Claude Code start the MCP server the app gives
// the run (the app's own binary as Node.js), call canvas_* tools, and the stickies and the arrow
// appear next to the agent's window — also when the app was restarted while the agent worked.
import { test, expect } from './fixtures.mjs';

const added = (app, id) => app.page.evaluate((id) => JSON.parse(JSON.stringify(window.__app.canvas.doc.nodes.filter((n) => n.data?.createdBy === id))), id);
const edgesOf = (app, ids) => app.page.evaluate((ids) => JSON.parse(JSON.stringify(window.__app.canvas.doc.edges.filter((e) => ids.includes(e.from)))), ids);

async function expectPlan(app, win, said) {
  const stickies = await added(app, win);
  expect(stickies.map((n) => n.data.text)).toEqual([`Шаг 1: ${said}`, 'Шаг 2: проверить']);
  const w = await app.page.evaluate((id) => window.__app.canvas.node(id), win);
  for (const s of stickies) expect(s.x, 'рядом с окном агента, справа').toBeGreaterThanOrEqual(w.x + w.w);
  expect(await edgesOf(app, stickies.map((s) => s.id))).toEqual([expect.objectContaining({ from: stickies[0].id, to: stickies[1].id, label: 'затем' })]);
  return stickies;
}

test('Codex и Claude Code раскладывают план стикерами рядом со своим окном; один Ctrl+Z убирает добавленное', async ({ app }) => {
  app.scenario({ codex: 'canvas', claude: 'canvas' });
  const a = await app.add('agentchat', { x: 0, y: 0, w: 460, h: 460, data: { agentId: 'codex', kind: 'codex', title: 'План', messages: [] } });
  await app.send(a, 'собрать релиз');
  const answer = await app.waitAnswer(a);
  expect(answer.content).toContain('Разложил план на холсте');
  expect(answer.content).toContain('Холст «');
  expect(answer.content).not.toContain('ОШИБКА');
  await expectPlan(app, a, 'собрать релиз');
  await app.page.evaluate(() => window.__app.canvas.undo());
  expect(await added(app, a)).toEqual([]);

  const b = await app.add('agentchat', { x: 0, y: 1400, w: 460, h: 460, data: { agentId: 'claude', kind: 'claude', title: 'Тесты', messages: [] } });
  await app.send(b, 'написать тесты');
  const answerB = await app.waitAnswer(b);
  expect(answerB.content).toContain('Разложил план на холсте');
  expect(answerB.parts.filter((p) => p.type === 'tool').map((p) => [p.name, p.status])).toEqual([
    ['mcp__vibetabula__canvas_list_objects', 'ok'], ['mcp__vibetabula__canvas_create_sticky', 'ok'], ['mcp__vibetabula__canvas_create_sticky', 'ok'], ['mcp__vibetabula__canvas_connect', 'ok'],
  ]);
  await expectPlan(app, b, 'написать тесты');
});

test('выключенная настройка: агенту не дают инструментов холста', async ({ app }) => {
  await app.page.evaluate(async () => (await import('./js/state.js')).state.setSetting('canvasTools', false));
  const a = await app.add('agentchat', { x: 0, y: 0, w: 460, h: 460, data: { agentId: 'codex', kind: 'codex', messages: [] } });
  await app.send(a, 'привет');
  await app.waitAnswer(a);
  expect(app.calls('codex')[0].argv.join(' ')).not.toContain('VT_CANVAS');
});

test('приложение перезапустили, пока агент думал: его инструменты холста продолжают работать', async ({ app }) => {
  app.scenario({ codex: 'canvas-wait' });
  const a = await app.add('agentchat', { x: 0, y: 0, w: 460, h: 460, data: { agentId: 'codex', kind: 'codex', title: 'Долгий план', messages: [] } });
  await app.send(a, 'план переезда');
  await expect.poll(() => app.calls('codex').length).toBe(1);
  await expect(app.el(a).locator('.msg.assistant')).toContainText('Продумываю план');
  await app.closeWindow();
  await app.launch();
  await expect.poll(() => app.status(a)).toBe('Работает');
  app.release('codex');
  const answer = await app.waitAnswer(a);
  expect(answer.content).toContain('Разложил план на холсте');
  expect(answer.content).not.toContain('ОШИБКА');
  await expectPlan(app, a, 'план переезда');
});

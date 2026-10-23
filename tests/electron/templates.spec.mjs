// Layout templates in the real app: the built-in «Баг» works end to end (the starter task goes to
// Claude Code with the area as context, its answer goes on to Codex along the «Передавать ответ»
// arrow), and a template of your own is written to workspace.json and is there after a restart.
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

test('шаблон «Баг»: стартовая задача с описанием уходит Claude Code, его ответ — Codex по стрелке', async ({ app }) => {
  await app.page.evaluate(async () => { const t = await import('./js/templates.js'); await t.placeTemplate(window.__app.canvas, t.BUILT_IN.find((x) => x.name === 'Баг')); });
  const [fix, check] = await app.page.evaluate(() => window.__app.canvas.doc.nodes.filter((n) => n.type === 'agentchat').sort((a, b) => a.x - b.x).map((n) => n.id));
  const sticky = await app.page.evaluate(() => window.__app.canvas.doc.nodes.find((n) => n.type === 'sticky').id);
  await app.page.evaluate((id) => window.__app.canvas.updateNode(id, { data: { text: 'Что сломалось:\nкнопка «Сохранить» не сохраняет' } }), sticky);

  await app.reveal(fix);
  const input = app.el(fix).locator('.chat-input');
  await expect(input).toHaveValue(/^Найди причину бага/);
  await input.press('Enter');
  const answer = await app.waitAnswer(fix);
  expect(answer.content).toContain('Claude: Найди причину бага');
  const [claude] = app.calls('claude');
  expect(claude.prompt).toContain('кнопка «Сохранить» не сохраняет');
  expect(claude.argv).toContain('acceptEdits');

  await expect.poll(() => app.calls('codex').length, { timeout: 20_000 }).toBe(1);
  const [codex] = app.calls('codex');
  expect(codex.prompt).toContain('Проверь это исправление бага');
  expect(codex.prompt).toContain('Claude: Найди причину бага');
  expect(codex.argv.join(' ')).toContain('-s read-only');
  await app.waitAnswer(check);
});

test('свой шаблон записывается в workspace.json и остаётся после перезапуска', async ({ app }) => {
  const frame = await app.add('frame', { x: 0, y: 0, w: 600, h: 400, data: { title: 'Ретро' } });
  await app.add('sticky', { x: 40, y: 80, w: 220, h: 200, data: { text: 'Что было хорошо' } });
  await app.page.evaluate(async (id) => {
    const t = await import('./js/templates.js');
    const c = window.__app.canvas;
    const tpl = await t.templateFrom(c, [c.node(id)], 'Ретро команды');
    const { state } = await import('./js/state.js');
    state.ws.templates = [...t.userTemplates(), tpl];
    state.saveWs();
  }, frame);
  await expect.poll(() => (app.readJson(path.join(app.userData, 'workspace.json')).templates || []).map((t) => t.name)).toEqual(['Ретро команды']);
  await app.restart();
  expect(await app.page.evaluate(async () => (await import('./js/templates.js')).userTemplates().map((t) => [t.name, t.nodes.length]))).toEqual([['Ретро команды', 2]]);
});

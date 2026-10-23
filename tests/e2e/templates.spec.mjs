// Layout templates (renderer/js/templates.js): built-in «Баг / Фича / Ревью», saving your own from
// the selection (an area brings its contents), placing one again (new ids, arrows and areas kept,
// a chat without its conversation, a note as a new file), renaming and deleting, starter prompts
// in chat windows. Sync of templates between computers: tests/unit/sync.test.mjs.
import { test, expect } from './fixtures.mjs';
import { menuItem, vault } from './helpers/canvas.mjs';
import { addAgentChat, chat, recordAgentRuns, agentRun } from './helpers/chat.mjs';

const ws = (page) => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/js/state.js')).state.ws.templates || [])));
const card = (page, name) => page.locator('.tpl-modal .tpl-card', { has: page.locator('.tpl-name', { hasText: new RegExp(`^${name}$`) }) });
async function answerPrompt(page, text) {
  const input = page.locator('.modal input.input').last();
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

test('встроенный шаблон «Баг» из меню холста: область с описанием, два агента, стрелки, стартовая задача; один Ctrl+Z', async ({ app, page }) => {
  await page.mouse.click(700, 450, { button: 'right' });
  await menuItem(page, 'Шаблон раскладки…').click();
  await expect(page.locator('.tpl-modal .tpl-section')).toHaveText(['Встроенные', 'Ваши']);
  await expect(page.locator('.tpl-modal .tpl-card.built-in .tpl-name')).toHaveText(['Баг', 'Фича', 'Ревью']);
  await expect(page.locator('.tpl-modal .tpl-empty')).toContainText('Пока нет');
  await card(page, 'Баг').click();
  await expect(page.locator('.tpl-modal')).toHaveCount(0);

  const nodes = await app.nodes();
  const frame = nodes.find((n) => n.type === 'frame');
  expect(frame.data.title).toBe('Описание бага');
  const stickies = nodes.filter((n) => n.type === 'sticky');
  expect(stickies.map((n) => n.data.text.split('\n')[0])).toEqual(['Что сломалось:', 'Как воспроизвести:', 'Ожидалось:']);
  expect(stickies.every((n) => n.parent === frame.id), 'стикеры внутри области').toBe(true);
  const [fix, check] = nodes.filter((n) => n.type === 'agentchat').sort((a, b) => a.x - b.x);
  expect(fix.data).toMatchObject({ kind: 'claude', title: 'Исправление бага', mode: 'acceptEdits', messages: [] });
  expect(check.data).toMatchObject({ kind: 'codex', title: 'Проверка исправления', mode: 'read' });
  const edges = await app.edges();
  expect(edges.find((e) => e.from === frame.id)?.to).toBe(fix.id);
  expect(edges.find((e) => e.from === fix.id)).toMatchObject({ to: check.id, relay: { note: expect.stringContaining('Проверь это исправление') } });
  // the layout's middle is where the right click was
  const at = await page.evaluate(() => window.__app.canvas.toWorld(700, 450));
  const x1 = Math.min(...nodes.map((n) => n.x)), x2 = Math.max(...nodes.map((n) => n.x + n.w));
  const y1 = Math.min(...nodes.map((n) => n.y)), y2 = Math.max(...nodes.map((n) => n.y + n.h));
  expect(Math.abs((x1 + x2) / 2 - at.x)).toBeLessThan(2);
  expect(Math.abs((y1 + y2) / 2 - at.y)).toBeLessThan(2);
  expect((await app.selection()).sort()).toEqual(nodes.map((n) => n.id).sort());
  await expect(chat(app, fix.id).input).toHaveValue(/^Найди причину бага/);
  await expect(chat(app, check.id).input).toHaveValue('');

  await app.undo();
  expect(await app.nodes()).toEqual([]);
});

test('стартовая задача уходит первым сообщением и больше не появляется', async ({ app, page }) => {
  await recordAgentRuns(page);
  await page.keyboard.press('Control+p');
  const search = page.locator('.modal input').first();
  await search.fill('Шаблон: Ревью');
  await search.press('Enter');
  const chats = (await app.nodes('agentchat')).sort((a, b) => a.x - b.x);
  expect(chats.map((n) => n.data.title)).toEqual(['Ревью: ошибки и риски', 'Ревью: тесты и стиль']);
  const c = chat(app, chats[0].id);
  await expect(c.input).toHaveValue(/^Сделай ревью изменений/);
  await c.input.press('Enter');
  expect((await agentRun(page, 0)).prompt).toContain('Сделай ревью изменений текущей ветки');
  expect((await app.node(chats[0].id)).data.draft).toBeNull();
  // the window is drawn again (canvas reloaded): the input stays empty
  await page.evaluate(() => window.__app.canvas.load());
  await expect(chat(app, chats[0].id).input).toHaveValue('');
});

test('свой шаблон из выделения: без переписки, сессии и папки; вставленная копия — новые объекты, заметка — новый файл', async ({ app, page }) => {
  const frame = await app.add('frame', { x: 0, y: 0, w: 700, h: 500, data: { title: 'Разбор' } });
  const s = await app.add('sticky', { x: 40, y: 80, w: 200, h: 160, data: { text: 'Симптомы' } });
  const p = await vault.create(page, '', 'Чек-лист разбора', '# Чек-лист разбора\n\n- логи\n- метрики');
  const note = await app.add('note', { x: 280, y: 80, w: 380, h: 300, data: { path: p } });
  const ag = await addAgentChat(app, { x: 800, y: 0, w: 460, h: 500, data: { title: 'Разбор логов', mode: 'read', cwd: '/home/user/proj', sessionId: 'sess-1', messages: [{ role: 'user', content: 'старый вопрос' }, { role: 'assistant', content: 'старый ответ' }], worktree: { repo: '/demo/repo', path: '/demo/repo.worktrees/x', cwd: '/demo/repo.worktrees/x', branch: 'vibetabula/x', baseBranch: 'main' } } });
  await page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b, { label: 'контекст' }), [frame, ag]);
  await app.select([frame, ag]);
  const head = await app.box(ag, '.node-head');
  await page.mouse.click(head.x + 80, head.cy, { button: 'right' });
  await menuItem(page, 'Сохранить как шаблон…').click();
  await answerPrompt(page, 'Разбор инцидента');
  await expect(page.locator('.toast').last()).toContainText('Шаблон «Разбор инцидента» сохранён: 4 объекта');

  const [tpl] = await ws(page);
  expect(tpl.name).toBe('Разбор инцидента');
  expect(tpl.nodes.map((n) => n.type)).toEqual(['frame', 'sticky', 'note', 'agentchat']);
  const tAg = tpl.nodes.find((n) => n.type === 'agentchat');
  expect(tAg.data).toMatchObject({ title: 'Разбор логов', mode: 'read' });
  for (const k of ['messages', 'sessionId', 'cwd', 'worktree']) expect(tAg.data[k], k).toBeUndefined();
  expect(tpl.nodes.find((n) => n.type === 'note').data).toEqual({ title: 'Чек-лист разбора', text: '# Чек-лист разбора\n\n- логи\n- метрики' });
  expect(Math.min(...tpl.nodes.map((n) => n.x))).toBe(0);

  await app.reset();
  await page.keyboard.press('Control+p');
  const search = page.locator('.modal input').first();
  await search.fill('Шаблоны раскладки');
  await search.press('Enter');
  await card(page, 'Разбор инцидента').click();
  const nodes = await app.nodes();
  expect(nodes.map((n) => n.type).sort()).toEqual(['agentchat', 'frame', 'note', 'sticky']);
  const f2 = nodes.find((n) => n.type === 'frame'), a2 = nodes.find((n) => n.type === 'agentchat'), n2 = nodes.find((n) => n.type === 'note');
  expect([f2.id, a2.id]).not.toContain(frame);
  expect(nodes.find((n) => n.type === 'sticky').parent).toBe(f2.id);
  expect(a2.data).toMatchObject({ title: 'Разбор логов', messages: [] });
  for (const k of ['sessionId', 'cwd', 'worktree']) expect(a2.data[k], k).toBeFalsy();
  expect(n2.data.path).toBe('Из шаблонов/Чек-лист разбора.md');
  expect(await vault.read(page, n2.data.path)).toBe('# Чек-лист разбора\n\n- логи\n- метрики');
  expect(await app.edges()).toEqual([expect.objectContaining({ from: f2.id, to: a2.id, label: 'контекст' })]);
});

test('второй раз тот же шаблон: названия областей и окон получают номер, первые остаются', async ({ app, page }) => {
  const place = (name) => page.evaluate(async (name) => { const t = await import('/js/templates.js'); return t.placeTemplate(window.__app.canvas, t.allTemplates().find((x) => x.name === name)); }, name);
  await place('Фича');
  await place('Фича');
  expect((await app.nodes('frame')).map((n) => n.data.title).sort()).toEqual(['Фича', 'Фича 2']);
  expect((await app.nodes('agentchat')).map((n) => n.data.title).sort()).toEqual(['План фичи', 'План фичи 2', 'Реализация', 'Реализация 2']);
  const lists = await app.nodes('widget');
  expect(lists.map((n) => n.data.items.length)).toEqual([4, 4]);
  expect((await app.edges()).filter((e) => e.relay)).toHaveLength(2);
});

test('свои шаблоны можно переименовать и удалить, встроенные — нет', async ({ app, page }) => {
  const s = await app.add('sticky', { x: 0, y: 0, data: { text: 'идея' } });
  await app.select([s]);
  await page.evaluate(async () => { const { saveTemplate } = await import('/js/templates.js'); saveTemplate(window.__app.canvas); });
  await answerPrompt(page, 'Мозговой штурм');
  await page.mouse.click(700, 450, { button: 'right' });
  await menuItem(page, 'Шаблон раскладки…').click();
  await expect(card(page, 'Баг').locator('.tpl-actions')).toHaveCount(0);
  const mine = card(page, 'Мозговой штурм');
  await mine.hover();
  await mine.locator('button[title="Переименовать"]').click();
  await answerPrompt(page, 'Штурм идей');
  await expect(card(page, 'Штурм идей')).toBeVisible();
  expect((await ws(page)).map((t) => t.name)).toEqual(['Штурм идей']);
  await card(page, 'Штурм идей').hover();
  await card(page, 'Штурм идей').locator('button[title="Удалить"]').click();
  await page.locator('.modal button', { hasText: 'Удалить' }).last().click();
  await expect(page.locator('.tpl-modal .tpl-empty')).toBeVisible();
  const st = await page.evaluate(async () => (await import('/js/state.js')).state.ws);
  expect(st.templates).toEqual([]);
  expect(st.tombstones.some((id) => id.startsWith('tpl_'))).toBe(true);
});

test('пустое выделение и слишком большой шаблон — понятные сообщения', async ({ app, page }) => {
  await page.evaluate(async () => { const { saveTemplate } = await import('/js/templates.js'); saveTemplate(window.__app.canvas); });
  await expect(page.locator('.toast').last()).toContainText('Выделите объекты или область');
  const img = await app.add('image', { x: 0, y: 0, w: 100, h: 100, data: { src: `data:image/png;base64,${'A'.repeat(1_600_000)}` } });
  await app.select([img]);
  await page.evaluate(async () => { const { saveTemplate } = await import('/js/templates.js'); saveTemplate(window.__app.canvas); });
  await answerPrompt(page, 'Большой');
  await expect(page.locator('.toast').last()).toContainText('Шаблон слишком большой');
  expect(await ws(page)).toEqual([]);
});

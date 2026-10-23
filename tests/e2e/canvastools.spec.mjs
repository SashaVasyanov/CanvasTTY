// Canvas tools of the agents, window side (renderer/js/canvasTools.js): what an agent sees and adds
// through canvas_* MCP tools. The calls come as the main process would pass them (target = the
// chat window and canvas of the run). Main side and the MCP server: tests/unit/canvas-tools.test.mjs.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat, recordAgentRuns, agentRun } from './helpers/chat.mjs';
import { vault } from './helpers/canvas.mjs';

const docId = (page) => page.evaluate(() => window.__app.canvas.doc.id);
async function agent(app, page, opts = {}) {
  const id = await addAgentChat(app, { x: 0, y: 0, w: 460, h: 600, ...opts });
  const target = { nodeId: id, docId: await docId(page), run: opts.run || 'run-1' };
  const call = (op, args = {}, t = target) => page.evaluate(([t, op, args]) => window.__canvasCall(t, op, args), [t, op, args]);
  const ok = async (op, args) => { const r = await call(op, args); expect(r.error, `${op}: ${r.error}`).toBeUndefined(); return r.result; };
  return { id, target, call, ok };
}
const idIn = (text) => /\[([a-z]{2}_[a-z0-9]+)\]/.exec(text)[1];
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('агент видит объекты холста и читает их: ближние первыми, своё окно отдельно, область со списком внутри', async ({ app, page }) => {
  const a = await agent(app, page);
  const near = await app.add('sticky', { x: 520, y: 0, w: 200, h: 160, data: { text: 'Требование: офлайн' } });
  const far = await app.add('text', { x: 3000, y: 2000, w: 300, h: 40, data: { html: 'Далёкий заголовок' } });
  const frame = await app.add('frame', { x: -900, y: 0, w: 600, h: 400, data: { title: 'Идеи' } });
  const inFrame = await app.add('sticky', { x: -850, y: 80, w: 200, h: 160, data: { text: 'Идея внутри' } });
  await page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b), [near, a.id]);

  const list = await a.ok('list_objects');
  expect(list).toContain(`Ваше окно: [${a.id}] чат агента`);
  expect(list).toContain(`← [${near}]`);
  const lines = list.split('\n').filter((l) => l.startsWith('- '));
  expect(lines[0]).toContain(`[${near}] стикер «Требование: офлайн»`);
  expect(lines.at(-1)).toContain(`[${far}] текст «Далёкий заголовок»`);
  expect(list).toContain(`[${inFrame}] стикер «Идея внутри» · x -850, y 80, 200×160 · в области [${frame}]`);
  expect((await a.ok('list_objects', { type: 'frame' })).split('\n').filter((l) => l.startsWith('- '))).toEqual([expect.stringContaining(`[${frame}] область «Идеи»`)]);

  expect(await a.ok('read_object', { id: near })).toContain('Требование: офлайн');
  const area = await a.ok('read_object', { id: frame });
  expect(area).toContain(`Внутри: [${inFrame}] стикер «Идея внутри»`);
  expect(area).toContain('Идея внутри');
  expect((await a.call('read_object', { id: 'st_nope' })).error).toContain('нет на холсте');
});

test('стикеры, текст и стрелки появляются рядом с окном агента, не наезжают, всё за ответ — один Ctrl+Z', async ({ app, page }) => {
  const a = await agent(app, page);
  const user = await app.add('sticky', { x: 500, y: 0, w: 220, h: 220, data: { text: 'моё' } });
  const ids = [];
  for (const t of ['Шаг 1', 'Шаг 2', 'Шаг 3']) ids.push(idIn(await a.ok('create_sticky', { text: t, color: 'green' })));
  ids.push(idIn(await a.ok('create_text', { text: 'План работ', size: 28 })));
  expect(await a.ok('connect', { from: ids[0], to: ids[1], label: 'потом' })).toContain(`[${ids[0]}] → [${ids[1]}] «потом»`);
  expect(await a.ok('connect', { from: ids[0], to: ids[1] })).toContain('уже есть');

  const win = await app.node(a.id);
  const added = await Promise.all(ids.map((id) => app.node(id)));
  for (const n of added) {
    expect(n.data.createdBy).toBe(a.id);
    expect(n.x, 'справа от окна').toBeGreaterThanOrEqual(win.x + win.w);
  }
  expect(added[0].data).toMatchObject({ text: 'Шаг 1', color: 'green' });
  expect(added[3].data.size).toBe(28);
  const all = await app.nodes();
  for (const n of added) for (const m of all) if (m.id !== n.id) expect(overlap(n, m), `${n.id} наезжает на ${m.id}`).toBe(false);
  expect((await app.edges()).find((e) => e.from === ids[0])).toMatchObject({ to: ids[1], label: 'потом', createdBy: a.id });
  await expect(page.locator('.toast').last()).toContainText('добавил на холст 4 объекта — Ctrl+Z уберёт');

  await app.undo();
  expect((await app.nodes()).map((n) => n.id).sort()).toEqual([a.id, user].sort());
  expect(await app.edges()).toEqual([]);
});

test('после действия пользователя следующие добавления агента — отдельный шаг отмены', async ({ app, page }) => {
  const a = await agent(app, page);
  const first = idIn(await a.ok('create_sticky', { text: 'первый' }));
  const mine = await page.evaluate(() => window.__app.canvas.addNode('shape', { x: -600, y: 0 }, { center: false, select: false }).id);
  const second = idIn(await a.ok('create_sticky', { text: 'второй' }));
  await app.undo();
  expect(await app.node(second)).toBeFalsy();
  expect(await app.node(mine)).toBeTruthy();
  expect(await app.node(first)).toBeTruthy();
});

test('области: вокруг объектов и пустая с наполнением через area; заметка — файл в заметках', async ({ app, page }) => {
  const a = await agent(app, page);
  const s1 = idIn(await a.ok('create_sticky', { text: 'A' }));
  const s2 = idIn(await a.ok('create_sticky', { text: 'B' }));
  const around = await a.ok('create_area', { title: 'Этап 1', objects: [s1, s2], color: 'green' });
  expect(around).toContain('внутри 2 объекта');
  const f1 = idIn(around);
  expect((await app.node(s1)).parent).toBe(f1);
  expect((await app.node(f1)).data).toMatchObject({ title: 'Этап 1', color: 'green', createdBy: a.id });
  expect((await a.call('create_area', { title: 'x', objects: [a.id] })).error).toContain('Ваше окно');

  const f2 = idIn(await a.ok('create_area', { title: 'Этап 2', width: 520, height: 300 }));
  const inside = [];
  for (const t of ['в области 1', 'в области 2', 'в области 3']) inside.push(idIn(await a.ok('create_sticky', { text: t, area: f2 })));
  for (const id of inside) expect((await app.node(id)).parent, 'внутри области').toBe(f2);
  expect((await app.node(f2)).h, 'область выросла под содержимое').toBeGreaterThan(300);

  const note = idIn(await a.ok('create_note', { title: 'План: релиз', markdown: '## Шаги\n- собрать\n- проверить' }));
  const n = await app.node(note);
  expect(n.data.path).toBe('Из чатов/План релиз.md');
  expect(await vault.read(page, n.data.path)).toBe('# План: релиз\n\n## Шаги\n- собрать\n- проверить');
});

test('менять можно только своё; удалять агент не может ничего', async ({ app, page }) => {
  const a = await agent(app, page);
  const user = await app.add('sticky', { x: -400, y: 0, data: { text: 'текст пользователя' } });
  const own = idIn(await a.ok('create_sticky', { text: 'черновик' }));
  expect(await a.ok('update_text', { id: own, text: 'исправлено' })).toContain('обновлён');
  expect((await app.node(own)).data.text).toBe('исправлено');
  const denied = await a.call('update_text', { id: user, text: 'взлом' });
  expect(denied.error).toContain('только объекты, которые вы добавили сами');
  expect((await app.node(user)).data.text).toBe('текст пользователя');
  // another chat window's additions are not this agent's either
  const b = await agent(app, page, { x: 0, y: 900, run: 'run-2' });
  expect((await b.call('update_text', { id: own, text: 'чужое' })).error).toContain('только объекты');
  for (const op of ['delete', 'remove_object', 'delete_object', 'constructor', 'toString']) expect((await a.call(op, { id: user })).error).toContain('Нет такого действия');
  const note = idIn(await a.ok('create_note', { title: 'Черновик', markdown: 'v1' }));
  await a.ok('update_text', { id: note, text: '# Черновик\n\nv2' });
  expect(await vault.read(page, (await app.node(note)).data.path)).toBe('# Черновик\n\nv2');
});

test('холст не открыт у пользователя: агент меняет его файл', async ({ app, page }) => {
  await page.evaluate(async () => {
    const { native } = await import('/js/state.js');
    await native.canvas.save('doc-other', { id: 'doc-other', version: 1, viewport: { x: 0, y: 0, z: 1 }, nodes: [
      { id: 'ag_bg', type: 'agentchat', x: 0, y: 0, w: 460, h: 600, z: 1, data: { agentId: 'claude', kind: 'claude', title: 'Фоновый', messages: [] } },
      { id: 'fr_bg', type: 'frame', x: 1000, y: 0, w: 600, h: 400, z: -1, data: { title: 'Готово' } },
      { id: 'st_user', type: 'sticky', x: 520, y: 0, w: 220, h: 220, z: 2, data: { text: 'дело пользователя' } },
    ], edges: [] });
  });
  const t = { nodeId: 'ag_bg', docId: 'doc-other', run: 'bg' };
  const call = (op, args) => page.evaluate(([t, op, args]) => window.__canvasCall(t, op, args), [t, op, args]);
  expect((await call('list_objects', {})).result).toContain('сейчас не открыт у пользователя');
  const r = await call('create_sticky', { text: 'из фона', area: 'fr_bg' });
  expect(r.error).toBeUndefined();
  const s = idIn(r.result);
  expect((await call('connect', { from: 'st_user', to: s })).error).toBeUndefined();
  const doc = await page.evaluate(async () => (await import('/js/state.js')).native.canvas.load('doc-other'));
  expect(doc.nodes.find((n) => n.id === s)).toMatchObject({ type: 'sticky', parent: 'fr_bg', data: { text: 'из фона', createdBy: 'ag_bg' } });
  expect(doc.edges).toEqual([expect.objectContaining({ from: 'st_user', to: s, arrow: true })]);
  expect(await app.node(s), 'на открытый холст ничего не попало').toBeFalsy();
});

test('настройка выключена — инструменты отвечают отказом и не передаются агенту; окна нет — понятная ошибка', async ({ app, page }) => {
  await recordAgentRuns(page);
  const a = await agent(app, page);
  await chat(app, a.id).input.fill('разложи план');
  await chat(app, a.id).input.press('Enter');
  expect((await agentRun(page, 0)).canvasTools).toBe(true);

  await page.evaluate(async () => (await import('/js/state.js')).state.setSetting('canvasTools', false));
  expect((await a.call('create_sticky', { text: 'x' })).error).toContain('выключил инструменты холста');
  const b = await agent(app, page, { x: 0, y: 900, run: 'run-2' });
  await chat(app, b.id).input.fill('ещё');
  await chat(app, b.id).input.press('Enter');
  expect((await agentRun(page, 1)).canvasTools).toBe(false);
  await page.evaluate(async () => (await import('/js/state.js')).state.setSetting('canvasTools', true));

  await page.evaluate((id) => window.__app.canvas.removeNodes([id]), a.id);
  expect((await a.call('list_objects')).error).toContain('Окна этого чата больше нет на холсте');
});

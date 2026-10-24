// Exact statuses of terminal agents from their own signals (main/pty.js → 'pty:agent'; Claude Code
// hooks, Codex OSC 9): the window's status and its line, «Ждут вас», a terminal on a canvas that is
// not open. How the signals are made: tests/unit/agent-signals.test.mjs.
import { test, expect } from './fixtures.mjs';

const ptyOf = (app, id) => app.node(id).then((n) => n.data.sessionId);
const signal = (page, ev) => page.evaluate((ev) => window.__mockEmit('pty:agent', ev), ev);
const status = (page, id) => page.evaluate((id) => window.__app.canvas.views.get(id)?.inst?.statusInfo(), id);
const inboxItems = (page) => page.evaluate(async () => (await import('/js/inbox.js')).inbox.items.map((x) => ({ title: x.title, kind: x.kind, text: x.text, type: x.type })));

test('«Ждёт ответа» с текстом агента и «Готово» по сигналам; набор текста их снимает; без фокуса — в «Ждут вас»', async ({ app, page }) => {
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'claude', title: 'Claude: рефакторинг' } });
  await expect.poll(() => ptyOf(app, t)).toBeTruthy();
  const id = await ptyOf(app, t);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await signal(page, { id, state: 'wait', message: 'Claude needs your permission to use Bash' });
  expect(await status(page, t)).toMatchObject({ label: 'Ждёт ответа', kind: 'wait', detail: 'needs your permission to use Bash' });
  await expect(page.locator(`.node[data-id="${t}"] .head-activity`)).toHaveText('needs your permission to use Bash');
  expect(await inboxItems(page)).toEqual([{ title: 'Claude: рефакторинг', kind: 'wait', text: 'Claude needs your permission to use Bash', type: 'terminal' }]);

  // you answered: the window is working again (its own «busy» signal clears «Ждут вас»)
  await page.evaluate(() => { document.hasFocus = () => true; });
  await page.locator(`.node[data-id="${t}"] .xterm`).click();
  await page.keyboard.type('y');
  expect((await status(page, t)).label).not.toBe('Ждёт ответа');
  await signal(page, { id, state: 'busy' });
  expect(await inboxItems(page)).toEqual([]);
  await signal(page, { id, state: 'done' });
  await expect.poll(() => status(page, t), { timeout: 5000 }).toMatchObject({ label: 'Готово', kind: 'idle' });
});

test('терминал на закрытом холсте сообщил, что закончил: запись в «Ждут вас» с холстом', async ({ app, page }) => {
  const first = await page.evaluate(() => window.__app.canvas.doc.id);
  const other = await page.evaluate(async () => { const { state } = await import('/js/state.js'); return (await state.createCanvas(state.project.id, 'Ночные')).id; });
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'codex', title: 'Codex: миграция' } });
  await expect.poll(() => ptyOf(app, t)).toBeTruthy();
  const id = await ptyOf(app, t);
  await page.evaluate(async () => (await import('/js/state.js')).state.flushAll());
  await page.evaluate(async (id) => { const { state } = await import('/js/state.js'); await state.openCanvas(state.project.id, id); }, first);
  await signal(page, { id, state: 'done', message: 'Agent turn complete', nodeId: t, docId: other });
  await expect.poll(() => inboxItems(page)).toEqual([{ title: 'Codex: миграция', kind: 'done', text: 'Agent turn complete', type: 'terminal' }]);
  await page.keyboard.press('Control+j');
  await expect.poll(() => page.evaluate(() => window.__app.canvas.doc.id)).toBe(other);
  await expect.poll(() => app.selection()).toEqual([t]);
});

test('агент без сигналов (оболочка) — по-старому, по тексту на экране', async ({ app, page }) => {
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'shell' } });
  await expect.poll(() => ptyOf(app, t)).toBeTruthy();
  await expect.poll(() => status(page, t).then((s) => s.label), { timeout: 6000 }).toBe('Ожидает');
});

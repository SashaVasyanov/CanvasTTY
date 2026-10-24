// Claude Code / Codex in a terminal window keep their own session (renderer/js/nodes.js
// TerminalInstance, node.data.agentSession): Claude starts with a known id, Codex's id is found
// after the start; after a restart the window continues exactly that session. The main process
// side (arguments, session files) is in tests/unit/termsessions.test.mjs, the real CLIs in a real
// pty in tests/electron/terminal.spec.mjs. Here the mock records the starts (window.__ptySpawns).
import { test, expect } from './fixtures.mjs';
import { addAgentChat } from './helpers/chat.mjs';
import { reloadApp } from './helpers/notes.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const spawns = (page) => page.evaluate(() => window.__ptySpawns || []);
const own = async (app, id) => (await app.node(id)).data.agentSession;
const flush = (page) => page.evaluate(async () => (await import('/js/state.js')).state.saveDoc.flush());
// a restart: the pty sessions are gone; `existing` — the session ids that have files on disk
async function restart(page, existing = [], settings = {}) {
  await flush(page);
  await page.addInitScript(([ids]) => { window.__mockSessions = ids; }, [existing]);
  if (Object.keys(settings).length) await page.evaluate(async (s) => { const { state } = await import('/js/state.js'); for (const [k, v] of Object.entries(s)) state.setSetting(k, v); await state.flushAll(); }, settings);
  await reloadApp(page);
}

test('Claude Code: своя сессия при запуске; после перезапуска окно само продолжает именно её', async ({ app, page }) => {
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'claude' } });
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  const [first] = await spawns(page);
  expect(first.session).toMatchObject({ kind: 'claude', resume: false });
  expect(first.session.id).toMatch(UUID);
  expect(first.args).toEqual([]);
  expect((await own(app, t)).id).toBe(first.session.id);
  // a second Claude in the same folder has a session of its own
  await app.add('terminal', { x: 700, y: 0, w: 600, h: 300, data: { agentId: 'claude' } });
  await expect.poll(async () => (await spawns(page)).length).toBe(2);
  expect((await spawns(page))[1].session.id).not.toBe(first.session.id);

  await restart(page, [first.session.id]);
  await expect.poll(async () => (await spawns(page)).find((s) => s.session?.resume)?.session.id).toBe(first.session.id);
  await expect(page.locator(`.node[data-id="${t}"] .xterm-rows`)).toContainText('продолжаю прошлую сессию агента');
  await expect(page.locator(`.node[data-id="${t}"] .term-banner`)).toBeHidden();
  expect((await own(app, t)).id).toBe(first.session.id);
});

test('Codex: id сессии находится после запуска; после перезапуска — resume именно её', async ({ app, page }) => {
  const id = 'cccccccc-dddd-4eee-8fff-000000000000';
  await page.evaluate((id) => { window.__mockCodexFind = id; }, id);
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'codex' } });
  await expect.poll(async () => (await spawns(page))[0]?.session).toEqual({ kind: 'codex', id: null, resume: false });
  await expect.poll(async () => (await own(app, t))?.id, { timeout: 8000 }).toBe(id);
  await restart(page, [id]);
  await expect.poll(async () => (await spawns(page)).at(-1)?.session).toEqual({ kind: 'codex', id, resume: true });
});

test('настройка выключена — кнопки; сессия без сообщений — новая с тем же id; агент вышел сам — не продолжается сам', async ({ app, page }) => {
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'claude' } });
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  const sid = (await own(app, t)).id;

  await restart(page, [sid], { resumeAgents: false });
  const banner = page.locator(`.node[data-id="${t}"] .term-banner`);
  await expect(banner).toContainText('Сессия не запущена');
  expect(await spawns(page)).toEqual([]);
  await banner.locator('button', { hasText: 'Продолжить прошлую сессию' }).click();
  await expect.poll(async () => (await spawns(page))[0]?.session).toEqual({ kind: 'claude', id: sid, resume: true });

  // the session never got a message (no file): nothing is continued by itself; the button starts it anew with the same id
  await restart(page, [], { resumeAgents: true });
  await expect(banner).toContainText('Сессия не запущена');
  await banner.locator('button', { hasText: 'Продолжить прошлую сессию' }).click();
  await expect.poll(async () => (await spawns(page))[0]?.session).toEqual({ kind: 'claude', id: sid, resume: false });

  // the agent quit by itself: after a restart it is not started again on its own
  await page.evaluate((id) => { const v = window.__app.canvas.views.get(id).inst; v.onExit(0); }, t);
  await restart(page, [sid]);
  await expect(banner).toContainText('Сессия не запущена');
  expect(await spawns(page)).toEqual([]);
});

test('оболочка без агента и свои аргументы с --continue — без своей сессии; «Открыть эту сессию в терминале» из чата', async ({ app, page }) => {
  await app.add('terminal', { x: 0, y: 0, w: 600, h: 300, data: { agentId: 'shell' } });
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  expect((await spawns(page))[0].session).toBeNull();
  await app.add('terminal', { x: 0, y: 400, w: 600, h: 300, data: { agentId: 'claude', extraArgs: '--continue' } });
  await expect.poll(async () => (await spawns(page)).length).toBe(2);
  expect((await spawns(page))[1]).toMatchObject({ args: ['--continue'], session: null });

  const chatSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await page.evaluate((id) => { window.__mockSessions = [id]; }, chatSid);
  const c = await addAgentChat(app, { x: 800, y: 0, data: { agentId: 'claude', kind: 'claude', sessionId: chatSid, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] } });
  await page.evaluate((id) => { const c = window.__app.canvas; const r = document.querySelector(`.node[data-id="${id}"]`).getBoundingClientRect(); c.nodeMenu(c.node(id), r.left + 20, r.top + 20); }, c);
  await page.locator('.menu:not(.sub) .menu-item', { hasText: 'Открыть эту сессию в терминале' }).click();
  await expect.poll(async () => (await spawns(page)).length).toBe(3);
  expect((await spawns(page))[2]).toMatchObject({ cmd: 'claude', args: [], session: { kind: 'claude', id: chatSid, resume: true } });
});

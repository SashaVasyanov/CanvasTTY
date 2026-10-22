// Helpers for the tests of AI chat windows (agent chats and API chats).
//
// Runs are not simulated by the mock's timers: recordAgentRuns / recordApiChats replace the run
// calls with recorders, and the test itself emits the events main/agentchat.js and main/chat.js
// would send (emitAgent / emitApi). That keeps every step of a streaming answer deterministic.
import { expect } from '../fixtures.mjs';

// a 1×1 PNG, for file inputs (no files on disk, so the tests run the same on every OS)
export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ---------------- windows ----------------
// While the view pans or zooms (and ~160 ms after) objects ignore the mouse; raw page.mouse
// clicks must wait for that (locator clicks wait by themselves).
export const idle = (page) => expect(page.locator('.canvas-root')).not.toHaveClass(/vp-moving/);

// a Codex chat window (not selected); returns its id
export async function addAgentChat(app, { x = 450, y = 0, w = 560, h = 640, data = {} } = {}) {
  const id = await app.add('agentchat', { x, y, w, h, data: { agentId: 'codex', kind: 'codex', ...data } });
  await idle(app.page);
  return id;
}
// an API chat window (OpenAI by default); returns its id
export async function addApiChat(app, { x = 450, y = 0, w = 460, h = 560, data = {} } = {}) {
  const id = await app.add('chat', { x, y, w, h, data: { provider: 'openai', ...data } });
  await idle(app.page);
  return id;
}

// the parts of one chat window
export function chat(app, id) {
  const el = app.el(id);
  return {
    el,
    input: el.locator('.chat-input'),
    send: el.locator('.chat-send'),
    list: el.locator('.chat-list'),
    msgs: el.locator('.chat-list > .msg'),
    userMsgs: el.locator('.chat-list > .msg.user'),
    lastAnswer: el.locator('.chat-list > .msg.assistant').last(),
    chips: el.locator('.att-chip'),
    ctxRow: el.locator('.chat-ctx'),
    ctxChips: el.locator('.chat-ctx .ctx-chip'),
    jump: el.locator('.chat-jump'),
    headStatus: el.locator('.head-status'),
    cardStatus: el.locator('.card-status'),
    fileInput: el.locator('input[type=file]'),
  };
}

export async function sendMessage(c, text) {
  await c.input.click();
  await c.input.fill(text);
  await c.input.press('Enter');
}

// the status of a window: a coloured dot in the header with the label as its tooltip
export async function expectStatus(c, label, kind) {
  await expect(c.headStatus).toHaveAttribute('title', label);
  if (kind) await expect(c.headStatus).toHaveClass(new RegExp(`(^|\\s)${kind}(\\s|$)`));
}

// ---------------- canvas objects ----------------
// a picture object stored inline (data.src) instead of in the vault, with a readable name
export function addSrcImage(app, { x = 0, y = 0, w = 160, h = 110, name = 'Картинка.png', color = '#007aff' } = {}) {
  return app.page.evaluate(({ x, y, w, h, name, color }) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
    return window.__app.canvas.addNode('image', { x, y, w, h, data: { src: cv.toDataURL('image/png'), name } }, { center: false, select: false }).id;
  }, { x, y, w, h, name, color });
}

// a note file in the vault; returns its path
export function vaultNote(page, name, text) {
  return page.evaluate(async ([name, text]) => {
    const { native } = await import('/js/state.js');
    const p = await native.vault.create('', name, text);
    await (await import('/js/vaultIndex.js')).vaultIndex.refresh();
    return p;
  }, [name, text]);
}

export const addEdge = (page, from, to) => page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b), [from, to]);
export const title = (page, id) => page.evaluate(async (id) => { const { titleOf } = await import('/js/context.js'); return titleOf(window.__app.canvas.node(id)); }, id);
export const undoDepth = (page) => page.evaluate(() => window.__app.canvas.undoStack.length);
export async function setZoom(page, z) {
  await page.evaluate((z) => { const c = window.__app.canvas; c.vp.z = z; c.applyViewport(); }, z);
  await idle(page);
}

// a screen point for a world point (for clicks on empty canvas)
export const screenAt = (page, x, y) => page.evaluate(([x, y]) => {
  const c = window.__app.canvas; const r = c.rect();
  return { x: r.left + c.vp.x + x * c.vp.z, y: r.top + c.vp.y + y * c.vp.z };
}, [x, y]);

// ---------------- agent runs (main/agentchat.js) ----------------
export function recordAgentRuns(page) {
  return page.evaluate(async () => {
    const { native } = await import('/js/state.js');
    window.__agentRuns = [];
    window.__agentAborts = [];
    native.agentChat.run = async (o) => { window.__agentRuns.push(JSON.parse(JSON.stringify(o))); return true; };
    // like main/agentchat.js: killing the CLI ends the run with done { aborted: true }
    native.agentChat.abort = async (reqId) => { window.__agentAborts.push(reqId); window.__mockEmit('agentchat:event', { reqId, type: 'done', aborted: true }); };
  });
}
export const agentRuns = (page) => page.evaluate(() => window.__agentRuns);
export const agentAborts = (page) => page.evaluate(() => window.__agentAborts);
// waits until run number i has started and returns what the window sent to the agent
export async function agentRun(page, i = 0) {
  await expect.poll(async () => (await agentRuns(page)).length, { message: `агент запущен (${i + 1}-й раз)` }).toBeGreaterThan(i);
  return (await agentRuns(page))[i];
}
// an event of the latest (or i-th) run
export function emitAgent(page, ev, i = -1) {
  return page.evaluate(([ev, i]) => { const r = window.__agentRuns.at(i); window.__mockEmit('agentchat:event', { reqId: r.reqId, ...ev }); }, [ev, i]);
}

// ---------------- API chat requests (main/chat.js) ----------------
export function recordApiChats(page) {
  return page.evaluate(async () => {
    const { native } = await import('/js/state.js');
    window.__apiRuns = [];
    window.__apiAborts = [];
    native.chat.send = async (o) => { window.__apiRuns.push(JSON.parse(JSON.stringify(o))); return true; };
    native.chat.abort = async (reqId) => { window.__apiAborts.push(reqId); window.__mockEmit('chat:event', { reqId, type: 'done', aborted: true }); };
  });
}
export const apiRuns = (page) => page.evaluate(() => window.__apiRuns);
export async function apiRun(page, i = 0) {
  await expect.poll(async () => (await apiRuns(page)).length, { message: `запрос к API отправлен (${i + 1}-й раз)` }).toBeGreaterThan(i);
  return (await apiRuns(page))[i];
}
export function emitApi(page, ev, i = -1) {
  return page.evaluate(([ev, i]) => { const r = window.__apiRuns.at(i); window.__mockEmit('chat:event', { reqId: r.reqId, ...ev }); }, [ev, i]);
}

// ---------------- scrolling of the message list ----------------
export const listScroll = (c) => c.list.evaluate((l) => ({ top: Math.round(l.scrollTop), dist: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight), height: l.clientHeight }));
export async function expectAtBottom(c) {
  await expect.poll(async () => (await listScroll(c)).dist, { message: 'список прокручен к последнему сообщению' }).toBeLessThan(5);
}

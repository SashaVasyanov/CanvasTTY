// Background runs of agent chats (main/agentchat.js + main/agent-runner.js): the CLI runs in a
// detached helper that writes a journal, so an answer survives closing the app; a new app instance
// replays the journal (attach). Runs a fake Codex CLI (tests/unit/fixtures/fake-codex.js); on
// Windows through a .cmd shim, like npm-installed CLIs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { AgentChatManager } = require('../../main/agentchat.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-codex.js');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'fake-claude.js');

let tmp, cli, claudeCli, managers;
// npm installs CLIs on Windows as .cmd shims, elsewhere the script itself is executable
function shim(script, name) {
  if (process.platform !== 'win32') { fs.chmodSync(script, 0o755); return script; }
  const p = path.join(tmp, `${name}.cmd`);
  fs.writeFileSync(p, `@"${process.execPath}" "${script}" %*\r\n`);
  return p;
}
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-agent-'));
  cli = shim(FAKE, 'codex');
  claudeCli = shim(FAKE_CLAUDE, 'claude');
  managers = [];
  delete process.env.FAKE_STEPS; delete process.env.FAKE_GAP; delete process.env.FAKE_FAIL;
});
afterEach(async () => {
  for (const m of managers) { for (const r of m.runs.values()) if (!r.closed) m.abort(r.reqId); clearInterval(m.ticker); }
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a manager like the app's, collecting the events it sends to the window
function manager() {
  const events = [];
  const m = new AgentChatManager({ send: (ch, ev) => events.push(ev), ptys: { which: (c) => (c === 'claude' ? claudeCli : cli) }, userData: path.join(tmp, 'userdata'), attachments: null });
  m.events = events;
  managers.push(m);
  return m;
}
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('timeout');
}
const doneOf = (m, reqId) => m.events.find((e) => e.reqId === reqId && e.type === 'done');
const textOf = (m, reqId) => m.events.filter((e) => e.reqId === reqId && e.type === 'delta').map((e) => e.text).join(' ');
const journals = () => { try { return fs.readdirSync(path.join(tmp, 'userdata', 'agent-runs')); } catch { return []; } };
const run = (m, reqId, extra = {}) => m.run({ reqId, kind: 'codex', cmd: 'codex', prompt: 'привет', cwd: tmp, nodeId: 'node-1', docId: 'doc-1', ...extra });

test('ответ приходит из журнала, release удаляет журнал', async () => {
  const m = manager();
  await run(m, 'r1');
  const done = await until(() => doneOf(m, 'r1'));
  assert.equal(done.sessionId, 'thread-1');
  assert.deepEqual(done.usage, { input: 7, output: 3 });
  assert.match(textOf(m, 'r1'), /Часть 1: привет.*Часть 3: привет/);
  assert.equal(journals().length, 1, 'журнал остаётся, пока окно не сохранило ответ');
  assert.equal(m.release('r1'), true);
  assert.equal(journals().length, 0);
});

test('ошибка CLI доходит до окна с текстом из stderr', async () => {
  process.env.FAKE_FAIL = '1';
  const m = manager();
  await run(m, 'r1');
  await until(() => doneOf(m, 'r1'));
  const err = m.events.find((e) => e.type === 'error');
  assert.match(err.message, /401 Unauthorized/);
});

test('«Стоп» завершает агента и сразу заканчивает ответ', async () => {
  process.env.FAKE_STEPS = '40'; process.env.FAKE_GAP = '100';
  const m = manager();
  await run(m, 'r1');
  await until(() => m.events.some((e) => e.type === 'delta'));
  const pid = m.runs.get('r1').pid;
  m.abort('r1');
  const done = await until(() => doneOf(m, 'r1'), 1000); // at once, not when the process has gone
  assert.equal(done.aborted, true);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
});

test('после «перезапуска» приложения ответ восстанавливается из журнала целиком', async () => {
  process.env.FAKE_STEPS = '6'; process.env.FAKE_GAP = '150';
  const first = manager();
  await run(first, 'r1');
  await until(() => first.events.some((e) => e.type === 'delta'));
  first.onQuit(); // the app quits mid-answer: the agent keeps going
  for (const r of first.runs.values()) first.stopFollowing(r);
  await sleep(1500);

  const second = manager(); // the next start of the app
  const info = second.attach({ nodeId: 'node-1', reqId: 'r2' });
  assert.ok(info, 'журнал найден');
  const done = await until(() => doneOf(second, 'r2'));
  assert.ok(!done.interrupted && !done.aborted);
  assert.match(textOf(second, 'r2'), /Часть 1: привет.*Часть 6: привет/);
  assert.equal(second.attach({ nodeId: 'другое окно', reqId: 'r3' }), null);
});

test('если помощник умер (компьютер перезагрузился), ответ помечается как прерванный', async () => {
  process.env.FAKE_STEPS = '50'; process.env.FAKE_GAP = '100';
  const first = manager();
  await run(first, 'r1');
  await until(() => first.events.some((e) => e.type === 'delta'));
  const { pid } = first.runs.get('r1');
  for (const r of first.runs.values()) first.stopFollowing(r);
  if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F']);
  else process.kill(-pid, 'SIGKILL');
  await sleep(300);

  const second = manager();
  assert.ok(second.attach({ nodeId: 'node-1', reqId: 'r2' }));
  const done = await until(() => doneOf(second, 'r2'));
  assert.equal(done.interrupted, true);
  assert.equal(done.sessionId, 'thread-1', 'сессию можно продолжить');
  assert.match(textOf(second, 'r2'), /Часть 1/, 'то, что агент успел написать, сохраняется');
});

test('при выключенной настройке закрытие приложения останавливает агента', async () => {
  process.env.FAKE_STEPS = '50'; process.env.FAKE_GAP = '100';
  const first = manager();
  await run(first, 'r1', { keepRunning: false });
  await until(() => first.events.some((e) => e.type === 'delta'));
  const { pid } = first.runs.get('r1');
  first.onQuit();
  for (const r of first.runs.values()) first.stopFollowing(r);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
  const second = manager();
  second.attach({ nodeId: 'node-1', reqId: 'r2' });
  const done = await until(() => doneOf(second, 'r2'));
  assert.equal(done.interrupted, true);
});

test('Claude Code: ответ готов раньше, чем процесс закрылся — журнал удаляется после выхода', async () => {
  const m = manager();
  await m.run({ reqId: 'c1', kind: 'claude', cmd: 'claude', prompt: 'привет', cwd: tmp, nodeId: 'node-c' });
  const done = await until(() => doneOf(m, 'c1'));
  assert.equal(done.sessionId, 'claude-session-1');
  assert.equal(m.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Привет, это Claude.', 'текст по кусочкам, без повтора из итогового сообщения');
  assert.equal(m.release('c1'), false, 'процесс ещё работает');
  await until(() => journals().length === 0, 5000);
  assert.equal(m.events.filter((e) => e.type === 'done').length, 1, 'ответ завершается один раз');
});

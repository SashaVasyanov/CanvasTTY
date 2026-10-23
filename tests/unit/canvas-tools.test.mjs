// Canvas tools of the agents, main-process side: the MCP server (main/mcp-history.js) started with a
// run's channel and token passes each call to the app over main/canvas-bridge.js; the token decides
// which chat window and canvas the call is about (main/agentchat.js gives each run its own and
// forgets it when the run ends). The renderer side is tested in tests/e2e/canvastools.spec.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { CanvasBridge, call } = require('../../main/canvas-bridge.js');
const { AgentChatManager } = require('../../main/agentchat.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', '..', 'main', 'mcp-history.js');
const FAKE = path.join(here, 'fixtures', 'fake-codex.js');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'fake-claude.js');
const TOKEN = 'a'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, cleanup;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-canvas-')); cleanup = []; delete process.env.FAKE_STEPS; delete process.env.FAKE_GAP; });
afterEach(async () => { for (const f of cleanup.reverse()) await f(); await sleep(200); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

async function bridge(request, resolve = (t) => (t === TOKEN ? { nodeId: 'win-1', docId: 'doc-1', run: t.slice(0, 12) } : null)) {
  const b = new CanvasBridge({ userData: path.join(tmp, 'ud'), resolve, request });
  await new Promise((r) => b.start(r));
  cleanup.push(() => b.stop());
  return b;
}
// the MCP server like Claude Code / Codex start it, with the env the app gives a run
function mcp(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CANVASTTY_USERDATA: path.join(tmp, 'ud'), ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); });
  cleanup.push(() => child.kill());
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 15000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    rpc,
    call: async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { text: r.content[0].text, isError: !!r.isError }; },
  };
}

test('MCP-сервер с каналом запуска: инструменты холста есть, вызов доходит до приложения с окном и холстом этого запуска', async () => {
  const calls = [];
  const b = await bridge(async (target, op, args) => { calls.push([target, op, args]); if (op === 'update_text') throw new Error('Менять можно только объекты, которые вы добавили сами'); return `Стикер добавлен: [st_1]`; });
  const s = mcp({ VT_CANVAS_PIPE: b.path, VT_CANVAS_TOKEN: TOKEN });
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const tools = (await s.rpc('tools/list', {})).result.tools.map((t) => t.name);
  assert.deepEqual(tools, ['search_chats', 'read_chat', 'list_chats', 'canvas_list_objects', 'canvas_read_object', 'canvas_create_sticky', 'canvas_create_note', 'canvas_create_text', 'canvas_create_area', 'canvas_connect', 'canvas_update_text']);
  const r = await s.call('canvas_create_sticky', { text: 'Шаг 1', color: 'green' });
  assert.deepEqual(r, { text: 'Стикер добавлен: [st_1]', isError: false });
  assert.deepEqual(calls, [[{ nodeId: 'win-1', docId: 'doc-1', run: TOKEN.slice(0, 12) }, 'create_sticky', { text: 'Шаг 1', color: 'green' }]]);
  const denied = await s.call('canvas_update_text', { id: 'чужой', text: 'x' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /только объекты, которые вы добавили сами/);
});

test('без канала инструментов холста нет; чужой токен и закрытое приложение — понятная ошибка', async () => {
  const plain = mcp({});
  await plain.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.ok(!(await plain.rpc('tools/list', {})).result.tools.some((t) => t.name.startsWith('canvas_')));

  let asked = 0;
  const b = await bridge(async () => { asked++; return 'ok'; });
  const stranger = mcp({ VT_CANVAS_PIPE: b.path, VT_CANVAS_TOKEN: 'b'.repeat(32) });
  const r = await stranger.call('canvas_list_objects', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /запуск агента уже закончился/);
  assert.equal(asked, 0, 'до окна запрос не дошёл');

  b.stop();
  await assert.rejects(call(b.path, TOKEN, 'list_objects', {}), /VibeTabula закрыт/);
});

// ---------------- tokens of the runs (main/agentchat.js) ----------------
function shim(script, name) {
  if (process.platform !== 'win32') { fs.chmodSync(script, 0o755); return script; }
  const p = path.join(tmp, `${name}.cmd`);
  fs.writeFileSync(p, `@"${process.execPath}" "${script}" %*\r\n`);
  return p;
}
function manager() {
  const cli = shim(FAKE, 'codex'), claude = shim(FAKE_CLAUDE, 'claude');
  const events = [];
  const m = new AgentChatManager({ send: (ch, ev) => events.push(ev), ptys: { which: (c) => (c === 'claude' ? claude : cli) }, userData: path.join(tmp, 'ud'), attachments: null });
  m.events = events;
  m.canvasPipe = 'test-pipe';
  cleanup.push(async () => { for (const r of m.runs.values()) if (!r.closed) m.abort(r.reqId); clearInterval(m.ticker); clearInterval(m.bgTimer); });
  return m;
}
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('timeout');
}
const runJson = (m, reqId) => JSON.parse(fs.readFileSync(path.join(m.runs.get(reqId).dir, 'run.json'), 'utf8'));
const doneOf = (m, reqId) => m.events.find((e) => e.reqId === reqId && e.type === 'done');

test('Codex: у запуска свой токен, он ведёт к окну и холсту, пока агент работает, и после перезапуска приложения', async () => {
  process.env.FAKE_STEPS = '30'; process.env.FAKE_GAP = '100';
  const m = manager();
  await m.run({ reqId: 'r1', kind: 'codex', cmd: 'codex', prompt: 'разложи план', cwd: tmp, nodeId: 'win-1', docId: 'doc-1', canvasTools: true, canvasToken: 'подставной' });
  const token = m.runs.get('r1').meta.opts.canvasToken;
  assert.match(token, /^[a-f0-9]{32}$/, 'токен выдаёт приложение, а не окно');
  const env = runJson(m, 'r1').args.find((a) => a.startsWith('mcp_servers.vibetabula.env='));
  assert.match(env, new RegExp(`VT_CANVAS_PIPE='test-pipe'.*VT_CANVAS_TOKEN='${token}'`));
  assert.deepEqual(m.canvasTarget(token), { nodeId: 'win-1', docId: 'doc-1', run: token.slice(0, 12) });
  assert.equal(m.canvasTarget('c'.repeat(32)), null);

  // the app restarts while the agent works: the token still leads to its window
  for (const r of m.runs.values()) m.stopFollowing(r);
  const second = manager();
  assert.deepEqual(second.canvasTarget(token), { nodeId: 'win-1', docId: 'doc-1', run: token.slice(0, 12) });
  second.attach({ nodeId: 'win-1', reqId: 'r2' });
  await until(() => doneOf(second, 'r2'), 20000);
  await sleep(100);
  assert.equal(second.canvasTarget(token), null, 'запуск закончился — токен больше не действует');

  // without the setting: no token, no canvas tools
  process.env.FAKE_STEPS = '1'; process.env.FAKE_GAP = '20';
  await second.run({ reqId: 'r3', kind: 'codex', cmd: 'codex', prompt: 'привет', cwd: tmp, nodeId: 'win-1', docId: 'doc-1' });
  assert.equal(second.runs.get('r3').meta.opts.canvasToken, undefined);
  assert.doesNotMatch(runJson(second, 'r3').args.join(' '), /VT_CANVAS/);
});

test('Claude Code: свой конфиг MCP с токеном и разрешёнными инструментами холста, удаляется после ответа', async () => {
  const m = manager();
  await m.run({ reqId: 'c1', kind: 'claude', cmd: 'claude', prompt: 'привет', cwd: tmp, nodeId: 'win-2', docId: 'doc-2', canvasTools: true });
  const token = m.runs.get('c1').meta.opts.canvasToken;
  const args = runJson(m, 'c1').args;
  const cfg = args[args.indexOf('--mcp-config') + 1];
  assert.equal(path.basename(cfg), `${token}.json`);
  const server = JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers.vibetabula;
  assert.equal(server.env.VT_CANVAS_TOKEN, token);
  assert.equal(server.env.VT_CANVAS_PIPE, 'test-pipe');
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.includes('mcp__vibetabula__search_chats') && allowed.includes('mcp__vibetabula__canvas_create_sticky') && allowed.includes('mcp__vibetabula__canvas_update_text'));
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /canvas/);
  await until(() => doneOf(m, 'c1'));
  await until(() => !fs.existsSync(cfg), 5000);
  await until(() => m.canvasTarget(token) === null, 5000);
});

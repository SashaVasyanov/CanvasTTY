// Exact statuses of terminal agents from the agents themselves (main/pty.js): the options given to
// Claude Code / Codex, Claude's hooks writing to the events file, Codex's OSC 9 notifications in
// the output. The window side: tests/e2e/terminal-signals.spec.mjs; real CLIs: tests/electron/terminal.spec.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PtyManager, signalArgs, hookEvent, oscEvent, CLAUDE_HOOKS } = require('../../main/pty.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('опции сигналов: Claude — файл настроек с хуками, Codex — уведомления OSC 9; чужим программам — ничего', () => {
  assert.deepEqual(signalArgs('claude', ['--resume', 'x'], { kind: 'claude' }, '/u/hooks.json'), ['--resume', 'x', '--settings', '/u/hooks.json']);
  assert.deepEqual(signalArgs('codex', ['resume', 'x'], { kind: 'codex' }), ['-c', 'tui.notifications=true', '-c', 'tui.notification_method=osc9', 'resume', 'x']);
  assert.deepEqual(signalArgs('kimi', [], { kind: 'claude' }, '/u/h.json'), []);
  assert.deepEqual(signalArgs('claude', [], null, '/u/h.json'), []);
  assert.deepEqual(signalArgs('claude', [], { kind: 'claude', signals: false }, '/u/h.json'), [], 'старая версия: без опций');
  assert.deepEqual(Object.keys(CLAUDE_HOOKS.hooks).sort(), ['Notification', 'Stop', 'UserPromptSubmit']);
});

test('события хуков и уведомления Codex → работает / ждёт ответа / готово', () => {
  assert.deepEqual(hookEvent('prompt {"prompt":"x"}'), { state: 'busy', message: '' });
  assert.deepEqual(hookEvent('stop {}'), { state: 'done', message: '' });
  assert.deepEqual(hookEvent('notify {"message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}'), { state: 'wait', message: 'Claude needs your permission to use Bash' });
  assert.equal(hookEvent('notify {"message":"Claude is waiting for your input"}').state, 'done', 'простаивает = закончил');
  assert.equal(hookEvent('notify {"notification_type":"idle_prompt","message":"x"}').state, 'done');
  assert.equal(hookEvent('notify not-json').state, 'wait');
  assert.equal(hookEvent('other {}'), null);
  assert.deepEqual(oscEvent('Approval requested: rm -rf build'), { state: 'wait', message: 'Approval requested: rm -rf build' });
  assert.equal(oscEvent('Codex wants to edit 3 files').state, 'wait');
  assert.equal(oscEvent('Agent turn complete').state, 'done');
  assert.equal(oscEvent('All tests pass now; approve the PR later').state, 'done', 'слово в тексте ответа — не запрос');
  assert.equal(oscEvent('4;1;50'), null, 'прогресс ConEmu');
});

test('хук настоящим bash дописывает файл событий, менеджер присылает события окну', { skip: process.platform === 'win32' && 'bash на Windows — в Electron-тесте' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-sig-'));
  const sent = [];
  const pm = new PtyManager({ userData: dir, send: (ch, p) => sent.push([ch, p]) });
  const s = { id: 'pty_1', nodeId: 'n1', docId: 'd1' };
  const file = pm.watchEvents(s);
  const run = (ev, input) => execFileSync('bash', ['-c', CLAUDE_HOOKS.hooks[ev][0].hooks[0].command], { input: JSON.stringify(input), env: { ...process.env, VT_AGENT_EVENTS: file } });
  run('UserPromptSubmit', { prompt: 'привет' });
  run('Notification', { message: 'Claude needs your permission to use Bash' });
  run('Stop', {});
  for (let i = 0; i < 30 && sent.length < 3; i++) await sleep(100);
  pm.unwatch(s);
  assert.deepEqual(sent.map(([ch, p]) => [ch, p.state, p.nodeId]), [['pty:agent', 'busy', 'n1'], ['pty:agent', 'wait', 'n1'], ['pty:agent', 'done', 'n1']]);
  assert.equal(s.agentEvent.state, 'done');
  assert.equal(fs.existsSync(file), false, 'файл событий удалён');
  assert.ok(fs.existsSync(pm.hooksFile()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OSC 9 Codex находится и на стыке кусков вывода', () => {
  const sent = [];
  const pm = new PtyManager({ userData: os.tmpdir(), send: (ch, p) => sent.push(p) });
  const s = { id: 'pty_2', osc: '' };
  pm.scanOsc(s, 'вывод\x1b]9;Approval req');
  assert.equal(sent.length, 0);
  pm.scanOsc(s, 'uested: npm i\x07ещё\x1b]9;Agent turn complete\x1b\\');
  assert.deepEqual(sent.map((p) => [p.state, p.message]), [['wait', 'Approval requested: npm i'], ['done', 'Agent turn complete']]);
  assert.equal(s.osc, '');
});

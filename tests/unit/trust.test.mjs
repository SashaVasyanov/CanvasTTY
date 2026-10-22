// Commands from other computers (main/trust.js): a command line that never ran on this computer is
// shown in a native dialog first; approved ones are remembered locally. Electron's dialog is stubbed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const dialogCalls = [];
let answer = async () => ({ response: 0 });
const electron = { dialog: { showMessageBox: (win, opts) => { dialogCalls.push({ win, opts }); return answer(); } } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
const require = createRequire(import.meta.url);
const { Trust } = require('../../main/trust.js');
Module._load = load;

let tmp, win;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-trust-'));
  dialogCalls.length = 0;
  answer = async () => ({ response: 0 });
  win = { destroyed: false, isDestroyed() { return this.destroyed; } };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const trust = () => new Trust({ userData: tmp, getWin: () => win });

test('строка команды: аргументы через пробел, лишние пробелы убираются', () => {
  assert.equal(Trust.line('codex', ['resume', '--last']), 'codex resume --last');
  assert.equal(Trust.line('  claude ', ['', null, '--model   opus']), 'claude --model opus');
  assert.equal(Trust.line('', []), '');
});

test('стандартные агенты и обычный терминал запускаются без вопроса', async () => {
  const t = trust();
  for (const k of ['', 'claude', 'claude --continue', 'codex', 'codex resume --last', 'kimi', 'gemini', 'agentchat:claude', 'agentchat:codex']) {
    assert.equal(await t.ensure(k), true, k);
  }
  assert.equal(dialogCalls.length, 0);
});

test('незнакомая команда: окно с самой командой и папкой; «Разрешить» запоминается на этом компьютере', async () => {
  const t = trust();
  assert.equal(await t.ensure('agentchat:/tmp/evil.sh --flag', { what: 'Окно чата хочет запустить', cwd: '/home/user/proj' }), true);
  assert.equal(dialogCalls.length, 1);
  const { win: parent, opts } = dialogCalls[0];
  assert.equal(parent, win);
  assert.equal(opts.message, 'Окно чата хочет запустить:');
  assert.match(opts.detail, /^\/tmp\/evil\.sh --flag\n\nПапка: \/home\/user\/proj\n/, 'префикс agentchat: не показывается');
  assert.deepEqual(opts.buttons, ['Разрешить', 'Отмена']);
  assert.equal(opts.defaultId, 1, 'по умолчанию — «Отмена»');
  assert.equal(await t.ensure('agentchat:/tmp/evil.sh --flag'), true);
  assert.equal(dialogCalls.length, 1, 'второй раз не спрашивает');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'trusted-commands.json'), 'utf8')), ['agentchat:/tmp/evil.sh --flag']);
  assert.equal(trust().has('agentchat:/tmp/evil.sh --flag'), true, 'после перезапуска тоже разрешена');
});

test('«Отмена», закрытое окно или ошибка диалога — не запускать и не запоминать', async () => {
  const t = trust();
  answer = async () => ({ response: 1 });
  assert.equal(await t.ensure('rm -rf /'), false);
  answer = async () => { throw new Error('окно закрыто'); };
  assert.equal(await t.ensure('rm -rf /'), false);
  assert.equal(t.has('rm -rf /'), false);
  assert.equal(fs.existsSync(path.join(tmp, 'trusted-commands.json')), false);
});

test('одна и та же команда из нескольких окон сразу — один вопрос', async () => {
  const t = trust();
  let release;
  answer = () => new Promise((r) => { release = () => r({ response: 0 }); });
  const a = t.ensure('npm run dev');
  const b = t.ensure('npm run dev');
  await new Promise((r) => setImmediate(r));
  assert.equal(dialogCalls.length, 1);
  release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(t.pending.size, 0);
});

test('окно приложения уже закрыто — диалог без родителя', async () => {
  win.destroyed = true;
  await trust().ensure('make');
  assert.equal(dialogCalls[0].win, undefined);
});

test('команды, вписанные в настройках на этом компьютере, разрешаются без вопроса; хранятся последние 500', async () => {
  const t = trust();
  t.add(['my-agent   --fast', '', '  ']);
  t.add('my-agent --fast');
  assert.equal(await t.ensure('my-agent --fast'), true);
  assert.equal(dialogCalls.length, 0);
  t.add(Array.from({ length: 600 }, (_, i) => `cmd${i}`));
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'trusted-commands.json'), 'utf8'));
  assert.equal(saved.length, 500);
  assert.equal(saved.at(-1), 'cmd599');
});

// The own session of a terminal agent (Claude Code / Codex in a terminal window): the arguments the
// main process adds after the trust check (main/pty.js withSession) and finding the session files
// (main/history.js sessionExists / findCodexSession). The window side: tests/e2e/terminal-resume.spec.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withSession } = require('../../main/pty.js');
const { sessionExists, findCodexSession } = require('../../main/history.js');

const ID = '11111111-2222-4333-8444-555555555555', ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('аргументы сессии: только UUID, только для своей программы, не поверх уже указанной сессии', () => {
  assert.deepEqual(withSession('claude', [], { kind: 'claude', id: ID }), ['--session-id', ID]);
  assert.deepEqual(withSession('C:\\npm\\claude.cmd', ['--model', 'opus'], { kind: 'claude', id: ID, resume: true }), ['--model', 'opus', '--resume', ID]);
  assert.deepEqual(withSession('codex', [], { kind: 'codex', id: ID, resume: true }), ['resume', ID]);
  assert.deepEqual(withSession('codex', [], { kind: 'codex', id: null }), [], 'новая сессия Codex: id он выберет сам');
  assert.deepEqual(withSession('codex', [], { kind: 'codex', id: ID }), [], 'без resume Codex не принимает id');
  assert.deepEqual(withSession('claude', [], { kind: 'claude', id: `${ID}; rm -rf /` }), [], 'не UUID — ничего');
  assert.deepEqual(withSession('claude', [], { kind: 'claude', id: '--dangerously-skip-permissions' }), []);
  assert.deepEqual(withSession('kimi', [], { kind: 'claude', id: ID }), [], 'чужая программа');
  assert.deepEqual(withSession('powershell', [], { kind: 'codex', id: ID, resume: true }), []);
  assert.deepEqual(withSession('claude', ['--continue'], { kind: 'claude', id: ID }), ['--continue'], 'сессия уже указана');
  assert.deepEqual(withSession('claude', [], null), []);
});

let home, oldClaude, oldCodex;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-sess-'));
  oldClaude = process.env.CLAUDE_CONFIG_DIR; oldCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude'); process.env.CODEX_HOME = path.join(home, '.codex');
});
afterEach(() => {
  for (const [k, v] of [['CLAUDE_CONFIG_DIR', oldClaude], ['CODEX_HOME', oldCodex]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});
const codexFile = (id, cwd, at, name = `rollout-2026-10-24T10-00-00-${id}.jsonl`) => {
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '24');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: new Date(at).toISOString() } }) + '\n');
  return f;
};

test('есть ли сессия: файл Claude в любой папке проектов, файл Codex по id в имени', async () => {
  assert.equal(await sessionExists('claude', ID), false);
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-home-u-app'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-home-u-app', `${ID}.jsonl`), '{}\n');
  assert.equal(await sessionExists('claude', ID), true);
  assert.equal(await sessionExists('claude', ID2), false);
  assert.equal(await sessionExists('claude', '../../etc/passwd'), false);
  codexFile(ID2, '/home/u/app', Date.now());
  assert.equal(await sessionExists('codex', ID2), true);
  assert.equal(await sessionExists('codex', ID), false);
  assert.equal(await sessionExists('gemini', ID), false);
});

test('сессия Codex окна: новая в этой папке после запуска; чужие (другие окна, другая папка, старые) — нет', async () => {
  const start = Date.now();
  codexFile(ID, '/home/u/other', start + 100); // another folder
  assert.equal(await findCodexSession({ cwd: '/home/u/app', since: start }), null);
  const old = codexFile(ID2, '/home/u/app', start - 60_000); // started long before this window
  fs.utimesSync(old, new Date(start - 60_000), new Date(start - 60_000));
  assert.equal(await findCodexSession({ cwd: '/home/u/app', since: start }), null);
  const mine = 'cccccccc-dddd-4eee-8fff-000000000000';
  codexFile(mine, '/home/u/app/', start + 500);
  assert.equal(await findCodexSession({ cwd: '/home/u/app', since: start }), mine, 'та же папка, хоть и с косой чертой в конце');
  assert.equal(await findCodexSession({ cwd: '/home/u/app', since: start, exclude: [mine] }), null, 'id другого окна не берётся');
});

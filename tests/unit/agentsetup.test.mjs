// The first start: installed agent CLIs, their versions and sign-in from their own files
// (main/agentsetup.js), with the fake CLIs of tests/electron/bin and a temporary home folder.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { detect, login } = require('../../main/agentsetup.js');
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'bin');
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'FAKE_CLI_NODE', pathKey];
let home, saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-setup-'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.FAKE_CLI_NODE = process.execPath;
  process.env[pathKey] = [BIN, path.dirname(process.execPath), saved[pathKey]].join(path.delimiter);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

test('установленные агенты с версией; вход — по их файлам', async () => {
  let r = await detect();
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.deepEqual(r.map((x) => x.id), ['claude', 'codex', 'gemini', 'kimi']);
  assert.equal(by.claude.found, true);
  assert.equal(by.claude.version, '9.9.9 (fake claude)');
  assert.equal(by.codex.version, '9.9.9 (fake codex)');
  if (process.platform !== 'darwin') assert.equal(by.claude.login, false);
  assert.equal(by.codex.login, false);

  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
  r = await detect();
  assert.deepEqual(r.filter((x) => x.found && ['claude', 'codex'].includes(x.id)).map((x) => [x.id, x.login, x.account]), [['claude', true, 'me@example.com'], ['codex', true, '']]);
});

test('вход по ключу API и «нельзя сказать»', () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  assert.deepEqual(login('claude'), { login: true, account: 'ключ API' });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk' }));
  assert.deepEqual(login('codex'), { login: true, account: 'ключ API' });
  assert.equal(login('gemini').login, null);
  fs.mkdirSync(path.join(home, '.gemini'));
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{}');
  assert.equal(login('gemini').login, true);
  assert.equal(login('kimi').login, null);
});

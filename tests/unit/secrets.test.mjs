// API keys at rest (main/secrets.js): provider keys in workspace.json are encrypted with the OS
// keychain (Electron safeStorage, stubbed here) and decrypted for the renderer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

let available = true, broken = false;
const safeStorage = {
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`secret(${s})`, 'utf8'),
  decryptString: (b) => { if (broken) throw new Error('другой пользователь'); const m = /^secret\((.*)\)$/s.exec(b.toString('utf8')); if (!m) throw new Error('bad'); return m[1]; },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? { safeStorage } : load.call(this, request, ...rest); };
const require = createRequire(import.meta.url);
const { encodeWs, decodeWs } = require('../../main/secrets.js');
Module._load = load;

beforeEach(() => { available = true; broken = false; });
const ws = () => ({ version: 1, projects: [{ id: 'p' }], settings: { theme: 'dark', providers: { openai: { key: 'sk-123', model: 'gpt-5', baseUrl: 'https://x' }, custom: { apiKey: 'k2', token: 't3' }, ollama: { model: 'llama' }, odd: 'строка' } } });

test('ключи шифруются, остальное остаётся как было; исходный объект не меняется', () => {
  const src = ws();
  const enc = encodeWs(src);
  const p = enc.settings.providers;
  assert.match(p.openai.key, /^enc:v1:/);
  assert.equal(Buffer.from(p.openai.key.slice(7), 'base64').toString(), 'secret(sk-123)');
  assert.match(p.custom.apiKey, /^enc:v1:/);
  assert.match(p.custom.token, /^enc:v1:/);
  assert.equal(p.openai.model, 'gpt-5');
  assert.deepEqual(p.ollama, { model: 'llama' });
  assert.equal(p.odd, 'строка');
  assert.equal(enc.settings.theme, 'dark');
  assert.deepEqual(enc.projects, [{ id: 'p' }]);
  assert.equal(src.settings.providers.openai.key, 'sk-123');
  assert.equal(JSON.stringify(enc).includes('sk-123'), false, 'в файле нет ключа открытым текстом');
});

test('расшифровка возвращает ключи; повторное шифрование не шифрует дважды', () => {
  const enc = encodeWs(ws());
  assert.deepEqual(decodeWs(enc), ws());
  assert.deepEqual(encodeWs(enc), enc);
  assert.deepEqual(decodeWs(ws()), ws(), 'старый файл с открытыми ключами читается как есть');
});

test('нет системного хранилища ключей — значения остаются как есть', () => {
  available = false;
  assert.deepEqual(encodeWs(ws()), ws());
});

test('ключ, зашифрованный на другом компьютере или другим пользователем, становится пустым', () => {
  const enc = encodeWs(ws());
  broken = true;
  const dec = decodeWs(enc);
  assert.equal(dec.settings.providers.openai.key, '');
  assert.equal(dec.settings.providers.openai.model, 'gpt-5');
});

test('workspace без провайдеров или без настроек проходит без изменений', () => {
  assert.equal(encodeWs(null), null);
  const noProviders = { settings: { theme: 'light' } };
  assert.equal(encodeWs(noProviders), noProviders);
  assert.deepEqual(decodeWs({ projects: [] }), { projects: [] });
});

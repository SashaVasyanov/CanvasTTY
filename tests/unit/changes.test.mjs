// What an agent changed during one answer and taking it back (main/changes.js), on real temporary
// git repositories: the user's index, branch and other files must stay untouched.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const changes = require('../../main/changes.js');

let repo, bin;
const g = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(repo, f));
const trash = async (abs) => { fs.mkdirSync(bin, { recursive: true }); fs.renameSync(abs, path.join(bin, path.basename(abs))); };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-changes-')));
  bin = path.join(repo, '..', `${path.basename(repo)}-bin`);
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  write('a.txt', 'один\nдва\nтри\n');
  write('c.txt', 'удалю\n');
  write('src/app.js', 'console.log(1);\n');
  write('.gitignore', 'node_modules/\n');
  g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => { for (const d of [repo, bin]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

test('снимок до и после хода: добавленные, изменённые и удалённые файлы со строками', async () => {
  write('wip.txt', 'моя незакоммиченная правка\n'); // already there before the agent: not its change
  const before = await changes.snapshot(path.join(repo, 'src'));
  assert.equal(before.root, repo, 'корень репозитория, даже если агент работает в подпапке');
  write('a.txt', 'один\nДВА\nтри\nчетыре\n');
  write('src/new.js', 'export const x = 1;\n');
  fs.unlinkSync(path.join(repo, 'c.txt'));
  write('node_modules/pkg/index.js', 'ignored');
  const c = await changes.changesSince(before);
  assert.deepEqual(c.files.map((f) => [f.path, f.status, f.add, f.del]).sort(), [['a.txt', 'M', 2, 1], ['c.txt', 'D', 0, 1], ['src/new.js', 'A', 1, 0]]);
  const p = await changes.patch(repo, c.before, c.after, 'a.txt');
  assert.match(p, /^-два$/m); assert.match(p, /^\+ДВА$/m); assert.match(p, /^\+четыре$/m);
});

test('свой индекс, ветка и подготовленные файлы пользователя не меняются', async () => {
  write('staged.txt', 'в индексе\n'); g('add', 'staged.txt');
  const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));
  const headBefore = g('rev-parse', 'HEAD');
  const snap = await changes.snapshot(repo);
  write('a.txt', 'другое\n');
  const c = await changes.changesSince(snap);
  await changes.restore({ root: repo, from: c.before, expect: c.after, files: c.files.map((f) => f.path), trash });
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), indexBefore);
  assert.equal(g('rev-parse', 'HEAD'), headBefore);
  assert.equal(g('diff', '--cached', '--name-only').trim(), 'staged.txt');
});

test('откат возвращает файлы, созданные агентом уходят в корзину; возврат отката', async () => {
  const snap = await changes.snapshot(repo);
  write('a.txt', 'агент\n');
  write('src/new.js', 'новый\n');
  fs.unlinkSync(path.join(repo, 'c.txt'));
  const c = await changes.changesSince(snap);
  const files = c.files.map((f) => f.path);

  const r = await changes.restore({ root: repo, from: c.before, expect: c.after, files, trash });
  assert.deepEqual(r.done.sort(), ['a.txt', 'c.txt', 'src/new.js']);
  assert.deepEqual(r.skipped, []);
  assert.equal(read('a.txt'), 'один\nдва\nтри\n');
  assert.equal(read('c.txt'), 'удалю\n');
  assert.equal(exists('src/new.js'), false);
  assert.equal(fs.readFileSync(path.join(bin, 'new.js'), 'utf8'), 'новый\n', 'новый файл в корзине, а не удалён');

  const back = await changes.restore({ root: repo, from: c.after, expect: c.before, files: r.done, trash });
  assert.deepEqual(back.done.sort(), ['a.txt', 'c.txt', 'src/new.js']);
  assert.equal(read('a.txt'), 'агент\n');
  assert.equal(read('src/new.js'), 'новый\n');
  assert.equal(exists('c.txt'), false);
});

test('файл, который правили после ответа, откат не трогает', async () => {
  const snap = await changes.snapshot(repo);
  write('a.txt', 'агент\n');
  write('src/app.js', 'агент тоже\n');
  const c = await changes.changesSince(snap);
  write('a.txt', 'агент\nи я поправил\n');
  const r = await changes.restore({ root: repo, from: c.before, expect: c.after, files: c.files.map((f) => f.path), trash });
  assert.deepEqual(r.done, ['src/app.js']);
  assert.deepEqual(r.skipped, [{ path: 'a.txt', reason: 'файл изменили после ответа' }]);
  assert.equal(read('a.txt'), 'агент\nи я поправил\n');
});

test('переводы строк Windows (autocrlf) сохраняются при откате', async () => {
  g('config', 'core.autocrlf', 'true');
  write('win.txt', 'a\r\nb\r\n'); g('add', 'win.txt'); g('commit', '-qm', 'win');
  const snap = await changes.snapshot(repo);
  write('win.txt', 'a\r\nB\r\n');
  const c = await changes.changesSince(snap);
  assert.deepEqual(c.files.map((f) => [f.path, f.add, f.del]), [['win.txt', 1, 1]]);
  await changes.restore({ root: repo, from: c.before, expect: c.after, files: ['win.txt'], trash });
  assert.equal(read('win.txt'), 'a\r\nb\r\n');
});

test('ничего не изменилось — пустой список; папка не под git — снимка нет', async () => {
  const snap = await changes.snapshot(repo);
  const c = await changes.changesSince(snap);
  assert.deepEqual(c.files, []);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-plain-'));
  try { assert.equal(await changes.snapshot(plain), null); } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  assert.equal(await changes.snapshot(path.join(repo, 'нет такой папки')), null);
});

test('папка с тысячами неигнорируемых файлов — снимок не делается', async () => {
  for (let i = 0; i < 5100; i++) write(`gen/f${i}.txt`, String(i));
  assert.equal(await changes.snapshot(repo), null);
});

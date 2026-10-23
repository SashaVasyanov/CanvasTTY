// A separate copy of the project for an agent (main/worktrees.js) on real temporary repositories:
// own branch and folder, two agents do not meet, merging only without conflicts and without
// touching the user's uncommitted work, removing with a warning about unsaved changes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wt = require('../../main/worktrees.js');

let base, repo;
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-wt-')));
  repo = path.join(base, 'proj');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'README.md', 'Проект\n');
  write(repo, 'src/app.js', 'let a = 1;\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
});
afterEach(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

test('копия: своя ветка и папка рядом с проектом, агент в той же подпапке', async () => {
  write(repo, 'wip.txt', 'моё незакоммиченное\n');
  const w = await wt.create({ cwd: path.join(repo, 'src'), name: 'Починить логин' });
  assert.match(w.branch, /^vibetabula\/pochinit-login-[0-9a-f]{4}$/);
  assert.equal(path.dirname(path.dirname(w.path)), base);
  assert.equal(path.basename(path.dirname(w.path)), 'proj.worktrees');
  assert.equal(w.cwd, path.join(w.path, 'src'));
  assert.equal(w.baseBranch, 'main');
  assert.equal(read(w.path, 'README.md'), 'Проект\n');
  assert.equal(fs.existsSync(path.join(w.path, 'wip.txt')), false, 'незакоммиченное остаётся в основной папке');
  assert.equal(g(repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'ветка пользователя не меняется');
  assert.deepEqual(await wt.status(w), { exists: true, ahead: 0, dirty: 0, into: 'main', merged: false });
});

test('два агента в одном репозитории не мешают друг другу', async () => {
  const a = await wt.create({ cwd: repo, name: 'агент A' });
  const b = await wt.create({ cwd: repo, name: 'агент B' });
  assert.notEqual(a.path, b.path); assert.notEqual(a.branch, b.branch);
  write(a.path, 'README.md', 'версия A\n');
  write(b.path, 'README.md', 'версия B\n');
  assert.equal(read(repo, 'README.md'), 'Проект\n');
  assert.equal((await wt.status(a)).dirty, 1);
  assert.equal((await wt.status(b)).dirty, 1);
});

test('предпросмотр и вливание: незакоммиченное агента коммитится, ветка пользователя получает изменения', async () => {
  const w = await wt.create({ cwd: repo, name: 'фича' });
  write(w.path, 'src/app.js', 'let a = 2;\n');
  write(w.path, 'src/new.js', 'export {};\n');
  const p = await wt.preview(w);
  assert.deepEqual(p.files.map((f) => [f.path, f.status]).sort(), [['src/app.js', 'M'], ['src/new.js', 'A']]);
  write(repo, 'wip.txt', 'моё\n'); // the user's own uncommitted file in other place: no obstacle
  const r = await wt.merge(w);
  assert.deepEqual(r, { ok: true, into: 'main', commits: 1 });
  assert.equal(read(repo, 'src/app.js'), 'let a = 2;\n');
  assert.equal(read(repo, 'src/new.js'), 'export {};\n');
  assert.equal(read(repo, 'wip.txt'), 'моё\n');
  assert.equal((await wt.status(w)).merged, true);
});

test('конфликт: ничего не влито, основная папка и ветка как были', async () => {
  const w = await wt.create({ cwd: repo, name: 'конфликт' });
  write(w.path, 'README.md', 'агент\n');
  write(repo, 'README.md', 'я\n'); g(repo, 'commit', '-qam', 'моя правка');
  const head = g(repo, 'rev-parse', 'HEAD');
  const r = await wt.merge(w);
  assert.equal(r.ok, false);
  assert.match(r.reason, /конфликтуют/);
  assert.deepEqual(r.files, ['README.md']);
  assert.equal(g(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(read(repo, 'README.md'), 'я\n');
  assert.equal(g(repo, 'status', '--porcelain'), '', 'ни маркеров конфликта, ни незавершённого слияния');
});

test('ваши незакоммиченные правки в тех же файлах: слияние отказывается и ничего не трогает', async () => {
  const w = await wt.create({ cwd: repo, name: 'мешает' });
  write(w.path, 'src/app.js', 'let a = 3;\n');
  write(repo, 'src/app.js', 'let a = 100; // моё\n');
  const r = await wt.merge(w);
  assert.equal(r.ok, false);
  assert.match(r.reason, /незакоммиченные изменения/);
  assert.equal(read(repo, 'src/app.js'), 'let a = 100; // моё\n');
});

test('удаление: с несохранёнными изменениями — предупреждение; влитая ветка удаляется, невлитая остаётся', async () => {
  const w = await wt.create({ cwd: repo, name: 'удалить' });
  write(w.path, 'done.txt', 'закоммичено агентом\n'); g(w.path, 'add', '-A'); g(w.path, 'commit', '-qm', 'agent');
  write(w.path, 'x.txt', 'агент\n');
  const r1 = await wt.remove(w);
  assert.deepEqual(r1, { ok: false, dirty: true, reason: 'В копии есть несохранённые изменения агента.' });
  assert.ok(fs.existsSync(w.path));
  const r2 = await wt.remove(w, { force: true });
  assert.deepEqual(r2, { ok: true, branchKept: true }, 'невлитая ветка с коммитами агента остаётся');
  assert.equal(g(repo, 'branch', '--list', w.branch).replace('*', '').trim(), w.branch);
  assert.equal(fs.existsSync(w.path), false);
  assert.equal(fs.existsSync(path.dirname(w.path)), false, 'пустая папка копий убрана');

  const m = await wt.create({ cwd: repo, name: 'влитая' });
  write(m.path, 'y.txt', 'y\n');
  await wt.merge(m);
  assert.deepEqual(await wt.remove(m), { ok: true, branchKept: false });
  assert.equal(g(repo, 'branch', '--list', m.branch), '');
});

test('не git или без коммитов — понятная ошибка', async () => {
  const plain = path.join(base, 'plain'); fs.mkdirSync(plain);
  await assert.rejects(wt.create({ cwd: plain, name: 'x' }), /не в git-репозитории/);
  const empty = path.join(base, 'empty'); fs.mkdirSync(empty); g(empty, 'init', '-q');
  await assert.rejects(wt.create({ cwd: empty, name: 'x' }), /ни одного коммита/);
});

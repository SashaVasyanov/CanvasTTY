// Commit, pull request and CI checks for what an agent changed (main/gitflow.js), on real temporary
// git repositories with a local "GitHub" remote and the fake GitHub CLI (tests/electron/bin/fake-gh.cjs).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gitflow = require('../../main/gitflow.js');
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'bin');

let tmp, repo, remote, state, oldPath, oldState;
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
const gh = (cfg) => fs.writeFileSync(path.join(state, 'gh.json'), JSON.stringify(cfg));
const ghCalls = () => { try { return fs.readFileSync(path.join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.cli === 'gh'); } catch { return []; } };
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-gitflow-')));
  repo = path.join(tmp, 'repo'); remote = path.join(tmp, 'remote.git'); state = path.join(tmp, 'state');
  fs.mkdirSync(repo); fs.mkdirSync(state);
  g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'core.autocrlf', 'false');
  write('README.md', 'Привет\n');
  write('old.txt', 'старое\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
  g(repo, 'remote', 'add', 'origin', remote);
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  g(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'); // what git clone sets
  oldPath = process.env[pathKey]; oldState = process.env.FAKE_CLI_STATE;
  process.env[pathKey] = [BIN, path.dirname(process.execPath), oldPath].join(path.delimiter);
  process.env.FAKE_CLI_STATE = state;
  process.env.FAKE_CLI_NODE = process.execPath;
});
afterEach(() => {
  process.env[pathKey] = oldPath;
  if (oldState === undefined) delete process.env.FAKE_CLI_STATE; else process.env.FAKE_CLI_STATE = oldState;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('коммит: только файлы ответа (новый, изменённый, удалённый); чужое в индексе остаётся в индексе', async () => {
  write('README.md', 'Привет\nот агента\n');
  write('src/new [1].js', 'x\n'); // brackets: a name, not a pattern
  fs.unlinkSync(path.join(repo, 'old.txt'));
  write('mine.txt', 'моё\n'); g(repo, 'add', 'mine.txt'); // the user's own staged work
  write('wip.txt', 'не трогать\n');
  const r = await gitflow.commit({ root: path.join(repo, 'src'), files: ['README.md', 'src/new [1].js', 'old.txt', '../outside.txt'], message: 'Агент: README и новый модуль' });
  assert.equal(r.branch, 'main');
  assert.equal(r.hash, g(repo, 'rev-parse', '--short', 'HEAD'));
  assert.equal(g(repo, 'log', '-1', '--format=%s'), 'Агент: README и новый модуль');
  assert.deepEqual(g(repo, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\tsrc/new [1].js', 'D\told.txt', 'M\tREADME.md']);
  assert.equal(g(repo, 'diff', '--cached', '--name-only'), 'mine.txt', 'своё в индексе осталось');
  assert.match(g(repo, 'status', '--porcelain'), /\?\? wip\.txt/);

  await assert.rejects(gitflow.commit({ root: repo, files: ['README.md'], message: 'ещё' }), /Нечего коммитить: эти файлы уже в последнем коммите/);
  await assert.rejects(gitflow.commit({ root: repo, files: ['README.md'], message: '  ' }), /сообщение коммита/);
  await assert.rejects(gitflow.commit({ root: tmp, files: ['a'], message: 'x' }), /не в git-репозитории/);
});

test('PR с основной ветки: новая ветка, коммит, push, gh pr create; второй раз — тот же PR', async () => {
  write('README.md', 'Привет\nот агента\n');
  write('wip.txt', 'не трогать\n');
  await assert.rejects(gitflow.pr({ root: repo, title: 'README', commit: { files: ['README.md'], message: 'README' } }), /основной ветке «main» — укажите новую ветку/);
  await assert.rejects(gitflow.pr({ root: repo, title: 'README', branch: 'bad..name', commit: { files: ['README.md'] } }), /Недопустимое имя ветки/);

  const r = await gitflow.pr({ root: repo, title: 'Обновить README', body: 'Сделал агент\nвторая строка & «кавычки» %PATH%', branch: 'agent/readme', commit: { files: ['README.md'], message: 'Обновить README' } });
  assert.deepEqual({ ...r, commit: !!r.commit }, { number: 1, url: 'https://github.com/tester/repo/pull/1', branch: 'agent/readme', base: 'main', existing: false, commit: true });
  assert.equal(g(repo, 'symbolic-ref', '--short', 'HEAD'), 'agent/readme', 'папка на новой ветке');
  assert.equal(g(repo, 'rev-parse', 'main'), g(repo, 'rev-parse', 'HEAD~1'), 'main не тронута');
  assert.equal(g(remote, 'log', '-1', '--format=%s', 'agent/readme'), 'Обновить README', 'ветка на удалённом');
  assert.match(g(repo, 'status', '--porcelain'), /\?\? wip\.txt/, 'незакоммиченное осталось в папке');
  const create = ghCalls().find((c) => c.argv[0] === 'pr' && c.argv[1] === 'create');
  assert.deepEqual(create.argv, ['pr', 'create', '--head', 'agent/readme', '--base', 'main', '--title', 'Обновить README', '--body-file', '-']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'gh-prs.json'), 'utf8'))[0].body, 'Сделал агент\nвторая строка & «кавычки» %PATH%', 'описание через stdin, как есть');

  // the agent fixed something: the next commit goes to the same pull request
  write('README.md', 'Привет\nот агента, исправлено\n');
  const again = await gitflow.pr({ root: repo, title: 'Исправление', commit: { files: ['README.md'], message: 'Исправление' } });
  assert.equal(again.existing, true);
  assert.equal(again.number, 1);
  assert.equal(g(remote, 'log', '-1', '--format=%s', 'agent/readme'), 'Исправление');
  assert.equal(ghCalls().filter((c) => c.argv[1] === 'create').length, 1);

  const i = await gitflow.info(path.join(repo));
  assert.deepEqual({ branch: i.branch, remote: i.remote, defaultBranch: i.defaultBranch, gh: i.gh, pr: i.pr?.number }, { branch: 'agent/readme', remote: 'origin', defaultBranch: 'main', gh: 'ok', pr: 1 });
});

test('без remote и без входа в gh — понятные причины', async () => {
  g(repo, 'remote', 'remove', 'origin');
  await assert.rejects(gitflow.pr({ root: repo, title: 'x', branch: 'b' }), /нет удалённого репозитория/);
  g(repo, 'remote', 'add', 'origin', remote);
  gh({ auth: 'login' });
  await assert.rejects(gitflow.pr({ root: repo, title: 'x', branch: 'b' }), /gh auth login/);
  assert.equal(g(repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'ничего не сделано');
});

test('проверки CI: идут / упали / прошли / нет; логи упавших для агента без служебных колонок', async () => {
  gh({ checks: 'none' });
  assert.deepEqual(await gitflow.checks({ root: repo, number: 1 }), { state: 'none', checks: [] });
  gh({ checks: [{ name: 'test (ubuntu)', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1' }, { name: 'test (windows)', state: 'IN_PROGRESS', bucket: 'pending', link: '' }] });
  assert.equal((await gitflow.checks({ root: repo, number: 1 })).state, 'pending');
  gh({ checks: [{ name: 'test (ubuntu)', state: 'SUCCESS', bucket: 'pass' }, { name: 'test (windows)', state: 'FAILURE', bucket: 'fail', link: 'https://ci/2' }] });
  const r = await gitflow.checks({ root: repo, number: 1 });
  assert.equal(r.state, 'fail');
  assert.deepEqual(r.checks.map((c) => [c.name, c.bucket]), [['test (ubuntu)', 'pass'], ['test (windows)', 'fail']]);
  gh({ checks: [{ name: 'lint', state: 'SUCCESS', bucket: 'pass' }, { name: 'docs', state: 'SKIPPED', bucket: 'skipping' }] });
  assert.equal((await gitflow.checks({ root: repo, number: 1 })).state, 'pass');

  // logs: the failed runs of the newest commit of the PR branch
  fs.writeFileSync(path.join(state, 'gh-prs.json'), JSON.stringify([{ number: 1, headRefName: 'agent/readme', state: 'OPEN' }]));
  gh({ runs: [{ databaseId: 7, conclusion: 'failure', workflowName: 'CI', headSha: 'new' }, { databaseId: 6, conclusion: 'success', workflowName: 'Docs', headSha: 'new' }, { databaseId: 5, conclusion: 'failure', workflowName: 'CI', headSha: 'old' }],
    log: 'test\tRun npm test\t2026-10-24T13:15:00.1234567Z \x1b[31mFAIL\x1b[0m tests/a.test.js\ntest\tRun npm test\t2026-10-24T13:15:01.0000000Z expected 2, got 3\n' });
  assert.equal(await gitflow.failedLogs({ root: repo, number: 1 }), '### CI\nFAIL tests/a.test.js\nexpected 2, got 3');
  assert.deepEqual(ghCalls().filter((c) => c.argv[0] === 'run' && c.argv[1] === 'view').map((c) => c.argv[2]), ['7'], 'только упавший запуск последнего коммита');
});

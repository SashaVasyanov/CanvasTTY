// Fake GitHub CLI (`gh`) for the tests of commit / pull request / CI checks (main/gitflow.js).
// Pull requests it "creates" live in <state>/gh-prs.json; what it answers is set in <state>/gh.json:
//   { auth: 'ok' | 'login', checks: [{ name, state, bucket, link }] | 'none', runs: [...], log: '...' }
// Every call is logged to <state>/calls.jsonl as { cli: 'gh', argv, cwd }.
// <state> is FAKE_CLI_STATE (tests/electron/fixtures.mjs or the unit test), else the OS temp folder.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE = process.env.FAKE_CLI_STATE || os.tmpdir();
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch (e) { return d; } };
const write = (f, v) => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, f), JSON.stringify(v)); };
const arg = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const pick = (o, fields) => (fields ? Object.fromEntries(fields.split(',').map((k) => [k, o[k]])) : o);

function main() {
  const argv = process.argv.slice(2);
  try { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(path.join(STATE, 'calls.jsonl'), JSON.stringify({ cli: 'gh', argv, cwd: process.cwd() }) + '\n'); } catch (e) { /* no log */ }
  const cfg = read('gh.json', {});
  const prs = read('gh-prs.json', []);
  const [a, b] = argv;
  const fail = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exitCode = code; };

  if (a === 'auth' && b === 'status') {
    if ((cfg.auth || 'ok') === 'ok') { process.stdout.write('github.com\n  ✓ Logged in to github.com account tester\n'); return; }
    return fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
  }
  if (a === 'pr' && b === 'create') {
    const n = prs.length + 1;
    const body = arg(argv, '--body-file') === '-' ? fs.readFileSync(0, 'utf8') : arg(argv, '--body');
    const pr = { number: n, url: `https://github.com/tester/repo/pull/${n}`, headRefName: arg(argv, '--head'), baseRefName: arg(argv, '--base'), title: arg(argv, '--title'), body, state: 'OPEN' };
    write('gh-prs.json', [...prs, pr]);
    process.stdout.write(`${pr.url}\n`);
    return;
  }
  if (a === 'pr' && b === 'view') {
    const key = argv[2];
    const pr = prs.find((p) => String(p.number) === key || p.headRefName === key);
    if (!pr) return fail(`no pull requests found for branch "${key}"`);
    process.stdout.write(JSON.stringify(pick(pr, arg(argv, '--json'))) + '\n');
    return;
  }
  if (a === 'pr' && b === 'checks') {
    const list = cfg.checks || 'none';
    if (list === 'none') return fail(`no checks reported on the '${prs[0]?.headRefName || 'x'}' branch`);
    process.stdout.write(JSON.stringify(list.map((c) => pick(c, arg(argv, '--json')))) + '\n');
    if (list.some((c) => c.bucket === 'fail')) process.exitCode = 1; else if (list.some((c) => c.bucket === 'pending')) process.exitCode = 8;
    return;
  }
  if (a === 'run' && b === 'list') {
    process.stdout.write(JSON.stringify(cfg.runs || []) + '\n');
    return;
  }
  if (a === 'run' && b === 'view') {
    process.stdout.write(cfg.log || '');
    return;
  }
  fail(`fake gh: unknown command ${argv.join(' ')}`);
}

main();

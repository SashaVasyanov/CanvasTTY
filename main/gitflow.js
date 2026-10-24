// Commit, push and pull request for what an agent changed during one answer (the «Изменения»
// card), and the CI checks of that pull request — git, and the GitHub CLI `gh` with the user's own
// login (VibeTabula keeps no tokens).
//
//   info(dir)                        → { git, root, branch, remote, defaultBranch, gh: 'ok'|'missing'|'login'|null, pr }
//   commit({ root, files, message }) → { hash, branch }
//       only these files, as they are on disk now; the user's other staged work stays staged
//   pr({ root, title, body, branch, commit })   → { number, url, branch, base, existing, commit }
//       on the default branch a new branch is made first (git switch -c: the working files stay as
//       they are), then the commit (if asked), push, and the pull request — or the open pull
//       request of that branch when there is one
//   checks({ root, number })         → { state: 'none'|'pending'|'pass'|'fail', checks: [{ name, bucket, link }] }
//   failedLogs({ root, number })     → the end of the logs of the failed runs, for the agent
const fs = require('fs');
const path = require('path');
const { git, text, rootOf } = require('./changes');
const { identity } = require('./worktrees');
const { run } = require('./which');

// fail instead of waiting for a password nobody sees
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
const errText = (e) => String(e?.stderr || e?.message || e).trim().split('\n').map((s) => s.trim()).filter(Boolean).slice(-3).join(' ');
const gh = (root, args, timeout = 60_000, input) => run('gh', args, { cwd: root, env: NO_PROMPT, timeout, input });
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function mustRoot(dir) {
  const root = await rootOf(dir);
  if (!root) throw new Error('Папка не в git-репозитории или недоступна на этом компьютере.');
  return root;
}
const branchOf = (root) => text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
const hasBranch = (root, b) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).then(() => true).catch(() => false);

async function ghState(root) {
  const r = await gh(root, ['auth', 'status'], 20_000);
  if (r.missing) return 'missing';
  return r.code === 0 ? 'ok' : 'login';
}
// the open pull request of a branch, or null
async function openPr(root, branch) {
  const r = await gh(root, ['pr', 'view', branch, '--json', 'number,url,state,baseRefName,headRefName'], 30_000);
  const v = r.code === 0 ? json(r.stdout) : null;
  return v && v.state === 'OPEN' && v.number ? { number: v.number, url: v.url, base: v.baseRefName, branch: v.headRefName || branch } : null;
}

async function info(dir) {
  const root = await rootOf(dir);
  if (!root) return { git: false };
  const branch = await branchOf(root);
  const remotes = (await text(root, ['remote']).catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  let defaultBranch = null;
  if (remote) defaultBranch = (await text(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).replace(`${remote}/`, '') || null;
  if (!defaultBranch) for (const b of ['main', 'master']) if (await hasBranch(root, b)) { defaultBranch = b; break; }
  const ghs = remote ? await ghState(root) : null;
  const pr = ghs === 'ok' && branch && branch !== defaultBranch ? await openPr(root, branch) : null;
  return { git: true, root, branch, remote, defaultBranch, gh: ghs, pr };
}

// paths inside the repository, relative, each once
function cleanFiles(root, files) {
  return [...new Set((Array.isArray(files) ? files : []).map(String))].filter((f) => f && !path.isAbsolute(f) && path.resolve(root, f).startsWith(root + path.sep));
}

async function commit({ root: dir, files, message }) {
  const root = await mustRoot(dir);
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Напишите сообщение коммита.');
  const list = cleanFiles(root, files);
  if (!list.length) throw new Error('Нет файлов для коммита.');
  const lit = ['--literal-pathspecs']; // names like [id].js are names, not patterns
  const tracked = new Set(String(await git(root, [...lit, 'ls-files', '-z', '--', ...list])).split('\0').filter(Boolean));
  const fresh = list.filter((f) => !tracked.has(f) && fs.existsSync(path.join(root, f)));
  const paths = list.filter((f) => tracked.has(f) || fresh.includes(f));
  if (!paths.length) throw new Error('Нечего коммитить: этих файлов уже нет.');
  if (fresh.length) await git(root, [...lit, 'add', '--', ...fresh]);
  try {
    await git(root, [...lit, ...(await identity(root)), 'commit', '-q', '--only', '-m', msg, '--', ...paths]);
  } catch (e) {
    if (/nothing to commit|no changes added|nothing added/i.test(`${e.stdout || ''}\n${e.stderr || ''}`)) throw new Error('Нечего коммитить: эти файлы уже в последнем коммите.');
    throw new Error(`Коммит не удался: ${errText(e)}`);
  }
  return { hash: await text(root, ['rev-parse', '--short', 'HEAD']), branch: await branchOf(root) };
}

async function pr({ root: dir, title, body, branch: newBranch, commit: c }) {
  const root = await mustRoot(dir);
  const i = await info(root);
  if (!i.remote) throw new Error('У репозитория нет удалённого репозитория (remote), PR некуда отправить. Добавьте его: git remote add origin <адрес>.');
  if (i.gh === 'missing') throw new Error('Нужен GitHub CLI (gh): установите его с cli.github.com и войдите командой gh auth login.');
  if (i.gh === 'login') throw new Error('GitHub CLI не вошёл в аккаунт: выполните в терминале gh auth login и повторите.');
  let branch = i.branch;
  if (!branch) throw new Error('В папке не выбрана ветка (detached HEAD) — переключитесь на ветку и повторите.');
  const t = String(title || '').trim();
  if (!t) throw new Error('Напишите название PR.');
  if (branch === i.defaultBranch) {
    const nb = String(newBranch || '').trim();
    if (!nb) throw new Error(`Вы на основной ветке «${branch}» — укажите новую ветку для PR.`);
    if (!(await git(root, ['check-ref-format', '--branch', nb]).then(() => true).catch(() => false)) || nb.startsWith('-')) throw new Error(`Недопустимое имя ветки: ${nb}`);
    if (await hasBranch(root, nb)) throw new Error(`Ветка «${nb}» уже есть — выберите другое имя.`);
    await git(root, ['switch', '-c', nb]).catch((e) => { throw new Error(`Не удалось создать ветку: ${errText(e)}`); });
    branch = nb;
  }
  let made = null;
  if (c?.files?.length) {
    try { made = await commit({ root, files: c.files, message: c.message || t }); } catch (e) { if (!/уже в последнем коммите/.test(e.message)) throw e; }
  }
  try { await git(root, ['push', '-u', i.remote, branch], { env: NO_PROMPT }); } catch (e) { throw new Error(`Не удалось отправить ветку «${branch}» на ${i.remote}: ${errText(e)}`); }
  const open = await openPr(root, branch);
  if (open) return { ...open, existing: true, commit: made };
  const base = i.defaultBranch || 'main';
  // the description through stdin: several lines survive any way of starting gh
  const r = await gh(root, ['pr', 'create', '--head', branch, '--base', base, '--title', t, '--body-file', '-'], 120_000, String(body || ''));
  const url = (r.stdout.match(/https?:\/\/\S+\/pull\/\d+/) || [])[0];
  if (r.code !== 0 || !url) throw new Error(`GitHub не создал PR: ${errText({ stderr: r.stderr || r.stdout })}`);
  return { number: Number(/\/pull\/(\d+)/.exec(url)[1]), url, branch, base, existing: false, commit: made };
}

// pass / fail / pending of one check (gh's bucket, or its state for an old gh)
const bucketOf = (s) => (/^(fail|cancel)/i.test(s) || /failure|error|timed_out|cancelled|action_required/i.test(s) ? 'fail' : /^(pass|skipping)/i.test(s) || /success|neutral|skipped/i.test(s) ? 'pass' : 'pending');
async function checks({ root: dir, number }) {
  const root = await mustRoot(dir);
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Нет номера PR.');
  let r = await gh(root, ['pr', 'checks', String(n), '--json', 'name,state,bucket,link,workflow'], 30_000);
  if (r.missing) throw new Error('GitHub CLI (gh) не найден.');
  let list = json(r.stdout);
  if (!Array.isArray(list)) {
    if (/no checks reported/i.test(`${r.stdout}\n${r.stderr}`)) return { state: 'none', checks: [] };
    // an older gh without --json: "name<TAB>state<TAB>elapsed<TAB>link"
    r = await gh(root, ['pr', 'checks', String(n)], 30_000);
    if (/no checks reported/i.test(`${r.stdout}\n${r.stderr}`)) return { state: 'none', checks: [] };
    list = r.stdout.split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 2 && c[0].trim()).map(([name, state, , link]) => ({ name: name.trim(), state, link }));
    if (!list.length && r.code !== 0 && r.code !== 8) throw new Error(`Проверки не прочитаны: ${errText({ stderr: r.stderr })}`);
  }
  const items = list.map((c) => ({ name: String(c.name || c.workflow || 'проверка'), bucket: bucketOf(c.bucket || c.state || ''), link: String(c.link || '') }));
  const state = !items.length ? 'none' : items.some((c) => c.bucket === 'fail') ? 'fail' : items.some((c) => c.bucket === 'pending') ? 'pending' : 'pass';
  return { state, checks: items };
}

const MAX_LOG = 6000;
// "job<TAB>step<TAB>2026-10-24T13:15:00.1234567Z text" → "step: text"
const tidy = (log) => String(log).replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => { const m = /^([^\t]*)\t([^\t]*)\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?(.*)$/.exec(l); return m ? m[3] : l; }).join('\n');
async function failedLogs({ root: dir, number }) {
  const root = await mustRoot(dir);
  const n = Number(number);
  const v = json((await gh(root, ['pr', 'view', String(n), '--json', 'headRefName'], 30_000)).stdout);
  if (!v?.headRefName) return '';
  const runs = json((await gh(root, ['run', 'list', '--branch', v.headRefName, '--json', 'databaseId,conclusion,workflowName,headSha', '--limit', '20'], 30_000)).stdout) || [];
  const sha = runs[0]?.headSha;
  const failed = runs.filter((x) => x.headSha === sha && /failure|timed_out|cancelled|startup_failure/i.test(x.conclusion || '')).slice(0, 3);
  const parts = [];
  for (const x of failed) {
    const o = await gh(root, ['run', 'view', String(x.databaseId), '--log-failed'], 90_000);
    const log = tidy(o.stdout).trim();
    if (log) parts.push(`### ${x.workflowName || 'Проверка'}\n${log.length > MAX_LOG ? `…\n${log.slice(-MAX_LOG)}` : log}`);
  }
  return parts.join('\n\n');
}

module.exports = { info, commit, pr, checks, failedLogs };

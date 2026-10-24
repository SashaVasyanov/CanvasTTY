// A separate copy of the project for one agent chat (git worktree): the agent works on its own
// branch in its own folder, so two agents in one repository never edit the same files, and the
// user's working folder stays as it is until they merge.
//
//   <repo>/                       the user's folder (branch e.g. main)
//   <repo>.worktrees/<name>/      the agent's copy, branch vibetabula/<name>
//
// The copy starts from the last commit (uncommitted work stays in the user's folder). Merging first
// commits what the agent left uncommitted in its copy, checks for conflicts without touching any
// files (git merge-tree), and only then merges into the branch checked out in the user's folder;
// with a conflict or local changes in the way nothing is changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { git, text, rootOf, snapshot, diff } = require('./changes');

// commits need an author; when the user never configured git, VibeTabula signs them
async function identity(cwd) {
  const has = async (k) => { try { return !!(await text(cwd, ['config', k])); } catch { return false; } };
  return (await has('user.name')) && (await has('user.email')) ? [] : ['-c', 'user.name=VibeTabula', '-c', 'user.email=vibetabula@localhost'];
}
const slug = (s) => String(s || 'agent').normalize('NFKD').toLowerCase()
  .replace(/[а-яё]/g, (c) => ({ а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' })[c] ?? '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';

// → { repo, path, cwd, branch, baseBranch, baseCommit }
async function create({ cwd, name }) {
  const repo = await rootOf(cwd);
  if (!repo) throw new Error('Папка агента не в git-репозитории — отдельная копия возможна только для git.');
  const head = await text(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
  if (!head) throw new Error('В репозитории ещё нет ни одного коммита — сделайте первый коммит.');
  const baseBranch = await text(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  const id = crypto.randomBytes(2).toString('hex');
  const base = `${slug(name)}-${id}`;
  const branch = `vibetabula/${base}`;
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`, base);
  await git(repo, ['worktree', 'add', '-b', branch, wt, head]);
  const rel = path.relative(repo, path.resolve(cwd));
  const sub = rel && !rel.startsWith('..') ? path.join(wt, rel) : wt;
  return { repo, path: wt, cwd: fs.existsSync(sub) ? sub : wt, branch, baseBranch, baseCommit: head };
}

// The description of a copy may come with a synced canvas from another computer: act only on a
// folder this repository really has as its worktree on the branch named.
async function known(w) {
  if (!w || typeof w.repo !== 'string' || typeof w.path !== 'string' || typeof w.branch !== 'string' || !/^vibetabula\//.test(w.branch)) return false;
  if (!(await rootOf(w.repo))) return false;
  const list = String(await git(w.repo, ['worktree', 'list', '--porcelain']).catch(() => ''));
  const want = path.resolve(w.path);
  return list.split('\n\n').some((block) => {
    const p = /^worktree (.+)$/m.exec(block)?.[1], b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    return p && path.resolve(p) === want && b === w.branch;
  });
}

// → { exists, ahead: commits of the agent, dirty: files changed in the copy, into: branch of the user's folder }
async function status(w) {
  if (!w?.path || !fs.existsSync(w.path) || !(await known(w))) return { exists: false };
  const into = await text(w.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  const ahead = +(await text(w.path, ['rev-list', '--count', `${w.baseCommit}..HEAD`]).catch(() => '0')) || 0;
  const dirty = String(await git(w.path, ['status', '--porcelain', '-z', '--untracked-files=all']).catch(() => '')).split('\0').filter(Boolean).length;
  // merged: the agent's commits are already in the user's branch
  const merged = ahead > 0 && (await git(w.repo, ['merge-base', '--is-ancestor', w.branch, 'HEAD']).then(() => true).catch(() => false));
  return { exists: true, ahead, dirty, into, merged };
}

// what merging would bring: from the common ancestor to the copy as it is now (uncommitted too);
// the same shape as main/changes.js, for the changes card
async function preview(w) {
  if (!(await known(w))) throw new Error('Копии нет на этом компьютере.');
  const snap = await snapshot(w.path);
  if (!snap) throw new Error('Не удалось прочитать копию.');
  const mb = await text(w.repo, ['merge-base', 'HEAD', w.branch]).catch(() => w.baseCommit);
  const before = await text(w.repo, ['rev-parse', `${mb}^{tree}`]);
  return { root: w.path, before, after: snap.tree, files: before === snap.tree ? [] : await diff(w.path, before, snap.tree) };
}

// → { ok: true, into, commits } | { ok: false, reason, files? }
async function merge(w) {
  if (!w?.path || !fs.existsSync(w.path) || !(await known(w))) return { ok: false, reason: 'Копии нет на этом компьютере.' };
  const into = await text(w.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  if (!into) return { ok: false, reason: 'В основной папке не выбрана ветка (detached HEAD) — переключитесь на ветку и повторите.' };
  // 1. what the agent left uncommitted becomes a commit on its branch
  const dirty = String(await git(w.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0').filter(Boolean).length;
  if (dirty) {
    await git(w.path, ['add', '-A']);
    await git(w.path, [...(await identity(w.path)), 'commit', '-q', '-m', 'VibeTabula: изменения агента']);
  }
  const commits = +(await text(w.repo, ['rev-list', '--count', `HEAD..${w.branch}`])) || 0;
  if (!commits) return { ok: true, into, commits: 0 };
  // 2. conflicts? (no files are touched; git 2.38+)
  let conflicts = null;
  try { await git(w.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', w.branch]); conflicts = []; } catch (e) {
    if (e.code === 1) { conflicts = String(e.stdout || '').split('\n').slice(1).map((s) => s.trim()).filter(Boolean); }
  }
  if (conflicts && conflicts.length) return { ok: false, reason: 'Изменения агента конфликтуют с вашими — ничего не влито.', files: conflicts };
  // 3. merge; git itself refuses when your uncommitted changes are in the way (nothing is touched then)
  try {
    await git(w.repo, [...(await identity(w.repo)), 'merge', '--no-edit', '-m', `Влить ${w.branch} (VibeTabula)`, w.branch]);
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (/CONFLICT/i.test(msg)) { await git(w.repo, ['merge', '--abort']).catch(() => {}); return { ok: false, reason: 'Изменения агента конфликтуют с вашими — ничего не влито.' }; }
    const files = [...msg.matchAll(/^\s+(\S.*)$/gm)].map((m) => m[1].trim()).filter((f) => !/^(Please|Aborting|Merge)/.test(f));
    return { ok: false, reason: 'В основной папке есть ваши незакоммиченные изменения в тех же файлах — закоммитьте или уберите их и повторите.', files };
  }
  return { ok: true, into, commits };
}

// removes the copy; force: also with uncommitted changes in it; the branch goes too when it is
// merged (or dropBranch)
async function remove(w, { force = false, dropBranch = false } = {}) {
  if (!w || typeof w.repo !== 'string' || !(await rootOf(w.repo)) || !/^vibetabula\//.test(String(w.branch))) return { ok: true, branchKept: false };
  if (w.path && fs.existsSync(w.path)) {
    if (!(await known(w))) return { ok: false, reason: 'Эта папка не копия этого репозитория — не трогаю.' };
    try { await git(w.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), w.path]); } catch (e) {
      const msg = String(e.stderr || e.message || '');
      if (/modified or untracked|contains modified|is dirty/i.test(msg)) return { ok: false, dirty: true, reason: 'В копии есть несохранённые изменения агента.' };
      throw e;
    }
  } else {
    await git(w.repo, ['worktree', 'prune']).catch(() => {});
  }
  let branchKept = true;
  const merged = await git(w.repo, ['merge-base', '--is-ancestor', w.branch, 'HEAD']).then(() => true).catch(() => false);
  if (merged || dropBranch) { await git(w.repo, ['branch', '-D', w.branch]).then(() => { branchKept = false; }).catch(() => {}); }
  try { fs.rmdirSync(path.dirname(w.path)); } catch {} // <repo>.worktrees when it is empty
  return { ok: true, branchKept };
}

module.exports = { create, status, preview, merge, remove, slug, identity };

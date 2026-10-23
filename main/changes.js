// What an agent changed in its working folder during one answer, and taking it back.
//
// Before the turn the whole working tree (tracked and new files, .gitignore respected) is written as
// a git tree object through a throw-away index: the user's own index, branch and files are not
// touched. After the turn the same again; `git diff <before> <after>` is exactly what the agent did.
// Rolling back restores those files from the "before" tree with `git restore --worktree` (line-ending
// filters apply), but only files that are still exactly as the agent left them; files the agent
// created go to the recycle bin. Taking the rollback back is the same operation the other way round.
// Only for folders inside a git work tree; elsewhere snapshot() returns null.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_PATCH = 400 * 1024;

function git(cwd, args, { env, maxBuffer = 64 * 1024 * 1024, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(stdout);
    });
    if (input != null) { p.stdin.end(input); }
  });
}
const text = async (cwd, args, o) => String(await git(cwd, args, o)).trim();

// the top folder of the git work tree that contains dir, or null
async function rootOf(dir) {
  try { if (!dir || !fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  try { return path.resolve(await text(dir, ['rev-parse', '--show-toplevel'])); } catch { return null; }
}

// the working tree as a tree object; { root, tree } or null
const MAX_NEW_FILES = 5000, MAX_NEW_BYTES = 200 * 1024 * 1024;
async function snapshot(dir) {
  const root = await rootOf(dir);
  if (!root) return null;
  // a folder full of files git does not ignore (node_modules without .gitignore…) would make the
  // snapshot slow and fill .git with copies: then changes are not tracked
  try {
    const fresh = String(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    if (fresh.length > MAX_NEW_FILES) return null;
    let bytes = 0;
    for (const f of fresh) { try { bytes += fs.statSync(path.join(root, f)).size; } catch {} if (bytes > MAX_NEW_BYTES) return null; }
  } catch { return null; }
  const tmp = path.join(os.tmpdir(), `vibetabula-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    // start from the real index: unchanged files are not hashed again (stat cache)
    try {
      const idx = path.resolve(root, await text(root, ['rev-parse', '--git-path', 'index']));
      if (fs.existsSync(idx)) fs.copyFileSync(idx, tmp);
    } catch {}
    const env = { GIT_INDEX_FILE: tmp };
    await git(root, ['add', '-A', '--', '.'], { env });
    const tree = await text(root, ['write-tree'], { env });
    return { root, tree };
  } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// files that differ between two trees: [{ path, status: 'A'|'M'|'D', add, del, binary }]
async function diff(root, before, after) {
  const z = (b) => String(b).split('\0');
  const ns = z(await git(root, ['diff', '--name-status', '-z', '--no-renames', before, after]));
  const files = new Map();
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) files.set(ns[i + 1], { path: ns[i + 1], status: ns[i][0], add: 0, del: 0, binary: false });
  const num = z(await git(root, ['diff', '--numstat', '-z', '--no-renames', before, after]));
  for (const rec of num) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m || !files.has(m[3])) continue;
    const f = files.get(m[3]);
    if (m[1] === '-') f.binary = true; else { f.add = +m[1]; f.del = +m[2]; }
  }
  return [...files.values()];
}

// what the agent did, in one call: the "after" snapshot and the list
async function changesSince(snap) {
  if (!snap?.root || !snap.tree) return null;
  const now = await snapshot(snap.root);
  if (!now) return null;
  const files = now.tree === snap.tree ? [] : await diff(snap.root, snap.tree, now.tree);
  return { root: snap.root, before: snap.tree, after: now.tree, files };
}

// unified diff of one file (cut at MAX_PATCH)
async function patch(root, before, after, file) {
  const out = await git(root, ['diff', '--no-color', '--no-renames', '--no-ext-diff', before, after, '--', file], { maxBuffer: 32 * 1024 * 1024 });
  const s = out.length > MAX_PATCH ? `${String(out.subarray(0, MAX_PATCH))}\n… (дальше обрезано)` : String(out);
  return s;
}

const inside = (root, file) => { const p = path.resolve(root, file); return p.startsWith(root + path.sep) ? p : null; };
// the blob id of a path in a tree, or null when it is not there
async function blobIn(root, tree, file) {
  try { return await text(root, ['rev-parse', '--verify', '--quiet', `${tree}:${file}`]); } catch { return null; }
}
// the blob id the file on disk would get (clean filters applied), or null when it does not exist
async function blobOnDisk(root, file) {
  const abs = inside(root, file);
  if (!abs || !fs.existsSync(abs)) return null;
  try { return await text(root, ['hash-object', '--', file]); } catch { return null; }
}

// Put files into their state in tree `from`, but only those still exactly as in tree `expect`.
// Rollback: restore({ from: before, expect: after }); taking it back: { from: after, expect: before }.
// trash(abs) moves a file to the recycle bin. → { done: [paths], skipped: [{ path, reason }] }
async function restore({ root, from, expect, files, trash }) {
  root = path.resolve(root);
  if (!(await rootOf(root))) throw new Error('Папка проекта недоступна на этом компьютере.');
  const done = [], skipped = [];
  for (const file of files) {
    const abs = inside(root, file);
    if (!abs) { skipped.push({ path: file, reason: 'вне папки проекта' }); continue; }
    const [want, cur, target] = await Promise.all([blobIn(root, expect, file), blobOnDisk(root, file), blobIn(root, from, file)]);
    if (want !== cur) { skipped.push({ path: file, reason: cur ? 'файл изменили после ответа' : 'файл удалили после ответа' }); continue; }
    try {
      if (target) {
        await git(root, ['restore', `--source=${from}`, '--worktree', '--', file]);
      } else if (cur) {
        if (trash) await trash(abs); else fs.unlinkSync(abs);
      }
      done.push(file);
    } catch (e) { skipped.push({ path: file, reason: String(e.stderr || e.message || e).trim().split('\n')[0] }); }
  }
  return { done, skipped };
}

module.exports = { snapshot, changesSince, diff, patch, restore, rootOf };

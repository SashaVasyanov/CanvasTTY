// The full path of a program on PATH (with the usual install folders GUI apps often miss), like
// `where` / `which`; .cmd shims of npm on Windows count (start them with agentchat.js cliCommand).
const path = require('path');
const fs = require('fs');
const os = require('os');

const isWin = process.platform === 'win32';

function which(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((e) => e.toLowerCase()) : [''];
  if (isWin) {
    // npm global bin is often missing from PATH of GUI apps
    const appdata = process.env.APPDATA;
    if (appdata) dirs.push(path.join(appdata, 'npm'));
    dirs.push(path.join(os.homedir(), '.local', 'bin'));
    dirs.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs'));
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'GitHub CLI'));
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'));
  }
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// the command line for a CLI; npm installs .cmd shims on Windows, which only cmd.exe can start
function cliCommand(resolved, args) {
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    const q = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    const line = [q(resolved), ...args.map(q)].join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file: resolved, args, verbatim: false };
}

// run a program found with which(): → { code, stdout, stderr } (never rejects; code -1: not found / failed to start)
function run(cmd, args, { cwd, env, timeout = 60_000, input } = {}) {
  const { execFile } = require('child_process');
  const resolved = which(cmd);
  if (!resolved) return Promise.resolve({ code: -1, stdout: '', stderr: `${cmd}: не найден`, missing: true });
  const c = cliCommand(resolved, args);
  return new Promise((resolve) => {
    const p = execFile(c.file, c.args, { cwd, env: { ...process.env, ...(env || {}) }, timeout, windowsHide: true, windowsVerbatimArguments: c.verbatim, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '') || '') });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? undefined); // a program that reads stdin must not wait for more
  });
}

module.exports = { which, cliCommand, run };

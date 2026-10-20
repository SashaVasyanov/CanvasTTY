// PTY sessions. On Windows a tiny C# ConPTY bridge is compiled on first run with the
// csc.exe that ships with .NET Framework; on Linux/macOS a python pty bridge is used.
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
// a folder from another computer (synced canvas) may not exist here
const safeCwd = (d) => { try { if (d && require('fs').statSync(d).isDirectory()) return d; } catch {} return os.homedir(); };

const isWin = process.platform === 'win32';
const MAX_SCROLLBACK = 400 * 1024;

class PtyManager {
  constructor({ userData, send }) {
    this.userData = userData;
    this.send = send; // (channel, payload) => void
    this.sessions = new Map();
    this.bridgeReady = null;
    this.seq = 0;
  }

  // ---------- bridge ----------
  async ensureBridge() {
    if (this.bridgeReady) return this.bridgeReady;
    this.bridgeReady = (async () => {
      if (!isWin) {
        return { kind: 'python', path: path.join(__dirname, 'pty', 'ptybridge.py') };
      }
      const binDir = path.join(this.userData, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const src = path.join(__dirname, 'pty', 'ptybridge.cs');
      const srcText = fs.readFileSync(src, 'utf8');
      const hash = require('crypto').createHash('sha1').update(srcText).digest('hex').slice(0, 10);
      const exe = path.join(binDir, `ptybridge-${hash}.exe`);
      if (fs.existsSync(exe)) return { kind: 'exe', path: exe };
      const windir = process.env.WINDIR || 'C:\\Windows';
      const candidates = [
        path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ];
      const csc = candidates.find((c) => fs.existsSync(c));
      if (!csc) throw new Error('Не найден csc.exe (.NET Framework 4). Терминалы недоступны.');
      const srcCopy = path.join(binDir, 'ptybridge.cs');
      fs.writeFileSync(srcCopy, srcText);
      await new Promise((resolve, reject) => {
        execFile(csc, ['/nologo', '/optimize+', '/codepage:65001', '/target:winexe', '/platform:anycpu', `/out:${exe}`, srcCopy],
          { windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(new Error('Ошибка компиляции ConPTY-моста: ' + (stdout || stderr || err.message)));
            else resolve();
          });
      });
      return { kind: 'exe', path: exe };
    })();
    try { return await this.bridgeReady; } catch (e) { this.bridgeReady = null; throw e; }
  }

  // ---------- helpers ----------
  which(cmd) {
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

  defaultShell() {
    if (isWin) {
      const pwsh = this.which('pwsh');
      return pwsh ? 'pwsh.exe' : 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  buildCommandLine(cmd, args) {
    const full = [cmd, ...(args || [])].filter(Boolean).join(' ').trim();
    if (!isWin) return full; // python bridge wraps with $SHELL -lc
    const shell = this.defaultShell();
    if (!full) return `${shell} -NoLogo -ExecutionPolicy Bypass`;
    // Run the agent inside PowerShell so .cmd shims work and the shell stays after the agent exits.
    const escaped = full.replace(/"/g, '\\"');
    return `${shell} -NoLogo -ExecutionPolicy Bypass -NoExit -Command "${escaped}"`;
  }

  // ---------- api ----------
  async spawn({ cmd, args, cwd, cols, rows, env }) {
    const id = `pty_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const session = { id, cmd, buffer: '', exited: false, exitCode: null, lastOutput: 0, proc: null, notFound: false };
    this.sessions.set(id, session);

    if (cmd && !this.which(cmd)) {
      session.notFound = true;
    }

    let bridge;
    try {
      bridge = await this.ensureBridge();
    } catch (e) {
      session.exited = true; session.exitCode = -1; session.error = e.message;
      const msg = `\r\n\x1b[31m${e.message}\x1b[0m\r\n`;
      session.buffer += msg;
      setTimeout(() => { this.send('pty:data', { id, data: msg }); this.send('pty:exit', { id, code: -1, error: e.message }); }, 50);
      return { id, notFound: session.notFound, error: e.message };
    }

    const b64 = (s) => (s ? Buffer.from(s, 'utf8').toString('base64') : '-');
    const cmdLine = this.buildCommandLine(cmd, args);
    const c = Math.max(10, Math.min(500, cols | 0 || 100));
    const r = Math.max(4, Math.min(300, rows | 0 || 30));
    const childEnv = { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'CanvasTTY', ...(env || {}) };
    if (isWin && process.env.APPDATA) {
      const npmBin = path.join(process.env.APPDATA, 'npm');
      if (!(childEnv.PATH || childEnv.Path || '').includes(npmBin)) {
        const key = childEnv.Path !== undefined ? 'Path' : 'PATH';
        childEnv[key] = `${childEnv[key] || ''};${npmBin}`;
      }
    }
    const argv = [String(c), String(r), b64(safeCwd(cwd)), b64(cmdLine)];
    const proc = bridge.kind === 'exe'
      ? spawn(bridge.path, argv, { windowsHide: true, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('python3', [bridge.path, ...argv], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    session.proc = proc;
    const decoder = new (require('string_decoder').StringDecoder)('utf8');

    proc.stdout.on('data', (chunk) => {
      const data = decoder.write(chunk);
      if (!data) return;
      session.lastOutput = Date.now();
      session.buffer += data;
      if (session.buffer.length > MAX_SCROLLBACK) session.buffer = session.buffer.slice(-MAX_SCROLLBACK);
      this.send('pty:data', { id, data });
    });
    proc.stderr.on('data', (chunk) => {
      let data = chunk.toString('utf8').replace(/\n/g, '\r\n');
      if (/xcrun: error|xcode-select/i.test(data)) data += '\r\n[CanvasTTY] Для терминала нужен python3 из Command Line Tools: выполните в Терминале macOS  xcode-select --install\r\n';
      session.buffer += data;
      this.send('pty:data', { id, data: `\x1b[90m${data}\x1b[0m` });
    });
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      session.exited = true; session.exitCode = code;
      this.send('pty:exit', { id, code });
    });
    proc.on('error', (err) => {
      session.exited = true; session.exitCode = -1;
      const hint = !isWin && err.code === 'ENOENT' ? (process.platform === 'darwin' ? '\r\nДля терминала нужен python3: выполните в Терминале macOS  xcode-select --install' : '\r\nДля терминала нужен python3') : '';
      const msg = `\r\n\x1b[31m[CanvasTTY] ${err.message}${hint}\x1b[0m\r\n`;
      session.buffer += msg;
      this.send('pty:data', { id, data: msg });
      this.send('pty:exit', { id, code: -1, error: err.message });
    });
    return { id, notFound: session.notFound };
  }

  frame(type, payload) {
    const h = Buffer.alloc(5);
    h.writeUInt8(type, 0);
    h.writeInt32LE(payload.length, 1);
    return Buffer.concat([h, payload]);
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || s.exited || !s.proc) return;
    try { s.proc.stdin.write(this.frame(0, Buffer.from(data, 'utf8'))); } catch {}
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || s.exited || !s.proc) return;
    const p = Buffer.alloc(4);
    p.writeUInt16LE(Math.max(2, cols | 0), 0);
    p.writeUInt16LE(Math.max(2, rows | 0), 2);
    try { s.proc.stdin.write(this.frame(1, p)); } catch {}
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.proc && !s.exited) {
      try { s.proc.stdin.write(this.frame(2, Buffer.alloc(0))); } catch {}
      setTimeout(() => { try { if (!s.exited) s.proc.kill(); } catch {} }, 800);
    }
    this.sessions.delete(id);
  }

  attach(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { id, buffer: s.buffer, exited: s.exited, exitCode: s.exitCode, lastOutput: s.lastOutput, notFound: s.notFound };
  }

  statuses() {
    const out = {};
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      out[id] = {
        exited: s.exited, exitCode: s.exitCode, notFound: s.notFound,
        busy: !s.exited && now - s.lastOutput < 2500,
        lastOutput: s.lastOutput,
      };
    }
    return out;
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager };

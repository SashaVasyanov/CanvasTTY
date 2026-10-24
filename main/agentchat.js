// Chat windows for CLI agents (like their own desktop apps), driven in non-interactive mode:
//   Claude Code: claude -p --output-format stream-json --verbose [--include-partial-messages] [--resume <id>]
//   Codex:       codex exec --json --skip-git-repo-check [resume <id>]
// The prompt is written to stdin, so no quoting problems. Uses the agent's own login (subscription).
// Every turn runs in a detached helper (agent-runner.js) that writes the CLI's output to a journal
// folder; see "background runs" below.
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const path = require('path');
const os = require('os');
// a folder from another computer (synced canvas) may not exist here
const safeCwd = (d) => { try { if (d && require('fs').statSync(d).isDirectory()) return d; } catch {} return os.homedir(); };
const fs = require('fs');
const crypto = require('crypto');

const isWin = process.platform === 'win32';

const { cliCommand } = require('./which'); // .cmd shims on Windows

// the helper and everything it started (it runs in its own process group on Linux/macOS)
function killTree(pid) {
  if (!pid) return;
  if (isWin) { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v)); } catch {} };
const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const RUNNER = path.join(__dirname, 'agent-runner.js');
const QUIET_CHECKS = 30; // ~30 s of the app's own running time without a heartbeat: the helper is gone
const JOURNAL_DAYS = 7;

function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || (c.type === 'image' ? '[изображение]' : ''))).join('\n');
  return JSON.stringify(content);
}

function toolSummary(name, input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || JSON.stringify(input).slice(0, 200);
}

// The agents get a small MCP server with the user's previous chats (search_chats / read_chat /
// list_chats), so "find it in my old chats" works from a chat window.
const HISTORY_TOOLS = ['mcp__vibetabula__search_chats', 'mcp__vibetabula__read_chat', 'mcp__vibetabula__list_chats'];
const HISTORY_HINT = 'You run inside VibeTabula. Tools mcp__vibetabula__search_chats, read_chat and list_chats search and read the user\'s previous conversations (VibeTabula chats and Claude Code / Codex sessions on this computer). Use them whenever the user refers to an earlier chat.';
// With the setting «Инструменты холста для агентов» the same server also gets canvas tools for
// this run (main/canvas-bridge.js, renderer/js/canvasTools.js); the run's token picks the canvas.
const CANVAS_TOOLS = ['canvas_list_objects', 'canvas_read_object', 'canvas_create_sticky', 'canvas_create_note', 'canvas_create_text', 'canvas_create_area', 'canvas_connect', 'canvas_update_text'].map((t) => `mcp__vibetabula__${t}`);
const CANVAS_HINT = ' Your chat window sits on the user\'s VibeTabula canvas (an infinite whiteboard). Tools mcp__vibetabula__canvas_* list and read its objects and add stickies, notes, text, areas and arrows next to your window. Use them when the user asks to put something on the canvas (a plan, ideas, a breakdown, a diagram) or talks about objects on it; read before you add. You can edit only objects you added and cannot delete anything.';

class AgentChatManager {
  constructor({ send, ptys, userData, attachments }) {
    this.attachments = attachments;
    // 'done' says when the CLI really exited (exit.json): a run replayed after a restart ended
    // long before the window saw it, and «Готово за 2 мин» must not count the time the app was closed
    this.send = (ch, ev) => {
      if (ch === 'agentchat:event' && ev?.type === 'done' && !ev.endedAt) { const r = this.runs.get(ev.reqId); if (r?.endedAt) ev = { ...ev, endedAt: r.endedAt }; }
      send(ch, ev);
    };
    this.ptys = ptys;
    this.userData = userData;
    this.runs = new Map(); // reqId → run (also finished ones, until the renderer releases them)
    this.runsDir = userData ? path.join(userData, 'agent-runs') : null;
    this.canvasPipe = null; // set by main.js once the canvas bridge listens
    this.tokenDirs = new Map(); // canvas token → journal folder of a run the app does not follow
    this.ticker = null;
    // journal folder → state of runs no window follows (see background()); taken now, so a run that
    // finishes in the first seconds after the start is reported too
    this.bgState = new Map(this.background().map((r) => [r.dir, r.state]));
    setTimeout(() => this.prune(), 5000);
    this.bgTimer = setInterval(() => this.checkBackground(), 4000);
    this.bgTimer.unref?.();
  }

  // absolute paths of the files attached to this message
  attachedFiles(opts) {
    return (opts.attachments || []).map((a) => ({ ...a, abs: this.attachments?.pathOf(a.file) })).filter((a) => a.abs && fs.existsSync(a.abs));
  }
  withFiles(prompt, files, hint) {
    if (!files.length) return prompt;
    return `${prompt || 'Посмотри приложенные файлы.'}\n\n${hint}\n${files.map((f) => `- ${f.abs}  (${f.name})`).join('\n')}`;
  }

  canvasOn(opts) { return !!(opts && opts.canvasToken && this.canvasPipe); }
  historyServer(opts = {}) {
    const env = { ELECTRON_RUN_AS_NODE: '1', CANVASTTY_USERDATA: this.userData || '', HOME: os.homedir(), USERPROFILE: os.homedir() };
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    if (this.canvasOn(opts)) { env.VT_CANVAS_PIPE = this.canvasPipe; env.VT_CANVAS_TOKEN = opts.canvasToken; }
    return { command: process.execPath, args: [path.join(__dirname, 'mcp-history.js')], env };
  }
  // a run with canvas tools gets its own config (its token); journal: a replayed run already has it
  claudeMcpConfig(opts = {}, journal = null) {
    if (!this.userData) return null;
    const own = this.canvasOn(opts);
    const file = own ? path.join(this.userData, 'mcp-runs', `${opts.canvasCfg || 'run'}.json`) : path.join(this.userData, 'mcp-vibetabula.json');
    if (journal) return file;
    try {
      if (own) fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { vibetabula: { type: 'stdio', ...this.historyServer(opts) } } }, null, 1));
      return file;
    } catch { return null; }
  }
  // the run is over: its token stops working, its config goes
  dropCanvasToken(opts) {
    const t = opts && opts.canvasToken;
    if (!t || !this.userData) return;
    this.tokenDirs.delete(t);
    if (opts.canvasCfg) { try { fs.unlinkSync(path.join(this.userData, 'mcp-runs', `${opts.canvasCfg}.json`)); } catch {} }
  }
  // the canvas behind a token: the chat window (node) and its canvas (doc) of a run still going
  canvasTarget(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return null;
    const target = (m) => ({ nodeId: m.nodeId, docId: m.docId, run: token.slice(0, 12) });
    for (const run of this.runs.values()) if (!run.closed && run.meta.opts && run.meta.opts.canvasToken === token) return target(run.meta);
    // a run the app does not follow (started before a restart, its window not shown yet)
    let dir = this.tokenDirs.get(token);
    if (!dir && this.runsDir) {
      for (const name of this.journalNames()) {
        const d = path.join(this.runsDir, name);
        const m = readJson(path.join(d, 'meta.json'));
        if (m && m.opts && m.opts.canvasToken === token) { dir = d; this.tokenDirs.set(token, d); break; }
      }
    }
    if (!dir) return null;
    const m = readJson(path.join(dir, 'meta.json'));
    if (!m || !m.nodeId || !m.docId || fs.existsSync(path.join(dir, 'exit.json')) || !pidAlive(m.pid)) return null;
    if ([...this.runs.values()].some((r) => r.dir === dir && r.closed)) return null;
    return target(m);
  }
  codexMcpArgs(approve = true, opts = {}) {
    const srv = this.historyServer(opts);
    const lit = (v) => `'${String(v).replace(/'/g, '')}'`; // TOML literal string
    const env = Object.entries(srv.env).map(([k, v]) => `${k}=${lit(v)}`).join(',');
    // codex exec runs with approval policy "never": a tool that needs approval is cancelled at once.
    // The history tools only read saved chats and the canvas tools only add objects to the canvas
    // (one Ctrl+Z removes them, nothing is deleted), so they are approved up front.
    return ['-c', `mcp_servers.vibetabula.command=${lit(srv.command)}`, '-c', `mcp_servers.vibetabula.args=[${srv.args.map(lit).join(',')}]`, '-c', `mcp_servers.vibetabula.env={${env}}`, ...(approve ? ['-c', `mcp_servers.vibetabula.default_tools_approval_mode='approve'`] : [])];
  }

  // ---------------- background runs ----------------
  // A turn runs in agent-runner.js, started detached: it keeps going when the app is closed or
  // reloaded. The app reads the journal (out.jsonl) while the turn runs. When the chat window
  // shows up again (after a restart or reload) it calls attach(): the journal is replayed from the
  // start through the same parser, so the answer is rebuilt from the agent's own output, and
  // followed further if the agent is still working. Once the renderer has saved the finished
  // answer it calls release() and the journal is deleted; leftovers are pruned after a week.
  spawnRunner(o) {
    if (!this.runsDir) throw new Error('Нет папки для журнала запуска.');
    const dir = path.join(this.runsDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    const f = (n) => path.join(dir, n);
    fs.writeFileSync(f('run.json'), JSON.stringify({ ...o.cmd, cwd: o.cwd }));
    fs.writeFileSync(f('prompt.txt'), o.prompt || '');
    const { reqId: _r, ...opts } = o.opts;
    const meta = { v: 1, reqId: o.reqId, nodeId: opts.nodeId || null, docId: opts.docId || null, kind: o.kind, opts, resolved: o.resolved, flag: o.flag, startedAt: Date.now(), keepRunning: opts.keepRunning !== false };
    const how = { cwd: o.cwd, env: { ...this.env(), ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true };
    // Linux/macOS: a child inherits every descriptor the app left open (Chromium's sockets, the lock
    // files of its storage…); a helper that outlives the app must not hold them, so a shell closes
    // them before it becomes the helper (exec keeps the pid)
    const child = isWin ? spawn(process.execPath, [RUNNER, dir], how)
      : spawn(fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', ['-c', 'for fd in $(ls /dev/fd); do [ "$fd" -gt 2 ] 2>/dev/null && eval "exec $fd>&-" 2>/dev/null; done; exec "$0" "$@"', process.execPath, RUNNER, dir], how);
    meta.pid = child.pid;
    child.on('error', (e) => { try { fs.appendFileSync(f('err.log'), `${e.message}\n`); } catch {} if (!fs.existsSync(f('exit.json'))) writeJson(f('exit.json'), { code: -1, at: Date.now() }); this.checkDir(dir); });
    child.on('exit', () => setTimeout(() => this.checkDir(dir), 30));
    child.unref(); // the app may quit while the agent keeps working
    writeJson(f('meta.json'), meta);
    return { dir, meta };
  }

  // o: { reqId, journal?, kind, opts, resolved, flag, cmd, cwd, prompt, onLine(line), onClose(code, stderr, { lost }) }
  startRun(o) {
    let dir = o.journal, meta;
    if (dir) meta = readJson(path.join(dir, 'meta.json')) || {};
    else {
      const old = this.runs.get(o.reqId); // a retry with other flags replaces the failed attempt
      if (old) { this.stopFollowing(old); this.removeJournal(old.dir); }
      ({ dir, meta } = this.spawnRunner(o));
    }
    const run = { reqId: o.reqId, dir, meta, pid: meta.pid, offset: 0, decoder: new StringDecoder('utf8'), buf: '', checks: 0, quiet: 0, beat: null, timers: [], aborted: !!meta.aborted, closed: false, onLine: o.onLine, onClose: o.onClose };
    this.runs.set(o.reqId, run);
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 250);
    return run;
  }
  stopFollowing(run) { run.stopped = true; for (const t of run.timers) clearInterval(t); }
  removeJournal(dir) { try { if (dir && this.runsDir && dir.startsWith(this.runsDir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  tick() {
    let any = false;
    for (const run of this.runs.values()) {
      if (run.closed || run.stopped) continue;
      any = true;
      this.pump(run);
      if (run.aborted) { this.close(run, null); continue; }
      if (++run.checks % 4 === 0) this.check(run);
    }
    if (!any) { clearInterval(this.ticker); this.ticker = null; }
  }
  // new output of the CLI → whole lines → parser
  pump(run) {
    let fd;
    try { fd = fs.openSync(path.join(run.dir, 'out.jsonl'), 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      while (run.offset < size) {
        const chunk = Buffer.alloc(Math.min(size - run.offset, 1 << 20));
        const n = fs.readSync(fd, chunk, 0, chunk.length, run.offset);
        if (n <= 0) break;
        run.offset += n;
        run.buf += run.decoder.write(chunk.subarray(0, n)); // never splits a multi-byte character
        let i;
        while ((i = run.buf.indexOf('\n')) >= 0) {
          const line = run.buf.slice(0, i).trim(); run.buf = run.buf.slice(i + 1);
          if (line) { try { run.onLine(line); } catch (e) { console.error('agent event', e); } }
        }
      }
    } catch {} finally { try { fs.closeSync(fd); } catch {} }
  }
  checkDir(dir) { for (const run of this.runs.values()) if (run.dir === dir && !run.closed && !run.stopped) { this.pump(run); this.check(run); } }
  // finished (exit.json), or the helper is gone (computer restarted, process killed)
  check(run) {
    const ex = readJson(path.join(run.dir, 'exit.json'));
    if (ex) { this.pump(run); this.close(run, ex.code ?? null); return; }
    const beat = mtimeOf(path.join(run.dir, 'alive'));
    if (beat !== run.beat) { run.beat = beat; run.quiet = 0; } else run.quiet++;
    // counted in checks, not wall time: after the computer wakes up the helper needs a moment too
    if (!pidAlive(run.pid) || run.quiet > QUIET_CHECKS) {
      const late = readJson(path.join(run.dir, 'exit.json'));
      this.pump(run);
      this.close(run, late ? late.code ?? null : null, late ? {} : { lost: true });
    }
  }
  close(run, code, extra = {}) {
    if (run.closed) return;
    run.closed = true;
    run.endedAt = readJson(path.join(run.dir, 'exit.json'))?.at || (extra.lost && mtimeOf(path.join(run.dir, 'alive'))) || Date.now();
    this.dropCanvasToken(run.meta.opts); // a retry (onClose below) writes a new config for its run
    if (run.meta.quit && !run.aborted) extra = { lost: true }; // stopped by quitting the app: broke off
    for (const t of run.timers) clearInterval(t);
    const rest = (run.buf + run.decoder.end()).trim(); run.buf = '';
    if (rest) { try { run.onLine(rest); } catch {} }
    let stderr = '';
    try { stderr = fs.readFileSync(path.join(run.dir, 'err.log'), 'utf8'); } catch {}
    Promise.resolve(run.onClose(code, stderr, extra)).catch((e) => console.error('agent close', e))
      .then(() => { if (run.released && this.runs.get(run.reqId) === run) { this.runs.delete(run.reqId); this.removeJournal(run.dir); } });
  }

  abort(reqId) {
    const run = this.runs.get(reqId);
    if (!run || run.closed) return;
    run.aborted = true;
    run.meta.aborted = true; writeJson(path.join(run.dir, 'meta.json'), run.meta);
    killTree(run.pid);
    this.pump(run);
    this.close(run, null);
  }

  // the chat window is back (app restarted or reloaded): replay its run under a new request id
  attach({ nodeId, reqId } = {}) {
    if (!this.runsDir || !nodeId || !reqId) return null;
    let dir = null;
    for (const [k, run] of this.runs) {
      if (run.meta.nodeId !== nodeId) continue;
      dir = run.dir; this.stopFollowing(run); this.runs.delete(k);
    }
    if (!dir) dir = this.findJournal(nodeId);
    const meta = dir && readJson(path.join(dir, 'meta.json'));
    if (!meta) return null;
    meta.reqId = reqId; writeJson(path.join(dir, 'meta.json'), meta);
    const emit = (type, payload = {}) => this.send('agentchat:event', { reqId, type, ...payload });
    const opts = { ...meta.opts, reqId };
    if (meta.kind === 'codex') this.runCodex(opts, meta.resolved, emit, meta.flag, dir);
    else this.runClaude(opts, meta.resolved, emit, meta.flag, dir);
    return { startedAt: meta.startedAt, running: !fs.existsSync(path.join(dir, 'exit.json')) };
  }
  findJournal(nodeId) {
    let best = null;
    for (const name of this.journalNames()) {
      const dir = path.join(this.runsDir, name);
      const m = readJson(path.join(dir, 'meta.json'));
      if (m && m.nodeId === nodeId && (!best || m.startedAt > best.t)) best = { dir, t: m.startedAt };
    }
    return best && best.dir;
  }
  journalNames() { try { return fs.readdirSync(this.runsDir); } catch { return []; } }
  // the finished answer is saved in the canvas: the journal is no longer needed
  release(reqId) {
    const run = this.runs.get(reqId);
    if (!run) return false;
    // Claude Code reports the result a moment before its process exits: delete once it has
    if (!run.closed) { run.released = true; return false; }
    this.runs.delete(reqId);
    this.removeJournal(run.dir);
    return true;
  }
  prune() {
    const now = Date.now(), live = new Set([...this.runs.values()].map((r) => r.dir));
    for (const name of this.journalNames()) {
      const dir = path.join(this.runsDir, name);
      if (live.has(dir)) continue;
      const ended = mtimeOf(path.join(dir, 'exit.json')) || (!pidAlive(readJson(path.join(dir, 'meta.json'))?.pid) && mtimeOf(path.join(dir, 'alive')));
      const age = now - (ended || mtimeOf(dir) || now);
      if (age > JOURNAL_DAYS * 86400e3) this.removeJournal(dir);
    }
    // configs of runs that ended while the app was closed
    const cfgDir = this.userData && path.join(this.userData, 'mcp-runs');
    let cfgs = [];
    try { cfgs = fs.readdirSync(cfgDir); } catch {}
    for (const name of cfgs) { const f = path.join(cfgDir, name); if (now - (mtimeOf(f) || now) > JOURNAL_DAYS * 86400e3) { try { fs.unlinkSync(f); } catch {} } }
  }
  // Runs no chat window follows right now: their canvas is not open (the app was restarted, or the
  // run was started before a reload). «Ждут вас» shows the finished ones; state is 'running',
  // 'done' (the CLI exited) or 'lost' (the helper is gone without finishing).
  background() {
    const followed = new Set([...this.runs.values()].filter((r) => !r.stopped).map((r) => r.dir));
    const out = [];
    for (const name of this.journalNames()) {
      const dir = path.join(this.runsDir, name);
      if (followed.has(dir)) continue;
      const m = readJson(path.join(dir, 'meta.json'));
      if (!m || !m.nodeId) continue;
      const done = fs.existsSync(path.join(dir, 'exit.json'));
      out.push({ dir, nodeId: m.nodeId, docId: m.docId, kind: m.kind, startedAt: m.startedAt, state: done ? 'done' : pidAlive(m.pid) ? 'running' : 'lost' });
    }
    return out;
  }
  // tell the window when such a run finishes
  checkBackground() {
    if (!this.runsDir) return;
    const now = this.background();
    const before = this.bgState;
    this.bgState = new Map(now.map((r) => [r.dir, r.state]));
    for (const r of now) if (before.get(r.dir) === 'running' && r.state !== 'running') this.send('agentchat:background', { nodeId: r.nodeId, docId: r.docId, state: r.state });
  }

  // the app is quitting: runs keep going unless the user turned that off
  onQuit() {
    for (const run of this.runs.values()) if (!run.closed && run.meta.keepRunning === false) { killTree(run.pid); run.meta.quit = true; writeJson(path.join(run.dir, 'meta.json'), run.meta); }
    clearInterval(this.ticker); this.ticker = null;
    clearInterval(this.bgTimer);
  }

  env() {
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
    if (isWin && process.env.APPDATA) {
      const npmBin = path.join(process.env.APPDATA, 'npm');
      const key = env.Path !== undefined ? 'Path' : 'PATH';
      if (!(env[key] || '').includes(npmBin)) env[key] = `${env[key] || ''};${npmBin}`;
    }
    return env;
  }

  async run(opts) {
    const { reqId } = opts;
    const emit = (type, payload = {}) => this.send('agentchat:event', { reqId, type, ...payload });
    const kind = opts.kind === 'codex' ? 'codex' : 'claude';
    const cmd = String(opts.cmd || kind).trim();
    // values that end up on the command line come from canvas data (possibly synced): no flags, no shell characters
    const ok = (v) => v == null || v === '' || (typeof v === 'string' && /^[\w.:/@\[\]+-]{1,160}$/.test(v) && !v.startsWith('-'));
    for (const k of ['model', 'effort', 'mode', 'sessionId']) if (!ok(opts[k])) { emit('error', { message: `Недопустимое значение «${k}».` }); emit('done', {}); return; }
    if (this.trust && !(await this.trust.ensure(`agentchat:${cmd}`, { what: 'Окно чата хочет запустить программу', cwd: safeCwd(opts.cwd) }))) {
      emit('error', { message: 'Запуск отменён: программа агента не разрешена.' }); emit('done', {}); return;
    }
    opts = { ...opts, kind, cmd };
    delete opts.canvasToken; delete opts.canvasCfg;
    if (opts.canvasTools && opts.nodeId && opts.docId && this.canvasPipe) {
      opts.canvasToken = crypto.randomBytes(16).toString('hex');
      opts.canvasCfg = crypto.randomBytes(8).toString('hex'); // the config's name: not the token
    }
    const resolved = this.ptys.which(cmd);
    if (!resolved) {
      emit('error', { message: `Команда «${cmd || kind}» не найдена. Установите ${kind === 'claude' ? 'Claude Code: npm i -g @anthropic-ai/claude-code' : 'Codex: npm i -g @openai/codex'} и войдите в аккаунт (запустите её один раз в терминале).` });
      emit('done', {});
      return;
    }
    if (kind === 'claude') this.runClaude(opts, resolved, emit, true);
    else this.runCodex(opts, resolved, emit, true);
  }

  // ---------------- Claude Code ----------------
  runClaude(opts, resolved, emit, partial, journal = null) {
    const { reqId, prompt, sessionId, mode, model, cwd } = opts;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (partial) args.push('--include-partial-messages');
    if (mode && mode !== 'default') args.push('--permission-mode', mode);
    if (model) args.push('--model', model);
    if (opts.effort && !opts.noEffort) args.push('--effort', opts.effort);
    if (sessionId) args.push('--resume', sessionId);
    const files = this.attachedFiles(opts);
    if (files.length) args.push('--add-dir', this.attachments.dir);
    const fullPrompt = this.withFiles(prompt, files, 'Пользователь приложил файлы. Открой их инструментом Read (он читает и картинки, и PDF):');
    const mcpFile = !opts.noMcp && this.claudeMcpConfig(opts, journal);
    const canvas = this.canvasOn(opts);
    if (mcpFile) args.push('--mcp-config', mcpFile, '--allowedTools', [...HISTORY_TOOLS, ...(canvas ? CANVAS_TOOLS : [])].join(','), '--append-system-prompt', HISTORY_HINT + (canvas ? CANVAS_HINT : ''));
    let gotOutput = false, streamedThisMsg = false, sid = sessionId || null, finished = false;
    const handle = (j) => {
      gotOutput = true;
      if (j.session_id && j.session_id !== sid) { sid = j.session_id; emit('session', { sessionId: sid }); }
      if (j.type === 'system' && j.subtype === 'init') emit('info', { model: j.model, cwd: j.cwd });
      else if (j.type === 'stream_event' && j.event) {
        const ev = j.event;
        if (ev.type === 'message_start') streamedThisMsg = false;
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta') { streamedThisMsg = true; emit('delta', { text: ev.delta.text }); }
          else if (ev.delta.type === 'thinking_delta') emit('reasoning', { text: ev.delta.thinking });
        }
      } else if (j.type === 'assistant' && j.message) {
        for (const c of j.message.content || []) {
          if (c.type === 'text' && !streamedThisMsg && c.text) emit('delta', { text: c.text });
          else if (c.type === 'tool_use') emit('tool', { id: c.id, name: c.name, input: toolSummary(c.name, c.input) });
        }
        streamedThisMsg = false;
        emit('break');
      } else if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
        for (const c of j.message.content) if (c.type === 'tool_result') emit('toolResult', { id: c.tool_use_id, output: asText(c.content).slice(0, 20000), isError: !!c.is_error });
      } else if (j.type === 'result') {
        finished = true;
        if (j.is_error || (j.subtype && j.subtype !== 'success')) emit('error', { message: asText(j.result) || j.subtype || 'Ошибка' });
        // tools the agent wasn't allowed to run: it now waits for the user to allow them
        if (Array.isArray(j.permission_denials) && j.permission_denials.length) {
          const names = [...new Set(j.permission_denials.map((d) => d.tool_name).filter(Boolean))].join(', ');
          emit('notice', { text: `Агенту не хватило прав${names ? ` (${names})` : ''}. Выберите режим «Доступ» шире и повторите или ответьте ему.`, needsInput: true });
        }
        emit('done', { sessionId: sid, cost: j.total_cost_usd, usage: j.usage ? { input: (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0), output: j.usage.output_tokens || 0 } : null, durationMs: j.duration_ms });
      }
    };
    const onClose = (code, stderr, { lost } = {}) => {
      if (run.aborted) { emit('done', { sessionId: sid, aborted: true }); return; }
      if (lost) { if (!finished) emit('done', { sessionId: sid, interrupted: true }); return; }
      if (!gotOutput && opts.effort && !opts.noEffort && /--effort|effort/i.test(stderr) && /unknown|invalid|error/i.test(stderr)) {
        emit('notice', { text: 'Эта версия Claude Code не поддерживает выбор уровня размышления — используется уровень по умолчанию. Обновите: npm i -g @anthropic-ai/claude-code' });
        this.runClaude({ ...opts, noEffort: true }, resolved, emit, partial); return;
      }
      // a session from another computer (synced chat) or one that was deleted: start a new one
      if (!gotOutput && sessionId && /no conversation found|session.*not found|could not find session|invalid session/i.test(stderr)) {
        emit('notice', { text: 'Прошлая сессия Claude Code на этом компьютере не найдена — начинаю новую.' });
        emit('session', { sessionId: null });
        this.runClaude({ ...opts, sessionId: null }, resolved, emit, partial); return;
      }
      if (!gotOutput && mcpFile && /mcp-config|allowedTools|append-system-prompt|mcp/i.test(stderr) && /unknown|invalid|error/i.test(stderr)) { this.runClaude({ ...opts, noMcp: true }, resolved, emit, partial); return; }
      if (!gotOutput && partial && /include-partial-messages|unknown option/i.test(stderr)) { this.runClaude(opts, resolved, emit, false); return; }
      if (!finished) {
        if (code !== 0) emit('error', { message: (stderr.trim() || `Процесс завершился с кодом ${code}`).slice(-1500), code });
        emit('done', { sessionId: sid });
      }
    };
    const run = this.launch(emit, { reqId, journal, kind: 'claude', opts, resolved, flag: partial, cmd: cliCommand(resolved, args), cwd: safeCwd(cwd), prompt: fullPrompt, onLine: (line) => { try { handle(JSON.parse(line)); } catch { /* non-json noise */ } }, onClose });
  }

  // ---------------- Codex ----------------
  runCodex(opts, resolved, emit, withResume, journal = null) {
    const { reqId, prompt, sessionId, mode, model, cwd } = opts;
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (mode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', mode === 'read' ? 'read-only' : 'workspace-write');
    if (model) args.push('-m', model);
    if (opts.effort) args.push('-c', `model_reasoning_effort=${opts.effort}`);
    if (!opts.noMcp && this.userData) args.push(...this.codexMcpArgs(!opts.noMcpApprove, opts));
    const files = this.attachedFiles(opts);
    const resuming = !!(sessionId && withResume);
    // new sessions get images directly; a resumed session looks at them with view_image
    if (!resuming) for (const f of files) if (f.kind === 'image') args.push('-i', f.abs);
    const fullPrompt = this.withFiles(prompt, resuming ? files : files.filter((f) => f.kind !== 'image'), resuming ? 'Пользователь приложил файлы (картинки можно открыть инструментом view_image):' : 'Пользователь приложил файлы:');
    if (sessionId && withResume) args.push('resume', sessionId);
    let gotOutput = false, sid = (withResume && sessionId) || null, usage = null, failed = false, ended = false;
    // "Reconnecting... 2/5 (stream disconnected …)": Codex lost the connection to OpenAI and retries
    // by itself; only when the retries run out the turn fails (turn.failed)
    const errorOrRetry = (message) => {
      const r = /^Reconnecting\b\D*(\d+)\s*\/\s*(\d+)/i.exec(String(message || ''));
      if (r) { emit('notice', { reconnect: true, text: `Связь с сервером OpenAI прервалась, Codex переподключается (${r[1]} из ${r[2]})…`, detail: String(message) }); return; }
      failed = true; emit('error', { message: message || 'Ошибка' });
    };
    // pictures Codex generates are saved to ~/.codex/generated_images/<session>/: new ones are
    // copied into the chat attachments and shown in the answer
    const genRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
    let since = Date.now() - 3000;
    const seen = new Set(), sizes = new Map();
    const scanImages = async (final = false) => {
      if (!sid || !this.attachments) return;
      const dir = path.join(genRoot, path.basename(String(sid)));
      let names;
      try { names = await fs.promises.readdir(dir); } catch { return; }
      for (const name of names) {
        if (seen.has(name) || !/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
        const abs = path.join(dir, name);
        let st;
        try { st = await fs.promises.stat(abs); } catch { continue; }
        if (!st.isFile() || st.mtimeMs < since) { seen.add(name); continue; } // older pictures of this session
        if (!final && (!st.size || sizes.get(name) !== st.size)) { sizes.set(name, st.size); continue; } // still being written
        seen.add(name);
        try { emit('image', { att: await this.attachments.importPath(abs), path: abs }); } catch {}
      }
    };
    const tool = (item) => {
      if (item.type === 'command_execution') return { name: 'Команда', input: item.command };
      if (item.type === 'file_change') return { name: 'Файлы', input: (item.changes || []).map((c) => `${c.kind || ''} ${c.path}`).join('\n') };
      if (item.type === 'mcp_tool_call') return { name: `MCP ${item.server || ''}`.trim(), input: item.tool || '' };
      if (item.type === 'web_search') return { name: 'Поиск', input: item.query || '' };
      return null;
    };
    const handle = (j) => {
      gotOutput = true;
      // new experimental JSON format
      if (j.type === 'thread.started' && j.thread_id) { sid = j.thread_id; emit('session', { sessionId: sid }); return; }
      if (j.type === 'item.started' && j.item) { const t = tool(j.item); if (t) emit('tool', { id: j.item.id, ...t }); return; }
      if (j.type === 'item.completed' && j.item) {
        const it = j.item;
        if (it.type === 'agent_message') { emit('delta', { text: it.text || '' }); emit('break'); }
        else if (it.type === 'reasoning') emit('reasoning', { text: (it.text || '') + '\n' });
        else if (it.type === 'error') errorOrRetry(it.message);
        else {
          const t = tool(it);
          if (t) {
            emit('tool', { id: it.id, ...t });
            emit('toolResult', { id: it.id, output: (it.aggregated_output || (it.status ? `статус: ${it.status}` : '')).slice(0, 20000), isError: it.exit_code != null ? it.exit_code !== 0 : it.status === 'failed' });
          }
        }
        return;
      }
      if (j.type === 'turn.completed') { ended = true; if (j.usage) usage = { input: j.usage.input_tokens || 0, output: j.usage.output_tokens || 0 }; return; }
      if (j.type === 'turn.failed') { ended = true; failed = true; emit('error', { message: (j.error && j.error.message) || 'Ошибка хода' }); return; }
      if (j.type === 'error') { errorOrRetry(j.message); return; }
      // legacy format {msg:{type,...}}
      const m = j.msg;
      if (!m) return;
      if (m.type === 'session_configured' && m.session_id) { sid = m.session_id; emit('session', { sessionId: sid }); }
      else if (m.type === 'agent_message') { emit('delta', { text: m.message || '' }); emit('break'); }
      else if (m.type === 'agent_reasoning') emit('reasoning', { text: (m.text || '') + '\n' });
      else if (m.type === 'exec_command_begin') emit('tool', { id: m.call_id, name: 'Команда', input: [].concat(m.command || []).join(' ') });
      else if (m.type === 'exec_command_end') emit('toolResult', { id: m.call_id, output: String(m.aggregated_output || m.stdout || m.stderr || '').slice(0, 20000), isError: m.exit_code !== 0 });
      else if (m.type === 'error') errorOrRetry(m.message);
      else if (m.type === 'token_count' && m.info && m.info.last_token_usage) usage = { input: m.info.last_token_usage.input_tokens || 0, output: m.info.last_token_usage.output_tokens || 0 };
    };
    const onClose = async (code, stderr, { lost } = {}) => {
      await scanImages(true).catch(() => {});
      if (run.aborted) { emit('done', { sessionId: sid, aborted: true }); return; }
      if (lost) { emit('done', { sessionId: sid, usage, ...(ended ? {} : { interrupted: true }) }); return; }
      // an older Codex that does not know the approval key: without it first, then without the history tools
      if (!gotOutput && code !== 0 && !opts.noMcp && !opts.noMcpApprove && /default_tools_approval_mode/i.test(stderr)) { this.runCodex({ ...opts, noMcpApprove: true }, resolved, emit, withResume); return; }
      if (!gotOutput && code !== 0 && !opts.noMcp && /mcp_servers|mcp server|invalid.*config|config.*invalid/i.test(stderr)) { this.runCodex({ ...opts, noMcp: true }, resolved, emit, withResume); return; }
      if (!gotOutput && withResume && sessionId && code !== 0) {
        emit('notice', { text: 'Не удалось продолжить прошлую сессию Codex — начинаю новую.' });
        this.runCodex(opts, resolved, emit, false);
        return;
      }
      if (code !== 0 && !failed) emit('error', { message: (stderr.trim() || `Процесс завершился с кодом ${code}`).slice(-1500), code });
      emit('done', { sessionId: sid, usage });
    };
    const run = this.launch(emit, { reqId, journal, kind: 'codex', opts, resolved, flag: withResume, cmd: cliCommand(resolved, args), cwd: safeCwd(cwd), prompt: fullPrompt, onLine: (line) => { if (line[0] === '{') { try { handle(JSON.parse(line)); } catch {} } }, onClose });
    if (!run) return;
    since = (run.meta.startedAt || Date.now()) - 3000; // a replayed run looks for its pictures since it started
    run.timers.push(setInterval(() => { scanImages().catch(() => {}); }, 1500));
  }

  // start (or, with a journal, replay) a run; a failure to start shows up as an error in the chat
  launch(emit, o) {
    try { return this.startRun(o); } catch (e) {
      emit('error', { message: `Не удалось запустить агента: ${e.message}` }); emit('done', {});
      return null;
    }
  }
}

// Defaults configured in the agents' own settings, so the UI can show which model is really used.
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function agentDefaults() {
  const home = os.homedir();
  const out = { claude: {}, codex: {} };
  // Claude Code: ~/.claude/settings.json → "model", "effortLevel"
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  try {
    const j = JSON.parse(readText(path.join(claudeDir, 'settings.json')) || '{}');
    if (j.model) out.claude.model = j.model;
    if (j.effortLevel || j.effort) out.claude.effort = j.effortLevel || j.effort;
  } catch {}
  if (process.env.ANTHROPIC_MODEL) out.claude.model = process.env.ANTHROPIC_MODEL;
  // Codex: ~/.codex/config.toml (top-level keys before the first [section])
  const codexDir = process.env.CODEX_HOME || path.join(home, '.codex');
  const toml = readText(path.join(codexDir, 'config.toml')).split(/^\s*\[/m)[0];
  const tv = (k) => { const m = new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\n#]+)["']?`, 'm').exec(toml); return m ? m[1].trim() : null; };
  if (tv('model')) out.codex.model = tv('model');
  if (tv('model_reasoning_effort')) out.codex.effort = tv('model_reasoning_effort');
  // models Codex has seen (cache files differ between versions — best effort)
  const models = new Set();
  for (const f of ['models_cache.json', 'models.json']) {
    const t = readText(path.join(codexDir, f));
    for (const m of t.matchAll(/"(?:slug|id|model)"\s*:\s*"([^"]+)"/g)) if (/^(gpt|o\d|codex)/i.test(m[1])) models.add(m[1]);
  }
  out.codex.models = [...models].slice(0, 20);
  return out;
}

module.exports = { AgentChatManager, agentDefaults };

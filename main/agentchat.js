// Chat windows for CLI agents (like their own desktop apps), driven in non-interactive mode:
//   Claude Code: claude -p --output-format stream-json --verbose [--include-partial-messages] [--resume <id>]
//   Codex:       codex exec --json --skip-git-repo-check [resume <id>]
// The prompt is written to stdin, so no quoting problems. Uses the agent's own login (subscription).
const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';

function spawnCli(resolved, args, opts) {
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    const q = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    const line = [q(resolved), ...args.map(q)].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true, windowsHide: true });
  }
  return spawn(resolved, args, { ...opts, windowsHide: true });
}

function killTree(proc) {
  if (!proc || proc.exitCode != null) return;
  if (isWin) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { proc.kill('SIGTERM'); } catch {} }
}

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

class AgentChatManager {
  constructor({ send, ptys }) {
    this.send = send;
    this.ptys = ptys;
    this.runs = new Map();
  }

  abort(reqId) {
    const r = this.runs.get(reqId);
    if (r) { r.aborted = true; killTree(r.proc); }
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

  run(opts) {
    const { reqId, kind, cmd } = opts;
    const emit = (type, payload = {}) => this.send('agentchat:event', { reqId, type, ...payload });
    const resolved = this.ptys.which(cmd || kind);
    if (!resolved) {
      emit('error', { message: `Команда «${cmd || kind}» не найдена. Установите ${kind === 'claude' ? 'Claude Code: npm i -g @anthropic-ai/claude-code' : 'Codex: npm i -g @openai/codex'} и войдите в аккаунт (запустите её один раз в терминале).` });
      emit('done', {});
      return;
    }
    if (kind === 'claude') this.runClaude(opts, resolved, emit, true);
    else this.runCodex(opts, resolved, emit, true);
  }

  // ---------------- Claude Code ----------------
  runClaude(opts, resolved, emit, partial) {
    const { reqId, prompt, sessionId, mode, model, cwd } = opts;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (partial) args.push('--include-partial-messages');
    if (mode && mode !== 'default') args.push('--permission-mode', mode);
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    const proc = spawnCli(resolved, args, { cwd: cwd || os.homedir(), env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    const run = { proc, aborted: false };
    this.runs.set(reqId, run);
    let buf = '', stderr = '', gotOutput = false, streamedThisMsg = false, sid = sessionId || null, finished = false;
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
        emit('done', { sessionId: sid, cost: j.total_cost_usd, usage: j.usage ? { input: (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0), output: j.usage.output_tokens || 0 } : null, durationMs: j.duration_ms });
      }
    };
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* non-json noise */ }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (e) => { emit('error', { message: e.message }); emit('done', {}); this.runs.delete(reqId); });
    proc.on('close', (code) => {
      this.runs.delete(reqId);
      if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch {} }
      if (run.aborted) { emit('done', { sessionId: sid, aborted: true }); return; }
      if (!gotOutput && partial && /include-partial-messages|unknown option/i.test(stderr)) { this.runClaude(opts, resolved, emit, false); return; }
      if (!finished) {
        if (code !== 0) emit('error', { message: (stderr.trim() || `Процесс завершился с кодом ${code}`).slice(-1500) });
        emit('done', { sessionId: sid });
      }
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
  }

  // ---------------- Codex ----------------
  runCodex(opts, resolved, emit, withResume) {
    const { reqId, prompt, sessionId, mode, model, cwd } = opts;
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (mode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', mode === 'read' ? 'read-only' : 'workspace-write');
    if (model) args.push('-m', model);
    if (sessionId && withResume) args.push('resume', sessionId);
    const proc = spawnCli(resolved, args, { cwd: cwd || os.homedir(), env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    const run = { proc, aborted: false };
    this.runs.set(reqId, run);
    let buf = '', stderr = '', gotOutput = false, sid = (withResume && sessionId) || null, usage = null, failed = false;
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
        else if (it.type === 'error') emit('error', { message: it.message || 'Ошибка' });
        else {
          const t = tool(it);
          if (t) {
            emit('tool', { id: it.id, ...t });
            emit('toolResult', { id: it.id, output: (it.aggregated_output || (it.status ? `статус: ${it.status}` : '')).slice(0, 20000), isError: it.exit_code != null ? it.exit_code !== 0 : it.status === 'failed' });
          }
        }
        return;
      }
      if (j.type === 'turn.completed') { if (j.usage) usage = { input: j.usage.input_tokens || 0, output: j.usage.output_tokens || 0 }; return; }
      if (j.type === 'turn.failed') { failed = true; emit('error', { message: (j.error && j.error.message) || 'Ошибка хода' }); return; }
      if (j.type === 'error') { failed = true; emit('error', { message: j.message || 'Ошибка' }); return; }
      // legacy format {msg:{type,...}}
      const m = j.msg;
      if (!m) return;
      if (m.type === 'session_configured' && m.session_id) { sid = m.session_id; emit('session', { sessionId: sid }); }
      else if (m.type === 'agent_message') { emit('delta', { text: m.message || '' }); emit('break'); }
      else if (m.type === 'agent_reasoning') emit('reasoning', { text: (m.text || '') + '\n' });
      else if (m.type === 'exec_command_begin') emit('tool', { id: m.call_id, name: 'Команда', input: [].concat(m.command || []).join(' ') });
      else if (m.type === 'exec_command_end') emit('toolResult', { id: m.call_id, output: String(m.aggregated_output || m.stdout || m.stderr || '').slice(0, 20000), isError: m.exit_code !== 0 });
      else if (m.type === 'error') { failed = true; emit('error', { message: m.message }); }
      else if (m.type === 'token_count' && m.info && m.info.last_token_usage) usage = { input: m.info.last_token_usage.input_tokens || 0, output: m.info.last_token_usage.output_tokens || 0 };
    };
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || line[0] !== '{') continue;
        try { handle(JSON.parse(line)); } catch {}
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (e) => { emit('error', { message: e.message }); emit('done', {}); this.runs.delete(reqId); });
    proc.on('close', (code) => {
      this.runs.delete(reqId);
      if (buf.trim().startsWith('{')) { try { handle(JSON.parse(buf.trim())); } catch {} }
      if (run.aborted) { emit('done', { sessionId: sid, aborted: true }); return; }
      if (!gotOutput && withResume && sessionId && code !== 0) {
        emit('notice', { text: 'Не удалось продолжить прошлую сессию Codex — начинаю новую.' });
        this.runCodex(opts, resolved, emit, false);
        return;
      }
      if (code !== 0 && !failed) emit('error', { message: (stderr.trim() || `Процесс завершился с кодом ${code}`).slice(-1500) });
      emit('done', { sessionId: sid, usage });
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
  }
}

module.exports = { AgentChatManager };

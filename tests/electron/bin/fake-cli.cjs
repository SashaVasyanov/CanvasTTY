// Fake Codex / Claude Code CLIs for the Electron tests. They speak the same JSON-lines protocol as
//   codex exec --json …                     (thread.started / item.* / turn.* events)
//   claude -p --output-format stream-json … (system / stream_event / assistant / user / result)
// read the prompt from stdin like the real ones, log every call and answer by a scenario.
//
//   scenario  <state>/scenario.json {"codex": "images", "claude": "denied"} (written by app.scenario()),
//             else FAKE_CODEX_SCENARIO / FAKE_CLAUDE_SCENARIO, else "basic"
//   log       <state>/calls.jsonl, one JSON line per call: cli, argv, cwd, prompt, pid, childPid, scenario
//   gate      waiting scenarios (reconnect, slow) go on once <state>/release-<cli> exists (app.release())
// <state> is FAKE_CLI_STATE (set by tests/electron/fixtures.mjs), else the OS temp folder.
//
// codex:  basic | images | edit | reconnect | fail | crash | slow | stale | old-mcp | mcp
// claude: basic | denied | crash | slow | stale | old | mcp
// "mcp" starts the chat-history MCP server the app passes (claude: --mcp-config file, codex: -c
// mcp_servers.vibetabula.*) and calls search_chats with the user's words, like the agents do.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STATE = process.env.FAKE_CLI_STATE || os.tmpdir();
// 2×2 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEIGBgY/v9nAAA/9AL+Zk6cQQAAAABJRU5ErkJggg==', 'base64');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

function scenarioFor(cli) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE, 'scenario.json'), 'utf8'));
    if (s && s[cli]) return String(s[cli]);
  } catch (e) { /* no file */ }
  return process.env[cli === 'codex' ? 'FAKE_CODEX_SCENARIO' : 'FAKE_CLAUDE_SCENARIO'] || 'basic';
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

// the user's own words: the prompt minus the canvas context before "---" and the attached files after
function userText(prompt) {
  return prompt.split(/\n\nПользователь приложил файлы/)[0].split('\n---\n').pop().trim();
}

async function gate(cli, ms = 60000) {
  const file = path.join(STATE, `release-${cli}`);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch (e) { /* taken */ } return true; }
    await sleep(40);
  }
  return false;
}

// a helper process like the real CLIs start (the native codex binary, a Bash tool command); a
// stop in the app must end it too. On POSIX the app sends SIGTERM to the CLI, which passes it on.
function startChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const stop = () => { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } };
  process.on('SIGTERM', () => { stop(); child.once('exit', () => process.exit(143)); setTimeout(() => process.exit(143), 2000); });
  process.on('exit', stop);
  return child;
}

// ---------------- MCP (stdio JSON-RPC) ----------------
function mcpCall(server, tool, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(server.command, server.args || [], { env: { ...process.env, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`MCP-сервер не ответил: ${err}`)); }, 20000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.id !== 2) continue;
        clearTimeout(timer);
        p.stdin.end();
        p.kill();
        if (m.error) reject(new Error(m.error.message));
        else resolve((m.result.content || []).map((c) => c.text).join('\n'));
      }
    });
    const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '1.0.0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  });
}

// codex -c mcp_servers.vibetabula.command='…' -c …args=['…'] -c …env={K='v',…} (TOML literal strings)
function codexMcpServer(argv) {
  const conf = {};
  argv.forEach((a, i) => {
    const m = argv[i - 1] === '-c' && /^mcp_servers\.vibetabula\.(\w+)=(.*)$/s.exec(a);
    if (m) conf[m[1]] = m[2];
  });
  if (!conf.command) return null;
  const strings = (v) => [...String(v || '').matchAll(/'([^']*)'/g)].map((x) => x[1]);
  const env = {};
  for (const x of String(conf.env || '').matchAll(/(\w+)='([^']*)'/g)) env[x[1]] = x[2];
  return { command: strings(conf.command)[0], args: strings(conf.args), env };
}

function fail(msg, code) {
  process.stderr.write(msg + '\n');
  process.exitCode = code;
}

// ---------------- Codex ----------------
async function codex(argv, prompt, scenario) {
  const resumeAt = argv.indexOf('resume');
  const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
  if (scenario === 'stale' && resumed) return fail(`Error: thread/resume failed: no rollout found for thread id ${resumed}`, 1);
  if (scenario === 'old-mcp' && argv.some((a) => a.includes('default_tools_approval_mode'))) {
    return fail('Error: unknown configuration field `default_tools_approval_mode` in `mcp_servers.vibetabula`', 2);
  }
  if (scenario === 'crash') return fail('codex: внутренняя ошибка (fake crash)', 3);
  const tid = resumed || crypto.randomUUID();
  out({ type: 'thread.started', thread_id: tid });
  out({ type: 'turn.started' });
  const said = userText(prompt);
  const finish = (text) => {
    out({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 34 } });
  };
  const retry = (n, of = 5) => out({ type: 'error', message: `Reconnecting... ${n}/${of} (stream disconnected before completion: websocket closed by server before response.completed)` });

  if (scenario === 'edit') {
    // edits files in its working folder like a real agent: one changed, one new, one deleted
    const cwd = process.cwd();
    fs.writeFileSync(path.join(cwd, 'README.md'), 'Привет, мир\nСтрока от агента\n');
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'файл агента\n');
    try { fs.unlinkSync(path.join(cwd, 'old.txt')); } catch (e) { /* not there */ }
    out({ type: 'item.completed', item: { id: 'fc_1', type: 'file_change', changes: [{ kind: 'update', path: 'README.md' }, { kind: 'add', path: 'notes.txt' }, { kind: 'delete', path: 'old.txt' }], status: 'completed' } });
    return finish(`Codex: ${said}`);
  }
  if (scenario === 'reconnect') {
    retry(1); await sleep(60); retry(2);
    if (!(await gate('codex'))) return fail('fake codex: gate timeout', 4);
    return finish(`Codex: ${said}`);
  }
  if (scenario === 'fail') {
    for (let i = 1; i <= 5; i++) retry(i);
    out({ type: 'turn.failed', error: { message: 'stream disconnected before completion: связь потеряна' } });
    process.exitCode = 1;
    return;
  }
  if (scenario === 'slow') {
    out({ type: 'item.completed', item: { id: 'r_1', type: 'reasoning', text: 'Думаю над задачей' } });
    out({ type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: 'sleep 600', status: 'in_progress' } });
    if (!(await gate('codex'))) return fail('fake codex: gate timeout', 4);
    out({ type: 'item.completed', item: { id: 'cmd_1', type: 'command_execution', command: 'sleep 600', aggregated_output: '', exit_code: 0, status: 'completed' } });
    return finish(`Codex: ${said}`);
  }
  if (scenario === 'mcp') {
    const server = codexMcpServer(argv);
    if (!server) return fail('fake codex: no mcp_servers.vibetabula in -c', 5);
    out({ type: 'item.started', item: { id: 'mcp_1', type: 'mcp_tool_call', server: 'vibetabula', tool: 'search_chats', status: 'in_progress' } });
    let found;
    try { found = await mcpCall(server, 'search_chats', { query: said }); } catch (e) { out({ type: 'turn.failed', error: { message: String(e.message || e) } }); process.exitCode = 1; return; }
    out({ type: 'item.completed', item: { id: 'mcp_1', type: 'mcp_tool_call', server: 'vibetabula', tool: 'search_chats', status: 'completed' } });
    return finish(`Нашёл в истории:\n${found}`);
  }
  if (scenario === 'images') {
    // Codex saves pictures to ${CODEX_HOME:-~/.codex}/generated_images/<thread>/
    const dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images', tid);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.png');
    fs.writeFileSync(old, PNG);
    const t = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(old, t, t); // an earlier picture of the session: must not be shown again
    out({ type: 'item.started', item: { id: 'ig_1', type: 'image_generation', status: 'in_progress' } });
    fs.writeFileSync(path.join(dir, 'ig_map.png'), PNG);
    return finish('Готово — карта сгенерирована.');
  }
  // basic
  out({ type: 'item.completed', item: { id: 'r_1', type: 'reasoning', text: 'Смотрю файлы проекта' } });
  out({ type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'cmd_1', type: 'command_execution', command: 'ls', aggregated_output: 'README.md\nmain\nrenderer\n', exit_code: 0, status: 'completed' } });
  finish(`Codex: ${said}`);
}

// ---------------- Claude Code ----------------
async function claude(argv, prompt, scenario) {
  const resumed = argAfter(argv, '--resume');
  if (scenario === 'stale' && resumed) return fail(`No conversation found with session ID: ${resumed}`, 1);
  if (scenario === 'old') {
    if (argv.includes('--effort')) return fail("error: unknown option '--effort'", 1);
    if (argv.includes('--include-partial-messages')) return fail("error: unknown option '--include-partial-messages'", 1);
  }
  if (scenario === 'crash') return fail('claude: внутренняя ошибка (fake crash)', 3);
  const sid = resumed || crypto.randomUUID();
  const partial = argv.includes('--include-partial-messages');
  const said = userText(prompt);
  const base = { session_id: sid };
  const streamText = (text) => {
    if (!partial) return;
    out({ type: 'stream_event', event: { type: 'message_start' }, ...base });
    for (const w of text.match(/\S+\s*/g) || []) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, ...base });
  };
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: argAfter(argv, '--model') || 'claude-fake-5', tools: ['Bash', 'Read', 'Write'], ...base });

  if (scenario === 'slow') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_slow', name: 'Bash', input: { command: 'sleep 600' } }] }, ...base });
    if (!(await gate('claude'))) return fail('fake claude: gate timeout', 4);
  }
  if (scenario === 'mcp') {
    const file = argAfter(argv, '--mcp-config');
    let found;
    try {
      const server = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.vibetabula;
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_mcp', name: 'mcp__vibetabula__search_chats', input: { query: said } }] }, ...base });
      found = await mcpCall(server, 'search_chats', { query: said });
    } catch (e) {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `MCP: ${e.message || e}`, ...base });
      return;
    }
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_mcp', content: found, is_error: false }] }, ...base });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Нашёл в истории.' }] }, ...base });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Нашёл в истории.', ...base });
    return;
  }
  streamText('Смотрю файлы.');
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Смотрю файлы.' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] }, ...base });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'README.md\nmain\nrenderer', is_error: false }] }, ...base });
  const answer = `Claude: ${said}`;
  streamText(answer);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] }, ...base });
  const result = { type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.0123, duration_ms: 900, usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 55 }, ...base };
  if (scenario === 'denied') result.permission_denials = [{ tool_name: 'Write', tool_use_id: 'tu_2', tool_input: { file_path: 'README.md' } }];
  out(result);
}

async function main(cli) {
  const argv = process.argv.slice(2);
  const prompt = await readStdin();
  const scenario = scenarioFor(cli);
  const child = scenario === 'slow' ? startChild() : null;
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(path.join(STATE, 'calls.jsonl'), JSON.stringify({ cli, argv, cwd: process.cwd(), prompt, pid: process.pid, childPid: child ? child.pid : null, scenario, time: Date.now() }) + '\n');
  } catch (e) { /* logging is best effort */ }
  await (cli === 'codex' ? codex(argv, prompt, scenario) : claude(argv, prompt, scenario));
  if (child) child.kill();
}

module.exports = { main };

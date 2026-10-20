// Chat history: every conversation of a chat window is kept here (like the sidebar of
// the ChatGPT / Claude apps), plus read-only access to Claude Code and Codex sessions on disk.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------------- CanvasTTY's own history ----------------
class HistoryStore {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.index = {}; }
    this.saveIndexSoon = null;
  }
  file(id) { return path.join(this.dir, `${String(id).replace(/[^\w-]/g, '')}.json`); }
  writeIndex() {
    clearTimeout(this.saveIndexSoon);
    this.saveIndexSoon = setTimeout(() => fsp.writeFile(this.indexFile, JSON.stringify(this.index)).catch(() => {}), 300);
  }
  list({ kind, agent } = {}) {
    return Object.values(this.index)
      .filter((r) => (!kind || r.kind === kind) && (!agent || r.agent === agent))
      .sort((a, b) => b.updated - a.updated);
  }
  async get(id) {
    try { return JSON.parse(await fsp.readFile(this.file(id), 'utf8')); } catch { return null; }
  }
  async save(rec) {
    if (!rec || !rec.id || !Array.isArray(rec.messages) || !rec.messages.length) return false;
    const now = Date.now();
    const prev = this.index[rec.id];
    const full = { ...rec, created: rec.created || prev?.created || now, updated: now };
    // never store half-streamed state
    full.messages = full.messages.map((m) => { const { running, ...rest } = m; return rest; });
    await fsp.writeFile(this.file(rec.id), JSON.stringify(full));
    this.indexRecord(full);
    this.onChange?.('save', full);
    return true;
  }
  indexRecord(full) {
    const firstUser = full.messages.find((m) => m.role === 'user');
    this.index[full.id] = {
      id: full.id, kind: full.kind, agent: full.agent, model: full.model || '', cwd: full.cwd || '', sessionId: full.sessionId || null,
      title: (full.title || firstUser?.content || 'Без названия').replace(/\s+/g, ' ').slice(0, 90),
      count: full.messages.length, created: full.created, updated: full.updated,
    };
    this.writeIndex();
  }
  // a conversation that arrived from another computer
  async importRecord(full) {
    if (!full?.id || !Array.isArray(full.messages)) return;
    await fsp.writeFile(this.file(full.id), JSON.stringify(full));
    this.indexRecord(full);
  }
  async removeLocal(id) {
    delete this.index[id];
    this.writeIndex();
    await fsp.unlink(this.file(id)).catch(() => {});
  }
  async remove(id) {
    await this.removeLocal(id);
    this.onChange?.('remove', id);
    return true;
  }
}

// ---------------- helpers ----------------
const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n…' : s; };
const isNoise = (t) => !t || /^\s*</.test(t) || /^Caveat:/i.test(t);

async function walk(dir, test, out = [], depth = 0) {
  if (depth > 5) return out;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, test, out, depth + 1);
    else if (test(e.name)) out.push(p);
  }
  return out;
}
async function newestFiles(files, limit) {
  const st = await Promise.all(files.map(async (f) => { try { const s = await fsp.stat(f); return { f, m: s.mtimeMs, size: s.size }; } catch { return null; } }));
  return st.filter(Boolean).sort((a, b) => b.m - a.m).slice(0, limit);
}
// reads JSON lines one by one; `fn` returns true to stop early
async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (fn(o) === true) break;
    }
  } finally { rl.close(); }
}
const textOf = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
  return '';
};
const toolInput = (name, input) => {
  if (!input) return '';
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return input; } }
  if (Array.isArray(input.command)) return input.command.join(' ');
  return input.command || input.cmd || input.file_path || input.path || input.pattern || input.url || input.query || input.description || JSON.stringify(input).slice(0, 400);
};

// ---------------- Claude Code (~/.claude/projects/*/*.jsonl) ----------------
const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

async function listClaude(limit = 150) {
  const files = await walk(claudeRoot(), (n) => n.endsWith('.jsonl'));
  const newest = await newestFiles(files, limit);
  const out = [];
  for (const { f, m, size } of newest) {
    let cwd = '', title = '', summary = '', first = 0;
    await eachLine(f, (o) => {
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!first && o.timestamp) first = Date.parse(o.timestamp) || 0;
      if (o.type === 'summary' && o.summary && !summary) summary = o.summary;
      if (!title && o.type === 'user' && o.message && !o.isMeta) { const t = textOf(o.message.content); if (!isNoise(t)) title = t; }
      return !!(cwd && title);
    });
    if (!title && !summary) continue;
    out.push({ source: 'claude', id: path.basename(f, '.jsonl'), sessionId: path.basename(f, '.jsonl'), file: f, cwd, title: clip(summary || title, 90), created: first || m, updated: m, size });
  }
  return out;
}

async function readClaude(file) {
  const msgs = [];
  let asst = null, cwd = '', sessionId = path.basename(file, '.jsonl'), model = '';
  const tools = new Map();
  await eachLine(file, (o) => {
    if (o.cwd) cwd = o.cwd;
    if (o.sessionId) sessionId = o.sessionId;
    const m = o.message;
    if (!m || o.isMeta) return;
    const ts = Date.parse(o.timestamp) || Date.now();
    if (o.type === 'user') {
      const c = m.content;
      // tool results come back as "user" messages
      if (Array.isArray(c) && c.some((p) => p.type === 'tool_result')) {
        for (const p of c) if (p.type === 'tool_result') { const t = tools.get(p.tool_use_id); if (t) { t.output = cut(textOf(p.content), 4000); t.status = p.is_error ? 'err' : 'ok'; } }
        return;
      }
      const t = textOf(c);
      if (isNoise(t)) return;
      asst = null;
      msgs.push({ role: 'user', content: t, ts });
    } else if (o.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') model = m.model;
      if (!asst) { asst = { role: 'assistant', content: '', parts: [], ts }; msgs.push(asst); }
      for (const p of Array.isArray(m.content) ? m.content : [{ type: 'text', text: textOf(m.content) }]) {
        if (p.type === 'text' && p.text) asst.parts.push({ type: 'text', text: p.text });
        else if (p.type === 'thinking' && p.thinking) asst.parts.push({ type: 'reasoning', text: p.thinking });
        else if (p.type === 'tool_use') { const t = { type: 'tool', id: p.id, name: p.name, input: toolInput(p.name, p.input), status: 'ok' }; tools.set(p.id, t); asst.parts.push(t); }
      }
    }
  });
  for (const m of msgs) if (m.role === 'assistant') m.content = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  return { messages: msgs, cwd, sessionId, model };
}

// ---------------- Codex (~/.codex/sessions/**/rollout-*.jsonl) ----------------
const codexRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const codexItem = (o) => (o.type === 'response_item' && o.payload ? o.payload : o.type && o.type !== 'session_meta' && o.type !== 'event_msg' && o.type !== 'turn_context' ? o : null);
const codexMeta = (o) => (o.type === 'session_meta' ? o.payload : o.id && o.timestamp && !o.type ? o : null);

async function listCodex(limit = 150) {
  const files = await walk(codexRoot(), (n) => /^rollout-.*\.jsonl$/.test(n));
  const newest = await newestFiles(files, limit);
  const out = [];
  for (const { f, m, size } of newest) {
    let id = '', cwd = '', title = '', first = 0;
    await eachLine(f, (o) => {
      const meta = codexMeta(o);
      if (meta) { id = id || meta.id || ''; cwd = cwd || meta.cwd || ''; first = first || Date.parse(meta.timestamp) || 0; }
      if (o.type === 'turn_context' && o.payload?.cwd && !cwd) cwd = o.payload.cwd;
      const it = codexItem(o);
      if (it && it.type === 'message' && it.role === 'user' && !title) { const t = textOf(it.content); if (!isNoise(t)) title = t; }
      return !!(id && title && cwd);
    });
    if (!title) continue;
    if (!id) { const mm = path.basename(f).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i); id = mm ? mm[1] : path.basename(f, '.jsonl'); }
    out.push({ source: 'codex', id, sessionId: id, file: f, cwd, title: clip(title, 90), created: first || m, updated: m, size });
  }
  return out;
}

async function readCodex(file) {
  const msgs = [];
  let asst = null, cwd = '', sessionId = '', model = '';
  const tools = new Map();
  const ensureAsst = (ts) => { if (!asst) { asst = { role: 'assistant', content: '', parts: [], ts }; msgs.push(asst); } return asst; };
  await eachLine(file, (o) => {
    const meta = codexMeta(o);
    if (meta) { sessionId = sessionId || meta.id || ''; cwd = cwd || meta.cwd || ''; }
    if (o.type === 'turn_context' && o.payload) { cwd = o.payload.cwd || cwd; model = o.payload.model || model; }
    const it = codexItem(o);
    if (!it) return;
    const ts = Date.parse(o.timestamp) || Date.now();
    if (it.type === 'message') {
      const t = textOf(it.content);
      if (it.role === 'user') { if (isNoise(t)) return; asst = null; msgs.push({ role: 'user', content: t, ts }); }
      else if (it.role === 'assistant' && t) ensureAsst(ts).parts.push({ type: 'text', text: t });
    } else if (it.type === 'reasoning') {
      const t = (it.summary || []).map((s) => s.text || '').join('\n');
      if (t) ensureAsst(ts).parts.push({ type: 'reasoning', text: t });
    } else if (it.type === 'function_call' || it.type === 'local_shell_call' || it.type === 'custom_tool_call') {
      const id = it.call_id || it.id;
      const input = it.type === 'local_shell_call' ? toolInput('shell', it.action) : toolInput(it.name, it.arguments || it.input);
      const t = { type: 'tool', id, name: it.name || 'shell', input, status: 'ok' };
      tools.set(id, t); ensureAsst(ts).parts.push(t);
    } else if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') {
      const t = tools.get(it.call_id);
      if (t) { let out = it.output; if (typeof out === 'object') out = out?.content || JSON.stringify(out); try { const j = JSON.parse(out); out = j.output ?? out; } catch {} t.output = cut(out, 4000); }
    }
  });
  if (!sessionId) { const mm = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i); if (mm) sessionId = mm[1]; }
  for (const m of msgs) if (m.role === 'assistant') m.content = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  return { messages: msgs, cwd, sessionId, model };
}

// ---------------- public API ----------------
async function listSessions(kind, { cwd } = {}) {
  const all = kind === 'codex' ? await listCodex() : await listClaude();
  if (!cwd) return all;
  const c = normPath(cwd);
  return all.map((s) => ({ ...s, here: normPath(s.cwd) === c }));
}
async function readSession(kind, file) {
  const root = kind === 'codex' ? codexRoot() : claudeRoot();
  const abs = path.resolve(file);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error('файл вне папки сессий');
  return kind === 'codex' ? readCodex(abs) : readClaude(abs);
}

module.exports = { HistoryStore, listSessions, readSession };

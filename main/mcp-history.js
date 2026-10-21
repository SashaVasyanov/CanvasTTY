#!/usr/bin/env node
// MCP server (stdio) that lets the agents in CanvasTTY chat windows search and read the
// user's previous conversations: CanvasTTY chat history plus Claude Code and Codex sessions.
// Started by CanvasTTY itself (Electron binary with ELECTRON_RUN_AS_NODE=1).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { HistoryStore, listSessions, readSession, sessionFiles } = require('./history');

const store = new HistoryStore(path.join(process.env.CANVASTTY_USERDATA || '.', 'chats'), { readOnly: true });
const SOURCES = ['canvastty', 'claude', 'codex'];
const MAX_OUT = 60000;

const fmtDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '');
const snippet = (text, terms, n = 220) => {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, n).replace(/\s+/g, ' ');
  const s = Math.max(0, at - n / 3);
  return (s > 0 ? '…' : '') + text.slice(s, s + n).replace(/\s+/g, ' ') + (s + n < text.length ? '…' : '');
};
const msgText = (m) => {
  if (m.role === 'user') return [m.content || '', ...(m.attachments || []).map((a) => `[вложение: ${a.name}]`)].filter(Boolean).join('\n');
  const parts = m.parts || [{ type: 'text', text: m.content }];
  return parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool' ? `[${p.name}: ${String(p.input || '').slice(0, 300)}]${p.output ? `\n${String(p.output).slice(0, 1500)}` : ''}` : '')).filter(Boolean).join('\n');
};
const convText = (messages) => messages.map((m) => `### ${m.role === 'user' ? 'Пользователь' : 'Ассистент'}\n${msgText(m)}`).join('\n\n');

async function search({ query = '', source = 'all', limit = 10 }) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error('пустой запрос');
  const want = (s) => source === 'all' || source === s;
  const hits = [];
  if (want('canvastty')) {
    for (const meta of store.list({})) {
      const rec = await store.get(meta.id);
      if (!rec) continue;
      const text = `${rec.title || ''}\n${convText(rec.messages || [])}`;
      const low = text.toLowerCase();
      if (terms.every((t) => low.includes(t))) hits.push({ source: 'canvastty', ref: rec.id, title: meta.title, date: rec.updated, cwd: rec.cwd || '', agent: rec.agent, snippet: snippet(text, terms) });
    }
  }
  for (const kind of ['claude', 'codex']) {
    if (!want(kind)) continue;
    for (const { f, m } of await sessionFiles(kind)) {
      if (hits.length >= limit * 3) break;
      let raw;
      try { const st = fs.statSync(f); if (st.size > 30e6) continue; raw = fs.readFileSync(f, 'utf8').toLowerCase(); } catch { continue; }
      if (!terms.every((t) => raw.includes(t))) continue;
      try {
        const s = await readSession(kind, f);
        const text = convText(s.messages);
        const low = text.toLowerCase();
        if (!terms.every((t) => low.includes(t))) continue; // matched only in metadata
        const first = s.messages.find((x) => x.role === 'user');
        hits.push({ source: kind, ref: f, title: (first?.content || '').replace(/\s+/g, ' ').slice(0, 90), date: m, cwd: s.cwd, snippet: snippet(text, terms) });
      } catch {}
    }
  }
  hits.sort((a, b) => (b.date || 0) - (a.date || 0));
  const out = hits.slice(0, limit);
  if (!out.length) return `Ничего не найдено по запросу «${query}». Попробуйте другие слова или source="all".`;
  return out.map((x, i) => `${i + 1}. [${x.source}] ${x.title || 'Без названия'}\n   дата: ${fmtDate(x.date)}${x.cwd ? ` · папка: ${x.cwd}` : ''}\n   source="${x.source}" ref="${x.ref}"\n   …${x.snippet}`).join('\n\n')
    + '\n\nЧтобы прочитать переписку целиком, вызовите read_chat с этими source и ref.';
}

async function read({ source, ref, offset = 0 }) {
  if (!SOURCES.includes(source)) throw new Error('source должен быть canvastty, claude или codex');
  let title = '', messages = [], cwd = '';
  if (source === 'canvastty') {
    const rec = await store.get(ref);
    if (!rec) throw new Error('чат не найден');
    title = rec.title || ''; messages = rec.messages || []; cwd = rec.cwd || '';
  } else {
    const s = await readSession(source, ref);
    messages = s.messages; cwd = s.cwd;
    title = (messages.find((x) => x.role === 'user')?.content || '').slice(0, 90);
  }
  const text = `# ${title || 'Переписка'}\n${cwd ? `Папка: ${cwd}\n` : ''}\n${convText(messages)}`;
  const part = text.slice(offset, offset + MAX_OUT);
  return part + (offset + MAX_OUT < text.length ? `\n\n[обрезано: показано ${offset + part.length} из ${text.length} символов, продолжение — read_chat с offset=${offset + MAX_OUT}]` : '');
}

async function list({ source = 'all', limit = 20 }) {
  const rows = [];
  if (source === 'all' || source === 'canvastty') for (const r of store.list({})) rows.push({ source: 'canvastty', ref: r.id, title: r.title, date: r.updated, cwd: r.cwd });
  for (const kind of ['claude', 'codex']) if (source === 'all' || source === kind) for (const s of await listSessions(kind)) rows.push({ source: kind, ref: s.file, title: s.title, date: s.updated, cwd: s.cwd });
  rows.sort((a, b) => (b.date || 0) - (a.date || 0));
  return rows.slice(0, limit).map((x, i) => `${i + 1}. [${x.source}] ${x.title} — ${fmtDate(x.date)}${x.cwd ? ` · ${x.cwd}` : ''}\n   source="${x.source}" ref="${x.ref}"`).join('\n') || 'Чатов пока нет.';
}

const TOOLS = [
  {
    name: 'search_chats',
    description: "Full-text search in the user's previous AI conversations: CanvasTTY chat history and Claude Code / Codex sessions stored on this computer (including ones started in a terminal). Use it whenever the user refers to something from an earlier chat. All words must match (case-insensitive).",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' }, source: { type: 'string', enum: ['all', ...SOURCES], default: 'all' }, limit: { type: 'number', default: 10 } }, required: ['query'] },
  },
  {
    name: 'read_chat',
    description: 'Read a whole previous conversation found with search_chats or list_chats.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: SOURCES }, ref: { type: 'string' }, offset: { type: 'number', default: 0 } }, required: ['source', 'ref'] },
  },
  {
    name: 'list_chats',
    description: "List the user's most recent previous conversations (newest first).",
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['all', ...SOURCES], default: 'all' }, limit: { type: 'number', default: 20 } } },
  },
];
const HANDLERS = { search_chats: search, read_chat: read, list_chats: list };

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canvastty-history', version: '1.0.0' } });
    else if (method === 'tools/list') reply({ tools: TOOLS });
    else if (method === 'tools/call') {
      const fn = HANDLERS[params?.name];
      if (!fn) { reply({ content: [{ type: 'text', text: `Нет инструмента ${params?.name}` }], isError: true }); return; }
      try { reply({ content: [{ type: 'text', text: await fn(params.arguments || {}) }] }); }
      catch (e) { reply({ content: [{ type: 'text', text: `Ошибка: ${e.message || e}` }], isError: true }); }
    } else if (method === 'ping') reply({});
    else if (id !== undefined && !String(method).startsWith('notifications/')) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
});

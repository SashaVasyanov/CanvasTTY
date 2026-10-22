// Fake Claude Code / Codex session files and VibeTabula chat history on disk, shaped like the real
// ones (~/.claude/projects/*/*.jsonl, ~/.codex/sessions/**/rollout-*.jsonl, <userData>/chats).
import fs from 'node:fs';
import path from 'node:path';

const jsonl = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return file; };
const ts = (min) => new Date(Date.UTC(2026, 9, 20, 10, min)).toISOString();

export const CLAUDE_SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
export const CODEX_SESSION = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';

// <root>/claude/projects/... and <root>/codex/sessions/...; returns { claudeDir, codexDir, files }
export function writeSessions(root) {
  const claudeDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  const files = {};
  files.claude = jsonl(path.join(claudeDir, 'projects', '-home-user-proj', `${CLAUDE_SESSION}.jsonl`), [
    { type: 'summary', summary: 'Таблицы UD в базе' },
    { type: 'user', isMeta: true, cwd: '/home/user/proj', message: { role: 'user', content: '<command-name>/init</command-name>' } },
    { type: 'user', cwd: '/home/user/proj', sessionId: CLAUDE_SESSION, timestamp: ts(0), message: { role: 'user', content: 'Найди   список таблиц по UD' } },
    { type: 'assistant', timestamp: ts(1), message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'Посмотрю схему' }, { type: 'text', text: 'Смотрю схему.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls db' } }] } },
    { type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'tables.sql' }] }] } },
    { type: 'assistant', timestamp: ts(3), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Таблицы: UD_ORDERS, UD_USERS' }] } },
    { type: 'user', timestamp: ts(4), message: { role: 'user', content: '<local-command-stdout>шум</local-command-stdout>' } },
    'не json',
  ]);
  // a session without a summary and with only noise from the user: not listed
  jsonl(path.join(claudeDir, 'projects', '-home-user-proj', 'empty.jsonl'), [
    { type: 'user', cwd: '/home/user/proj', message: { role: 'user', content: 'Caveat: служебное' } },
  ]);
  files.codex = jsonl(path.join(codexDir, 'sessions', '2026', '10', '20', `rollout-2026-10-20T10-00-00-${CODEX_SESSION}.jsonl`), [
    { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX_SESSION, timestamp: ts(0), cwd: 'C:\\Users\\vasya\\proj' } },
    { timestamp: ts(0), type: 'turn_context', payload: { cwd: 'C:\\Users\\vasya\\proj', model: 'gpt-5-codex' } },
    { timestamp: ts(0), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Почини тесты UD' }] } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Ищу тесты' }] } },
    { timestamp: ts(3), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }), call_id: 'c1' } },
    { timestamp: ts(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok 3 tests', metadata: {} }) } },
    { timestamp: ts(5), type: 'event_msg', payload: { type: 'token_count' } },
    { timestamp: ts(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Тесты проходят.' }] } },
  ]);
  // something that is not a rollout file is ignored
  jsonl(path.join(codexDir, 'sessions', '2026', '10', '20', 'other.jsonl'), [{ type: 'x' }]);
  // file times: the Codex session is the newer one
  fs.utimesSync(files.claude, new Date('2026-10-20T10:05:00Z'), new Date('2026-10-20T10:05:00Z'));
  fs.utimesSync(files.codex, new Date('2026-10-21T09:00:00Z'), new Date('2026-10-21T09:00:00Z'));
  return { claudeDir, codexDir, files };
}

// VibeTabula's own history (<userData>/chats/<id>.json + index.json)
export function writeHistory(userData, records) {
  const dir = path.join(userData, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const index = {};
  for (const r of records) {
    fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r));
    index[r.id] = { id: r.id, kind: r.kind, agent: r.agent, model: r.model || '', cwd: r.cwd || '', sessionId: null, title: r.title, count: r.messages.length, created: r.created, updated: r.updated };
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  return dir;
}

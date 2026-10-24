// What an agent is doing right now, in a few words, and how its last answer went — for the window
// header, the card of a far-away window, the agents hub and the «Агенты» widget (nodes.js
// statusInfo → canvas.js syncHead, hub.js, widgets.js). Pure functions (no DOM):
// tests/unit/activity.test.mjs.
//   doing(msg)          → 'Запускает npm test' | 'Правит README.md' | 'Думает…' | 'Пишет ответ…' | …
//   elapsed(ms)         → '42 с' | '2 мин' | '1 ч 5 мин'
//   liveLine(msg, now)  → 'Запускает npm test · 2 мин'
//   live(msg, now)      → { what: 'Запускает npm test', time: '2 мин', detail: 'Запускает npm test · 2 мин' }
//   outcome(msg)        → 'Готово за 2 мин · 3 файла' | 'Остановлено через 40 с' | 'Ошибка через 1 мин' | ''

export const filesWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'файл' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'файла' : 'файлов');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };
const unquote = (s) => String(s || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
const base = (p) => unquote(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || unquote(p);
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// "bash -lc 'cd app && npm test'" → "npm test"; powershell.exe -Command "…", cmd /c … the same
const SHELL = /^\s*"?(?:[^"\s]*[\\/])?(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?"?\s+(?:[-/][A-Za-z][\w-]*\s+)*/i;
const CD = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i;
export function command(input) {
  let s = String(input || '').trim();
  const inner = s.replace(SHELL, '');
  if (inner !== s && inner.trim()) s = unquote(inner);
  s = firstLine(s);
  for (let i = 0; i < 5 && CD.test(s); i++) s = s.replace(CD, '');
  return clip(s, 48);
}
const host = (u) => { try { return new URL(firstLine(u)).hostname.replace(/^www\./, ''); } catch { return clip(firstLine(u), 40); } };

const CANVAS = {
  list_objects: 'Смотрит холст', read_object: 'Смотрит холст', create_sticky: 'Добавляет стикер на холст',
  create_note: 'Пишет заметку на холсте', create_text: 'Добавляет текст на холст', create_area: 'Добавляет область на холст',
  connect: 'Соединяет объекты на холсте', update_text: 'Правит текст на холсте',
};
// files of a Codex «Файлы» call: "update src/a.js" lines
const changeLines = (input) => String(input || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^(add|update|create|modify|delete|remove|rename|move)\s+/i, ''));

function toolDoing(p) {
  const name = String(p.name || ''), input = String(p.input || ''), first = firstLine(input);
  if (/^(Bash|Команда|shell|exec_command)$/i.test(name)) return first ? `Запускает ${command(input)}` : 'Запускает команду';
  if (name === 'BashOutput') return 'Смотрит вывод команды';
  if (/^Kill(Shell|Bash)$/.test(name)) return 'Останавливает команду';
  if (name === 'Файлы') {
    const files = changeLines(input);
    if (!files.length) return 'Правит файлы';
    return files.length > 1 ? `Правит ${base(files[0])} и ещё ${files.length - 1}` : `Правит ${base(files[0])}`;
  }
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(name)) return first ? `Правит ${base(first)}` : 'Правит файл';
  if (name === 'Write') return first ? `Пишет ${base(first)}` : 'Пишет файл';
  if (/^(Read|NotebookRead)$/.test(name)) return first ? `Читает ${base(first)}` : 'Читает файл';
  if (name === 'Grep') return first ? `Ищет «${clip(first, 30)}»` : 'Ищет в файлах';
  if (name === 'Glob') return first ? `Ищет файлы ${clip(first, 30)}` : 'Ищет файлы';
  if (name === 'LS') return first ? `Смотрит папку ${base(first)}` : 'Смотрит папку';
  if (/^(WebSearch|Поиск|web_search)$/i.test(name)) return first ? `Ищет в интернете «${clip(first, 30)}»` : 'Ищет в интернете';
  if (name === 'WebFetch') return first ? `Открывает ${host(first)}` : 'Открывает страницу';
  if (/^(Task|Agent)$/.test(name)) return first ? `Помощник: ${clip(first, 40)}` : 'Работает с помощником';
  if (/^(TodoWrite|update_plan)$/.test(name)) return 'Составляет план';
  // MCP tools: Claude names them mcp__server__tool, Codex «MCP server» with the tool as input
  let server = '', tool = '';
  const mc = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mc) { server = mc[1]; tool = mc[2]; } else if (/^MCP\b/.test(name)) { server = name.slice(3).trim(); tool = first; }
  if (server === 'vibetabula' && tool) {
    const c = /^canvas_(.+)$/.exec(tool);
    if (c) return CANVAS[c[1]] || 'Работает с холстом';
    return 'Ищет в прошлых чатах';
  }
  if (tool || server) return `Вызывает ${clip(tool || server, 36)}`;
  return name ? `Вызывает ${clip(name, 36)}` : 'Работает';
}

// the step of a running answer: its last part that says something
export function doing(m) {
  if (!m) return '';
  const parts = Array.isArray(m.parts) ? m.parts : null;
  if (parts) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p) continue;
      if (p.type === 'notice') { if (p.reconnect) return 'Переподключается…'; continue; }
      if (p.type === 'tool') return p.status === 'run' || !p.status ? toolDoing(p) : 'Думает…'; // a finished tool: reading its result
      if (p.type === 'reasoning' && String(p.text || '').trim()) return 'Думает…';
      if (p.type === 'text' && String(p.text || '').trim()) return 'Пишет ответ…';
    }
    return 'Думает…';
  }
  // API chats: text and reasoning, no tools
  if (String(m.content || '').trim()) return 'Пишет ответ…';
  return 'Думает…';
}

export function elapsed(ms) {
  const s = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} с`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} мин`;
  const hr = Math.floor(min / 60), rest = min % 60;
  return rest ? `${hr} ч ${rest} мин` : `${hr} ч`;
}

export function live(m, now = Date.now()) {
  const what = doing(m), time = m?.ts && now >= m.ts ? elapsed(now - m.ts) : '';
  return { what, time, detail: time ? `${what} · ${time}` : what };
}
export const liveLine = (m, now = Date.now()) => live(m, now).detail;

// el ← «what · time» as two spans, so a long command is cut and the time stays visible
// (canvas.js, hub.js, widgets.js; the only function here that touches the DOM)
export function paintActivity(el, st) {
  const what = st?.what || st?.detail || st?.label || '', time = st?.time || '';
  const key = `${what}|${time}`;
  if (el._act === key) return;
  el._act = key;
  el.title = time ? `${what} · ${time}` : what;
  const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
  el.replaceChildren(...(what ? [span('act-what', what)] : []), ...(time ? [span('act-time', ` · ${time}`)] : []));
}

// how the last answer ended; '' when there is nothing worth saying (an old answer without times)
export function outcome(m) {
  if (!m || m.role !== 'assistant' || m.running || m.interrupted) return '';
  const dur = m.end && m.ts && m.end >= m.ts ? elapsed(m.end - m.ts) : '';
  if (m.stopped) return dur ? `Остановлено через ${dur}` : 'Остановлено';
  if (m.error || (m.parts || []).some((p) => p?.type === 'error')) return dur ? `Ошибка через ${dur}` : '';
  if (m.needsInput || !dur) return '';
  const files = m.changes?.files?.length || m.touched?.length || 0;
  return `Готово за ${dur}${files ? ` · ${files} ${filesWord(files)}` : ''}`;
}

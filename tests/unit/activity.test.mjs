// What an agent is doing right now and how its last answer went (renderer/js/activity.js): the line
// in the window header, on the card of a far-away window, in the agents hub and the «Агенты» widget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doing, elapsed, liveLine, outcome, command } from '../../renderer/js/activity.js';

const run = (...parts) => ({ role: 'assistant', running: true, parts });
const tool = (name, input, status = 'run') => ({ type: 'tool', id: name, name, input, status });

test('команды: без обёрток оболочки и cd, коротко', () => {
  assert.equal(doing(run(tool('Bash', 'npm test'))), 'Запускает npm test');
  assert.equal(doing(run(tool('Команда', "bash -lc 'cd /home/u/app && npm test'"))), 'Запускает npm test');
  assert.equal(doing(run(tool('Команда', '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "npm run build"'))), 'Запускает npm run build');
  assert.equal(command('cmd /c dir /b'), 'dir /b');
  assert.equal(command('ssh server ls'), 'ssh server ls', 'ssh — не оболочка');
  assert.equal(command('git status\ngit diff'), 'git status');
  assert.ok(command('x'.repeat(200)).length <= 48);
  assert.equal(doing(run(tool('Bash', ''))), 'Запускает команду');
});

test('файлы: правит, пишет, читает — имя файла без папок', () => {
  assert.equal(doing(run(tool('Edit', 'C:\\proj\\README.md'))), 'Правит README.md');
  assert.equal(doing(run(tool('MultiEdit', '/home/u/app/src/main.js'))), 'Правит main.js');
  assert.equal(doing(run(tool('Write', '/home/u/app/notes.txt'))), 'Пишет notes.txt');
  assert.equal(doing(run(tool('Read', '/home/u/app/package.json'))), 'Читает package.json');
  assert.equal(doing(run(tool('Файлы', 'update src/a.js'))), 'Правит a.js');
  assert.equal(doing(run(tool('Файлы', 'update src/a.js\nadd src/b.js\ndelete old.js'))), 'Правит a.js и ещё 2');
});

test('поиск, сайты, помощники, план, MCP и инструменты холста', () => {
  assert.equal(doing(run(tool('Grep', 'TODO'))), 'Ищет «TODO»');
  assert.equal(doing(run(tool('Glob', '**/*.ts'))), 'Ищет файлы **/*.ts');
  assert.equal(doing(run(tool('WebSearch', 'electron 38 release'))), 'Ищет в интернете «electron 38 release»');
  assert.equal(doing(run(tool('Поиск', 'погода'))), 'Ищет в интернете «погода»');
  assert.equal(doing(run(tool('WebFetch', 'https://www.example.com/docs/a'))), 'Открывает example.com');
  assert.equal(doing(run(tool('Task', 'Найти все вызовы API'))), 'Помощник: Найти все вызовы API');
  assert.equal(doing(run(tool('TodoWrite', '[]'))), 'Составляет план');
  assert.equal(doing(run(tool('mcp__vibetabula__canvas_create_sticky', 'План'))), 'Добавляет стикер на холст');
  assert.equal(doing(run(tool('MCP vibetabula', 'canvas_connect'))), 'Соединяет объекты на холсте');
  assert.equal(doing(run(tool('mcp__vibetabula__search_chats', 'сборка'))), 'Ищет в прошлых чатах');
  assert.equal(doing(run(tool('mcp__github__create_issue', '{}'))), 'Вызывает create_issue');
  assert.equal(doing(run(tool('SomethingNew', ''))), 'Вызывает SomethingNew');
});

test('думает, пишет ответ, переподключается; законченный инструмент — думает над результатом', () => {
  assert.equal(doing(run()), 'Думает…');
  assert.equal(doing(run({ type: 'reasoning', text: 'hmm' })), 'Думает…');
  assert.equal(doing(run(tool('Bash', 'ls', 'ok'))), 'Думает…');
  assert.equal(doing(run(tool('Bash', 'ls', 'ok'), { type: 'text', text: 'Готово, вот что' })), 'Пишет ответ…');
  assert.equal(doing(run({ type: 'text', text: 'План' }, tool('Read', 'a.md'), { type: 'text', text: '' })), 'Читает a.md', 'пустой текст не считается');
  assert.equal(doing(run(tool('Bash', 'ls', 'ok'), { type: 'notice', text: 'Переподключение 2/5', reconnect: true })), 'Переподключается…');
  assert.equal(doing(run(tool('Bash', 'npm test'), { type: 'notice', text: 'что-то' })), 'Запускает npm test');
  // API chats: no parts
  assert.equal(doing({ role: 'assistant', running: true, content: '' }), 'Думает…');
  assert.equal(doing({ role: 'assistant', running: true, content: 'Привет' }), 'Пишет ответ…');
});

test('время: секунды, минуты, часы', () => {
  assert.equal(elapsed(0), '1 с');
  assert.equal(elapsed(42_000), '42 с');
  assert.equal(elapsed(125_000), '2 мин');
  assert.equal(elapsed(3_600_000), '1 ч');
  assert.equal(elapsed(3_900_000), '1 ч 5 мин');
  const m = { ...run(tool('Bash', 'npm test')), ts: 1_000_000 };
  assert.equal(liveLine(m, 1_000_000 + 130_000), 'Запускает npm test · 2 мин');
  assert.equal(liveLine({ ...m, ts: undefined }), 'Запускает npm test');
});

test('итог: готово за N · файлы, остановлено, ошибка; у старых ответов без времени — ничего', () => {
  const ts = 1_000_000;
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 120_000, changes: { files: [{}, {}, {}] } }), 'Готово за 2 мин · 3 файла');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 40_000, touched: ['a'] }), 'Готово за 40 с · 1 файл');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 40_000, changes: { files: Array(5).fill({}) } }), 'Готово за 40 с · 5 файлов');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 9_000 }), 'Готово за 9 с');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 40_000, stopped: true }), 'Остановлено через 40 с');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 60_000, parts: [{ type: 'error', text: 'x' }] }), 'Ошибка через 1 мин');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 60_000, error: true }), 'Ошибка через 1 мин');
  assert.equal(outcome({ role: 'assistant', ts }), '', 'старый ответ без end');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 1000, running: true }), '');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 1000, interrupted: true }), '');
  assert.equal(outcome({ role: 'assistant', ts, end: ts + 1000, needsInput: true }), '');
  assert.equal(outcome({ role: 'user', ts, end: ts + 1000 }), '');
  assert.equal(outcome(undefined), '');
});

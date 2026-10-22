# Тесты VibeTabula

Три уровня, от быстрых к медленным:

| что | где | команда | время |
| --- | --- | --- | --- |
| синтаксис всех файлов | `scripts/check.mjs` | `npm run check` | секунды |
| юнит-тесты главного процесса и чистых функций: синхронизация, история чатов, вложения, фоновые ответы агентов, понятные ошибки | `tests/unit/*.test.mjs` (`node:test`, без зависимостей) | `npm run test:unit` | ~1 мин |
| интерфейс в браузере с демо-данными (`renderer/js/mock.js`): холст, объекты, рисование, цвета, заметки, виджеты, комментарии, чаты | `tests/e2e/*.spec.mjs` (Playwright) | `npm run test:browser` | ~5 мин |
| настоящее приложение в Electron | `tests/electron/*.spec.mjs` | `npm run test:electron` | ~2 мин |

`npm test` = синтаксис + юнит + браузер. На GitHub всё, включая Electron, запускается на каждый push
в `main` и в pull request — на Windows и Linux (`.github/workflows/build.yml`); сборки собираются
только после зелёных тестов, отчёт об упавших тестах прикладывается к запуску (`test-results`).

### Браузерные тесты

Нужен браузер для Playwright: на Windows используется встроенный Edge (ничего ставить не надо),
на Linux / macOS — `npx playwright install chromium` один раз. Тесты сами поднимают маленький
сервер `tests/server.mjs` (порт 5588, `TEST_PORT` меняет его) с папкой `renderer/`.

- Общая фикстура `tests/e2e/fixtures.mjs`: пустой холст на каждый тест, тест падает при ошибке в консоли.
- Помощники по областям — `tests/e2e/helpers/*.mjs`. Ответы агентов в чатах не ждут таймеров мока:
  `recordAgentRuns` / `emitAgent` подменяют запуск, тест сам присылает события в том виде, как их шлёт
  `main/agentchat.js`.
- Сразу после сдвига или масштабирования холста объекты ~160 мс не принимают клики (`vp-moving`):
  перед кликами мышью после смены вида — `await app.idle()`.
- Один файл: `npx playwright test --project=browser tests/e2e/chat.spec.mjs`, один тест: `-g "название"`.

### Юнит-тесты

`node --test "tests/unit/*.test.mjs"` (или один файл). Тесты фоновых ответов агентов
(`agentchat.test.mjs`) запускают поддельные CLI из `tests/unit/fixtures` — на Windows через `.cmd`,
как настоящие npm-обёртки; синхронизация проверяется двумя «компьютерами» с общей папкой.

## Electron

`tests/electron` запускает настоящее приложение (main-процесс, IPC, файлы на диске, процессы
агентов) через Playwright. Каждый тест получает чистый профиль во временной папке
(`VIBETABULA_TEST_HOME`, туда же указывают `HOME` / `USERPROFILE`), поэтому ваши настройки, canvas,
чаты и заметки не трогаются. Вместо настоящих Codex и Claude Code запускаются подделки из
`tests/electron/bin` — они говорят тем же JSON-протоколом и не ходят в сеть, вход в аккаунты не нужен.

Нужно: Node.js 20+ и `npm install` (он скачивает Electron). Браузеры Playwright для этих тестов не нужны.

**Windows** (PowerShell или cmd), ничего дополнительно ставить не надо:

```powershell
npx playwright test --project=electron
```

Терминалы в тестах собирают ConPTY-мост через `csc.exe` из .NET Framework 4 — он есть в Windows 10/11.

**Linux** — нужен дисплей. В графической сессии команда та же; без неё (сервер, CI, WSL без GUI) — через Xvfb:

```bash
sudo apt install xvfb        # один раз
xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test --project=electron
```

Для терминалов нужен `python3`. На Linux приложение запускается с `--no-sandbox` и `--disable-gpu`
(под Xvfb нет GPU, а программный GL делает закрытие окна очень медленным).

Полезное:

- один файл или тест: `npx playwright test --project=electron tests/electron/agentchat.spec.mjs -g "Стоп"`;
- проверка на нестабильность: `--repeat-each=2`; параллельно: `--workers=2`;
- `ELECTRON_PATH=<путь к electron(.exe)>` — другой бинарник Electron вместо пакета `electron`;
- `ELECTRON_GPU=1` — не выключать GPU на Linux; `ELECTRON_EXTRA_ARGS="--флаг ..."` — дополнительные ключи Chromium;
- отчёт об упавшем тесте лежит в `test-results/`: скриншот, trace и `main-process.log` (вывод main-процесса).

Тесты буфера обмена работают с настоящим системным буфером — пока идёт прогон, лучше ничего не копировать.

### Поддельные Codex и Claude Code

`tests/electron/bin/codex` и `claude` — node-скрипты (на Windows их находят по `PATH` через
`codex.cmd` / `claude.cmd`, как npm-обёртки настоящих CLI); общая логика — в `fake-cli.cjs`.
Фикстура ставит папку первой в `PATH` (на Linux / macOS ещё и в профиле оболочки тестового `HOME`,
потому что приложение берёт `PATH` из login-shell) и проверяет, что приложение нашло именно подделки.

Что ответит агент, задаёт сценарий: в тесте `app.scenario({ codex: 'images', claude: 'denied' })`
(или переменные `FAKE_CODEX_SCENARIO` / `FAKE_CLAUDE_SCENARIO`):

| сценарий | что делает |
| --- | --- |
| `basic` (по умолчанию) | размышления/инструмент и ответ «Codex: …» / «Claude: …» с текстом вопроса; `resume` продолжает ту же сессию |
| `images` | Codex сохраняет картинку в `~/.codex/generated_images/<сессия>/` (и старую, которую показывать не надо) |
| `reconnect` | два «Reconnecting… n/5», потом ждёт `app.release('codex')` |
| `fail` | пять переподключений и `turn.failed` |
| `crash` | только текст в stderr и код выхода 3 |
| `slow` | запускает дочерний процесс и ждёт `app.release(cli)` — для «Стоп» и выхода из приложения |
| `stale` | сессию для `resume` / `--resume` «не нашли» |
| `old` (claude), `old-mcp` (codex) | старая версия CLI: не знает `--effort` и `--include-partial-messages` / одобрения MCP-инструментов |
| `denied` (claude) | ответ с `permission_denials` |
| `mcp` | запускает MCP-сервер истории, который передало приложение, и ищет в нём слова вопроса |

Каждый запуск записывается в `<профиль>/.fake-cli/calls.jsonl` (аргументы, папка, промпт из stdin,
pid) — в тесте это `app.calls('codex')`. Вручную (bash): `echo привет | FAKE_CODEX_SCENARIO=basic node tests/electron/bin/codex exec --json`.

Тесты, помеченные `test.fixme`, описывают найденные ошибки приложения (см. комментарии над ними):
их надо включить, когда ошибка исправлена.

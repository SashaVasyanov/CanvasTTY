# Тесты VibeTabula

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
pid) — в тесте это `app.calls('codex')`. Вручную: `echo привет | FAKE_CODEX_SCENARIO=basic node tests/electron/bin/codex exec --json`.

Тесты, помеченные `test.fixme`, описывают найденные ошибки приложения (см. комментарии над ними):
их надо включить, когда ошибка исправлена.

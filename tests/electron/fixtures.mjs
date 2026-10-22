// Shared setup for the Electron tests: every test gets the real app (main process, IPC, files on
// disk, CLI processes) with a throw-away profile in a temp folder and the fake Codex / Claude Code
// CLIs from tests/electron/bin first on PATH. A test fails if the renderer or the main process
// reported an error.
//   ELECTRON_PATH=<binary> overrides the `electron` package; Linux needs a display (xvfb-run).
import { test as base, expect, _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App as CanvasApp } from '../e2e/fixtures.mjs';

export { expect };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const BIN = path.join(HERE, 'bin');
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function electronPath() {
  if (process.env.ELECTRON_PATH) return process.env.ELECTRON_PATH;
  try {
    return createRequire(import.meta.url)('electron'); // the package's default export is the binary path
  } catch (e) {
    throw new Error(`Electron не найден (${e.message}). Выполните npm install или задайте ELECTRON_PATH.`);
  }
}

// a process that still runs (a zombie waiting for its parent counts as finished)
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  if (process.platform === 'linux') {
    try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
  }
  return true;
}

// Linux CI has no setuid chrome-sandbox (and Ubuntu 24 blocks user namespaces). Under Xvfb there
// is no GPU: Mesa's software GL makes closing a window take up to 10 s, so the GPU is off there
// (ELECTRON_GPU=1 keeps it).
function platformArgs() {
  if (process.platform !== 'linux') return [];
  return ['--no-sandbox', ...(process.env.ELECTRON_GPU === '1' ? [] : ['--disable-gpu'])];
}

// noise that is not a bug of the app
const IGNORED = [
  /favicon|ResizeObserver loop|Failed to load resource/i,
];
// what the main process prints when something threw: an IPC handler, an uncaught exception
const MAIN_ERROR = /Error occurred in handler for|Uncaught|UnhandledPromiseRejection|A JavaScript error occurred/i;

function testEnv(home, extra = {}) {
  const env = { ...process.env };
  // nothing of the developer's own setup leaks in (agent configs, keys, a VS Code shell's ELECTRON_RUN_AS_NODE)
  for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'FAKE_CODEX_SCENARIO', 'FAKE_CLAUDE_SCENARIO']) delete env[k];
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const sysPath = env[pathKey] || '';
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  // the fake CLIs, then the Node.js that runs the tests (the fakes are node scripts)
  env[isWin ? 'Path' : 'PATH'] = [BIN, path.dirname(process.execPath), sysPath].join(path.delimiter);
  Object.assign(env, {
    VIBETABULA_TEST_HOME: home, // main.js: profile, canvases, chats and the vault live here
    HOME: home, // ~/.codex, ~/.claude (os.homedir() on Linux / macOS)
    USERPROFILE: home, // the same on Windows
    FAKE_CLI_STATE: path.join(home, '.fake-cli'),
    FAKE_CLI_NODE: process.execPath,
  });
  if (isWin) Object.assign(env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  else env.SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  // a desktop session is UTF-8; under the C locale Chromium on Linux cannot open files with
  // Cyrillic names (they are silently dropped from file inputs)
  if (process.platform === 'linux' && !/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) { delete env.LC_ALL; env.LANG = 'C.UTF-8'; }
  return { ...env, ...extra };
}

// main.js takes PATH from the user's login shell on Linux / macOS (fixPath), and that one puts the
// system folders first. The test home is $HOME, so its shell profile puts the fake CLIs first —
// just like a user's own ~/.bashrc puts nvm first.
function writeShellProfile(home) {
  if (isWin) return;
  const line = `# tests/electron/fixtures.mjs: the fake agent CLIs and the test's Node.js come first\nexport PATH="${BIN}:${path.dirname(process.execPath)}:$PATH"\n`;
  for (const f of ['.bash_profile', '.profile', '.zshrc']) fs.writeFileSync(path.join(home, f), line);
}

// the fakes must stay executable for Linux / macOS even if the bit got lost (a copy made on Windows)
let executable = false;
function makeExecutable() {
  if (isWin || executable) return;
  for (const f of ['codex', 'claude']) { try { fs.chmodSync(path.join(BIN, f), 0o755); } catch {} }
  executable = true;
}

export class App extends CanvasApp {
  constructor({ home, env = {} }) {
    super(null);
    this.home = home;
    this.extraEnv = env;
    this.errors = [];
    this.allowed = [];
    this.mainLog = '';
    this.electronApp = null;
  }

  get userData() { return path.join(this.home, 'AppData', 'VibeTabula'); }
  get state() { return path.join(this.home, '.fake-cli'); }
  readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

  // errors a test provokes on purpose
  allowErrors(...res) { this.allowed.push(...res); }
  #ignored(text) { return [...IGNORED, ...this.allowed].some((re) => re.test(text)); }
  #error(text) { if (!this.#ignored(text)) this.errors.push(text); }

  async launch() {
    fs.mkdirSync(this.state, { recursive: true });
    makeExecutable();
    writeShellProfile(this.home);
    const app = await _electron.launch({
      executablePath: electronPath(),
      args: [...platformArgs(), ...(process.env.ELECTRON_EXTRA_ARGS || '').split(' ').filter(Boolean), ROOT],
      env: testEnv(this.home, this.extraEnv),
      timeout: 60_000,
    });
    this.electronApp = app;
    const proc = this.proc = app.process(); // not available from Playwright after close()
    let pending = '';
    const onOutput = (d) => {
      this.mainLog += d;
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const l of lines) if (MAIN_ERROR.test(l)) this.#error(`main: ${l.trim()}`);
    };
    proc.stdout?.on('data', onOutput);
    proc.stderr?.on('data', onOutput);
    await app.evaluate(() => {
      global.__testErrors = [];
      process.on('uncaughtException', (e) => global.__testErrors.push(`uncaughtException: ${e?.stack || e}`));
      process.on('unhandledRejection', (e) => global.__testErrors.push(`unhandledRejection: ${e?.stack || e}`));
    });
    const page = await app.firstWindow();
    this.page = page;
    page.on('pageerror', (e) => this.#error(`renderer pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') this.#error(`renderer console: ${m.text()}`); });
    page.on('crash', () => this.#error('renderer crashed'));
    await page.waitForFunction(() => (window.__app?.canvas?.doc && !document.querySelector('#boot')) || /Ошибка запуска/.test(document.querySelector('#boot')?.textContent || ''), null, { timeout: 45_000, polling: 100 });
    const boot = await page.evaluate(() => document.querySelector('#boot')?.textContent || '');
    if (boot) throw new Error(`приложение не запустилось:\n${boot}`);
    // the window is created hidden and shown on ready-to-show; a hidden page does not paint, so
    // clicks would wait for it
    await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 30_000, polling: 100 });
    // a new canvas gets its hub in the first animation frame (canvas.js 'fresh')
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return this;
  }

  // the fake CLIs must be the ones the app finds, not a real Codex / Claude Code of this computer
  async checkFakeClis() {
    const same = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (const cli of ['codex', 'claude']) {
      const found = await this.page.evaluate((c) => window.native.pty.which(c), cli);
      if (!found || !same(path.dirname(found), BIN)) {
        throw new Error(`приложение нашло ${cli} в «${found}», а не тестовый ${path.join(BIN, cli)}: проверьте PATH и профиль оболочки`);
      }
    }
  }

  async #collectMainErrors() {
    if (!this.electronApp) return;
    const errs = await this.electronApp.evaluate(() => global.__testErrors || []).catch(() => []);
    for (const e of errs) this.#error(`main: ${e}`);
  }

  #exited() {
    const proc = this.proc;
    return proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  }

  // quit like the app does (the window flushes pending saves first, see main.js 'close')
  async close() {
    if (!this.electronApp) return;
    const exited = this.#exited();
    await this.#collectMainErrors();
    // app.quit() ourselves: Playwright's close() alone takes ~5 s longer to let the process go
    await this.main(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    await Promise.race([exited, sleep(30_000)]);
    await this.electronApp.close().catch(() => {});
    const proc = this.proc;
    if (proc.exitCode === null && proc.signalCode === null) { this.#error('main: приложение не завершилось за 30 с'); proc.kill(); }
    this.electronApp = null;
  }

  // the user closes the window (title bar ×): resolves when the app process has exited
  async closeWindow() {
    const exited = this.#exited();
    await this.#collectMainErrors();
    const button = this.page.locator('.win-btn.close'); // macOS has its own traffic lights instead
    if (await button.count()) await button.click({ noWaitAfter: true }).catch(() => {});
    else await this.main(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); }).catch(() => {});
    await Promise.race([exited, sleep(30_000).then(() => { throw new Error('окно не закрылось за 30 с'); })]);
    this.electronApp = null;
  }

  async restart() { await this.close(); return this.launch(); }

  // code in the main process: fn receives the electron module
  main(fn, arg) { return this.electronApp.evaluate(fn, arg); }

  // native dialogs answer by themselves; their texts are recorded (dialogs())
  stubDialogs(response = 1) {
    return this.main(({ dialog }, response) => {
      global.__dialogs = [];
      global.__dialogAnswer = response;
      dialog.showMessageBox = async (win, opts) => { const o = opts || win; global.__dialogs.push({ message: o.message, detail: o.detail }); return { response: global.__dialogAnswer }; };
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    }, response);
  }
  dialogs() { return this.main(() => global.__dialogs || []); }
  answerDialogs(response) { return this.main((e, r) => { global.__dialogAnswer = r; }, response); }

  // nothing reaches the OS (browser, Explorer, Trash); calls are recorded (opened())
  stubShell() {
    return this.main(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (url) => { global.__opened.push(['openExternal', url]); };
      shell.openPath = async (p) => { global.__opened.push(['openPath', p]); return ''; };
      shell.showItemInFolder = (p) => { global.__opened.push(['showItemInFolder', p]); };
    });
  }
  opened() { return this.main(() => global.__opened || []); }

  // ---------------- fake CLIs ----------------
  // what the fake agents do from now on: { codex: 'images', claude: 'denied' }
  scenario(s) {
    const file = path.join(this.state, 'scenario.json');
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    fs.writeFileSync(file, JSON.stringify({ ...cur, ...s }));
  }
  // lets a waiting fake (scenario reconnect / slow) go on
  release(cli) { fs.writeFileSync(path.join(this.state, `release-${cli}`), ''); }
  // every start of a fake CLI: { cli, argv, cwd, prompt, pid, childPid, scenario }
  calls(cli) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(this.state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
    return lines.map((l) => JSON.parse(l)).filter((c) => !cli || c.cli === cli);
  }

  // ---------------- agent chat windows ----------------
  async openAgentChat(agentId = 'codex', world = { x: 420, y: 280 }) {
    const id = await this.page.evaluate(([agentId, world]) => window.__app.launchAgentChat({ agentId, world }).id, [agentId, world]);
    await expect(this.el(id).locator('.chat-input')).toBeVisible();
    return id;
  }
  // a window outside the visible canvas is not drawn (culled): show it first, like a person would
  // (the CI Windows screen is only 1024 px wide)
  async reveal(id) {
    const moved = await this.page.evaluate((id) => {
      const c = window.__app.canvas, n = c.node(id), r = c.rect();
      const z = c.vp.z, x = r.left + c.vp.x + n.x * z, y = r.top + c.vp.y + n.y * z;
      if (x >= r.left && y >= r.top && x + n.w * z <= r.right && y + n.h * z <= r.bottom) return false;
      c.vp.x = r.width / 2 - (n.x + n.w / 2) * z; c.vp.y = r.height / 2 - (n.y + n.h / 2) * z;
      c.applyViewport();
      return true;
    }, id);
    if (moved) await this.idle();
  }
  async send(id, text) {
    await this.reveal(id);
    const input = this.el(id).locator('.chat-input');
    await input.fill(text);
    await input.press('Enter');
  }
  messages(id) { return this.page.evaluate((id) => JSON.parse(JSON.stringify(window.__app.canvas.node(id)?.data.messages || [])), id); }
  status(id) { return this.page.evaluate((id) => window.__app.canvas.views.get(id)?.inst?.statusInfo().label, id); }
  // the agent finished: the last answer is complete and the window is idle; returns that answer
  async waitAnswer(id, { timeout = 30_000 } = {}) {
    try {
      await this.page.waitForFunction((id) => {
        const c = window.__app.canvas;
        const msgs = c.node(id)?.data.messages || [];
        const inst = c.views.get(id)?.inst;
        return msgs.length && msgs[msgs.length - 1].role === 'assistant' && !msgs[msgs.length - 1].running && inst && !inst.isBusy();
      }, id, { timeout });
    } catch (e) {
      // CI shows only the error text: put the state of the chat, the CLI calls and the end of the
      // main-process output into it
      const state = await this.page.evaluate((id) => {
        const c = window.__app.canvas, inst = c.views.get(id)?.inst;
        return { status: inst?.statusInfo?.().label, busy: inst?.isBusy?.(), messages: (c.node(id)?.data.messages || []).map((m) => ({ role: m.role, running: m.running, content: (m.content || '').slice(0, 120), parts: (m.parts || []).map((p) => `${p.type}:${(p.text || p.name || '').slice(0, 80)}`) })) };
      }, id).catch((x) => ({ error: String(x) }));
      let calls = [];
      try { calls = this.calls().slice(-3).map((c) => ({ cli: c.cli, scenario: c.scenario, argv: c.argv.join(' ').slice(0, 200) })); } catch {}
      e.message += `\nchat: ${JSON.stringify(state)}\ncalls: ${JSON.stringify(calls)}\nmain: ${this.mainLog.slice(-1500)}`;
      throw e;
    }
    return (await this.messages(id)).at(-1);
  }
}

export const test = base.extend({
  // folder name prefix of the throw-away profile (a test may want spaces or Cyrillic in it)
  homePrefix: ['vibetabula-e2e-', { option: true }],

  home: async ({ homePrefix }, use) => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), homePrefix)));
    await use(home);
    // Windows keeps files locked for a moment after the processes exit
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.warn(`не удалось удалить ${home}: ${e.message}`); }
  },

  // launchApp({ env }) starts the app on the test's profile; files can be put into `home` before
  launchApp: async ({ home }, use, testInfo) => {
    const apps = [];
    await use(async (opts = {}) => {
      const app = new App({ home, ...opts });
      apps.push(app);
      await app.launch();
      return app;
    });
    for (const app of apps) {
      try { await app.close(); } catch (e) { app.errors.push(`close: ${e.message}`); }
      if (app.mainLog && testInfo.status !== testInfo.expectedStatus) await testInfo.attach('main-process.log', { body: app.mainLog, contentType: 'text/plain' });
    }
    for (const app of apps) expect(app.errors, 'ни renderer, ни main-процесс не должны сообщать об ошибках').toEqual([]);
  },

  // a running app with an empty canvas
  app: async ({ launchApp }, use) => {
    const app = await launchApp();
    await app.checkFakeClis();
    await app.reset();
    await use(app);
  },
});

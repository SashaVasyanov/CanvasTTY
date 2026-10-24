// Terminals on the canvas run a real shell through the pty bridge of the main process (python on
// Linux / macOS, a ConPTY bridge compiled with csc.exe on Windows); the session lives in the main
// process, so it survives its window being re-created.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

const isWin = process.platform === 'win32';
// prints "<mark> 42 <name of the current folder>" in bash and in PowerShell
const echo = (mark) => (isWin ? `Write-Output "${mark} $(6*7) $(Split-Path -Leaf (Get-Location))"` : `echo "${mark} $((6*7)) \${PWD##*/}"`);
// prints "<mark>_42" a moment later (the typed line has the formula, only the output has "42")
const later = (mark) => (isWin ? `Start-Sleep -Milliseconds 1500; Write-Output "${mark}_$(6*7)"` : `sleep 1.5; echo "${mark}_$((6*7))"`);
// raw pty output without colours / cursor moves (ConPTY on Windows redraws a lot)
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g, '');

async function openShell(app) {
  const id = await app.page.evaluate(() => window.__app.launchAgent({ agentId: 'shell', world: { x: 420, y: 260 } }).id);
  await expect.poll(() => app.page.evaluate((id) => window.__app.canvas.views.get(id)?.inst?.state, id), { timeout: 45_000, message: 'оболочка запустилась' }).toBe('running');
  return id;
}
const tail = (app, id) => app.page.evaluate((id) => window.__app.canvas.views.get(id)?.inst?.tailText() || '', id);
async function type(app, id, line) {
  await app.el(id).locator('.xterm').click();
  await app.page.keyboard.type(line);
  await app.page.keyboard.press('Enter');
}

test('терминал: оболочка в папке проекта выполняет набранную команду', async ({ app, home }) => {
  const term = await openShell(app);
  await type(app, term, echo('CANVAS_OK'));
  // the typed line has "$((6*7))", only the output has "42"
  await expect.poll(() => tail(app, term), { timeout: 30_000 }).toContain(`CANVAS_OK 42 ${path.basename(home)}`);
  expect(await app.status(term)).not.toBe('Статус недоступен');
});

test('сессия терминала продолжает работать, пока открыт другой canvas', async ({ app }) => {
  const term = await openShell(app);
  const session = await app.page.evaluate((id) => window.__app.canvas.node(id).data.sessionId, term);
  await type(app, term, later('LATER'));

  // the window is destroyed with its canvas; the process and its output stay in the main process
  await app.page.evaluate(async () => { const { state } = await import('/js/state.js'); await state.createCanvas(state.project.id, 'Второй'); });
  await expect(app.page.locator('.ctab.active')).toHaveText('Второй');
  await expect(app.el(term)).toHaveCount(0);
  await expect.poll(async () => plain(await app.page.evaluate((s) => window.native.pty.attach(s).then((a) => a?.buffer || ''), session)), { timeout: 20_000 }).toContain('LATER_42');

  await app.page.locator('.ctab', { hasText: 'Главный' }).click();
  await expect.poll(() => tail(app, term)).toContain('LATER_42');
  expect(await app.page.evaluate((id) => window.__app.canvas.node(id).data.sessionId, term)).toBe(session);
  expect((await app.page.evaluate(() => window.native.pty.statuses()))[session]).toMatchObject({ exited: false });
  await type(app, term, echo('STILL_HERE'));
  await expect.poll(() => tail(app, term), { timeout: 20_000 }).toContain('STILL_HERE 42');
});

// Claude Code / Codex in a terminal window keep their own session; after a restart of the app the
// window continues exactly that one (the fake CLIs in a pty act like the interactive ones:
// tests/electron/bin/fake-cli.cjs interactive)
async function openAgent(app, agentId, world) {
  const id = await app.page.evaluate(([agentId, world]) => window.__app.launchAgent({ agentId, world }).id, [agentId, world]);
  return id;
}
const ownSession = (app, id) => app.page.evaluate((id) => window.__app.canvas.node(id).data.agentSession, id);
const ttyCalls = (app, cli) => app.calls(cli).filter((c) => c.tty);

test('Claude Code и Codex в терминале: своя сессия, после перезапуска приложения — продолжение именно её', async ({ app }) => {
  const cl = await openAgent(app, 'claude', { x: 420, y: 260 });
  await expect.poll(() => tail(app, cl), { timeout: 45_000, message: 'Claude запустился' }).toContain('Fake Claude: new session');
  const sid = (await ownSession(app, cl)).id;
  expect(sid).toMatch(/^[0-9a-f-]{36}$/);
  expect(await tail(app, cl)).toContain(sid);
  expect(ttyCalls(app, 'claude')[0].argv.slice(0, 2)).toEqual(['--session-id', sid]);
  await type(app, cl, 'hello');
  await expect.poll(() => tail(app, cl), { timeout: 20_000 }).toContain('ok: hello');

  const cx = await openAgent(app, 'codex', { x: 420, y: 700 });
  await expect.poll(() => tail(app, cx), { timeout: 45_000, message: 'Codex запустился' }).toContain('Fake Codex: new session');
  await expect.poll(async () => (await ownSession(app, cx))?.id, { timeout: 20_000, message: 'id сессии Codex найден' }).toMatch(/^[0-9a-f-]{36}$/);
  const cxid = (await ownSession(app, cx)).id;
  expect(await tail(app, cx)).toContain(cxid);

  await app.restart();
  await expect.poll(() => tail(app, cl), { timeout: 45_000 }).toContain(`Fake Claude: resumed session ${sid}`);
  await expect.poll(() => tail(app, cx), { timeout: 45_000 }).toContain(`Fake Codex: resumed session ${cxid}`);
  expect(ttyCalls(app, 'claude').at(-1).argv.slice(0, 2)).toEqual(['--resume', sid]);
  expect(ttyCalls(app, 'codex').at(-1).argv.slice(-2)).toEqual(['resume', cxid]);
});

// Exact statuses from the agents themselves (main/pty.js signals): Claude Code hooks from the
// --settings file VibeTabula gives it, Codex OSC 9 notifications; with the window on screen the
// status changes, with the app in the background the window also goes to «Ждут вас»
test('статусы терминальных агентов по их сигналам: «Готово», «Ждёт ответа», и в «Ждут вас»', async ({ app }) => {
  const cl = await openAgent(app, 'claude', { x: 420, y: 260 });
  await expect.poll(() => tail(app, cl), { timeout: 45_000 }).toContain('Fake Claude: new session');
  const argv = ttyCalls(app, 'claude')[0].argv;
  const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
  expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'Stop', 'UserPromptSubmit']);
  await type(app, cl, 'hello');
  await expect.poll(() => app.status(cl), { timeout: 20_000, message: 'Stop → «Готово»' }).toBe('Готово');
  await type(app, cl, 'perm');
  await expect.poll(() => app.status(cl), { timeout: 20_000, message: 'Notification → «Ждёт ответа»' }).toBe('Ждёт ответа');
  expect(await app.page.evaluate((id) => window.__app.canvas.views.get(id).inst.statusInfo().detail, cl)).toBe('needs your permission to use Bash');

  const cx = await openAgent(app, 'codex', { x: 420, y: 760 });
  await expect.poll(() => tail(app, cx), { timeout: 45_000 }).toContain('Fake Codex: new session');
  // the app in the background: the finished Codex goes to «Ждут вас»
  await app.page.evaluate(() => { document.hasFocus = () => false; });
  await app.page.evaluate((id) => { const v = window.__app.canvas.views.get(id).inst; v.sendText('approve?', true); }, cx);
  await expect.poll(() => app.status(cx), { timeout: 20_000, message: 'OSC 9 запрос → «Ждёт ответа»' }).toBe('Ждёт ответа');
  await expect.poll(() => app.page.evaluate(async () => (await import('./js/inbox.js')).inbox.items.map((x) => [x.title.includes('Codex'), x.kind])), { timeout: 10_000 }).toContainEqual([true, 'wait']);
});

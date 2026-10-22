// Terminals on the canvas run a real shell through the pty bridge of the main process (python on
// Linux / macOS, a ConPTY bridge compiled with csc.exe on Windows); the session lives in the main
// process, so it survives its window being re-created.
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

const isWin = process.platform === 'win32';
// prints "<mark> 42 <name of the current folder>" in bash and in PowerShell
const echo = (mark) => (isWin ? `Write-Output "${mark} $(6*7) $(Split-Path -Leaf (Get-Location))"` : `echo "${mark} $((6*7)) \${PWD##*/}"`);
const later = (mark) => (isWin ? `Start-Sleep -Milliseconds 1500; Write-Output "${mark}"` : `sleep 1.5; echo "${mark}"`);

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
  await type(app, term, later('LATER_MARK'));

  // the window is destroyed with its canvas; the process and its output stay in the main process
  await app.page.evaluate(async () => { const { state } = await import('/js/state.js'); await state.createCanvas(state.project.id, 'Второй'); });
  await expect(app.page.locator('.ctab.active')).toHaveText('Второй');
  await expect(app.el(term)).toHaveCount(0);
  await expect.poll(() => app.page.evaluate((s) => window.native.pty.attach(s).then((a) => a?.buffer || ''), session), { timeout: 20_000 }).toMatch(/LATER_MARK\r?\n/);

  await app.page.locator('.ctab', { hasText: 'Главный' }).click();
  await expect.poll(() => tail(app, term)).toMatch(/^LATER_MARK$/m);
  expect(await app.page.evaluate((id) => window.__app.canvas.node(id).data.sessionId, term)).toBe(session);
  expect((await app.page.evaluate(() => window.native.pty.statuses()))[session]).toMatchObject({ exited: false });
  await type(app, term, echo('STILL_HERE'));
  await expect.poll(() => tail(app, term), { timeout: 20_000 }).toContain('STILL_HERE 42');
});

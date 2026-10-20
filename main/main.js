const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Menu, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { PtyManager } = require('./pty');
const { Vault } = require('./vault');
const { ChatManager, PROVIDERS } = require('./chat');
const { getLimits } = require('./limits');
const { AgentChatManager, agentDefaults } = require('./agentchat');

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
let userData, wsFile, canvasDir, usageFile;
let usageLog = {};

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const ptys = new PtyManager({ userData: app.getPath('userData'), send });
const vault = new Vault({ send });
const agentChat = new AgentChatManager({ send, ptys });
const chat = new ChatManager({
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
    frame: false,
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
  Menu.setApplicationMenu(null);
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
    const file = path.join(RENDERER, path.normalize(p));
    if (!file.startsWith(RENDERER)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // ---------- window ----------
  ipcMain.handle('win:minimize', () => win.minimize());
  ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.handle('win:close', () => win.close());
  ipcMain.handle('win:isMaximized', () => win.isMaximized());
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, home: app.getPath('home'), userData }));

  // ---------- storage ----------
  ipcMain.handle('ws:load', () => loadWorkspace());
  ipcMain.handle('ws:save', (e, ws) => writeJson(wsFile, ws));
  ipcMain.handle('canvas:load', (e, id) => readJsonSync(path.join(canvasDir, `${id}.json`), null));
  ipcMain.handle('canvas:save', (e, id, data) => writeJson(path.join(canvasDir, `${id}.json`), data));
  ipcMain.handle('canvas:delete', async (e, id) => { try { await fsp.unlink(path.join(canvasDir, `${id}.json`)); } catch {} });

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

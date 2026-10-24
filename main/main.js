const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Menu, clipboard, nativeImage, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { PtyManager } = require('./pty');
const { Vault } = require('./vault');
const { ChatManager, PROVIDERS } = require('./chat');
const { getLimits } = require('./limits');
const { AgentChatManager, agentDefaults } = require('./agentchat');
const { CanvasBridge } = require('./canvas-bridge');
const { SearchIndex } = require('./search');
const { HistoryStore, listSessions, readSession } = require('./history');
const { Attachments } = require('./attachments');
// automated tests run the app against a throw-away profile: settings, canvases, chats and the
// notes vault all live in that folder, never in the user's own data
function useTestHome() {
  if (!process.env.VIBETABULA_TEST_HOME) return false;
  const home = path.resolve(process.env.VIBETABULA_TEST_HOME);
  app.setPath('home', home);
  app.setPath('appData', path.join(home, 'AppData'));
  app.setPath('userData', path.join(home, 'AppData', 'VibeTabula'));
  app.setPath('documents', path.join(home, 'Documents'));
  return true;
}
useTestHome();
const { SyncManager } = require('./sync');
const changes = require('./changes');
const worktrees = require('./worktrees');
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

app.setName('VibeTabula');
useTestHome(); // setName must not move a test profile back to the real one
// The app used to be called CanvasTTY: its data folder (workspace, canvases, chats, approved
// commands…) moves to the new name once. If Electron already created the new folder at start-up
// (crash reporter, caches), the old entries are moved into it; if moving is impossible, the old
// folder is simply used as is.
(function migrateUserData() {
  try {
    const appData = app.getPath('appData');
    const oldDir = path.join(appData, 'CanvasTTY'), newDir = path.join(appData, 'VibeTabula');
    if (!fs.existsSync(path.join(oldDir, 'workspace.json')) || fs.existsSync(path.join(newDir, 'workspace.json'))) return;
    if (!fs.existsSync(newDir)) { fs.renameSync(oldDir, newDir); return; }
    for (const name of fs.readdirSync(oldDir)) {
      const to = path.join(newDir, name);
      if (!fs.existsSync(to)) fs.renameSync(path.join(oldDir, name), to);
    }
  } catch { try { app.setPath('userData', path.join(app.getPath('appData'), 'CanvasTTY')); } catch {} }
})();
// Chat attachments: the folder used to be created before the move above, so the old CanvasTTY
// attachments stayed behind and pictures in old chats showed as unavailable. Copy what is missing
// (once; the old folder is left as it is).
(function migrateAttachments() {
  try {
    const oldA = path.join(app.getPath('appData'), 'CanvasTTY', 'attachments');
    const newA = path.join(app.getPath('userData'), 'attachments');
    const mark = path.join(newA, '.from-canvastty');
    if (oldA === newA || !fs.existsSync(oldA) || fs.existsSync(mark)) return;
    fs.mkdirSync(newA, { recursive: true });
    for (const name of fs.readdirSync(oldA)) {
      const to = path.join(newA, name);
      if (!fs.existsSync(to)) { try { fs.copyFileSync(path.join(oldA, name), to); } catch {} }
    }
    fs.writeFileSync(mark, '');
  } catch {}
})();
const attachments = new Attachments(app.getPath('userData'));
// rendering performance: GPU rasterization even on blocklisted drivers
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');
if (process.platform === 'win32') app.setAppUserModelId('VibeTabula');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const RENDERER = path.join(__dirname, '..', 'renderer');
// Only web and mail links go to the OS. Other schemes (file:, smb:, search-ms:, ms-msdt:, custom
// app handlers) can start programs on Windows and must never come from a note, a page or the model.
function safeExternal(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return false;
  shell.openExternal(u.toString());
  return true;
}
let win = null;
let canvasBridge = null;
let canvasToolsReady = false; // the page answers canvas-tool requests (renderer/js/canvasTools.js)
const canvasReadyWaiters = [];
let userData, wsFile, canvasDir, usageFile, sync = null;
let usageLog = {};

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const ptys = new PtyManager({ userData: app.getPath('userData'), send });
const { Trust } = require('./trust');
const trust = new Trust({ userData: app.getPath('userData'), getWin: () => win });
ptys.trust = trust;
const vault = new Vault({ send });
const agentChat = new AgentChatManager({ send, ptys, userData: app.getPath('userData'), attachments });
agentChat.trust = trust;
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

// Saves of one file run one after another, each through its own temp file: two overlapping saves
// (the delayed save and the flush when the window closes) used to share "<file>.tmp" and could
// leave a broken canvas. The newest save is written last.
const writeQueues = new Map();
// jobs on one file (writes, and reads that must not see a half-done sequence) one after another
function queueFile(file, job) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  writeQueues.set(file, next);
  next.then(() => {}, () => {}).then(() => { if (writeQueues.get(file) === next) writeQueues.delete(file); });
  return next;
}
async function writeNow(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  // Windows: an antivirus or a cloud client may hold the target for a moment
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, file); return; } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await fsp.unlink(tmp).catch(() => {}); throw e; }
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}
function writeJson(file, data) {
  const text = JSON.stringify(data, null, 1); // the state at the moment of the call
  return queueFile(file, () => writeNow(file, text));
}
// A canvas that is not on screen is changed in its file by the window (an agent's canvas tools, a
// passed answer, a finished answer): read with its version, written back only if nobody (a save,
// sync from another computer) wrote it in between — otherwise the window reads it again and redoes
// its change (renderer/js/state.js editCanvasFile).
const versionOf = (buf) => (buf ? require('crypto').createHash('sha1').update(buf).digest('hex') : '');
const readBuf = (file) => { try { return fs.readFileSync(file); } catch { return null; } };
function readVersioned(file) {
  return queueFile(file, async () => { const buf = readBuf(file); let doc = null; try { doc = buf ? JSON.parse(buf.toString('utf8')) : null; } catch {} return { doc, ver: versionOf(buf) }; });
}
function writeJsonIf(file, data, ver) {
  const text = JSON.stringify(data, null, 1);
  return queueFile(file, async () => { if (versionOf(readBuf(file)) !== ver) return false; await writeNow(file, text); return true; });
}
function readJsonSync(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const { encodeWs, decodeWs } = require('./secrets');
function loadWorkspace() {
  return decodeWs(readJsonSync(wsFile, null));
}

function ensureVault(ws) {
  // default vault: a "CanvasTTY Vault" from the old name stays in use (it may also be open in Obsidian)
  const docs = app.getPath('documents');
  const oldVault = path.join(docs, 'CanvasTTY Vault'), newVault = path.join(docs, 'VibeTabula Vault');
  const vp = (ws && ws.settings && ws.settings.vaultPath) || (!fs.existsSync(newVault) && fs.existsSync(oldVault) ? oldVault : newVault);
  const fresh = !fs.existsSync(vp) || fs.readdirSync(vp).length === 0;
  vault.setRoot(vp);
  if (fresh) {
    const welcome = [
      '# Добро пожаловать в VibeTabula',
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
    const ideas = '# Идеи\n\nСюда можно складывать идеи для проектов. Обратная ссылка: [[Добро пожаловать в VibeTabula]]\n\n- Сделать агента для ревью кода #идея\n';
    fs.writeFileSync(path.join(vp, 'Добро пожаловать в VibeTabula.md'), welcome);
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
  win.loadURL('app://vibetabula/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-start-loading', () => { canvasToolsReady = false; }); // a reload: wait for the page again
  // let the page write pending edits (debounced saves) before the window goes away
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose || win.webContents.isCrashed?.()) return;
    e.preventDefault();
    const done = () => { if (allowClose) return; allowClose = true; clearTimeout(t); ipcMain.removeListener('app:flushed', done); if (!win.isDestroyed()) win.close(); };
    const t = setTimeout(done, 2500);
    ipcMain.once('app:flushed', done);
    send('app:flush');
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { safeExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); safeExternal(url); } });
  // web pages on the canvas (<webview>): no node, no preload, own sandbox, http(s) only
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
    if (!/^https?:\/\//i.test(params.src || '')) e.preventDefault();
  });
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

// Permissions: the app itself may use what it needs; web pages on the canvas get nothing that
// touches the camera, microphone, location, screen, files or devices.
const PAGE_OK = new Set(['fullscreen', 'clipboard-sanitized-write']);
const isAppUrl = (u) => String(u || '').startsWith('app://');
// guests (<webview> pages): popups go to the browser (web links only), no navigation to other schemes
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => { safeExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (ev, url) => { if (!/^https?:\/\//i.test(url)) ev.preventDefault(); });
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(isAppUrl(details?.requestingUrl || wc?.getURL?.()) || PAGE_OK.has(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => isAppUrl(origin) || isAppUrl(wc?.getURL?.()) || PAGE_OK.has(permission));
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
    if (!file.startsWith(RENDERER + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // ---------- window ----------
  ipcMain.handle('win:minimize', () => win.minimize());
  ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.handle('win:close', () => win.close());
  ipcMain.handle('win:isMaximized', () => win.isMaximized());
  // «Ждут вас»: a click on the system notification brings the window back; the taskbar button
  // flashes while an agent is done and the window is not in focus
  ipcMain.handle('win:focus', () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  ipcMain.handle('win:attention', () => { if (!win.isFocused()) win.flashFrame(true); });
  ipcMain.handle('perf:info', async () => ({
    gpu: app.getGPUFeatureStatus(),
    gpuInfo: await app.getGPUInfo('basic').catch(() => null),
    displays: screen.getAllDisplays().map((d) => ({ size: d.size, scale: d.scaleFactor, hz: d.displayFrequency })),
    platform: process.platform, electron: process.versions.electron,
  }));
  ipcMain.handle('perf:save', (e, report) => {
    const txt = JSON.stringify(report, null, 2);
    const out = [];
    for (const f of [path.join(userData, 'perf-report.json')]) {
      try { fs.writeFileSync(f, txt); out.push(f); } catch {}
    }
    return out[0] || '';
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, home: app.getPath('home'), userData, host: os.hostname() }));

  // ---------- storage ----------
  ipcMain.handle('ws:load', () => loadWorkspace());
  ipcMain.handle('ws:save', async (e, ws) => { await writeJson(wsFile, encodeWs(ws)); sync?.localChanged('workspace', 'workspace', ws); });
  // waits for saves of that file still being written (a canvas just left is flushed on the way out)
  ipcMain.handle('canvas:load', async (e, id) => { const f = path.join(canvasDir, `${id}.json`); await writeQueues.get(f)?.catch(() => {}); return readJsonSync(f, null); });
  ipcMain.handle('canvas:loadVer', (e, id) => readVersioned(path.join(canvasDir, `${id}.json`)));
  ipcMain.handle('canvas:saveIf', async (e, id, data, ver) => { const ok = await writeJsonIf(path.join(canvasDir, `${id}.json`), data, ver); if (ok) sync?.localChanged('canvas', id, data); return ok; });
  ipcMain.handle('canvas:save', async (e, id, data) => { await writeJson(path.join(canvasDir, `${id}.json`), data); sync?.localChanged('canvas', id, data); });
  ipcMain.handle('canvas:delete', async (e, id) => { try { await fsp.unlink(path.join(canvasDir, `${id}.json`)); } catch {} sync?.localDeleted('canvas', id); });

  // ---------- pty ----------
  ipcMain.handle('pty:spawn', (e, opts) => ptys.spawn(opts));
  // commands typed in Settings on this computer (not from sync) are trusted
  ipcMain.handle('trust:add', (e, keys) => { trust.add(keys); return true; });
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
  ipcMain.handle('agentchat:attach', (e, o) => agentChat.attach(o));
  ipcMain.handle('agentchat:release', (e, reqId) => agentChat.release(reqId));
  ipcMain.handle('agentchat:background', () => agentChat.background().map(({ dir, ...r }) => r));
  ipcMain.handle('agentchat:defaults', () => agentDefaults());
  // where Codex keeps the pictures it generated in a session (~/.codex/generated_images/<session>)
  ipcMain.handle('agentchat:imagesDir', (e, sid) => {
    const root = path.join(process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex'), 'generated_images');
    const dir = sid ? path.join(root, path.basename(String(sid))) : root;
    return fs.existsSync(dir) ? dir : fs.existsSync(root) ? root : '';
  });
  // ---------- chat history ----------
  const history = new HistoryStore(path.join(userData, 'chats'));
  // ---------- sync between computers ----------
  sync = new SyncManager({ userData, wsFile, canvasDir, history, send, encodeWs, decodeWs, writeLocal: writeJson });
  history.onChange = (op, v) => (op === 'save' ? sync.localChanged('chat', v.id, v) : sync.localDeleted('chat', v));
  ipcMain.handle('sync:info', () => sync.info());
  ipcMain.handle('sync:configure', (e, patch) => sync.configure(patch || {}));
  ipcMain.handle('sync:now', async () => { await sync.reconcile(); return sync.info(); });
  ipcMain.handle('sync:adoptVault', async () => { const dest = await sync.adoptVault(vault.root); vault.setRoot(dest); return dest; });
  // started once the window listens, so no change from another computer is missed
  ipcMain.handle('sync:ready', () => { sync.start(); return sync.info(); });
  ipcMain.handle('history:list', (e, q) => history.list(q || {}));
  // search across everything (Ctrl+K): canvases, notes, saved conversations (main/search.js)
  const searchIndex = new SearchIndex({ canvasDir, history, vault, waitFile: (f) => writeQueues.get(f)?.catch(() => {}) });
  ipcMain.handle('search:all', (e, q, o) => searchIndex.search(String(q || '').slice(0, 200), { canvasIds: Array.isArray(o?.canvasIds) ? o.canvasIds.slice(0, 500) : [], limit: Math.min(50, Number(o?.limit) || 30) }));
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
  ipcMain.handle('vault:createNumbered', (e, folder, name, content) => vault.createNumbered(folder, name, content));
  ipcMain.handle('vault:mkdir', (e, rel) => vault.mkdir(rel));
  ipcMain.handle('vault:rename', (e, a, b) => vault.rename(a, b));
  ipcMain.handle('vault:styles', () => vault.styles());
  ipcMain.handle('vault:setStyle', (e, rel, style) => vault.setStyle(rel, style));
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
  ipcMain.handle('shell:open', (e, url) => safeExternal(url));
  // what an agent changed in its git folder during one answer (main/changes.js)
  ipcMain.handle('changes:snapshot', (e, dir) => changes.snapshot(String(dir || '')));
  ipcMain.handle('changes:since', (e, snap) => changes.changesSince(snap));
  ipcMain.handle('changes:patch', (e, o) => changes.patch(path.resolve(String(o.root)), String(o.before), String(o.after), String(o.file)));
  ipcMain.handle('changes:restore', (e, o) => changes.restore({ root: String(o.root), from: String(o.from), expect: String(o.expect), files: (o.files || []).map(String),
    // a file the agent created goes to the recycle bin; where there is none (some Linux setups) it is
    // removed — «Вернуть» brings it back from git anyway
    trash: async (abs) => { try { await shell.trashItem(abs); } catch { fs.unlinkSync(abs); } } }));
  // a separate copy of the project for an agent chat (main/worktrees.js)
  ipcMain.handle('wt:isRepo', async (e, dir) => !!(await changes.rootOf(String(dir || ''))));
  ipcMain.handle('wt:create', (e, o) => worktrees.create({ cwd: String(o?.cwd || ''), name: String(o?.name || '') }));
  ipcMain.handle('wt:status', (e, w) => worktrees.status(w));
  ipcMain.handle('wt:preview', (e, w) => worktrees.preview(w));
  ipcMain.handle('wt:merge', (e, w) => worktrees.merge(w));
  ipcMain.handle('wt:remove', (e, w, o) => worktrees.remove(w, { force: !!o?.force, dropBranch: !!o?.dropBranch }));
  // only shows the file in Explorer (opening it could start a program: .bat, .js, .exe…)
  ipcMain.handle('changes:reveal', (e, o) => {
    const root = path.resolve(String(o.root)), abs = path.resolve(root, String(o.file));
    if (!abs.startsWith(root + path.sep)) return false;
    if (fs.existsSync(abs)) shell.showItemInFolder(abs); else if (fs.existsSync(path.dirname(abs))) shell.openPath(path.dirname(abs));
    return true;
  });
  // folders only (opening a file could run it)
  ipcMain.handle('shell:openPath', (e, p) => { try { if (fs.statSync(String(p)).isDirectory()) return shell.openPath(String(p)); } catch {} return 'Можно открыть только папку'; });
  // a file an agent made or named in a chat: shown in Explorer / Finder (selected in its folder).
  // Nothing is opened or run — a folder opens as a folder, a file only gets selected.
  // { path, cwd }: a relative path is taken from the chat's working folder. → '' or what went wrong
  ipcMain.handle('shell:reveal', (e, o) => {
    let p = String(o?.path || '').trim();
    if (!p || p.length > 4096) return 'Пустой путь';
    if (/^file:/i.test(p)) { try { p = require('url').fileURLToPath(p); } catch { return 'Неверный путь'; } }
    if (/^~(?=[\\/]|$)/.test(p)) p = path.join(os.homedir(), p.slice(1));
    p = p.replace(/#L\d+(-L?\d+)?$/i, '').replace(/(\.[^\\/.:]+):\d+(:\d+)?$/, '$1'); // file.py:12, file.py#L12
    if (!path.isAbsolute(p)) {
      const base = String(o?.cwd || '');
      if (!base || !path.isAbsolute(base)) return 'Путь указан относительно папки, которой здесь нет';
      p = path.resolve(base, p);
    }
    p = path.normalize(p);
    try { if (fs.statSync(p).isDirectory()) { shell.openPath(p); return ''; } shell.showItemInFolder(p); return ''; } catch {}
    const dir = path.dirname(p);
    try { if (fs.statSync(dir).isDirectory()) { shell.openPath(dir); return 'Файла уже нет — открыта папка, где он был'; } } catch {}
    return 'Файл не найден на этом компьютере';
  });
  ipcMain.handle('clipboard:write', (e, text) => clipboard.writeText(text));

  // canvas tools of the agents: the MCP server of a run asks here, the window (renderer/js/canvasTools.js) answers
  const pendingCanvas = new Map();
  let canvasSeq = 0;
  ipcMain.on('canvastools:ready', (e) => {
    if (!win || e.sender !== win.webContents) return;
    canvasToolsReady = true;
    for (const f of canvasReadyWaiters.splice(0)) f();
  });
  // a request that comes while the page is still loading (the app was just started) waits for it
  const pageReady = (ms) => (canvasToolsReady ? Promise.resolve(true) : new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { const i = canvasReadyWaiters.indexOf(done); if (i >= 0) canvasReadyWaiters.splice(i, 1); resolve(false); }, ms);
    canvasReadyWaiters.push(done);
  }));
  ipcMain.on('canvastools:reply', (e, r) => {
    if (!win || e.sender !== win.webContents || !r) return;
    const p = pendingCanvas.get(r.id);
    if (!p) return;
    pendingCanvas.delete(r.id); clearTimeout(p.timer);
    if (r.error) p.reject(new Error(String(r.error))); else p.resolve(r.result);
  });
  canvasBridge = new CanvasBridge({
    userData,
    resolve: (token) => agentChat.canvasTarget(token),
    request: async (target, op, args) => {
      if (!(await pageReady(15000))) throw new Error('Окно VibeTabula ещё не готово — попробуйте ещё раз');
      return askPage(target, op, args);
    },
  }).start((pipe) => { agentChat.canvasPipe = pipe; });
  function askPage(target, op, args) {
    return new Promise((resolve, reject) => {
      if (!win || win.isDestroyed()) { reject(new Error('Окно VibeTabula закрыто')); return; }
      const id = ++canvasSeq;
      const timer = setTimeout(() => { pendingCanvas.delete(id); reject(new Error('Окно VibeTabula не ответило (возможно, оно ещё загружается) — попробуйте ещё раз')); }, 15000);
      pendingCanvas.set(id, { resolve, reject, timer });
      send('canvastools:request', { id, ...target, op, args, deadline: Date.now() + 12000 }); // the page gives up before this does
    });
  }

  createWindow();
});

// agent chats keep answering in the background (agent-runner.js) unless that is turned off
app.on('window-all-closed', () => { ptys.killAll(); agentChat.onQuit(); canvasBridge?.stop(); app.quit(); });
app.on('before-quit', () => ptys.killAll());

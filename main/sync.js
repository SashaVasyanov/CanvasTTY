// Sync between computers through a shared folder (iCloud Drive, Dropbox, Google Drive,
// OneDrive, Яндекс Диск, Syncthing, a network share…). No server and no account: every
// change is written to the folder as a small JSON "envelope" with a timestamp, and the
// newest version of each item wins. Projects, canvases and chat history are synced;
// notes can live in the same folder (they are plain .md files).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const KINDS = { canvas: 'canvases', chat: 'chats' };

// CommonJS copy of renderer/js/merge.js
function mergeDocs(base, local, remote) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mergeList = (b, l, r) => {
    const bm = new Map((b || []).map((x) => [x.id, x]));
    const lm = new Map((l || []).map((x) => [x.id, x]));
    const rm = new Map((r || []).map((x) => [x.id, x]));
    const out = [];
    const ids = new Set([...rm.keys(), ...lm.keys()]);
    for (const id of ids) {
      const bv = bm.get(id), lv = lm.get(id), rv = rm.get(id);
      if (rv && lv) out.push(base && same(rv, bv) ? lv : rv);
      else if (rv && !lv) { if (!base || !bv || !same(rv, bv)) out.push(rv); } // deleted here and unchanged there → stays deleted
      else if (lv && !rv) { if (!base || !bv || !same(lv, bv)) out.push(lv); } // deleted there and unchanged here → delete
    }
    // keep the remote order, then local additions
    const order = new Map([...(r || []), ...(l || [])].map((x, i) => [x.id, i]));
    return out.sort((a, b) => order.get(a.id) - order.get(b.id));
  };
  return { ...local, ...remote, nodes: mergeList(base?.nodes, local?.nodes, remote?.nodes), edges: mergeList(base?.edges, local?.edges, remote?.edges) };
}

const hashOf = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const readJson = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));
async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

class SyncManager {
  constructor({ userData, wsFile, canvasDir, history, send }) {
    this.userData = userData; this.wsFile = wsFile; this.canvasDir = canvasDir; this.history = history; this.send = send;
    this.cfgFile = path.join(userData, 'sync.json');
    this.baseDir = path.join(userData, 'sync-base'); // last version both sides agreed on, per canvas
    this.stateFile = path.join(userData, 'sync-state.json');
    this.cfg = this.load(this.cfgFile, { enabled: false, dir: '', keys: false });
    this.st = this.load(this.stateFile, {});
    if (!this.st.deviceId) this.st.deviceId = crypto.randomUUID();
    this.st.items = this.st.items || {};
    this.mtimes = new Map(); // remote file -> mtime seen, to skip unchanged files
    this.status = { state: 'off', last: 0, error: '', pushed: 0, pulled: 0 };
    this.busy = false;
    this.saveState();
  }
  load(f, d) { try { return { ...d, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return d; } }
  saveState() { clearTimeout(this._stT); this._stT = setTimeout(() => fsp.writeFile(this.stateFile, JSON.stringify(this.st)).catch(() => {}), 200); }
  get root() {
    if (!this.cfg.dir) return '';
    return path.basename(this.cfg.dir) === 'CanvasTTY Sync' ? this.cfg.dir : path.join(this.cfg.dir, 'CanvasTTY Sync');
  }
  get on() { return !!(this.cfg.enabled && this.cfg.dir); }
  info() {
    return { ...this.cfg, root: this.root, device: os.hostname(), deviceId: this.st.deviceId, status: this.status, items: Object.keys(this.st.items).length };
  }

  // ---------------- what is synced ----------------
  strip(kind, data) {
    const d = clone(data);
    if (kind === 'workspace') {
      delete d.activeProjectId; delete d.activeCanvasId;
      if (d.settings) {
        delete d.settings.vaultPath; // each computer has its own path
        if (!this.cfg.keys) delete d.settings.providers; // API keys stay on this computer unless asked
      }
      for (const p of d.projects || []) delete p.cwd; // folders differ between computers
    } else if (kind === 'canvas') {
      delete d.viewport; delete d.fresh;
    }
    return d;
  }
  remoteFile(kind, id) { return kind === 'workspace' ? path.join(this.root, 'workspace.json') : path.join(this.root, KINDS[kind], `${String(id).replace(/[^\w-]/g, '')}.json`); }
  key(kind, id) { return `${kind}:${id}`; }

  baseFile(id) { return path.join(this.baseDir, `${String(id).replace(/[^\w-]/g, '')}.json`); }
  // recent versions of each canvas by hash: every envelope names the version it was edited
  // from ("parent"), which gives the merge a true common ancestor
  async readVersions(id) { try { return await readJson(this.baseFile(id)); } catch { return { order: [], v: {} }; } }
  async addVersion(id, hash, body) {
    const b = await this.readVersions(id);
    if (!b.v[hash]) { b.v[hash] = body; b.order.push(hash); }
    while (b.order.length > 12) delete b.v[b.order.shift()];
    try { await writeAtomic(this.baseFile(id), b); } catch {}
  }
  async version(id, hash) { if (!hash) return null; const b = await this.readVersions(id); return b.v[hash] || null; }

  // ---------------- local → folder ----------------
  async localChanged(kind, id, data) {
    if (!this.on) return;
    try {
      let body = this.strip(kind, data);
      const k = this.key(kind, id);
      if (kind === 'canvas' && !this.st.items[k]?.hash) {
        // never let a copy that hasn't seen the folder's version delete things from it
        let remote = null;
        try { remote = await readJson(this.remoteFile(kind, id)); } catch {}
        if (remote && !remote.deleted && remote.data) { body = this.strip('canvas', mergeDocs(null, body, remote.data)); this.st.items[k] = { ts: remote.ts, hash: remote.hash }; await this.addVersion(id, remote.hash, remote.data); }
      }
      const hash = hashOf(body);
      if (this.st.items[k]?.hash === hash) return; // nothing that matters changed (e.g. only the viewport)
      const env = { v: 1, kind, id, ts: Date.now(), device: this.st.deviceId, deviceName: os.hostname(), hash, parent: this.st.items[k]?.hash || null, data: body };
      await writeAtomic(this.remoteFile(kind, id), env);
      if (kind === 'canvas') await this.addVersion(id, hash, body);
      this.st.items[k] = { ts: env.ts, hash };
      this.saveState();
      this.status.pushed++; this.status.last = Date.now(); this.status.state = 'ok'; this.status.error = '';
    } catch (e) { this.fail(e); }
  }
  async localDeleted(kind, id) {
    if (!this.on) return;
    try {
      const env = { v: 1, kind, id, ts: Date.now(), device: this.st.deviceId, deviceName: os.hostname(), deleted: true };
      await writeAtomic(this.remoteFile(kind, id), env);
      this.st.items[this.key(kind, id)] = { ts: env.ts, hash: 'deleted' };
      this.saveState();
    } catch (e) { this.fail(e); }
  }
  fail(e) { this.status.state = 'error'; this.status.error = String(e.message || e); this.send('sync:status', this.info()); }

  // projects and canvases are merged by id (both computers keep what they created);
  // names, settings and order come from the newer side; deletions travel as tombstones
  mergeWorkspace(remote, local) {
    if (!local?.projects) return remote;
    const tomb = new Set([...(remote.tombstones || []), ...(local.tombstones || [])]);
    const projects = (remote.projects || []).filter((p) => !tomb.has(p.id)).map((p) => ({ ...p, canvases: (p.canvases || []).filter((c) => !tomb.has(c.id)) }));
    const remoteCanvases = new Set(projects.flatMap((p) => p.canvases.map((c) => c.id)));
    for (const lp of local.projects) {
      if (tomb.has(lp.id) || (this.pristine && this.pristine.projectId === lp.id)) continue;
      const rp = projects.find((p) => p.id === lp.id);
      const extra = (lp.canvases || []).filter((c) => !tomb.has(c.id) && !remoteCanvases.has(c.id));
      if (!rp) { if (extra.length) projects.push({ ...lp, canvases: extra }); }
      else rp.canvases.push(...extra);
    }
    for (const p of projects) if (!p.canvases.length) p.canvases.push({ id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: 'Главный' });
    return { ...remote, projects, tombstones: [...tomb].slice(-1000) };
  }

  // a brand-new install (one empty project) should simply take what's in the folder
  async detectPristine() {
    this.pristine = null;
    try {
      const ws = await readJson(this.wsFile);
      if (ws.projects?.length !== 1 || ws.projects[0].canvases?.length !== 1) return;
      const cid = ws.projects[0].canvases[0].id;
      let doc = null;
      try { doc = await readJson(path.join(this.canvasDir, `${cid}.json`)); } catch {}
      if (!doc || ((doc.nodes || []).every((n) => n.type === 'hub') && !(doc.edges || []).length)) this.pristine = { projectId: ws.projects[0].id, canvasId: cid };
    } catch {}
  }

  // ---------------- folder → local ----------------
  async apply(env) {
    const { kind, id } = env;
    let extra = {};
    if (kind === 'workspace') {
      let local = null;
      try { local = await readJson(this.wsFile); } catch {}
      const ws = this.mergeWorkspace(clone(env.data), local);
      ws.settings = ws.settings || {};
      const ls = local?.settings || {};
      ws.settings.vaultPath = ls.vaultPath || null;
      if (!this.cfg.keys || !ws.settings.providers) ws.settings.providers = ls.providers || {};
      for (const p of ws.projects || []) p.cwd = local?.projects?.find((q) => q.id === p.id)?.cwd || os.homedir();
      const has = (pid, cid) => ws.projects?.some((p) => p.id === pid && (!cid || p.canvases.some((c) => c.id === cid)));
      ws.activeProjectId = local && has(local.activeProjectId, local.activeCanvasId) ? local.activeProjectId : ws.projects?.[0]?.id;
      ws.activeCanvasId = local && has(local.activeProjectId, local.activeCanvasId) ? local.activeCanvasId : ws.projects?.[0]?.canvases?.[0]?.id;
      await writeAtomic(this.wsFile, ws);
      this.st.items[this.key(kind, id)] = { ts: env.ts, hash: env.hash };
      this.pristine = null;
      // projects that only exist here go back to the folder
      if (hashOf(this.strip('workspace', ws)) !== env.hash) setTimeout(() => this.localChanged('workspace', 'workspace', ws), 50);
    } else if (kind === 'canvas') {
      const file = path.join(this.canvasDir, `${id}.json`);
      if (env.deleted) { await fsp.unlink(file).catch(() => {}); }
      else {
        let local = null;
        try { local = await readJson(file); } catch {}
        // common ancestor: the version the other computer edited from, else the last one we synced
        const base = (await this.version(id, env.parent)) || (await this.version(id, this.st.items[this.key(kind, id)]?.hash));
        const merged = local ? mergeDocs(base, local, env.data) : clone(env.data);
        await writeAtomic(file, { ...merged, viewport: local?.viewport || { x: 0, y: 0, z: 1 } });
        const mergedBody = this.strip('canvas', merged);
        await this.addVersion(id, env.hash, env.data);
        extra = { base, remote: env.data };
        // this computer had changes the folder doesn't have yet → send the merged version back
        if (hashOf(mergedBody) !== env.hash) setTimeout(() => this.localChanged('canvas', id, merged), 50);
      }
    } else if (kind === 'chat') {
      if (env.deleted) await this.history.removeLocal(id);
      else await this.history.importRecord(env.data);
    }
    this.st.items[this.key(kind, id)] = { ts: env.ts, hash: env.deleted ? 'deleted' : env.hash };
    this.saveState();
    this.status.pulled++;
    this.send('sync:changed', { kind, id, deleted: !!env.deleted, from: env.deviceName, ...extra });
  }

  async pullOne(file) {
    let mt;
    try { mt = (await fsp.stat(file)).mtimeMs; } catch { return; }
    if (this.mtimes.get(file) === mt) return;
    let env;
    try { env = await readJson(file); } catch { return; } // half-downloaded by the cloud client: try next time
    this.mtimes.set(file, mt);
    if (!env || !env.kind || !env.ts || env.device === this.st.deviceId) return;
    const mine = this.st.items[this.key(env.kind, env.id)];
    if (mine && mine.ts >= env.ts) return;
    if (mine && !env.deleted && mine.hash === env.hash) { mine.ts = env.ts; return; }
    await this.apply(env);
  }

  async pull() {
    if (!this.on || this.busy) return;
    this.busy = true;
    try {
      await fsp.mkdir(this.root, { recursive: true });
      // canvases first, so a project that arrives with the workspace opens with its content
      for (const dir of Object.values(KINDS)) {
        let names = [];
        try { names = await fsp.readdir(path.join(this.root, dir)); } catch {}
        for (const n of names) if (n.endsWith('.json')) await this.pullOne(path.join(this.root, dir, n));
      }
      await this.pullOne(path.join(this.root, 'workspace.json'));
      this.status.state = 'ok'; this.status.error = ''; this.status.last = Date.now();
    } catch (e) { this.fail(e); }
    this.busy = false;
    this.send('sync:status', this.info());
  }

  // first run on this computer (or after the folder changed): send everything that is
  // newer here than in the folder, then take what is newer there
  async reconcile() {
    if (!this.on) return;
    await fsp.mkdir(this.root, { recursive: true });
    await this.detectPristine();
    let remoteWs = null;
    try { remoteWs = await readJson(this.remoteFile('workspace', 'workspace')); } catch {}
    const joining = this.pristine && remoteWs && !remoteWs.deleted;
    const push = async (kind, id, file, data) => {
      if (joining && (kind === 'workspace' || (kind === 'canvas' && id === this.pristine.canvasId))) return;
      const k = this.key(kind, id);
      let remote = null;
      try { remote = await readJson(this.remoteFile(kind, id)); } catch {}
      let localTs = this.st.items[k]?.ts;
      if (!localTs) { try { localTs = (await fsp.stat(file)).mtimeMs; } catch { localTs = 0; } }
      if (!remote || remote.ts < localTs) {
        delete this.st.items[k]; // force a write
        await this.localChanged(kind, id, data);
      }
    };
    try { await push('workspace', 'workspace', this.wsFile, await readJson(this.wsFile)); } catch {}
    let names = [];
    try { names = await fsp.readdir(this.canvasDir); } catch {}
    for (const n of names) if (n.endsWith('.json')) { const f = path.join(this.canvasDir, n); try { await push('canvas', n.slice(0, -5), f, await readJson(f)); } catch {} }
    for (const meta of this.history.list({})) {
      const rec = await this.history.get(meta.id);
      if (rec) { const k = this.key('chat', rec.id); if (!this.st.items[k]) this.st.items[k] = { ts: rec.updated || 0, hash: '' }; await push('chat', rec.id, this.history.file(rec.id), rec); }
    }
    await this.pull();
  }

  start() {
    this.stop();
    if (!this.on) { this.status.state = 'off'; return; }
    this.status.state = 'syncing';
    this.reconcile().catch((e) => this.fail(e));
    this.timer = setInterval(() => this.pull(), 8000);
    try {
      this.watcher = fs.watch(this.root, { recursive: process.platform !== 'linux' }, () => { clearTimeout(this._wT); this._wT = setTimeout(() => this.pull(), 600); });
      this.watcher.on('error', () => {});
    } catch {}
  }
  stop() { clearInterval(this.timer); this.timer = null; try { this.watcher?.close(); } catch {} this.watcher = null; }

  async configure(patch) {
    const dirChanged = patch.dir !== undefined && patch.dir !== this.cfg.dir;
    this.cfg = { ...this.cfg, ...patch };
    await fsp.writeFile(this.cfgFile, JSON.stringify(this.cfg));
    if (dirChanged) { this.st.items = {}; this.mtimes.clear(); this.saveState(); }
    this.start();
    return this.info();
  }

  // notes: move the vault into the sync folder so it travels with everything else
  async adoptVault(currentRoot) {
    if (!this.root) throw new Error('сначала выберите папку синхронизации');
    const dest = path.join(this.root, 'Заметки');
    await fsp.mkdir(dest, { recursive: true });
    const copy = async (src, dst) => {
      let ents = [];
      try { ents = await fsp.readdir(src, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') && e.name !== '.obsidian') continue;
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) { await fsp.mkdir(d, { recursive: true }); await copy(s, d); continue; }
        try {
          const [ss, ds] = await Promise.all([fsp.stat(s), fsp.stat(d).catch(() => null)]);
          if (!ds || ss.mtimeMs > ds.mtimeMs) await fsp.copyFile(s, d);
        } catch {}
      }
    };
    if (currentRoot && path.resolve(currentRoot) !== path.resolve(dest)) await copy(currentRoot, dest);
    return dest;
  }
}

module.exports = { SyncManager };

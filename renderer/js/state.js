// Workspace: projects → canvases, settings. Canvas documents are loaded on demand.
import { Emitter, uid, debounce } from './util.js';
import { mockNative } from './mock.js';
import { mergeDocs } from './merge.js';

export const native = window.native || mockNative;

export const DEFAULT_AGENTS = [
  { id: 'codex', name: 'Codex', cmd: 'codex', args: '', resumeArgs: 'resume --last', chat: 'codex', mono: 'Cx', color: '#5b7cfa', limitKey: 'codex', install: 'npm i -g @openai/codex' },
  { id: 'claude', name: 'Claude Code', cmd: 'claude', args: '', resumeArgs: '--continue', chat: 'claude', mono: 'Cl', color: '#d9825b', limitKey: 'claude', install: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'kimi', name: 'Kimi', cmd: 'kimi', args: '', resumeArgs: '--continue', mono: 'K', color: '#1c1f26', dark: true, limitKey: 'kimi', install: 'uv tool install kimi-cli  (или pip install kimi-cli)' },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', args: '', mono: 'G', color: '#6f7dff', limitKey: 'gemini', install: 'npm i -g @google/gemini-cli' },
  { id: 'shell', name: 'Терминал', cmd: '', args: '', mono: '>_', color: '#59606f', limitKey: null },
];

export const PROVIDER_META = {
  openai: { mono: 'AI', color: '#10a37f' },
  anthropic: { mono: 'A', color: '#d9825b' },
  moonshot: { mono: 'K', color: '#1c1f26', dark: true },
  openrouter: { mono: 'OR', color: '#6467f2' },
  deepseek: { mono: 'DS', color: '#4d6bfe' },
  gemini: { mono: 'G', color: '#6f7dff' },
  ollama: { mono: 'OL', color: '#8a8f98' },
  custom: { mono: '⚙', color: '#59606f' },
};

// Apple system colours (theme tokens, see pentools.js)
const PROJECT_COLORS = ['blue', 'green', 'orange', 'pink', 'cyan', 'purple', 'yellow'];

function defaultSettings() {
  return {
    vaultPath: null,
    wheel: 'zoom', // zoom | scroll
    theme: 'dark', // dark | light | system
    minimap: true,
    grid: true,
    snap: true,
    pet: true,
    lodZoom: 0.5,
    agents: DEFAULT_AGENTS.map((a) => ({ ...a })),
    providers: {},
    defaultProvider: 'openai',
    limitRows: ['codex', 'claude', 'kimi'],
  };
}

export function emptyCanvas(id) {
  return { id, version: 1, viewport: { x: 0, y: 0, z: 1 }, nodes: [], edges: [], fresh: true };
}

class State extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.doc = null;
    this.info = {};
    this.saveWs = debounce(() => native.ws.save(this.ws), 400);
    this.saveDoc = debounce(() => { if (this.doc) native.canvas.save(this.doc.id, this.doc); }, 500);
  }

  async init() {
    this.info = await native.info();
    let ws = await native.ws.load();
    if (!ws || !ws.projects || !ws.projects.length) {
      const cid = uid('c');
      const pid = uid('p');
      ws = {
        version: 1,
        projects: [{ id: pid, name: 'Мой проект', color: PROJECT_COLORS[0], cwd: this.info.home || '', canvases: [{ id: cid, name: 'Главный' }] }],
        activeProjectId: pid, activeCanvasId: cid,
        settings: defaultSettings(),
      };
    }
    ws.settings = { ...defaultSettings(), ...(ws.settings || {}) };
    // merge in new default agents without overriding user's edits
    for (const a of DEFAULT_AGENTS) {
      const mine = ws.settings.agents.find((x) => x.id === a.id);
      if (!mine) ws.settings.agents.push({ ...a });
      else if (a.chat && mine.chat === undefined) mine.chat = a.chat;
    }
    this.ws = ws;
    if (ws.settings.vaultPath) { try { await native.vault.setRoot(ws.settings.vaultPath); } catch {} }
    else { ws.settings.vaultPath = await native.vault.root(); }
    await this.openCanvas(ws.activeProjectId, ws.activeCanvasId);
    this.saveWs();
  }

  get settings() { return this.ws.settings; }
  setSetting(k, v) { this.ws.settings[k] = v; this.saveWs(); this.emit('settings', k); }

  get project() { return this.ws.projects.find((p) => p.id === this.ws.activeProjectId) || this.ws.projects[0]; }
  get canvasMeta() { const p = this.project; return p.canvases.find((c) => c.id === this.ws.activeCanvasId) || p.canvases[0]; }
  agent(id) { return this.settings.agents.find((a) => a.id === id) || DEFAULT_AGENTS.find((a) => a.id === id) || DEFAULT_AGENTS[4]; }

  async openCanvas(projectId, canvasId) {
    if (this.doc && !this._skipFlush) { this.saveDoc.flush(); }
    this._skipFlush = false;
    const p = this.ws.projects.find((x) => x.id === projectId) || this.ws.projects[0];
    const c = p.canvases.find((x) => x.id === canvasId) || p.canvases[0];
    this.ws.activeProjectId = p.id;
    this.ws.activeCanvasId = c.id;
    const doc = (await native.canvas.load(c.id)) || emptyCanvas(c.id);
    doc.nodes = doc.nodes || []; doc.edges = doc.edges || [];
    this.doc = doc;
    this.saveWs();
    this.emit('canvas', doc);
  }

  touch() { this.saveDoc(); }
  // write everything that is still waiting in a debounce (called before the window closes)
  async flushAll() {
    this.saveWs.cancel?.(); this.saveDoc.cancel?.();
    const jobs = [native.ws.save(this.ws)];
    if (this.doc && !this._skipFlush) jobs.push(native.canvas.save(this.doc.id, this.doc));
    jobs.push(import('./editor.js').then((m) => m.flushEditors()).catch(() => {}));
    await Promise.allSettled(jobs);
  }
  // deleted ids travel with the workspace so other computers delete them too
  tombstone(...ids) { this.ws.tombstones = [...new Set([...(this.ws.tombstones || []), ...ids])].slice(-1000); }

  // ----- changes that arrived from another computer (sync) -----
  normalizeWs(ws) {
    ws.settings = { ...defaultSettings(), ...(ws.settings || {}) };
    for (const a of DEFAULT_AGENTS) if (!ws.settings.agents.find((x) => x.id === a.id)) ws.settings.agents.push({ ...a });
    return ws;
  }
  async applyRemote(ev, isBusy = () => false) {
    if (ev.kind === 'workspace') {
      const ws = await native.ws.load();
      if (!ws?.projects?.length) return;
      ws.activeProjectId = this.ws.activeProjectId; ws.activeCanvasId = this.ws.activeCanvasId;
      ws.settings = { ...ws.settings, vaultPath: this.ws.settings.vaultPath };
      this.ws = this.normalizeWs(ws);
      const p = this.ws.projects.find((x) => x.id === this.ws.activeProjectId);
      if (!p || !p.canvases.some((c) => c.id === this.ws.activeCanvasId)) { this.dropDoc(); await this.openCanvas(this.ws.projects[0].id, this.ws.projects[0].canvases[0].id); }
      this.emit('projects'); this.emit('settings', 'all');
      return true;
    }
    if (ev.kind === 'canvas' && this.doc && ev.id === this.doc.id && !ev.deleted && ev.remote) {
      // merged into the open canvas in place: windows, terminals and running agents are untouched
      if (isBusy('drag') || this._remoteQueue?.length) {
        (this._remoteQueue = this._remoteQueue || []).push(ev);
        if (!this._remoteT) {
          const drain = () => {
            if (isBusy('drag')) { this._remoteT = setTimeout(drain, 500); return; }
            this._remoteT = null;
            const q = this._remoteQueue; this._remoteQueue = [];
            for (const e of q) if (this.doc && e.id === this.doc.id) this.mergeRemote(e);
          };
          this._remoteT = setTimeout(drain, 500);
        }
        return false;
      }
      return this.mergeRemote(ev);
    }
    return false;
  }
  mergeRemote(ev) {
    {
      const merged = mergeDocs(ev.base, this.doc, ev.remote);
      this.doc.nodes = merged.nodes; this.doc.edges = merged.edges;
      if (merged.groups) this.doc.groups = merged.groups;
      this.emit('docMerged', this.doc);
      this.saveDoc();
      return true;
    }
    return false;
  }

  // ----- projects -----
  async createProject(name, cwd) {
    const cid = uid('c');
    const p = { id: uid('p'), name: name || 'Новый проект', color: PROJECT_COLORS[this.ws.projects.length % PROJECT_COLORS.length], cwd: cwd || this.info.home || '', canvases: [{ id: cid, name: 'Главный' }] };
    this.ws.projects.push(p);
    this.saveWs();
    await this.openCanvas(p.id, cid);
    this.emit('projects');
    return p;
  }
  updateProject(id, patch) { const p = this.ws.projects.find((x) => x.id === id); Object.assign(p, patch); this.saveWs(); this.emit('projects'); }
  async deleteProject(id) {
    if (this.ws.projects.length <= 1) return false;
    const p = this.ws.projects.find((x) => x.id === id);
    for (const c of p.canvases) await native.canvas.remove(c.id);
    this.tombstone(id, ...p.canvases.map((c) => c.id));
    this.ws.projects = this.ws.projects.filter((x) => x.id !== id);
    if (this.ws.activeProjectId === id) { this.dropDoc(); await this.openCanvas(this.ws.projects[0].id, this.ws.projects[0].canvases[0].id); }
    this.saveWs(); this.emit('projects');
    return true;
  }
  // the open canvas was deleted: forget it without saving it back (that would resurrect it)
  dropDoc() { this.saveDoc.cancel?.(); this._skipFlush = true; }
  async createCanvas(projectId, name) {
    const p = this.ws.projects.find((x) => x.id === projectId);
    const c = { id: uid('c'), name: name || `Canvas ${p.canvases.length + 1}` };
    p.canvases.push(c);
    this.saveWs();
    await this.openCanvas(p.id, c.id);
    this.emit('projects');
    return c;
  }
  renameCanvas(projectId, canvasId, name) {
    const p = this.ws.projects.find((x) => x.id === projectId);
    const c = p.canvases.find((x) => x.id === canvasId);
    c.name = name; this.saveWs(); this.emit('projects');
  }
  async duplicateCanvas(projectId, canvasId) {
    const p = this.ws.projects.find((x) => x.id === projectId);
    const src = p.canvases.find((x) => x.id === canvasId);
    const data = canvasId === this.doc?.id ? this.doc : await native.canvas.load(canvasId);
    const c = { id: uid('c'), name: `${src.name} (копия)` };
    const copy = JSON.parse(JSON.stringify(data || emptyCanvas(c.id)));
    copy.id = c.id;
    for (const n of copy.nodes) if (n.data) { delete n.data.sessionId; delete n.data.convId; }
    await native.canvas.save(c.id, copy);
    p.canvases.push(c);
    this.saveWs(); this.emit('projects');
    await this.openCanvas(p.id, c.id);
  }
  async deleteCanvas(projectId, canvasId) {
    const p = this.ws.projects.find((x) => x.id === projectId);
    if (p.canvases.length <= 1) return false;
    p.canvases = p.canvases.filter((x) => x.id !== canvasId);
    this.tombstone(canvasId);
    await native.canvas.remove(canvasId);
    if (this.ws.activeCanvasId === canvasId) { this.dropDoc(); await this.openCanvas(p.id, p.canvases[0].id); }
    this.saveWs(); this.emit('projects');
    return true;
  }
}

export const state = new State();

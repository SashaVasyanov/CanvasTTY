// Cached index of the vault: notes, links, tags, backlinks.
import { Emitter, debounce } from './util.js';
import { native } from './state.js';

class VaultIndex extends Emitter {
  constructor() {
    super();
    this.root = '';
    this.notes = [];
    this.folders = [];
    this.assets = [];
    this.refreshSoon = debounce(() => this.refresh(), 200);
  }
  async refresh() {
    try {
      const idx = await native.vault.index();
      this.root = idx.root; this.notes = idx.notes; this.folders = idx.folders; this.assets = idx.assets || [];
      this.emit('change');
    } catch (e) { console.error(e); }
  }
  byName(name) {
    if (!name) return null;
    const n = name.replace(/\.md$/i, '').trim().toLowerCase();
    return this.notes.find((x) => x.name.toLowerCase() === n) || this.notes.find((x) => x.path.replace(/\.md$/i, '').toLowerCase() === n) || null;
  }
  byPath(p) { return this.notes.find((x) => x.path === p) || null; }
  backlinks(path) {
    const note = this.byPath(path);
    if (!note) return [];
    const name = note.name.toLowerCase();
    return this.notes.filter((n) => n.path !== path && n.links.some((l) => l.toLowerCase() === name || l.toLowerCase() === note.path.replace(/\.md$/, '').toLowerCase()));
  }
  outgoing(path) {
    const note = this.byPath(path);
    if (!note) return [];
    return note.links.map((l) => this.byName(l)).filter(Boolean);
  }
  tags() {
    const map = new Map();
    for (const n of this.notes) for (const t of n.tags) map.set(t, (map.get(t) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }
  resolveAsset(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    return this.assets.find((a) => a.toLowerCase() === lower) || this.assets.find((a) => a.split('/').pop().toLowerCase() === lower) || null;
  }
  addAsset(rel) { if (!this.assets.includes(rel)) this.assets.push(rel); }
}

export const vaultIndex = new VaultIndex();
native.vault.onChanged(() => vaultIndex.refreshSoon());

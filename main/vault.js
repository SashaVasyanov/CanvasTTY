// Obsidian-compatible vault: a plain folder of .md files.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IGNORE = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.vibetabula', '.canvastty']);
const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu;
// names Windows keeps for devices: a note called «CON» or «nul.md» would not be a file there
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

class Vault {
  constructor({ send }) {
    this.send = send;
    this.root = null;
    this.watcher = null;
    this.changeTimer = null;
  }

  setRoot(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
    this.watch();
  }

  watch() {
    try { this.watcher && this.watcher.close(); } catch {}
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (evt, file) => {
        if (file && file.split(/[\\/]/).some((p) => IGNORE.has(p))) return;
        clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => this.send('vault:changed', { file: file ? file.replace(/\\/g, '/') : null }), 250);
      });
    } catch { /* recursive watch unsupported on some linux setups */ }
  }

  abs(rel) {
    const p = path.resolve(this.root, rel || '');
    const r = path.resolve(this.root);
    if (p !== r && !p.startsWith(r + path.sep)) throw new Error('Путь вне хранилища');
    return p;
  }

  rel(abs) { return path.relative(this.root, abs).replace(/\\/g, '/'); }

  async walk(dir = this.root, out = { files: [], folders: [] }) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') { if (IGNORE.has(e.name) || e.name.startsWith('.')) continue; }
      if (IGNORE.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out.folders.push(this.rel(p)); await this.walk(p, out); }
      else out.files.push(p);
    }
    return out;
  }

  static parse(text) {
    const links = new Set();
    const tags = new Set();
    let m;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(text))) links.add(m[1].trim());
    // strip code blocks for tags
    const noCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(noCode))) { if (!/^\d+$/.test(m[2])) tags.add(m[2]); }
    // frontmatter tags: [a, b]
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    if (fm) {
      const t = /tags:\s*\[([^\]]*)\]/.exec(fm[1]);
      if (t) t[1].split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean).forEach((s) => tags.add(s));
    }
    return { links: [...links], tags: [...tags] };
  }

  async index() {
    const { files, folders } = await this.walk();
    const notes = [];
    const assets = [];
    for (const f of files) {
      const rel = this.rel(f);
      if (!f.toLowerCase().endsWith('.md')) { assets.push(rel); continue; }
      try {
        const st = await fsp.stat(f);
        const text = await fsp.readFile(f, 'utf8');
        const { links, tags } = Vault.parse(text);
        const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
        notes.push({
          path: rel,
          name: path.basename(rel, '.md'),
          mtime: st.mtimeMs,
          ctime: st.birthtimeMs || st.ctimeMs,
          size: st.size,
          links, tags,
          preview: body.replace(/[#>*`\[\]_~-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
        });
      } catch {}
    }
    return { root: this.root, notes, folders: folders.sort(), assets };
  }

  async read(rel) { return fsp.readFile(this.abs(rel), 'utf8'); }

  async write(rel, content) {
    const p = this.abs(rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content, 'utf8');
    return true;
  }

  async uniquePath(folder, base, ext = '.md') {
    let name = base.replace(/[\\/:*?"<>|]/g, '-').replace(/[.\s]+$/, '').trim() || 'Без названия';
    if (RESERVED.test(name)) name += ' (заметка)'; // CON, NUL, COM1… are devices on Windows, not files
    let rel = path.posix.join(folder || '', name + ext);
    let i = 1;
    while (fs.existsSync(this.abs(rel))) { rel = path.posix.join(folder || '', `${name} ${i++}${ext}`); }
    return rel;
  }

  // copy of a note named like Figma does: «Идея 1» -> «Идея 2», «Идея 3»… (next free number)
  async createNumbered(folder, stem, content = '') {
    let base = String(stem || 'Без названия').replace(/\s+\d+$/, '').trim() || 'Без названия';
    if (RESERVED.test(base)) base += ' (заметка)';
    let names = [];
    try { names = await fsp.readdir(this.abs(folder || '')); } catch {}
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc}(?: (\\d+))?\\.md$`, 'i');
    let max = 1;
    for (const n of names) { const m = n.match(re); if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1); }
    let i = max + 1, rel;
    do { rel = path.posix.join(folder || '', `${base.replace(/[\\/:*?"<>|]/g, '-')} ${i++}.md`); } while (fs.existsSync(this.abs(rel)));
    await this.write(rel, content);
    return rel;
  }

  async create(folder, name, content = '') {
    const rel = await this.uniquePath(folder, name || 'Без названия');
    await this.write(rel, content);
    return rel;
  }

  // per-note look (font, size) lives next to the notes, invisible to Obsidian and synced with them
  stylesFile() { return path.join(this.root, '.vibetabula', 'note-styles.json'); }
  async styles() {
    for (const f of [this.stylesFile(), path.join(this.root, '.canvastty', 'note-styles.json')]) { // .canvastty — the app's former name
      try { return JSON.parse(await fsp.readFile(f, 'utf8')) || {}; } catch {}
    }
    return {};
  }
  async writeStyles(all) {
    const f = this.stylesFile();
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(all, null, 1));
    await fsp.rename(tmp, f);
  }
  async setStyle(rel, style) {
    const all = await this.styles();
    const clean = {};
    if (style?.font) clean.font = String(style.font).slice(0, 120);
    if (style?.size) clean.size = Math.min(72, Math.max(8, Math.round(Number(style.size) || 0))) || undefined;
    if (Object.keys(clean).filter((k) => clean[k] != null).length) all[rel] = clean; else delete all[rel];
    await this.writeStyles(all);
    return all[rel] || null;
  }
  async moveStyles(oldRel, newRel) {
    const all = await this.styles();
    let changed = false;
    for (const k of Object.keys(all)) {
      if (k === oldRel || k.startsWith(oldRel + '/')) { all[newRel + k.slice(oldRel.length)] = all[k]; delete all[k]; changed = true; }
    }
    if (changed) await this.writeStyles(all);
  }

  async mkdir(rel) { await fsp.mkdir(this.abs(rel), { recursive: true }); return rel; }

  async rename(oldRel, newRel) {
    const from = this.abs(oldRel);
    const to = this.abs(newRel);
    if (fs.existsSync(to)) throw new Error('Файл с таким именем уже существует');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    await this.moveStyles(oldRel, newRel).catch(() => {});
    // update [[links]] like Obsidian does
    if (oldRel.endsWith('.md') && newRel.endsWith('.md')) {
      const oldName = path.basename(oldRel, '.md');
      const newName = path.basename(newRel, '.md');
      if (oldName !== newName) {
        const { files } = await this.walk();
        const re = new RegExp(`\\[\\[${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g');
        for (const f of files) {
          if (!f.endsWith('.md')) continue;
          const t = await fsp.readFile(f, 'utf8');
          if (!re.test(t)) continue;
          re.lastIndex = 0;
          await fsp.writeFile(f, t.replace(re, (all, h, a) => `[[${newName}${h || ''}${a || ''}]]`), 'utf8');
        }
      }
    }
    return newRel;
  }

  async remove(rel, shell) {
    const p = this.abs(rel);
    try { await shell.trashItem(p); } catch { await fsp.rm(p, { recursive: true, force: true }); }
    return true;
  }

  async search(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];
    const { files } = await this.walk();
    const results = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const rel = this.rel(f);
      const name = path.basename(rel, '.md');
      let text = '';
      try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      const lower = text.toLowerCase();
      const inName = name.toLowerCase().includes(q);
      const idx = lower.indexOf(q);
      if (!inName && idx < 0) continue;
      const matches = [];
      let from = 0;
      while (matches.length < 3) {
        const i = lower.indexOf(q, from);
        if (i < 0) break;
        const s = Math.max(0, i - 50);
        matches.push({ before: text.slice(s, i).replace(/\s+/g, ' '), hit: text.slice(i, i + q.length), after: text.slice(i + q.length, i + q.length + 70).replace(/\s+/g, ' ') });
        from = i + q.length;
      }
      results.push({ path: rel, name, score: (inName ? 10 : 0) + matches.length, matches });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 100);
  }

  async saveAsset(dataUrl, suggestedName) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('bad data url');
    const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' })[m[1]] || '.bin';
    const base = (suggestedName || `Pasted image ${new Date().toISOString().replace(/[:.]/g, '-')}`).replace(/\.[a-z0-9]+$/i, '');
    const rel = await this.uniquePath('attachments', base, ext);
    const p = this.abs(rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, Buffer.from(m[2], 'base64'));
    return rel;
  }

  async readAsset(rel) {
    const p = this.abs(rel);
    const buf = await fsp.readFile(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
}

module.exports = { Vault };

// Search across everything (Ctrl+K, renderer/js/search.js): the objects and chat messages of every
// canvas of every project, the notes (main/vault.js search) and saved conversations (chat history).
// Canvas files and conversations are turned into plain text once and read again only when they
// change (mtime / updated), so typing in the search box stays fast with many canvases.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_TEXT = 60000; // characters of one object or message kept for searching
const strip = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const firstLine = (s, n = 70) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, n) || '';
const base = (p) => String(p || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');
const msgText = (m) => {
  if (m.role === 'user') return [m.content || '', ...(m.attachments || []).map((a) => a.name || '')].filter(Boolean).join('\n');
  if (Array.isArray(m.parts) && m.parts.length) return m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool' ? `${p.name || ''} ${p.input || ''}` : '')).filter(Boolean).join('\n');
  return m.content || '';
};

// one canvas → entries { nodeId, type, title, text, msg? } (a chat window: one entry per message)
function canvasEntries(doc) {
  const out = [];
  const add = (n, title, text, extra = {}) => { if (title || text) out.push({ nodeId: n.id, type: n.type, title: String(title || '').slice(0, 120), text: String(text || '').slice(0, MAX_TEXT), ...extra }); };
  for (const n of doc?.nodes || []) {
    const d = n.data || {};
    switch (n.type) {
      case 'sticky': add(n, firstLine(d.text), d.text); break;
      case 'shape': add(n, firstLine(d.text), d.text); break;
      case 'text': { const t = strip(d.html); add(n, firstLine(t), t); break; }
      case 'frame': add(n, d.title || 'Область', ''); break;
      case 'note': add(n, base(d.path), ''); break; // the text: notes search
      case 'image': add(n, d.name || base(d.vault) || 'Картинка', ''); break;
      case 'web': add(n, d.title || d.url, d.url); break;
      case 'diff': add(n, d.title || 'Изменения', [...(d.changes?.files || []).map((f) => f.path), ...(d.comments || []).map((c) => c.text)].join('\n')); break; // files and comments on lines
      case 'terminal': add(n, d.title || '', ''); break; // live output: searched in the window
      case 'widget': {
        if (d.kind === 'checklist') add(n, d.title || 'Чек-лист', (d.items || []).map((x) => x.text).join('\n'));
        else if (d.kind === 'countdown') add(n, d.title || 'До события', '');
        else if (d.kind === 'calendar') add(n, 'Календарь', Object.values(d.notes || {}).map((x) => x?.text || '').join('\n'));
        break;
      }
      case 'chat': case 'agentchat': {
        const title = d.title || '';
        add(n, title, '', { chat: true });
        (d.messages || []).forEach((m, i) => { const t = msgText(m); if (t.trim()) add(n, title, t, { msg: i, role: m.role }); });
        break;
      }
      default: break;
    }
  }
  return out;
}

// all words, any case
const matcher = (query) => {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? (s) => { const low = s.toLowerCase(); return words.every((w) => low.includes(w)); } : null;
};
function snippet(text, query, n = 140) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const low = String(text || '').toLowerCase();
  let at = -1;
  for (const w of words) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const flat = (s) => s.replace(/\s+/g, ' ');
  if (at < 0) return flat(String(text || '').slice(0, n)).trim();
  const s = Math.max(0, at - Math.floor(n / 3));
  return (s > 0 ? '…' : '') + flat(text.slice(s, s + n)).trim() + (s + n < text.length ? '…' : '');
}

class SearchIndex {
  // waitFile(file): a promise that resolves when saves of that file still being written are done
  constructor({ canvasDir, history, vault, waitFile = async () => {} }) {
    this.canvasDir = canvasDir; this.history = history; this.vault = vault; this.waitFile = waitFile;
    this.canvases = new Map(); // id → { mtime, entries }
    this.chats = new Map(); // id → { updated, text, title, meta }
    this.notes = new Map(); // absolute path → { mtime, size, text }
  }
  async canvas(id) {
    const file = path.join(this.canvasDir, `${id}.json`);
    await this.waitFile(file);
    let st;
    try { st = await fsp.stat(file); } catch { this.canvases.delete(id); return []; }
    const c = this.canvases.get(id);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.entries;
    let doc = null;
    try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
    const entries = canvasEntries(doc);
    this.canvases.set(id, { mtime: st.mtimeMs, size: st.size, entries });
    return entries;
  }
  // the notes of the vault (.md files), read again when they change
  async noteHits(match, query, limit) {
    if (!this.vault?.root || !this.vault.walk) return [];
    const { files } = await this.vault.walk();
    const hits = [], live = new Set();
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      live.add(f);
      let st; try { st = await fsp.stat(f); } catch { continue; }
      let c = this.notes.get(f);
      if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
        let text = ''; try { text = st.size < 5e6 ? await fsp.readFile(f, 'utf8') : ''; } catch {}
        c = { mtime: st.mtimeMs, size: st.size, text };
        this.notes.set(f, c);
      }
      const rel = this.vault.rel(f), name = path.basename(rel, '.md');
      if (!match(`${rel}\n${c.text}`)) continue;
      const inName = match(name);
      hits.push({ path: rel, name, snippet: snippet(c.text, query), score: inName ? 1 : 0, mtime: c.mtime });
    }
    for (const f of this.notes.keys()) if (!live.has(f)) this.notes.delete(f);
    return hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, limit).map(({ score, mtime, ...h }) => h);
  }
  async chat(meta) {
    const c = this.chats.get(meta.id);
    if (c && c.updated === meta.updated) return c;
    const rec = await this.history.get(meta.id);
    const msgs = rec?.messages || [];
    const v = { updated: meta.updated, title: rec?.title || meta.title || '', texts: msgs.map(msgText) };
    this.chats.set(meta.id, v);
    return v;
  }
  // canvasIds: every canvas of the workspace (the renderer knows them) → grouped hits
  async search(query, { canvasIds = [], limit = 30 } = {}) {
    const match = matcher(query);
    if (!match) return { objects: [], notes: [], chats: [] };
    const objects = [];
    for (const id of canvasIds) {
      if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) continue;
      for (const e of await this.canvas(id)) {
        if (objects.length >= limit * 4) break;
        if (!match(`${e.title}\n${e.text}`)) continue;
        objects.push({ canvasId: id, nodeId: e.nodeId, type: e.type, title: e.title, msg: e.msg, role: e.role, snippet: e.text ? snippet(e.text, query) : '' });
      }
    }
    let notes = [];
    try { notes = await this.noteHits(match, query, limit); } catch {}
    const chats = [];
    for (const meta of this.history?.list({}) || []) {
      if (chats.length >= limit) break;
      const c = await this.chat(meta);
      const i = c.texts.findIndex((t) => match(`${c.title}\n${t}`));
      if (i < 0 && !match(c.title)) continue;
      chats.push({ id: meta.id, title: c.title || 'Чат', kind: meta.kind, agent: meta.agent, provider: meta.provider, updated: meta.updated, msg: i < 0 ? null : i, snippet: i < 0 ? '' : snippet(c.texts[i], query) });
    }
    return { objects: objects.slice(0, limit * 2), notes, chats };
  }
}

module.exports = { SearchIndex, canvasEntries, snippet };

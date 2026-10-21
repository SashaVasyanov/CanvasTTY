// Files attached to chat messages. They are copied into <userData>/attachments and shown via
// app://canvastty/__attach/<file>; messages keep only a small description plus a thumbnail.
// When a message is sent, images / PDFs / text files are turned into the parts each API expects.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MIME = { ...IMAGE, '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
const TEXT_EXT = new Set(('txt md markdown csv tsv json jsonl yaml yml toml ini cfg conf env xml html htm css scss less js mjs cjs ts tsx jsx py rb go rs java kt kts swift c h cpp hpp cc cs php sh bash zsh ps1 bat cmd sql graphql proto vue svelte lua r m mm pl tex log gitignore dockerfile makefile gradle properties').split(' '));
const MAX_FILE = 50 * 1024 * 1024; // 50 MB per file
const MAX_TEXT = 200 * 1024; // text files larger than this are only referenced
const MAX_API_IMAGE = 3.5 * 1024 * 1024;

class Attachments {
  constructor(userData) {
    this.dir = path.join(userData, 'attachments');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  pathOf(file) {
    const p = path.join(this.dir, path.basename(String(file || '')));
    return p.startsWith(this.dir + path.sep) ? p : null;
  }
  meta(file, name, size) {
    const ext = path.extname(name).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    return { id: file.split('-')[0], file, name, size, mime, kind: IMAGE[ext] ? 'image' : 'file', ext: ext.slice(1), url: `app://canvastty/__attach/${encodeURIComponent(file)}` };
  }
  fileName(name) {
    const safe = path.basename(String(name || 'file')).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').slice(-80) || 'file';
    return `${crypto.randomBytes(5).toString('hex')}-${safe}`;
  }
  async saveBytes({ name, bytes }) {
    const buf = Buffer.from(bytes);
    if (buf.length > MAX_FILE) throw new Error(`«${name}» больше 50 МБ`);
    const file = this.fileName(name);
    await fsp.writeFile(path.join(this.dir, file), buf);
    return this.meta(file, path.basename(name), buf.length);
  }
  async importPath(src) {
    const st = await fsp.stat(src);
    if (!st.isFile()) throw new Error('можно прикладывать только файлы');
    if (st.size > MAX_FILE) throw new Error(`«${path.basename(src)}» больше 50 МБ`);
    const file = this.fileName(path.basename(src));
    await fsp.copyFile(src, path.join(this.dir, file));
    return this.meta(file, path.basename(src), st.size);
  }
  isText(att) { return TEXT_EXT.has((att.ext || '').toLowerCase()) || TEXT_EXT.has(path.basename(att.name || '').toLowerCase()); }

  async imageData(att, nativeImage) {
    const p = this.pathOf(att.file);
    let buf = await fsp.readFile(p);
    let mime = att.mime;
    // big photos: scale down so the API accepts them (and to save tokens)
    if ((buf.length > MAX_API_IMAGE || mime === 'image/bmp') && nativeImage) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        const k = Math.min(1, 1800 / Math.max(width, height));
        buf = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }).toJPEG(85);
        mime = 'image/jpeg';
      }
    }
    return { mime, data: buf.toString('base64') };
  }

  // content parts for one message, in the format of the given API ('anthropic' | 'openai')
  async toParts(text, atts, kind, nativeImage) {
    const parts = [];
    const notes = [];
    for (const att of atts || []) {
      const p = this.pathOf(att.file);
      if (!p || !fs.existsSync(p)) { notes.push(`[Вложение «${att.name}» недоступно на этом компьютере]`); continue; }
      try {
        if (att.kind === 'image' && att.mime !== 'image/svg+xml') {
          const { mime, data } = await this.imageData(att, nativeImage);
          parts.push(kind === 'anthropic' ? { type: 'image', source: { type: 'base64', media_type: mime, data } } : { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
        } else if (att.mime === 'application/pdf') {
          const data = (await fsp.readFile(p)).toString('base64');
          parts.push(kind === 'anthropic'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: att.name }
            : { type: 'file', file: { filename: att.name, file_data: `data:application/pdf;base64,${data}` } });
        } else if (this.isText(att) || att.mime === 'image/svg+xml') {
          if (att.size > MAX_TEXT) { notes.push(`[Файл «${att.name}» (${Math.round(att.size / 1024)} КБ) слишком большой, чтобы вставить его целиком]`); continue; }
          const body = await fsp.readFile(p, 'utf8');
          notes.push(`Файл «${att.name}»:\n\`\`\`${att.ext || ''}\n${body}\n\`\`\``);
        } else {
          notes.push(`[Приложен файл «${att.name}» (${(att.ext || "файл").toUpperCase()}, ${Math.max(1, Math.round(att.size / 1024))} КБ) — эта модель не может прочитать такой формат]`);
        }
      } catch (e) { notes.push(`[Не удалось прочитать «${att.name}»: ${e.message}]`); }
    }
    const fullText = [text, ...notes].filter(Boolean).join('\n\n') || 'Посмотри вложения.';
    if (!parts.length) return fullText; // plain string keeps every provider happy
    return kind === 'anthropic' ? [...parts, { type: 'text', text: fullText }] : [{ type: 'text', text: fullText }, ...parts];
  }
}

module.exports = { Attachments, IMAGE };

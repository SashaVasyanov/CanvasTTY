// Codex pets: the same pets the Codex app uses. They live in ${CODEX_HOME:-~/.codex}/pets/<id>/
// (pet.json + spritesheet.webp, an 8×9 or 8×11 atlas of 192×208 cells), so a pet installed here
// also shows up in Codex and vice versa. The catalog is the community site codex-pets.net.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { net } = require('electron');

const API = (process.env.CODEX_PETS_API_BASE || 'https://codex-pets.net').replace(/\/$/, '');
const petsDir = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets');
const safeId = (id) => String(id || '').replace(/[^\w.-]/g, '-').replace(/^\.+/, '').slice(0, 80);
const SORTS = new Set(['new', 'popular', 'views', 'discussed', 'random']);

async function getJson(url) {
  const r = await net.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'VibeTabula' } });
  if (!r.ok) throw new Error(`codex-pets.net ответил ${r.status}`);
  return r.json();
}

// height of a WebP / PNG image, read from its header (to tell 9-row from 11-row atlases)
function imageHeight(buf) {
  if (buf.slice(1, 4).toString() === 'PNG') return buf.readUInt32BE(20);
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    const chunk = buf.slice(12, 16).toString();
    if (chunk === 'VP8X') return 1 + buf.readUIntLE(27, 3);
    if (chunk === 'VP8 ') return buf.readUInt16LE(28) & 0x3fff;
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return ((b >> 14) & 0x3fff) + 1; }
  }
  return 0;
}

// minimal ZIP reader (stored + deflate), enough for .codex-pet.zip packages
const MAX_ENTRY = 24 * 1024 * 1024, MAX_TOTAL = 48 * 1024 * 1024, MAX_FILES = 64; // pets are a json + one image
function unzip(buf) {
  const files = {};
  let total = 0;
  // central directory is authoritative (local headers may defer sizes to a data descriptor)
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('повреждённый архив');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    if (i >= MAX_FILES) throw new Error('слишком много файлов в архиве');
    if (!name.endsWith('/')) {
      const out = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) : data;
      if (out.length > MAX_ENTRY || (total += out.length) > MAX_TOTAL) throw new Error('архив слишком большой');
      files[name.split('/').pop()] = out;
    }
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

async function readInstalled() {
  const dir = petsDir();
  let names = [];
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, d.name, 'pet.json'), 'utf8'));
      const sheet = meta.spritesheetPath || 'spritesheet.webp';
      const file = path.join(dir, d.name, sheet);
      const fd = await fsp.open(file, 'r');
      const head = Buffer.alloc(64); await fd.read(head, 0, 64, 0); await fd.close();
      const h = imageHeight(head);
      const rows = meta.spriteVersionNumber === 2 || h >= 2288 ? 11 : 9;
      const st = await fsp.stat(file);
      out.push({
        id: d.name, displayName: meta.displayName || meta.id || d.name, description: meta.description || '', kind: meta.kind || '',
        rows, url: `app://vibetabula/__codexpets/${encodeURIComponent(d.name)}/${encodeURIComponent(sheet)}?v=${Math.round(st.mtimeMs)}`,
      });
    } catch {}
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

module.exports = {
  petsDir,
  async installed() { return readInstalled(); },
  async catalog({ page = 1, pageSize = 30, sort = 'new', q = '' } = {}) {
    const u = new URL(`${API}/api/pets`);
    u.searchParams.set('page', String(page)); u.searchParams.set('pageSize', String(pageSize));
    if (SORTS.has(sort) && sort !== 'new') u.searchParams.set('sort', sort);
    if (q) u.searchParams.set('q', q);
    const data = await getJson(u.toString());
    const have = new Set((await readInstalled()).map((p) => p.id));
    return {
      page: data.page, totalPages: data.totalPages, total: data.total,
      pets: (data.pets || []).map((p) => ({
        id: p.id, displayName: p.displayName, description: p.description, owner: p.ownerName || p.ownerHandle || '', tags: p.tags || [],
        rows: p.spriteVersionNumber === 2 || p.validationReport?.atlasSize === '1536x2288' ? 11 : 9,
        spritesheetUrl: p.spritesheetUrl, downloadUrl: new URL(p.downloadUrl, API).toString(), likes: p.likeCount || 0, views: p.viewCount || 0,
        installed: have.has(safeId(p.id)),
      })),
    };
  },
  async install(pet) {
    const url = new URL(pet.downloadUrl, API);
    if (url.origin !== new URL(API).origin) throw new Error('чужой адрес загрузки');
    const r = await net.fetch(url.toString(), { headers: { 'user-agent': 'VibeTabula' } });
    if (!r.ok) throw new Error(`загрузка не удалась: ${r.status}`);
    const zipBuf = Buffer.from(await r.arrayBuffer());
    if (zipBuf.length > MAX_TOTAL) throw new Error('архив слишком большой');
    const files = unzip(zipBuf);
    if (!files['pet.json']) throw new Error('в архиве нет pet.json');
    const meta = JSON.parse(files['pet.json'].toString('utf8'));
    const sheetName = path.basename(meta.spritesheetPath || 'spritesheet.webp');
    const sheet = files[sheetName] || files['spritesheet.webp'] || files['spritesheet.png'];
    if (!sheet) throw new Error('в архиве нет spritesheet');
    const id = safeId(meta.id || pet.id);
    const dir = path.join(petsDir(), id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, sheetName), sheet);
    await fsp.writeFile(path.join(dir, 'pet.json'), JSON.stringify({ ...meta, id, spritesheetPath: sheetName }, null, 2));
    return (await readInstalled()).find((p) => p.id === id);
  },
  async remove(id) {
    const dir = path.join(petsDir(), safeId(id));
    if (!dir.startsWith(petsDir() + path.sep)) return false;
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  },
};

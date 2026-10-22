// Codex pets: the same pets the Codex app keeps in ~/.codex/pets, served to the page through the
// app:// protocol; the codex-pets.net catalog (here a local server via CODEX_PETS_API_BASE) is
// downloaded and unpacked by the main process.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from './fixtures.mjs';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// a one-colour PNG: an 8×9 atlas of 192×208 cells like the Codex pets use
function png(w = 1536, h = 1872, rgb = [255, 149, 0]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

// a .codex-pet.zip (deflated entries, central directory) as codex-pets.net serves it
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc32(data), 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, n, packed); centrals.push(cen, n);
    offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('питомцы Codex: уже установленный и скачанный из каталога появляются на экране', async ({ launchApp, home }) => {
  // installed earlier by the Codex app itself
  const zipPet = path.join(home, '.codex', 'pets', 'zip-pet');
  fs.mkdirSync(zipPet, { recursive: true });
  fs.writeFileSync(path.join(zipPet, 'spritesheet.png'), png(1536, 1872, [52, 199, 89]));
  fs.writeFileSync(path.join(zipPet, 'pet.json'), JSON.stringify({ id: 'zip-pet', displayName: 'Zip Pet', spritesheetPath: 'spritesheet.png' }));

  const sheet = png();
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push([req.url, req.headers['user-agent']]);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url.startsWith('/api/pets')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ page: 1, totalPages: 1, total: 1, pets: [{ id: 'pixel-cat', displayName: 'Пиксельный кот', description: 'тест', ownerName: 'tester', tags: [], spriteVersionNumber: 1, spritesheetUrl: `${base}/sheet.png`, downloadUrl: '/download/pixel-cat.zip', likeCount: 3, viewCount: 10 }] }));
    } else if (req.url === '/sheet.png') { res.setHeader('content-type', 'image/png'); res.end(sheet); }
    else if (req.url === '/download/pixel-cat.zip') {
      res.setHeader('content-type', 'application/zip');
      res.end(zip({ 'pixel-cat/pet.json': Buffer.from(JSON.stringify({ id: 'pixel-cat', displayName: 'Пиксельный кот', spritesheetPath: 'spritesheet.png' })), 'pixel-cat/spritesheet.png': sheet }));
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const app = await launchApp({ env: { CODEX_PETS_API_BASE: `http://127.0.0.1:${server.address().port}` } });
    const installed = await app.page.evaluate(() => window.native.codexPets.installed());
    expect(installed.map((p) => [p.id, p.displayName, p.rows])).toEqual([['zip-pet', 'Zip Pet', 9]]);
    expect(installed[0].url).toMatch(/^app:\/\/vibetabula\/__codexpets\/zip-pet\/spritesheet\.png\?v=\d+$/);

    await app.page.evaluate(async () => (await import('/js/util.js')).bus.emit('openPetCatalog'));
    const card = app.page.locator('.cat-card', { hasText: 'Пиксельный кот' });
    await expect(card).toContainText('by tester');
    await card.locator('button', { hasText: 'Установить' }).click();
    await expect(card.locator('button')).toHaveText('Выбран ✓');

    // unpacked into ~/.codex/pets, so the Codex app sees it too
    const dir = path.join(home, '.codex', 'pets', 'pixel-cat');
    expect(fs.readFileSync(path.join(dir, 'spritesheet.png'))).toEqual(sheet);
    expect(app.readJson(path.join(dir, 'pet.json'))).toMatchObject({ id: 'pixel-cat', spritesheetPath: 'spritesheet.png' });
    expect(requests.filter(([u]) => !u.startsWith('/sheet')), 'каталог и архив скачивает main-процесс').toEqual([
      ['/api/pets?page=1&pageSize=24&sort=popular', 'VibeTabula'], ['/download/pixel-cat.zip', 'VibeTabula'],
    ]);

    // the chosen pet walks on the screen, its sprite comes through app://
    await app.page.keyboard.press('Escape');
    const sprite = app.page.locator('.companion .cpet-img');
    await expect(sprite).toHaveAttribute('style', /app:\/\/vibetabula\/__codexpets\/pixel-cat\/spritesheet\.png/);
    const size = await sprite.evaluate((el) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(`${img.naturalWidth}×${img.naturalHeight}`);
      img.onerror = () => resolve('не загрузилась');
      img.src = el.style.backgroundImage.slice(5, -2);
    }));
    expect(size).toBe('1536×1872');

    // an archive from another site is never downloaded
    app.allowErrors(/handler for 'codexPets:install'/);
    const refused = await app.page.evaluate(() => window.native.codexPets.install({ id: 'evil', downloadUrl: 'http://evil.example/evil.zip' }).then(() => 'установлен', (e) => e.message));
    expect(refused).toContain('чужой адрес загрузки');
  } finally {
    server.close();
  }
});

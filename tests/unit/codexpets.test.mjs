// Codex pets (main/codexpets.js): pets installed in ${CODEX_HOME}/pets, the codex-pets.net catalog
// and installing a .zip package from it. Electron's net.fetch is stubbed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Module, { createRequire } from 'node:module';

const requests = [];
let respond = () => { throw new Error('нет ответа'); };
const net = { fetch: async (url, opts) => { requests.push({ url, opts }); return respond(url); } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? { net } : load.call(this, request, ...rest); };
const require = createRequire(import.meta.url);
const pets = require('../../main/codexpets.js');
Module._load = load;

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-pets-')); process.env.CODEX_HOME = tmp; requests.length = 0; });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// image headers: 8 columns × 9 rows (1536×1872) or × 11 rows (1536×2288)
function png(height) { const b = Buffer.alloc(64); b.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); b.writeUInt32BE(1536, 16); b.writeUInt32BE(height, 20); return b; }
function webpVP8X(height) { const b = Buffer.alloc(64); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(1535, 24, 3); b.writeUIntLE(height - 1, 27, 3); return b; }
function webpVP8L(height) { const b = Buffer.alloc(64); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8L', 12); b[20] = 0x2f; b.writeUInt32LE(((height - 1) << 14) | 1535, 21); return b; }
function webpVP8(height) { const b = Buffer.alloc(64); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8 ', 12); b.writeUInt16LE(1536, 26); b.writeUInt16LE(height, 28); return b; }

function addPet(id, meta, sheet, sheetName = 'spritesheet.webp') {
  const dir = path.join(tmp, 'pets', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(meta));
  if (sheet) fs.writeFileSync(path.join(dir, sheetName), sheet);
}

// a minimal .zip (stored or deflated entries), as codex-pets.net serves them
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const data = deflate ? zlib.deflateRawSync(content) : content;
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const okZip = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

test('установленные питомцы: число строк анимации по размеру листа, имена, сортировка, битые пропускаются', async () => {
  addPet('zeta', { displayName: 'Яша' }, png(2288), 'sheet.png');
  fs.writeFileSync(path.join(tmp, 'pets', 'zeta', 'pet.json'), JSON.stringify({ displayName: 'Яша', spritesheetPath: 'sheet.png' }));
  addPet('alpha', { id: 'alpha' }, webpVP8X(1872));
  addPet('looker', { displayName: 'Глазастик' }, webpVP8L(2288));
  addPet('lossy', { displayName: 'Бета', description: 'описание', kind: 'cat' }, webpVP8(1872));
  addPet('v2', { displayName: 'Вторая версия', spriteVersionNumber: 2 }, webpVP8X(1872));
  addPet('broken', { displayName: 'Без листа' }, null);
  fs.writeFileSync(path.join(tmp, 'pets', 'not-a-dir.txt'), 'x');
  const list = await pets.installed();
  assert.deepEqual(list.map((p) => [p.id, p.displayName, p.rows]), [['alpha', 'alpha', 9], ['lossy', 'Бета', 9], ['v2', 'Вторая версия', 11], ['looker', 'Глазастик', 11], ['zeta', 'Яша', 11]]);
  assert.equal(list[1].description, 'описание');
  assert.equal(list[1].kind, 'cat');
  assert.match(list[4].url, /^app:\/\/vibetabula\/__codexpets\/zeta\/sheet\.png\?v=\d+$/);
  assert.equal(pets.petsDir(), path.join(tmp, 'pets'));
});

test('нет папки питомцев — пустой список', async () => {
  process.env.CODEX_HOME = path.join(tmp, 'нет');
  assert.deepEqual(await pets.installed(), []);
});

test('каталог codex-pets.net: параметры запроса, 11 строк — смотрит на курсор, отметка «установлен»', async () => {
  addPet('cat-1', { displayName: 'Кот' }, webpVP8X(1872));
  respond = () => ({ ok: true, json: async () => ({ page: 2, totalPages: 5, total: 120, pets: [
    { id: 'cat-1', displayName: 'Кот', description: 'd', ownerName: 'Аня', tags: ['cat'], spriteVersionNumber: 1, spritesheetUrl: 'https://cdn/s1.webp', downloadUrl: '/api/pets/cat-1/download', likeCount: 3, viewCount: 9 },
    { id: 'owl', displayName: 'Сова', ownerHandle: '@owl', validationReport: { atlasSize: '1536x2288' }, spritesheetUrl: 'https://cdn/s2.webp', downloadUrl: 'https://codex-pets.net/d/owl.zip' },
  ] }) });
  const r = await pets.catalog({ page: 2, pageSize: 24, sort: 'popular', q: 'кот' });
  const u = new URL(requests[0].url);
  assert.equal(u.origin + u.pathname, 'https://codex-pets.net/api/pets');
  assert.deepEqual(Object.fromEntries(u.searchParams), { page: '2', pageSize: '24', sort: 'popular', q: 'кот' });
  assert.equal(requests[0].opts.headers['user-agent'], 'VibeTabula');
  assert.deepEqual([r.page, r.totalPages, r.total], [2, 5, 120]);
  assert.deepEqual(r.pets.map((p) => [p.id, p.rows, p.owner, p.installed]), [['cat-1', 9, 'Аня', true], ['owl', 11, '@owl', false]]);
  assert.equal(r.pets[0].downloadUrl, 'https://codex-pets.net/api/pets/cat-1/download');
  assert.deepEqual([r.pets[0].likes, r.pets[0].views, r.pets[1].likes], [3, 9, 0]);

  await pets.catalog({ sort: 'new' });
  await pets.catalog({ sort: 'hack&x=1' });
  for (const req of requests.slice(1)) assert.equal(new URL(req.url).searchParams.has('sort'), false, 'сортировка «новые» и неизвестная не передаются');
  respond = () => ({ ok: false, status: 503 });
  await assert.rejects(pets.catalog({}), /codex-pets\.net ответил 503/);
});

test('установка: архив распаковывается в ~/.codex/pets/<id> и питомец сразу в списке', async () => {
  const sheet = webpVP8X(2288);
  respond = () => okZip(zip([['owl/', Buffer.alloc(0)], ['owl/pet.json', Buffer.from(JSON.stringify({ id: 'owl', displayName: 'Сова', spritesheetPath: 'owl.webp' })), true], ['owl/owl.webp', sheet, true]]));
  const p = await pets.install({ id: 'owl', downloadUrl: '/d/owl.zip' });
  assert.equal(requests[0].url, 'https://codex-pets.net/d/owl.zip');
  assert.deepEqual([p.id, p.displayName, p.rows], ['owl', 'Сова', 11]);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'pets', 'owl', 'owl.webp')), sheet);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'pets', 'owl', 'pet.json'), 'utf8')), { id: 'owl', displayName: 'Сова', spritesheetPath: 'owl.webp' });
});

test('установка не выходит за папку питомцев и не качает с чужого сайта', async () => {
  respond = () => okZip(zip([['pet.json', Buffer.from(JSON.stringify({ id: '../../evil', displayName: 'Злой' }))], ['spritesheet.webp', webpVP8X(1872)]]));
  const p = await pets.install({ id: 'x', downloadUrl: '/d/x.zip' });
  assert.equal(p.id, '-..-evil', 'слэши и точки в начале убираются');
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'pets')), ['-..-evil']);
  assert.equal(fs.existsSync(path.join(tmp, 'evil')), false);
  const before = requests.length;
  await assert.rejects(pets.install({ id: 'y', downloadUrl: 'https://evil.example/pet.zip' }), /чужой адрес загрузки/);
  assert.equal(requests.length, before, 'запроса к чужому сайту не было');
});

test('битые архивы отклоняются понятной ошибкой', async () => {
  const cases = [
    [Buffer.from('это не zip'), /повреждённый архив/],
    [zip([['spritesheet.webp', webpVP8X(1872)]]), /нет pet\.json/],
    [zip([['pet.json', Buffer.from('{"id":"a"}')]]), /нет spritesheet/],
    [zip(Array.from({ length: 70 }, (_, i) => [`f${i}.txt`, Buffer.from('x')])), /слишком много файлов/],
  ];
  for (const [buf, err] of cases) { respond = () => okZip(buf); await assert.rejects(pets.install({ id: 'a', downloadUrl: '/a.zip' }), err); }
  respond = () => ({ ok: false, status: 404 });
  await assert.rejects(pets.install({ id: 'a', downloadUrl: '/a.zip' }), /загрузка не удалась: 404/);
});

test('удаление: только папка этого питомца', async () => {
  addPet('cat', { displayName: 'Кот' }, webpVP8X(1872));
  addPet('dog', { displayName: 'Пёс' }, webpVP8X(1872));
  assert.equal(await pets.remove('cat'), true);
  assert.deepEqual((await pets.installed()).map((p) => p.id), ['dog']);
  assert.equal(await pets.remove(''), false, 'пустой id не удаляет всю папку питомцев');
  assert.equal(await pets.remove('..'), false);
  assert.ok(fs.existsSync(path.join(tmp, 'pets', 'dog')));
});

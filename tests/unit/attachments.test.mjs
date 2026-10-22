// Files attached to chat messages (main/attachments.js): stored under <userData>/attachments with
// safe names, and turned into the parts each API expects (images, PDFs, text files inline).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Attachments } = require('../../main/attachments.js');

let tmp, att;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-att-')); att = new Attachments(tmp); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('сохранение: случайный префикс, безопасное имя, описание с превью-адресом', async () => {
  const m = await att.saveBytes({ name: 'Скриншот 2026?.png', bytes: [...PNG] });
  assert.match(m.file, /^[0-9a-f]{10}-Скриншот 2026_\.png$/);
  assert.equal(m.id, m.file.split('-')[0]);
  assert.equal(m.name, 'Скриншот 2026?.png', 'показывается исходное имя');
  assert.deepEqual({ size: m.size, mime: m.mime, kind: m.kind, ext: m.ext }, { size: PNG.length, mime: 'image/png', kind: 'image', ext: 'png' });
  assert.equal(m.url, `app://vibetabula/__attach/${encodeURIComponent(m.file)}`);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'attachments', m.file)), PNG);
  const doc = await att.saveBytes({ name: 'отчёт.PDF', bytes: [1] });
  assert.deepEqual([doc.kind, doc.mime, doc.ext], ['file', 'application/pdf', 'pdf']);
  assert.match(att.fileName('../../etc/passwd'), /^[0-9a-f]{10}-passwd$/, 'путь в имени отбрасывается');
});

test('файл вложения ищется только внутри папки вложений', () => {
  const dir = path.join(tmp, 'attachments');
  assert.equal(att.pathOf('abc-file.txt'), path.join(dir, 'abc-file.txt'));
  assert.equal(att.pathOf('../../secret.txt'), path.join(dir, 'secret.txt'));
  assert.equal(att.pathOf(''), null);
  assert.equal(att.pathOf(undefined), null);
});

test('файл с диска копируется; папку приложить нельзя', async () => {
  const src = path.join(tmp, 'заметки.md');
  fs.writeFileSync(src, '# привет');
  const m = await att.importPath(src);
  assert.equal(m.name, 'заметки.md');
  assert.equal(fs.readFileSync(att.pathOf(m.file), 'utf8'), '# привет');
  await assert.rejects(att.importPath(tmp), /только файлы/);
});

test('части сообщения для Anthropic и OpenAI: картинка, PDF, текст файла, неизвестный формат', async () => {
  const img = await att.saveBytes({ name: 'shot.png', bytes: [...PNG] });
  const pdf = await att.saveBytes({ name: 'doc.pdf', bytes: [37, 80, 68, 70] });
  const code = await att.saveBytes({ name: 'main.py', bytes: [...Buffer.from('print("hi")')] });
  const docker = await att.saveBytes({ name: 'Dockerfile', bytes: [...Buffer.from('FROM node')] });
  const bin = await att.saveBytes({ name: 'data.bin', bytes: [0, 1, 2] });
  const b64 = PNG.toString('base64');

  const anth = await att.toParts('Что на картинке?', [img, pdf, code, docker, bin], 'anthropic');
  assert.deepEqual(anth[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
  assert.deepEqual(anth[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') }, title: 'doc.pdf' });
  assert.equal(anth.length, 3);
  assert.equal(anth[2].type, 'text');
  assert.equal(anth[2].text, [
    'Что на картинке?',
    'Файл «main.py»:\n```py\nprint("hi")\n```',
    'Файл «Dockerfile»:\n```\nFROM node\n```',
    '[Приложен файл «data.bin» (BIN, 1 КБ) — эта модель не может прочитать такой формат]',
  ].join('\n\n'));

  const oai = await att.toParts('Что на картинке?', [img, pdf], 'openai');
  assert.equal(oai[0].type, 'text', 'у OpenAI текст первым');
  assert.deepEqual(oai[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
  assert.deepEqual(oai[2], { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}` } });
});

test('без картинок — обычная строка; недоступные и слишком большие файлы описываются словами', async () => {
  const big = await att.saveBytes({ name: 'big.log', bytes: [...Buffer.alloc(210 * 1024, 97)] });
  const svg = await att.saveBytes({ name: 'logo.svg', bytes: [...Buffer.from('<svg/>')] });
  const gone = { file: 'deadbeef00-gone.png', name: 'gone.png', kind: 'image', mime: 'image/png' };
  const out = await att.toParts('', [big, svg, gone], 'openai');
  assert.equal(typeof out, 'string');
  assert.equal(out, [
    '[Файл «big.log» (210 КБ) слишком большой, чтобы вставить его целиком]',
    'Файл «logo.svg»:\n```svg\n<svg/>\n```',
    '[Вложение «gone.png» недоступно на этом компьютере]',
  ].join('\n\n'));
  assert.equal(await att.toParts('', [], 'anthropic'), 'Посмотри вложения.');
  assert.equal(await att.toParts('просто текст', undefined, 'anthropic'), 'просто текст');
});

test('большая картинка уменьшается до 1800 px в JPEG, если есть nativeImage', async () => {
  const m = await att.saveBytes({ name: 'photo.bmp', bytes: [...PNG] });
  const calls = [];
  const nativeImage = { createFromPath: (p) => ({ isEmpty: () => false, getSize: () => ({ width: 3600, height: 1800 }), resize: (o) => { calls.push([p, o]); return { toJPEG: (q) => Buffer.from(`jpeg${q}`) }; } }) };
  const r = await att.imageData({ ...m, kind: 'image', mime: 'image/bmp' }, nativeImage);
  assert.deepEqual(r, { mime: 'image/jpeg', data: Buffer.from('jpeg85').toString('base64') });
  assert.deepEqual(calls, [[att.pathOf(m.file), { width: 1800, height: 900, quality: 'best' }]]);
  const small = await att.saveBytes({ name: 'small.png', bytes: [...PNG] });
  assert.deepEqual(await att.imageData(small, nativeImage), { mime: 'image/png', data: PNG.toString('base64') }, 'маленькая остаётся как есть');
});

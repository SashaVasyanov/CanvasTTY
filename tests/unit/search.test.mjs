// Search across everything, main-process side (main/search.js): objects and chat messages of every
// canvas file, notes (through the vault), saved conversations; all words must match; canvas files
// and conversations are read again only when they change.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SearchIndex, canvasEntries } = require('../../main/search.js');
const { HistoryStore } = require('../../main/history.js');

let tmp, canvasDir, history, idx;
const write = (id, nodes) => fs.writeFileSync(path.join(canvasDir, `${id}.json`), JSON.stringify({ id, nodes, edges: [] }));
const { Vault } = require('../../main/vault.js');
let vault;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-search-'));
  canvasDir = path.join(tmp, 'canvases');
  fs.mkdirSync(canvasDir);
  history = new HistoryStore(path.join(tmp, 'chats'));
  vault = new Vault({ send: () => {} });
  vault.root = path.join(tmp, 'vault'); // setRoot() would also start a file watcher
  fs.mkdirSync(path.join(vault.root, 'Проекты'), { recursive: true });
  fs.writeFileSync(path.join(vault.root, 'Проекты', 'План.md'), '# План\n\nДата релиза — пятница\n');
  fs.writeFileSync(path.join(vault.root, 'Релизы.md'), 'список');
  idx = new SearchIndex({ canvasDir, history, vault });
  write('c_a', [
    { id: 'st1', type: 'sticky', data: { text: 'Купить молоко\nи хлеб' } },
    { id: 'tx1', type: 'text', data: { html: '<p>План <b>релиза</b> &amp; сборки</p>' } },
    { id: 'fr1', type: 'frame', data: { title: 'Этап 1' } },
    { id: 'im1', type: 'image', data: { name: 'Схема', src: `data:image/png;base64,${'релиз'.repeat(1000)}` } },
    { id: 'ag1', type: 'agentchat', data: { title: 'Сборка', messages: [{ role: 'user', content: 'Почини сборку' }, { role: 'assistant', content: '', parts: [{ type: 'tool', name: 'Команда', input: 'npm run build' }, { type: 'text', text: 'Сборка починена: обновил webpack' }] }] } },
    { id: 'wg1', type: 'widget', data: { kind: 'checklist', title: 'Дела', items: [{ id: 't1', text: 'позвонить в банк' }] } },
  ]);
  write('c_b', [{ id: 'st2', type: 'sticky', data: { text: 'Релиз в пятницу' } }]);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('объекты холстов: текст стикеров, текста без разметки, области, чек-листы; картинки по названию, без данных', () => {
  const e = canvasEntries(JSON.parse(fs.readFileSync(path.join(canvasDir, 'c_a.json'), 'utf8')));
  assert.deepEqual(e.find((x) => x.nodeId === 'tx1'), { nodeId: 'tx1', type: 'text', title: 'План релиза & сборки', text: 'План релиза & сборки\n' });
  assert.equal(e.find((x) => x.nodeId === 'im1').text, '');
  assert.deepEqual(e.filter((x) => x.nodeId === 'ag1').map((x) => x.msg), [undefined, 0, 1]);
  assert.match(e.find((x) => x.nodeId === 'ag1' && x.msg === 1).text, /npm run build[\s\S]*webpack/);
});

test('все слова, без учёта регистра, по всем холстам; сообщения чатов с номером; заметки; плохие id пропускаются', async () => {
  const r = await idx.search('РЕЛИЗ', { canvasIds: ['c_a', 'c_b', '../c_a', 'нет'] });
  assert.deepEqual(r.objects.map((o) => [o.canvasId, o.nodeId]), [['c_a', 'tx1'], ['c_b', 'st2']], 'картинка с «релиз» в данных не найдена');
  assert.equal(r.objects[1].snippet, 'Релиз в пятницу');
  assert.deepEqual(r.notes.map((n) => n.path), ['Релизы.md', 'Проекты/План.md'], 'совпадение в названии выше');
  assert.equal(r.notes[1].snippet, '# План Дата релиза — пятница');
  assert.deepEqual((await idx.search('пятница план', { canvasIds: [] })).notes.map((n) => n.path), ['Проекты/План.md'], 'все слова, в любом порядке');

  const chat = await idx.search('сборка webpack', { canvasIds: ['c_a'] });
  assert.deepEqual(chat.objects.map((o) => [o.nodeId, o.msg, o.role]), [['ag1', 1, 'assistant']]);
  assert.match(chat.objects[0].snippet, /Сборка починена: обновил webpack/);
  assert.deepEqual((await idx.search('банк', { canvasIds: ['c_a'] })).objects.map((o) => o.title), ['Дела']);
  assert.deepEqual((await idx.search('   ', { canvasIds: ['c_a'] })).objects, []);
});

test('файл холста читается снова, только когда изменился', async () => {
  await idx.search('молоко', { canvasIds: ['c_a'] });
  const first = idx.canvases.get('c_a').entries;
  await idx.search('хлеб', { canvasIds: ['c_a'] });
  assert.equal(idx.canvases.get('c_a').entries, first, 'тот же разбор');
  write('c_a', [{ id: 'st9', type: 'sticky', data: { text: 'Купить кефир, а не молоко' } }]);
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(canvasDir, 'c_a.json'), t, t);
  assert.deepEqual((await idx.search('кефир', { canvasIds: ['c_a'] })).objects.map((o) => o.nodeId), ['st9']);
  fs.unlinkSync(path.join(canvasDir, 'c_a.json'));
  assert.deepEqual((await idx.search('кефир', { canvasIds: ['c_a'] })).objects, []);
});

test('история чатов: найденное сообщение с номером, новые первыми', async () => {
  await history.save({ id: 'cv_old', kind: 'chat', agent: 'openai', provider: 'openai', title: 'Старый', messages: [{ role: 'user', content: 'про миграцию базы' }, { role: 'assistant', content: 'Миграция: добавить колонку' }] });
  await new Promise((r) => setTimeout(r, 5));
  await history.save({ id: 'cv_new', kind: 'agentchat', agent: 'codex', title: 'Новый', messages: [{ role: 'user', content: 'миграция готова?' }] });
  const r = await idx.search('миграци', { canvasIds: [] });
  assert.deepEqual(r.chats.map((c) => [c.id, c.msg, c.kind]), [['cv_new', 0, 'agentchat'], ['cv_old', 0, 'chat']]);
  assert.deepEqual((await idx.search('миграция колонку', { canvasIds: [] })).chats.map((c) => [c.id, c.msg]), [['cv_old', 1]]);
});

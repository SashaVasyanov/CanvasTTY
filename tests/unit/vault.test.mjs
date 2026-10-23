// The notes vault (main/vault.js): a plain Obsidian-compatible folder of .md files — paths stay
// inside it, links / tags are indexed, copies are numbered, renames fix [[links]] and per-note styles.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vault } = require('../../main/vault.js');

let tmp, v;
const put = (rel, text) => { const p = path.join(tmp, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (rel) => fs.readFileSync(path.join(tmp, ...rel.split('/')), 'utf8');
const exists = (rel) => fs.existsSync(path.join(tmp, ...rel.split('/')));
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-vault-'));
  v = new Vault({ send: () => {} });
  v.root = tmp; // setRoot() would also start a file watcher
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('пути', () => {
  test('ничего нельзя прочитать или записать за пределами хранилища', async () => {
    assert.equal(v.abs('Папка/Заметка.md'), path.join(tmp, 'Папка', 'Заметка.md'));
    assert.equal(v.abs(''), path.resolve(tmp));
    for (const bad of ['../secret.md', 'a/../../secret.md', path.resolve(tmp, '..', 'x.md'), path.resolve(os.tmpdir(), 'other.md')]) {
      assert.throws(() => v.abs(bad), /Путь вне хранилища/, bad);
    }
    await assert.rejects(v.read('../x.md'), /Путь вне хранилища/);
    await assert.rejects(v.write('../x.md', 'x'), /Путь вне хранилища/);
    await assert.rejects(v.rename('a.md', '../b.md'), /Путь вне хранилища/);
    // a sibling folder whose name starts with the vault's name is outside too
    assert.throws(() => v.abs(`../${path.basename(tmp)}-evil/x.md`), /Путь вне хранилища/);
  });

  test('относительные пути всегда с прямым слэшем (одинаково на Windows и macOS)', () => {
    assert.equal(v.rel(path.join(tmp, 'Проекты', 'Монтаж.md')), 'Проекты/Монтаж.md');
  });
});

describe('ссылки и теги', () => {
  test('[[ссылки]] с алиасом и заголовком, #теги с кириллицей и вложенностью, теги из frontmatter', () => {
    const text = '---\ntags: [старт, #canvas]\n---\n# Заголовок\n\nСм. [[Идеи]], [[Цель|алиас]], [[Монтаж#Шаги]] и снова [[Идеи]].\n#проект/canvas #идея_1 (#в-скобках) #2026 не#тег\n\n```js\nconst a = "#невидимый";\n```\nи `#код`';
    const { links, tags } = Vault.parse(text);
    assert.deepEqual(links, ['Идеи', 'Цель', 'Монтаж']);
    assert.deepEqual(tags.sort(), ['canvas', 'в-скобках', 'идея_1', 'проект/canvas', 'старт'].sort());
  });

  test('индекс: заметки с превью без разметки, папки, вложения; служебные папки пропускаются', async () => {
    put('Идеи.md', '---\ntags: [a]\n---\n# Идеи\n\n**Жирный** текст и [[Проекты/Монтаж]] #идея\n');
    put('Проекты/Монтаж.md', 'Шаги');
    put('Проекты/Видео/Сценарий.md', 'текст');
    put('attachments/img.png', 'PNG');
    for (const hidden of ['.obsidian/app.json', '.git/HEAD', '.vibetabula/note-styles.json', 'node_modules/x.md', '.trash/old.md', '.hidden.md']) put(hidden, '#скрыто');
    const idx = await v.index();
    assert.equal(idx.root, tmp);
    assert.deepEqual(idx.notes.map((n) => n.path).sort(), ['Идеи.md', 'Проекты/Видео/Сценарий.md', 'Проекты/Монтаж.md']);
    assert.deepEqual(idx.folders, ['attachments', 'Проекты', 'Проекты/Видео'].sort());
    assert.deepEqual(idx.assets, ['attachments/img.png']);
    const ideas = idx.notes.find((n) => n.name === 'Идеи');
    assert.equal(ideas.preview, 'Идеи Жирный текст и Проекты/Монтаж идея');
    assert.deepEqual(ideas.links, ['Проекты/Монтаж']);
    assert.deepEqual(ideas.tags.sort(), ['a', 'идея']);
    assert.ok(ideas.mtime > 0 && ideas.size > 0);
  });
});

describe('создание заметок', () => {
  test('имя очищается от запрещённых в Windows символов, занятое получает номер', async () => {
    assert.equal(await v.create('', 'Вопрос: что? <да>|нет'), 'Вопрос- что- -да--нет.md');
    assert.equal(await v.create('Папка', 'Идея', 'текст'), 'Папка/Идея.md');
    assert.equal(await v.create('Папка', 'Идея'), 'Папка/Идея 1.md');
    assert.equal(await v.create('', '  '), 'Без названия.md');
    // names Windows keeps for devices (CON, NUL, COM1…) and trailing dots are not file names there
    assert.equal(await v.create('', 'NUL'), 'NUL (заметка).md');
    assert.equal(await v.create('', 'con.txt'), 'con.txt (заметка).md');
    assert.equal(await v.create('', 'Concert'), 'Concert.md');
    assert.equal(await v.create('', 'Итог...'), 'Итог.md');
    assert.equal(read('Папка/Идея.md'), 'текст');
  });

  test('копия как в Figma: «Идея» → «Идея 2» → «Идея 3», в том числе из «Идея 2»', async () => {
    put('Идеи/Идея.md', 'x');
    assert.equal(await v.createNumbered('Идеи', 'Идея', 'копия'), 'Идеи/Идея 2.md');
    assert.equal(await v.createNumbered('Идеи', 'Идея 2', 'копия'), 'Идеи/Идея 3.md');
    put('Идеи/идея 7.md', 'другой регистр');
    assert.equal(await v.createNumbered('Идеи', 'Идея'), 'Идеи/Идея 8.md');
    assert.equal(read('Идеи/Идея 2.md'), 'копия');
    assert.equal(await v.createNumbered('', 'Цена (руб.)'), 'Цена (руб.) 2.md', 'спецсимволы в имени не ломают поиск номера');
  });
});

describe('переименование', () => {
  test('файл переезжает, [[ссылки]] на него обновляются во всём хранилище', async () => {
    put('Старое имя.md', '# Старое');
    put('Ссылки.md', 'См. [[Старое имя]], [[Старое имя#Раздел]] и [[Старое имя|алиас]], но не [[Старое имя 2]].');
    put('Папка/Ещё.md', '[[Старое имя]]');
    assert.equal(await v.rename('Старое имя.md', 'Архив/Новое имя.md'), 'Архив/Новое имя.md');
    assert.equal(exists('Старое имя.md'), false);
    assert.equal(read('Архив/Новое имя.md'), '# Старое');
    assert.equal(read('Ссылки.md'), 'См. [[Новое имя]], [[Новое имя#Раздел]] и [[Новое имя|алиас]], но не [[Старое имя 2]].');
    assert.equal(read('Папка/Ещё.md'), '[[Новое имя]]');
  });

  test('нельзя затереть существующий файл', async () => {
    put('a.md', 'a'); put('b.md', 'b');
    await assert.rejects(v.rename('a.md', 'b.md'), /уже существует/);
    assert.equal(read('b.md'), 'b');
  });

  test('шрифт и размер заметки переезжают вместе с ней и с папкой', async () => {
    put('Папка/Заметка.md', 'x'); put('Отдельная.md', 'y');
    await v.setStyle('Папка/Заметка.md', { font: 'Georgia', size: 18 });
    await v.setStyle('Отдельная.md', { size: 20 });
    await v.rename('Папка', 'Новая папка');
    await v.rename('Отдельная.md', 'Переименована.md');
    assert.deepEqual(await v.styles(), { 'Новая папка/Заметка.md': { font: 'Georgia', size: 18 }, 'Переименована.md': { size: 20 } });
  });
});

describe('вид заметки (.vibetabula/note-styles.json)', () => {
  test('размер ограничен 8…72, пустой стиль удаляется, файл лежит рядом с заметками', async () => {
    assert.deepEqual(await v.setStyle('a.md', { font: 'Georgia', size: 100.4 }), { font: 'Georgia', size: 72 });
    assert.deepEqual(await v.setStyle('b.md', { size: 3 }), { size: 8 });
    assert.deepEqual(await v.setStyle('c.md', { font: 'x'.repeat(500) }), { font: 'x'.repeat(120) });
    assert.equal(await v.setStyle('a.md', {}), null);
    assert.deepEqual(Object.keys(JSON.parse(read('.vibetabula/note-styles.json'))).sort(), ['b.md', 'c.md']);
  });

  test('стили из папки под старым названием приложения (.canvastty) читаются', async () => {
    put('.canvastty/note-styles.json', JSON.stringify({ 'a.md': { size: 16 } }));
    assert.deepEqual(await v.styles(), { 'a.md': { size: 16 } });
    await v.setStyle('b.md', { size: 12 });
    assert.deepEqual(await v.styles(), { 'a.md': { size: 16 }, 'b.md': { size: 12 } }, 'дальше пишутся в .vibetabula');
    assert.equal(exists('.vibetabula/note-styles.json'), true);
  });
});

describe('поиск, удаление, вложения', () => {
  test('поиск: совпадение в имени выше, до трёх фрагментов с контекстом', async () => {
    put('Рецепт борща.md', 'свёкла');
    put('Покупки.md', 'купить борщ, ещё борщ, снова борщ и опять борщ');
    put('Другое.md', 'ничего');
    const r = await v.search('БОРЩ');
    assert.deepEqual(r.map((x) => x.name), ['Рецепт борща', 'Покупки']);
    assert.equal(r[1].matches.length, 3);
    assert.deepEqual(r[1].matches[0], { before: 'купить ', hit: 'борщ', after: ', ещё борщ, снова борщ и опять борщ' });
    assert.deepEqual(await v.search('  '), []);
  });

  test('удаление: в корзину системы, а если её нет — просто удалить', async () => {
    put('a.md', 'a'); put('Папка/b.md', 'b');
    const trashed = [];
    await v.remove('a.md', { trashItem: async (p) => { trashed.push(p); fs.rmSync(p); } });
    assert.deepEqual(trashed, [path.join(tmp, 'a.md')]);
    await v.remove('Папка', { trashItem: async () => { throw new Error('нет корзины'); } });
    assert.equal(exists('Папка'), false);
    await assert.rejects(v.remove('../x', {}), /Путь вне хранилища/);
  });

  test('картинка из буфера: сохраняется в attachments и читается обратно', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const url = `data:image/png;base64,${png.toString('base64')}`;
    const rel = await v.saveAsset(url, 'Скриншот.jpeg');
    assert.equal(rel, 'attachments/Скриншот.png', 'расширение по типу данных');
    assert.equal(await v.saveAsset(url, 'Скриншот.png'), 'attachments/Скриншот 1.png');
    assert.match(await v.saveAsset(`data:image/webp;base64,AAAA`), /^attachments\/Pasted image .+\.webp$/);
    assert.equal(await v.readAsset(rel), url);
    await assert.rejects(v.saveAsset('не data url'), /bad data url/);
  });
});

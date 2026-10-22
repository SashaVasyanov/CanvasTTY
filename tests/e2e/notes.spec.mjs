// Notes: copies get their own .md file, font and size per note, the editor toolbar and the
// format bubble, Markdown round trip, duplicates that do not share data with the original.
import { test, expect } from './fixtures.mjs';
import { createNote, readNote, notePaths, savedNoteStyles, editorLook, selectText, reloadApp, canvasIdle } from './helpers/notes.mjs';

const WELCOME = 'Добро пожаловать в VibeTabula.md';

test.describe('копии заметок', () => {
  test('Alt+перетаскивание заметки: копия со своим файлом, правка копии не трогает оригинал', async ({ app, page }) => {
    await createNote(page, 'Исходная', 'Текст оригинала');
    const orig = await app.add('note', { x: 0, y: 100, w: 360, h: 260, data: { path: 'Исходная.md' } });
    await expect(app.el(orig).locator('.rich-content')).toContainText('Текст оригинала');

    await canvasIdle(page);
    const head = await app.box(orig, '.node-head');
    await app.drag({ x: head.x + 60, y: head.cy }, { x: head.x + 480, y: head.cy + 60 }, { modifiers: ['Alt'] });

    await expect.poll(async () => (await app.nodes('note')).length).toBe(2);
    const original = await app.node(orig);
    expect(original.x, 'оригинал остаётся на месте').toBe(0);
    expect(original.y).toBe(100);
    await expect.poll(async () => (await app.nodes('note')).map((n) => n.data.path).sort()).toEqual(['Исходная 2.md', 'Исходная.md']);
    const copy = (await app.nodes('note')).find((n) => n.id !== orig);
    expect(copy.x, 'копия уехала за курсором').toBeGreaterThan(300);
    expect(await app.selection(), 'выделена копия').toEqual([copy.id]);
    expect(await readNote(page, 'Исходная 2.md')).toContain('Текст оригинала');

    // typing into the copy changes only the copy's file
    const ed = app.el(copy.id).locator('.rich-content');
    await expect(ed).toContainText('Текст оригинала');
    const b = await ed.boundingBox();
    await page.mouse.click(b.x + 40, b.y + 20);
    await page.keyboard.press('End');
    await page.keyboard.type(' + правка копии');
    await expect.poll(() => readNote(page, 'Исходная 2.md')).toContain('Текст оригинала + правка копии');
    expect(await readNote(page, 'Исходная.md')).not.toContain('правка копии');
    await expect(app.el(orig).locator('.rich-content')).not.toContainText('правка копии');
  });

  test('Ctrl+D по заметке: «Имя 2», «Имя 3», отмена убирает файл копии, повтор возвращает', async ({ app, page }) => {
    await createNote(page, 'Идея', 'черновик идеи');
    const orig = await app.add('note', { x: 0, y: 0, data: { path: 'Идея.md' } });
    for (const expected of ['Идея 2.md', 'Идея 3.md']) {
      await app.select([orig]);
      await page.evaluate(() => window.__app.canvas.duplicate());
      await expect.poll(async () => (await app.nodes('note')).map((n) => n.data.path)).toContain(expected);
    }
    await expect.poll(() => notePaths(page)).toEqual(expect.arrayContaining(['Идея.md', 'Идея 2.md', 'Идея 3.md']));
    expect(await readNote(page, 'Идея 3.md')).toContain('черновик идеи');

    await app.undo();
    expect((await app.nodes('note')).map((n) => n.data.path).sort()).toEqual(['Идея 2.md', 'Идея.md']);
    await expect.poll(() => readNote(page, 'Идея 3.md'), { message: 'файл отменённой копии убран' }).toBeNull();
    await app.redo();
    await expect.poll(() => readNote(page, 'Идея 3.md'), { message: 'повтор возвращает файл' }).toContain('черновик идеи');
  });

  test('дубликат стикера, заметки, текста и фигуры не делит данные с оригиналом', async ({ app, page }) => {
    await app.add('sticky', { x: 0, y: 100, data: { text: 'S' } });
    await app.add('note', { x: 300, y: 100, data: { path: WELCOME } });
    await app.add('text', { x: 0, y: 450, data: { html: 'T' } });
    await app.add('shape', { x: 200, y: 450, w: 120, h: 80, data: { kind: 'rect', text: 'R' } });
    await page.evaluate(() => { const c = window.__app.canvas; c.select(c.doc.nodes.map((n) => n.id)); c.duplicate(); });
    await expect.poll(async () => (await app.nodes()).length).toBe(8);

    const shared = await page.evaluate(() => {
      const by = {};
      for (const n of window.__app.canvas.doc.nodes) (by[n.type] ||= []).push(n);
      return Object.fromEntries(Object.entries(by).map(([t, ns]) => [t, ns.length === 2 && ns[0].data === ns[1].data]));
    });
    expect(shared).toEqual({ sticky: false, note: false, text: false, shape: false });

    // editing the copy leaves the original as it was
    const [s1, s2] = await app.nodes('sticky');
    await page.evaluate((id) => window.__app.canvas.updateNode(id, { data: { text: 'копия' } }), s2.id);
    expect((await app.node(s1.id)).data.text).toBe('S');
    await expect.poll(async () => (await app.nodes('note')).map((n) => n.data.path).sort()).toEqual(['Добро пожаловать в VibeTabula 2.md', WELCOME]);
  });
});

test.describe('шрифт и размер заметки', () => {
  test('выбираются на панели, одинаковы на canvas и в боковом редакторе, переживают перезапуск', async ({ app, page }) => {
    test.slow();
    await createNote(page, 'Шрифты', '# Заголовок\n\nОбычный текст заметки для проверки шрифта.\n\n```js\nconst code = 1;\n```');
    await app.add('note', { x: 0, y: 0, data: { path: 'Шрифты.md' } }, { select: true });
    await page.evaluate(() => window.__app.openNote('Шрифты.md'));
    await expect(page.locator('.note-panel .rich-content h1')).toHaveText('Заголовок');
    const look = () => editorLook(page);
    expect((await look()).map((l) => [l.where, l.button, l.size, l.fontFamily])).toEqual([['canvas', 'Шрифт', '', ''], ['panel', 'Шрифт', '', '']]);

    // a font from the list (only fonts installed on this computer are offered)
    await page.locator('.note-panel .ns-fontbtn').click();
    const rows = page.locator('.ns-pop .menu-item .menu-label');
    await expect(rows.first()).toHaveText('По умолчанию');
    await expect(rows.last()).toHaveText('Другой шрифт компьютера…');
    const offered = await page.locator('.ns-pop .ns-list .menu-label').allTextContents();
    if (offered.length) {
      await page.locator('.ns-pop .ns-list .menu-item').first().click();
      await expect.poll(async () => (await look()).map((l) => l.button)).toEqual([offered[0], offered[0]]);
      for (const l of await look()) expect(l.fontFamily).toContain(offered[0]);
    } else {
      await page.keyboard.press('Escape');
      test.info().annotations.push({ type: 'note', description: 'на этом компьютере не нашлось ни одного шрифта из списка' });
    }

    // size: type a number, then the + button goes to the next preset
    await page.locator('.note-panel .ns-size').click();
    await page.keyboard.type('20');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await look()).map((l) => [l.fontSize, l.size])).toEqual([['20px', '20'], ['20px', '20']]);
    await page.locator('.note-panel .ns-step', { hasText: '+' }).click();
    await expect.poll(async () => (await look()).map((l) => l.fontSize)).toEqual(['22px', '22px']);

    // any other font of the computer by name
    await page.locator('.note-panel .ns-fontbtn').click();
    await page.locator('.ns-pop .ns-more').click();
    await expect(page.locator('.ns-pop .ns-search')).toBeFocused();
    await page.keyboard.type('Georgia');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await look()).map((l) => l.button)).toEqual(['Georgia', 'Georgia']);
    expect((await look())[1].fontFamily).toContain('Georgia');

    // back to the default font; the size stays
    await page.locator('.note-panel .ns-fontbtn').click();
    await page.locator('.ns-pop .menu-item', { hasText: 'По умолчанию' }).click();
    await expect.poll(async () => (await look()).map((l) => [l.button, l.fontFamily, l.fontSize])).toEqual([['Шрифт', '', '22px'], ['Шрифт', '', '22px']]);
    expect(await savedNoteStyles(page)).toEqual({ 'Шрифты.md': { size: 22 } });
    expect(await readNote(page, 'Шрифты.md'), 'сам .md файл не меняется').not.toMatch(/font|22/);

    await reloadApp(page);
    await page.evaluate(() => window.__app.openNote('Шрифты.md'));
    await expect(page.locator('.note-panel .rich-content h1')).toHaveText('Заголовок');
    await expect.poll(async () => (await look()).find((l) => l.where === 'panel')).toMatchObject({ fontSize: '22px', size: '22', button: 'Шрифт' });
  });

  test('вид, изменённый снаружи (синхронизация, другое окно), сразу применяется только к своей заметке', async ({ app, page }) => {
    await createNote(page, 'Шрифты', '# Заголовок\n\nОбычный текст заметки.');
    await createNote(page, 'Другая', 'Без своего шрифта');
    await app.add('note', { x: -300, y: -150, data: { path: 'Шрифты.md' } });
    await app.add('note', { x: 200, y: -150, data: { path: 'Другая.md' } });
    await page.evaluate(() => window.__app.openNote('Шрифты.md'));
    await expect(page.locator('.note-panel .rich-content h1')).toHaveText('Заголовок');

    await page.evaluate(async () => { const { noteStyles } = await import('/js/notestyle.js'); await noteStyles.set('Шрифты.md', { font: 'Georgia', size: 18 }); });
    await expect.poll(async () => (await editorLook(page)).filter((l) => l.where === 'panel' || l.path === 'Шрифты.md').map((l) => [l.button, l.fontSize]))
      .toEqual([['Georgia', '18px'], ['Georgia', '18px']]);
    const other = (await editorLook(page)).find((l) => l.path === 'Другая.md');
    expect(other).toMatchObject({ button: 'Шрифт', fontFamily: '', size: '' });
    expect(other.fontSize).not.toBe('18px');
  });
});

test.describe('панель инструментов заметки', () => {
  // toolbar items that are hidden right now, by the label their "⋯" menu row uses
  const hiddenItems = (page) => page.evaluate(() => [...document.querySelectorAll('.note-panel .note-toolbar > .tb-hidden')]
    .filter((k) => !k.classList.contains('tb-sep') && !k.classList.contains('tb-more')).map((k) => k.title.replace(/\s*\(.*\)$/, '')));
  const fits = (page) => page.evaluate(() => { const tb = document.querySelector('.note-panel .note-toolbar'); return tb.scrollWidth <= tb.clientWidth + 1; });

  test('не вылезает за край боковой панели: лишние кнопки уходят в меню ⋯', async ({ app, page }) => {
    await page.evaluate((p) => window.__app.openNote(p), WELCOME);
    await expect(page.locator('.note-panel .rich-content h1')).toBeVisible();
    await expect.poll(() => fits(page)).toBe(true);

    await page.setViewportSize({ width: 900, height: 860 }); // the smallest window the app allows
    await expect.poll(() => fits(page)).toBe(true);
    await expect(page.locator('.note-panel .tb-more')).toBeVisible();
    const hidden = await hiddenItems(page);
    expect(hidden).toEqual(expect.arrayContaining(['Жирный', 'Отменить']));

    await page.locator('.note-panel .tb-more').click();
    const menuLabels = await page.evaluate(() => [...document.querySelectorAll('.menu:not(.sub) > .menu-item > .menu-label')].map((x) => x.textContent));
    for (const h of hidden) expect(menuLabels.some((l) => l.startsWith(h)), `«${h}» есть в меню ⋯`).toBe(true);
    expect(menuLabels, 'видимые кнопки не дублируются в меню').not.toContain('Стиль текста');
  });

  test('«Жирный» из меню ⋯ не теряет выделение и сохраняется в .md', async ({ app, page }) => {
    await page.setViewportSize({ width: 900, height: 860 });
    await page.evaluate((p) => window.__app.openNote(p), WELCOME);
    await expect(page.locator('.note-panel .rich-content p').first()).toContainText('Это хранилище');
    expect(await selectText(page, '.note-panel .rich-content p', 0, 4)).toBe('Это ');
    await page.locator('.note-panel .tb-more').click();
    await page.locator('.menu .menu-item', { hasText: 'Жирный' }).click();
    expect(await page.locator('.note-panel .rich-content p').first().innerHTML()).toMatch(/^<(b|strong)>Это <\/(b|strong)>хранилище/);
    expect(await page.evaluate(() => getSelection().toString()), 'текст остаётся выделенным').toBe('Это ');
    await expect.poll(async () => (await readNote(page, WELCOME)).split('\n')[2]).toBe('**Это** хранилище заметок — обычная папка с файлами **Markdown**, совместимая с Obsidian.');
  });

  test('над выделенным текстом заметки на canvas появляется плавающая панель', async ({ app, page }) => {
    await createNote(page, 'Формат', 'Первое слово и остальной текст\n\nВторой абзац');
    const id = await app.add('note', { x: 100, y: 80, w: 380, h: 360, data: { path: 'Формат.md' } });
    const p1 = app.el(id).locator('.rich-content p').first();
    await expect(p1).toHaveText('Первое слово и остальной текст');
    await canvasIdle(page);
    const bb = await p1.boundingBox();
    await page.mouse.click(bb.x + 2, bb.y + bb.height / 2);
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    const bubble = page.locator('.fmt-bubble');
    await expect(bubble).toBeVisible();
    expect(await page.evaluate(() => getSelection().toString())).toBe('Первое');
    expect(await app.selection(), 'выделение текста не выделяет окно').toEqual([]);

    await bubble.locator('.fb-btn[data-cmd="bold"]').click();
    await expect(bubble.locator('.fb-btn[data-cmd="bold"]')).toHaveClass(/\bon\b/);
    await bubble.locator('.fb-btn[data-cmd="italic"]').click();
    await expect(bubble.locator('.fb-btn[data-cmd="italic"]')).toHaveClass(/\bon\b/);
    expect(await p1.innerHTML()).toMatch(/^<(b|i)><(b|i)>Первое<\/(b|i)><\/(b|i)> слово/);

    // a click elsewhere in the text collapses the selection and hides the bar
    await page.mouse.click(bb.x + 200, bb.y + bb.height / 2);
    await expect(bubble).toHaveCount(0);
    await expect.poll(async () => (await readNote(page, 'Формат.md')).split('\n')[0]).toBe('***Первое*** слово и остальной текст');

    // Aa in the bar turns the paragraph into a heading
    await selectText(page, `.node[data-id="${id}"] .rich-content p:nth-of-type(2)`, 0, 6);
    await expect(bubble).toBeVisible();
    await bubble.locator('.fb-btn').first().click();
    await expect(page.locator('.aa-pop .menu-label').first()).toHaveText('Заголовок');
    await page.locator('.aa-pop .menu-item', { hasText: /^Заголовок$/ }).click();
    await expect(app.el(id).locator('.rich-content h1')).toHaveText('Второй абзац');
    await expect.poll(() => readNote(page, 'Формат.md')).toContain('\n# Второй абзац');
  });
});

test.describe('Markdown', () => {
  test('заметка в стиле Obsidian проходит путь md → редактор → md без изменений', async ({ app, page }) => {
    const md = [
      '---', 'tags: [a, b]', '---', '# Заголовок', '',
      'Обычный **жирный** и *курсив*, ~~зачёркнутый~~, `код`, ==маркер== и <u>подчёркнутый</u>.', '',
      'Ссылка на [[Другая заметка]] и [[Цель|алиас]], тег #проект/canvas, url [сайт](https://example.com).', '',
      '- пункт 1', '- пункт 2', '    - вложенный', '- [ ] задача', '- [x] сделано', '',
      '1. раз', '2. два', '',
      '> цитата', '> вторая строка', '',
      '```js', 'const a = 1;', '```', '',
      '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
      '---', '',
      '![[image.png]]', 'Строка с переносом', 'вторая строка', '',
    ].join('\n');
    const plain = 'Простой текст с * звёздочкой и snake_case_name и путь C:\\Users\\vasya.\n';
    const res = await page.evaluate(async (cases) => {
      const { mdToHtml, htmlToMd, splitFrontmatter } = await import('/js/md.js');
      return cases.map((src) => {
        const { fm } = splitFrontmatter(src);
        const d1 = document.createElement('div'); d1.innerHTML = mdToHtml(src);
        const back = htmlToMd(d1, fm);
        const d2 = document.createElement('div'); d2.innerHTML = mdToHtml(back);
        return { back, back2: htmlToMd(d2, fm), text1: d1.textContent, text2: d2.textContent, html: d1.innerHTML };
      });
    }, [md, plain]);

    expect(res[0].back).toBe(md);
    expect(res[0].html).toContain('<li data-checked="false">задача</li>');
    expect(res[0].html).toContain('class="wikilink" data-target="Цель" data-alias="1">алиас</a>');
    expect(res[0].html).toContain('<span class="tag" data-tag="проект/canvas">');
    // special characters of plain text survive (escaped where Markdown needs it) and stay stable
    expect(res[1].back2).toBe(res[1].back);
    expect(res[1].text2).toBe(res[1].text1);
    expect(res[1].text1).toContain('C:\\Users\\vasya.');
    expect(res[1].text1).toContain('с * звёздочкой и snake_case_name');
  });
});

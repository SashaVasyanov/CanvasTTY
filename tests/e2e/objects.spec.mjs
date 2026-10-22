// Canvas objects and interaction: creating with tools, Alt+drag copies, areas as groups, "grab"
// mode, arrows, text editing and font size, copies of notes with their files, the layers panel.
import { test, expect } from './fixtures.mjs';
import { emptySpot, toPage, center, menuItem, vault, waitRest } from './helpers/canvas.mjs';

// right after a viewport change objects ignore the pointer for a moment: start from a resting view
test.beforeEach(async ({ app, page }) => { await waitRest(page); });

const sticky = (app, text) => app.nodes('sticky').then((l) => l.filter((n) => n.data.text === text));

test.describe('создание объектов инструментами', () => {
  test('S и клик ставят стикер и сразу открывают его для текста; клик мимо сохраняет', async ({ app, page }) => {
    const p1 = await toPage(page, 100, 100), p2 = await toPage(page, 400, 150);
    await page.keyboard.press('s');
    await page.mouse.click(p1.x, p1.y);
    await expect(page.locator('.node-sticky .txt[contenteditable="true"]')).toBeFocused();
    await page.keyboard.type('Идея: агент для ревью');
    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    await page.keyboard.press('s');
    await page.mouse.click(p2.x, p2.y);
    await page.keyboard.type('Второй');
    await page.mouse.click(away.x, away.y);
    await expect.poll(async () => (await app.nodes('sticky')).map((n) => n.data.text).sort()).toEqual(['Второй', 'Идея: агент для ревью']);
    expect(await page.evaluate(() => window.__app.canvas.tool), 'после создания снова «Выделение»').toBe('select');
    const first = (await sticky(app, 'Идея: агент для ревью'))[0];
    expect(first.x + first.w / 2, 'стикер стоит там, где кликнули').toBeCloseTo(100, -1);
    expect(first.y + first.h / 2).toBeCloseTo(100, -1);
  });

  test('R и протягивание рисуют прямоугольник по размеру рамки, с подписью', async ({ app, page }) => {
    const a = await toPage(page, 100, 300), b = await toPage(page, 300, 420);
    await page.keyboard.press('r');
    await app.drag(a, b);
    await page.keyboard.type('Шаг 1');
    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    const shapes = await app.nodes('shape');
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ x: 100, y: 300, data: { kind: 'rect', text: 'Шаг 1' } });
    expect(Math.round(shapes[0].w)).toBe(200);
    expect(Math.round(shapes[0].h)).toBe(120);
  });

  test('двойной и тройной клик по пустому холсту ничего не создают', async ({ app, page }) => {
    const p = await emptySpot(page);
    await page.mouse.dblclick(p.x, p.y);
    await page.mouse.click(p.x, p.y, { clickCount: 3 });
    expect(await app.nodes()).toEqual([]);
    expect(await page.evaluate(() => window.__app.canvas.tool)).toBe('select');
  });

  test('рамка выделяет объекты, «По верху» выравнивает их, Ctrl+D дублирует', async ({ app, page }) => {
    const s1 = await app.add('sticky', { x: 0, y: 0, w: 160, h: 160, data: { text: 'один' } });
    const s2 = await app.add('sticky', { x: 260, y: 90, w: 160, h: 160, data: { text: 'два' } });
    const from = await toPage(page, -60, -60), to = await toPage(page, 480, 300);
    await app.drag(from, to);
    expect((await app.selection()).sort()).toEqual([s1, s2].sort());
    await page.locator('.sel-toolbar .st-btn[title="По верху"]').click();
    expect((await app.node(s1)).y).toBe(0);
    expect((await app.node(s2)).y).toBe(0);
    await app.select([s2]);
    await page.keyboard.press('Control+d');
    const copies = await sticky(app, 'два');
    expect(copies).toHaveLength(2);
    const copy = copies.find((n) => n.id !== s2);
    expect(copy).toMatchObject({ x: 260 + 32, y: 32 });
    expect(await app.selection()).toEqual([copy.id]);
  });
});

test.describe('стрелки между объектами', () => {
  test('стрелка от точки на краю к другому объекту; Ctrl+Z убирает, Ctrl+Shift+Z возвращает', async ({ app, page }) => {
    const s = await app.add('sticky', { x: 0, y: 0, w: 200, h: 160, data: { text: 'начало' } });
    const r = await app.add('shape', { x: 120, y: 360, w: 200, h: 120, data: { kind: 'rect' } });
    await app.select([s]);
    const dot = await center(page.locator('.conn-dot.d-bottom'));
    const target = await app.box(r);
    await app.drag(dot, { x: target.cx, y: target.cy });
    await expect.poll(() => app.edges()).toEqual([expect.objectContaining({ from: s, to: r })]);
    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    await page.keyboard.press('Control+z');
    expect(await app.edges()).toEqual([]);
    await page.keyboard.press('Control+Shift+z');
    expect(await app.edges()).toEqual([expect.objectContaining({ from: s, to: r })]);
  });

  test.describe('протягивание прерывается без следов', () => {
    let id;
    const preview = (page) => page.evaluate(() => document.querySelector('.edge-preview').getAttribute('d') || '');
    test.beforeEach(async ({ app }) => {
      id = await app.add('sticky', { x: 0, y: 0, w: 200, h: 200, data: { text: 'источник' } });
      await app.select([id]);
    });

    test('источник удалили во время протягивания: превью исчезает, стрелки нет', async ({ app, page }) => {
      const dot = await center(page.locator('.conn-dot.d-right'));
      await page.mouse.move(dot.x, dot.y); await page.mouse.down();
      await page.mouse.move(dot.x + 150, dot.y + 120, { steps: 5 });
      await expect.poll(() => preview(page)).not.toBe('');
      await page.evaluate((id) => window.__app.canvas.removeNodes([id]), id);
      expect(await preview(page)).toBe('');
      await page.mouse.up();
      expect(await app.edges()).toEqual([]);
      await expect(page.locator('.menu')).toHaveCount(0);
    });

    test('потерянный pointerup (pointercancel) сбрасывает протягивание', async ({ app, page }) => {
      const dot = await center(page.locator('.conn-dot.d-right'));
      await page.mouse.move(dot.x, dot.y); await page.mouse.down();
      await page.mouse.move(dot.x + 200, dot.y + 50, { steps: 5 });
      await expect.poll(() => preview(page)).not.toBe('');
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
      expect(await preview(page)).toBe('');
      expect(await page.evaluate(() => !!window.__app.canvas.dragging)).toBe(false);
      await page.mouse.up();
      expect(await app.edges()).toEqual([]);
    });

    test('отпустить на пустом месте — меню «Создать и соединить», Esc закрывает его', async ({ app, page }) => {
      const dot = await center(page.locator('.conn-dot.d-right'));
      await app.drag(dot, { x: dot.x + 300, y: dot.y + 200 });
      expect(await preview(page)).toBe('');
      await expect(page.locator('.menu .menu-header')).toHaveText('Создать и соединить');
      await page.keyboard.press('Escape');
      await expect(page.locator('.menu')).toHaveCount(0);
      expect(await app.edges()).toEqual([]);
    });
  });
});

test.describe('Alt + перетаскивание копирует (как в Figma)', () => {
  let ids;
  test.beforeEach(async ({ app, page }) => {
    const f = await app.add('frame', { x: 0, y: 0, w: 500, h: 360, data: { title: 'Зона' } });
    const a = await app.add('sticky', { x: 40, y: 80, w: 180, h: 180, data: { text: 'A' } });
    const b = await app.add('sticky', { x: 280, y: 80, w: 180, h: 180, data: { text: 'B' } });
    const l = await app.add('sticky', { x: 650, y: 0, w: 180, h: 180, data: { text: 'L' } });
    await page.evaluate(([a, b]) => { const c = window.__app.canvas; c.addEdge(a, b); c.recomputeGroups('all'); c.undoStack.length = 0; }, [a, b]);
    ids = { f, a, b, l };
  });

  test('отдельный стикер: оригинал остаётся на месте, тянется выделенная копия', async ({ app }) => {
    const l = await app.box(ids.l);
    await app.drag({ x: l.cx, y: l.cy }, { x: l.cx + 150, y: l.cy + 40 }, { modifiers: ['Alt'] });
    const ls = await sticky(app, 'L');
    expect(ls).toHaveLength(2);
    expect(await app.node(ids.l)).toMatchObject({ x: 650, y: 0 });
    const copy = ls.find((n) => n.id !== ids.l);
    expect(copy.x).toBeGreaterThan(650 + 100);
    expect(copy.y).toBeGreaterThan(20);
    expect(await app.selection()).toEqual([copy.id]);
  });

  test('область за название копируется вместе с содержимым и стрелкой, копия — «Зона 2»', async ({ app }) => {
    const t = await app.box(ids.f, '.frame-title');
    await app.drag({ x: t.x + 10, y: t.cy }, { x: t.x + 20, y: t.cy + 420 }, { modifiers: ['Alt'] });
    const frames = await app.nodes('frame');
    expect(frames.map((f) => f.data.title).sort()).toEqual(['Зона', 'Зона 2']);
    expect(await app.node(ids.f)).toMatchObject({ x: 0, y: 0 });
    const copy = frames.find((f) => f.id !== ids.f);
    expect(copy.y).toBeGreaterThan(300);
    const inCopy = (await app.nodes('sticky')).filter((n) => n.parent === copy.id).map((n) => n.data.text).sort();
    expect(inCopy).toEqual(['A', 'B']);
    expect((await app.nodes('sticky')).filter((n) => n.parent === ids.f).map((n) => n.data.text).sort()).toEqual(['A', 'B']);
    const edges = await app.edges();
    expect(edges).toHaveLength(2);
    const copyIds = new Set((await app.nodes('sticky')).filter((n) => n.parent === copy.id).map((n) => n.id));
    expect(edges.some((e) => copyIds.has(e.from) && copyIds.has(e.to)), 'стрелка между копиями').toBe(true);
  });

  test('Alt, нажатый посреди перетаскивания, превращает перенос в копию; Ctrl+Z её убирает', async ({ app, page }) => {
    const a = await app.box(ids.a);
    await page.mouse.move(a.cx, a.cy); await page.mouse.down();
    await page.mouse.move(a.cx + 10, a.cy - 20); await page.mouse.move(a.cx + 20, a.cy - 40);
    await expect.poll(async () => (await app.node(ids.a)).y, 'обычное перетаскивание двигает сам стикер').toBeLessThan(80);
    expect(await app.nodes('sticky')).toHaveLength(3);
    await page.keyboard.down('Alt');
    await page.mouse.move(a.cx + 40, a.cy - 60, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect(await sticky(app, 'A')).toHaveLength(2);
    expect(await app.node(ids.a), 'оригинал вернулся на место').toMatchObject({ x: 40, y: 80 });
    await page.keyboard.press('Control+z');
    expect(await sticky(app, 'A')).toHaveLength(1);
    expect(await app.node(ids.a)).toMatchObject({ x: 40, y: 80 });
  });
});

test('копии картинок и чатов нумеруются: «Фото 2», «Ревью 2»…', async ({ app, page }) => {
  const im = await app.add('image', { x: 0, y: 0, w: 200, h: 150, data: { vault: 'attachments/Фото.png' } });
  const ch = await app.add('chat', { x: 300, y: 0, data: { title: 'Ревью', messages: [] } });
  for (let i = 0; i < 3; i++) {
    await app.select([im, ch]);
    await page.evaluate(() => window.__app.canvas.duplicate());
    await expect.poll(async () => (await app.nodes('image')).length).toBe(i + 2);
  }
  const names = (await app.nodes('image')).map((n) => n.data.name || n.data.vault.split('/').pop().replace(/\.png$/, '')).sort();
  expect(names).toEqual(['Фото', 'Фото 2', 'Фото 3', 'Фото 4']);
  expect((await app.nodes('chat')).map((n) => n.data.title).sort()).toEqual(['Ревью', 'Ревью 2', 'Ревью 3', 'Ревью 4']);
});

test.describe('области — это группы', () => {
  let ids;
  test.beforeEach(async ({ app, page }) => {
    await app.reset({ x: 150, y: 200 });
    await waitRest(page);
    const f = await app.add('frame', { x: 0, y: 0, w: 700, h: 450, data: { title: 'Фото проекта 1' } });
    const a = await app.add('sticky', { x: 60, y: 90, w: 160, h: 140, data: { text: 'a' } });
    const b = await app.add('sticky', { x: 320, y: 120, w: 160, h: 140, data: { text: 'b' } });
    const out = await app.add('sticky', { x: 900, y: 100, w: 160, h: 140, data: { text: 'out' } });
    await page.evaluate(() => { const c = window.__app.canvas; c.recomputeGroups('all'); c.undoStack.length = 0; });
    ids = { f, a, b, out };
  });
  const count = (app) => app.el(ids.f).locator('.frame-count');
  const interior = async (app) => { const b = await app.box(ids.f); return { x: b.x + b.width - 40, y: b.y + b.height - 40 }; };

  test('брошенный в область объект становится её частью; область везёт содержимое; вынесенный — уходит', async ({ app, page }) => {
    await expect(count(app)).toHaveText('2 объекта');
    const o = await app.box(ids.out);
    await page.mouse.move(o.cx, o.cy); await page.mouse.down();
    await page.mouse.move(o.cx - 380, o.cy + 150, { steps: 6 });
    await expect(app.el(ids.f), 'область, куда попадёт объект, подсвечена').toHaveClass(/drop-target/);
    await page.mouse.up();
    await expect(app.el(ids.f)).not.toHaveClass(/drop-target/);
    expect((await app.node(ids.out)).parent).toBe(ids.f);
    await expect(count(app)).toHaveText('3 объекта');

    const before = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await app.node(id)])));
    const t = await app.box(ids.f, '.frame-title');
    await app.drag({ x: t.x + 20, y: t.cy }, { x: t.x + 120, y: t.cy + 50 });
    const f = await app.node(ids.f);
    const dx = f.x - before.f.x, dy = f.y - before.f.y;
    expect(dx).toBeGreaterThan(80);
    expect(dy).toBeGreaterThan(30);
    for (const k of ['a', 'b', 'out']) {
      const n = await app.node(ids[k]);
      expect([n.x - before[k].x, n.y - before[k].y], `${k} едет вместе с областью`).toEqual([dx, dy]);
    }

    const a = await app.box(ids.a);
    await app.drag({ x: a.cx, y: a.cy }, { x: a.cx, y: a.cy + 500 });
    expect((await app.node(ids.a)).parent).toBeUndefined();
    await expect(count(app)).toHaveText('2 объекта');
  });

  test('«Сгруппировать»: клик по объекту выделяет всю область, Ctrl+клик — сам объект', async ({ app, page }) => {
    const p = await interior(app);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await expect(page.locator('.menu .menu-label')).toContainText(['Ввести название…', 'Сгруппировать: двигать как одно целое', 'Выделить содержимое', 'Разгруппировать (убрать область)', 'Удалить вместе с содержимым']);
    await menuItem(page, 'Сгруппировать: двигать как одно целое').click();
    expect((await app.node(ids.f)).data.grouped).toBe(true);
    const b = await app.box(ids.b);
    await page.mouse.click(b.cx, b.cy);
    expect(await app.selection()).toEqual([ids.f]);
    await page.keyboard.down('Control'); await page.mouse.click(b.cx, b.cy); await page.keyboard.up('Control');
    expect(await app.selection()).toEqual([ids.b]);
    // dragging any object of the group moves the whole group
    const f0 = await app.node(ids.f), a0 = await app.node(ids.a);
    await app.clearSelection();
    await app.drag({ x: b.cx, y: b.cy }, { x: b.cx + 100, y: b.cy + 60 });
    const f1 = await app.node(ids.f), a1 = await app.node(ids.a);
    expect(f1.x - f0.x).toBeGreaterThan(80);
    expect([a1.x - a0.x, a1.y - a0.y]).toEqual([f1.x - f0.x, f1.y - f0.y]);
  });

  test('дубль области — с содержимым; Ctrl+Z убирает его; «Разгруппировать» оставляет объекты на месте', async ({ app, page }) => {
    await app.select([ids.f]);
    await page.keyboard.press('Control+d');
    expect(await app.nodes()).toHaveLength(7);
    expect((await app.nodes('frame')).map((f) => f.data.title).sort()).toEqual(['Фото проекта 1', 'Фото проекта 2']);
    await expect(page.locator('.frame-count')).toHaveText(['2 объекта', '2 объекта']);
    await page.keyboard.press('Control+z');
    expect(await app.nodes()).toHaveLength(4);

    const a0 = await app.node(ids.a), b0 = await app.node(ids.b);
    const p = await interior(app);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menuItem(page, 'Разгруппировать (убрать область)').click();
    expect(await app.nodes('frame')).toEqual([]);
    const a1 = await app.node(ids.a), b1 = await app.node(ids.b);
    expect([a1.x, a1.y, b1.x, b1.y]).toEqual([a0.x, a0.y, b0.x, b0.y]);
    expect(a1.parent).toBeUndefined();
    expect((await app.selection()).sort()).toEqual([ids.a, ids.b].sort());
  });
});

test.describe('перетаскивание за любое место (двойной клик)', () => {
  test('окно чата: обычное перетаскивание по содержимому не двигает окно, после двойного клика — двигает, Esc выключает', async ({ app, page }) => {
    const chat = await app.add('agentchat', { x: 420, y: 0, w: 500, h: 560, data: { agentId: 'claude', kind: 'claude', messages: [] } });
    const before = await app.node(chat);
    const body = await app.box(chat, '.chat-list');
    const p = { x: body.x + 100, y: body.y + 100 };
    await app.drag(p, { x: p.x + 100, y: p.y + 50 });
    expect(await app.node(chat)).toMatchObject({ x: before.x, y: before.y });

    await page.mouse.dblclick(p.x, p.y);
    await expect(app.el(chat)).toHaveClass(/\bgrab\b/);
    await app.drag(p, { x: p.x + 150, y: p.y + 60 });
    const moved = await app.node(chat);
    expect(Math.abs(moved.x - before.x - 150)).toBeLessThanOrEqual(8);
    expect(Math.abs(moved.y - before.y - 60)).toBeLessThanOrEqual(8);
    await page.keyboard.press('Escape');
    await expect(app.el(chat)).not.toHaveClass(/\bgrab\b/);
  });

  test('область: «Ввести название…» в меню, двойной клик внутри — и её можно тянуть', async ({ app, page }) => {
    const f = await app.add('frame', { x: -200, y: 120, w: 500, h: 400 });
    const b = await app.box(f);
    const p = { x: b.x + 250, y: b.y + 250 };
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menuItem(page, 'Ввести название…').click();
    const input = page.locator('.modal input');
    await expect(input).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Фото проекта 1');
    await page.keyboard.press('Enter');
    await expect(page.locator('.modal')).toHaveCount(0);
    expect((await app.node(f)).data.title).toBe('Фото проекта 1');
    await expect(app.el(f).locator('.frame-title')).toHaveText('Фото проекта 1');

    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    // without the double click a drag inside the area draws a selection frame
    await app.drag(p, { x: p.x + 50, y: p.y + 80 });
    expect(await app.node(f)).toMatchObject({ x: -200, y: 120 });
    await page.mouse.dblclick(p.x, p.y);
    await expect(app.el(f)).toHaveClass(/\bgrab\b/);
    await app.drag(p, { x: p.x + 50, y: p.y + 80 });
    const n = await app.node(f);
    expect(Math.abs(n.x - (-200 + 50))).toBeLessThanOrEqual(8);
    expect(Math.abs(n.y - (120 + 80))).toBeLessThanOrEqual(8);
  });
});

// Regression (fixed): focusing a text field of a window whose lower part is below the visible canvas makes the
// browser scroll .canvas-root (overflow: hidden) to reveal the field, so the whole canvas, minimap
// included, jumps up and stays shifted (pointer → world coordinates are wrong from then on). Seen after
// Enter on a selected window, and when a window launched from the dock / menus gets its focus while the
// camera is still flying to it. Cause: inst.edit() → input.focus() without { preventScroll: true }
// (renderer/js/nodes.js), and nothing resets the canvas root's scroll position.
test('Enter по окну, чей низ за краем экрана, открывает поле ввода и не сдвигает холст', async ({ app, page }) => {
  const chat = await app.add('agentchat', { x: 0, y: 400, w: 500, h: 620, data: { agentId: 'claude', kind: 'claude', messages: [] } });
  const head = await app.box(chat, '.head-title');
  await page.mouse.click(head.x + 10, head.cy);
  expect(await app.selection()).toEqual([chat]);
  await page.keyboard.press('Enter');
  await expect(app.el(chat).locator('.chat-input')).toBeFocused();
  expect(await page.evaluate(() => window.__app.canvas.root.scrollTop), 'холст не прокручен браузером').toBe(0);
  await expect(page.locator('.nav-box'), 'миникарта на месте').toBeInViewport();
});

test.describe('текст на холсте', () => {
  const editing = (page) => page.evaluate(() => !!document.querySelector('.free-text[contenteditable="true"]'));
  const caret = (page) => page.evaluate(() => getSelection().anchorOffset);
  // a point inside the first line of the text (the box may be taller than the text)
  const textBox = (app, id) => app.el(id).locator('.free-text').evaluate((el) => {
    const r = document.createRange(); r.selectNodeContents(el); const b = r.getClientRects()[0];
    return { x: b.left + 30, y: b.top + b.height / 2 };
  });

  test('T и клик создают текст в режиме правки, клик мимо сохраняет его', async ({ app, page }) => {
    const p = await toPage(page, 200, 200);
    await page.keyboard.press('t');
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.free-text[contenteditable="true"]')).toBeFocused();
    expect(await page.evaluate(() => window.__app.canvas.tool)).toBe('select');
    await page.keyboard.type('Привет');
    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    expect(await editing(page)).toBe(false);
    expect((await app.nodes('text')).map((n) => n.data.html)).toEqual(['Привет']);
  });

  test('первый клик выделяет текст, второй открывает правку с курсором там, куда кликнули', async ({ app, page }) => {
    const id = await app.add('text', { x: 100, y: 100, w: 320, h: 60, data: { html: 'Привет мир', size: 20 } });
    const p = await textBox(app, id);
    await page.mouse.click(p.x, p.y);
    expect(await app.selection()).toEqual([id]);
    expect(await editing(page)).toBe(false);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => editing(page)).toBe(true);
    const at = await caret(page);
    expect(at, 'курсор внутри текста, а не в начале или в конце').toBeGreaterThan(0);
    expect(at).toBeLessThan('Привет мир'.length);
    await page.keyboard.type('Ж');
    await page.keyboard.press('Escape');
    expect(await editing(page)).toBe(false);
    const html = (await app.node(id)).data.html;
    expect(html).toHaveLength(11);
    expect(html.indexOf('Ж')).toBe(at);
  });

  test('двойной клик и инструмент T по готовому тексту правят его, а не создают новый', async ({ app, page }) => {
    const id = await app.add('text', { x: 100, y: 100, w: 320, h: 60, data: { html: 'Привет мир', size: 20 } });
    const p = await textBox(app, id);
    await page.mouse.dblclick(p.x, p.y);
    await expect.poll(() => editing(page)).toBe(true);
    await page.keyboard.press('Escape');
    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    await page.keyboard.press('t');
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => editing(page)).toBe(true);
    expect(await app.nodes('text')).toHaveLength(1);
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Escape');
    expect((await app.node(id)).data.html).toBe('Привет мир!');
  });

  test('выделенный текст перетаскивается, а не открывается для правки', async ({ app, page }) => {
    const id = await app.add('text', { x: 100, y: 100, w: 320, h: 60, data: { html: 'Привет мир', size: 20 } });
    const p = await textBox(app, id);
    await page.mouse.click(p.x, p.y);
    await app.drag(p, { x: p.x + 80, y: p.y + 40 });
    expect(await editing(page)).toBe(false);
    const n = await app.node(id);
    expect(Math.abs(n.x - 180)).toBeLessThanOrEqual(8);
    expect(Math.abs(n.y - 140)).toBeLessThanOrEqual(8);
  });

  test('размер шрифта: число, стрелки, «−», готовые размеры; высота подстраивается; Ctrl+Z', async ({ app, page }) => {
    const id = await app.add('text', { x: 100, y: 100, w: 320, h: 60, data: { html: 'Привет мир', size: 20 } });
    await app.select([id]);
    const fs = page.locator('.sel-toolbar .st-fs-input');
    await expect(fs).toHaveValue('20');
    await fs.click();
    await page.keyboard.type('36');
    await page.keyboard.press('Enter');
    expect((await app.node(id)).data.size).toBe(36);
    const h36 = (await app.node(id)).h;
    await fs.click();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect((await app.node(id)).data.size).toBe(38);
    await expect(page.locator('.sel-toolbar .st-fs-input'), 'поле остаётся в фокусе для следующих нажатий').toBeFocused();
    await page.keyboard.press('Escape');
    await page.locator('.sel-toolbar .st-fs-btn', { hasText: '−' }).click();
    expect((await app.node(id)).data.size, '«−» — предыдущий типовой размер').toBe(36);
    await page.locator('.sel-toolbar .st-fs .st-fs-btn').last().click();
    await page.locator('.menu .menu-item', { hasText: /^14$/ }).click();
    expect((await app.node(id)).data.size).toBe(14);
    expect((await app.node(id)).h, 'высота подстраивается под размер текста').toBeLessThan(h36 * 0.6);
    await expect(page.locator('.sel-toolbar .st-fs-input')).toHaveValue('14');
    const away = await emptySpot(page);
    await page.mouse.click(away.x, away.y);
    await page.keyboard.press('Control+z');
    expect((await app.node(id)).data.size).toBe(36);
  });
});

test.describe('копии заметок — отдельные файлы', () => {
  test('отмена дубля убирает файл копии, повтор возвращает его вместе с правками; Alt-копия тоже', async ({ app, page }) => {
    await vault.create(page, '', 'Идея 1', 'исходный текст');
    const note = await app.add('note', { x: 0, y: 0, data: { path: 'Идея 1.md' } });
    const paths = async () => (await app.nodes('note')).map((n) => n.data.path).sort();
    for (let i = 2; i <= 3; i++) {
      await app.select([(await app.nodes('note')).at(-1).id]);
      await page.keyboard.press('Control+d');
      await expect.poll(paths).toEqual(Array.from({ length: i }, (_, k) => `Идея ${k + 1}.md`));
    }
    expect(await vault.paths(page, 'Идея')).toEqual(['Идея 1.md', 'Идея 2.md', 'Идея 3.md']);
    await vault.write(page, 'Идея 3.md', 'правка в копии');

    await app.clearSelection();
    await page.keyboard.press('Control+z');
    await expect.poll(() => vault.paths(page, 'Идея')).toEqual(['Идея 1.md', 'Идея 2.md']);
    await page.keyboard.press('Control+z');
    await expect.poll(() => vault.paths(page, 'Идея')).toEqual(['Идея 1.md']);
    expect(await paths()).toEqual(['Идея 1.md']);
    expect((await vault.read(page, 'Идея 1.md')).trim()).toBe('исходный текст');

    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => vault.paths(page, 'Идея')).toEqual(['Идея 1.md', 'Идея 2.md', 'Идея 3.md']);
    expect((await vault.read(page, 'Идея 3.md')).trim()).toBe('правка в копии');
    const third = (await app.nodes('note')).find((n) => n.data.path === 'Идея 3.md');
    await expect(app.el(third.id).locator('.rich-content')).toContainText('правка в копии');

    // Alt+drag of a note makes a copy with its own file; undo takes the file away again
    const head = await app.box(third.id, '.node-head');
    await app.drag({ x: head.x + 60, y: head.cy }, { x: head.x + 260, y: head.cy + 300 }, { modifiers: ['Alt'] });
    await expect.poll(() => vault.paths(page, 'Идея')).toEqual(['Идея 1.md', 'Идея 2.md', 'Идея 3.md', 'Идея 4.md']);
    expect((await vault.read(page, 'Идея 4.md')).trim()).toBe('правка в копии');
    await page.keyboard.press('Control+z');
    await expect.poll(() => vault.paths(page, 'Идея')).toEqual(['Идея 1.md', 'Идея 2.md', 'Идея 3.md']);
    expect(await app.node(note)).toBeTruthy();
  });
});

test.describe('панель «Слои» и заметки на холсте', () => {
  test.beforeEach(async ({ app, page }) => {
    for (const n of ['Альфа', 'Бета', 'Гамма', 'Дельта']) await vault.create(page, 'Work', n, `# ${n}`);
    await app.add('frame', { x: 0, y: 100, w: 600, h: 400, data: { title: 'Исследование' } });
    await app.add('sticky', { x: 40, y: 170, w: 200, h: 200, data: { text: 'Внутри области' } });
    await app.add('shape', { x: 300, y: 170, w: 120, h: 80, data: { kind: 'ellipse', text: '' } });
    await app.add('sticky', { x: 800, y: 150, w: 200, h: 200, data: { text: 'Снаружи' } });
    await page.evaluate(() => { window.__app.canvas.recomputeGroups('all'); window.__app.toggleSidebar(true); });
  });
  // notes lying on top of anything else (objects inside an area overlap it by design)
  const overlaps = (nodes) => {
    let k = 0;
    for (const a of nodes.filter((n) => n.type === 'note')) for (const b of nodes) if (a.id !== b.id && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) k++;
    return k;
  };

  test('заметки выбираются с Ctrl и Shift и выводятся на холст, не перекрывая объекты', async ({ app, page }) => {
    const file = (name) => page.locator('.sb-tree .sb-item.file', { hasText: name });
    await file('Альфа').click();
    await file('Гамма').click({ modifiers: ['Control'] });
    await expect(page.locator('.sb-item.file.picked')).toHaveText(['Альфа', 'Гамма']);
    await file('Дельта').click({ modifiers: ['Shift'] });
    await expect(page.locator('.sb-item.file.picked'), 'Shift — диапазон от последней выбранной').toHaveText(['Гамма', 'Дельта']);
    await file('Гамма').click({ button: 'right' });
    await expect(page.locator('.menu .menu-header')).toHaveText('Выбрано заметок: 2');
    await menuItem(page, 'Вывести на canvas').click();
    await expect.poll(async () => (await app.nodes('note')).map((n) => n.data.path).sort()).toEqual(['Work/Гамма.md', 'Work/Дельта.md']);
    const notes = await app.nodes('note');
    expect(overlaps(await app.nodes()), 'новые заметки не легли поверх объектов').toBe(0);
    expect((await app.selection()).sort()).toEqual(notes.map((n) => n.id).sort());
  });

  test('вкладка «Слои»: дерево областей, общее с холстом выделение, сворачивание, замок', async ({ app, page }) => {
    await page.locator('.sb-tab', { hasText: 'Слои' }).click();
    await expect(page.locator('.sb-pane.layers-pane')).toBeVisible();
    const row = (t) => page.locator('.ly-row', { hasText: t });
    await expect(page.locator('.ly-row')).toHaveCount(4);
    await expect(row('Исследование').locator('.ly-count')).toHaveText('2');
    const pad = async (t) => parseFloat(await row(t).evaluate((e) => e.style.paddingLeft));
    expect(await pad('Внутри области'), 'содержимое области — с отступом').toBeGreaterThan(await pad('Исследование'));
    expect(await pad('Снаружи')).toBe(await pad('Исследование'));
    await expect(page.locator('.sb-tree .sb-item.file').first(), 'список заметок спрятан').toBeHidden();

    await row('Снаружи').click();
    await row('Внутри области').click({ modifiers: ['Control'] });
    const texts = async () => (await Promise.all((await app.selection()).map((id) => app.node(id)))).map((n) => n.data.text).sort();
    expect(await texts()).toEqual(['Внутри области', 'Снаружи']);

    const frame = (await app.nodes('frame'))[0];
    await app.select([frame.id]);
    await expect(page.locator('.ly-row.active')).toHaveCount(1);
    await expect(page.locator('.ly-row.active .sb-label')).toHaveText('Исследование');

    await row('Исследование').locator('.ly-twisty').click();
    await expect(page.locator('.ly-row')).toHaveCount(2);
    await row('Исследование').locator('.ly-twisty').click();
    await expect(page.locator('.ly-row')).toHaveCount(4);

    const out = (await sticky(app, 'Снаружи'))[0];
    await page.evaluate((id) => window.__app.canvas.updateNode(id, { data: { text: 'Переименован' } }), out.id);
    await expect(row('Переименован')).toHaveCount(1);

    await row('Переименован').hover();
    await expect(app.el(out.id)).toHaveClass(/layer-hover/);
    await row('Переименован').locator('.ly-lock').click();
    expect((await app.node(out.id)).locked).toBe(true);
    await expect(row('Переименован').locator('.ly-lock')).toHaveClass(/\bon\b/);
  });

  test('несколько заметок, брошенных на занятое место, ложатся сеткой без наложений; перенос в папку обновляет окна', async ({ app, page }) => {
    for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) await vault.create(page, '', n, n);
    await page.evaluate(async () => { const { native } = await import('/js/state.js'); await native.vault.mkdir('Архив'); await (await import('/js/vaultIndex.js')).vaultIndex.refresh(); });
    await app.reset();
    const s = await app.add('sticky', { x: 300, y: 200, w: 220, h: 220, data: { text: 'мешает' } });
    const at = await app.box(s);
    await page.evaluate(({ x, y }) => {
      const dt = new DataTransfer();
      dt.setData('application/x-vibetabula-notes', JSON.stringify(['A1.md', 'A2.md', 'A3.md', 'A4.md', 'A5.md']));
      dt.setData('application/x-vibetabula-note', 'A1.md');
      document.querySelector('.canvas-root').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, { x: at.cx, y: at.cy });
    await expect.poll(async () => (await app.nodes('note')).length).toBe(5);
    expect(overlaps(await app.nodes())).toBe(0);
    const notes = await app.nodes('note');
    expect(new Set(notes.map((n) => n.x)).size, 'сетка в несколько колонок').toBeGreaterThan(1);

    const file = (name) => page.locator('.sb-tree .sb-item.file', { hasText: name });
    await file('A1').click({ modifiers: ['Control'] });
    await file('A2').click({ modifiers: ['Control'] });
    await file('A2').click({ button: 'right' });
    await menuItem(page, 'Переместить в папку').hover();
    await page.locator('.menu .sub .menu-item', { hasText: 'Архив' }).click();
    await expect.poll(async () => (await app.nodes('note')).map((n) => n.data.path).sort()).toEqual(['A3.md', 'A4.md', 'A5.md', 'Архив/A1.md', 'Архив/A2.md']);
  });
});

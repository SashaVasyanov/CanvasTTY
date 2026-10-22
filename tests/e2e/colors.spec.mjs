// Colours: the Apple system palette for stickies, shapes, areas and arrows (old saved colours map
// onto it), the Spectrum window (one undo step per picking session, Esc closes only the window),
// theme-dependent shades, project and agent colours, widgets.
import { test, expect } from './fixtures.mjs';
import { toPage, menuItem, waitRest } from './helpers/canvas.mjs';

test.beforeEach(async ({ app, page }) => { await waitRest(page); });

const swatchOn = (page) => page.locator('.sel-toolbar .pb-swatch.on:not(.pb-spectrum)');
const tokenOf = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(`--pen-${n}`).trim(), name);
const bgOf = (locator) => locator.evaluate((e) => getComputedStyle(e).backgroundColor);
const rgb = (hex) => { const v = hex.replace('#', ''); return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`; };

test.describe('цвета стикеров, фигур и областей', () => {
  let ids;
  test.beforeEach(async ({ app }) => {
    // colours as the previous version saved them, plus a custom one
    ids = {
      frame: await app.add('frame', { x: 60, y: 330, w: 620, h: 300, data: { title: 'Старая область', color: '#3fae7c' } }),
      sOld: await app.add('sticky', { x: 120, y: 100, w: 180, h: 160, data: { text: 'Старый жёлтый', color: '#ffe58a' } }),
      sPink: await app.add('sticky', { x: 330, y: 100, w: 180, h: 160, data: { text: 'Розовый', color: '#ffb8d1' } }),
      sNew: await app.add('sticky', { x: 540, y: 100, w: 180, h: 160, data: { text: 'Свой тёмный', color: '#1f3a5f' } }),
      shape: await app.add('shape', { x: 120, y: 420, w: 200, h: 140, data: { kind: 'rect', color: '#7c8cff', text: 'Старая фигура' } }),
    };
  });

  test('старые цвета попадают в новую палитру, свой цвет отмечен на спектре, оттенки зависят от темы', async ({ app, page }) => {
    const box = (id) => app.el(id).locator('.sticky');
    expect(await box(ids.sOld).evaluate((e) => e.style.background)).toBe('var(--pen-yellow)');
    expect(await bgOf(box(ids.sOld))).toBe(rgb(await tokenOf(page, 'yellow')));
    await expect(box(ids.sPink), 'на насыщенном розовом — белый текст').toHaveClass(/\bdark\b/);
    await expect(box(ids.sNew), 'на своём тёмном цвете — белый текст').toHaveClass(/\bdark\b/);
    await expect(box(ids.sOld)).not.toHaveClass(/\bdark\b/);
    expect(await bgOf(box(ids.sNew))).toBe('rgb(31, 58, 95)');

    for (const [id, name] of [[ids.sOld, 'Жёлтый'], [ids.sPink, 'Розовый'], [ids.shape, 'Синий'], [ids.frame, 'Зелёный']]) {
      await app.select([id]);
      await expect(swatchOn(page)).toHaveAttribute('title', name);
      await expect(page.locator('.sel-toolbar .pb-spectrum.on')).toHaveCount(0);
    }
    await app.select([ids.sNew]);
    await expect(swatchOn(page)).toHaveCount(0);
    await expect(page.locator('.sel-toolbar .pb-spectrum.on')).toHaveCount(1);

    const dark = await bgOf(box(ids.sOld));
    await app.theme('light');
    await expect.poll(() => bgOf(box(ids.sOld)), 'светлая тема — свой оттенок жёлтого').not.toBe(dark);
    expect(await bgOf(box(ids.sOld))).toBe(rgb(await tokenOf(page, 'yellow')));
  });

  test('цвет из панели над выделением: у одного стикера и у нескольких сразу; Ctrl+Z', async ({ app, page }) => {
    await app.select([ids.sOld]);
    await page.locator('.sel-toolbar .pb-swatch[title="Розовый"]').click();
    expect((await app.node(ids.sOld)).data.color).toBe('pink');
    await expect(swatchOn(page)).toHaveAttribute('title', 'Розовый');
    await page.keyboard.press('Control+z');
    expect((await app.node(ids.sOld)).data.color).toBe('#ffe58a');

    await app.select([ids.sOld, ids.sPink]);
    await expect(page.locator('.sel-toolbar .pb-swatch:not(.pb-spectrum)'), 'один ряд цветов на оба стикера').toHaveCount(8);
    await expect(swatchOn(page), 'цвета разные — ни один не отмечен').toHaveCount(0);
    await page.locator('.sel-toolbar .pb-swatch[title="Красный"]').click();
    expect([(await app.node(ids.sOld)).data.color, (await app.node(ids.sPink)).data.color]).toEqual(['red', 'red']);
    await page.keyboard.press('Control+z');
    expect([(await app.node(ids.sOld)).data.color, (await app.node(ids.sPink)).data.color]).toEqual(['#ffe58a', '#ffb8d1']);
  });

  test('спектр стикера: системные цвета в окне, выбор протягиванием — одна отмена', async ({ app, page }) => {
    await app.select([ids.sNew]);
    await page.locator('.sel-toolbar .pb-spectrum').click();
    await expect(page.locator('.pb-picker')).toBeVisible();
    const names = await page.locator('.pk-grid .pb-swatch').evaluateAll((l) => l.map((b) => b.title));
    expect(names).toEqual(expect.arrayContaining(['Синий', 'Зелёный', 'Жёлтый', 'Оранжевый', 'Красный', 'Розовый', 'Фиолетовый', 'Серый']));
    const a = await page.locator('.pk-spectrum').boundingBox();
    await page.mouse.move(a.x + a.width * 0.2, a.y + a.height * 0.4); await page.mouse.down();
    await page.mouse.move(a.x + a.width * 0.5, a.y + a.height * 0.45, { steps: 4 });
    await page.mouse.move(a.x + a.width * 0.8, a.y + a.height * 0.5, { steps: 4 });
    await page.mouse.up();
    const picked = (await app.node(ids.sNew)).data.color;
    expect(picked).toMatch(/^#[0-9a-f]{6}$/);
    expect(picked).not.toBe('#1f3a5f');
    expect(await bgOf(app.el(ids.sNew).locator('.sticky'))).toBe(rgb(picked));
    await page.keyboard.press('Escape');
    await expect(page.locator('.pb-picker')).toHaveCount(0);
    expect(await app.selection(), 'Esc закрыл только окно цветов').toEqual([ids.sNew]);
    await page.keyboard.press('Control+z');
    expect((await app.node(ids.sNew)).data.color).toBe('#1f3a5f');
  });
});

test('цвет связи: из меню и «Другой цвет…»; весь выбор в спектре — одна отмена', async ({ app, page }) => {
  const a = await app.add('shape', { x: 100, y: 200, w: 160, h: 100, data: { kind: 'rect' } });
  const b = await app.add('shape', { x: 500, y: 200, w: 160, h: 100, data: { kind: 'rect', color: 'pink' } });
  const edge = await page.evaluate(([a, b]) => { const c = window.__app.canvas; const e = c.addEdge(a, b); c.undoStack.length = 0; return e.id; }, [a, b]);
  const mid = await page.evaluate((id) => { const p = document.querySelector(`.edge[data-id="${id}"] .edge-hit`); const l = p.getTotalLength(); const q = p.getPointAtLength(l / 2); return [q.x, q.y]; }, edge);
  const at = await toPage(page, ...mid);
  const color = () => app.edges().then((l) => l[0].color ?? null);
  const colorMenu = async () => {
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await menuItem(page, 'Цвет').hover();
    await expect(page.locator('.menu .sub')).toBeVisible();
  };

  await colorMenu();
  await page.locator('.menu .sub .menu-item', { hasText: 'Оранжевый' }).click();
  expect(await color()).toBe('orange');
  expect(await page.locator(`.edge[data-id="${edge}"] .edge-line`).getAttribute('style')).toContain('var(--pen-orange)');

  await colorMenu();
  await page.locator('.menu .sub .menu-item', { hasText: 'Другой цвет…' }).click();
  await expect(page.locator('.pb-picker')).toBeVisible();
  const r = await page.locator('.pk-spectrum').boundingBox();
  await page.mouse.move(r.x + r.width * 0.82, r.y + r.height * 0.45); await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.86, r.y + r.height * 0.5);
  await page.mouse.move(r.x + r.width * 0.88, r.y + r.height * 0.47);
  await page.mouse.up();
  expect(await color()).toMatch(/^#[0-9a-f]{6}$/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pb-picker')).toHaveCount(0);
  await expect(page.locator('.pick-anchor'), 'временный якорь окна убран').toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect(await color(), 'одна отмена за весь выбор в спектре').toBe('orange');
  await page.keyboard.press('Control+z');
  expect(await color()).toBe(null);
});

test('новый проект: спектр открывается поверх окна, Esc закрывает сначала спектр, потом окно', async ({ page }) => {
  await page.locator('.proj-btn').click();
  await menuItem(page, 'Новый проект…').click();
  const modal = page.locator('.modal', { hasText: 'Новый проект' });
  await expect(modal).toBeVisible();
  await expect(modal.locator('.swatches.apple .pb-swatch:not(.pb-spectrum)')).toHaveCount(8);
  await modal.locator('.swatches.apple .pb-spectrum').click();
  const picker = page.locator('.pb-picker');
  await expect(picker).toBeVisible();
  const c = await picker.boundingBox();
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.pb-picker'), { x: c.x + c.width / 2, y: c.y + c.height / 2 }), 'окно цветов не спрятано под диалогом').toBe(true);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('цвет значка агента в настройках: окно цветов поверх настроек, значок перекрашивается', async ({ page }) => {
  await page.evaluate(() => window.__app.openSettings('agents'));
  const settings = page.locator('.modal');
  await expect(settings).toBeVisible();
  await page.locator('.agent-color').first().click();
  await expect(page.locator('.pb-picker')).toBeVisible();
  await page.locator('.pk-grid .pb-swatch[title="Красный"]').click();
  const red = await tokenOf(page, 'red');
  await expect.poll(() => page.locator('.agent-row .badge').first().evaluate((e) => e.style.getPropertyValue('--b'))).toBe(red);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pb-picker')).toHaveCount(0);
  await expect(settings, 'настройки остались открытыми').toBeVisible();
  expect(await page.evaluate(async () => (await import('/js/state.js')).state.settings.agents[0].color)).toBe(red);
  await expect(page.locator('.agent-row .badge').first()).toHaveCSS('--b', red);
});

test('виджеты таймер, секундомер и чек-лист на холсте; таймер запускается', async ({ app, page }) => {
  await page.evaluate(() => { const a = window.__app; a.addWidget('timer', { x: 100, y: 100 }); a.addWidget('stopwatch', { x: 450, y: 100 }); a.addWidget('checklist', { x: 800, y: 100 }); a.canvas.selection.clear(); a.canvas.afterSelect(); });
  await expect(page.locator('.widget')).toHaveCount(3);
  for (const k of ['timer', 'stopwatch', 'checklist']) await expect(page.locator(`.widget.wk-${k} .wg-body`)).not.toBeEmpty();
  const timer = page.locator('.widget.wk-timer');
  const time = timer.locator('.wg-time');
  const start = await time.textContent();
  await timer.locator('.wg-btn.primary').click();
  await expect(timer).toHaveClass(/\brunning\b/);
  await expect(time).not.toHaveText(start, { timeout: 5000 });
  expect((await app.nodes('widget')).find((n) => n.data.kind === 'timer').data.endAt).toBeGreaterThan(0);
});

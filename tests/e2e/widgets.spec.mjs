// Widgets on the canvas (picker, timer, checklist, calendar with day notes) and the StandBy
// clock of the agents hub with its colour presets.
import { test, expect } from './fixtures.mjs';
import { calendarKey, calendarNotes, canvasIdle } from './helpers/notes.mjs';

const widgetId = (app, kind) => app.page.evaluate((kind) => window.__app.canvas.doc.nodes.find((n) => n.type === 'widget' && n.data.kind === kind)?.id, kind);

test.describe('виджеты', () => {
  test('W открывает выбор виджетов, карточка добавляет виджет на canvas', async ({ app, page }) => {
    await page.mouse.click(700, 500);
    await page.keyboard.press('w');
    const cards = page.locator('.wg-picker .wg-card-name');
    await expect(cards).toHaveText(['Часы', 'Таймер', 'Чек-лист', 'Календарь', 'До события', 'Агенты', 'Лимиты', 'Секундомер', 'Счётчик']);
    await page.locator('.wg-picker .wg-card', { hasText: 'Таймер' }).click();
    await expect(page.locator('.wg-picker')).toHaveCount(0);
    const widgets = await app.nodes('widget');
    expect(widgets.map((n) => n.data.kind)).toEqual(['timer']);
    expect(await app.selection(), 'новый виджет выделен').toEqual([widgets[0].id]);
    await expect(app.el(widgets[0].id).locator('.wg-time')).toHaveText('25:00');
  });

  test('таймер: старт идёт, пауза запоминает остаток, пресет меняет длительность', async ({ app, page }) => {
    await page.evaluate(() => window.__app.addWidget('timer', { x: 200, y: 200 }));
    const id = await widgetId(app, 'timer');
    const w = app.el(id);
    await canvasIdle(page);
    await expect(w.locator('.wg-time')).toHaveText('25:00');
    await w.locator('.wg-btn.primary').click();
    expect((await app.node(id)).data.endAt, 'запущен: есть время окончания').toBeGreaterThan(Date.now());
    await expect(w.locator('.widget')).toHaveClass(/\brunning\b/);
    await expect(w.locator('.wg-time')).not.toHaveText('25:00');
    expect(await w.locator('.wg-time').textContent(), 'идёт обратный отсчёт').toMatch(/^24:[0-5]\d$/);

    await w.locator('.wg-btn.primary').click();
    const paused = (await app.node(id)).data;
    expect(paused.endAt).toBe(0);
    expect(paused.left).toBeLessThan(25 * 60000);
    expect(paused.left).toBeGreaterThan(24 * 60000);
    await expect(w.locator('.widget')).not.toHaveClass(/\brunning\b/);

    await w.locator('.wg-chip', { hasText: /^5$/ }).click();
    await expect(w.locator('.wg-time')).toHaveText('05:00');
    expect((await app.node(id)).data).toMatchObject({ duration: 5 * 60000, left: 5 * 60000, endAt: 0 });
  });

  test('чек-лист: Enter добавляет задачи, клик отмечает, отмена и дублирование', async ({ app, page }) => {
    await page.evaluate(() => window.__app.addWidget('checklist', { x: 200, y: 200 }));
    const id = await widgetId(app, 'checklist');
    const w = app.el(id);
    const items = async () => (await app.node(id)).data.items.map((i) => `${i.text}:${i.done}`);
    await canvasIdle(page);
    await w.locator('.wg-add').click();
    await page.keyboard.type('Сделать ревью');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Залить релиз');
    await page.keyboard.press('Enter');
    expect(await items()).toEqual(['Сделать ревью:false', 'Залить релиз:false']);
    await expect(w.locator('.wg-add'), 'поле очищается для следующей задачи').toHaveValue('');
    expect(await page.evaluate(() => window.__app.canvas.tool), 'буквы в поле не переключают инструменты').toBe('select');

    await w.locator('.wg-check').first().click();
    expect(await items()).toEqual(['Сделать ревью:true', 'Залить релиз:false']);
    await expect(w.locator('.wg-count')).toHaveText('1/2');
    await expect(w.locator('.wg-item-text').first()).toHaveClass(/\bdone\b/);
    expect(await w.locator('.wg-progress i').evaluate((el) => el.style.width)).toBe('50%');

    await page.keyboard.press('Escape');
    await page.mouse.click(1300, 820);
    await page.keyboard.press('Control+z');
    expect(await items(), 'отмена снимает отметку').toEqual(['Сделать ревью:false', 'Залить релиз:false']);
    await expect(w.locator('.wg-count')).toHaveText('0/2');

    await page.evaluate((id) => { const c = window.__app.canvas; c.select([id]); c.duplicate(); }, id);
    const lists = await app.nodes('widget');
    expect(lists).toHaveLength(2);
    expect(lists[1].data.items.map((i) => i.text), 'копия со своими задачами').toEqual(['Сделать ревью', 'Залить релиз']);
    await page.evaluate((id) => window.__app.canvas.updateNode(id, { data: { items: [] } }), lists[1].id);
    expect(await items(), 'правка копии не трогает оригинал').toHaveLength(2);
  });
});

test.describe('календарь', () => {
  const day = (page, d) => page.locator('.wk-calendar button.wg-day').nth(d - 1);
  const swatch = (page, title) => page.locator(`.wg-daypop .wg-daycolors .pb-swatch[title="${title}"]`);

  test.beforeEach(async ({ app, page }) => {
    await page.evaluate(() => window.__app.addWidget('calendar', { x: 150, y: 120 }));
    await app.clearSelection();
    await canvasIdle(page);
  });

  test('заметка и цвет дня: попап, Готово, Ctrl+Enter, клик мимо, Esc закрывает сначала спектр', async ({ app, page }) => {
    test.slow();
    const id = await widgetId(app, 'calendar');
    const k = (d) => calendarKey(page, d);
    const pop = page.locator('.wg-daypop');

    await day(page, 21).click();
    await expect(pop).toBeVisible();
    await expect(pop.locator('.wg-daytext')).toBeFocused();
    await page.keyboard.type('Созвон с командой в 15:00');
    await swatch(page, 'Зелёный').click();
    expect((await calendarNotes(page, id))[await k(21)], 'цвет применяется сразу').toEqual({ text: 'Созвон с командой в 15:00', color: 'green' });
    await page.keyboard.type(' wp');
    expect(await page.evaluate(() => window.__app.canvas.tool), 'W и P в заметке не переключают инструменты').toBe('select');
    await pop.locator('.wg-dayfoot .btn.primary').click();
    await expect(pop).toHaveCount(0);
    expect((await calendarNotes(page, id))[await k(21)]).toEqual({ text: 'Созвон с командой в 15:00 wp', color: 'green' });

    // a colour from the Spectrum window: it stacks on the day popover; Esc closes the top one first
    await day(page, 24).click();
    await pop.locator('.wg-daycolors .pb-spectrum').click();
    await expect(page.locator('.pb-pop')).toHaveCount(2);
    const area = await page.locator('.pb-picker .pk-spectrum').boundingBox();
    await page.mouse.click(area.x + area.width * 0.83, area.y + area.height * 0.4);
    await expect(pop, 'попап дня не закрывается при выборе цвета').toBeVisible();
    expect((await calendarNotes(page, id))[await k(24)].color).toMatch(/^#[0-9a-f]{6}$/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pb-picker')).toHaveCount(0);
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pb-pop')).toHaveCount(0);

    // colour only + Esc; text + colour + Ctrl+Enter; text only + click outside
    await day(page, 3).click();
    await swatch(page, 'Оранжевый').click();
    await page.keyboard.press('Escape');
    await day(page, 10).click();
    await expect(pop.locator('.wg-daytext')).toBeFocused();
    await page.keyboard.type('Релиз 1.5');
    await swatch(page, 'Фиолетовый').click();
    await page.keyboard.press('Control+Enter');
    await expect(pop).toHaveCount(0);
    await day(page, 15).click();
    await expect(pop.locator('.wg-daytext')).toBeFocused();
    await page.keyboard.type('Без цвета, просто заметка');
    await page.mouse.click(1300, 820);
    await expect(pop).toHaveCount(0);

    const notes = await calendarNotes(page, id);
    expect(notes[await k(3)]).toEqual({ text: '', color: 'orange' });
    expect(notes[await k(10)]).toEqual({ text: 'Релиз 1.5', color: 'purple' });
    expect(notes[await k(15)]).toEqual({ text: 'Без цвета, просто заметка', color: null });
    expect(Object.keys(notes)).toHaveLength(5);

    // marked days, dots and the text (shown in the cell only in a big calendar)
    await expect(day(page, 10)).toHaveClass(/\bmarked\b/);
    await expect(day(page, 10)).toHaveClass(/\bhas-note\b/);
    await expect(day(page, 15)).not.toHaveClass(/\bmarked\b/);
    await expect(day(page, 10)).toHaveAttribute('title', /Релиз 1\.5/);
    await expect(day(page, 10).locator('.wg-dot')).toBeVisible();
    await expect(day(page, 10).locator('.wg-dtext')).toBeHidden();
    await page.evaluate((id) => { const c = window.__app.canvas; const n = c.node(id); n.w = 620; n.h = 560; c.syncView(n); }, id);
    await expect(day(page, 10).locator('.wg-dtext')).toBeVisible();
    await expect(day(page, 10).locator('.wg-dtext')).toHaveText('Релиз 1.5');
  });

  test('Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y для заметки дня; перетаскивание за день не открывает попап', async ({ app, page }) => {
    const id = await widgetId(app, 'calendar');
    const key = await calendarKey(page, 15);
    await day(page, 15).click();
    await expect(page.locator('.wg-daypop .wg-daytext')).toBeFocused();
    await page.keyboard.type('тест');
    await page.mouse.click(1300, 820);
    expect(await calendarNotes(page, id)).toEqual({ [key]: { text: 'тест', color: null } });

    await page.keyboard.press('Control+z');
    expect(await calendarNotes(page, id)).toEqual({});
    await expect(day(page, 15)).not.toHaveClass(/\bhas-note\b/);
    await page.keyboard.press('Control+Shift+z');
    expect(await calendarNotes(page, id)).toEqual({ [key]: { text: 'тест', color: null } });
    await expect(day(page, 15)).toHaveClass(/\bhas-note\b/);
    await page.keyboard.press('Control+y');
    expect(await calendarNotes(page, id), 'повторять больше нечего').toEqual({ [key]: { text: 'тест', color: null } });

    const x0 = (await app.node(id)).x;
    const b = await day(page, 17).boundingBox();
    await app.drag({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + 80, y: b.y + 50 }, { steps: 8 });
    expect((await app.node(id)).x, 'виджет передвинулся').toBeGreaterThan(x0 + 40);
    await expect(page.locator('.wg-daypop'), 'попап дня не открылся').toHaveCount(0);
    expect(await calendarNotes(page, id)).toEqual({ [key]: { text: 'тест', color: null } });
    await page.keyboard.press('Control+z');
    expect((await app.node(id)).x).toBe(x0);
    expect(await calendarNotes(page, id), 'отмена перемещения не трогает заметки').toEqual({ [key]: { text: 'тест', color: null } });
  });
});

test.describe('часы в пульте', () => {
  const clockVars = (page, sel = '.hub-clock') => page.locator(sel).first().evaluate((el) => ({ bg: el.style.getPropertyValue('--sb-bg'), d1: el.style.getPropertyValue('--sb-d1'), blend: el.style.getPropertyValue('--sb-blend') }));

  test.beforeEach(async ({ app }) => {
    await app.add('hub', { x: 0, y: 0 });
  });

  test('показывают текущее время и дату, цвета StandBy в тёмной теме и «Бумага» в светлой', async ({ app, page }) => {
    const clock = page.locator('.hub-clock');
    const hhmm = () => page.evaluate(() => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; });
    const before = await hhmm();
    const shown = await clock.locator('.sb-time').getAttribute('aria-label');
    expect([before, await hhmm()]).toContain(shown);
    expect(await clock.locator('.sb-d').allTextContents()).toEqual(shown.replace(':', '').split(''));
    const today = await page.evaluate(() => new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
    await expect(clock.locator('.sb-date')).toHaveText(today);

    expect(await clockVars(page)).toEqual({ bg: '#000000', d1: '#1f6dff', blend: 'screen' });
    await page.evaluate(() => window.__app.toggleTheme());
    await expect.poll(() => clockVars(page)).toEqual({ bg: '#ffffff', d1: '#1f6dff', blend: 'multiply' });
  });

  test('цвета выбираются в настройках для каждой темы и через ПКМ по часам', async ({ app, page }) => {
    await page.evaluate(() => window.__app.openSettings('general', 'clock'));
    const cols = page.locator('.clock-col');
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0).locator('select')).toHaveValue('standby');
    await expect(cols.nth(1).locator('select')).toHaveValue('paper');
    await expect(page.locator('[data-anchor="clock"]')).toBeInViewport();

    await cols.nth(0).locator('select').selectOption('sunset');
    await cols.nth(1).locator('select').selectOption('custom');
    const settings = () => page.evaluate(async () => { const { state } = await import('/js/state.js'); const s = state.settings; return { dark: s.clockDark, light: s.clockLight, custom: s.clockCustomLight }; });
    const s1 = await settings();
    expect(s1.dark).toBe('sunset');
    expect(s1.light).toBe('custom');
    expect(s1.custom, 'свои цвета начинаются с текущего набора').toMatchObject({ bg: '#ffffff', d: ['#1f6dff', '#7db8ff', '#3b84ff', '#a6ceff'] });
    await expect(cols.nth(0).locator('.clock-picks'), 'свои цвета только у «Свои цвета»').toBeHidden();
    await expect(cols.nth(1).locator('.clock-picks .clock-pick')).toHaveText(['Фон', 'Цифра 1', 'Цифра 2', 'Цифра 3', 'Цифра 4', 'Точки', 'Дата']);
    expect(await clockVars(page, '.clock-col .sb-preview')).toMatchObject({ bg: '#000000', d1: '#ff4f2e' });
    await cols.nth(1).locator('.clock-pick input').first().evaluate((el) => { el.value = '#eaf3ff'; el.dispatchEvent(new Event('input')); });
    expect((await settings()).custom.bg).toBe('#eaf3ff');
    expect((await clockVars(page, '.clock-col:nth-child(2) .sb-preview')).bg).toBe('#eaf3ff');

    // the hub clock follows at once (dark theme now)
    expect(await clockVars(page)).toMatchObject({ bg: '#000000', d1: '#ff4f2e' });

    await page.locator('.set-nav [data-id="sync"]').click();
    await expect(page.locator('.set-pane')).toContainText('выключена');
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-modal')).toHaveCount(0);

    // light theme: the custom colours, the context menu of the clock offers the light presets
    await page.evaluate(() => window.__app.toggleTheme());
    await expect.poll(() => clockVars(page)).toMatchObject({ bg: '#eaf3ff' });
    const c = await app.box(await page.evaluate(() => window.__app.canvas.doc.nodes.find((n) => n.type === 'hub').id), '.hub-clock');
    await page.mouse.click(c.x + 40, c.y + 40, { button: 'right' });
    const menu = page.locator('.menu');
    await expect(menu.locator('.menu-label').first()).toHaveText('Цвета часов для светлой темы');
    await expect(menu.locator('.menu-item.checked .menu-label')).toHaveText('Свои цвета…');
    await menu.locator('.menu-item', { hasText: 'Мята' }).click();
    expect((await settings()).light).toBe('mint');
    await expect.poll(() => clockVars(page)).toMatchObject({ bg: '#03110c', d1: '#10b981' });
  });
});

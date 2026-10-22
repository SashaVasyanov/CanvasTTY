// Zoom: objects follow the cursor in world units at any zoom, the wheel zooms around the cursor,
// windows turn into cards when zoomed out (AI chats only further out), multi-selection frame.
import { test, expect } from './fixtures.mjs';
import { toPage, emptySpot, view, waitRest, setSetting } from './helpers/canvas.mjs';

test.beforeEach(async ({ app, page }) => { await waitRest(page); });

test.describe('масштаб 70 %', () => {
  let a, b;
  test.beforeEach(async ({ app, page }) => {
    a = await app.add('sticky', { x: 0, y: 0, w: 200, h: 200, data: { text: 'A' } });
    b = await app.add('sticky', { x: 400, y: 0, w: 200, h: 200, data: { text: 'B' } });
    await view(page, { x: 400, y: 300, z: 0.7 });
  });

  test('объект на своём месте, идёт за курсором и встаёт туда, где его отпустили', async ({ app, page }) => {
    const r0 = await app.box(a), e0 = await toPage(page, 0, 0);
    expect(Math.abs(r0.x - e0.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r0.y - e0.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(r0.width - 140)).toBeLessThanOrEqual(1);
    // 140 × 70 screen pixels at 70 % = 200 × 100 in the world
    await page.mouse.move(r0.x + 50, r0.y + 50); await page.mouse.down();
    await page.mouse.move(r0.x + 120, r0.y + 85, { steps: 5 });
    await page.mouse.move(r0.x + 190, r0.y + 120, { steps: 5 });
    await expect.poll(async () => Math.round((await app.box(a)).x - r0.x), 'во время перетаскивания объект под курсором').toBe(140);
    await page.mouse.up();
    expect(await app.node(a)).toMatchObject({ x: 200, y: 100, w: 200, h: 200 });
    await waitRest(page);
    const r1 = await app.box(a), e1 = await toPage(page, 200, 100);
    expect(Math.abs(r1.x - e1.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r1.y - e1.y)).toBeLessThanOrEqual(1);
  });

  // drag the bottom-right resize handle of A by 70 × 35 screen pixels (= 100 × 50 in the world)
  const resizeA = async (app, page) => {
    await app.select([a]);
    const h = await page.locator('.sel-box .h-se').boundingBox();
    const hx = h.x + h.width / 2, hy = h.y + h.height / 2;
    await app.drag({ x: hx, y: hy }, { x: hx + 70, y: hy + 35 });
  };

  test('ручка размера меняет размер в мировых единицах', async ({ app, page }) => {
    await resizeA(app, page);
    const n = await app.node(a);
    expect(Math.abs(n.w - 300), 'ширина +100 в мире').toBeLessThanOrEqual(8);
    expect(Math.abs(n.h - 250), 'высота +50 в мире').toBeLessThanOrEqual(8);
  });

  // Regression (fixed): the resize handle's pointerdown does not prevent the default action, so dragging it
  // also makes a native text selection across the objects (here "\nA\nB\n", highlighted on screen).
  // On Windows / Edge (CI) the next drag that starts over that selection becomes a native drag and
  // drop: the canvas drop handler turns the dragged text into a new sticky, so a selection-frame drag
  // selected one new sticky instead of A and B. (renderer/js/canvas.js onPointerDown → startResize;
  // the background → startMarquee path does not prevent it either.)
  test('после ручки размера не остаётся выделенного текста, и следующая рамка выделяет объекты', async ({ app, page }) => {
    await resizeA(app, page);
    expect(await page.evaluate(() => getSelection().toString().trim()), 'на странице не выделен текст').toBe('');
    await app.clearSelection();
    await app.drag(await toPage(page, -50, -50), await toPage(page, 650, 300));
    expect((await app.selection()).sort()).toEqual([a, b].sort());
    expect(await app.nodes('sticky'), 'новых стикеров нет').toHaveLength(2);
  });

  test('рамка выделения и двойной клик для правки', async ({ app, page }) => {
    await app.drag(await toPage(page, -50, -50), await toPage(page, 650, 300));
    expect((await app.selection()).sort()).toEqual([a, b].sort());
    expect(await app.nodes('sticky')).toHaveLength(2);

    await app.clearSelection();
    const bb = await app.box(b);
    await page.mouse.dblclick(bb.cx, bb.cy);
    await expect(app.el(b).locator('.txt[contenteditable="true"]')).toBeFocused();
    await page.keyboard.type('X');
    await page.keyboard.press('Escape');
    expect([...(await app.node(b)).data.text].sort()).toEqual(['B', 'X']);
  });
});

test('колесо мыши масштабирует вокруг курсора', async ({ page }) => {
  const p = await emptySpot(page);
  const worldAt = () => page.evaluate(({ x, y }) => window.__app.canvas.toWorld(x, y), p);
  const w0 = await worldAt();
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, 300);
  await waitRest(page);
  const z = await page.evaluate(() => window.__app.canvas.vp.z);
  expect(z).toBeLessThan(0.9);
  expect(z).toBeGreaterThan(0.3);
  const w1 = await worldAt();
  expect(Math.abs(w1.x - w0.x), 'точка под курсором остаётся на месте').toBeLessThanOrEqual(2);
  expect(Math.abs(w1.y - w0.y)).toBeLessThanOrEqual(2);
  await expect(page.locator('.zoom-label')).toHaveText(`${Math.round(z * 100)}%`);
});

test('несколько выделенных: общая рамка с подписью «Выбрано: N», каждый обведён', async ({ app, page }) => {
  await view(page, { x: 200, y: 150, z: 0.6 });
  const ids = [
    await app.add('frame', { x: 0, y: 0, w: 600, h: 400, data: { title: 'Референсы' } }),
    await app.add('sticky', { x: 60, y: 80, w: 160, h: 140, data: { text: 'A' } }),
    await app.add('sticky', { x: 300, y: 80, w: 160, h: 140, data: { text: 'B', color: 'blue' } }),
    await app.add('sticky', { x: 100, y: 600, w: 160, h: 140, data: { text: 'C', color: 'green' } }),
    await app.add('agentchat', { x: 700, y: 50, w: 500, h: 600, data: { agentId: 'codex', kind: 'codex', messages: [] } }),
  ];
  await app.select(ids);
  const box = page.locator('.sel-box');
  await expect(box).toHaveClass(/\bmulti\b/);
  await expect(box).toHaveAttribute('data-count', 'Выбрано: 5');
  await expect(page.locator('.canvas-root')).toHaveClass(/multi-sel/);
  await expect(page.locator('.node.selected')).toHaveCount(5);
  await app.select([ids[1]]);
  await expect(box).not.toHaveClass(/\bmulti\b/);
  await expect(page.locator('.canvas-root')).not.toHaveClass(/multi-sel/);
  await app.clearSelection();
  await expect(box).toBeHidden();
});

test.describe('карточки при отдалении', () => {
  let ids;
  test.beforeEach(async ({ app }) => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Сообщение ${i}\n\n` + 'текст '.repeat(40) }));
    ids = {
      agent: await app.add('agentchat', { x: 0, y: 0, w: 600, h: 700, data: { agentId: 'codex', kind: 'codex', messages: msgs } }),
      chat: await app.add('chat', { x: 700, y: 0, w: 500, h: 600, data: { messages: [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'ответ' }] } }),
      term: await app.add('terminal', { x: 1300, y: 0, w: 600, h: 400 }),
    };
  });
  const look = (page) => page.evaluate((ids) => {
    const shown = (id) => (getComputedStyle(document.querySelector(`.node[data-id="${id}"] .node-body`)).visibility === 'visible' ? 'окно' : 'карточка');
    const r = document.querySelector('.canvas-root').classList;
    return { lod: r.contains('lod'), far: r.contains('lod-far'), agent: shown(ids.agent), chat: shown(ids.chat), term: shown(ids.term) };
  }, ids);

  test('терминалы и заметки — карточки ниже 30 %, чаты нейросетей — только ниже 20 %', async ({ page }) => {
    const all = (v) => ({ agent: v, chat: v, term: v });
    const expected = [
      [0.5, { lod: false, far: false, ...all('окно') }],
      [0.35, { lod: false, far: false, ...all('окно') }],
      [0.29, { lod: true, far: false, agent: 'окно', chat: 'окно', term: 'карточка' }],
      [0.25, { lod: true, far: false, agent: 'окно', chat: 'окно', term: 'карточка' }],
      [0.2, { lod: true, far: false, agent: 'окно', chat: 'окно', term: 'карточка' }],
      [0.19, { lod: true, far: true, ...all('карточка') }],
      [0.15, { lod: true, far: true, ...all('карточка') }],
    ];
    for (const [z, want] of expected) {
      await view(page, { x: 200, y: 150, z });
      expect(await look(page), `масштаб ${z * 100} %`).toEqual(want);
    }
    await expect(page.locator(`.node[data-id="${ids.term}"] .node-card .card-title`)).toBeVisible();
  });

  test('на 25 % в чате можно печатать и прокручивать переписку колесом', async ({ page }) => {
    await view(page, { x: 200, y: 150, z: 0.25 });
    const input = page.locator(`.node[data-id="${ids.agent}"] .chat-input`);
    await input.click();
    await page.keyboard.type('тест');
    await expect(input).toHaveValue('тест');
    const list = page.locator(`.node[data-id="${ids.agent}"] .chat-list`);
    const lb = await list.boundingBox();
    const before = await list.evaluate((e) => e.scrollTop);
    expect(before, 'переписка открыта на последних сообщениях').toBeGreaterThan(0);
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => list.evaluate((e) => e.scrollTop)).toBeLessThan(before);
    expect(await page.evaluate(() => window.__app.canvas.vp.z), 'колесо над чатом не меняет масштаб').toBe(0.25);
  });

  test('старый сохранённый порог 60 % не прячет чаты нейросетей', async ({ page }) => {
    await setSetting(page, 'lodZoom', 0.6);
    await view(page, { x: 200, y: 150, z: 0.55 });
    await page.evaluate(() => window.__app.canvas.resetLod());
    await waitRest(page);
    expect(await look(page)).toEqual({ lod: true, far: false, agent: 'окно', chat: 'окно', term: 'карточка' });
  });
});

test('настройки: пороги карточек — 30 % и 20 %', async ({ page }) => {
  await page.evaluate(() => window.__app.openSettings('general'));
  const value = (label) => page.locator('.set-row', { has: page.locator('.set-label', { hasText: label }) }).locator('.range-val');
  await expect(value('Карточки при отдалении')).toHaveText('30 %');
  await expect(value('Чаты нейросетей при отдалении')).toHaveText('20 %');
});

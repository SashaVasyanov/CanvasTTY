// Text of the AI chat windows: its size (Настройки → Общие, per window: menu and Ctrl + / − / 0 in
// the input) and «readable when zoomed out» — at rest the text grows so that on screen it is not
// smaller than 12 px (at most 3× its size). renderer/js/nodes.js applyChatText, styles.css .chat
import { test, expect } from './fixtures.mjs';
import { addAgentChat, addApiChat, chat } from './helpers/chat.mjs';
import { menuItem } from './helpers/canvas.mjs';

const fontOf = (page, id, sel = '.chat-list') => page.evaluate(([id, sel]) => parseFloat(getComputedStyle(document.querySelector(`.node[data-id="${id}"] ${sel}`)).fontSize), [id, sel]);
const zoomTo = async (app, page, z) => {
  await page.evaluate((z) => { const c = window.__app.canvas; c.vp.z = z; c.vp.x = 80; c.vp.y = 120; c.applyViewport(); }, z);
  await app.idle();
};
const setSetting = (page, k, v) => page.evaluate(async ([k, v]) => (await import('/js/state.js')).state.setSetting(k, v), [k, v]);
const MSGS = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Сообщение номер ${i + 1}: немного текста, чтобы переписка была длинной.` }));

test('по умолчанию 14 px в переписке и поле ввода, и у агентов, и у API-чатов; настройка меняет размер всем окнам', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 460, h: 500 });
  const b = await addApiChat(app, { x: 520, w: 460, h: 500 });
  for (const id of [a, b]) {
    expect(await fontOf(page, id)).toBe(14);
    expect(await fontOf(page, id, '.chat-input')).toBe(14);
  }
  await page.evaluate(() => window.__app.openSettings('general'));
  const row = page.locator('.set-row', { has: page.locator('.set-label', { hasText: 'Размер текста в чатах' }) });
  await expect(row.locator('.range-val')).toHaveText('14 px');
  await row.locator('input[type=range]').fill('18');
  await expect(row.locator('.range-val')).toHaveText('18 px');
  for (const id of [a, b]) expect(await fontOf(page, id)).toBe(18);
});

test('отдалили холст: текст укрупняется до 12 px на экране, не больше чем втрое; выключили — обычный', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 460, h: 500, data: { messages: MSGS } });
  await zoomTo(app, page, 0.5);
  expect(await fontOf(page, a)).toBeCloseTo(24, 1); // 24 px × 50 % = 12 px on screen
  const screen = await page.evaluate((id) => { const el = document.querySelector(`.node[data-id="${id}"] .chat-list .msg-text`); return el.getBoundingClientRect().height; }, a);
  expect(screen).toBeGreaterThan(14); // one line of 12 px text on screen, not 7 px
  await zoomTo(app, page, 0.25);
  expect(await fontOf(page, a), 'не больше чем втрое').toBe(42);
  await zoomTo(app, page, 1);
  expect(await fontOf(page, a)).toBe(14);
  await setSetting(page, 'chatReadable', false);
  await zoomTo(app, page, 0.5);
  expect(await fontOf(page, a)).toBe(14);
});

test('после укрупнения текста чат по-прежнему показывает последнее сообщение', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 460, h: 500, data: { messages: MSGS } });
  const atBottom = () => page.evaluate((id) => { const l = document.querySelector(`.node[data-id="${id}"] .chat-list`); return l.scrollHeight - l.scrollTop - l.clientHeight < 4; }, a);
  await expect.poll(atBottom).toBe(true);
  await zoomTo(app, page, 0.45);
  await expect.poll(atBottom).toBe(true);
  await expect(chat(app, a).el.locator('.msg').last()).toContainText('Сообщение номер 30');
});

test('своё окно: Ctrl + / Ctrl − в поле ввода и меню «Размер текста»; Ctrl 0 — как в настройках', async ({ app, page }) => {
  const a = await addAgentChat(app, { x: 0, w: 460, h: 500 });
  const other = await addApiChat(app, { x: 520, w: 460, h: 500 });
  const input = chat(app, a).input;
  await input.click();
  await input.press('Control+Equal');
  await input.press('Control+Equal');
  expect(await fontOf(page, a)).toBe(16);
  expect((await app.node(a)).data.fontSize).toBe(16);
  expect(await fontOf(page, other), 'другие окна не меняются').toBe(14);
  await input.press('Control+Minus');
  expect(await fontOf(page, a)).toBe(15);
  await input.press('Control+0');
  expect(await fontOf(page, a)).toBe(14);
  expect((await app.node(a)).data.fontSize).toBeNull();

  const head = await app.box(other, '.node-head');
  await page.mouse.click(head.x + 80, head.cy, { button: 'right' });
  await menuItem(page, 'Размер текста').hover();
  await page.locator('.menu .sub .menu-item', { hasText: 'Крупнее' }).click();
  expect(await fontOf(page, other)).toBe(15);
  // the window's own size stays when the setting changes, and grows when zoomed out too
  await setSetting(page, 'chatFontSize', 12);
  expect(await fontOf(page, other)).toBe(15);
  expect(await fontOf(page, a)).toBe(12);
  await zoomTo(app, page, 0.5);
  expect(await fontOf(page, other)).toBe(24);
});

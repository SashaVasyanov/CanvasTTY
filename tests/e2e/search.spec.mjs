// Search across everything (Ctrl+K, renderer/js/search.js): objects of every canvas, messages in
// chat windows, notes, saved conversations, terminal output; Enter goes there. The index itself
// (main/search.js) is tested in tests/unit/search.test.mjs.
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat } from './helpers/chat.mjs';
import { vault } from './helpers/canvas.mjs';

const box = (page) => page.locator('.search-modal');
async function search(page, q) {
  await page.keyboard.press('Control+k');
  await expect(box(page)).toBeVisible();
  await box(page).locator('.search-input').fill(q);
  await expect(box(page).locator('.search-status')).toContainText(/Найдено|Ничего/);
}
const rows = (page) => box(page).locator('.sr-row');
const flashed = (page, id) => expect(page.locator(`.node[data-id="${id}"]`)).toHaveClass(/flash/);
const docId = (page) => page.evaluate(() => window.__app.canvas.doc.id);

test('Ctrl+K: стикер на этом холсте, слово подсвечено; Enter подлетает к нему', async ({ app, page }) => {
  const far = await app.add('sticky', { x: 3000, y: 2000, data: { text: 'Купить молоко\nи хлеб' } });
  await app.add('sticky', { x: 0, y: 0, data: { text: 'Позвонить в банк' } });
  await app.idle();
  await search(page, 'МОЛОКО');
  await expect(box(page).locator('.sr-head')).toHaveText(['На холстах · 1']);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Стикер «Купить молоко»');
  await expect(rows(page).first().locator('.pl-hint')).toHaveText('этот холст');
  await expect(rows(page).first().locator('mark').first()).toHaveText('молоко');
  await box(page).locator('.search-input').press('Enter');
  await expect(box(page)).toHaveCount(0);
  await flashed(page, far);
  expect(await app.selection()).toEqual([far]);
});

test('объект на другом холсте: в подсказке проект и холст, Enter открывает тот холст', async ({ app, page }) => {
  const first = await docId(page);
  const other = await page.evaluate(async () => { const { state } = await import('/js/state.js'); return (await state.createCanvas(state.project.id, 'Идеи')).id; });
  const st = await app.add('sticky', { x: 100, y: 100, data: { text: 'Редкое слово квазар' } });
  await page.evaluate(async (id) => { const { state } = await import('/js/state.js'); await state.openCanvas(state.project.id, id); }, first);
  expect(await docId(page)).toBe(first);
  await search(page, 'квазар');
  await expect(rows(page).first().locator('.pl-hint')).toHaveText('Мой проект / Идеи');
  await rows(page).first().click();
  await expect.poll(() => docId(page)).toBe(other);
  await flashed(page, st);
});

test('сообщение в окне чата: даже старое, за «Показать предыдущие», прокручено и подсвечено', async ({ app, page }) => {
  const msgs = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 4 ? 'Секретное слово — бегемот' : `Сообщение ${i + 1}` }));
  const a = await addAgentChat(app, { x: 0, w: 460, h: 460, data: { title: 'Длинный чат', messages: msgs } });
  await expect(chat(app, a).el.locator('.msg[data-i="4"]')).toHaveCount(0); // older than the last 40
  await search(page, 'бегемот');
  await expect(rows(page).first()).toContainText('Чат агента «Длинный чат» · ваше сообщение');
  await box(page).locator('.search-input').press('Enter');
  const msg = chat(app, a).el.locator('.msg[data-i="4"]');
  await expect(msg).toHaveClass(/found/);
  const inView = await page.evaluate((id) => { const l = document.querySelector(`.node[data-id="${id}"] .chat-list`); const m = l.querySelector('.msg[data-i="4"]'); const a = l.getBoundingClientRect(), b = m.getBoundingClientRect(); return b.top >= a.top && b.bottom <= a.bottom; }, a);
  expect(inView, 'сообщение видно в окне').toBe(true);
  expect(await page.evaluate(() => CSS.highlights.get('vt-found')?.size)).toBe(1);
});

test('заметка по тексту и разговор из истории чатов', async ({ app, page }) => {
  await vault.create(page, 'Проекты', 'Релиз', '# Релиз\n\nСобрать установщик под Windows');
  await search(page, 'установщик windows');
  await expect(box(page).locator('.sr-head')).toContainText(['Заметки · 1']);
  await rows(page).filter({ hasText: 'Релиз' }).click();
  await expect(page.locator('.note-panel .np-title')).toHaveValue('Релиз');

  // the demo history has «Починить сборку под Windows» (agent chat, Claude)
  await search(page, 'почини сборку');
  const hist = rows(page).filter({ hasText: 'Починить сборку под Windows' });
  await expect(hist).toHaveCount(1);
  await hist.click();
  await expect.poll(async () => (await app.nodes('agentchat')).length).toBe(1);
  const [w] = await app.nodes('agentchat');
  expect(w.data.convId).toBe('demo2');
  expect(w.data.messages.map((m) => m.content)).toEqual(['Почини сборку', 'Готово']);
});

test('вывод терминала на этом холсте; Ctrl+K в поле ввода не перехватывается', async ({ app, page }) => {
  const t = await app.add('terminal', { x: 0, y: 0, w: 600, h: 300 });
  await expect(page.locator(`.node[data-id="${t}"] .xterm-rows`)).toContainText('demo shell');
  await search(page, 'demo shell');
  await expect(box(page).locator('.sr-head')).toContainText(['В терминалах · 1']);
  await rows(page).filter({ hasText: 'Терминал' }).click();
  await flashed(page, t);

  const s = await app.add('sticky', { x: 700, y: 0, data: { text: '' } });
  await page.evaluate((id) => window.__app.canvas.views.get(id).inst.edit(), s);
  await page.keyboard.press('Control+k');
  await expect(box(page)).toHaveCount(0);
});

test('поиск есть в поиске команд; меньше 2 букв — подсказка', async ({ app, page }) => {
  await page.keyboard.press('Control+p');
  const input = page.locator('.modal input').first();
  await input.fill('Поиск по всему');
  await input.press('Enter');
  await expect(box(page)).toBeVisible();
  await box(page).locator('.search-input').fill('я');
  await expect(box(page).locator('.search-status')).toHaveText('Введите хотя бы 2 буквы');
});

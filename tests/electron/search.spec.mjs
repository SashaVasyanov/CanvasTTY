// Search across everything in the real app: canvas files on disk (also of a canvas that is not
// open), notes in the vault, saved conversations — and the same after a restart.
import { test, expect } from './fixtures.mjs';

async function search(app, q) {
  await app.page.keyboard.press('Control+k');
  const box = app.page.locator('.search-modal');
  await expect(box).toBeVisible();
  await box.locator('.search-input').fill(q);
  await expect(box.locator('.search-status')).toContainText(/Найдено|Ничего/);
  return box;
}

test('поиск находит стикер на другом холсте, заметку и разговор из истории; после перезапуска тоже', async ({ app }) => {
  const page = app.page;
  const first = await page.evaluate(() => window.__app.canvas.doc.id);
  await page.evaluate(async () => { const { state } = await import('./js/state.js'); await state.createCanvas(state.project.id, 'Архив идей'); });
  const st = await app.add('sticky', { x: 0, y: 0, data: { text: 'Проверить пульсар на стенде' } });
  await page.evaluate(async (id) => { const { state } = await import('./js/state.js'); await state.openCanvas(state.project.id, id); }, first);
  await page.evaluate(async () => {
    await window.native.vault.create('', 'Стенд', '# Стенд\n\nНастройка пульсара и датчиков');
    await window.native.history.save({ id: 'cv_puls', kind: 'chat', agent: 'openai', provider: 'openai', title: 'Про пульсары', messages: [{ role: 'user', content: 'что такое пульсар' }, { role: 'assistant', content: 'Нейтронная звезда' }] });
  });

  let box = await search(app, 'пульсар');
  await expect(box.locator('.sr-head')).toHaveText([/На холстах · 1/, /Заметки · 1/, /История чатов · 1/]);
  await expect(box.locator('.sr-row').first().locator('.pl-hint')).toHaveText(/Архив идей/);
  await box.locator('.search-input').press('Enter');
  await expect.poll(() => page.evaluate((id) => !!window.__app.canvas.node(id), st), { message: 'открылся холст «Архив идей»' }).toBe(true);
  await expect(page.locator(`.node[data-id="${st}"]`)).toHaveClass(/flash/);

  await app.restart();
  box = await search(app, 'датчиков пульсара');
  await expect(box.locator('.sr-row')).toHaveCount(1);
  await expect(box.locator('.sr-row').first()).toContainText('Стенд');
});

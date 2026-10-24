// View bookmarks in the real app: Ctrl+Shift+1 right before closing the window is written into the
// canvas file, and after the restart Ctrl+1 flies there (on a canvas that is opened again).
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

const lookAt = (page, x, y, z = 1) => page.evaluate(([x, y, z]) => { const c = window.__app.canvas, r = c.rect(); c.vp.z = z; c.vp.x = r.width / 2 - x * z; c.vp.y = r.height / 2 - y * z; c.applyViewport(); }, [x, y, z]);
const middle = (page) => page.evaluate(() => { const c = window.__app.canvas, r = c.rect(); return { x: Math.round((r.width / 2 - c.vp.x) / c.vp.z), y: Math.round((r.height / 2 - c.vp.y) / c.vp.z), z: Math.round(c.vp.z * 100) / 100 }; });

test('закладка вида в файле холста и после перезапуска; у другого холста своих нет', async ({ app }) => {
  const page = app.page;
  await app.add('frame', { x: 1400, y: 600, w: 800, h: 500, data: { title: 'Релиз' } });
  await lookAt(page, 1800, 850, 0.7);
  await page.keyboard.press('Control+Shift+Digit2');
  const canvasId = await page.evaluate(() => window.__app.canvas.doc.id);
  await app.closeWindow(); // inside the save delay: the page flushes first
  const saved = app.readJson(path.join(app.userData, 'canvases', `${canvasId}.json`));
  expect(saved.bookmarks).toEqual([{ id: 'b2', slot: 2, name: 'Релиз', x: 1800, y: 850, z: 0.7 }]);

  await app.launch();
  await lookAt(app.page, 0, 0, 1);
  await app.page.keyboard.press('Control+Digit2');
  await expect.poll(() => middle(app.page)).toEqual({ x: 1800, y: 850, z: 0.7 });

  await app.page.evaluate(async () => { const { state } = await import('./js/state.js'); await state.createCanvas(state.project.id, 'Другой'); });
  await app.page.keyboard.press('Control+Digit2');
  await expect(app.page.locator('.toast').last()).toContainText('Закладки 2 на этом холсте нет');
});

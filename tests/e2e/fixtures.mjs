// Shared setup for the browser tests: every test gets a fresh app (demo data, empty canvas,
// fixed viewport) and fails if the page logged an error.
import { test as base, expect } from '@playwright/test';

export { expect };

// noise that is not a bug of the app
const IGNORED = /favicon|ResizeObserver loop|Failed to load resource/i;

export class App {
  constructor(page) { this.page = page; }

  // empty canvas, nothing selected, world (0,0) at screen (x, y) of the canvas, zoom z
  async reset({ x = 300, y = 150, z = 1 } = {}) {
    await this.page.evaluate(({ x, y, z }) => {
      const c = window.__app.canvas;
      c.removeNodes(c.doc.nodes.map((n) => n.id));
      c.doc.edges.length = 0; c.renderEdges();
      c.undoStack.length = 0; c.redoStack.length = 0;
      c.vp.x = x; c.vp.y = y; c.vp.z = z; c.applyViewport();
      c.selection.clear(); c.afterSelect();
    }, { x, y, z });
    await this.idle();
  }

  // right after the view moves the canvas ignores the pointer for a moment (class vp-moving)
  idle() { return expect(this.page.locator('.canvas-root')).not.toHaveClass(/vp-moving/); }

  theme(t) { return this.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), t); }

  // add an object without selecting it; returns its id
  add(type, opts = {}, { select = false } = {}) {
    return this.page.evaluate(([type, opts, select]) => window.__app.canvas.addNode(type, opts, { center: false, select }).id, [type, opts, select]);
  }
  node(id) { return this.page.evaluate((id) => { const n = window.__app.canvas.node(id); return n && JSON.parse(JSON.stringify(n)); }, id); }
  nodes(type) { return this.page.evaluate((type) => JSON.parse(JSON.stringify(window.__app.canvas.doc.nodes.filter((n) => !type || n.type === type))), type); }
  edges() { return this.page.evaluate(() => JSON.parse(JSON.stringify(window.__app.canvas.doc.edges))); }
  selection() { return this.page.evaluate(() => [...window.__app.canvas.selection]); }
  select(ids) { return this.page.evaluate((ids) => { const c = window.__app.canvas; c.select(ids); c.updateOverlay(); }, ids); }
  clearSelection() { return this.page.evaluate(() => { const c = window.__app.canvas; c.selection.clear(); c.afterSelect(); c.updateOverlay(); }); }
  undo() { return this.page.evaluate(() => window.__app.canvas.undo()); }
  redo() { return this.page.evaluate(() => window.__app.canvas.redo()); }

  // the DOM element of an object and its screen box
  el(id) { return this.page.locator(`.node[data-id="${id}"]`); }
  async box(id, inner = '') {
    const b = await this.page.locator(`.node[data-id="${id}"] ${inner}`.trim()).first().boundingBox();
    if (!b) throw new Error(`no box for ${id} ${inner}`);
    return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  }

  // drag with the mouse from one point to another in small steps
  async drag(from, to, { steps = 12, modifiers = [] } = {}) {
    const m = this.page.mouse;
    for (const k of modifiers) await this.page.keyboard.down(k);
    await m.move(from.x, from.y); await m.down();
    for (let i = 1; i <= steps; i++) await m.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await m.up();
    for (const k of modifiers) await this.page.keyboard.up(k);
  }

  // a paste event with an image or text on the clipboard, dispatched where the focus is
  paste({ image, text } = {}) {
    return this.page.evaluate(async ({ image, text }) => {
      const dt = new DataTransfer();
      if (image) {
        const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30;
        const x = cv.getContext('2d'); x.fillStyle = image === true ? '#34c759' : image; x.fillRect(0, 0, 40, 30);
        const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
        dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      }
      if (text) dt.setData('text/plain', text);
      const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { image, text });
  }

  // a PNG made in the page, as an image object in the vault (like a dropped file)
  addImage({ x = 0, y = 0, name = 'Картинка.png', color = '#34c759', w = 200, h = 140 } = {}) {
    return this.page.evaluate(async ({ x, y, name, color, w, h }) => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const { imageNodeFromFile } = await import('/js/nodes.js');
      const n = await imageNodeFromFile(window.__app.canvas, new File([blob], name, { type: 'image/png' }), { x, y });
      window.__app.canvas.selection.clear(); window.__app.canvas.afterSelect();
      return n.id;
    }, { x, y, name, color, w, h });
  }
}

export const test = base.extend({
  app: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.test(m.text())) errors.push(`console: ${m.text()}`); });
    // every test has its own browser context, so storage starts empty (no clear + reload, whose
    // debounced saves of the first page could land after the clear)
    await page.goto('/');
    await page.waitForFunction(() => window.__app?.canvas?.doc && !document.querySelector('#boot'), null, { timeout: 15_000 }).catch(() => page.waitForFunction(() => window.__app?.canvas?.doc));
    const app = new App(page);
    await app.reset();
    await use(app);
    expect(errors, 'в консоли страницы не должно быть ошибок').toEqual([]);
  },
});

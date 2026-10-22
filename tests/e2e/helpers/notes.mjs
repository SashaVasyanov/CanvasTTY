// Helpers for the notes / widgets / comments / misc specs: the demo vault of mock.js, note
// editors, calendar days and a page reload that keeps localStorage (the "disk" of the mock).

// a note in the demo vault (and in the vault index, so links and the editor find it); returns its path
export function createNote(page, name, content = '', folder = '') {
  return page.evaluate(async ([folder, name, content]) => {
    const { native } = await import('/js/state.js');
    const p = await native.vault.create(folder, name, content);
    await (await import('/js/vaultIndex.js')).vaultIndex.refresh();
    return p;
  }, [folder, name, content]);
}

// text of a note file, or null when there is no such file
export function readNote(page, path) {
  return page.evaluate(async (path) => {
    const { native } = await import('/js/state.js');
    try { return await native.vault.read(path); } catch { return null; }
  }, path);
}

// every .md file of the demo vault, sorted
export function notePaths(page) {
  return page.evaluate(async () => {
    const { native } = await import('/js/state.js');
    return (await native.vault.index()).notes.map((n) => n.path).sort();
  });
}

// font / size saved per note (mock of <vault>/.vibetabula/note-styles.json)
export function savedNoteStyles(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('mock:noteStyles') || '{}'));
}

// what the editors of notes show: the canvas window(s) and the side panel
export function editorLook(page) {
  return page.evaluate(() => [...document.querySelectorAll('.note-toolbar')].map((tb) => {
    const panel = tb.closest('.note-panel');
    const content = panel ? panel.querySelector('.rich-content') : tb.closest('.rich-editor').querySelector('.rich-content');
    const cs = getComputedStyle(content);
    return {
      where: panel ? 'panel' : 'canvas',
      path: panel ? null : window.__app.canvas.node(tb.closest('.node').dataset.id)?.data.path,
      fontSize: cs.fontSize,
      fontFamily: content.style.fontFamily,
      button: tb.querySelector('.ns-fontname').textContent,
      size: tb.querySelector('.ns-size').value,
    };
  }));
}

// select characters [start, end) of the first text node inside `selector` (focuses its editor)
export function selectText(page, selector, start, end) {
  return page.evaluate(([selector, start, end]) => {
    const el = document.querySelector(selector);
    const editor = el.closest('[contenteditable="true"]') || el;
    editor.focus();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode();
    const r = document.createRange(); r.setStart(t, start); r.setEnd(t, end);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return s.toString();
  }, [selector, start, end]);
}

// reload the page keeping localStorage (the saved workspace, vault and settings of the mock)
export async function reloadApp(page) {
  await page.reload();
  await page.waitForFunction(() => window.__app?.canvas?.doc && !document.querySelector('#boot'), null, { timeout: 15_000 });
}

// move / zoom the view without touching the objects (the fixture's reset() also clears the canvas)
export async function setViewport(page, { x = 300, y = 150, z = 1 } = {}) {
  await page.evaluate(({ x, y, z }) => { const c = window.__app.canvas; c.vp.x = x; c.vp.y = y; c.vp.z = z; c.applyViewport(); }, { x, y, z });
  await canvasIdle(page);
}

// for 160 ms after the viewport moves (also the fixture's reset) objects ignore the mouse
// (.vp-moving, smooth panning); wait for the canvas to rest before clicking into a window
export function canvasIdle(page) {
  return page.waitForFunction(() => !window.__app.canvas.root.classList.contains('vp-moving'));
}

// a key press as the canvas sees it (focus on the page, not in an editor)
export function canvasKey(page, key, code, mods = {}) {
  return page.evaluate(([key, code, mods]) => {
    document.activeElement?.blur?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }));
  }, [key, code, mods]);
}

// key of a day of the month the calendar widget shows now ("2026-10-21")
export function calendarKey(page, day) {
  return page.evaluate((day) => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }, day);
}

// a calendar widget's day notes
export function calendarNotes(page, id) {
  return page.evaluate((id) => JSON.parse(JSON.stringify(window.__app.canvas.node(id).data.notes || {})), id);
}

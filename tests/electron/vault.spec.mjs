// The notes vault is a plain folder of Markdown files (Obsidian-compatible): what the editor writes
// to disk, note styles next to the notes, renaming with link updates.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

test('заметка из редактора сохраняется в .md, последние правки — даже при закрытии окна', async ({ app }) => {
  const vault = await app.page.evaluate(() => window.native.vault.root());
  const file = path.join(vault, 'Идеи.md');
  const read = () => fs.readFileSync(file, 'utf8');
  await app.page.evaluate(() => window.__app.openNote('Идеи.md'));
  const editor = app.page.locator('.note-panel .rich-content');
  await expect(editor).toContainText('Сделать агента для ревью кода');
  await editor.click();
  const kb = app.page.keyboard;
  await kb.press('Control+End');
  await kb.press('Enter');
  await kb.type('## Новый раздел');
  await kb.press('Enter');
  await kb.type('[] купить молоко');
  await kb.press('Enter');
  await kb.type('позвонить');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('Связь с [[Доб');
  await expect(app.page.locator('.menu, .suggest, .ac-list, [class*="suggest"]').filter({ hasText: 'Добро пожаловать в VibeTabula' }).first()).toBeVisible();
  await kb.press('Enter');
  await kb.type('и **готово**');

  await expect.poll(read, { timeout: 10_000 }).toContain('**готово**');
  const md = read();
  expect(md.startsWith('# Идеи\n\nСюда можно складывать идеи для проектов. Обратная ссылка: [[Добро пожаловать в VibeTabula]]\n\n- Сделать агента для ревью кода #идея\n')).toBe(true);
  expect(md).toContain('\n## Новый раздел\n\n- [ ] купить молоко\n- [ ] позвонить\n\nСвязь с [[Добро пожаловать в VibeTabula]] ');
  const index = await app.page.evaluate(() => window.native.vault.index());
  expect(index.notes.find((n) => n.name === 'Идеи').links).toEqual(['Добро пожаловать в VibeTabula']);

  // typed right before the window closes: written by the flush on close, not lost with the 0.5 s delay
  await kb.type(' ПОСЛЕДНЕЕ');
  await app.closeWindow();
  expect(read()).toMatch(/\*\*готово\*\* ПОСЛЕДНЕЕ\n$/);
});

test('стиль заметки лежит рядом с заметками и переезжает при переименовании; ссылки обновляются', async ({ app }) => {
  const vault = await app.page.evaluate(() => window.native.vault.root());
  const r = await app.page.evaluate(async () => {
    const v = window.native.vault;
    await v.setStyle('Идеи.md', { font: 'Georgia', size: 18 });
    const before = await v.styles();
    const moved = await v.rename('Идеи.md', 'Проекты/Мысли.md');
    return { before, moved, after: await v.styles(), index: await v.index() };
  });
  expect(r.before).toEqual({ 'Идеи.md': { font: 'Georgia', size: 18 } });
  expect(r.moved).toBe('Проекты/Мысли.md');
  expect(r.after).toEqual({ 'Проекты/Мысли.md': { font: 'Georgia', size: 18 } });
  expect(app.readJson(path.join(vault, '.vibetabula', 'note-styles.json'))).toEqual(r.after);
  // the hidden folder is not a note or a folder of the vault
  expect(r.index.folders).toEqual(['Проекты']);
  expect(r.index.notes.map((n) => n.path).sort()).toEqual(['Добро пожаловать в VibeTabula.md', 'Проекты/Мысли.md']);

  // [[Идеи]] in the other note now points to the new name, like Obsidian does it
  expect(fs.readFileSync(path.join(vault, 'Добро пожаловать в VibeTabula.md'), 'utf8')).toContain('- [x] Ссылки между заметками: [[Мысли]]');
  expect(fs.existsSync(path.join(vault, 'Идеи.md'))).toBe(false);
  expect(fs.readFileSync(path.join(vault, 'Проекты', 'Мысли.md'), 'utf8')).toMatch(/^# Идеи\n/);
});

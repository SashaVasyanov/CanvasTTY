// What an agent changed during one answer: the line under the answer, the card with the diff,
// rollback and taking it back. The git work itself (main/changes.js) is tested in
// tests/unit/changes.test.mjs and in the real app (tests/electron/changes.spec.mjs); here the mock
// answers with prepared changes (window.__mockChanges).
import { test, expect } from './fixtures.mjs';
import { addAgentChat, chat, recordAgentRuns, agentRun, emitAgent, sendMessage } from './helpers/chat.mjs';

const CHANGES = {
  root: '/demo/repo', before: 'tree-before', after: 'tree-after',
  files: [
    { path: 'src/app.js', status: 'M', add: 2, del: 1, binary: false },
    { path: 'src/new.js', status: 'A', add: 1, del: 0, binary: false },
    { path: 'old.txt', status: 'D', add: 0, del: 3, binary: false },
  ],
};
const PATCHES = {
  'src/app.js': 'diff --git a/src/app.js b/src/app.js\nindex 1..2 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,3 @@\n const a = 1;\n-console.log(a);\n+console.info(a);\n+export default a;\n',
  'src/new.js': '@@ -0,0 +1 @@\n+export const x = 1;\n',
};
const line = (c) => c.el.locator('.msg-changes');
const card = (page) => page.locator('.node-diff');

async function answerWithChanges(app, page, changes = CHANGES) {
  await page.evaluate(([since, patches]) => { window.__mockChanges = { since, patches }; }, [changes, PATCHES]);
  await recordAgentRuns(page);
  const id = await addAgentChat(app, { x: 0, data: { title: 'Рефакторинг' } });
  const c = chat(app, id);
  await sendMessage(c, 'Поправь логирование');
  await agentRun(page);
  await emitAgent(page, { type: 'delta', text: 'Готово.' });
  await emitAgent(page, { type: 'done', sessionId: 's1' });
  return { id, c };
}

test('строка под ответом: сколько файлов и строк изменил агент', async ({ app, page }) => {
  const { id, c } = await answerWithChanges(app, page);
  await expect(line(c).locator('.mc-text')).toHaveText('Изменено 3 файла');
  await expect(line(c).locator('.mc-add')).toHaveText('+3');
  await expect(line(c).locator('.mc-del')).toHaveText('−4');
  await expect(line(c).locator('button')).toHaveText(['Показать', 'Откатить']);
  const saved = (await app.node(id)).data.messages.at(-1);
  expect(saved.changes.after).toBe('tree-after');
  expect(saved.snap, 'снимок «до» не остаётся в переписке').toBeUndefined();
});

test('карточка изменений рядом с чатом: файлы, diff с подсветкой, «Показать в папке»', async ({ app, page }) => {
  const { id, c } = await answerWithChanges(app, page);
  await line(c).locator('button', { hasText: 'Показать' }).click();
  await expect(card(page)).toHaveCount(1);
  const [d] = await app.nodes('diff'), chatNode = await app.node(id);
  expect(d.x, 'справа от чата').toBeGreaterThanOrEqual(chatNode.x + chatNode.w);
  expect(await app.edges(), 'без стрелки: карточка не становится контекстом агента').toEqual([]);
  await expect(card(page).locator('.node-head .head-title')).toHaveText('Изменения: Рефакторинг');
  await expect(card(page).locator('.diff-head')).not.toContainText('null');
  await expect(card(page).locator('.diff-path')).toHaveText(['src/app.js', 'src/new.js', 'old.txt']);
  await expect(card(page).locator('.diff-st')).toHaveText(['изменён', 'новый', 'удалён']);
  // the first file is open: header lines hidden, added and removed lines marked
  const first = card(page).locator('.diff-file').first();
  await expect(first.locator('.dl.del')).toHaveText(['-console.log(a);']);
  await expect(first.locator('.dl.add')).toHaveText(['+console.info(a);', '+export default a;']);
  await expect(first.locator('.dl.hunk')).toHaveCount(1);
  await expect(first.locator('.dl', { hasText: 'diff --git' })).toHaveCount(0);
  // the others load when opened
  await card(page).locator('.diff-file').nth(1).locator('summary .diff-path').click();
  await expect(card(page).locator('.diff-file').nth(1).locator('.dl.add')).toHaveText(['+export const x = 1;']);
  await card(page).locator('.diff-file').nth(1).locator('summary .icon-btn').click();
  expect(await page.evaluate(() => window.__mockChanges.revealed)).toEqual({ root: '/demo/repo', file: 'src/new.js' });
  // a second «Показать» goes to the same card
  await line(c).locator('button', { hasText: 'Показать' }).click();
  await expect(card(page)).toHaveCount(1);
});

test('«Откатить» после подтверждения, «Вернуть» — обратно; карточка видит то же', async ({ app, page }) => {
  const { id, c } = await answerWithChanges(app, page);
  await line(c).locator('button', { hasText: 'Показать' }).click();
  await expect(card(page)).toHaveCount(1);
  await app.idle();
  await line(c).locator('button', { hasText: 'Откатить' }).click();
  await expect(page.locator('.modal')).toContainText('Откатить изменения агента в 3 файлах?');
  await page.locator('.modal button', { hasText: 'Откатить' }).click();
  await expect(line(c).locator('.mc-text')).toHaveText('Изменения откачены (3 файла)');
  await expect(line(c).locator('button')).toHaveText(['Показать', 'Вернуть']);
  await expect(card(page).locator('.diff-head .diff-rev')).toHaveText('откачено');
  await expect(card(page).locator('.diff-head button')).toHaveText('Вернуть');
  let restores = await page.evaluate(() => window.__mockChanges.restores);
  expect(restores).toEqual([{ root: '/demo/repo', from: 'tree-before', expect: 'tree-after', files: ['src/app.js', 'src/new.js', 'old.txt'] }]);
  expect((await app.node(id)).data.messages.at(-1).changes.reverted.files).toHaveLength(3);

  // taking it back from the card (once the camera that flew to the card has stopped: while the
  // view moves, clicks go to the canvas)
  await app.idle();
  await card(page).locator('.diff-head button', { hasText: 'Вернуть' }).click();
  await expect(line(c).locator('.mc-text')).toHaveText('Изменено 3 файла');
  restores = await page.evaluate(() => window.__mockChanges.restores);
  expect(restores[1]).toEqual({ root: '/demo/repo', from: 'tree-after', expect: 'tree-before', files: ['src/app.js', 'src/new.js', 'old.txt'] });
  expect((await app.node(id)).data.messages.at(-1).changes.reverted).toBeUndefined();
});

test('файл, который правили после ответа, не откатывается — и об этом сказано', async ({ app, page }) => {
  const { c } = await answerWithChanges(app, page);
  await page.evaluate(() => { window.__mockChanges.restoreResult = (o) => ({ done: o.files.filter((f) => f !== 'src/app.js'), skipped: [{ path: 'src/app.js', reason: 'файл изменили после ответа' }] }); });
  await line(c).locator('button', { hasText: 'Откатить' }).click();
  await page.locator('.modal button', { hasText: 'Откатить' }).click();
  await expect(page.locator('.toast').last()).toContainText('Не тронуты: src/app.js (файл изменили после ответа)');
  await expect(line(c).locator('.mc-text')).toHaveText('Изменения откачены (2 файла)');
});

test('«Отмена» в подтверждении ничего не трогает', async ({ app, page }) => {
  const { c } = await answerWithChanges(app, page);
  await line(c).locator('button', { hasText: 'Откатить' }).click();
  await page.locator('.modal button', { hasText: 'Отмена' }).click();
  await expect(line(c).locator('.mc-text')).toHaveText('Изменено 3 файла');
  expect(await page.evaluate(() => window.__mockChanges.restores || [])).toEqual([]);
});

test('агент ничего не менял — строки нет; папка не под git — список тронутых файлов', async ({ app, page }) => {
  const { c } = await answerWithChanges(app, page, { ...CHANGES, files: [] });
  await expect(c.lastAnswer).toContainText('Готово.');
  await expect(line(c)).toHaveCount(0);

  await page.evaluate(() => { window.__mockChanges = null; });
  const id2 = await addAgentChat(app, { x: 620 });
  const c2 = chat(app, id2);
  await sendMessage(c2, 'Поправь');
  await agentRun(page, 1);
  await emitAgent(page, { type: 'tool', id: 't1', name: 'Файлы', input: 'update src/a.js\nadd src/b.js' });
  await emitAgent(page, { type: 'toolResult', id: 't1', output: 'ok' });
  await emitAgent(page, { type: 'done' });
  await expect(line(c2).locator('.mc-text')).toHaveText('Агент менял 2 файла: a.js, b.js');
  await expect(line(c2).locator('.mc-note')).toHaveText('папка не под git — без diff и отката');
  await expect(line(c2).locator('button')).toHaveCount(0);
});

// ---------------- comments on lines → the agent (renderer/js/diffComments.js, diffView.js) ----------------
async function openCard(app, page) {
  const r = await answerWithChanges(app, page);
  await line(r.c).locator('button', { hasText: 'Показать' }).click();
  await expect(card(page).locator('.diff-file').first().locator('.dl.add').first()).toBeVisible();
  return r;
}
async function addComment(page, row, text, { button = false } = {}) {
  await row.hover();
  await row.locator('.dl-plus').click();
  const ta = card(page).locator('.dl-ta');
  await expect(ta).toBeFocused();
  await ta.fill(text);
  if (button) await card(page).locator('.dl-edit button', { hasText: 'Добавить' }).click();
  else await ta.press('Control+Enter');
  await expect(ta).toHaveCount(0);
}

test('замечания к строкам: номера строк, «+» → текст, правка, удаление; «Отправить агенту» — одним сообщением', async ({ app, page }) => {
  const { id, c } = await openCard(app, page);
  const first = card(page).locator('.diff-file').first();
  const adds = first.locator('.dl.add'), del = first.locator('.dl.del');
  await expect(adds).toHaveText(['+console.info(a);', '+export default a;']); // the number is not part of the text
  expect(await adds.evaluateAll((els) => els.map((e) => e.dataset.no))).toEqual(['2', '3']);
  expect(await del.getAttribute('data-no')).toBe('2');
  await expect(card(page).locator('.diff-send')).toHaveCount(0); // no comments yet

  await addComment(page, adds.first(), 'Оставь console.log');
  await addComment(page, del, 'Зачем удалил?', { button: true });
  const notes = first.locator('.dl-cmt');
  await expect(notes.locator('.dl-cmt-text')).toHaveText(['Зачем удалил?', 'Оставь console.log']); // under their lines, in order
  await expect(notes.first().locator('.dl-cmt-meta')).toContainText('ещё не отправлено');
  await expect(first.locator('.diff-ncmt')).toHaveText('💬 2');
  await expect(card(page).locator('.diff-send')).toHaveText('Отправить агенту (2)');

  // edit and delete; Esc closes the editor, Delete in it does not delete the card
  await notes.nth(1).locator('[title="Изменить"]').click();
  await card(page).locator('.dl-ta').fill('Верни console.log, info не нужен');
  await card(page).locator('.dl-ta').press('Delete');
  await card(page).locator('.dl-edit button', { hasText: 'Сохранить' }).click();
  await expect(card(page)).toHaveCount(1);
  await addComment(page, adds.nth(1), 'временное');
  await expect(card(page).locator('.diff-send')).toHaveText('Отправить агенту (3)');
  await first.locator('.dl-cmt', { hasText: 'временное' }).locator('[title="Удалить замечание"]').click();
  await adds.nth(1).hover(); await adds.nth(1).locator('.dl-plus').click();
  await card(page).locator('.dl-ta').press('Escape');
  await expect(card(page).locator('.dl-ta')).toHaveCount(0);

  await card(page).locator('.diff-send').click();
  const run = await agentRun(page, 1);
  expect(run.prompt).toContain([
    'Замечания к твоим изменениям — исправь, пожалуйста:',
    '',
    'src/app.js, строка 2 (удалена; номер в старой версии):\n> console.log(a);\nЗачем удалил?',
    '',
    'src/app.js, строка 2 (добавлена):\n> console.info(a);\nВерни console.log, info не нужен',
  ].join('\n'));
  await expect(c.userMsgs.last()).toContainText('Замечания к твоим изменениям');
  await expect(card(page).locator('.diff-send')).toHaveText('Замечания отправлены');
  await expect(card(page).locator('.diff-send')).toBeDisabled();
  await expect(notes.first().locator('.dl-cmt-meta')).toContainText('отправлено агенту');
  await expect(notes.first()).toHaveClass(/sent/);

  // kept in the card: after a reload too
  await page.evaluate(async () => (await import('/js/state.js')).state.saveDoc.flush());
  await page.reload();
  await page.waitForFunction(() => window.__app?.canvas?.doc && !document.querySelector('#boot'));
  const [d] = await app.nodes('diff');
  expect(d.data.comments.map((x) => [x.file, x.kind, x.line, x.text, !!x.sent])).toEqual([
    ['src/app.js', 'add', 2, 'Верни console.log, info не нужен', true],
    ['src/app.js', 'del', 2, 'Зачем удалил?', true],
  ]);
  expect(id).toBeTruthy();
});

test('агент ещё работает — замечания уходят после его ответа', async ({ app, page }) => {
  const { c } = await openCard(app, page);
  await addComment(page, card(page).locator('.dl.add').first(), 'Переименуй переменную');
  // the agent is busy with another question
  await c.input.fill('И ещё добавь тест');
  await c.input.press('Enter');
  await agentRun(page, 1);
  await card(page).locator('.diff-send').click();
  await expect(page.locator('.toast').last()).toContainText('замечания уйдут после его ответа');
  expect((await page.evaluate(() => window.__agentRuns.length))).toBe(2);
  await emitAgent(page, { type: 'done', sessionId: 's1' });
  const run = await agentRun(page, 2);
  expect(run.prompt).toContain('Переименуй переменную');
});

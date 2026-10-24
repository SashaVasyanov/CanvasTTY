// Comments on lines of the «Изменения» card (renderer/js/diffComments.js): line numbers from the
// diff and the message that goes to the agent. The card itself: tests/e2e/changes.spec.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, commentMessage } from '../../renderer/js/diffComments.js';

const PATCH = 'diff --git a/src/app.js b/src/app.js\nindex 1..2 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -10,3 +10,4 @@ function main() {\n const a = 1;\n-console.log(a);\n+console.info(a);\n+export default a;\n \n\\ No newline at end of file\n@@ -40 +41 @@\n-old\n+new\n';

test('номера строк: новая версия для добавленных и неизменённых, старая — для удалённых', () => {
  const rows = parsePatch(PATCH);
  assert.deepEqual(rows.map((r) => [r.kind, r.line ?? null, r.text]), [
    ['hunk', null, '@@ -10,3 +10,4 @@ function main() {'],
    ['ctx', 10, ' const a = 1;'],
    ['del', 11, '-console.log(a);'],
    ['add', 11, '+console.info(a);'],
    ['add', 12, '+export default a;'],
    ['ctx', 13, ' '],
    ['meta', null, '\\ No newline at end of file'],
    ['hunk', null, '@@ -40 +41 @@'],
    ['del', 40, '-old'],
    ['add', 41, '+new'],
  ]);
  assert.deepEqual(parsePatch(''), []);
  assert.deepEqual(parsePatch('@@ -0,0 +1 @@\n+export const x = 1;\n').map((r) => r.line ?? null), [null, 1]);
});

test('сообщение агенту: файл, строка, что за строка, код и замечание; по порядку в файлах', () => {
  const text = commentMessage([
    { file: 'src/app.js', kind: 'add', line: 11, code: '+console.info(a);', text: 'Оставь console.log' },
    { file: 'src/app.js', kind: 'del', line: 40, code: '-old', text: '  Зачем удалил?\n' },
    { file: 'README.md', kind: 'ctx', line: 3, code: ' ', text: 'Добавь сюда раздел' },
  ]);
  assert.equal(text, [
    'Замечания к твоим изменениям — исправь, пожалуйста:',
    '',
    'README.md, строка 3:\nДобавь сюда раздел',
    '',
    'src/app.js, строка 11 (добавлена):\n> console.info(a);\nОставь console.log',
    '',
    'src/app.js, строка 40 (удалена; номер в старой версии):\n> old\nЗачем удалил?',
  ].join('\n'), 'по файлам, сверху вниз');
  const same = commentMessage([{ file: 'a', kind: 'add', line: 5, code: '+x', text: 'B' }, { file: 'a', kind: 'del', line: 5, code: '-y', text: 'A' }]);
  assert.ok(same.indexOf('\nA') < same.indexOf('\nB'), 'удалённая строка перед добавленной с тем же номером');
});

// Comments on lines of the «Изменения» card (nodes.js diff): «+» by a line → write what to fix;
// «Отправить агенту» sends every new comment to the agent's chat window as one message (after its
// current answer if it is busy). Kept in the card (node.data.comments), so they survive a restart
// and travel with sync; sent ones stay, marked «отправлено».
//   comment: { id, file, kind: 'add'|'del'|'ctx', line, code, text, sent?: ms }
//   line: the number in the new version (in the old one for a removed line)
// Pure functions (no DOM): tests/unit/diff-comments.test.mjs; the lines with comments: diffView.js

const HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename |old mode|new mode)/;

// a unified diff → rows { kind: 'hunk'|'add'|'del'|'ctx'|'meta', text, line? }
export function parsePatch(patch) {
  const out = [];
  let o = 0, n = 0;
  const lines = String(patch || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const text of lines) {
    if (HEADER.test(text)) continue;
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hm) { o = Number(hm[1]); n = Number(hm[2]); out.push({ kind: 'hunk', text }); continue; }
    if (text.startsWith('\\')) { out.push({ kind: 'meta', text }); continue; }
    if (text.startsWith('+')) { out.push({ kind: 'add', text, line: n++ }); continue; }
    if (text.startsWith('-')) { out.push({ kind: 'del', text, line: o++ }); continue; }
    out.push({ kind: 'ctx', text, line: n++ }); o++;
  }
  return out;
}

const KIND_NOTE = { add: ' (добавлена)', del: ' (удалена; номер в старой версии)', ctx: '' };
const codeOf = (c) => String(c.code || '').replace(/^[+\- ]/, '').slice(0, 300);
// the message to the agent: by file, then from the top of the file (a removed line before the added one)
export function commentMessage(list) {
  const sorted = [...list].sort((a, b) => String(a.file).localeCompare(String(b.file)) || a.line - b.line || (a.kind === 'del' ? 0 : 1) - (b.kind === 'del' ? 0 : 1));
  const blocks = sorted.map((c) => {
    const code = codeOf(c);
    return `${c.file}, строка ${c.line}${KIND_NOTE[c.kind] || ''}:${code.trim() ? `\n> ${code}` : ''}\n${String(c.text).trim()}`;
  });
  return `Замечания к твоим изменениям — исправь, пожалуйста:\n\n${blocks.join('\n\n')}`;
}

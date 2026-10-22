#!/usr/bin/env node
// A stand-in for `codex exec --json`: reads the prompt from stdin, prints a thread id and
// FAKE_STEPS agent messages FAKE_GAP ms apart, then turn.completed. FAKE_FAIL=1 → exits with an error.
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const r = args.indexOf('resume');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (process.env.FAKE_FAIL) { process.stderr.write('Error: unexpected status 401 Unauthorized\n'); process.exit(2); }
  out({ type: 'thread.started', thread_id: r >= 0 ? args[r + 1] : 'thread-1' });
  out({ type: 'turn.started' });
  const n = Number(process.env.FAKE_STEPS || 3), gap = Number(process.env.FAKE_GAP || 50);
  for (let i = 1; i <= n; i++) setTimeout(() => out({ type: 'item.completed', item: { id: `m${i}`, type: 'agent_message', text: `Часть ${i}: ${stdin.trim().slice(0, 20)}` } }), i * gap);
  setTimeout(() => { out({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }); process.exit(0); }, (n + 1) * gap);
});

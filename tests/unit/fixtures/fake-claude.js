#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`: a few text deltas, the result, and the
// process stays a moment longer (like the real CLI flushing its session) before exiting.
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const sid = 'claude-session-1';
  const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
  out({ type: 'system', subtype: 'init', model: 'claude-test', cwd: process.cwd() });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (const w of ['Привет, ', 'это ', 'Claude.']) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Привет, это Claude.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Привет, это Claude.', total_cost_usd: 0.001, duration_ms: 10, usage: { input_tokens: 5, output_tokens: 4 } });
  setTimeout(() => process.exit(0), Number(process.env.FAKE_LINGER || 800));
});

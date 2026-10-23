// Passing answers along an arrow with real CLI processes: Codex answers, Claude Code gets the answer
// as its next message and answers it.
import { test, expect } from './fixtures.mjs';

test('стрелка «Передавать ответ»: ответ Codex уходит в Claude Code', async ({ app }) => {
  const a = await app.add('agentchat', { x: 0, y: 0, w: 460, h: 460, data: { agentId: 'codex', kind: 'codex', title: 'План', messages: [] } });
  const b = await app.add('agentchat', { x: 540, y: 0, w: 460, h: 460, data: { agentId: 'claude', kind: 'claude', title: 'Проверка', messages: [] } });
  await app.page.evaluate(([a, b]) => window.__app.canvas.addEdge(a, b, { relay: { note: 'Проверь:' } }), [a, b]);
  await app.send(a, 'Составь план');
  await app.waitAnswer(a);
  await expect.poll(() => app.calls('claude').length, { timeout: 20_000 }).toBe(1);
  const call = app.calls('claude')[0];
  expect(call.prompt).toContain('Проверь:\n\nCodex: Составь план');
  const answer = await app.waitAnswer(b);
  expect(answer.content).toContain('Claude: Проверь:');
  const [user] = await app.messages(b);
  expect(user.relay).toMatchObject({ from: a, title: 'План', depth: 1 });
});

// A refusal (stop_reason "refusal"), possibly after some text streamed:
// the server's done says refused and returns no turns (finish-turn.ts); the
// browser replaces the partial text with a notice and keeps the question out
// of chatHistory, so the refused turn is never replayed (web/index.html §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finishEvents } from '../supabase/functions/chat/finish-turn.ts';
import { loadChat, sseStream, tick } from './helpers/chat-harness.mjs';

const userTurn = { role: 'user', content: [{ type: 'text', text: 'q' }] };
const turns = [{ role: 'assistant', content: [{ type: 'text', text: 'Partial answer that was decl' }] }];

test('server: a refusal ends with done.refused and no turns, even after text, a fallback or a tool round', () => {
  for (const o of [
    { newTurns: turns, sawText: true, stopReason: 'refusal', usedFallback: false, userTurn },
    { newTurns: turns, sawText: false, stopReason: 'refusal', usedFallback: true, userTurn },
  ]) {
    assert.deepEqual(finishEvents(o), [{ type: 'done', appended: [], refused: true, truncated: false, provider: 'claude', user_turn: null }]);
  }
  assert.equal(finishEvents({ newTurns: turns, sawText: true, stopReason: 'end_turn', usedFallback: false, userTurn }).at(-1).refused, undefined);
});

test('server: the refusal is logged by category only, before finishEvents', () => {
  const index = readFileSync(new URL('../supabase/functions/chat/index.ts', import.meta.url), 'utf8');
  assert.match(index, /if \(stopReason === "refusal"\) \{\s*\/\/ Category only, never content/);
  assert.match(index, /console\.error\("chat: model declined", \{ category: /);
});

const EXPORT = 'globalThis.__chat = { get history(){ return chatHistory; }, get msgs(){ return chatMsgs; }, ask, chatMsgHtml, CHAT_REFUSED };';

test('browser: partial text is replaced by the notice, and the refused question never enters history or the next request', async () => {
  let stream;
  const h = loadChat({ extra: EXPORT, invoke: async () => { stream = sseStream(); return { data: stream, error: null }; } });
  const chat = h.ctx.__chat;

  // A normal first answer, committed.
  const p1 = chat.ask('First question');
  await tick();
  stream.push({ type: 'text', text: 'First answer.' });
  stream.push({ type: 'done', appended: [{ role: 'assistant', content: 'First answer.' }], provider: 'claude' });
  stream.end(); await p1;
  const before = JSON.stringify(chat.history);
  assert.equal(chat.history.length, 2);

  // Second question: some text streams, then the server reports a refusal.
  const p2 = chat.ask('Second question');
  await tick();
  stream.push({ type: 'text', text: 'Here is how to do the thing you asked ab' });
  for (const e of finishEvents({ newTurns: turns, sawText: true, stopReason: 'refusal', usedFallback: false, userTurn })) stream.push(e);
  stream.end(); await p2;
  const m = chat.msgs.at(-1);
  assert.equal(m.state, 'refused');
  const html = chat.chatMsgHtml(m);
  assert.equal(html.includes('Here is how'), false, 'the partial text is not shown');
  assert.ok(html.includes(chat.CHAT_REFUSED));
  assert.equal(JSON.stringify(chat.history), before, 'history unchanged');

  // Third question: the request carries only the first exchange.
  const p3 = chat.ask('Third question');
  await tick();
  const sent = JSON.parse(JSON.stringify(h.calls.at(-1).opts.body.messages));
  assert.deepEqual(sent.map((t) => typeof t.content === 'string' ? t.content : 'blocks'), ['First question', 'First answer.', 'Third question']);
  stream.push({ type: 'done', appended: [{ role: 'assistant', content: 'Third answer.' }], provider: 'claude' });
  stream.end(); await p3;
});

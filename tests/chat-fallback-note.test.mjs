// The "answered via backup model" note after a Kimi -> Claude fallback is
// display only (supabase/functions/chat/finish-turn.ts). It used to be appended
// to the assistant turn Claude produced, so the next question replayed an
// edited, thinking-bearing turn -- a 400 on Sonnet 5.5 for enforced accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FALLBACK_NOTE, finishEvents } from '../supabase/functions/chat/finish-turn.ts';
import { loadChat, sseStream, tick } from './helpers/chat-harness.mjs';

// What Claude produced for one question: a tool round trip, then a final turn
// whose thinking block is signed over everything before it.
const produced = () => [
  { role: 'assistant', content: [
    { type: 'thinking', thinking: '', signature: 'sig-tool-turn' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_derived_series', input: { vintage: 2026 } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'rows' }] },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: '', signature: 'sig-final-turn' },
    { type: 'text', text: 'GDD is 2,268 as of September 8.' },
  ] },
];
const userTurn = { role: 'user', content: [{ type: 'text', text: 'How is GDD tracking?' }] };

test('fallback: the note is its own text event, and done.appended is exactly what Claude produced', () => {
  const newTurns = produced();
  const events = finishEvents({ newTurns, sawText: true, stopReason: 'end_turn', usedFallback: true, userTurn });
  assert.deepEqual(events.map((e) => e.type), ['text', 'done']);
  assert.equal(events[0].text, FALLBACK_NOTE);
  const done = events[1];
  assert.deepEqual(done.appended, produced());
  assert.equal(JSON.stringify(done.appended).includes('backup model'), false);
  assert.equal(done.provider, 'claude');
  assert.equal(done.user_turn, userTurn);
});

test('no fallback: no note; a turn with no text still gets the honest message, before done', () => {
  assert.deepEqual(finishEvents({ newTurns: produced(), sawText: true, stopReason: 'end_turn', usedFallback: false, userTurn }).map((e) => e.type), ['done']);
  const cut = finishEvents({ newTurns: produced(), sawText: false, stopReason: 'max_tokens', usedFallback: true, userTurn });
  assert.deepEqual(cut.map((e) => e.type), ['text', 'text', 'done']);
  assert.match(cut[0].text, /needed more room/);
  assert.equal(cut[1].text, FALLBACK_NOTE);
  assert.equal(cut[2].truncated, true);
});

test('chat/index.ts sends finishEvents and never edits a produced turn for the note', () => {
  const index = readFileSync(new URL('../supabase/functions/chat/index.ts', import.meta.url), 'utf8');
  assert.match(index, /for \(const e of finishEvents\(\{ newTurns, sawText, stopReason, usedFallback, userTurn \}\)\) send\(e\);/);
  assert.equal(/last\.content = \[\.\.\.last\.content/.test(index), false);
  assert.equal(index.includes('backup model due to'), false, 'the note text lives only in finish-turn.ts');
});

const EXPORT = 'globalThis.__chat = { get history(){ return chatHistory; }, get msgs(){ return chatMsgs; }, ask };';

test('the follow-up question after a fallback replays turn 1 byte-for-byte; the note stays on screen only', async () => {
  let stream;
  const h = loadChat({ extra: EXPORT, invoke: async () => { stream = sseStream(); return { data: stream, error: null }; } });
  const chat = h.ctx.__chat;

  // Turn 1: Kimi failed, Claude answered; the server's real event sequence.
  const p1 = chat.ask('How is GDD tracking?');
  await tick();
  stream.push({ type: 'text', text: 'GDD is 2,268 as of September 8.' });
  for (const e of finishEvents({ newTurns: produced(), sawText: true, stopReason: 'end_turn', usedFallback: true, userTurn })) stream.push(e);
  stream.end();
  await p1;
  assert.match(chat.msgs.at(-1).text, /answered via backup model/);

  // Turn 2: what the browser sends must hold turn 1 exactly as produced.
  const p2 = chat.ask('And versus 2025?');
  await tick();
  const sent = h.calls.at(-1).opts.body.messages;
  assert.deepEqual(JSON.parse(JSON.stringify(sent.slice(0, 4))), [userTurn, ...produced()]);
  assert.equal(JSON.stringify(sent).includes('backup model'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { role: 'user', content: 'And versus 2025?' });
  stream.push({ type: 'done', appended: [{ role: 'assistant', content: 'Ahead.' }], provider: 'claude' });
  stream.end();
  await p2;
});

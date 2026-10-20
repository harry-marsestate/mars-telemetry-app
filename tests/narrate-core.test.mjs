// Batched insight narration (supabase/functions/insights-scan/narrate-core.ts):
// batching, split-and-retry on a cut-off or malformed JSON, per-row
// validation, the banned-words check and guarded writes, with a scripted
// model and a recording writer. docs/SECURITY.md, "Insight narration outage".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANNED_DIRECTIONAL_WORDS, BATCH_SIZE, MAX_TOKENS, narrateRows, PROVENANCE_WORDS, SYSTEM_PROMPT, bannedWord, provenanceWord, unsupportedYear } from '../supabase/functions/insights-scan/narrate-core.ts';

const rows = (n, label = 'reproduced') => Array.from({ length: n }, (_, i) => ({ id: 100 + i, tier: 'A', metric_a: 'air_temp', metric_b: 'soil_moisture',
  effect: -0.78, n_observations: 852, lag_days: 2, scope_kind: 'estate', scope_block_id: null, scope_vintages: [2022, 2023, 2024, 2025],
  vintages_agreeing: 4, vintages_tested: 4, confidence_label: label, status: 'surfaced', narration: null, run_id: 'r' }));
const ok = (input, f = (r) => ({ id: r.id, keep: true, narration: `Narration for ${r.id}.` })) =>
  ({ text: JSON.stringify(input.map(f)), stopReason: 'end_turn', outputTokens: 300, thinkingTokens: 100 });

// model: (input, callIndex) => CallResult. Records every call's ids.
function harness(model, writeImpl) {
  const calls = [], writes = [], logs = [];
  const call = async (input) => { calls.push(input.map((r) => r.id)); return model(input, calls.length - 1); };
  const write = async (id, values) => { writes.push({ id, values }); return writeImpl ? writeImpl(id, values) : { ok: true, matched: true }; };
  const log = { info: (m, d) => logs.push(['info', m, d]), error: (m, d) => logs.push(['error', m, d]) };
  return { calls, writes, logs, run: (rs) => narrateRows(rs, call, write, { model: 'claude-sonnet-5-5', now: () => '2026-10-19T00:00:00Z', log }) };
}

test('20 rows -> 4 calls of 5, oldest first, every row written once', async () => {
  const h = harness((input) => ok(input));
  const out = await h.run(rows(20));
  assert.equal(BATCH_SIZE, 5);
  assert.deepEqual(h.calls.map((c) => c.length), [5, 5, 5, 5]);
  assert.deepEqual(h.calls.flat(), rows(20).map((r) => r.id));
  assert.equal(out.written.length, 20); assert.equal(out.calls, 4); assert.equal(out.splits, 0);
  assert.deepEqual(h.writes[0].values, { narration: 'Narration for 100.', narration_model: 'claude-sonnet-5-5', narrated_at: '2026-10-19T00:00:00Z' });
  // Token counts are logged per call, counts only.
  const callLogs = h.logs.filter(([, m]) => m === 'call');
  assert.equal(callLogs.length, 4);
  assert.deepEqual(Object.keys(callLogs[0][2]).sort(), ['ids', 'max_tokens', 'output_tokens', 'rows', 'stop_reason', 'thinking_tokens']);
  assert.equal(callLogs[0][2].max_tokens, MAX_TOKENS);
});

test('max_tokens stop: the batch is split in half and retried; nothing from the cut-off call is written', async () => {
  const h = harness((input, i) => i === 0
    ? { text: '[{"id":100,"keep":true,"narration":"half', stopReason: 'max_tokens', outputTokens: 2048, thinkingTokens: 1900 }
    : ok(input));
  const out = await h.run(rows(5));
  assert.deepEqual(h.calls, [[100, 101, 102, 103, 104], [100, 101, 102], [103, 104]]);
  assert.equal(out.splits, 1);
  assert.deepEqual(out.written, [100, 101, 102, 103, 104]);
  assert.equal(h.writes.length, 5);
});

test('even a parseable max_tokens response is treated as cut off', async () => {
  const h = harness((input, i) => i === 0 ? { ...ok(input), stopReason: 'max_tokens' } : ok(input));
  const out = await h.run(rows(2));
  assert.deepEqual(h.calls, [[100, 101], [100], [101]]);
  assert.equal(out.written.length, 2);
});

test('malformed JSON: split down to single rows; a row that still fails is logged and skipped, the rest are written', async () => {
  // Row 102 always breaks the JSON it is part of.
  const h = harness((input) => input.some((r) => r.id === 102) ? { text: '[{"id": 102, "keep": tru', stopReason: 'end_turn', outputTokens: 50, thinkingTokens: 0 } : ok(input));
  const out = await h.run(rows(5));
  assert.deepEqual(h.calls, [[100, 101, 102, 103, 104], [100, 101, 102], [100, 101], [102], [103, 104]]); // depth-first
  assert.deepEqual(out.written.sort(), [100, 101, 103, 104]);
  assert.deepEqual(out.failed, [{ id: 102, reason: 'unparseable', stop_reason: 'end_turn' }]);
  assert.equal(h.writes.some((w) => w.id === 102), false);
  const err = h.logs.find(([k, m]) => k === 'error' && m === 'row left un-narrated');
  assert.deepEqual(err[2], { id: 102, reason: 'unparseable', stop_reason: 'end_turn' });
});

test('a single bad row is skipped without blocking the other batches', async () => {
  const h = harness((input) => input.length === 1 && input[0].id === 107
    ? { text: 'not json', stopReason: 'end_turn', outputTokens: 5, thinkingTokens: 0 }
    : input.some((r) => r.id === 107) ? { text: 'oops', stopReason: 'end_turn', outputTokens: 5, thinkingTokens: 0 } : ok(input));
  const out = await h.run(rows(12));
  assert.deepEqual(out.failed.map((f) => f.id), [107]);
  assert.equal(out.written.length, 11);
  assert.deepEqual(h.calls.slice(-1), [[110, 111]], 'the last batch still ran');
});

test('keep:true with an empty or whitespace narration is retried alone, then left un-narrated', async () => {
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: true, narration: r.id === 101 ? '   ' : `N ${r.id}` })));
  const out = await h.run(rows(3));
  assert.deepEqual(h.calls, [[100, 101, 102], [101]]);
  assert.deepEqual(out.written, [100, 102]);
  assert.deepEqual(out.failed, [{ id: 101, reason: 'invalid_verdict', stop_reason: 'end_turn' }]);
  assert.equal(h.writes.some((w) => w.id === 101), false);
});

test('missing and duplicated verdicts are retried; ids not in the batch are ignored, never written', async () => {
  let first = true;
  const h = harness((input) => {
    if (first) { first = false; return { text: JSON.stringify([{ id: 100, keep: true, narration: 'a' }, { id: 101, keep: true, narration: 'b' }, { id: 101, keep: false, narration: '' }, { id: 999, keep: true, narration: 'x' }]), stopReason: 'end_turn', outputTokens: 9, thinkingTokens: 0 }; }
    return ok(input);
  });
  const out = await h.run(rows(3));
  assert.deepEqual(h.calls, [[100, 101, 102], [101], [102]]);
  assert.deepEqual(out.written.sort(), [100, 101, 102]);
  assert.equal(h.writes.some((w) => w.id === 999), false);
});

test('a veto writes status below_threshold and the reason, like before', async () => {
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: false, narration: '' })));
  await h.run(rows(1));
  assert.deepEqual(h.writes[0].values, { status: 'below_threshold', rejection_reason: 'narration model vetoed: no plausible mechanism', narration_model: 'claude-sonnet-5-5', narrated_at: '2026-10-19T00:00:00Z' });
});

test('banned word in a directional_only narration: retried once alone, then logged with the word (not the text)', async () => {
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: true, narration: r.id === 100 ? 'Yield rose because irrigation rose, on five points.' : `Five points, watch ${r.id}.` })));
  const out = await h.run(rows(2, 'directional_only'));
  assert.deepEqual(h.calls, [[100, 101], [100]]);
  assert.deepEqual(out.written, [101]);
  assert.deepEqual(out.failed, [{ id: 100, reason: 'banned_word', stop_reason: 'end_turn', word: 'because' }]);
  const err = h.logs.find(([k, m]) => k === 'error' && m === 'row left un-narrated');
  assert.equal(JSON.stringify(err).includes('irrigation rose'), false);
});

test('banned word fixed on the retry is written; the same word in a reproduced row is allowed', async () => {
  let n = 0;
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: true, narration: n++ === 0 ? 'Significant on five points.' : 'Five points: one to watch.' })));
  const out = await h.run(rows(1, 'directional_only'));
  assert.deepEqual(out.written, [100]);
  assert.equal(h.writes[0].values.narration, 'Five points: one to watch.');
  const r2 = harness((input) => ok(input, () => ({ id: 100, keep: true, narration: 'A significant, consistent pattern.' })));
  assert.deepEqual((await r2.run(rows(1))).written, [100]);
});

test('bannedWord matches whole words, any case, only from the shared list', () => {
  assert.equal(bannedWord('It DRIVES ripening'), 'drives');
  assert.equal(bannedWord('a correlation, insignificant'), null);
  assert.equal(bannedWord('driver and becauses'), null);
});

test('the prompt bans exactly the shared word list', () => {
  assert.deepEqual(BANNED_DIRECTIONAL_WORDS, ['correlated', 'significant', 'predicts', 'drives', 'because']);
  assert.ok(SYSTEM_PROMPT.includes('never use "correlated," "significant," "predicts," "drives," or "because." Frame it as something to watch'));
  const src = readFileSync(new URL('../supabase/functions/insights-scan/narrate-core.ts', import.meta.url), 'utf8');
  assert.equal((src.match(/"correlated,"/g) ?? []).length, 0, 'the prompt builds the list from the constant, never a second copy');
});

test('guarded writes: a row narrated elsewhere is skipped; a failed update is a failure, not a success', async () => {
  const h = harness((input) => ok(input), async (id) => id === 100 ? { ok: true, matched: false } : id === 101 ? { ok: false, error: 'boom' } : { ok: true, matched: true });
  const out = await h.run(rows(3));
  assert.deepEqual(out.skipped, [100]);
  assert.deepEqual(out.failed, [{ id: 101, reason: 'write_error' }]);
  assert.deepEqual(out.written, [102]);
});

test('an API error fails that batch only; later batches still run', async () => {
  const h = harness((input, i) => { if (i === 0) throw new Error('529 overloaded'); return ok(input); });
  const out = await h.run(rows(7));
  assert.deepEqual(out.failed.map((f) => f.id), [100, 101, 102, 103, 104]);
  assert.deepEqual(out.written, [105, 106]);
});

test('narrate.ts guards every update on status and narrated_at; index.ts reports rows written', () => {
  const narrate = readFileSync(new URL('../supabase/functions/insights-scan/narrate.ts', import.meta.url), 'utf8');
  assert.match(narrate, /\.eq\("id", id\)\.eq\("status", "surfaced"\)\.is\("narrated_at", null\)\.select\("id"\)/);
  const index = readFileSync(new URL('../supabase/functions/insights-scan/index.ts', import.meta.url), 'utf8');
  assert.match(index, /narrated_this_run: narration\?\.written\.length \?\? 0/);
  assert.match(index, /narration_failed: narration\?\.failed\.length/);
  assert.match(index, /narration_skipped: narration\?\.skipped\.length/);
});

// ── content checks added 2026-10-19: years and provenance ─────────────────
test('a year the row does not contain: retried once alone, then logged with the year (not the text)', async () => {
  const yieldRows = rows(2, 'directional_only').map((r) => ({ ...r, scope_vintages: [2023, 2024], vintages_agreeing: null, vintages_tested: null }));
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: true, narration: r.id === 100 ? 'Five points from 2023 and 2024; check again in 2025.' : 'Five points from 2023 and 2024, one to watch.' })));
  const out = await h.run(yieldRows);
  assert.deepEqual(h.calls, [[100, 101], [100]]);
  assert.deepEqual(out.written, [101]);
  assert.deepEqual(out.failed, [{ id: 100, reason: 'unsupported_year', stop_reason: 'end_turn', year: '2025' }]);
  const err = h.logs.find(([k, m]) => k === 'error' && m === 'row left un-narrated');
  assert.equal(JSON.stringify(err).includes('check again'), false);
});

test('a year fixed on the retry is written; years in the input (a 2022-2025 range) pass', async () => {
  let n = 0;
  const h = harness((input) => ok(input, () => ({ id: 100, keep: true, narration: n++ === 0 ? 'Held since 2019.' : 'Held in all four seasons, 2022-2025.' })));
  const out = await h.run(rows(1));
  assert.deepEqual(h.calls, [[100], [100]]);
  assert.deepEqual(out.written, [100]);
  assert.equal(h.writes[0].values.narration, 'Held in all four seasons, 2022-2025.');
});

test('unsupportedYear: only 19xx/20xx tokens, matched against numbers sent for the row', () => {
  const input = { id: 7, effect: -0.78, n_observations: 852, scope_vintages: [2022, 2025], vintages_tested: 4 };
  assert.equal(unsupportedYear('From 2022 to 2025, 852 observations.', input), null);
  assert.equal(unsupportedYear('Since 2023.', input), '2023');
  assert.equal(unsupportedYear('About 1999 and 20254 units.', input), '1999');
  assert.equal(unsupportedYear('effect 0.78 over 852 days', input), null);
});

test('a provenance word in any kept narration: retried once alone, then logged with the word', async () => {
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: true, narration: r.id === 100 ? 'Check the soil moisture probes two days later.' : 'Modelled estate soil moisture ran lower.' })));
  const out = await h.run(rows(2));
  assert.deepEqual(h.calls, [[100, 101], [100]]);
  assert.deepEqual(out.written, [101]);
  assert.deepEqual(out.failed, [{ id: 100, reason: 'provenance_word', stop_reason: 'end_turn', word: 'probe' }]);
});

test('a provenance word fixed on the retry is written; vetoes are never checked', async () => {
  let n = 0;
  const h = harness((input) => ok(input, (r) => r.id === 101 ? { id: 101, keep: false, narration: 'A sensor identity, no mechanism.' }
    : { id: 100, keep: true, narration: n++ === 0 ? 'The on-site Weather Station shows it.' : 'Modelled estate data shows it.' }));
  const out = await h.run(rows(2));
  assert.deepEqual(h.calls, [[100, 101], [100]]);
  assert.deepEqual(out.written.sort(), [100, 101]);
  assert.equal(h.writes.find((w) => w.id === 101).values.status, 'below_threshold');
});

test('provenanceWord: case-insensitive, plurals, the shared list', () => {
  assert.deepEqual(PROVENANCE_WORDS, ['probe', 'sensor', 'weather station']);
  assert.equal(provenanceWord('SENSORS on the block'), 'sensor');
  assert.equal(provenanceWord('soil probes'), 'probe');
  assert.equal(provenanceWord('a Weather Station'), 'weather station');
  assert.equal(provenanceWord('modelled ECMWF and ERA5-Land data; sensible timing'), null);
});

test('the prompt carries the provenance sentence', () => {
  assert.ok(SYSTEM_PROMPT.includes('Climate and soil inputs are modelled estate-wide data (ECMWF weather, ERA5-Land soil), not on-site sensors, so never describe them as probes, sensors, stations or measurements taken at the estate.'));
});

// ── first-attempt reasons are logged (2026-10-19) ─────────────────────────
test('the first reason is logged when a row is retried alone or a batch is split', async () => {
  const h = harness((input, i) => i === 0
    ? { text: '[{"id":100,"keep":true,"narration":"a"}', stopReason: 'max_tokens', outputTokens: 2048, thinkingTokens: 1 }
    : input.length === 1 && input[0].id === 102 && i === 2 ? ok(input, () => ({ id: 102, keep: true, narration: 'probe readings' }))
    : ok(input));
  await h.run(rows(3));
  const info = h.logs.filter(([k]) => k === 'info').map(([, m, d]) => [m, d]);
  assert.deepEqual(info.find(([m]) => m === 'splitting batch')[1], { ids: [100, 101, 102], reason: 'max_tokens', stop_reason: 'max_tokens' });
  const alone = info.filter(([m]) => m === 'retrying row alone').map(([, d]) => d);
  assert.deepEqual(alone[0], { id: 102, reason: 'provenance_word', stop_reason: 'end_turn', word: 'probe' });
});

test('an invalid verdict retried alone logs why before the retry', async () => {
  const h = harness((input) => ok(input, (r) => ({ id: r.id, keep: true, narration: r.id === 101 && input.length > 1 ? '' : `N ${r.id}` })));
  await h.run(rows(3));
  const d = h.logs.find(([k, m]) => k === 'info' && m === 'retrying row alone')[2];
  assert.deepEqual(d, { id: 101, reason: 'invalid_verdict', stop_reason: 'end_turn' });
});

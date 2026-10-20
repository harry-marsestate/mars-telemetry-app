// The weekly scan saves a run only when its findings differ from the latest
// stored run (supabase/functions/insights-scan/fingerprint.ts, index.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findingKey, sameFindings } from '../supabase/functions/insights-scan/fingerprint.ts';

// What the scan builds in memory (no ids, undefined for unset fields).
const built = () => [
  { run_id: 'new', tier: 'A', metric_a: 'air_temp', metric_b: 'soil_moisture', status: 'surfaced', rejection_reason: null, scope_kind: 'estate',
    scope_vintages: [2023, 2022, 2025, 2024], method: 'spearman_lag', effect: -0.7757922281644074, lag_days: 2, n_observations: 852,
    vintages_agreeing: 4, vintages_tested: 4, confidence_label: 'reproduced', p_value: 1.2e-40, p_adjusted: 3.4e-39 },
  { run_id: 'new', tier: 'A', metric_a: 'humidity', metric_b: 'solar', status: 'excluded_low_n', rejection_reason: 'no vintage has real data for both metrics',
    scope_kind: 'estate', scope_vintages: [], method: 'spearman_lag', effect: 0, n_observations: 0, confidence_label: 'directional_only' },
  { run_id: 'new', tier: 'B', metric_a: 'harvest_yield_tons', metric_b: 'irrigation_volume', status: 'surfaced', rejection_reason: null, scope_kind: 'block',
    scope_vintages: [2023, 2024], method: 'rank_concordance', effect: 0.8, n_observations: 5, confidence_label: 'directional_only' },
];
// The same findings as stored by an earlier run: ids, nulls, a different
// vintage order, narration fields, and the air_temp row vetoed by narration.
const stored = () => [
  { id: 505, run_id: 'old', computed_at: '2026-10-18T15:00:15Z', tab: 'vineyard', tier: 'A', metric_a: 'air_temp', metric_b: 'soil_moisture',
    status: 'below_threshold', rejection_reason: 'narration model vetoed: no plausible mechanism', narration: null, narration_model: 'claude-sonnet-5-5',
    narrated_at: '2026-10-19T00:00:00Z', scope_kind: 'estate', scope_block_id: null, scope_vintages: [2022, 2023, 2024, 2025], method: 'spearman_lag',
    effect: -0.7757922281644074, lag_days: 2, n_observations: 852, vintages_agreeing: 4, vintages_tested: 4, confidence_label: 'reproduced',
    p_value: 1.2e-40, p_adjusted: 3.4e-39, date_range_start: null, date_range_end: null },
  { id: 530, run_id: 'old', tier: 'A', metric_a: 'humidity', metric_b: 'solar', status: 'excluded_low_n', rejection_reason: 'no vintage has real data for both metrics',
    narration_model: null, scope_kind: 'estate', scope_block_id: null, scope_vintages: [], method: 'spearman_lag', effect: 0, lag_days: null,
    n_observations: 0, vintages_agreeing: null, vintages_tested: null, confidence_label: 'directional_only', p_value: null, p_adjusted: null },
  { id: 560, run_id: 'old', tier: 'B', metric_a: 'harvest_yield_tons', metric_b: 'irrigation_volume', status: 'surfaced', rejection_reason: null,
    narration: 'Five points...', narration_model: 'claude-sonnet-5-5', scope_kind: 'block', scope_block_id: null, scope_vintages: [2023, 2024],
    method: 'rank_concordance', effect: 0.8, lag_days: null, n_observations: 5, vintages_agreeing: null, vintages_tested: null,
    confidence_label: 'directional_only', p_value: null, p_adjusted: null },
];

test('the same findings as stored (nulls, ids, vintage order, narration, a veto) are unchanged', () => {
  assert.equal(sameFindings(built(), stored()), true);
  assert.equal(sameFindings(built().reverse(), stored()), true, 'row order does not matter');
});

test('any computed change makes it a new run', () => {
  const change = (f) => { const b = built(); f(b); return sameFindings(b, stored()); };
  assert.equal(change((b) => { b[0].effect = -0.7757922; }), false, 'effect');
  assert.equal(change((b) => { b[0].lag_days = 3; }), false, 'lag');
  assert.equal(change((b) => { b[0].n_observations = 860; }), false, 'sample size');
  assert.equal(change((b) => { b[0].scope_vintages = [2022, 2023, 2024, 2025, 2026]; }), false, 'a new vintage');
  assert.equal(change((b) => { b[0].confidence_label = 'single_season'; }), false, 'confidence');
  assert.equal(change((b) => { b[2].status = 'below_threshold'; }), false, 'surfaced -> below threshold');
  assert.equal(change((b) => { b[1].status = 'below_threshold'; b[1].effect = 0.4; }), false, 'a pair that now has data');
  assert.equal(change((b) => { b.pop(); }), false, 'row count');
  assert.equal(change((b) => { b[0].p_adjusted = 0.2; }), false, 'p_adjusted');
});

test('a below_threshold row the scan itself rejected is not mistaken for a veto', () => {
  const s = stored(); s[0].narration_model = null; // scan-rejected, never narrated
  assert.equal(sameFindings(built(), s), false);
});

test('the key never includes ids, run ids, timestamps or narration text', () => {
  const k = findingKey(stored()[0]);
  for (const v of ['505', 'old', '2026-10-18', '2026-10-19', 'narration model vetoed', 'claude-sonnet']) assert.equal(k.includes(v), false, v);
});

test('index.ts reads the latest run, skips the insert when unchanged, and still narrates', () => {
  const index = readFileSync(new URL('../supabase/functions/insights-scan/index.ts', import.meta.url), 'utf8');
  const skip = index.indexOf('if (unchangedSince) {'), insert = index.indexOf('.from("insights").insert(rows)'), narrate = index.indexOf('narrateFindings(ctx.supabaseAdmin');
  assert.ok(skip > 0 && insert > skip && narrate > insert, 'insert only in the changed branch, narration after both');
  assert.match(index, /else if \(sameFindings\(rows, prevRows \?\? \[\]\)\) unchangedSince = latest;/);
  assert.match(index, /unchanged_since_run: unchangedSince\?\.run_id \?\? null/);
});

// ── real data: the 2026-10-18 stored run vs the scan without the five derived
// metrics (fixture: computed fields only, no narration text) ──────────────
const RAW = new Set(['air_temp', 'humidity', 'precipitation', 'soil_moisture', 'soil_temp', 'solar']);
const stored56 = () => JSON.parse(readFileSync(new URL('./fixtures/insights-run-2026-10-18.json', import.meta.url), 'utf8'));
// What the scan now builds: the raw-metric pairs plus Tier B, as built in
// memory (a vetoed row is surfaced again; no narration fields).
const built16 = () => stored56()
  .filter((r) => r.tier === 'B' || (RAW.has(r.metric_a) && RAW.has(r.metric_b)))
  .map(({ narration_model, ...r }) => ({ ...r, status: r.status === 'below_threshold' && narration_model ? 'surfaced' : r.status }));

test('the stored 56-row run vs the new 16-row run: unchanged, because every dropped row carries no result', () => {
  const s = stored56(), b = built16();
  assert.equal(s.length, 56); assert.equal(b.length, 16);
  const dropped = s.filter((r) => !(r.tier === 'B' || (RAW.has(r.metric_a) && RAW.has(r.metric_b))));
  assert.equal(dropped.length, 40);
  assert.ok(dropped.every((r) => r.status === 'excluded_low_n' || r.status === 'excluded_derived'));
  assert.equal(b.filter((r) => r.status === 'surfaced').length, 5);
  assert.equal(sameFindings(b, s), true);
});

test('a pair gaining data still counts as a change', () => {
  const b = built16();
  b.push({ tier: 'A', metric_a: 'gdd_day', metric_b: 'soil_temp', status: 'below_threshold', scope_kind: 'estate', scope_vintages: [2022, 2023, 2024, 2025],
    method: 'spearman_lag', effect: 0.959, lag_days: 1, n_observations: 857, vintages_agreeing: 4, vintages_tested: 4, confidence_label: 'reproduced', p_value: 1e-9, p_adjusted: 1e-8 });
  assert.equal(sameFindings(b, stored56()), false);
  // ...and the other way: a stored no-data row whose pair is now tested.
  const s = stored56(); const i = s.findIndex((r) => r.metric_a === 'air_temp' && r.metric_b === 'soil_temp');
  s[i] = { ...s[i], status: 'excluded_low_n' };
  assert.equal(sameFindings(built16(), s), false);
});

test('a changed effect on a tested pair still counts as a change', () => {
  const b = built16(); const r = b.find((x) => x.metric_a === 'air_temp' && x.metric_b === 'soil_moisture');
  r.effect = r.effect + 0.001;
  assert.equal(sameFindings(b, stored56()), false);
});

// Pairs computed from a shared input are excluded from the insights scan
// (supabase/functions/insights-scan/derivation.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { derivationExclusion, inputsOf } from '../supabase/functions/insights-scan/derivation.ts';

// metric_derivation as it is in production (2026-10-19).
const ROWS = [
  { metric_key: 'dtr', derived_from: 'air_temp' }, { metric_key: 'et0_in', derived_from: 'air_temp' },
  { metric_key: 'gdd_day', derived_from: 'air_temp' },
  { metric_key: 'vpd_kpa', derived_from: 'air_temp' }, { metric_key: 'vpd_kpa', derived_from: 'humidity' },
  { metric_key: 'vpd_peak_kpa', derived_from: 'air_temp' }, { metric_key: 'vpd_peak_kpa', derived_from: 'humidity' },
];
const TIER_A = ['air_temp', 'humidity', 'precipitation', 'soil_moisture', 'soil_temp', 'solar', 'gdd_day', 'dtr', 'vpd_kpa', 'vpd_peak_kpa', 'et0_in'];
const ex = (a, b) => derivationExclusion(a, b, ROWS);

test('derived vs its own input: direct (the original rule)', () => {
  assert.deepEqual(ex('air_temp', 'dtr'), { kind: 'direct', input: 'air_temp' });
  assert.deepEqual(ex('vpd_kpa', 'humidity'), { kind: 'direct', input: 'humidity' });
  assert.deepEqual(ex('humidity', 'vpd_peak_kpa'), { kind: 'direct', input: 'humidity' });
});

test('derived vs derived with a shared input: excluded', () => {
  for (const [a, b] of [['vpd_kpa', 'vpd_peak_kpa'], ['et0_in', 'dtr'], ['gdd_day', 'dtr'], ['gdd_day', 'et0_in'], ['et0_in', 'vpd_peak_kpa'], ['gdd_day', 'vpd_peak_kpa'], ['dtr', 'vpd_kpa']]) {
    assert.equal(ex(a, b)?.kind, 'shared', `${a} ~ ${b}`);
    assert.equal(ex(b, a)?.kind, 'shared', `${b} ~ ${a}`);
  }
  assert.deepEqual(ex('vpd_kpa', 'vpd_peak_kpa'), { kind: 'shared', input: 'air_temp' });
});

test('pairs without a shared input are still tested', () => {
  for (const [a, b] of [['gdd_day', 'soil_temp'], ['air_temp', 'soil_temp'], ['air_temp', 'humidity'], ['et0_in', 'soil_moisture'], ['vpd_kpa', 'solar'], ['soil_moisture', 'precipitation']]) {
    assert.equal(ex(a, b), null, `${a} ~ ${b}`);
  }
});

test('exactly which Tier A pairs the rule excludes', () => {
  const excluded = [];
  for (let i = 0; i < TIER_A.length; i++) for (let j = i + 1; j < TIER_A.length; j++) {
    const [a, b] = [TIER_A[i], TIER_A[j]].sort();
    if (ex(a, b)) excluded.push(`${a}~${b}`);
  }
  assert.deepEqual(excluded.sort(), [
    'air_temp~dtr', 'air_temp~et0_in', 'air_temp~gdd_day', 'air_temp~vpd_kpa', 'air_temp~vpd_peak_kpa',
    'dtr~et0_in', 'dtr~gdd_day', 'dtr~vpd_kpa', 'dtr~vpd_peak_kpa',
    'et0_in~gdd_day', 'et0_in~vpd_kpa', 'et0_in~vpd_peak_kpa',
    'gdd_day~vpd_kpa', 'gdd_day~vpd_peak_kpa',
    'humidity~vpd_kpa', 'humidity~vpd_peak_kpa', 'vpd_kpa~vpd_peak_kpa',
  ]);
});

test('inputsOf includes the metric itself; raw metrics have only themselves', () => {
  assert.deepEqual([...inputsOf('vpd_kpa', ROWS)].sort(), ['air_temp', 'humidity', 'vpd_kpa']);
  assert.deepEqual([...inputsOf('soil_temp', ROWS)], ['soil_temp']);
});

test('index.ts uses the shared-input rule for every Tier A pair', () => {
  const index = readFileSync(new URL('../supabase/functions/insights-scan/index.ts', import.meta.url), 'utf8');
  assert.match(index, /const excl = derivationExclusion\(a, b, derivationRows\);/);
  assert.equal(index.includes('isDerived'), false);
});

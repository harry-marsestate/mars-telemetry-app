// Is this run's set of findings the same as a stored run's? Used to skip
// saving a weekly run that would only duplicate the latest one (docs/
// SECURITY.md, "Weekly insight runs saved only when findings change"). The
// scan's inputs are closed vintages, so until new real data arrives every
// run produced the same 56 rows and re-narrated the same 5.

type Row = Record<string, unknown>;

const num = (x: unknown, digits: number) => typeof x === "number" ? Number(x.toPrecision(digits)) : x ?? null;

// The status the scan assigned, before narration: a veto turns a surfaced row
// into below_threshold and stamps narration_model, which the scan never does.
function scanStatus(r: Row): unknown {
  return r.status === "below_threshold" && r.narration_model != null ? "surfaced" : r.status;
}

// Everything the scan computes for one finding; never ids, run ids,
// timestamps, narration or rejection text.
export function findingKey(r: Row): string {
  return JSON.stringify([
    r.tier, r.metric_a, r.metric_b, scanStatus(r), r.scope_kind ?? null, r.scope_block_id ?? null,
    Array.isArray(r.scope_vintages) ? [...r.scope_vintages].sort() : r.scope_vintages ?? null,
    r.method ?? null, num(r.effect, 10), r.lag_days ?? null, r.n_observations ?? null,
    r.vintages_agreeing ?? null, r.vintages_tested ?? null, r.confidence_label ?? null,
    num(r.p_value, 8), num(r.p_adjusted, 8),
  ]);
}

// Only rows with a tested result count: surfaced and below_threshold (a
// narration veto is stored as below_threshold). excluded_low_n (no data, or
// too little to test) and excluded_derived (never tested) carry no result, so
// adding or dropping them -- e.g. when the scanned metric list changes --
// does not by itself make a new run. A pair that gains data moves to
// below_threshold or surfaced and so does count.
export function hasResult(r: Row): boolean {
  return r.status === "surfaced" || r.status === "below_threshold";
}

export function sameFindings(a: Row[], b: Row[]): boolean {
  const ka = a.filter(hasResult).map(findingKey).sort(), kb = b.filter(hasResult).map(findingKey).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

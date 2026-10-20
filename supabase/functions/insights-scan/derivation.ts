// Which metric pairs the scan must not test because their values are computed
// from the same inputs (metric_derivation). Correlating two such metrics
// mostly measures the shared formula, not anything in the vineyard: VPD and
// peak VPD are both Tetens on air temperature and humidity; ET0 (Hargreaves),
// DTR and daily GDD are all functions of air temperature alone.

export interface DerivationRow { metric_key: string; derived_from: string }

// A metric's inputs: itself plus every input metric_derivation declares.
export function inputsOf(metric: string, rows: DerivationRow[]): Set<string> {
  const s = new Set([metric]);
  for (const r of rows) if (r.metric_key === metric) s.add(r.derived_from);
  return s;
}

// null when the pair may be tested; otherwise why not. "direct" is the
// original rule (one metric is declared as computed from the other);
// "shared" covers two metrics computed from a common input.
export function derivationExclusion(a: string, b: string, rows: DerivationRow[]):
  { kind: "direct" | "shared"; input: string } | null {
  const ia = inputsOf(a, rows), ib = inputsOf(b, rows);
  if (ia.has(b)) return { kind: "direct", input: b };
  if (ib.has(a)) return { kind: "direct", input: a };
  for (const x of [...ia].sort()) if (ib.has(x)) return { kind: "shared", input: x };
  return null;
}

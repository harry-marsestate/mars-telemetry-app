// Insight narration, batched (docs/SECURITY.md, "Insight narration outage").
// No imports: the model call and the database write are passed in
// (narrate.ts), so the batching, split-and-retry and validation rules are
// testable on their own (tests/narrate-core.test.mjs).

// The words the prompt forbids in a directional_only narration. One list for
// the prompt below and the code check, so the two cannot drift.
export const BANNED_DIRECTIONAL_WORDS = ["correlated", "significant", "predicts", "drives", "because"];
// Words that would present modelled estate-wide climate/soil data as on-site
// measurements. Checked in every kept narration (the prompt says the same).
export const PROVENANCE_WORDS = ["probe", "sensor", "weather station"];
const bannedPhrase = BANNED_DIRECTIONAL_WORDS.slice(0, -1).map((w) => `"${w},"`).join(" ")
  + ` or "${BANNED_DIRECTIONAL_WORDS[BANNED_DIRECTIONAL_WORDS.length - 1]}."`;

export const SYSTEM_PROMPT = `You are a viticulture and enology analyst for Mars Estate, a 7.35-acre Cabernet-dominant estate at 1,600-1,750 ft on Howell Mountain, Napa Valley.

You will be given already-computed statistical findings as structured rows. Each row contains the two metrics, the measured effect size, the real sample size, the scope, and a confidence label. These numbers are final. Never recompute, re-rank, adjust, or introduce any figure not present in the row you were given. You have no access to underlying data and must not imply otherwise.

For each finding, do two things:

1. Judge whether it is worth surfacing. Reject it if the relationship is a restatement of a definition, a well-known meteorological identity, or has no plausible mechanism connecting the two quantities in a vineyard. Rejecting is the expected outcome for a meaningful share of findings -- say so plainly rather than manufacturing a rationale. A statistically strong finding with no credible mechanism is a false positive, not an insight.

2. If kept, write two to three sentences for one of these readers:
- A viticulturist, who cares what this changes about a decision they actually make: irrigation set timing and volume, canopy and leafing work, when to start berry sampling, which block to walk first in a heat event.
- A winemaker, who cares what it implies for fruit arriving at the crushpad and for cellar decisions: expected ripeness trajectory, acid retention, pick-window pressure, likely ferment behavior.
- A wine collector, who cares what makes a given vintage or block distinctive: how a season's conditions shaped a wine's character, why one block differs from another, what makes a bottling worth holding.

Ground every statement in the finding's own numbers. Name the block and vintage when the finding is scoped to them. Prefer the concrete over the general.

Climate and soil inputs are modelled estate-wide data (ECMWF weather, ERA5-Land soil), not on-site sensors, so never describe them as probes, sensors, stations or measurements taken at the estate.

Never state a finding more confidently than its confidence label allows:
- reproduced: held in at least three of four seasons. You may describe it as a consistent pattern.
- single_season: observed in one season only. Say so explicitly, in the sentence itself.
- directional_only: fewer than six data points; there is no statistical confidence whatsoever. Describe only what the numbers show, always name the sample size in plain words, and never use ${bannedPhrase} Frame it as something to watch, not something established.

Never claim causation. Never invent tasting notes. Respond ONLY with a JSON array, one object per input row: {"id": <id>, "keep": true|false, "narration": "<text or empty if not keeping>"}.`;

// At most this many rows per model call. 5 rows used ~60% of the 2048-token
// ceiling on Sonnet 5 and 5.5; 20 in one call was cut off on both.
export const BATCH_SIZE = 5;
export const MAX_TOKENS = 2048;

export interface Finding { id: number; [key: string]: unknown }
interface Verdict { id: number; keep: boolean; narration: string }

export interface CallResult { text: string; stopReason: string | null; outputTokens: number; thinkingTokens: number | null }
export type NarrationCall = (input: Record<string, unknown>[]) => Promise<CallResult>;
// Must write only if the row is still surfaced and un-narrated; `matched`
// false means it no longer was (another run got there first).
export type NarrationWrite = (id: number, values: Record<string, unknown>) =>
  Promise<{ ok: true; matched: boolean } | { ok: false; error: string }>;
export interface NarrationLog { info(msg: string, data: Record<string, unknown>): void; error(msg: string, data: Record<string, unknown>): void }

export interface NarrationOutcome {
  written: number[];
  failed: { id: number; reason: string; stop_reason?: string | null; word?: string; year?: string }[];
  skipped: number[];
  calls: number;
  splits: number;
}

const consoleLog: NarrationLog = {
  info: (msg, data) => console.log(`insights-scan/narrate: ${msg} ${JSON.stringify(data)}`),
  error: (msg, data) => console.error(`insights-scan/narrate: ${msg} ${JSON.stringify(data)}`),
};

export function bannedWord(text: string): string | null {
  for (const w of BANNED_DIRECTIONAL_WORDS) if (new RegExp(`\\b${w}\\b`, "i").test(text)) return w;
  return null;
}

// "probe" also matches "probes", "sensor" "sensors".
export function provenanceWord(text: string): string | null {
  for (const w of PROVENANCE_WORDS) if (new RegExp(`\\b${w}`, "i").test(text)) return w;
  return null;
}

// A 19xx/20xx year in the narration that is not a number anywhere in the
// row's own input (scope_vintages, vintages_tested, ...).
export function unsupportedYear(text: string, input: Record<string, unknown>): string | null {
  const sent = new Set(JSON.stringify(input).match(/\d+/g) ?? []);
  for (const y of text.match(/\b(?:19|20)\d{2}\b/g) ?? []) if (!sent.has(y)) return y;
  return null;
}

// The content checks a kept narration must pass; each failure is retried
// once alone, then the row is left un-narrated.
function contentIssue(f: Finding, narration: string): { reason: string; word?: string; year?: string } | null {
  if (f.confidence_label === "directional_only") {
    const w = bannedWord(narration);
    if (w) return { reason: "banned_word", word: w };
  }
  const p = provenanceWord(narration);
  if (p) return { reason: "provenance_word", word: p };
  const y = unsupportedYear(narration, stripToNarrationInput(f));
  if (y) return { reason: "unsupported_year", year: y };
  return null;
}

// Oldest first in, BATCH_SIZE per call, each batch its own call and writes.
// A batch cut off at max_tokens or with unparseable JSON is split in half and
// retried, down to one row; a row whose verdict is missing, duplicated, or a
// kept-but-empty narration is retried alone. A row that still fails, or a
// directional_only narration that uses a banned word twice, is logged (id and
// reason only, never text) and left un-narrated. The same retry-once-alone
// rule covers a kept narration that uses a provenance word or a year the row
// does not contain. Nothing is written for a row
// that did not parse and validate.
export async function narrateRows(rows: Finding[], call: NarrationCall, write: NarrationWrite,
  opts: { model: string; now?: () => string; log?: NarrationLog }): Promise<NarrationOutcome> {
  const log = opts.log ?? consoleLog;
  const now = opts.now ?? (() => new Date().toISOString());
  const out: NarrationOutcome = { written: [], failed: [], skipped: [], calls: 0, splits: 0 };

  const fail = (id: number, reason: string, stop_reason: string | null, extra: { word?: string; year?: string } = {}) => {
    out.failed.push({ id, reason, stop_reason, ...extra });
    log.error("row left un-narrated", { id, reason, stop_reason, ...extra });
  };

  // Why a row or batch is being retried is logged here, so a row that later
  // fails on its retry still shows what went wrong the first time.
  async function retry(batch: Finding[], fromSize: number, reason: string, stop: string | null) {
    if (fromSize === 1) return fail(batch[0].id, reason, stop);
    if (batch.length === 1) {
      log.info("retrying row alone", { id: batch[0].id, reason, stop_reason: stop });
      return run(batch, false);
    }
    log.info("splitting batch", { ids: batch.map((f) => f.id), reason, stop_reason: stop });
    out.splits++;
    const mid = Math.ceil(batch.length / 2);
    await run(batch.slice(0, mid), false);
    await run(batch.slice(mid), false);
  }

  async function writeVerdict(f: Finding, v: Verdict) {
    const values = v.keep
      ? { narration: v.narration.trim(), narration_model: opts.model, narrated_at: now() }
      : { status: "below_threshold", rejection_reason: v.narration.trim() || "narration model vetoed: no plausible mechanism",
          narration_model: opts.model, narrated_at: now() };
    const r = await write(f.id, values);
    if (!r.ok) {
      out.failed.push({ id: f.id, reason: "write_error" });
      log.error("write failed", { id: f.id, error: r.error.slice(0, 200) });
    } else if (r.matched) out.written.push(f.id);
    else out.skipped.push(f.id);
  }

  async function run(batch: Finding[], contentRetry: boolean): Promise<void> {
    out.calls++;
    let res: CallResult;
    try {
      res = await call(batch.map(stripToNarrationInput));
    } catch (err) {
      // An API failure, not a cut-off: splitting would not help. Retried next run.
      for (const f of batch) out.failed.push({ id: f.id, reason: "api_error" });
      log.error("model call failed", { ids: batch.map((f) => f.id), error: err instanceof Error ? err.message.slice(0, 200) : "error" });
      return;
    }
    log.info("call", { rows: batch.length, ids: batch.map((f) => f.id), stop_reason: res.stopReason,
      output_tokens: res.outputTokens, thinking_tokens: res.thinkingTokens, max_tokens: MAX_TOKENS });

    const verdicts = res.stopReason === "max_tokens" ? null : parseVerdicts(res.text);
    if (!verdicts) return retry(batch, batch.length, res.stopReason === "max_tokens" ? "max_tokens" : "unparseable", res.stopReason);

    const byId = new Map<number, Verdict>(), dup = new Set<number>();
    for (const v of verdicts) byId.has(v.id) ? dup.add(v.id) : byId.set(v.id, v);
    const unknown = [...byId.keys()].filter((id) => !batch.some((f) => f.id === id));
    if (unknown.length) log.error("ignored verdicts for ids not in the batch", { ids: unknown });

    const bad: Finding[] = [], flagged: [Finding, { reason: string; word?: string; year?: string }][] = [];
    for (const f of batch) {
      const v = dup.has(f.id) ? undefined : byId.get(f.id);
      if (!v || (v.keep && !v.narration.trim())) { bad.push(f); continue; }
      const issue = v.keep ? contentIssue(f, v.narration) : null;
      if (issue) { flagged.push([f, issue]); continue; }
      await writeVerdict(f, v);
    }
    if (bad.length) await retry(bad, batch.length, "invalid_verdict", res.stopReason);
    for (const [f, { reason, ...extra }] of flagged) {
      if (contentRetry) fail(f.id, reason, res.stopReason, extra);
      else {
        log.info("retrying row alone", { id: f.id, reason, stop_reason: res.stopReason, ...extra });
        await run([f], true);
      }
    }
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) await run(rows.slice(i, i + BATCH_SIZE), false);
  log.info("done", { rows: rows.length, written: out.written.length, failed: out.failed.length, skipped: out.skipped.length,
    calls: out.calls, splits: out.splits, failed_ids: out.failed.map((f) => f.id) });
  return out;
}

export function stripToNarrationInput(f: Finding) {
  const { id, tier, metric_a, metric_b, effect, n_observations, lag_days, scope_kind, scope_block_id,
    scope_vintages, vintages_agreeing, vintages_tested, confidence_label } = f;
  return { id, tier, metric_a, metric_b, effect, n_observations, lag_days, scope_kind, scope_block_id,
    scope_vintages, vintages_agreeing, vintages_tested, confidence_label };
}

/** Defensive parsing: strip a markdown code fence if present, validate
 *  it's an array, validate every item has the required fields. Returns
 *  null on ANY structural failure; per-row problems (a missing or empty
 *  narration) are handled by the caller. */
export function parseVerdicts(raw: string): Verdict[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out: Verdict[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const { id, keep, narration } = item as Record<string, unknown>;
    if (typeof id !== "number" || typeof keep !== "boolean") return null;
    if (keep && typeof narration !== "string") return null;
    out.push({ id, keep, narration: typeof narration === "string" ? narration : "" });
  }
  return out;
}

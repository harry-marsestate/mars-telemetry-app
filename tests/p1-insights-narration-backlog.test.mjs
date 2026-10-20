// Offline test for P1's insight narration backlog check
// (supabase/migrations/20261018120000_p1_insights_narration_backlog.sql) on
// PGlite: runs the block's exact SQL against a stub record_result, and checks
// the migration redefines run_p1_checks() as the previous migration left it
// plus only that block.
//
//   (cd scripts && npm install) && node --test tests/p1-insights-narration-backlog.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromScripts = createRequire(new URL("../scripts/package.json", import.meta.url));
const { PGlite } = await import(pathToFileURL(requireFromScripts.resolve("@electric-sql/pglite")).href);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mig = read("supabase/migrations/20261018120000_p1_insights_narration_backlog.sql");
const prev = read("supabase/migrations/20261006120100_p1_ets_ingest.sql");

const fnOf = (sql) => { const i = sql.indexOf("CREATE OR REPLACE FUNCTION system_health.run_p1_checks()"); return sql.slice(i, sql.indexOf("end $function$;", i) + 15); };
const start = mig.indexOf("  -- Insight narration backlog");
const block = mig.slice(start, mig.indexOf("  return v_run;", start));
const ID = "database.insights.narration_backlog";

let db;
async function runCheck() {
  await db.exec("delete from system_health.results");
  await db.exec(`do $do$ declare v_run bigint := 1; v_status text; v_obs jsonb; v_n bigint; v_n2 bigint; begin\n${block}\nend $do$;`);
  return (await db.query("select status, observed, detail from system_health.results where check_id = $1", [ID])).rows[0];
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create schema system_health;
    create table system_health.results (run bigint, layer text, check_id text, status text, observed jsonb, expected jsonb, detail text);
    create function system_health.record_result(p_run bigint, p_layer text, p_check text, p_status text, p_obs jsonb, p_exp jsonb, p_detail text)
      returns void language sql as $$ insert into system_health.results values (p_run, p_layer, p_check, p_status, p_obs, p_exp, p_detail) $$;
    create table public.insights (id bigserial primary key, computed_at timestamptz, status text, narration text, narrated_at timestamptz);
  `);
});

test("migration = previous run_p1_checks() + only the narration backlog block", () => {
  assert.equal(fnOf(mig).replace(block, ""), fnOf(prev));
  assert.ok(mig.includes("revoke all on function system_health.run_p1_checks() from public, anon, authenticated, service_role;"));
});

test("no backlog: pass", async () => {
  const r = await runCheck();
  assert.equal(r.status, "pass");
  assert.deepEqual(r.observed, { unnarrated_surfaced: 0, older_than_8_days: 0, oldest_computed_at: null });
});

test("today's production state (4 weekly runs x 5 rows, none narrated) fails; counts and oldest date only", async () => {
  // Mirrors 2026-10-18: runs 21, 14, 7 and 0 days old.
  await db.exec(`insert into public.insights (computed_at, status)
    select now() - make_interval(days => d), 'surfaced' from unnest(array[21, 14, 7, 0]) d, generate_series(1, 5)`);
  // Older narrated rows and un-narrated non-surfaced rows never count.
  await db.exec(`insert into public.insights (computed_at, status, narration, narrated_at) values (now() - interval '28 days', 'surfaced', 'n', now() - interval '28 days')`);
  await db.exec(`insert into public.insights (computed_at, status) values (now() - interval '30 days', 'below_threshold'), (now() - interval '30 days', 'excluded_low_n')`);
  const r = await runCheck();
  assert.equal(r.status, "fail");
  assert.equal(r.observed.unnarrated_surfaced, 20);
  assert.equal(r.observed.older_than_8_days, 10);
  assert.ok(Date.parse(r.observed.oldest_computed_at) < Date.now() - 20 * 86400e3);
  assert.deepEqual(Object.keys(r.observed).sort(), ["older_than_8_days", "oldest_computed_at", "unnarrated_surfaced"]);
  assert.match(r.detail, /^10 surfaced insight\(s\) un-narrated for more than 8 days/);
});

test("rows from this week's scan alone (7 days or newer) pass", async () => {
  await db.exec(`update public.insights set narrated_at = now(), narration = 'n' where status = 'surfaced' and computed_at < now() - interval '8 days'`);
  const r = await runCheck();
  assert.equal(r.status, "pass");
  assert.equal(r.observed.unnarrated_surfaced, 10);
  assert.equal(r.observed.older_than_8_days, 0);
});

test("backlog cleared: pass with zero", async () => {
  await db.exec(`update public.insights set narrated_at = now(), narration = 'n' where status = 'surfaced' and narrated_at is null`);
  const r = await runCheck();
  assert.equal(r.status, "pass");
  assert.equal(r.observed.unnarrated_surfaced, 0);
});

test("a vetoed row (status below_threshold, narrated) leaves the backlog", async () => {
  await db.exec(`insert into public.insights (computed_at, status) values (now() - interval '9 days', 'surfaced')`);
  assert.equal((await runCheck()).status, "fail");
  await db.exec(`update public.insights set status = 'below_threshold', narrated_at = now() where narrated_at is null and status = 'surfaced'`);
  assert.equal((await runCheck()).status, "pass");
});

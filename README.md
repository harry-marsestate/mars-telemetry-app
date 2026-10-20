# Mars Telemetry

Mars Telemetry is a web dashboard and chat assistant for Mars Estate, a
vineyard and winery on Howell Mountain with three vineyard blocks (7.35 acres
in `seed-data/blocks.csv`). It brings climate, soil, irrigation, labour, lab
and cellar data for the 2022–2026 vintages into one place. Before it, this
data sat in InnoVint, Excel spreadsheets and PDF lab reports. The vineyard
team uses it today, and winery staff are planned users. Operators see
everything; wine club members can have customer accounts that exclude sensitive financial and lab data. It supports decisions on when fruit is ready
to pick (berry maturity by block), how a vintage's weather compares with
earlier ones, where labour hours and cost go by operation, and, once on-site
sensors are in, irrigation timing and volume.

## Architecture

**Data sources.**
- Open-Meteo: modelled climate (ECMWF IFS) and soil (ERA5-Land) for the estate; not on-site sensors.
- InnoVint (winery management system API): lot analyses, vessels and grower receipts.
- ETS Laboratories: berry maturity, smoke markers and wine chemistry, from CSV exports and PDF reports.
- Spreadsheets: irrigation logs (2023–2025) and labour invoice backups.
- Simulated: wind, solar and UV, cellar sensors, and per-block soil probes. The dashboard labels each of these as simulated.

**Ingestion.** One-time backfills are hand-run Python scripts in
`ingestion/` (ETS CSVs, irrigation, labour, historical climate). Daily jobs
are Supabase Edge Functions called by `pg_cron`: `ingest-climate-2026` and
`ingest-innovint` (07:00 UTC). `ingest-ets-report` accepts parsed PDF lab
reports from a weekly Claude Code scheduled task that runs in Claude's cloud.

**Database.** Supabase Postgres, defined by 108 SQL migrations in
`supabase/migrations/`. Row-level security decides what each role can read.
Views do the read-side shaping, for example `berry_maturity_by_block`, which
pivots lab results into one row per block and date. The dbt project in
`ingestion/mars_dbt/` builds the `daily_weather` and `daily_derived` models
(growing degree days, diurnal range, VPD, reference ET).

**Backend functions.** Edge Functions in `supabase/functions/`:
- `chat`: the assistant, with nine data tools plus a dashboard guide.
- `mcp`: a read-only MCP server for external agents, with 12 tools.
- `insights-scan`: runs weekly, finds correlations across metrics and vintages, and has Claude narrate them.
- `health-probe`: checks upstream services each night.
- `notify-admin-approval` and `admin-pending-emails`: account approval.

**Frontend.** `web/index.html`, one static HTML file using supabase-js, hosted on Vercel. It has
three tabs: Vineyard Data, Winery Data and Chat. Panels include 20 charts, a
block map, two "at a glance" summaries and an Insights and Anomalies panel.
Admins approve sign-ups and manage accounts and API keys on a User Management
page.

**Monitoring.** Nightly health checks run in three parts. P1 runs database
checks at 12:00 UTC. P2 runs upstream probes at 12:10 UTC. P3 is a browser
check of the dashboard as three synthetic users, run by GitHub Actions at
12:17 UTC (disabled in this public copy). Results go to a `system_health`
schema through a write-only role.

## Key design decisions

- Supabase is the only backend: Postgres, Auth, Edge Functions and `pg_cron` for schedules.
- Row-level security is the access control; role checks in the UI are cosmetic only.
- Chat tools query with the caller's own login token, never the service role, so the chat sees exactly what the user's role allows.
- Each data domain is marked real or simulated per vintage (`domain_reality()`), and an account can be set to see real data only.
- Rates, totals and date ranges are computed in the tools; the model is instructed never to compute them itself.
- Operators can switch the chat to Kimi K3 (via Fireworks AI) as an alternative to Claude.

## Other design choices in the code

- The dashboard is one static HTML file with no build step.
- Lab results are stored one row per analyte (entity-attribute-value) and pivoted by views.
- The PDF lab-report path is write-only with its own key; the scheduled task that posts reports holds no Supabase credential.
- The MCP gateway uses per-user API keys and runs every query as a SELECT-only role in a read-only transaction under the key owner's row-level security.
- InnoVint responses are validated against strict schemas (unknown fields fail the run) and saved raw before parsing.
- Backfill scripts refuse to write a source whose computed totals do not match checksums.
- The daily syncs run as Edge Functions instead of the original Dagster schedule, which was never deployed.
- The insights scan uses hand-written rank statistics (Spearman, Fisher, Benjamini-Hochberg) rather than a statistics library.

## Built with

- Languages: TypeScript (Deno), JavaScript, Python 3.12, SQL.
- Database and backend: Supabase (Postgres, Auth, Edge Functions, Vault, `pg_cron`, `pg_net`).
- Data tooling: dbt (`dbt-postgres`), Dagster, pandas, pydantic, openpyxl, httpx.
- Frontend: plain HTML, CSS and JavaScript with supabase-js.
- Models: Anthropic Claude Sonnet 5.5 for chat and insight narration; Kimi K3 on Fireworks AI as an optional chat backend.
- Hosting and other services: Vercel (dashboard), Open-Meteo, InnoVint API, Resend (email), GitHub Actions.
- Tests: Node's built-in test runner with PGlite for SQL tests, and Deno test (352 test cases in `tests/`).

The project was built with AI assistance using Claude Code.

## Engineering notes

- [`docs/ETS-INGEST.md`](docs/ETS-INGEST.md): how ETS lab results reach the
  database by the CSV and PDF paths, with the analyte rules, access rules and
  the tests that keep the document and code in agreement.
- [`docs/MCP.md`](docs/MCP.md): how to connect an agent to the read-only MCP
  gateway, how keys are issued and revoked, and how to add a tool.
- The engineering log (`docs/SECURITY.md`), which records design decisions,
  security reviews and verification results, is kept private. Code comments
  that cite it refer to that private file.

## Data in this repository

Most files in `seed-data/` are made up. The ETS lab reports are simulated from
real files, and the irrigation logs and block acreage are real. See
[`seed-data/README.md`](seed-data/README.md) for the file-by-file list.

## Status

Runs today:
- The dashboard, sign-up with admin approval, and customer accounts limited by block.
- Daily InnoVint and 2026 climate syncs, and weekly ETS PDF report ingestion.
- The chat assistant (Claude Sonnet 5.5, with Kimi K3 as an option) and the MCP gateway.
- The weekly insights scan and the nightly health checks.

Planned:
- An on-site weather station and soil probes (being installed).
- Winery sensors.
- Accounts for winery staff.

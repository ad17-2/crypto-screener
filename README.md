# Crypto Daily Screener

Signal-only crypto futures screener for daily manual chart review.

This project turns futures market structure into a ranked watchlist. It collects liquid USDT perpetual markets, enriches them with funding, open interest, liquidations, taker flow, 4h technicals, positioning, market breadth, and sector context, then writes the result to SQLite, optional report files, and a lightweight dashboard.

It ranks on **observables only** — there is no learned model, no factor-weighting engine, and no confidence prediction. Every column is a market fact you could look up yourself; the screener's job is to collect them for the whole universe at once and rank them so you review a short list instead of the whole tape.

It does not place trades, connect to an exchange account, request broker keys, or automate execution. Treat every output as a shortlist for manual TradingView review.

## The Idea

Most daily crypto screening is noisy because it mixes three different questions:

- What is the broad market regime?
- Which symbols are moving with useful futures confirmation?
- Which symbols are too crowded and should be reviewed as a fade or a squeeze risk?

This screener keeps those questions separate. It ranks symbols into watchlists, explains the observable drivers behind each row, and flags bad provider data. The goal is not to predict trades. The goal is to compress the market into a small set of symbols worth reviewing by hand.

The dashboard is a top-down read. You do not pick a tab and start hunting; you scroll, and the page narrows the market for you:

1. **The market** — a plain-English verdict ("No clear direction."), the regime and bias, and a funnel showing the run's real counts: symbols scanned, priced, trusted, shortlisted.
2. **Breadth and rotation** — how many coins are up vs down, which sectors lead and lag, plus three correlation reads (**BTC correlation (mkt)**, **Alt-alt correlation**, **Correlation spread**). A wide spread means every coin is hanging off BTC — little genuine diversification even across many names. All three are display-only and feed nothing.
3. **The majors** — BTC, ETH, SOL. They are context, not candidates.
4. **Screened coins** — what actually cleared the screen, split into what's worth trading and what's a crowding risk. Click a row for the observable drivers, the chart read, and the derivatives detail.

Then confirm the setup on a chart before doing anything.

Nothing on the page is a black box. Every term (open interest, funding, crowding, correlation, positioning) sits behind an ⓘ that gives a plain-English definition and names the underlying field. A dismissible "How to read this screener" guide, reachable from the header, walks a first-time visitor through the same four lists and the BTC fakeout guards in plain English before they ever open a row.

## What The Screener Shows

Each row is scored into one of four watchlists — **long**, **short**, **crowded long** (fade watch), and **squeeze risk** — and carries a set of observables for manual review. Long/short membership requires at least a ±0.5% 24h move (a noise floor below which a move isn't a real advance or decline) and never includes BTC, ETH, or SOL — the majors live in the Core read, not as directional candidates. Most are display-only; BTC correlation and BTC beta are the exception — they also feed the long/short formulas directly, as a residual and a fights-BTC guard (see How Ranking Works). Rows default to the API's own score order; click any column header to re-sort on that one value instead.

The **table** shows, per coin: the setup label, 24h price change, quote volume, 24h OI change, funding rate, crowding, and two risk lenses:

- **BTC correlation** — Pearson ρ of the coin's 4h returns against BTC's over the last ~30 days. A high positive ρ means a BTC pump can reverse a technically-justified short; a coin near zero moves on its own. (Populated only after a fresh run computes it; blank on older runs.)
- **Smart $** (positioning divergence) — top-trader ÷ crowd long/short account ratio. Above 1, professional accounts lean more long than retail; below 1, the crowd is more long than the pros.

A row whose direction is opposed by a live BTC impulse it's correlated to also carries a **Fights BTC** chip next to its setup label — the same guard the ranking formula subtracts for, not a prediction.

- **Run trend** — a **Strengthening** / **Weakening** / **Holding** badge next to the setup label, showing whether the row's score moved more than typical run-over-run noise since the last run; suppressed whenever the last run used a different scoring version, and a brand-new row shows the existing **NEW** chip instead.
- **Size** — a **Low vol** / **High vol** chip next to the setup label: a volatility-derived sizing hint, not a conviction rating. Only renders outside the near-neutral band.

Click a row to open the **detail rail**, which adds:

- **OI / price read** — a four-way quadrant from the signs of 24h price and OI change: _New longs_ (both up, fresh money), _Short covering_ (price up, OI down, a weak rally), _New shorts_ (price down, OI up, fresh downside), _Long liquidation_ (both down, a washout). Computed server-side, with a dead-zone below 0.5% price change or 1% OI change; inside it the rail shows a muted "Quiet" read instead of a quadrant.
- **BTC beta** — the coin's move per 1% BTC move, from the same ~30-day shared 4h-return series as BTC correlation. **Residual 24h** — the 24h move left after subtracting the beta-implied BTC move; shown only when the row was actually residualized.
- **Liquidation imbalance** — net 24h skew; positive means more shorts were liquidated (squeeze pressure), negative means more longs (a washout).
- **Taker flow** — net 24h aggressive buy vs sell volume; positive is net buying.
- **Positioning** — retail and top-trader long/short account ratios side by side, with an alignment badge, plus the top-trader position ratio (weighted by position size, not headcount) and its 24h change.
- Funding, open interest (change and notional), crowding, round-trip cost and size estimates, the 4h technical state, a sparkline of recent history, and the reason chips that explain why the row scored where it did.

## What It Produces

- A SQLite database at `data/crypto_screener.sqlite3` by default.
- Optional Markdown, JSON, and CSV reports under `reports/`.
- A local or Railway-hosted dashboard at `/`.
- Compact factor history that feeds the dashboard sparklines.

## How The Screener Works

The screener is an offline batch job (`apps/api/src/cli/screener.ts`). A separate always-on server (`apps/api/src/server.ts`) reads the latest run from the same SQLite file and serves the dashboard.

```text
config/default.json
  -> collect CoinGlass futures universe + market data (funding, OI, liquidations, taker flow, 4h candles)
  -> collect CoinGecko market + category (sector) context
  -> data-quality checks (thin/malformed rows are flagged, kept visible, excluded from trusted ranking)
  -> build normalized observable factors (cross-sectional robust z-scores)
  -> classify the market regime + market context (descriptive labels)
  -> score rows into the four watchlists on observables
  -> save the run to SQLite
  -> optionally write Markdown / JSON / CSV reports

server.ts (separate process)
  -> read the latest saved run from SQLite
  -> serve /health and /api/dashboard; optionally run a scheduled refresh
```

The observables the screener reads:

- Price momentum and 3-day reversal stretch.
- Price plus open-interest confirmation.
- Funding and long/short crowding.
- Liquidation imbalance and taker flow.
- 4h technical trend and momentum.
- Historical OI, funding, liquidation, and taker-flow context.
- Market breadth and sector rotation.
- BTC return correlation, beta, and the resulting residual 24h move.
- Top-trader position ratio (size-weighted) and its 24h change.

Rows that fail data-quality checks stay visible for inspection but are excluded from trusted ranking.

## How Ranking Works

There is no learned model and no confidence score. Each row gets four independent scores from fixed, hand-set formulas over observables (`apps/api/src/pipeline/rowScoring.ts`) — mechanical rationale, not fitted weights; this codebase deliberately has none:

- **long** / **short** — rank on the coin's own move with BTC's pull subtracted out first: 24h price change minus beta × BTC's 24h change (falls back to the raw 24h change when beta isn't available), scaled by the coin's own volatility (an ATR-based scale, clamped both ways; a fixed legacy scale when ATR is missing). Rising open interest still confirms either side; falling OI now drags — a short-covering drag on **long**, a long-liquidation-washout drag on **short**. Liquidity/quality still credits both sides, and long/short crowding still penalizes them. Three subtractive guards sit on top: a **fights-BTC veto** (the candidate's direction is opposed by a live BTC impulse the coin is correlated to — needs correlation ≥ 0.5 and a ≥1% BTC 24h move not contradicted by BTC's own 4h momentum), a **3-day stretch penalty** (the move is already extended relative to the coin's volatility), and a **liquidation-lateness penalty** (the flush already happened, so the row is late rather than early).
- **crowded long** — flags one-sided long positioning and funding as a fade watch. Unchanged by the above.
- **squeeze risk** — flags short-crowding as a risk condition (funding/L-S/OI/price); in the 2026 panel these names more often continued lower than squeezed — a watch condition, not an upside prediction. Unchanged by the above.

The one cross-sectional input is a liquidity/quality percentile, a robust (median/MAD) z-score of each symbol against the rest of the current run, passed through a sigmoid to a 0–100 scale. The broader factor normalization still runs, but it mostly drives the plain-English reason chips shown on each row, not the score itself.

Because the score is a direct function of observables, the dashboard can always name exactly why a symbol ranked where it did — the reason chips are the score's own inputs, not a post-hoc explanation of a model.

The **regime** label (`btc-led`, `alts-strong`, `neutral`, `chaos`) is descriptive market context derived from BTC dominance shift, ETH/BTC performance, breadth, return dispersion, and average funding, with hysteresis against the prior state. It labels the tape; it does not reweight anything.

## Requirements

- Node.js >= 20.9 (see `package.json`'s `engines` field).
- npm workspaces — this repo is a single workspace tree: `apps/api`, `apps/web`, and `packages/contracts`.
- CoinGlass API key for fresh futures collection.
- Optional CoinGecko API key.
- Optional Railway CLI for cloud deployment and SQLite sync.

`apps/api`'s runtime dependencies are intentionally small: `express` for the HTTP server, `better-sqlite3` for storage, and `zod` for config and payload validation — the same schemas are shared with `apps/web` through the internal `@crypto-screener/contracts` workspace package.

No exchange account or trading API key is needed.

## Setup

```bash
npm install
```

npm workspaces installs `apps/api`, `apps/web`, and `packages/contracts` from the repo root in one shot — there is no separate per-package install step.

Provider keys:

```bash
export COINGLASS_API_KEY="..."
export COINGECKO_API_KEY="..." # optional
```

## Run The Screener

The screener CLI lives at `apps/api/src/cli/screener.ts` and is published as the `crypto-screener` bin once `apps/api` is built.

Normal report-producing run, against the built JS:

```bash
npm run build
node apps/api/dist/cli/screener.js --config config/default.json --out-dir reports
```

Or run straight from source during development, via `tsx`:

```bash
npx tsx apps/api/src/cli/screener.ts --config config/default.json --out-dir reports
```

Dashboard-only run, with no Markdown/JSON/CSV artifacts:

```bash
node apps/api/dist/cli/screener.js \
  --config config/default.json \
  --out-dir reports \
  --no-reports
```

Fast smoke run without saving history:

```bash
node apps/api/dist/cli/screener.js \
  --config config/default.json \
  --out-dir reports \
  --top-symbols 25 \
  --report-limit 8 \
  --coinglass-candidate-symbols 25 \
  --no-reports \
  --no-save
```

Expected CLI summary shape (verified against `apps/api/src/cli/screener.ts`'s `main()`):

```text
run_id=YYYYMMDD-HHMMSS-abcdef12
screened_symbols=80
bias=risk-on
factor_regime=neutral
long_candidates=12
short_candidates=12
crowded_longs=4
squeeze_risks=9
```

`reports=skipped` is printed when no report files were written (e.g. `--no-reports`); otherwise one `{label}={path}` line is printed per report file, in write order.

CLI flags:

```text
--config PATH                          default config/default.json
--out-dir DIR                          default reports
--top-symbols N
--report-limit N
--min-quote-volume-usd N
--coinglass-candidate-symbols N        alias: --max-coinglass-symbols (same destination)
--no-save
--no-reports
```

## Dashboard

Run apps/api and apps/web together for local dev:

```bash
npm run dev
```

This starts apps/api's Express server on `127.0.0.1:$API_PORT` (default `4000`, internal only) and apps/web's Next.js dev server on `$PORT` (default `3000`) as sibling processes. Open:

```text
http://localhost:3000/
```

If port 3000 is taken, Next.js picks the next free port and prints it — watch the startup log.

`apps/web`'s `next.config.ts` rewrites `/api/*` and `/health` to the Express origin (`API_BASE_URL`, default `http://127.0.0.1:4000`), so the dashboard UI, `/health`, and `/api/dashboard` are all reachable from the single public port.

Routes:

```text
GET  /                          HTML dashboard (Next.js)
GET  /health                    {"status":"ok","database_exists":bool,"refresh":{...}}
GET  /api/dashboard             Latest dashboard payload
GET  /api/dashboard?run_id=...  Specific run payload
GET  /api/btc-pulse             Near-live BTC spot price, for staleness detection
POST /api/refresh               Protected manual refresh
```

The Express app registers only `/health`, `/api/dashboard`, `/api/btc-pulse`, and `/api/refresh` (`apps/api/src/http/app.ts`); `GET /` is served by Next.js. `/health` only implements `GET` — use `GET`, not `HEAD`, for health checks.

`GET /api/btc-pulse` fetches BTC's spot price from Binance's public ticker (keyless), cached in memory for 30s; on fetch failure it serves the last value stale for up to 5 minutes, else `503 {"error":"btc_pulse_unavailable"}`. The dashboard polls it every 60s and compares it against the run's BTC price: the Watchlist panel's header always shows a small live-price chip, and once BTC has moved ≥1.5% since the run, a warning banner appears above the threatened list (shorts on a BTC pump, longs on a BTC dump) — the tripwire for the fact that runs are batch, 4×/day, while BTC moves live.

`POST /api/refresh` is default-deny: it returns `403` unless `CRYPTO_DASHBOARD_REFRESH_TOKEN` is set _and_ the request supplies it via an `X-Refresh-Token` header or an `Authorization: Bearer` header (compared with a constant-time check).

Dashboard environment:

| Variable                                | Default               | Purpose                                                                          |
| --------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `API_PORT`                              | `4000`                | Port apps/api's Express server binds on `127.0.0.1` (internal only)              |
| `PORT`                                  | `3000` locally        | Port apps/web (Next.js) binds on; public in production                           |
| `CRYPTO_SCREENER_CONFIG`                | `config/default.json` | Config path                                                                      |
| `CRYPTO_SCREENER_DB_PATH`               | Config `storage_path` | SQLite path                                                                      |
| `CRYPTO_SCREENER_REPORT_DIR`            | `reports`             | Runtime work directory                                                           |
| `CRYPTO_DASHBOARD_LIMIT`                | Config `report.limit` | Rows per list                                                                    |
| `CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS` | `0`                   | Interval refresh threshold                                                       |
| `CRYPTO_DASHBOARD_DAILY_REFRESH_TIME`   | unset                 | One or more `HH:MM` daily refresh times (alias: `CRYPTO_DASHBOARD_REFRESH_TIME`) |
| `CRYPTO_DASHBOARD_REFRESH_TZ`           | `Asia/Jakarta`        | Refresh timezone                                                                 |
| `CRYPTO_DASHBOARD_RETAIN_RUNS`          | `0`                   | Keep newest N full runs after refresh                                            |
| `CRYPTO_DASHBOARD_REFRESH_TOKEN`        | unset                 | Required token for `POST /api/refresh`                                           |
| `COINGLASS_API_KEY`                     | unset                 | CoinGlass provider key                                                           |
| `COINGECKO_API_KEY`                     | unset                 | Optional CoinGecko provider key                                                  |

Dashboard boot, `/health`, and `/api/dashboard` work from an existing SQLite database without provider keys. Provider keys are required only when the service runs a fresh screener refresh.

## Railway

One Railway service (`crypto-dashboard`), with a volume mounted at `/data`.

`nixpacks.toml` sets `providers = ["node"]`, `NIXPACKS_NODE_VERSION = "22"`, and `NPM_CONFIG_PRODUCTION = "false"` — devDependencies must survive install because the build needs `typescript`, Tailwind, and Next's toolchain.

`railway.json`:

- `build.buildCommand`: `npm run build` (must NOT re-run `npm ci` — that fails with `EBUSY` on the mounted `node_modules/.cache`).
- `deploy.startCommand`: `npm start`, which runs `scripts/start.mjs` — the production supervisor that spawns `apps/api/dist/server.js` and `next start -p $PORT` (apps/web) as sibling processes, forwards `SIGTERM`/`SIGINT` to both, and exits non-zero the instant either one dies so Railway's restart policy kicks in.
- `deploy.healthcheckPath`: `/health`.

`.github/workflows/deploy-railway.yml` runs the test job (`npm ci --include=dev`, `npm run check`, `npm run typecheck`, `npm test`, `npm run build`) then `railway up` on every push to `main`.

Manual deploy:

```bash
railway up --detach --message "Update crypto dashboard"
```

The Railway domain is not stored in the repo — resolve it from the dashboard or the CLI:

```bash
railway domain --service <service-id>
railway deployment list --json
railway logs --deployment <deployment-id> --lines 80
curl -fsS https://<railway-domain>/health
curl -fsS https://<railway-domain>/api/dashboard
```

For persistent history, mount a Railway volume and set:

```bash
CRYPTO_SCREENER_DB_PATH=/data/crypto_screener.sqlite3
CRYPTO_SCREENER_REPORT_DIR=/data/reports
```

For scheduled cloud refresh:

```bash
CRYPTO_DASHBOARD_DAILY_REFRESH_TIME=07:10,11:10,15:10,19:10
CRYPTO_DASHBOARD_REFRESH_TZ=Asia/Jakarta
CRYPTO_DASHBOARD_RETAIN_RUNS=1
```

## Local Run, Cloud Dashboard

A common operating mode is to run the screener locally, then sync SQLite to Railway:

```bash
npm run build
node apps/api/dist/cli/screener.js --config config/default.json --out-dir reports --no-reports
scripts/sync_sqlite_to_railway.sh data/crypto_screener.sqlite3
```

The sync script gzip+base64-chunks the local SQLite database up over `railway ssh`, verifies the remote temporary file with better-sqlite3's `pragma quick_check` integrity check, then atomically moves it into `CRYPTO_SCREENER_DB_PATH`.

## Backfill

Backfill writes compact factor history only. It does not create fake dashboard runs.

The backfill CLI lives at `apps/api/src/cli/backfill.ts` and is published as the `crypto-screener-backfill` bin once `apps/api` is built.

Dry run, against the built JS:

```bash
npm run build
node apps/api/dist/cli/backfill.js --config config/default.json --dry-run
```

Or from source during development:

```bash
npx tsx apps/api/src/cli/backfill.ts --config config/default.json --dry-run
```

Specific symbols:

```bash
node apps/api/dist/cli/backfill.js \
  --config config/default.json \
  --symbols BTC,ETH,SOL,SUI,HYPE,LINK \
  --interval 4h \
  --limit 220
```

CLI flags:

```text
--config PATH                default config/default.json
--symbols SYM,SYM,...
--interval INTERVAL
--limit N
--min-cross-section N         default 3
--request-delay-seconds N
--dry-run
```

## Project Structure

```text
apps/api/src/
  cli/                  screener.ts, backfill.ts CLIs (+ shared support.ts helpers)
  config/               config loading + schema (config/default.json contract)
  dashboard/            dashboard payload builder, row shaping, watchlists, freshness
  db/                   better-sqlite3 client, schema, runs/factor-history persistence
  http/                 Express app + routes (health, dashboard, refresh, btc-pulse)
  pipeline/             collector, factors, scoring, regime, technicals, correlation, derivatives
  providers/            CoinGlass and CoinGecko HTTP clients
  refresh/              refresh runtime + scheduler (interval and daily-time triggers)
  reports/              Markdown/JSON/CSV report writers
  env.ts                process.env loading + validation
  server.ts             process entrypoint (opens DB, starts scheduler, listens on 127.0.0.1:API_PORT)
apps/api/tests/         vitest suite, including the two parity gates and tests/fixtures/
apps/web/app/           Next.js App Router: layout.tsx, page.tsx, globals.css (single route, /)
apps/web/components/    dashboard UI components (layout/, context/, watchlist/)
packages/contracts/src/ zod schemas + shared TS types for the wire payload
scripts/start.mjs       production supervisor (spawns apps/api + `next start -p $PORT`)
scripts/sync_sqlite_to_railway.sh   local-DB -> Railway sync script
config/default.json     main config
data/crypto_screener.sqlite3   SQLite database
railway.json
nixpacks.toml
package.json            npm workspaces root
```

The SQLite schema carries five tables — `runs`, `market_rows`, `factor_history`, `market_regime_history`, and a legacy `recommendations` table that the application no longer writes (kept so existing databases keep opening). Pruning (`CRYPTO_DASHBOARD_RETAIN_RUNS`) only ever deletes from `runs` and `market_rows`; it never touches `factor_history` or `market_regime_history`, which back the sparklines.

## Development

Run the local gate:

```bash
npm run check && npm run typecheck && npm test && npm run build
```

- `npm run check` / `npm run check:fix` — Biome handles lint and format in one tool (2-space indent, single quotes, 100-column width; see `biome.json`).
- `npm run typecheck` — runs each workspace's `typecheck` script (`tsc --noEmit`).
- `npm test` — `vitest run`, covering apps/api and apps/web, including the two golden parity gates under `apps/api/tests/`.
- `npm run build` — builds `packages/contracts`, then `apps/api`, then `apps/web`, in that order.

This is the same gate `.github/workflows/deploy-railway.yml` runs before every deploy to Railway.

The two parity gates compare freshly computed output against frozen fixtures. Regenerate them intentionally when output changes on purpose:

```bash
npx tsx apps/api/scripts/regen-golden.ts payload   # dashboard-payload.json (display fields)
npx tsx apps/api/scripts/regen-golden.ts parity     # parity-run.json (factors + scores)
```

Git hooks (husky + lint-staged, installed automatically by `npm install`):

- **pre-commit** — Biome lints and formats the staged JS/TS/JSON/CSS files, fixing what it can and re-staging the result; Prettier formats staged Markdown/YAML, the only formats Biome does not cover.
- **pre-push** — `npm run typecheck && npm test`. The build is left to CI.

Use `git commit --no-verify` or `git push --no-verify` to bypass in an emergency.

Local dashboard smoke test:

```bash
npm run dev
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/api/dashboard
```

## Security

- Do not commit `.env`, API keys, SQLite databases, or generated reports with private operating context.
- Do not add broker or exchange trading-key requirements to this project.
- Keep outputs signal-only and manually reviewed.

## License

MIT. See `LICENSE`.

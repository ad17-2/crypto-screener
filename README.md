# Crypto Quant Daily Screener

Signal-only crypto futures screener for daily manual chart review.

This project turns futures market structure into a ranked watchlist. It collects liquid USDT perpetual markets, enriches them with funding, open interest, liquidation, taker-flow, 4h technicals, market breadth, and sector context, then writes the result to SQLite, report artifacts, and a lightweight dashboard.

It does not place trades, connect to an exchange account, request broker keys, or automate execution. Treat every output as a shortlist for manual TradingView review.

## The Idea

Most daily crypto screening is noisy because it mixes three different questions:

- What is the broad market regime?
- Which symbols are moving with useful futures confirmation?
- Which symbols are too crowded and should be reviewed as fade or squeeze risk?

This screener keeps those questions separate. It ranks symbols into watchlists, explains the factor drivers, flags bad provider rows, and shows when the model direction conflicts with trend, derivatives, breadth, or regime. The goal is not to predict trades automatically. The goal is to compress the market into a small set of symbols worth reviewing by hand.

The dashboard is a top-down read. You do not pick a tab and start hunting; you scroll, and the page narrows the market for you:

1. **The market** — a plain-English verdict ("Risk-off, and it's broad."), the regime and bias, and a funnel showing the run's real counts: symbols scanned, priced, trusted, shortlisted.
2. **Breadth and rotation** — how many coins are up vs down, and which sectors lead and lag.
3. **The majors** — BTC, ETH, SOL. They are context, not candidates.
4. **Screened coins** — what actually cleared the screen, split into what's worth trading and what's a crowding risk. Click a row for the drivers, the chart read, and the conflicts.

Then confirm the setup on a chart before doing anything.

Quant terms are not printed on the page. Every jargon term (confidence, open interest, funding, crowding, rank) sits behind an ⓘ that gives the plain-English definition and names the underlying field. The model's own diagnostics — factor weights, IC, t-stats, collinearity, calibration, provider health — live on a separate `/model` page, because that is how you check the model is sane, not how you read a market.

## What It Produces

- A SQLite database at `data/crypto_screener.sqlite3` by default.
- Optional Markdown, JSON, and CSV reports under `reports/`.
- A local or Railway-hosted dashboard (`/`) and model-health page (`/model`).
- Compact factor history for rolling validation and sparklines.

The screener ranks symbols into watchlists, explains the factor drivers, flags bad provider rows, and shows when the model direction conflicts with trend, derivatives, breadth, or regime.

## How The Screener Works

```text
config/default.json
  -> collect CoinGlass futures universe and market data
  -> collect CoinGecko market and category context
  -> apply data-quality checks
  -> build normalized factors
  -> apply regime-aware weights
  -> score watchlists and confidence
  -> save SQLite
  -> optionally write report files
  -> serve dashboard from SQLite
```

The main model uses:

- Momentum and reversal.
- Price plus open-interest confirmation.
- Funding and long/short crowding.
- Liquidation imbalance.
- 4h technical trend and momentum.
- Historical OI, funding, liquidation, and taker-flow confirmation.
- Market breadth and sector rotation.

Rows that fail sanity checks remain visible for inspection but are excluded from trusted ranking.

## For The Curious: The Quant Logic

This screener is built as an attention allocator, not as a trade executor. The core assumption is that a daily operator does not need another table of the biggest gainers and losers. They need a short list of markets where price, positioning, crowding, and regime create something worth inspecting manually.

Crypto perpetual futures are useful for this because they expose more than price. A spot chart can show that a coin moved. Perpetual data can add whether traders are adding leverage, whether the move is supported by open interest, whether funding has become one-sided, whether liquidations are pressuring one side, and whether taker flow is confirming or fading the move. None of those fields is a standalone signal. Together they describe the state of the auction.

The model starts with liquidity and data quality. Thin or malformed markets can look exciting because bad data creates extreme factors. Those rows are still shown, because bad provider data is operationally useful to see, but they are not allowed to drive trusted rankings.

After quality checks, the screener builds a cross-sectional view of the current futures universe. Each symbol is compared against the rest of the market instead of judged in isolation. That matters because a `+4%` move can mean very different things when the whole tape is up `+6%` versus when most coins are red. The model normalizes factor values so that momentum, reversal, open-interest behavior, funding, long/short crowding, technical state, and derivatives pressure can be combined without one raw unit dominating the score.

The directional read asks a simple question: is this symbol showing useful long or short pressure relative to the rest of the market? Price plus open interest is the first layer. Rising price with rising OI can mean fresh participation; falling price with rising OI can mean active downside positioning. Reversal factors look for stretched three-day moves that are due to cool off.

The crowding read is deliberately separate. Positive funding, aggressive long/short ratios, and one-sided liquidation context can identify crowded longs. Negative funding and short-heavy positioning can identify squeeze risk. These are not automatic contrarian trades. They are warnings that the market structure may be fragile and should be reviewed differently.

The regime layer keeps the model from pretending every day is the same. In a broad risk-on tape, momentum and price/OI confirmation deserve more respect. In a weak or mixed tape, reversal and crowding context become more important. The regime adjustment changes factor emphasis, but it does not erase the underlying factors. This keeps the model explainable and avoids a black-box override.

The confidence score is also not a prediction. It is a measure of agreement. A cleaner setup has strong factor direction, usable liquidity, good data quality, aligned 4h technicals, supportive derivatives context, and market breadth that does not fight the idea. A low-confidence row can still be useful, but it should be treated as a question mark rather than a clean setup.

Signal conflicts are intentionally visible. If the factor model leans short but the 4h trend, breadth, or regime points long, the dashboard should say that plainly. The best use of the screener is not to hide disagreement; it is to surface disagreement early so the operator can decide whether the chart resolves it.

SQLite is part of the quant loop, not just storage. Saved runs provide history for sparklines and factor validation. When enough forward-return labels exist, the model can compare factor direction against later price behavior and shift from static prior weights toward observed information coefficient context. That history is diagnostic. It helps judge whether a factor has been useful recently, but it is still bounded by conservative thresholds and manual review.

The final output should be read as a set of prompts:

- "Is this long candidate still structurally clean on the chart?"
- "Is this short candidate breaking down with real participation?"
- "Is this crowded long ready to unwind, or is the trend still absorbing pressure?"
- "Is this crowded short actually squeezeable, or just weak?"
- "Does BTC, sector rotation, and market regime agree with the idea?"

That is the intended edge: reduce the market to a defensible review queue, make the reasoning inspectable, and keep the final decision outside the code.

## Requirements

- Node.js >= 20.9 (see `package.json`'s `engines` field).
- npm workspaces -- this repo is a single npm workspace tree: `apps/api`, `apps/web`, and `packages/contracts`.
- CoinGlass API key for fresh futures collection.
- Optional CoinGecko API key.
- Optional Railway CLI for cloud deployment and SQLite sync.

`apps/api`'s runtime dependencies are intentionally small: `express` for the HTTP server, `better-sqlite3` for storage, and `zod` for config and payload validation (the same schemas are shared with `apps/web` via `packages/contracts`).

No exchange account or trading API key is needed.

## Setup

```bash
npm install
```

npm workspaces installs `apps/api`, `apps/web`, and `packages/contracts` from the repo root in one shot -- there is no separate per-package install step.

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
factor_regime=momentum
weight_mode=ic
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

`apps/web`'s `next.config.ts` rewrites `/api/*` and `/health` to the Express origin (`API_BASE_URL`, default `http://127.0.0.1:4000`), so the dashboard UI, `/health`, and `/api/dashboard` are all reachable from the single public port.

Routes:

```text
GET  /                          HTML dashboard (Next.js)
GET  /health                    {"status":"ok","database_exists":bool,"refresh":{...}}
GET  /api/dashboard              Latest dashboard payload
GET  /api/dashboard?run_id=...   Specific run payload
POST /api/refresh                Protected manual refresh
```

`/health` only implements `GET` (see `apps/api/src/http/routes/health.ts`) -- use `GET`, not `HEAD`, for health checks.

`POST /api/refresh` is default-deny: it returns `403` unless `CRYPTO_DASHBOARD_REFRESH_TOKEN` is set _and_ the request supplies it via an `X-Refresh-Token` header or an `Authorization: Bearer` header.

Dashboard environment:

| Variable                                | Default               | Purpose                                                             |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------- |
| `API_PORT`                              | `4000`                | Port apps/api's Express server binds on `127.0.0.1` (internal only) |
| `PORT`                                  | `3000` locally        | Port apps/web (Next.js) binds on; public in production              |
| `CRYPTO_SCREENER_CONFIG`                | `config/default.json` | Config path                                                         |
| `CRYPTO_SCREENER_DB_PATH`               | Config `storage_path` | SQLite path                                                         |
| `CRYPTO_SCREENER_REPORT_DIR`            | `reports`             | Runtime work directory                                              |
| `CRYPTO_DASHBOARD_LIMIT`                | Config `report.limit` | Rows per list                                                       |
| `CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS` | `0`                   | Interval refresh threshold                                          |
| `CRYPTO_DASHBOARD_DAILY_REFRESH_TIME`   | unset                 | One or more `HH:MM` daily refresh times                             |
| `CRYPTO_DASHBOARD_REFRESH_TZ`           | `Asia/Jakarta`        | Refresh timezone                                                    |
| `CRYPTO_DASHBOARD_RETAIN_RUNS`          | `0`                   | Keep newest N full runs after refresh                               |
| `CRYPTO_DASHBOARD_REFRESH_TOKEN`        | unset                 | Required token for `POST /api/refresh`                              |
| `COINGLASS_API_KEY`                     | unset                 | CoinGlass provider key                                              |
| `COINGECKO_API_KEY`                     | unset                 | Optional CoinGecko provider key                                     |

Dashboard boot, `/health`, and `/api/dashboard` can work from an existing SQLite database without provider keys. Provider keys are required when the service runs a fresh screener refresh.

## Railway

One Railway service (`crypto-dashboard`), with a volume mounted at `/data`.

`nixpacks.toml` sets `providers = ["node"]`, `NIXPACKS_NODE_VERSION = "22"`, and `NPM_CONFIG_PRODUCTION = "false"` -- devDependencies must survive install because the build needs `typescript`, Tailwind, and Next's toolchain.

`railway.json`:

- `build.buildCommand`: `npm run build` (must NOT re-run `npm ci` -- that fails with `EBUSY` on the mounted `node_modules/.cache`).
- `deploy.startCommand`: `npm start`, which runs `scripts/start.mjs` -- the production supervisor that spawns `apps/api/dist/server.js` and `next start -p $PORT` (apps/web) as sibling processes, forwards `SIGTERM`/`SIGINT` to both, and exits non-zero the instant either one dies so Railway's restart policy kicks in.
- `deploy.healthcheckPath`: `/health`.

`.github/workflows/deploy-railway.yml` runs the test job (`npm ci --include=dev`, `npm run check`, `npm run typecheck`, `npm test`, `npm run build`) then `railway up` on every push to `main`.

Manual deploy:

```bash
railway up --detach --message "Update crypto dashboard"
```

Verify:

```bash
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
  config/                config loading + schema (config/default.json contract)
  dashboard/              dashboard payload builder, row shaping, watchlists, freshness
  db/                     better-sqlite3 client, schema, runs/factor-history persistence
  http/                   Express app + routes (health, dashboard, refresh)
  pipeline/               collector, factors, scoring, regime, IC weighting, validation, technicals
  providers/              CoinGlass and CoinGecko HTTP clients
  refresh/                refresh runtime + scheduler (interval and daily-time triggers)
  reports/                Markdown/JSON/CSV report writers
  env.ts                  process.env loading + validation
  server.ts               process entrypoint (opens DB, starts scheduler, listens on 127.0.0.1:API_PORT)
apps/api/tests/           vitest suite, including the two parity gates and tests/fixtures/
apps/web/app/             Next.js App Router pages, layout, globals.css
apps/web/components/       dashboard UI components (layout/, context/, watchlist/)
packages/contracts/src/    zod schemas + shared TS types for the wire payload
scripts/start.mjs          production supervisor (spawns apps/api + `next start -p $PORT`)
scripts/sync_sqlite_to_railway.sh   local-DB -> Railway sync script
config/default.json        main config
data/crypto_screener.sqlite3   SQLite database
railway.json
nixpacks.toml
package.json                npm workspaces root
```

The SQLite schema is unchanged from the previous implementation -- same four tables (`runs`, `market_rows`, `factor_history`, `market_regime_history`) -- so an existing database keeps working. Pruning (`CRYPTO_DASHBOARD_RETAIN_RUNS`) only ever deletes from `runs` and `market_rows`; it never touches `factor_history` or `market_regime_history`, because the IC / decay / walk-forward engine depends on the full, unpruned history.

## Development

Run the local gate:

```bash
npm run check && npm run typecheck && npm test && npm run build
```

- `npm run check` / `npm run check:fix` -- Biome handles lint and format in one tool (2-space indent, single quotes, 100-column width; see `biome.json`).
- `npm run typecheck` -- runs each workspace's `typecheck` script (`tsc --noEmit`).
- `npm test` -- `vitest run`, covering apps/api's suite, including the two parity gates under `apps/api/tests/`.
- `npm run build` -- builds `packages/contracts`, then `apps/api`, then `apps/web`, in that order.

This is the same gate `.github/workflows/deploy-railway.yml` runs before every deploy to Railway.

Git hooks (husky + lint-staged, installed automatically by `npm install`):

- **pre-commit** -- Biome lints and formats the staged JS/TS/JSON/CSS files, fixing what it can and re-staging the result; Prettier formats staged Markdown/YAML, the only formats Biome does not cover.
- **pre-push** -- `npm run typecheck && npm test`. The build is left to CI.

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

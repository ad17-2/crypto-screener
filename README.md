# Crypto Quant Daily Screener

Signal-only crypto futures screener and dashboard for manual chart review.

The project screens liquid perpetual futures markets from CoinGlass, adds CoinGecko market context, stores every run in SQLite, and renders a daily operator dashboard for long, short, crowded-position fade, and squeeze-risk review.

It does not place trades, connect to an exchange account, request broker keys, or automate execution. Treat every output as a shortlist for manual TradingView review.

## What This Is For

Use this project at the start of the trading day to answer:

- What is the current crypto market bias?
- Which coins deserve manual chart review first?
- Is a setup long, short, crowded-long fade, or short-squeeze risk?
- Which factors drove the score?
- Is the data clean enough to trust?
- How has this symbol behaved across prior saved runs?

The dashboard is designed around this workflow:

1. Open the dashboard.
2. Start with the `Chart Next` tab.
3. Filter by quality, source, volume, OI, or funding.
4. Select a row to inspect the detail rail.
5. Open the symbol in TradingView and confirm structure manually.

## Current Capabilities

- CoinGlass futures universe collection from supported exchange pairs.
- CoinGlass pairs-market data for price, volume, funding, open interest, long/short volume, and liquidations.
- CoinGecko global market context and sector/category rotation.
- Data-quality guards for suspicious provider rows and extreme outliers.
- SQLite history for previous runs, factor IC learning, dashboard run selection, and sparklines.
- Markdown, JSON, and CSV report artifacts.
- Local and Railway-hosted dashboard.
- Railway SQLite sync helper for local-run/cloud-dashboard workflow.

## Project Layout

```text
.
|-- config/default.json              # Main screening, provider, quality, factor, report config
|-- crypto_screener/
|   |-- cli.py                       # CLI entrypoint
|   |-- pipeline.py                  # Collect -> score -> save -> report orchestration
|   |-- collector.py                 # Provider collection and enrichment orchestration
|   |-- coinglass.py                 # CoinGlass API client
|   |-- coingecko.py                 # CoinGecko API client
|   |-- quality.py                   # Sanity filters and trust scoring
|   |-- factors.py                   # Factor construction, IC weighting, regime inference
|   |-- scoring.py                   # Shared numeric helpers and scoring primitives
|   |-- report.py                    # Markdown/JSON/CSV report writer
|   |-- storage.py                   # SQLite schema, snapshots, labeled history records
|   |-- dashboard.py                 # Stdlib HTTP dashboard server and runtime
|   |-- dashboard_payload.py         # Dashboard JSON payload assembly
|   `-- dashboard_static/            # Package-local HTML, CSS, and JavaScript assets
|-- reports/.gitkeep                 # Report output directory placeholder
|-- scripts/sync_sqlite_to_railway.sh # Upload local SQLite DB to Railway volume
|-- tests/                           # Unit tests for scoring, quality, dashboard contracts
|-- railway.json                     # Railway start and healthcheck config
`-- requirements.txt                 # Intentional: stdlib-only runtime
```

The screener and dashboard use the Python standard library only. There are no required third-party Python packages.

## Requirements

- Python 3.10 or newer.
- Internet access to market data providers.
- Optional Railway CLI for deployment and database sync.
- CoinGlass API key.
- Optional CoinGecko API key.

No exchange account or trading API key is needed.

## License And Security

This project is released under the MIT license. See `LICENSE`.

Do not publish API keys, `.env` files, SQLite databases, or generated reports that may contain private operating context. See `SECURITY.md` for reporting guidance.

## Quick Start

From the repository root:

```bash
python3 -m crypto_screener.cli --config config/default.json --out-dir reports
```

The command prints a compact run summary:

```text
run_id=20260702-121038-5eb8149d
screened_symbols=80
bias=risk-on
factor_regime=mixed
weight_mode=ic
long_candidates=12
short_candidates=12
crowded_longs=4
squeeze_risks=9
markdown=reports/crypto-quant-daily-YYYYMMDD-HHMMSS.md
json=reports/crypto-quant-daily-YYYYMMDD-HHMMSS.json
csv=reports/crypto-quant-daily-YYYYMMDD-HHMMSS.csv
```

## Fast Smoke Run

Use this when checking the pipeline quickly or avoiding paid-provider usage:

```bash
python3 -m crypto_screener.cli \
  --config config/default.json \
  --out-dir reports \
  --top-symbols 25 \
  --report-limit 8 \
  --coinglass-candidate-symbols 25 \
  --no-reports \
  --no-save
```

`--no-reports` skips Markdown, JSON, and CSV artifacts. `--no-save` prevents the smoke run from polluting SQLite history.

## CLI Options

```text
--config PATH                 Config JSON path. Default: config/default.json
--out-dir DIR                 Report output directory. Default: reports
--top-symbols N               Override universe.top_symbols_by_volume
--report-limit N              Override report.limit
--min-quote-volume-usd N      Override universe.min_quote_volume_usd
--coinglass-candidate-symbols N
                              Override providers.coinglass.candidate_symbols
--no-save                     Do not save this run to SQLite history
--no-reports                  Save SQLite when enabled, but skip Markdown/JSON/CSV files
```

## API Keys

### CoinGlass

CoinGlass is required for futures collection.

```bash
export COINGLASS_API_KEY="..."
```

If unset, the screener cannot collect futures rows.

### CoinGecko

CoinGecko is optional. The public endpoint often works without a key, but a Demo key can be supplied:

```bash
export COINGECKO_API_KEY="..."
```

HTTP 429 rate limits are retried with exponential backoff and jitter. In the default config, `retry_429_max_attempts` is `0`, which means retry 429 responses until CoinGecko succeeds.

### SoSoValue

SoSoValue is currently reserved in config for future ETF-flow and sector-index integration. The code does not currently call it.

```bash
export SOSOVALUE_API_KEY="..."
```

## Default Configuration

The main config is `config/default.json`.

Key defaults:

| Area | Default |
|---|---|
| Universe | CoinGlass-supported `USDT` perpetual futures |
| Symbols | Top 80 by aggregated CoinGlass quote volume |
| Minimum 24h quote volume | `$20M` |
| CoinGlass candidate symbols | 80 |
| Minimum supported venues | 2 |
| CoinGlass request delay | 2.1 seconds |
| CoinGecko categories | 12 |
| Report rows per section | 12 |
| Core symbols | BTC, ETH, SOL |
| SQLite path | `data/crypto_screener.sqlite3` |

Stablecoins and dollar-like base assets are excluded by default.

## Data Providers

### CoinGlass

Required futures provider. Current usage builds a candidate universe from supported exchange pairs, then aggregates futures pairs-market data across configured exchanges:

- OKX
- Bybit
- Bitget
- Gate
- Hyperliquid

If CoinGlass returns suspicious values, the data-quality layer can exclude the row from ranking.

### CoinGecko

Used for broader market context:

- Total market cap.
- Market cap 24h change.
- BTC and ETH dominance.
- Category leaders and laggards.

## Pipeline Flow

```text
load config
  -> collect CoinGlass-supported futures universe
  -> collect CoinGecko global and category context
  -> aggregate CoinGlass pairs-market data by symbol
  -> apply data-quality sanity checks
  -> load prior SQLite history for factor IC labels
  -> compute factors, weights, scores, and market regime
  -> save snapshot to SQLite
  -> optionally write Markdown, JSON, and CSV reports
```

## Reports

Report artifacts are optional. They are useful for sharing, debugging, and archival review, but the dashboard reads SQLite directly and does not need them.

By default, a run writes timestamped artifacts to `reports/`:

```text
reports/crypto-quant-daily-YYYYMMDD-HHMMSS.md
reports/crypto-quant-daily-YYYYMMDD-HHMMSS.json
reports/crypto-quant-daily-YYYYMMDD-HHMMSS.csv
```

Use `--no-reports` for dashboard-only scheduled runs that should update SQLite without creating files:

```bash
python3 -m crypto_screener.cli --config config/default.json --out-dir reports --no-reports
```

### Markdown Sections

- Market Bias
- Provider Status
- Data Quality
- Factor Regime
- Dominance And Sector Rotation
- BTC / ETH / SOL Core Read
- Top Long Watchlist
- Top Short Watchlist
- Crowded Longs To Fade
- Crowded Shorts / Squeeze Risk
- Manual Chart Checklist

### CSV Fields

The CSV includes symbol, provider, price, 24h price change, quote volume, open interest, OI change, funding, long/short ratio, liquidation fields where available, factor score, long/short/crowding scores, trust state, quality score, and flags.

## SQLite Storage

Saved snapshots live in `data/crypto_screener.sqlite3` unless overridden.

Tables:

- `runs`: one row per screener run with config, provider status, market context, regime, and factor weights.
- `market_rows`: one row per symbol per run with full row JSON, factors, scores, price, and generated time.

SQLite is used for:

- Dashboard run selection.
- Recent-run history.
- Per-symbol sparklines.
- Factor IC learning against forward returns.
- Persisting cloud dashboard state through Railway volume sync.

## Factor Model

The screener builds normalized cross-sectional factors from the trusted rows in each run.

Directional factors:

- `momentum_24h`
- `reversal_1d`
- `oi_price_signal`
- `funding_rate_contrarian`
- `ls_ratio_contrarian`
- `liquidation_imbalance`
- `btc_relative_strength`

Quality/context factors:

- `liquidity_30d`
- `volume_expansion_24h`

### Weighting

On early runs, the model uses configured prior weights from `config/default.json`.

After enough labeled SQLite history exists, it can switch individual factor weights toward rolling Spearman IC against forward returns:

- Forward-return horizon: `24h`
- IC window: `30d`
- Minimum observations: `30`
- Minimum absolute IC: `0.02`
- Maximum absolute raw IC weight: `0.35`

The report and dashboard show whether the run used prior or IC-informed factor weighting.

## Watchlists

The model creates five base lists:

- `Longs`: trusted rows with positive directional factor score, ranked by `long_score`.
- `Shorts`: trusted rows with negative directional factor score, ranked by `short_score`.
- `Squeeze Risk`: crowded short conditions ranked by `squeeze_risk_score`.
- `Long Fades`: crowded long conditions ranked by `crowded_long_score`.
- `Core`: BTC, ETH, SOL regime read.

The dashboard also builds:

- `Chart Next`: a deduplicated priority queue across all lists, sorted by chart priority.

Chart priority combines the relevant score with data quality and trust state. It is not an entry signal; it is a workflow sort for manual review.

## Data Quality

Rows with critical sanity flags are excluded from factor normalization and ranking.

Default guards:

- Absolute 24h price change above `300%`.
- Absolute 24h OI change above `300%`.
- Absolute 24h volume change above `1000%`.
- Absolute funding rate above `2%`.
- Quote volume below `$10M` after enrichment.
- Missing or nonpositive price/volume fields.
- Malformed base symbol.
- Contract/quote mismatch.
- CoinGlass price deviates from index price by more than `25%`.
- CoinGlass enrichment has fewer than 2 configured exchange venues.

Flagged rows remain visible in the report and dashboard Data Quality panel so provider anomalies can be inspected manually.

## Dashboard

Run locally:

```bash
python3 -m crypto_screener.dashboard
```

Open:

```text
http://127.0.0.1:8080/
```

The dashboard is a stdlib HTTP server with package-local HTML, CSS, and JavaScript assets. It reads SQLite and does not require a frontend build step.

### Dashboard UI

The top strip shows:

- Market bias.
- Factor regime.
- Market cap 24h.
- BTC dominance.
- Trusted/excluded row count.
- Provider status.

The main watchlist surface has tabs:

- Chart Next
- Longs
- Shorts
- Squeeze Risk
- Long Fades
- Core

Filters:

- Symbol/setup text search.
- Minimum quality.
- Provider source.
- Minimum volume.
- OI positive only.
- Negative funding only.

Selecting a row opens the detail rail with:

- TradingView link using the row's primary CoinGlass venue where possible.
- Setup type.
- Score and chart priority.
- Data quality.
- 24h and OI 24h.
- Funding and long/short ratio.
- Volume and open interest.
- Reason chips.
- Factor breakdown bars.
- SQLite history sparklines.

Side modules:

- Providers.
- Data Quality.
- Sector Rotation.
- Recent Runs.

### Dashboard Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Dashboard web port |
| `HOST` | `0.0.0.0` | Bind host |
| `CRYPTO_SCREENER_CONFIG` | `config/default.json` | Config file path |
| `CRYPTO_SCREENER_DB_PATH` | Config `storage_path` | SQLite database path |
| `CRYPTO_SCREENER_REPORT_DIR` | `reports` | Runtime work directory; dashboard refresh skips report files |
| `CRYPTO_DASHBOARD_LIMIT` | Config `report.limit` | Rows per watchlist |
| `CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS` | `0` | Auto-run screener when latest run is older than this many seconds |
| `CRYPTO_DASHBOARD_DAILY_REFRESH_TIME` | unset | Daily refresh time in `HH:MM`; takes precedence over interval refresh |
| `CRYPTO_DASHBOARD_REFRESH_TZ` | `Asia/Jakarta` | Timezone for daily refresh scheduling |
| `CRYPTO_DASHBOARD_RETAIN_RUNS` | `0` | Keep only this many newest SQLite runs after each successful refresh; `0` disables pruning |
| `CRYPTO_DASHBOARD_REFRESH_TOKEN` | unset | Enables protected manual refresh API |

### Dashboard API

```text
GET  /                              HTML dashboard
GET  /assets/dashboard.css          Dashboard stylesheet
GET  /assets/dashboard.js           Dashboard JavaScript
GET  /health                        Health and database existence
GET  /api/dashboard                 Latest dashboard payload
GET  /api/dashboard?run_id=...      Specific run payload
POST /api/refresh                   Queue screener refresh when token is configured
```

Manual refresh requires `CRYPTO_DASHBOARD_REFRESH_TOKEN` and either:

```bash
curl -X POST \
  -H "Authorization: Bearer $CRYPTO_DASHBOARD_REFRESH_TOKEN" \
  http://127.0.0.1:8080/api/refresh
```

or:

```bash
curl -X POST \
  -H "X-Refresh-Token: $CRYPTO_DASHBOARD_REFRESH_TOKEN" \
  http://127.0.0.1:8080/api/refresh
```

## Railway Deployment

`railway.json` configures Railway to run:

```bash
python -m crypto_screener.dashboard
```

with `/health` as the healthcheck path.

Typical deploy:

```bash
railway up --detach --message "Update crypto dashboard"
```

Useful checks:

```bash
railway deployment list --json
railway logs
curl -fsS https://<your-railway-domain>/health
```

### Railway Volume

For persistent dashboard history, mount a Railway volume and use paths under `/data`:

```bash
CRYPTO_SCREENER_DB_PATH=/data/crypto_screener.sqlite3
CRYPTO_SCREENER_REPORT_DIR=/data/reports
```

To let Railway refresh itself once per day at 06:00 Asia/Jakarta, keeping only the latest saved run, set:

```bash
CRYPTO_DASHBOARD_DAILY_REFRESH_TIME=06:00
CRYPTO_DASHBOARD_REFRESH_TZ=Asia/Jakarta
CRYPTO_DASHBOARD_RETAIN_RUNS=1
```

The daily scheduler runs the screener after the configured local time when the latest SQLite snapshot is older than that day's scheduled run. The dashboard refresh path saves SQLite only and does not write Markdown, JSON, or CSV files. If CoinGecko returns HTTP 429 during refresh, the CoinGecko client backs off with jitter and keeps retrying until the market and sector context request succeeds.

### Local Backend, Railway Frontend Pattern

If you prefer local collection with a cloud-hosted dashboard, run the screener locally and sync SQLite to Railway:

```bash
python3 -m crypto_screener.cli --config config/default.json --out-dir reports --no-reports
scripts/sync_sqlite_to_railway.sh data/crypto_screener.sqlite3
```

The sync script:

1. Gzips and base64-encodes the local SQLite database.
2. Uploads it in chunks over `railway ssh`.
3. Runs `pragma quick_check` on the remote temp DB.
4. Atomically moves it into `CRYPTO_SCREENER_DB_PATH`.

Environment knobs:

| Variable | Default | Purpose |
|---|---|---|
| `CRYPTO_SCREENER_DB_PATH` | `/data/crypto_screener.sqlite3` | Remote Railway DB path |
| `RAILWAY_SYNC_CHUNK_SIZE` | `50000` | Upload chunk size |

## Testing And Validation

Run the full test suite:

```bash
python3 -m unittest discover -s tests
```

Compile all package modules:

```bash
python3 -m py_compile crypto_screener/*.py
```

Validate dashboard JavaScript syntax:

```bash
node --check crypto_screener/dashboard_static/dashboard.js
```

Local dashboard smoke check:

```bash
PORT=8097 HOST=127.0.0.1 python3 -m crypto_screener.dashboard
curl -fsS http://127.0.0.1:8097/health
curl -fsS http://127.0.0.1:8097/assets/dashboard.css
curl -fsS http://127.0.0.1:8097/assets/dashboard.js
curl -fsS http://127.0.0.1:8097/api/dashboard
```

## Troubleshooting

### CoinGlass API key is missing

Set `COINGLASS_API_KEY`. CoinGlass is required for futures collection.

### CoinGlass rate limits or slow runs

Reduce the candidate symbol count or keep the default delay:

```bash
python3 -m crypto_screener.cli \
  --config config/default.json \
  --out-dir reports \
  --coinglass-candidate-symbols 25
```

### Dashboard says no saved runs

Check the database path:

```bash
ls -lh data/crypto_screener.sqlite3
echo "$CRYPTO_SCREENER_DB_PATH"
```

Then run a normal save-enabled screener:

```bash
python3 -m crypto_screener.cli --config config/default.json --out-dir reports
```

### Dashboard refresh is forbidden

`POST /api/refresh` only works when `CRYPTO_DASHBOARD_REFRESH_TOKEN` is set and the request sends the matching token.

### Suspicious symbols appear in Data Quality

This is expected. The quality layer keeps flagged rows visible for inspection, but excludes untrusted rows from factor normalization and ranking.

### History sparklines say more runs are needed

The selected symbol has fewer than two saved rows in SQLite for the chosen run. Let scheduled runs accumulate or select a newer run with more history.

## Manual Chart Checklist

Before acting on any watchlist row:

- Confirm higher-timeframe trend.
- Identify key support/resistance and invalidation.
- Check whether BTC regime agrees with the alt setup.
- Reject entries extended far from invalidation.
- Treat funding and long/short crowding as context, not standalone entries.
- Size down or skip when provider quality is degraded.

## Safety Boundary

This repository is for market analysis and manual review only. It does not and should not:

- Place orders.
- Hold exchange trading credentials.
- Manage positions.
- Decide trade sizing.
- Replace manual chart confirmation.

Keep the workflow signal-only unless this boundary is intentionally redesigned.

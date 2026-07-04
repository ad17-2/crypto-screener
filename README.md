# Crypto Quant Daily Screener

Signal-only crypto futures screener and dashboard for manual chart review.

The project screens liquid perpetual futures markets from CoinGlass, adds CoinGecko market context, stores SQLite snapshots and compact factor history, and renders a daily operator dashboard for long, short, crowded-position fade, and squeeze-risk review.

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
2. Start with the `Top Setups` tab.
3. Filter by quality, source, volume, OI, or funding.
4. Select a row to inspect the detail rail.
5. Open the symbol in TradingView and confirm structure manually.

## Current Capabilities

- CoinGlass futures universe collection from supported exchange pairs.
- CoinGlass pairs-market data for price, volume, funding, open interest, long/short volume, and liquidations.
- CoinGlass OHLC price-history enrichment for 4h technical indicators.
- CoinGlass 4h historical OI, funding, liquidation, and taker buy/sell features for stronger derivatives confirmation.
- Compact historical backfill into `factor_history` without creating fake dashboard runs.
- CoinGecko global market context, sector/category rotation, and breadth summaries.
- Data-quality guards for suspicious provider rows and extreme outliers.
- Regime-aware scoring that adjusts factor emphasis for momentum, reversal, crowding, and broad market tape.
- Signal conflict labels for rows where technicals, derivatives, breadth, or regime disagree with model direction.
- Validation metrics from labeled factor history, including rolling model/factor hit-rate context.
- Confidence scoring that combines factor strength, liquidity, data quality, 4h technical alignment, derivatives, breadth, and conflicts.
- SQLite storage with full latest-run dashboard rows plus compact factor history for IC learning and sparklines.
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
|   |-- market.py                    # Market breadth and sector-rotation summaries
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
| CoinGlass technical candles | 4h interval, 220 candles, top 40 rows |
| CoinGlass derivative history | 4h interval, 220 rows, top 25 rows |
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

The provider also fetches 4h price-history candles for top rows and derives EMA trend, RSI, MACD histogram, ATR, Bollinger position, Bollinger width, and a compact technical setup label. The default interval is `4h` to stay compatible with the CoinGlass Hobbyist tier's price-history interval limits.

For top rows, the provider also fetches CoinGlass historical derivatives series at the same `4h` interval:

- Aggregated open interest history.
- Open-interest-weighted funding history.
- Aggregated liquidation history.
- Aggregated taker buy/sell volume history.

These fields are used as model confirmation signals; they do not change dashboard layout.

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
  -> enrich top rows with CoinGlass 4h OHLC technicals
  -> enrich top rows with CoinGlass 4h derivatives history
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

The CSV includes symbol, provider, price, 24h price change, quote volume, open interest, OI change, funding, long/short ratio, liquidation fields where available, factor score, confidence, technical setup and indicators, long/short/crowding scores, trust state, quality score, and flags.

## SQLite Storage

Saved snapshots live in `data/crypto_screener.sqlite3` unless overridden.

Tables:

- `runs`: one row per screener run with config, provider status, market context, regime, and factor weights.
- `market_rows`: one row per symbol per run with full row JSON, factors, scores, price, and generated time.
- `factor_history`: compact per-symbol factor, score, and indicator history retained independently from full dashboard row retention.

SQLite is used for:

- Dashboard run selection.
- Recent-run history for retained full runs.
- Per-symbol sparklines.
- Factor IC learning against forward returns.
- Persisting cloud dashboard state through Railway volume sync.

When `CRYPTO_DASHBOARD_RETAIN_RUNS=1`, the dashboard keeps only the newest full snapshot in `runs` and `market_rows`, while `factor_history` remains available for rolling factor learning and lightweight sparklines.

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
- `technical_trend_4h`
- `technical_momentum_4h`
- `oi_acceleration_signal`
- `funding_persistence_contrarian`
- `taker_flow_24h`
- `liquidation_pressure_24h`

Quality/context factors:

- `liquidity_30d`
- `volume_expansion_24h`
- `volatility_expansion_4h`

### Weighting

On early runs, the model uses configured prior weights from `config/default.json`.

After enough labeled SQLite history exists, it can switch individual factor weights toward rolling Spearman IC against forward returns:

- Forward-return horizon: `24h`
- IC window: `30d`
- Minimum observations: `30`
- Minimum absolute IC: `0.02`
- Maximum absolute raw IC weight: `0.35`

The report and dashboard show whether the run used prior or IC-informed factor weighting.

### Regime And Conflict Layer

Each run also derives market breadth from the trusted futures universe:

- Advancers versus decliners.
- Average and volume-weighted 24h return.
- Open-interest expansion breadth.
- CoinGecko category momentum when available.

That breadth is folded into the market bias and stored in `market_context.breadth`. CoinGecko category leaders and laggards are also summarized in `market_context.sector_rotation`.

Before scoring rows, the model applies conservative regime multipliers:

- Momentum regimes emphasize price/OI confirmation, 4h trend, technical momentum, taker flow, and OI acceleration.
- Reversal regimes emphasize reversal, funding contrarian, long/short contrarian, and liquidation pressure.
- Crowding-contrarian regimes emphasize funding persistence, long/short crowding, and liquidation imbalance.
- Risk-on/risk-off bias adjusts trend-sensitive factors without replacing the factor model.

Rows also receive:

- `signal_conflict_label`: `aligned`, `minor-conflict`, `mixed-signals`, `high-conflict`, `neutral`, or `excluded`.
- `signal_conflict_score`: 0 to 100 conflict severity.
- `regime_alignment_score`: whether the row direction agrees with market bias.
- `breadth_alignment_score`: whether the row direction agrees with market breadth.

These fields are additive and are stored inside existing SQLite JSON columns.

### Validation Metrics

When `factor_history` has enough labeled forward-return observations, the model reports validation context under `factor_weights.validation`:

- Observation count.
- Forward-return horizon.
- Model directional hit rate.
- Per-factor directional hit rates.
- Long-side and short-side hit-rate splits when available.

This is diagnostic only. It helps judge whether current weighting has historical support; it is not an execution rule.

## Watchlists

The model creates five base lists:

- `Longs`: trusted rows with positive directional factor score, ranked by `long_score`.
- `Shorts`: trusted rows with negative directional factor score, ranked by `short_score`.
- `Squeeze Risk`: crowded short conditions ranked by `squeeze_risk_score`.
- `Long Fades`: crowded long conditions ranked by `crowded_long_score`.
- `Core`: BTC, ETH, SOL regime read.

The dashboard also builds:

- `Top Setups`: a deduplicated priority queue across all lists, sorted by chart priority.

Chart priority combines the relevant score with data quality and trust state. It is not an entry signal; it is a workflow sort for manual review.

Each row also has a `confidence_score` from 0 to 100. It rewards stronger directional factors, better liquidity, clean data, and alignment between the factor side, 4h technical trend/momentum, derivatives, and market breadth. It penalizes conflicting signals. Treat confidence as a sorting aid, not a trade trigger.

## Historical Backfill

Backfill writes compact model history only. It does not insert into `runs` or `market_rows`, so the dashboard continues showing the latest real snapshot while `factor_history` gains more observations for IC learning and future backtests.

Dry-run the default core-symbol backfill:

```bash
python3 -m crypto_screener.backfill --config config/default.json --dry-run
```

Backfill a specific universe:

```bash
python3 -m crypto_screener.backfill \
  --config config/default.json \
  --symbols BTC,ETH,SOL,SUI,HYPE,LINK \
  --interval 4h \
  --limit 220
```

The backfill command:

- Fetches CoinGlass price, OI, funding, liquidation, and taker buy/sell histories.
- Builds synthetic cross-sectional snapshots by timestamp.
- Reuses the same factor model and scoring code.
- Stores deterministic `backfill-YYYYMMDDHHMM` compact records in `factor_history`.
- Skips cross-sections with fewer than `--min-cross-section` symbols.

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

- Top Setups
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

Historical sparklines stay in the detail rail, so newly rotating symbols do not fill the main watchlist table with missing-history states.

Selecting a row opens the detail rail with:

- TradingView link using the row's primary CoinGlass venue where possible.
- Setup type.
- Score and chart priority.
- Confidence score.
- Data quality.
- 24h and OI 24h.
- Funding and long/short ratio.
- Volume and open interest.
- 4h technical setup, RSI, MACD histogram, ATR, Bollinger state, EMA20 distance, trend score, and momentum score.
- Reason chips.
- Signal conflict label when the setup has meaningful disagreement.
- Factor breakdown bars.
- SQLite history sparklines.

Side modules:

- Providers.
- Data Quality.
- Sector Rotation, including breadth and sector-tape labels.
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
| `CRYPTO_DASHBOARD_DAILY_REFRESH_TIME` | unset | Daily refresh time or comma-separated times in `HH:MM`; takes precedence over interval refresh |
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

To let Railway refresh itself three times per workday in Asia/Jakarta, keeping only the latest saved full run, set:

```bash
CRYPTO_DASHBOARD_DAILY_REFRESH_TIME=07:10,11:10,15:10
CRYPTO_DASHBOARD_REFRESH_TZ=Asia/Jakarta
CRYPTO_DASHBOARD_RETAIN_RUNS=1
```

The daily scheduler runs the screener after each configured local time when the latest SQLite snapshot is older than that scheduled run. The dashboard refresh path saves SQLite only and does not write Markdown, JSON, or CSV files. If CoinGecko returns HTTP 429 during refresh, the CoinGecko client backs off with jitter and keeps retrying until the market and sector context request succeeds.

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

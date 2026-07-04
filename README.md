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

The intended workflow is:

1. Open the dashboard or latest report.
2. Start with `Top Setups`.
3. Check long, short, crowded-long fade, and short-squeeze tabs.
4. Inspect factor reasons, data quality, and signal conflicts.
5. Confirm the setup manually on a chart before doing anything.

## What It Produces

- A SQLite database at `data/crypto_screener.sqlite3` by default.
- Optional Markdown, JSON, and CSV reports under `reports/`.
- A local or Railway-hosted dashboard.
- Compact factor history for rolling validation and sparklines.

Core dashboard/report sections:

- Market Bias
- Factor Regime
- Dominance And Sector Rotation
- BTC / ETH / SOL Core Read
- Top Long Watchlist
- Top Short Watchlist
- Crowded Longs To Fade
- Crowded Shorts / Squeeze Risk

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
- BTC-relative strength.
- 4h technical trend and momentum.
- Historical OI, funding, liquidation, and taker-flow confirmation.
- Market breadth and sector rotation.

Rows that fail sanity checks remain visible for inspection but are excluded from trusted ranking.

## For The Curious: The Quant Logic

This screener is built as an attention allocator, not as a trade executor. The core assumption is that a daily operator does not need another table of the biggest gainers and losers. They need a short list of markets where price, positioning, crowding, and regime create something worth inspecting manually.

Crypto perpetual futures are useful for this because they expose more than price. A spot chart can show that a coin moved. Perpetual data can add whether traders are adding leverage, whether the move is supported by open interest, whether funding has become one-sided, whether liquidations are pressuring one side, and whether taker flow is confirming or fading the move. None of those fields is a standalone signal. Together they describe the state of the auction.

The model starts with liquidity and data quality. Thin or malformed markets can look exciting because bad data creates extreme factors. Those rows are still shown, because bad provider data is operationally useful to see, but they are not allowed to drive trusted rankings.

After quality checks, the screener builds a cross-sectional view of the current futures universe. Each symbol is compared against the rest of the market instead of judged in isolation. That matters because a `+4%` move can mean very different things when the whole tape is up `+6%` versus when most coins are red. The model normalizes factor values so that momentum, reversal, open-interest behavior, funding, long/short crowding, technical state, and derivatives pressure can be combined without one raw unit dominating the score.

The directional read asks a simple question: is this symbol showing useful long or short pressure relative to the rest of the market? Price plus open interest is the first layer. Rising price with rising OI can mean fresh participation; falling price with rising OI can mean active downside positioning. Reversal factors look for stretched one-day moves. BTC-relative strength asks whether the symbol is actually leading or just following the benchmark.

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
- "Does BTC, sector breadth, and market regime agree with the idea?"

That is the intended edge: reduce the market to a defensible review queue, make the reasoning inspectable, and keep the final decision outside the code.

## Requirements

- Python 3.10 or newer.
- Runtime dependencies from `requirements.txt`.
- CoinGlass API key for fresh futures collection.
- Optional CoinGecko API key.
- Optional Railway CLI for cloud deployment and SQLite sync.

Runtime dependencies are intentionally small:

- `httpx` for provider HTTP clients.
- `pydantic` for config and payload validation.

No exchange account or trading API key is needed.

## Setup

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
```

Provider keys:

```bash
export COINGLASS_API_KEY="..."
export COINGECKO_API_KEY="..." # optional
```

## Run The Screener

Normal report-producing run:

```bash
python -m crypto_screener.cli --config config/default.json --out-dir reports
```

Dashboard-only run, with no Markdown/JSON/CSV artifacts:

```bash
python -m crypto_screener.cli \
  --config config/default.json \
  --out-dir reports \
  --no-reports
```

Fast smoke run without saving history:

```bash
python -m crypto_screener.cli \
  --config config/default.json \
  --out-dir reports \
  --top-symbols 25 \
  --report-limit 8 \
  --coinglass-candidate-symbols 25 \
  --no-reports \
  --no-save
```

Expected CLI summary shape:

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

Useful CLI flags:

```text
--config PATH
--out-dir DIR
--top-symbols N
--report-limit N
--min-quote-volume-usd N
--coinglass-candidate-symbols N
--no-save
--no-reports
```

## Dashboard

Run locally:

```bash
python -m crypto_screener.dashboard
```

Open:

```text
http://127.0.0.1:8080/
```

The dashboard is a stdlib Python HTTP server with packaged HTML, CSS, and JavaScript. It reads SQLite directly and does not need a frontend build.

Main routes:

```text
GET  /                         HTML dashboard
GET  /assets/dashboard.css     Stylesheet
GET  /assets/dashboard.js      JavaScript
GET  /health                   Health and database status
GET  /api/dashboard            Latest dashboard payload
GET  /api/dashboard?run_id=... Specific run payload
POST /api/refresh              Protected manual refresh
```

Use `GET` for health checks. Some Railway hosts do not handle `HEAD` reliably.

Dashboard environment:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Web port |
| `HOST` | `0.0.0.0` | Bind host |
| `CRYPTO_SCREENER_CONFIG` | `config/default.json` | Config path |
| `CRYPTO_SCREENER_DB_PATH` | Config `storage_path` | SQLite path |
| `CRYPTO_SCREENER_REPORT_DIR` | `reports` | Runtime work directory |
| `CRYPTO_DASHBOARD_LIMIT` | Config `report.limit` | Rows per list |
| `CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS` | `0` | Interval refresh threshold |
| `CRYPTO_DASHBOARD_DAILY_REFRESH_TIME` | unset | One or more `HH:MM` daily refresh times |
| `CRYPTO_DASHBOARD_REFRESH_TZ` | `Asia/Jakarta` | Refresh timezone |
| `CRYPTO_DASHBOARD_RETAIN_RUNS` | `0` | Keep newest N full runs after refresh |
| `CRYPTO_DASHBOARD_REFRESH_TOKEN` | unset | Required token for `POST /api/refresh` |

## Railway

`railway.json` deploys the dashboard with:

```bash
python -m crypto_screener.dashboard
```

The Railway healthcheck path is `/health`. Runtime dependencies install from `requirements.txt`; `.python-version` pins the Railway/GitHub runtime to Python 3.11.

Deploy:

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
CRYPTO_DASHBOARD_DAILY_REFRESH_TIME=07:10,11:10,15:10
CRYPTO_DASHBOARD_REFRESH_TZ=Asia/Jakarta
CRYPTO_DASHBOARD_RETAIN_RUNS=1
```

Dashboard boot, `/health`, static assets, and `/api/dashboard` can work from an existing SQLite database without provider keys. Provider keys are required when the service runs a fresh screener refresh.

## Local Run, Cloud Dashboard

A common operating mode is to run the screener locally, then sync SQLite to Railway:

```bash
python -m crypto_screener.cli --config config/default.json --out-dir reports --no-reports
scripts/sync_sqlite_to_railway.sh data/crypto_screener.sqlite3
```

The sync script uploads the local SQLite database over `railway ssh`, checks the remote temporary DB with `pragma quick_check`, then atomically moves it into `CRYPTO_SCREENER_DB_PATH`.

## Backfill

Backfill writes compact factor history only. It does not create fake dashboard runs.

Dry run:

```bash
python -m crypto_screener.backfill --config config/default.json --dry-run
```

Specific symbols:

```bash
python -m crypto_screener.backfill \
  --config config/default.json \
  --symbols BTC,ETH,SOL,SUI,HYPE,LINK \
  --interval 4h \
  --limit 220
```

## Project Structure

```text
config/default.json        Main config
crypto_screener/cli.py     CLI entrypoint
crypto_screener/pipeline.py
crypto_screener/collector.py
crypto_screener/factors.py
crypto_screener/report.py
crypto_screener/storage.py
crypto_screener/dashboard.py
crypto_screener/dashboard_static/
scripts/sync_sqlite_to_railway.sh
tests/
railway.json
pyproject.toml
requirements.txt
```

The code is split around stable boundaries:

- Provider clients: `coinglass.py`, `coingecko.py`.
- Collection/enrichment: `collector.py`, `coinglass_enrichment.py`, `coinglass_pairs.py`.
- Scoring: `factors.py`, `factor_definitions.py`, `factor_explanations.py`, `scoring.py`.
- Dashboard shaping: `dashboard_payload.py`, `dashboard_rows.py`, `dashboard_taxonomy.py`, `dashboard_freshness.py`.
- Persistence: `storage.py`.

## Development

Install dev tools:

```bash
python -m pip install -e ".[dev]"
```

Run the local gate:

```bash
python -m unittest discover -s tests -v
python -m py_compile crypto_screener/*.py
node --check crypto_screener/dashboard_static/dashboard.js
python -m ruff check .
python -m ruff format --check .
python -m mypy crypto_screener
```

Local dashboard smoke:

```bash
PORT=8097 HOST=127.0.0.1 python -m crypto_screener.dashboard
curl -fsS http://127.0.0.1:8097/health
curl -fsS http://127.0.0.1:8097/
curl -fsS http://127.0.0.1:8097/assets/dashboard.css
curl -fsS http://127.0.0.1:8097/assets/dashboard.js
curl -fsS http://127.0.0.1:8097/api/dashboard
```

GitHub Actions runs the same dependency install, unit tests, Python compile check, Ruff, mypy, and dashboard JavaScript syntax check before Railway deploy.

## Security

- Do not commit `.env`, API keys, SQLite databases, or generated reports with private operating context.
- Do not add broker or exchange trading-key requirements to this project.
- Keep outputs signal-only and manually reviewed.

## License

MIT. See `LICENSE`.

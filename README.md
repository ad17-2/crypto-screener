# Crypto Quant Daily Screener

Signal-only crypto market report for manual chart review. It does not place trades.

Version 2 is a daily quant screening pipeline:

1. Collect a liquid USD-M perpetual universe from Binance public endpoints.
2. Optionally enrich the top symbols with CoinGlass futures data when `COINGLASS_API_KEY` is set.
3. Pull global market and category context from CoinGecko.
4. Persist each run to SQLite so later runs can calculate factor IC against forward returns.
5. Rank long, short, crowded-long, and squeeze-risk watchlists for manual chart confirmation.

## Run

```bash
cd /Users/adtzy/Personal/crypto-screener
python3 -m crypto_screener.cli --config config/default.json --out-dir reports
```

Fast smoke test:

```bash
python3 -m crypto_screener.cli \
  --config config/default.json \
  --out-dir reports \
  --top-symbols 25 \
  --depth-symbols 5 \
  --report-limit 8 \
  --disable-coinglass
```

## API Keys

CoinGlass is optional but recommended:

```bash
export COINGLASS_API_KEY="..."
```

CoinGecko is optional. The public endpoint often works without a key, but a Demo key can be supplied:

```bash
export COINGECKO_API_KEY="..."
```

SoSoValue is reserved in config for ETF-flow and sector-index data once official API access is available:

```bash
export SOSOVALUE_API_KEY="..."
```

## Output

Each run writes timestamped files into `reports/`:

- Markdown daily report
- JSON payload
- CSV ranked rows

Snapshots are stored in `data/crypto_screener.sqlite3`. The first runs use prior factor weights. After enough labeled snapshots exist, the report switches factor weights toward rolling Spearman IC against the configured forward-return horizon.

## Factors

Directional factors:

- `momentum_24h`
- `reversal_1d`
- `oi_price_signal`
- `funding_rate_contrarian`
- `ls_ratio_contrarian`
- `liquidation_imbalance`
- `btc_relative_strength`

Quality factors:

- `liquidity_30d`
- `volume_expansion_24h`

The report is intended to narrow the universe. Final entries still require manual chart structure, key level, invalidation, and BTC regime checks.

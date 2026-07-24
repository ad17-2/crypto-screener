import type { CoinGlassConfig } from '../config/index.js';
import type { CoinGlassClient, CoinGlassHistoryRow } from '../providers/coinglass.js';
import { collectProviderError } from '../providers/errors.js';
import { sleep } from '../providers/http.js';
import type { PriceBar } from './correlation.js';
import { closeSeries, returnStats } from './correlation.js';
import { derivativesSnapshot } from './derivatives.js';
import { toFloat } from './scoring.js';
import { technicalSnapshot } from './technicals.js';
import type { Row } from './types.js';

// A provider failure for one row is captured into `status[...]`, not thrown -- must not abort the whole run.
export type ProviderStatus = Record<string, unknown>;

// ~10 days of 4h bars; below this the correlation is too noisy to report.
const MIN_CORR_PAIRS = 60;

export async function appendCoinglassTechnicals(
  rows: Row[],
  client: CoinGlassClient,
  providerCfg: CoinGlassConfig,
  status?: ProviderStatus,
): Promise<void> {
  const technicalCfg = providerCfg.technical_indicators;
  if (!technicalCfg.enabled) {
    if (status) {
      status.technicals = { status: 'disabled' };
    }
    return;
  }

  const interval = technicalCfg.interval;
  const limit = technicalCfg.limit;
  const maxSymbols = technicalCfg.max_symbols;
  const requestDelay = technicalCfg.request_delay_seconds;
  // 0 means "no cap", as in long_short_ratio below. A cap here truncates the cross-section every
  // technical factor is ranked over, so it silently shrinks their IC sample rather than the universe.
  const target = maxSymbols <= 0 ? rows : rows.slice(0, maxSymbols);
  let enriched = 0;
  const errors: string[] = [];
  const seriesBySymbol = new Map<string, PriceBar[]>();

  for (const row of target) {
    const exchange = String(row.primary_exchange ?? '');
    const contractSymbol = String(row.contract_symbol ?? '');
    if (!exchange || !contractSymbol) {
      continue;
    }
    try {
      const candles = await client.priceHistory(exchange, contractSymbol, interval, limit);
      const snapshot = technicalSnapshot(candles, interval);
      if (Object.keys(snapshot).length > 0) {
        Object.assign(row, snapshot);
        enriched += 1;
      }
      const symbol = String(row.symbol ?? '');
      const series = closeSeries(candles);
      if (symbol && series.length > 0) {
        seriesBySymbol.set(symbol, series);
        if (symbol === 'BTC') {
          // Retained on the row itself (seriesBySymbol above is local to this function, used only
          // for the correlation pass below and then discarded) so pipeline/macroReaction.ts can
          // compute a macro event's BTC price reaction without a second candle fetch.
          row.price_history_bars = series;
        }
      }
    } catch (error) {
      collectProviderError(errors, error, String(row.symbol ?? contractSymbol));
    } finally {
      await sleepBetweenRequests(requestDelay);
    }
  }

  let btcCorrelationRows = 0;
  const btcBars = seriesBySymbol.get('BTC');
  if (btcBars) {
    for (const row of target) {
      const symbol = String(row.symbol ?? '');
      if (symbol === 'BTC') {
        continue; // BTC has no correlation/beta against itself
      }
      const bars = seriesBySymbol.get(symbol);
      if (!bars) {
        continue;
      }
      const stats = returnStats(bars, btcBars, MIN_CORR_PAIRS, interval);
      if (stats.correlation !== null) {
        row.btc_correlation = stats.correlation;
        btcCorrelationRows += 1;
      }
      if (stats.beta !== null) {
        row.btc_beta = stats.beta;
      }
      if (stats.gapped) {
        row.price_history_gapped = true;
      }
    }
  }

  // Correlation-structure scalars: a rival screener renders a full correlation minimum-spanning
  // tree over the coin universe and reads its topology -- a "star" (every coin hangs directly off
  // BTC) means no genuine diversification is available even across many names. mean_btc_correlation
  // vs. alt_alt_mean_correlation carries the same information without a graph. Display-only: see
  // market.ts's marketSensingSummary, which is the only consumer, for the scoring-isolation note.
  //
  // Only alt_alt_mean_correlation/alt_alt_correlation_pairs are computed here -- they genuinely
  // cannot move to market.ts because they need the raw price series (seriesBySymbol/target,
  // already in scope from the fetch loop above), which no later stage retains per-row.
  // mean_btc_correlation and correlation_spread live in market.ts instead: they're derived from
  // each row's own btc_correlation field (set in the loop above, which IS retained), averaged over
  // the same is_trusted-filtered set as the sibling market-context fields -- something this
  // function can't do, since quality.ts's applyDataQuality runs AFTER this one.
  //
  // seriesBySymbol/target are already in scope from the fetch loop above, so this costs zero new
  // HTTP calls -- the only new cost is the O(altSymbols^2) pairwise pass below, measured and
  // reported via pairwise_correlation_ms so a slow universe doesn't hide silently.
  const altSymbols = target
    .map((row) => String(row.symbol ?? ''))
    .filter((symbol) => symbol !== 'BTC' && seriesBySymbol.has(symbol));
  let altAltCorrelationSum = 0;
  let altAltCorrelationPairs = 0;
  const pairwiseStartMs = Date.now();
  for (let i = 0; i < altSymbols.length; i += 1) {
    const barsA = seriesBySymbol.get(altSymbols[i] as string) as PriceBar[];
    for (let j = i + 1; j < altSymbols.length; j += 1) {
      const barsB = seriesBySymbol.get(altSymbols[j] as string) as PriceBar[];
      const stats = returnStats(barsA, barsB, MIN_CORR_PAIRS, interval);
      // is_trusted is the wrong gate for a correlation statistic -- it flags exchange-coverage and
      // extreme-move conditions on a single row, not the series-alignment integrity a pairwise
      // correlation actually depends on. A dropped/missing candle that would mislabel a
      // multi-period move as a single-period return is what corrupts a correlation, and that's
      // already handled here by MIN_CORR_PAIRS (thin overlap) plus `gapped` (misaligned pairing,
      // see correlation.ts's resolveStep). Skipping `gapped` pairs is therefore a deliberate,
      // documented divergence from the sibling market-context fields (which key off is_trusted
      // instead) -- not an oversight.
      if (stats.correlation !== null && !stats.gapped) {
        altAltCorrelationSum += stats.correlation;
        altAltCorrelationPairs += 1;
      }
    }
  }
  const pairwiseCorrelationMs = Date.now() - pairwiseStartMs;

  const altAltMeanCorrelation =
    altAltCorrelationPairs > 0 ? altAltCorrelationSum / altAltCorrelationPairs : null;

  // rows is the only channel that survives unmodified from here through collector.ts/
  // runPipeline.ts into scoreSnapshot -- these market-wide (not BTC-specific) scalars ride on the
  // BTC row the same way price_history_bars does above. market.ts's marketSensingSummary reads
  // and deletes them before returning, so they never leak into a persisted row_json.
  const btcRow = target.find((row) => String(row.symbol ?? '') === 'BTC');
  if (btcRow) {
    btcRow.alt_alt_mean_correlation = altAltMeanCorrelation;
    btcRow.alt_alt_correlation_pairs = altAltCorrelationPairs;
  }

  if (status) {
    status.technicals = {
      status: enriched ? 'ok' : 'error',
      rows: enriched,
      candidate_symbols: target.length,
      interval,
      errors: errors.slice(0, 5),
      note: 'CoinGlass futures price OHLC technical indicators',
      btc_correlation_rows: btcCorrelationRows,
      alt_alt_mean_correlation: altAltMeanCorrelation,
      alt_alt_correlation_pairs: altAltCorrelationPairs,
      pairwise_correlation_ms: pairwiseCorrelationMs,
    };
  }
}

export async function appendCoinglassDerivativesHistory(
  rows: Row[],
  client: CoinGlassClient,
  providerCfg: CoinGlassConfig,
  status?: ProviderStatus,
): Promise<void> {
  const historyCfg = providerCfg.derivatives_history;
  if (!historyCfg.enabled) {
    if (status) {
      status.derivatives_history = { status: 'disabled' };
    }
    return;
  }

  const interval = historyCfg.interval;
  const limit = historyCfg.limit;
  const maxSymbols = historyCfg.max_symbols;
  const requestDelay = historyCfg.request_delay_seconds;
  const exchanges = providerCfg.exchanges;
  // 0 means "no cap", as in long_short_ratio below. Four factors (oi_acceleration_signal,
  // funding_persistence_contrarian, taker_flow_24h, liquidation_pressure_24h) are ranked only over
  // the rows enriched here, so a cap of 25 estimated their IC on 25 of ~48 names.
  const target = maxSymbols <= 0 ? rows : rows.slice(0, maxSymbols);
  let enriched = 0;
  const errors: string[] = [];

  for (const row of target) {
    const symbol = String(row.symbol ?? '');
    if (!symbol) {
      continue;
    }
    try {
      const oiHistory = await client.openInterestAggregatedHistory(symbol, interval, limit);
      await sleepBetweenRequests(requestDelay);
      const fundingHistory = await client.fundingOiWeightHistory(symbol, interval, limit);
      await sleepBetweenRequests(requestDelay);
      const liquidationHistory = await client.liquidationAggregatedHistory(
        exchanges,
        symbol,
        interval,
        limit,
      );
      await sleepBetweenRequests(requestDelay);
      const takerHistory = await client.aggregatedTakerBuySellHistory(
        exchanges,
        symbol,
        interval,
        limit,
      );

      const snapshot = derivativesSnapshot(
        oiHistory,
        fundingHistory,
        liquidationHistory,
        takerHistory,
        interval,
      );
      if (Object.keys(snapshot).length > 0) {
        Object.assign(row, snapshot);
        enriched += 1;
      }
    } catch (error) {
      collectProviderError(errors, error, symbol);
    } finally {
      await sleepBetweenRequests(requestDelay);
    }
  }

  if (status) {
    status.derivatives_history = {
      status: enriched ? 'ok' : 'error',
      rows: enriched,
      candidate_symbols: target.length,
      interval,
      errors: errors.slice(0, 5),
      note: 'CoinGlass historical OI/funding/liquidation/taker features',
    };
  }
}

export async function appendCoinglassLongShortRatio(
  rows: Row[],
  client: CoinGlassClient,
  providerCfg: CoinGlassConfig,
  status?: ProviderStatus,
): Promise<void> {
  const cfg = providerCfg.long_short_ratio;
  if (!cfg.enabled) {
    if (status) {
      status.long_short_ratio = { status: 'disabled' };
    }
    return;
  }

  const interval = cfg.interval;
  const limit = cfg.limit;
  const maxSymbols = cfg.max_symbols;
  const ratioExchange = cfg.ratio_exchange;
  const includeTop = cfg.include_top_trader;
  const includeTopPosition = cfg.include_top_position;
  const requestDelay = cfg.request_delay_seconds;
  const target = maxSymbols <= 0 ? rows : rows.slice(0, maxSymbols);
  let enriched = 0;
  const errors: string[] = [];

  for (const row of target) {
    const exchange = ratioExchange || String(row.primary_exchange ?? '');
    const base = String(row.base_asset ?? row.symbol ?? '');
    const quote = String(row.quote_asset ?? 'USDT');
    const pair = `${base}${quote}`;
    if (!base || !exchange) {
      continue;
    }
    try {
      const globalHistory = await client.globalLongShortAccountRatioHistory(
        exchange,
        pair,
        interval,
        limit,
      );
      const ratio = parseRatioEntry(globalHistory, [
        'global_account_long_short_ratio',
        'long_short_ratio',
        'account_long_short_ratio',
      ]);
      if (ratio !== null) {
        row.long_short_account_ratio = ratio;
        enriched += 1;
      }
      await sleepBetweenRequests(requestDelay);

      if (includeTop) {
        const topHistory = await client.topLongShortAccountRatioHistory(
          exchange,
          pair,
          interval,
          limit,
        );
        const topKeys = [
          'top_account_long_short_ratio',
          'long_short_ratio',
          'account_long_short_ratio',
        ];
        const topRatio = parseRatioEntry(topHistory, topKeys);
        if (topRatio !== null) {
          row.top_trader_long_short_ratio = topRatio;
        }
        const ratioDelta24h = parseRatioDelta(topHistory, topKeys);
        if (ratioDelta24h !== null) {
          row.top_trader_ratio_delta_24h = ratioDelta24h;
        }
        await sleepBetweenRequests(requestDelay);
      }

      if (includeTopPosition) {
        const positionHistory = await client.topLongShortPositionRatioHistory(
          exchange,
          pair,
          interval,
          limit,
        );
        const positionRatio = parseRatioEntry(positionHistory, [
          'top_position_long_short_ratio',
          'long_short_ratio',
          'position_long_short_ratio',
        ]);
        if (positionRatio !== null) {
          row.top_trader_position_ratio = positionRatio;
        }
        // No sleep here: positionHistory is the last call in the loop body, so the
        // `finally` sleep below already paces the next request (success = 3 sleeps/3 calls).
      }
    } catch (error) {
      collectProviderError(errors, error, base);
    } finally {
      await sleepBetweenRequests(requestDelay);
    }
  }

  if (status) {
    status.long_short_ratio = {
      status: enriched ? 'ok' : errors.length ? 'error' : 'empty',
      rows: enriched,
      candidate_symbols: target.length,
      exchange: ratioExchange,
      errors: errors.slice(0, 5),
      note: 'CoinGlass global + top-trader long/short account ratio',
    };
  }
}

function sleepBetweenRequests(seconds: number): Promise<void> {
  return seconds > 0 ? sleep(seconds) : Promise.resolve();
}

function parseRatioEntry(data: CoinGlassHistoryRow[], keys: string[]): number | null {
  if (data.length === 0) {
    return null;
  }
  return parseRatioValue(data.at(-1) as CoinGlassHistoryRow, keys);
}

// 24h delta at 4h bars = 6 bars back from the latest, i.e. index length-7.
const RATIO_DELTA_24H_BARS_BACK = 6;

function parseRatioDelta(data: CoinGlassHistoryRow[], keys: string[]): number | null {
  if (data.length < RATIO_DELTA_24H_BARS_BACK + 1) {
    return null;
  }
  const latest = parseRatioValue(data.at(-1) as CoinGlassHistoryRow, keys);
  const prior = parseRatioValue(
    data[data.length - 1 - RATIO_DELTA_24H_BARS_BACK] as CoinGlassHistoryRow,
    keys,
  );
  if (latest === null || prior === null) {
    return null;
  }
  return latest - prior;
}

function parseRatioValue(entry: CoinGlassHistoryRow, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFloat(entry[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

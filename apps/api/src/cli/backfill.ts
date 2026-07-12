#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from 'node:util';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { openDatabase, saveFactorHistoryRecords } from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { FactorHistoryRecordInput } from '../db/types.js';
import { selectPricePair } from '../pipeline/coinglassPairs.js';
import { candlesPerWindow, derivativesSnapshot } from '../pipeline/derivatives.js';
import { scoreSnapshot } from '../pipeline/factors.js';
import { median, pctChange, toFloat } from '../pipeline/scoring.js';
import { technicalSnapshot } from '../pipeline/technicals.js';
import type { Row } from '../pipeline/types.js';
import type { CoinGlassClient } from '../providers/coinglass.js';
import { CoinGlassHttpClient } from '../providers/coinglass.js';
import { ProviderError } from '../providers/errors.js';
import { sleep } from '../providers/http.js';
import { parseNumberFlag, runIfMain } from './support.js';

export interface BackfillCliArgs {
  config: string;
  symbols?: string | undefined;
  interval?: string | undefined;
  limit?: number | undefined;
  minCrossSection: number;
  requestDelaySeconds?: number | undefined;
  dryRun: boolean;
}

export function parseBackfillCliArgs(argv: string[]): BackfillCliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config/default.json' },
      symbols: { type: 'string' },
      interval: { type: 'string' },
      limit: { type: 'string' },
      'min-cross-section': { type: 'string', default: '3' },
      'request-delay-seconds': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });

  return {
    config: values.config as string,
    symbols: values.symbols as string | undefined,
    interval: values.interval as string | undefined,
    limit: parseNumberFlag(values.limit as string | undefined, '--limit'),
    minCrossSection: Number(values['min-cross-section']),
    requestDelaySeconds: parseNumberFlag(
      values['request-delay-seconds'] as string | undefined,
      '--request-delay-seconds',
    ),
    dryRun: values['dry-run'] as boolean,
  };
}

function dedupeSymbols(symbols: string[]): string[] {
  const result: string[] = [];
  for (const symbol of symbols) {
    const normalized = symbol.trim().toUpperCase();
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function symbolsFromArgs(rawSymbols: string | undefined, config: AppConfig): string[] {
  if (rawSymbols) {
    return dedupeSymbols(rawSymbols.split(','));
  }
  return dedupeSymbols(config.report.core_symbols);
}

interface NormalizedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_usd: number;
}

function normalizePriceCandles(candles: Record<string, unknown>[]): NormalizedCandle[] {
  const sorted = [...candles].sort(
    (a, b) => (toFloat(a.time, 0.0) ?? 0.0) - (toFloat(b.time, 0.0) ?? 0.0),
  );
  const normalized: NormalizedCandle[] = [];
  for (const candle of sorted) {
    const time = toFloat(candle.time);
    const open = toFloat(candle.open);
    const high = toFloat(candle.high);
    const low = toFloat(candle.low);
    const close = toFloat(candle.close);
    const volume = toFloat(candle.volume_usd, 0.0) ?? 0.0;
    if (time === null || open === null || high === null || low === null || close === null) {
      continue;
    }
    if (Math.min(open, high, low, close) <= 0) {
      continue;
    }
    normalized.push({ time, open, high, low, close, volume_usd: volume });
  }
  return normalized;
}

function rawCandlesUntil(
  candles: Record<string, unknown>[],
  endTime: number,
): Record<string, unknown>[] {
  return candles.filter((candle) => (toFloat(candle.time, 0.0) ?? 0.0) <= endTime);
}

/**
 * A negative `end` wraps (counts back from array length) rather than clamping to 0 -- callers
 * clamp only `start`. No test currently drives `end` negative (only 4h is covered), so a "clamp
 * both ends" cleanup would ship silently broken.
 */
function wrappingSliceSum(values: number[], start: number, end: number): number {
  const length = values.length;
  const normalize = (index: number): number => {
    const shifted = index < 0 ? index + length : index;
    return Math.min(Math.max(shifted, 0), length);
  };
  const from = normalize(start);
  const to = normalize(end);
  let total = 0;
  for (let index = from; index < to; index += 1) {
    total += values[index] as number;
  }
  return total;
}

function timestampId(timeMs: number): string {
  return formatJakartaIso(new Date(timeMs)).slice(0, 16).replace(/[-:T]/g, '');
}

export interface BackfillHistories {
  price: Record<string, unknown>[];
  oi: Record<string, unknown>[];
  funding: Record<string, unknown>[];
  liquidation: Record<string, unknown>[];
  taker: Record<string, unknown>[];
}

export function buildSymbolRows(
  symbol: string,
  exchange: string,
  contractSymbol: string,
  interval: string,
  histories: BackfillHistories,
): Row[] {
  const priceRows = normalizePriceCandles(histories.price);
  if (priceRows.length < 50) {
    return [];
  }

  const rows: Row[] = [];
  const window = candlesPerWindow(interval, 24.0);
  const window72h = candlesPerWindow(interval, 72.0);
  const closes = priceRows.map((row) => row.close);
  const rollingVolumes = priceRows.map((row) => row.volume_usd);

  priceRows.forEach((candle, index) => {
    if (index < 49) {
      return;
    }
    const timeValue = Math.trunc(candle.time);
    const priceChange =
      index >= window ? pctChange(closes[index - window] as number, closes[index] as number) : null;
    const priceChange72h =
      index >= window72h
        ? pctChange(closes[index - window72h] as number, closes[index] as number)
        : null;
    const previousVolume = wrappingSliceSum(
      rollingVolumes,
      Math.max(0, index - window * 2 + 1),
      index - window + 1,
    );
    const currentVolume = wrappingSliceSum(
      rollingVolumes,
      Math.max(0, index - window + 1),
      index + 1,
    );
    const volumeChange = previousVolume > 0 ? pctChange(previousVolume, currentVolume) : null;
    const technical = technicalSnapshot(rawCandlesUntil(histories.price, timeValue), interval);
    const derivatives = derivativesSnapshot(
      histories.oi,
      histories.funding,
      histories.liquidation,
      histories.taker,
      interval,
      timeValue,
    );

    const row: Row = {
      _time: timeValue,
      run_id: `backfill-${timestampId(timeValue)}`,
      generated_at: formatJakartaIso(new Date(timeValue)),
      symbol,
      contract_symbol: contractSymbol,
      primary_exchange: exchange,
      data_source: 'coinglass_backfill',
      is_trusted: true,
      data_quality_score: 100,
      price_usd: candle.close,
      price_change_24h_pct: priceChange,
      price_change_72h_pct: priceChange72h,
      quote_volume_usd: currentVolume,
      volume_change_percent_24h: volumeChange,
      ...technical,
      ...derivatives,
    };
    if (row.oi_change_24h_pct_history !== null && row.oi_change_24h_pct_history !== undefined) {
      row.oi_change_24h_pct = row.oi_change_24h_pct_history;
    }
    // Proxies a 24h mean onto a point-in-time rate; live rows use the instantaneous rate.
    if (row.funding_avg_24h_pct !== null && row.funding_avg_24h_pct !== undefined) {
      row.funding_rate_pct = row.funding_avg_24h_pct;
    }
    // No historical account long/short data exists -- do not alias taker flow onto
    // long_short_ratio, or ls_ratio_contrarian silently becomes a copy of taker_flow_24h.
    if (
      row.long_liquidation_usd_24h_history !== null &&
      row.long_liquidation_usd_24h_history !== undefined
    ) {
      row.long_liquidation_usd_24h = row.long_liquidation_usd_24h_history;
    }
    if (
      row.short_liquidation_usd_24h_history !== null &&
      row.short_liquidation_usd_24h_history !== undefined
    ) {
      row.short_liquidation_usd_24h = row.short_liquidation_usd_24h_history;
    }
    rows.push(row);
  });
  return rows;
}

function btcPriceChange24hPct(rows: Row[]): number | null {
  for (const row of rows) {
    if (row.symbol === 'BTC') {
      return toFloat(row.price_change_24h_pct);
    }
  }
  return null;
}

function backfillMarketContext(rows: Row[]): Record<string, unknown> {
  const atrValues = rows
    .map((row) => toFloat(row.atr_14_pct))
    .filter((value): value is number => value !== null);
  return {
    median_atr_pct: atrValues.length > 0 ? median(atrValues) : null,
    btc_price_change_24h_pct: btcPriceChange24hPct(rows),
  };
}

export function scoreBackfillRows(
  rowsByTime: Map<number, Row[]>,
  config: AppConfig,
  minCrossSection: number,
): Row[] {
  const records: Row[] = [];
  const nowMs = Date.now();
  const sortedTimes = [...rowsByTime.keys()].sort((a, b) => a - b);
  for (const timeValue of sortedTimes) {
    if (timeValue > nowMs) {
      continue;
    }
    const rows = rowsByTime.get(timeValue) as Row[];
    if (rows.length < minCrossSection) {
      continue;
    }
    const marketContext = backfillMarketContext(rows);
    const scored = scoreSnapshot(rows, marketContext, [], config).rows;
    for (const row of scored) {
      delete row._time;
      records.push(row);
    }
  }
  return records;
}

async function fetchHistories(
  client: CoinGlassClient,
  exchanges: string[],
  exchange: string,
  contractSymbol: string,
  symbol: string,
  interval: string,
  limit: number,
  requestDelay: number,
): Promise<BackfillHistories> {
  const price = await client.priceHistory(exchange, contractSymbol, interval, limit);
  await sleep(requestDelay);
  const oi = await client.openInterestAggregatedHistory(symbol, interval, limit);
  await sleep(requestDelay);
  const funding = await client.fundingOiWeightHistory(symbol, interval, limit);
  await sleep(requestDelay);
  const liquidation = await client.liquidationAggregatedHistory(exchanges, symbol, interval, limit);
  await sleep(requestDelay);
  const taker = await client.aggregatedTakerBuySellHistory(exchanges, symbol, interval, limit);
  await sleep(requestDelay);
  return { price, oi, funding, liquidation, taker };
}

export interface BackfillSummary {
  symbols_requested: number;
  timestamps: number;
  records: number;
  saved: number;
  interval: string;
  limit: number;
  errors: string[];
  dry_run: boolean;
}

/**
 * The CRYPTO_SCREENER_DB_PATH override must be applied to `config.storage_path` BEFORE the
 * COINGLASS_API_KEY check, so a missing key still surfaces the env override in `config` (locked
 * by tests/cli/backfill.test.ts). Writes only to factor_history -- never `runs`/`market_rows`.
 */
export async function runBackfill(
  config: AppConfig,
  args: BackfillCliArgs,
): Promise<BackfillSummary> {
  const dbPathEnv = process.env.CRYPTO_SCREENER_DB_PATH;
  if (dbPathEnv) {
    config.storage_path = dbPathEnv;
  }

  const providerCfg = config.providers.coinglass;
  const apiKeyEnv = providerCfg.api_key_env || 'COINGLASS_API_KEY';
  const apiKey = process.env[apiKeyEnv] ?? '';
  if (!apiKey) {
    throw new ProviderError(`${apiKeyEnv} is required for backfill`);
  }

  const historyCfg = providerCfg.derivatives_history;
  const technicalCfg = providerCfg.technical_indicators;
  const interval = args.interval || historyCfg.interval || technicalCfg.interval || '4h';
  const limit = args.limit || historyCfg.limit || technicalCfg.limit || 220;
  const requestDelay =
    args.requestDelaySeconds !== undefined
      ? args.requestDelaySeconds
      : (historyCfg.request_delay_seconds ?? providerCfg.request_delay_seconds ?? 2.1);
  const exchanges = [...providerCfg.exchanges];
  const quoteAsset = config.universe.quote_asset;
  const symbols = symbolsFromArgs(args.symbols, config);

  const client = new CoinGlassHttpClient({
    apiKey,
    baseUrl: providerCfg.base_url,
    timeoutSeconds: providerCfg.request_timeout_seconds,
  });
  const supportedPairs = await client.supportedExchangePairs();
  await sleep(requestDelay);

  const rowsByTime = new Map<number, Row[]>();
  const errors: string[] = [];
  for (const symbol of symbols) {
    try {
      const [exchange, contractSymbol] = selectPricePair(
        supportedPairs,
        exchanges,
        symbol,
        quoteAsset,
      );
      const histories = await fetchHistories(
        client,
        exchanges,
        exchange,
        contractSymbol,
        symbol,
        interval,
        limit,
        requestDelay,
      );
      const symbolRows = buildSymbolRows(symbol, exchange, contractSymbol, interval, histories);
      for (const row of symbolRows) {
        const timeValue = row._time as number;
        const existing = rowsByTime.get(timeValue);
        if (existing) {
          existing.push(row);
        } else {
          rowsByTime.set(timeValue, [row]);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(`${symbol}: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  const records = scoreBackfillRows(rowsByTime, config, args.minCrossSection);
  let saved = 0;
  if (!args.dryRun) {
    const db = openDatabase(config.storage_path);
    try {
      saved = saveFactorHistoryRecords(db, records as unknown as FactorHistoryRecordInput[]);
    } finally {
      db.close();
    }
  }

  return {
    symbols_requested: symbols.length,
    timestamps: rowsByTime.size,
    records: records.length,
    saved,
    interval,
    limit,
    errors: errors.slice(0, 10),
    dry_run: args.dryRun,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseBackfillCliArgs(argv);
  const config = loadConfig(args.config);
  const summary = await runBackfill(config, args);

  console.log(`symbols_requested=${summary.symbols_requested}`);
  console.log(`timestamps=${summary.timestamps}`);
  console.log(`records=${summary.records}`);
  console.log(`saved=${summary.saved}`);
  console.log(`interval=${summary.interval}`);
  console.log(`limit=${summary.limit}`);
  console.log(`dry_run=${summary.dry_run ? 'True' : 'False'}`);
  if (summary.errors.length > 0) {
    console.log(`errors=${JSON.stringify(summary.errors)}`);
  }
  return 0;
}

runIfMain(import.meta.url, main);

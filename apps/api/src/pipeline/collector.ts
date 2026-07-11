import type { AppConfig } from '../config/index.js';
import type { CoinGeckoClient } from '../providers/coingecko.js';
import { CoinGeckoHttpClient } from '../providers/coingecko.js';
import type { CoinGlassClient, CoinGlassPair } from '../providers/coinglass.js';
import { CoinGlassHttpClient } from '../providers/coinglass.js';
import { ProviderError } from '../providers/errors.js';
import { sleep } from '../providers/http.js';
import {
  baseFromPair,
  isLikelyPerpetualPair,
  pairSymbolMatchesQuote,
  quoteMatches,
} from './coinglassPairs.js';
import type { ProviderStatus } from './enrichment.js';
import {
  appendCoinglassDerivativesHistory,
  appendCoinglassLongShortRatio,
  appendCoinglassTechnicals,
} from './enrichment.js';
import { applyDataQuality } from './quality.js';
import { fundingAnnualizedPct, toFloat, weightedAverage } from './scoring.js';
import type { Row } from './types.js';
import { asRecord } from './types.js';

export type { ProviderStatus } from './enrichment.js';

export interface CollectResult {
  rows: Row[];
  market_context: Record<string, unknown>;
  provider_status: ProviderStatus;
}

export interface CollectDeps {
  coinglassClient?: CoinGlassClient;
  coingeckoClient?: CoinGeckoClient;
}

export async function collectMarket(
  config: AppConfig,
  deps: CollectDeps = {},
): Promise<CollectResult> {
  const status: ProviderStatus = {};
  const rows = await collectCoinglassFutures(config, status, deps.coinglassClient);
  const marketContext = await collectCoingeckoContext(config, status, deps.coingeckoClient);
  status.data_quality = applyDataQuality(rows, config);
  return { rows, market_context: marketContext, provider_status: status };
}

export async function collectCoinglassFutures(
  config: AppConfig,
  status?: ProviderStatus,
  client?: CoinGlassClient,
): Promise<Row[]> {
  const providerCfg = config.providers.coinglass;
  const universeCfg = config.universe;
  if (!providerCfg.enabled) {
    throw new ProviderError('CoinGlass provider is required for futures collection');
  }

  const apiKeyEnv = providerCfg.api_key_env || 'COINGLASS_API_KEY';
  const apiKey = process.env[apiKeyEnv] ?? '';
  if (!client && !apiKey) {
    throw new ProviderError(`${apiKeyEnv} is required for CoinGlass-only futures collection`);
  }

  const coinglassClient =
    client ??
    new CoinGlassHttpClient({
      apiKey,
      baseUrl: providerCfg.base_url,
      timeoutSeconds: providerCfg.request_timeout_seconds,
    });

  const exchanges = new Set(providerCfg.exchanges);
  const requestDelay = providerCfg.request_delay_seconds;
  const topSymbols = universeCfg.top_symbols_by_volume;
  const candidateLimit = providerCfg.candidate_symbols || topSymbols;
  const minVolume = universeCfg.min_quote_volume_usd;
  const quoteAsset = universeCfg.quote_asset;
  const minExchangeCount = providerCfg.min_exchange_count;
  const excludedBases = new Set(universeCfg.exclude_base_assets.map((item) => item.toUpperCase()));
  const coreSymbols = config.report.core_symbols.map((item) => item.toUpperCase());

  const supportedPairs = await coinglassClient.supportedExchangePairs();
  const candidateStats = coinglassCandidateStats({
    supportedPairs,
    exchanges,
    quoteAsset,
    minExchangeCount,
    excludedBases,
  });
  const candidates = rankCoinglassCandidates(candidateStats, coreSymbols, candidateLimit);

  const rows: Row[] = [];
  const errors: string[] = [];
  for (const symbol of candidates) {
    try {
      const pairs = await coinglassClient.futuresPairsMarkets(symbol);
      const aggregate = aggregateCoinglassPairs(
        pairs,
        exchanges,
        candidateStats.get(symbol) ?? null,
        quoteAsset,
      );
      const quoteVolumeUsd = toFloat(aggregate?.quote_volume_usd, 0.0) ?? 0.0;
      if (aggregate && quoteVolumeUsd >= minVolume) {
        rows.push(aggregate);
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        errors.push(`${symbol}: ${error.message}`);
      } else {
        throw error;
      }
    } finally {
      if (requestDelay > 0) {
        await sleep(requestDelay);
      }
    }
  }

  rows.sort(
    (a, b) => (toFloat(b.quote_volume_usd, 0.0) ?? 0.0) - (toFloat(a.quote_volume_usd, 0.0) ?? 0.0),
  );
  const topRows = rows.slice(0, topSymbols);
  await appendCoinglassTechnicals(topRows, coinglassClient, providerCfg, status);
  await appendCoinglassDerivativesHistory(topRows, coinglassClient, providerCfg, status);
  await appendCoinglassLongShortRatio(topRows, coinglassClient, providerCfg, status);

  if (status) {
    status.coinglass = {
      status: topRows.length ? 'ok' : 'error',
      rows: topRows.length,
      candidate_symbols: candidates.length,
      supported_symbols: candidateStats.size,
      errors: errors.slice(0, 5),
      note: 'CoinGlass futures pairs-markets primary data',
    };
  }
  return topRows;
}

export async function collectCoingeckoContext(
  config: AppConfig,
  status: ProviderStatus,
  client?: CoinGeckoClient,
): Promise<Record<string, unknown>> {
  const providerCfg = config.providers.coingecko;
  if (!providerCfg.enabled) {
    status.coingecko = { status: 'disabled' };
    return {};
  }

  const apiKey = process.env[providerCfg.api_key_env || 'COINGECKO_API_KEY'] ?? '';
  const coingeckoClient =
    client ??
    new CoinGeckoHttpClient({
      baseUrl: providerCfg.base_url,
      apiKey: apiKey || null,
      timeoutSeconds: providerCfg.request_timeout_seconds,
      retry429: providerCfg.retry_429,
      retry429InitialDelaySeconds: providerCfg.retry_429_initial_delay_seconds,
      retry429MaxDelaySeconds: providerCfg.retry_429_max_delay_seconds,
      retry429JitterSeconds: providerCfg.retry_429_jitter_seconds,
      retry429MaxAttempts: providerCfg.retry_429_max_attempts,
    });

  const context: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    const globalData = await coingeckoClient.globalData();
    Object.assign(context, normalizeCoingeckoGlobal(globalData));
  } catch (error) {
    if (error instanceof ProviderError) {
      errors.push(error.message);
    } else {
      throw error;
    }
  }

  try {
    const categories = await coingeckoClient.categories();
    context.categories = normalizeCoingeckoCategories(categories, providerCfg.categories_limit);
  } catch (error) {
    if (error instanceof ProviderError) {
      errors.push(error.message);
    } else {
      throw error;
    }
  }

  status.coingecko = {
    status: Object.keys(context).length ? 'ok' : 'error',
    errors: errors.slice(0, 5),
    note: 'global market and category context',
  };
  return context;
}

export interface CandidateStats {
  symbol: string;
  exchanges: Set<string>;
  instrumentCount: number;
  maxLeverage: number;
}

/** Exported for unit testing. */
export function coinglassCandidateStats(options: {
  supportedPairs: Record<string, CoinGlassPair[]>;
  exchanges: Set<string>;
  quoteAsset: string;
  minExchangeCount: number;
  excludedBases: Set<string>;
}): Map<string, CandidateStats> {
  const { supportedPairs, exchanges, quoteAsset, minExchangeCount, excludedBases } = options;
  const stats = new Map<string, CandidateStats>();

  for (const [exchangeName, pairs] of Object.entries(supportedPairs)) {
    if (exchanges.size > 0 && !exchanges.has(exchangeName)) {
      continue;
    }
    for (const pair of pairs) {
      const baseAsset = String(pair.base_asset ?? '').toUpperCase();
      if (!baseAsset || excludedBases.has(baseAsset)) {
        continue;
      }
      if (!quoteMatches(pair, quoteAsset)) {
        continue;
      }
      if (!isLikelyPerpetualPair(pair)) {
        continue;
      }
      let item = stats.get(baseAsset);
      if (!item) {
        item = { symbol: baseAsset, exchanges: new Set(), instrumentCount: 0, maxLeverage: 0.0 };
        stats.set(baseAsset, item);
      }
      item.exchanges.add(exchangeName);
      item.instrumentCount += 1;
      item.maxLeverage = Math.max(item.maxLeverage, toFloat(pair.max_leverage, 0.0) ?? 0.0);
    }
  }

  for (const [symbol, item] of stats) {
    if (item.exchanges.size < minExchangeCount) {
      stats.delete(symbol);
    }
  }
  return stats;
}

/** Exported for unit testing. */
export function rankCoinglassCandidates(
  candidateStats: Map<string, CandidateStats>,
  coreSymbols: string[],
  limit: number,
): string[] {
  const ranked = [...candidateStats.keys()].sort((a, b) => {
    const statsA = candidateStats.get(a) as CandidateStats;
    const statsB = candidateStats.get(b) as CandidateStats;
    if (statsA.exchanges.size !== statsB.exchanges.size) {
      return statsB.exchanges.size - statsA.exchanges.size;
    }
    if (statsA.instrumentCount !== statsB.instrumentCount) {
      return statsB.instrumentCount - statsA.instrumentCount;
    }
    if (statsA.maxLeverage !== statsB.maxLeverage) {
      return statsB.maxLeverage - statsA.maxLeverage;
    }
    if (a === b) {
      return 0;
    }
    return a > b ? -1 : 1;
  });

  const ordered: string[] = [];
  for (const symbol of [...coreSymbols, ...ranked]) {
    if (candidateStats.has(symbol) && !ordered.includes(symbol)) {
      ordered.push(symbol);
    }
    if (ordered.length >= limit) {
      break;
    }
  }
  return ordered;
}

/** Exported for unit testing. */
export function aggregateCoinglassPairs(
  pairs: CoinGlassPair[],
  exchanges: Set<string>,
  symbolStats: CandidateStats | null,
  quoteAsset: string,
): Row | null {
  const filtered = pairs.filter(
    (pair) =>
      (exchanges.size === 0 || exchanges.has(String(pair.exchange_name ?? ''))) &&
      pairSymbolMatchesQuote(pair, quoteAsset),
  );
  if (filtered.length === 0) {
    return null;
  }

  const primary = filtered.reduce((best, pair) =>
    (toFloat(pair.volume_usd, 0.0) ?? 0.0) > (toFloat(best.volume_usd, 0.0) ?? 0.0) ? pair : best,
  );
  const symbol = baseFromPair(primary, quoteAsset);
  const totalVolume = sumField(filtered, 'volume_usd');
  const totalOi = sumField(filtered, 'open_interest_usd');
  const longVolume = sumField(filtered, 'long_volume_usd');
  const shortVolume = sumField(filtered, 'short_volume_usd');
  const longLiq = sumField(filtered, 'long_liquidation_usd_24h');
  const shortLiq = sumField(filtered, 'short_liquidation_usd_24h');
  const funding = weightedAverage(filtered, 'funding_rate', 'open_interest_usd');

  return {
    symbol,
    contract_symbol: primary.instrument_id || `${symbol}${quoteAsset}`,
    base_asset: symbol,
    quote_asset: quoteAsset,
    primary_exchange: primary.exchange_name ?? null,
    data_source: 'coinglass',
    price_usd: weightedAverage(filtered, 'current_price', 'volume_usd'),
    index_price: weightedAverage(filtered, 'index_price', 'volume_usd'),
    price_change_24h_pct: weightedAverage(filtered, 'price_change_percent_24h', 'volume_usd'),
    quote_volume_usd: totalVolume,
    volume_change_percent_24h: weightedAverage(
      filtered,
      'volume_usd_change_percent_24h',
      'volume_usd',
    ),
    open_interest_usd: totalOi,
    oi_change_24h_pct: weightedAverage(
      filtered,
      'open_interest_change_percent_24h',
      'open_interest_usd',
    ),
    funding_rate_pct: funding,
    funding_annualized_pct: funding !== null ? fundingAnnualizedPct(funding / 100.0) : null,
    next_funding_time: primary.next_funding_time ?? null,
    long_volume_usd_24h: longVolume,
    short_volume_usd_24h: shortVolume,
    long_short_ratio: shortVolume > 0 ? longVolume / shortVolume : null,
    long_liquidation_usd_24h: longLiq,
    short_liquidation_usd_24h: shortLiq,
    open_interest_volume_ratio: totalVolume > 0 ? totalOi / totalVolume : null,
    coinglass_exchange_count: new Set(filtered.map((pair) => pair.exchange_name)).size,
    coinglass_instrument_count: symbolStats?.instrumentCount ?? null,
    coinglass_supported_exchange_count: symbolStats?.exchanges.size ?? 0,
  };
}

function normalizeCoingeckoGlobal(globalData: Record<string, unknown>): Record<string, unknown> {
  const totalMarketCap = asRecord(globalData.total_market_cap);
  const marketCapPercentage = asRecord(globalData.market_cap_percentage);
  return {
    total_market_cap_usd: toFloat(totalMarketCap.usd),
    market_cap_change_24h_pct: toFloat(globalData.market_cap_change_percentage_24h_usd),
    btc_dominance_pct: toFloat(marketCapPercentage.btc),
    eth_dominance_pct: toFloat(marketCapPercentage.eth),
    active_cryptocurrencies: globalData.active_cryptocurrencies ?? null,
    markets: globalData.markets ?? null,
  };
}

function normalizeCoingeckoCategories(
  categories: Record<string, unknown>[],
  limit: number,
): { leaders: Record<string, unknown>[]; laggards: Record<string, unknown>[] } {
  const normalized = categories
    .filter((item) => toFloat(item.market_cap_change_24h) !== null)
    .map((item) => ({
      id: item.id ?? null,
      name: item.name ?? null,
      market_cap_usd: toFloat(item.market_cap),
      market_cap_change_24h_pct: toFloat(item.market_cap_change_24h),
      volume_24h_usd: toFloat(item.volume_24h),
      top_3_coins: item.top_3_coins ?? [],
    }));

  const leaders = [...normalized]
    .sort((a, b) => (b.market_cap_change_24h_pct ?? 0) - (a.market_cap_change_24h_pct ?? 0))
    .slice(0, limit);
  const laggards = [...normalized]
    .sort((a, b) => (a.market_cap_change_24h_pct ?? 0) - (b.market_cap_change_24h_pct ?? 0))
    .slice(0, limit);
  return { leaders, laggards };
}

function sumField(rows: CoinGlassPair[], key: string): number {
  return rows.reduce((sum, row) => sum + (toFloat(row[key], 0.0) ?? 0.0), 0);
}

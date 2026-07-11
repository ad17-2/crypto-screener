import type { CoinGlassConfig } from '../config/index.js';
import type { CoinGlassClient, CoinGlassHistoryRow } from '../providers/coinglass.js';
import { ProviderError } from '../providers/errors.js';
import { sleep } from '../providers/http.js';
import { derivativesSnapshot } from './derivatives.js';
import { toFloat } from './scoring.js';
import { technicalSnapshot } from './technicals.js';
import type { Row } from './types.js';

// A provider failure for one row is captured into `status[...]`, not thrown -- must not abort the whole run.
export type ProviderStatus = Record<string, unknown>;

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
  let enriched = 0;
  const errors: string[] = [];

  for (const row of rows.slice(0, maxSymbols)) {
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
    } catch (error) {
      if (error instanceof ProviderError) {
        errors.push(`${row.symbol ?? contractSymbol}: ${error.message}`);
      } else {
        throw error;
      }
    } finally {
      await sleepBetweenRequests(requestDelay);
    }
  }

  if (status) {
    status.technicals = {
      status: enriched ? 'ok' : 'error',
      rows: enriched,
      candidate_symbols: Math.min(maxSymbols, rows.length),
      interval,
      errors: errors.slice(0, 5),
      note: 'CoinGlass futures price OHLC technical indicators',
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
  let enriched = 0;
  const errors: string[] = [];

  for (const row of rows.slice(0, maxSymbols)) {
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
      if (error instanceof ProviderError) {
        errors.push(`${symbol}: ${error.message}`);
      } else {
        throw error;
      }
    } finally {
      await sleepBetweenRequests(requestDelay);
    }
  }

  if (status) {
    status.derivatives_history = {
      status: enriched ? 'ok' : 'error',
      rows: enriched,
      candidate_symbols: Math.min(maxSymbols, rows.length),
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
        const topRatio = parseRatioEntry(topHistory, [
          'top_account_long_short_ratio',
          'long_short_ratio',
          'account_long_short_ratio',
        ]);
        if (topRatio !== null) {
          row.top_trader_long_short_ratio = topRatio;
        }
        await sleepBetweenRequests(requestDelay);
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        errors.push(`${base}: ${error.message}`);
      } else {
        throw error;
      }
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
  const latest = data.at(-1) as CoinGlassHistoryRow;
  for (const key of keys) {
    const value = toFloat(latest[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

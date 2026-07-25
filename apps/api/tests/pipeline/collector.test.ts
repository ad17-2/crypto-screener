import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config';
import { AppConfigSchema } from '../../src/config';
import type { EnrichmentCacheBlob } from '../../src/db/enrichmentCache';
import {
  aggregateCoinglassPairs,
  coinglassCandidateStats,
  collectCoingeckoContext,
  collectCoinglassFutures,
  collectFearGreedContext,
  collectMacroCalendarContext,
  collectMarket,
  type EnrichmentCacheDeps,
  normalizeCoingeckoCategories,
  rankCoinglassCandidates,
} from '../../src/pipeline/collector';
import { DERIVATIVES_SNAPSHOT_FIELDS } from '../../src/pipeline/derivatives';
import {
  BTC_ONLY_CACHE_FIELDS,
  CORRELATION_FIELDS,
  LONG_SHORT_FIELDS,
} from '../../src/pipeline/enrichment';
import { TECHNICAL_SNAPSHOT_FIELDS } from '../../src/pipeline/technicals';
import type { CoinGeckoClient } from '../../src/providers/coingecko';
import type {
  CoinGlassClient,
  CoinGlassHistoryRow,
  CoinGlassPair,
} from '../../src/providers/coinglass';
import { ProviderError } from '../../src/providers/errors';
import type { FearGreedClient, FearGreedSnapshot } from '../../src/providers/feargreed';
import type { ForexFactoryClient, MacroEvent } from '../../src/providers/forexfactory';
import fixture from '../fixtures/parity-run.json';

function buildConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse(overrides);
}

describe('coinglassCandidateStats + rankCoinglassCandidates', () => {
  it('filters excluded/stablecoin bases and thin exchange coverage, then ranks by coverage', () => {
    const supportedPairs: Record<string, CoinGlassPair[]> = {
      MEXC: [
        { base_asset: 'BTC', quote_asset: 'USDT', instrument_id: 'BTCUSDT', max_leverage: '125' },
        { base_asset: 'USDT', quote_asset: 'USDT', instrument_id: 'USDTUSDT', max_leverage: '1' },
        {
          base_asset: 'OLD',
          quote_asset: 'USDT',
          instrument_id: 'OLD-USDT-260101',
          max_leverage: '10',
        },
      ],
      OKX: [
        {
          base_asset: 'BTC',
          quote_asset: 'USDT',
          instrument_id: 'BTC-USDT-SWAP',
          max_leverage: '100',
        },
        {
          base_asset: 'ETH',
          quote_asset: 'USDT',
          instrument_id: 'ETH-USDT-SWAP',
          max_leverage: '100',
        },
      ],
      Bybit: [
        { base_asset: 'ETH', quote_asset: 'USDT', instrument_id: 'ETHUSDT', max_leverage: '100' },
      ],
    };

    const stats = coinglassCandidateStats({
      supportedPairs,
      exchanges: new Set(['MEXC', 'OKX', 'Bybit']),
      quoteAsset: 'USDT',
      minExchangeCount: 2,
      excludedBases: new Set(['USDT']),
    });
    const ranked = rankCoinglassCandidates(stats, ['ETH'], 2);

    // USDT excluded as a stablecoin base; OLD excluded (dated instrument id, not perpetual);
    // only BTC and ETH clear the min-exchange-count(2) bar.
    expect(new Set(stats.keys())).toEqual(new Set(['BTC', 'ETH']));
    expect(ranked).toEqual(['ETH', 'BTC']);
  });
});

describe('aggregateCoinglassPairs', () => {
  it('builds a volume-weighted cross-exchange aggregate row, keyed off the highest-volume pair', () => {
    const pairs: CoinGlassPair[] = [
      {
        symbol: 'BTC/USDT',
        instrument_id: 'BTC-USDT-SWAP',
        exchange_name: 'OKX',
        current_price: 100,
        index_price: 101,
        price_change_percent_24h: 2,
        volume_usd: 200,
        volume_usd_change_percent_24h: 5,
        open_interest_usd: 1000,
        open_interest_change_percent_24h: 4,
        funding_rate: 0.01,
        long_volume_usd: 60,
        short_volume_usd: 40,
        long_liquidation_usd_24h: 10,
        short_liquidation_usd_24h: 20,
      },
      {
        symbol: 'BTC/USDT',
        instrument_id: 'BTCUSDT',
        exchange_name: 'Bybit',
        current_price: 110,
        index_price: 109,
        price_change_percent_24h: 3,
        volume_usd: 100,
        volume_usd_change_percent_24h: 7,
        open_interest_usd: 500,
        open_interest_change_percent_24h: 6,
        funding_rate: 0.02,
        long_volume_usd: 90,
        short_volume_usd: 60,
        long_liquidation_usd_24h: 30,
        short_liquidation_usd_24h: 40,
      },
    ];

    const row = aggregateCoinglassPairs(
      pairs,
      new Set(['OKX', 'Bybit']),
      { symbol: 'BTC', exchanges: new Set(['OKX', 'Bybit']), instrumentCount: 2, maxLeverage: 0 },
      'USDT',
    );

    expect(row).not.toBeNull();
    expect(row?.symbol).toBe('BTC');
    expect(row?.data_source).toBe('coinglass');
    // OKX has the higher volume_usd (200 > 100) so it's primary.
    expect(row?.primary_exchange).toBe('OKX');
    expect(row?.quote_volume_usd).toBe(300);
    expect(row?.open_interest_usd).toBe(1500);
    // long_short_ratio = (60+90) / (40+60) = 150/100 = 1.5
    expect(row?.long_short_ratio).toBeCloseTo(1.5);
    expect(row?.coinglass_exchange_count).toBe(2);
  });

  it('excludes pairs from unconfigured exchanges and non-matching quote assets', () => {
    const pairs: CoinGlassPair[] = [
      {
        symbol: 'BTC/USDT',
        instrument_id: 'BTCUSDT',
        exchange_name: 'OKX',
        current_price: 100,
        volume_usd: 200,
      },
      {
        symbol: 'BTC/USD',
        instrument_id: 'BTCUSD',
        exchange_name: 'OKX',
        current_price: 100,
        volume_usd: 500,
      },
      {
        symbol: 'BTC/USDT',
        instrument_id: 'BTCUSDT',
        exchange_name: 'Kraken',
        current_price: 100,
        volume_usd: 900,
      },
    ];

    const row = aggregateCoinglassPairs(pairs, new Set(['OKX', 'Bybit']), null, 'USDT');

    expect(row).not.toBeNull();
    // Only the first pair matches both the exchange allowlist and the USDT quote asset.
    expect(row?.quote_volume_usd).toBe(200);
    expect(row?.coinglass_exchange_count).toBe(1);
  });

  it('returns null when no pair survives the exchange/quote filters', () => {
    const pairs: CoinGlassPair[] = [
      {
        symbol: 'BTC/USD',
        instrument_id: 'BTCUSD',
        exchange_name: 'OKX',
        current_price: 100,
        volume_usd: 200,
      },
    ];
    expect(aggregateCoinglassPairs(pairs, new Set(['OKX']), null, 'USDT')).toBeNull();
  });
});

class StubCoinGlassClient implements CoinGlassClient {
  calls: string[] = [];

  constructor(
    private readonly supportedPairs: Record<string, CoinGlassPair[]>,
    private readonly pairsBySymbol: Record<string, CoinGlassPair[]>,
    private readonly failingSymbols: Set<string> = new Set(),
  ) {}

  async supportedExchangePairs(): Promise<Record<string, CoinGlassPair[]>> {
    return this.supportedPairs;
  }

  async futuresPairsMarkets(symbol: string): Promise<CoinGlassPair[]> {
    this.calls.push(`futuresPairsMarkets:${symbol}`);
    if (this.failingSymbols.has(symbol)) {
      throw new ProviderError(`${symbol}: simulated outage`);
    }
    return this.pairsBySymbol[symbol] ?? [];
  }

  async priceHistory(
    _exchange: string,
    _symbol: string,
    _interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return Array.from({ length: limit }, (_, index) => {
      const close = 100.0 + index * 0.4;
      return { time: index, open: close - 0.2, high: close + 0.5, low: close - 0.5, close };
    });
  }

  async openInterestAggregatedHistory(
    _symbol: string,
    _interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return Array.from({ length: limit }, (_, index) => ({ time: index, close: 1000 + index }));
  }

  async fundingOiWeightHistory(
    _symbol: string,
    _interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return Array.from({ length: limit }, (_, index) => ({ time: index, close: 0.01 }));
  }

  async liquidationAggregatedHistory(
    _exchanges: string[],
    _symbol: string,
    _interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return Array.from({ length: limit }, (_, index) => ({
      time: index,
      aggregated_long_liquidation_usd: 100,
      aggregated_short_liquidation_usd: 200,
    }));
  }

  async aggregatedTakerBuySellHistory(
    _exchanges: string[],
    _symbol: string,
    _interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return Array.from({ length: limit }, (_, index) => ({
      time: index,
      aggregated_buy_volume_usd: 120,
      aggregated_sell_volume_usd: 100,
    }));
  }

  async globalLongShortAccountRatioHistory(): Promise<CoinGlassHistoryRow[]> {
    return [{ global_account_long_short_ratio: 1.8 }];
  }

  async topLongShortAccountRatioHistory(): Promise<CoinGlassHistoryRow[]> {
    return [{ top_account_long_short_ratio: 2.4 }];
  }

  async topLongShortPositionRatioHistory(): Promise<CoinGlassHistoryRow[]> {
    return [{ top_position_long_short_ratio: 3.1 }];
  }
}

function btcOkxPair(overrides: Partial<CoinGlassPair> = {}): CoinGlassPair {
  return {
    symbol: 'BTC/USDT',
    instrument_id: 'BTCUSDT',
    exchange_name: 'OKX',
    current_price: 60000,
    index_price: 60010,
    price_change_percent_24h: 1.5,
    volume_usd: 5_000_000_000,
    volume_usd_change_percent_24h: 2,
    open_interest_usd: 2_000_000_000,
    open_interest_change_percent_24h: 1,
    funding_rate: 0.01,
    long_volume_usd: 2_600_000_000,
    short_volume_usd: 2_400_000_000,
    long_liquidation_usd_24h: 1_000_000,
    short_liquidation_usd_24h: 900_000,
    next_funding_time: 1783526400000,
    ...overrides,
  };
}

const SUPPORTED_PAIRS: Record<string, CoinGlassPair[]> = {
  OKX: [
    { base_asset: 'BTC', quote_asset: 'USDT', instrument_id: 'BTC-USDT-SWAP', max_leverage: '100' },
    { base_asset: 'ETH', quote_asset: 'USDT', instrument_id: 'ETH-USDT-SWAP', max_leverage: '100' },
    { base_asset: 'USDT', quote_asset: 'USDT', instrument_id: 'USDTUSDT', max_leverage: '1' },
  ],
  Bybit: [
    { base_asset: 'BTC', quote_asset: 'USDT', instrument_id: 'BTCUSDT', max_leverage: '100' },
    { base_asset: 'ETH', quote_asset: 'USDT', instrument_id: 'ETHUSDT', max_leverage: '100' },
  ],
};

describe('collectCoinglassFutures (full pass, stubbed client)', () => {
  const config = buildConfig({
    providers: {
      coinglass: {
        exchanges: ['OKX', 'Bybit'],
        min_exchange_count: 2,
        candidate_symbols: 5,
        request_delay_seconds: 0,
        technical_indicators: { max_symbols: 5, limit: 80 },
        derivatives_history: { max_symbols: 5, limit: 40 },
        long_short_ratio: { max_symbols: 0 },
      },
    },
    universe: {
      exclude_base_assets: ['USDT', 'USDC'],
      min_quote_volume_usd: 20_000_000,
      top_symbols_by_volume: 80,
    },
    report: { core_symbols: ['BTC', 'ETH'] },
  });

  it('excludes stablecoin bases and rows below the min-quote-volume floor', async () => {
    const client = new StubCoinGlassClient(SUPPORTED_PAIRS, {
      BTC: [btcOkxPair()],
      ETH: [btcOkxPair({ symbol: 'ETH/USDT', instrument_id: 'ETHUSDT', volume_usd: 1_000_000 })], // below floor
    });
    const status: Record<string, unknown> = {};

    const rows = await collectCoinglassFutures(config, status, client);

    expect(rows.map((row) => row.symbol)).toEqual(['BTC']);
    expect((status.coinglass as { supported_symbols: number }).supported_symbols).toBe(2); // USDT excluded
  });

  it('excludes non-crypto base assets from the candidate pool, so they cost neither a universe slot nor a provider call', async () => {
    const excludeConfig = buildConfig({
      providers: {
        coinglass: {
          exchanges: ['OKX', 'Bybit'],
          min_exchange_count: 2,
          candidate_symbols: 5,
          request_delay_seconds: 0,
          technical_indicators: { max_symbols: 0 },
          derivatives_history: { max_symbols: 0 },
          long_short_ratio: { max_symbols: 0 },
        },
      },
      universe: {
        // 'msft' lower-case proves the match is case-insensitive.
        exclude_base_assets: ['USDT', 'USDC', 'msft'],
        min_quote_volume_usd: 20_000_000,
        top_symbols_by_volume: 1, // forces the slice to choose between BTC and MSFT
      },
      report: { core_symbols: [] },
    });
    const supportedPairs: Record<string, CoinGlassPair[]> = {
      OKX: [
        ...SUPPORTED_PAIRS.OKX,
        {
          base_asset: 'MSFT',
          quote_asset: 'USDT',
          instrument_id: 'MSFT-USDT-SWAP',
          max_leverage: '10',
        },
      ],
      Bybit: [
        ...SUPPORTED_PAIRS.Bybit,
        { base_asset: 'MSFT', quote_asset: 'USDT', instrument_id: 'MSFTUSDT', max_leverage: '10' },
      ],
    };
    const client = new StubCoinGlassClient(supportedPairs, {
      // MSFT has more volume than BTC, so without exclusion it would win the single top_symbols_by_volume slot.
      BTC: [btcOkxPair({ volume_usd: 1_000_000_000 })],
      MSFT: [
        btcOkxPair({ symbol: 'MSFT/USDT', instrument_id: 'MSFTUSDT', volume_usd: 5_000_000_000 }),
      ],
    });

    const rows = await collectCoinglassFutures(excludeConfig, {}, client);

    expect(rows.map((row) => row.symbol)).toEqual(['BTC']);
    expect(rows.map((row) => row.symbol)).not.toContain('MSFT');
    expect(rows).toHaveLength(1); // still fills to top_symbols_by_volume(1), not starved by the exclusion
  });

  it('records a provider failure in provider_status but keeps the run going for other symbols', async () => {
    const client = new StubCoinGlassClient(
      SUPPORTED_PAIRS,
      { BTC: [btcOkxPair()], ETH: [btcOkxPair({ symbol: 'ETH/USDT', instrument_id: 'ETHUSDT' })] },
      new Set(['ETH']),
    );
    const status: Record<string, unknown> = {};

    const rows = await collectCoinglassFutures(config, status, client);

    expect(rows.map((row) => row.symbol)).toEqual(['BTC']);
    const coinglassStatus = status.coinglass as { errors: string[] };
    expect(coinglassStatus.errors).toHaveLength(1);
    expect(coinglassStatus.errors[0]).toContain('ETH');
    expect(coinglassStatus.errors[0]).toContain('simulated outage');
  });

  it('produces a row containing every collector/enrichment/quality key the fixture expects', async () => {
    const client = new StubCoinGlassClient(SUPPORTED_PAIRS, { BTC: [btcOkxPair()] });
    const rows = await collectCoinglassFutures(config, {}, client);
    expect(rows).toHaveLength(1);

    // applyDataQuality is invoked separately -- collectCoinglassFutures doesn't call it directly.
    const { applyDataQuality } = await import('../../src/pipeline/quality');
    applyDataQuality(rows, config);

    const fixtureRow = (fixture as { input_rows: Array<Record<string, unknown>> })
      .input_rows[0] as Record<string, unknown>;
    // price_change_72h_pct is added by a later historical-lookback stage, not this boundary.
    // The other four were dropped from derivatives.ts (zero consumers anywhere downstream); the
    // frozen fixture predates that removal and still carries them.
    const droppedKeys = new Set([
      'price_change_72h_pct',
      'funding_abs_avg_24h_pct',
      'liquidation_total_24h_usd',
      'taker_buy_volume_usd_24h',
      'taker_sell_volume_usd_24h',
    ]);
    const expectedKeys = Object.keys(fixtureRow).filter((key) => !droppedKeys.has(key));

    for (const key of expectedKeys) {
      expect(rows[0]).toHaveProperty(key);
    }
  });
});

// Wraps StubCoinGlassClient to count history-method calls by method name (and log the identifier
// each was called with) -- everything else (candle/history shape, futuresPairsMarkets tracking via
// the inherited `calls`) is unchanged.
class CountingCoinGlassClient extends StubCoinGlassClient {
  historyCalls: string[] = [];

  override async priceHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`priceHistory:${symbol}`);
    return super.priceHistory(exchange, symbol, interval, limit);
  }

  override async openInterestAggregatedHistory(
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`openInterestAggregatedHistory:${symbol}`);
    return super.openInterestAggregatedHistory(symbol, interval, limit);
  }

  override async fundingOiWeightHistory(
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`fundingOiWeightHistory:${symbol}`);
    return super.fundingOiWeightHistory(symbol, interval, limit);
  }

  override async liquidationAggregatedHistory(
    exchanges: string[],
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`liquidationAggregatedHistory:${symbol}`);
    return super.liquidationAggregatedHistory(exchanges, symbol, interval, limit);
  }

  override async aggregatedTakerBuySellHistory(
    exchanges: string[],
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`aggregatedTakerBuySellHistory:${symbol}`);
    return super.aggregatedTakerBuySellHistory(exchanges, symbol, interval, limit);
  }

  override async globalLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`globalLongShortAccountRatioHistory:${symbol}`);
    return super.globalLongShortAccountRatioHistory(exchange, symbol, interval, limit);
  }

  override async topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`topLongShortAccountRatioHistory:${symbol}`);
    return super.topLongShortAccountRatioHistory(exchange, symbol, interval, limit);
  }

  override async topLongShortPositionRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.historyCalls.push(`topLongShortPositionRatioHistory:${symbol}`);
    return super.topLongShortPositionRatioHistory(exchange, symbol, interval, limit);
  }
}

describe('collectCoinglassFutures light/full enrichment cache', () => {
  const config = buildConfig({
    providers: {
      coinglass: {
        exchanges: ['OKX', 'Bybit'],
        min_exchange_count: 2,
        candidate_symbols: 5,
        request_delay_seconds: 0,
        technical_indicators: { max_symbols: 0 },
        derivatives_history: { max_symbols: 0 },
        long_short_ratio: { max_symbols: 0 },
      },
    },
    universe: {
      exclude_base_assets: ['USDT', 'USDC'],
      min_quote_volume_usd: 20_000_000,
      top_symbols_by_volume: 80,
    },
    report: { core_symbols: ['BTC', 'ETH'] },
  });

  function twoSymbolPairs(): Record<string, CoinGlassPair[]> {
    return {
      BTC: [btcOkxPair()],
      ETH: [btcOkxPair({ symbol: 'ETH/USDT', instrument_id: 'ETHUSDT' })],
    };
  }

  it('(a) light run with a warm cache covering every symbol makes zero history-method calls, but still calls pairs-markets per candidate', async () => {
    const cachedRows = {
      BTC: { technical_interval: '4h', rsi_14: 55 },
      ETH: { technical_interval: '4h', rsi_14: 48 },
    };
    const saveMock = vi.fn();
    const client = new CountingCoinGlassClient(SUPPORTED_PAIRS, twoSymbolPairs());
    const status: Record<string, unknown> = {};
    const enrichmentCache: EnrichmentCacheDeps = {
      mode: 'light',
      barTsMs: 111,
      cachedRows,
      save: saveMock,
    };

    const rows = await collectCoinglassFutures(config, status, client, enrichmentCache);

    expect(client.historyCalls).toEqual([]);
    expect(client.calls).toEqual(['futuresPairsMarkets:BTC', 'futuresPairsMarkets:ETH']);
    expect(saveMock).not.toHaveBeenCalled();
    expect(rows.find((row) => row.symbol === 'BTC')?.rsi_14).toBe(55);
    expect(rows.find((row) => row.symbol === 'ETH')?.rsi_14).toBe(48);
    expect(status.technicals).toMatchObject({
      status: 'cached',
      cache_bar_ts_ms: 111,
      rows: 2,
      delta_rows: 0,
    });
    expect(status.refresh_mode).toBe('light');
    expect(status.history_bar_ts_ms).toBe(111);
  });

  it('(b) light run with one symbol missing from the cache fetches only that symbol, overlaying the rest', async () => {
    const cachedRows = { BTC: { technical_interval: '4h', rsi_14: 55 } };
    const client = new CountingCoinGlassClient(SUPPORTED_PAIRS, twoSymbolPairs());
    const enrichmentCache: EnrichmentCacheDeps = {
      mode: 'light',
      barTsMs: 222,
      cachedRows,
      save: vi.fn(),
    };

    const rows = await collectCoinglassFutures(config, {}, client, enrichmentCache);

    // Exactly one delta symbol (ETH, not in the cache): 5 history-method calls + 3 long/short-ratio
    // calls (global + top-trader + top-position, all enabled by default in this config) = 8 total,
    // one each -- BTC (already cached) contributes zero.
    expect(client.historyCalls).toHaveLength(8);
    const methodNames = client.historyCalls.map((call) => call.split(':')[0]).sort();
    expect(methodNames).toEqual(
      [
        'aggregatedTakerBuySellHistory',
        'fundingOiWeightHistory',
        'globalLongShortAccountRatioHistory',
        'liquidationAggregatedHistory',
        'openInterestAggregatedHistory',
        'priceHistory',
        'topLongShortAccountRatioHistory',
        'topLongShortPositionRatioHistory',
      ].sort(),
    );
    expect(rows.find((row) => row.symbol === 'BTC')?.rsi_14).toBe(55); // overlaid from cache
    expect(rows.find((row) => row.symbol === 'ETH')?.technical_interval).toBe('4h'); // freshly fetched
  });

  it('(c) full run harvests every enriched symbol into the save callback, with BTC-only extras only on BTC', async () => {
    const saveMock = vi.fn();
    const client = new CountingCoinGlassClient(SUPPORTED_PAIRS, twoSymbolPairs());
    const status: Record<string, unknown> = {};
    const enrichmentCache: EnrichmentCacheDeps = {
      mode: 'full',
      barTsMs: 333,
      cachedRows: null,
      save: saveMock,
    };

    await collectCoinglassFutures(config, status, client, enrichmentCache);

    expect(status.refresh_mode).toBe('full');
    expect(status.history_bar_ts_ms).toBe(333);

    expect(saveMock).toHaveBeenCalledOnce();
    const blob = saveMock.mock.calls[0]?.[0] as EnrichmentCacheBlob;
    expect(Object.keys(blob.rows).sort()).toEqual(['BTC', 'ETH']);

    for (const key of [...TECHNICAL_SNAPSHOT_FIELDS, ...DERIVATIVES_SNAPSHOT_FIELDS]) {
      expect(blob.rows.BTC).toHaveProperty(key);
      expect(blob.rows.ETH).toHaveProperty(key);
    }
    // top_trader_ratio_delta_24h excluded: StubCoinGlassClient's top-account-ratio history is a
    // single entry, below the 7 entries parseRatioDelta needs, so that one field is legitimately
    // absent here -- see enrichment.test.ts's dedicated AccountRatioHistoryClient fixture for that
    // field's own coverage.
    for (const key of [
      'long_short_account_ratio',
      'top_trader_long_short_ratio',
      'top_trader_position_ratio',
    ] as const) {
      expect(blob.rows.BTC).toHaveProperty(key);
    }
    // BTC-only extras: price_history_bars + alt_alt_* ride only on the BTC row.
    expect(blob.rows.BTC).toHaveProperty('price_history_bars');
    expect(blob.rows.BTC).toHaveProperty('alt_alt_mean_correlation');
    expect(blob.rows.BTC).toHaveProperty('alt_alt_correlation_pairs');
    expect(blob.rows.ETH).not.toHaveProperty('price_history_bars');
    expect(blob.rows.ETH).not.toHaveProperty('alt_alt_mean_correlation');
    expect(blob.rows.ETH).not.toHaveProperty('alt_alt_correlation_pairs');

    // Upper bound: every harvested key must belong to one of the known enrichment allowlists (plus
    // BTC_ONLY_CACHE_FIELDS for BTC specifically) -- catches a field silently leaking into the cache
    // that no allowlist accounts for.
    const sharedAllowlist = new Set<string>([
      ...TECHNICAL_SNAPSHOT_FIELDS,
      ...DERIVATIVES_SNAPSHOT_FIELDS,
      ...LONG_SHORT_FIELDS,
      ...CORRELATION_FIELDS,
    ]);
    const btcAllowlist = new Set<string>([...sharedAllowlist, ...BTC_ONLY_CACHE_FIELDS]);
    for (const key of Object.keys(blob.rows.BTC as Record<string, unknown>)) {
      expect(btcAllowlist.has(key)).toBe(true);
    }
    for (const key of Object.keys(blob.rows.ETH as Record<string, unknown>)) {
      expect(sharedAllowlist.has(key)).toBe(true);
    }
  });

  it('(d) round-trip parity: fields harvested from a full run overlay onto a light run as deep-equal values', async () => {
    let harvestedBlob: EnrichmentCacheBlob | undefined;
    const fullClient = new CountingCoinGlassClient(SUPPORTED_PAIRS, twoSymbolPairs());
    const fullEnrichmentCache: EnrichmentCacheDeps = {
      mode: 'full',
      barTsMs: 444,
      cachedRows: null,
      save: (blob) => {
        harvestedBlob = blob;
      },
    };

    const fullRows = await collectCoinglassFutures(config, {}, fullClient, fullEnrichmentCache);
    expect(harvestedBlob).toBeDefined();
    const cachedRows = (harvestedBlob as EnrichmentCacheBlob).rows;

    const lightClient = new CountingCoinGlassClient(SUPPORTED_PAIRS, twoSymbolPairs());
    const lightEnrichmentCache: EnrichmentCacheDeps = {
      mode: 'light',
      barTsMs: 444,
      cachedRows,
      save: vi.fn(),
    };
    const lightRows = await collectCoinglassFutures(config, {}, lightClient, lightEnrichmentCache);

    const allowlistedKeys = [
      ...TECHNICAL_SNAPSHOT_FIELDS,
      ...DERIVATIVES_SNAPSHOT_FIELDS,
      ...LONG_SHORT_FIELDS,
      ...CORRELATION_FIELDS,
    ];
    for (const symbol of ['BTC', 'ETH']) {
      const fullRow = fullRows.find((row) => row.symbol === symbol);
      const lightRow = lightRows.find((row) => row.symbol === symbol);
      for (const key of allowlistedKeys) {
        expect(lightRow?.[key]).toEqual(fullRow?.[key]);
      }
    }
  });

  it('(e) light run whose cache lacks BTC harvests BTC as a delta row and strips its wrong-universe alt_alt_* stats', async () => {
    // Mirrors (b), but BTC (not ETH) is the symbol missing from the cache -- the common real-world
    // case where BTC's own history fetch failed on the prior full run, not the invariant-violating
    // edge case the old comment in collector.ts used to claim.
    const cachedRows = { ETH: { technical_interval: '4h', rsi_14: 48 } };
    const client = new CountingCoinGlassClient(SUPPORTED_PAIRS, twoSymbolPairs());
    const enrichmentCache: EnrichmentCacheDeps = {
      mode: 'light',
      barTsMs: 555,
      cachedRows,
      save: vi.fn(),
    };

    const rows = await collectCoinglassFutures(config, {}, client, enrichmentCache);

    // BTC went through the harvest (delta) path, not the cache overlay: it has freshly computed
    // technicals from CountingCoinGlassClient's priceHistory fixture, not ETH's cached rsi_14.
    expect(client.historyCalls.some((call) => call.startsWith('priceHistory:BTC'))).toBe(true);
    const btcRow = rows.find((row) => row.symbol === 'BTC');
    expect(btcRow?.technical_interval).toBe('4h');
    expect(btcRow?.rsi_14).not.toBe(48);

    // appendCoinglassTechnicals computed alt_alt_mean_correlation/alt_alt_correlation_pairs over
    // ONLY this tiny delta batch (the wrong universe) and stamped them onto BTC's row -- with no
    // cache entry to overlay them away. collectCoinglassFutures must strip them rather than publish
    // a non-representative market-wide stat.
    expect(btcRow).not.toHaveProperty('alt_alt_mean_correlation');
    expect(btcRow).not.toHaveProperty('alt_alt_correlation_pairs');

    // ETH is untouched: still overlaid from the cache.
    const ethRow = rows.find((row) => row.symbol === 'ETH');
    expect(ethRow?.rsi_14).toBe(48);
  });
});

describe('normalizeCoingeckoCategories', () => {
  const LIMIT = 12;
  const MIN_MARKET_CAP_USD = 100_000_000;
  const MIN_VOLUME_24H_USD = 10_000_000;

  function category(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'defi',
      name: 'DeFi',
      market_cap: 500_000_000,
      market_cap_change_24h: 4.2,
      volume_24h: 50_000_000,
      top_3_coins: [],
      ...overrides,
    };
  }

  it('drops a microcap category even when it carries a huge swing', () => {
    // NFT Index: -100.0%, mcap $0.0M, vol $0.0M -- exactly the dashboard-visible bug this floor fixes.
    const nftIndex = category({
      id: 'nft-index',
      name: 'NFT Index',
      market_cap: 12_000,
      market_cap_change_24h: -100.0,
      volume_24h: 3_000,
    });

    const { leaders, laggards } = normalizeCoingeckoCategories(
      [nftIndex],
      LIMIT,
      MIN_MARKET_CAP_USD,
      MIN_VOLUME_24H_USD,
    );

    expect(leaders).toEqual([]);
    expect(laggards).toEqual([]);
  });

  it('keeps a category that clears both the market-cap and volume floors', () => {
    const layer1 = category({
      id: 'layer-1',
      name: 'Layer 1',
      market_cap: 250_000_000,
      market_cap_change_24h: 6.5,
      volume_24h: 40_000_000,
    });

    const { leaders, laggards } = normalizeCoingeckoCategories(
      [layer1],
      LIMIT,
      MIN_MARKET_CAP_USD,
      MIN_VOLUME_24H_USD,
    );

    expect(leaders).toHaveLength(1);
    expect(leaders[0]).toMatchObject({ id: 'layer-1', market_cap_change_24h_pct: 6.5 });
    expect(laggards).toHaveLength(1);
  });

  it('drops a category with a null market_cap', () => {
    const { leaders, laggards } = normalizeCoingeckoCategories(
      [category({ id: 'unknown-mcap', market_cap: null })],
      LIMIT,
      MIN_MARKET_CAP_USD,
      MIN_VOLUME_24H_USD,
    );

    expect(leaders).toEqual([]);
    expect(laggards).toEqual([]);
  });

  it('drops a category with a null volume_24h', () => {
    const { leaders, laggards } = normalizeCoingeckoCategories(
      [category({ id: 'unknown-volume', volume_24h: null })],
      LIMIT,
      MIN_MARKET_CAP_USD,
      MIN_VOLUME_24H_USD,
    );

    expect(leaders).toEqual([]);
    expect(laggards).toEqual([]);
  });

  it('computes leaders and laggards only from survivors of the liquidity floor', () => {
    // CNY Stablecoin (+928.4%) and Farming Games (-100.0%) are the dashboard-visible garbage this
    // fix removes; Market-Making (+143.0%, mcap $2.5M, vol $0.1M) is a real measured example.
    const cnyStablecoin = category({
      id: 'cny-stablecoin',
      name: 'CNY Stablecoin',
      market_cap: 2_000_000,
      market_cap_change_24h: 928.4,
      volume_24h: 500_000,
    });
    const farmingGames = category({
      id: 'farming-games',
      name: 'Farming Games',
      market_cap: 0,
      market_cap_change_24h: -100.0,
      volume_24h: 0,
    });
    const marketMaking = category({
      id: 'market-making',
      name: 'Market-Making',
      market_cap: 2_500_000,
      market_cap_change_24h: 143.0,
      volume_24h: 100_000,
    });
    const liquidLeader = category({
      id: 'liquid-leader',
      name: 'Liquid Leader',
      market_cap: 300_000_000,
      market_cap_change_24h: 13.0,
      volume_24h: 20_000_000,
    });
    const liquidLaggard = category({
      id: 'liquid-laggard',
      name: 'Liquid Laggard',
      market_cap: 300_000_000,
      market_cap_change_24h: -12.0,
      volume_24h: 20_000_000,
    });

    // limit=1 isolates the single leader and single laggard, proving the garbage swings
    // (CNY Stablecoin +928.4%, Farming Games -100.0%, Market-Making +143.0%) never even enter the
    // ranking despite dwarfing the liquid categories' +13.0%/-12.0% moves.
    const { leaders, laggards } = normalizeCoingeckoCategories(
      [cnyStablecoin, farmingGames, marketMaking, liquidLeader, liquidLaggard],
      1,
      MIN_MARKET_CAP_USD,
      MIN_VOLUME_24H_USD,
    );

    expect(leaders.map((item) => item.id)).toEqual(['liquid-leader']);
    expect(laggards.map((item) => item.id)).toEqual(['liquid-laggard']);
  });

  it('yields empty leaders and laggards, without throwing, when everything is filtered out', () => {
    const categories = [
      category({ id: 'a', market_cap: 1_000, volume_24h: 100 }),
      category({ id: 'b', market_cap: null, volume_24h: 50_000_000 }),
      category({ id: 'c', market_cap: 200_000_000, volume_24h: null }),
    ];

    expect(() =>
      normalizeCoingeckoCategories(categories, LIMIT, MIN_MARKET_CAP_USD, MIN_VOLUME_24H_USD),
    ).not.toThrow();
    const { leaders, laggards } = normalizeCoingeckoCategories(
      categories,
      LIMIT,
      MIN_MARKET_CAP_USD,
      MIN_VOLUME_24H_USD,
    );
    expect(leaders).toEqual([]);
    expect(laggards).toEqual([]);
  });
});

class StubCoinGeckoClient implements CoinGeckoClient {
  async globalData(): Promise<Record<string, unknown>> {
    return {
      total_market_cap: { usd: 2_500_000_000_000 },
      market_cap_change_percentage_24h_usd: 1.5,
      market_cap_percentage: { btc: 54.2, eth: 17.1 },
      active_cryptocurrencies: 10000,
      markets: 900,
    };
  }

  async categories(): Promise<Record<string, unknown>[]> {
    return [
      {
        id: 'defi',
        name: 'DeFi',
        market_cap: 100,
        market_cap_change_24h: 5,
        volume_24h: 10,
        top_3_coins: [],
      },
      {
        id: 'meme',
        name: 'Meme',
        market_cap: 50,
        market_cap_change_24h: -8,
        volume_24h: 5,
        top_3_coins: [],
      },
    ];
  }

  async categoryMembers(_categoryId: string): Promise<string[]> {
    return [];
  }
}

class StubFearGreedClient implements FearGreedClient {
  constructor(private readonly snapshot: FearGreedSnapshot | null = null) {}

  async latest(): Promise<FearGreedSnapshot> {
    if (!this.snapshot) {
      throw new ProviderError('simulated feargreed outage');
    }
    return this.snapshot;
  }
}

class StubForexFactoryClient implements ForexFactoryClient {
  constructor(private readonly events: MacroEvent[] | null = null) {}

  async weeklyEvents(): Promise<MacroEvent[]> {
    if (!this.events) {
      throw new ProviderError('simulated forexfactory outage');
    }
    return this.events;
  }
}

describe('collectMarket', () => {
  it('assembles rows, market_context, and provider_status from both providers, and quality-flags rows', async () => {
    const config = buildConfig({
      providers: {
        coinglass: {
          exchanges: ['OKX', 'Bybit'],
          min_exchange_count: 2,
          candidate_symbols: 5,
          request_delay_seconds: 0,
          technical_indicators: { max_symbols: 0 },
          derivatives_history: { max_symbols: 0 },
          long_short_ratio: { max_symbols: 0 },
        },
      },
      universe: { exclude_base_assets: ['USDT'], min_quote_volume_usd: 20_000_000 },
      report: { core_symbols: ['BTC'] },
    });
    // Two exchanges clear min_coinglass_exchange_count(2), so the aggregate is_trusted=true.
    const coinglassClient = new StubCoinGlassClient(SUPPORTED_PAIRS, {
      BTC: [btcOkxPair(), btcOkxPair({ exchange_name: 'Bybit', instrument_id: 'BTCUSDT' })],
    });
    const coingeckoClient = new StubCoinGeckoClient();
    const feargreedClient = new StubFearGreedClient({
      value: 25,
      classification: 'Extreme Fear',
      yesterdayValue: 27,
    });
    const forexfactoryClient = new StubForexFactoryClient([
      {
        title: 'CPI m/m',
        country: 'USD',
        impact: 'High',
        time_utc: '2026-07-14T16:30:00.000Z',
        forecast: '-0.1%',
        previous: '0.5%',
      },
    ]);

    const result = await collectMarket(config, {
      coinglassClient,
      coingeckoClient,
      feargreedClient,
      forexfactoryClient,
    });

    expect(result.rows.map((row) => row.symbol)).toEqual(['BTC']);
    expect(result.rows[0]?.is_trusted).toBe(true); // clean row, no quality flags
    expect(result.market_context.btc_dominance_pct).toBeCloseTo(54.2);
    expect(result.market_context).toHaveProperty('categories');
    expect(result.market_context.fear_greed_value).toBe(25);
    expect(result.market_context.fear_greed_classification).toBe('Extreme Fear');
    expect(result.market_context.fear_greed_value_yesterday).toBe(27);
    expect(result.market_context.macro_events).toEqual([
      {
        title: 'CPI m/m',
        country: 'USD',
        impact: 'High',
        time_utc: '2026-07-14T16:30:00.000Z',
        forecast: '-0.1%',
        previous: '0.5%',
      },
    ]);
    expect((result.provider_status.coinglass as { status: string }).status).toBe('ok');
    expect((result.provider_status.coingecko as { status: string }).status).toBe('ok');
    expect((result.provider_status.feargreed as { status: string }).status).toBe('ok');
    expect((result.provider_status.forexfactory as { status: string }).status).toBe('ok');
    expect((result.provider_status.data_quality as { excluded: number }).excluded).toBe(0);
  });
});

describe('collectCoingeckoContext (screener sectors)', () => {
  const config = buildConfig({});

  class SectorStubCoinGeckoClient implements CoinGeckoClient {
    constructor(
      private readonly membersByCategoryId: Record<string, string[]>,
      private readonly failingCategoryId: string | null = null,
    ) {}

    async globalData(): Promise<Record<string, unknown>> {
      return {};
    }

    async categories(): Promise<Record<string, unknown>[]> {
      return [];
    }

    async categoryMembers(categoryId: string): Promise<string[]> {
      if (categoryId === this.failingCategoryId) {
        throw new ProviderError(`${categoryId}: simulated outage`);
      }
      return this.membersByCategoryId[categoryId] ?? [];
    }
  }

  it('sets market_context.screener_sector_members keyed by each configured sector label', async () => {
    const status: Record<string, unknown> = {};
    const client = new SectorStubCoinGeckoClient({
      'layer-1': ['BTC', 'ETH'],
      'decentralized-finance-defi': ['UNI'],
    });

    const context = await collectCoingeckoContext(config, status, client);

    expect(context.screener_sector_members).toEqual({
      'Layer 1': ['BTC', 'ETH'],
      DeFi: ['UNI'],
      AI: [],
      Meme: [],
      'Layer 2': [],
      Gaming: [],
    });
  });

  it('falls back to an empty map, without failing the run, when one sector fetch fails', async () => {
    const status: Record<string, unknown> = {};
    const client = new SectorStubCoinGeckoClient(
      { 'layer-1': ['BTC'] },
      'decentralized-finance-defi',
    );

    const context = await collectCoingeckoContext(config, status, client);

    expect(context.screener_sector_members).toEqual({});
    const coingeckoStatus = status.coingecko as { errors: string[] };
    expect(coingeckoStatus.errors.some((message) => message.includes('simulated outage'))).toBe(
      true,
    );
  });
});

describe('collectFearGreedContext', () => {
  const config = buildConfig({});

  it('merges fear_greed fields into market_context on success', async () => {
    const status: Record<string, unknown> = {};
    const client = new StubFearGreedClient({
      value: 72,
      classification: 'Greed',
      yesterdayValue: 68,
    });

    const context = await collectFearGreedContext(config, status, client);

    expect(context).toEqual({
      fear_greed_value: 72,
      fear_greed_classification: 'Greed',
      fear_greed_value_yesterday: 68,
    });
    expect((status.feargreed as { status: string }).status).toBe('ok');
  });

  it('omits fear_greed_value_yesterday when the yesterday value is absent', async () => {
    const status: Record<string, unknown> = {};
    const client = new StubFearGreedClient({
      value: 72,
      classification: 'Greed',
      yesterdayValue: null,
    });

    const context = await collectFearGreedContext(config, status, client);

    expect(context).toEqual({ fear_greed_value: 72, fear_greed_classification: 'Greed' });
    expect(context).not.toHaveProperty('fear_greed_value_yesterday');
  });

  it('omits fear_greed_classification when the classification is absent', async () => {
    const status: Record<string, unknown> = {};
    const client = new StubFearGreedClient({
      value: 72,
      classification: null,
      yesterdayValue: 68,
    });

    const context = await collectFearGreedContext(config, status, client);

    expect(context).toEqual({ fear_greed_value: 72, fear_greed_value_yesterday: 68 });
    expect(context).not.toHaveProperty('fear_greed_classification');
  });

  it('leaves fields absent and records a status.feargreed error note on failure, without throwing', async () => {
    const status: Record<string, unknown> = {};
    const client = new StubFearGreedClient(null);

    const context = await collectFearGreedContext(config, status, client);

    expect(context).toEqual({});
    const feargreedStatus = status.feargreed as { status: string; errors: string[] };
    expect(feargreedStatus.status).toBe('error');
    expect(feargreedStatus.errors).toHaveLength(1);
    expect(feargreedStatus.errors[0]).toContain('simulated feargreed outage');
  });

  it('marks status.feargreed as disabled and returns no fields when the provider is disabled', async () => {
    const disabledConfig = buildConfig({ providers: { feargreed: { enabled: false } } });
    const status: Record<string, unknown> = {};

    const context = await collectFearGreedContext(
      disabledConfig,
      status,
      new StubFearGreedClient({ value: 1, classification: 'x', yesterdayValue: null }),
    );

    expect(context).toEqual({});
    expect((status.feargreed as { status: string }).status).toBe('disabled');
  });
});

describe('collectMacroCalendarContext', () => {
  const config = buildConfig({});

  function event(overrides: Partial<MacroEvent> = {}): MacroEvent {
    return {
      title: 'CPI m/m',
      country: 'USD',
      impact: 'High',
      time_utc: '2026-07-14T16:30:00.000Z',
      forecast: '-0.1%',
      previous: '0.5%',
      ...overrides,
    };
  }

  it('sets market_context.macro_events to the USD+High events on success', async () => {
    const status: Record<string, unknown> = {};
    const client = new StubForexFactoryClient([
      event(),
      event({ title: 'FOMC Member Bowman Speaks', impact: 'Low' }),
      event({ title: 'BusinessNZ Services Index', country: 'NZD' }),
    ]);

    const context = await collectMacroCalendarContext(config, status, client);

    expect(context).toEqual({ macro_events: [event()] });
    expect((status.forexfactory as { status: string }).status).toBe('ok');
  });

  it('caps macro_events at 30 entries', async () => {
    const status: Record<string, unknown> = {};
    const events = Array.from({ length: 35 }, (_, i) => event({ title: `Event ${i}` }));
    const client = new StubForexFactoryClient(events);

    const context = await collectMacroCalendarContext(config, status, client);

    expect((context.macro_events as MacroEvent[]).length).toBe(30);
  });

  it('leaves fields absent and records a status.forexfactory error note on failure, without throwing', async () => {
    const status: Record<string, unknown> = {};
    const client = new StubForexFactoryClient(null);

    const context = await collectMacroCalendarContext(config, status, client);

    expect(context).toEqual({});
    const forexfactoryStatus = status.forexfactory as { status: string; errors: string[] };
    expect(forexfactoryStatus.status).toBe('error');
    expect(forexfactoryStatus.errors).toHaveLength(1);
    expect(forexfactoryStatus.errors[0]).toContain('simulated forexfactory outage');
  });

  it('marks status.forexfactory as disabled and returns no fields when the provider is disabled', async () => {
    const disabledConfig = buildConfig({ providers: { forexfactory: { enabled: false } } });
    const status: Record<string, unknown> = {};

    const context = await collectMacroCalendarContext(
      disabledConfig,
      status,
      new StubForexFactoryClient([event()]),
    );

    expect(context).toEqual({});
    expect((status.forexfactory as { status: string }).status).toBe('disabled');
  });
});

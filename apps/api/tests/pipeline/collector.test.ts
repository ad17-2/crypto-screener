import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config';
import { AppConfigSchema } from '../../src/config';
import {
  aggregateCoinglassPairs,
  coinglassCandidateStats,
  collectCoinglassFutures,
  collectFearGreedContext,
  collectMarket,
  rankCoinglassCandidates,
} from '../../src/pipeline/collector';
import type { CoinGeckoClient } from '../../src/providers/coingecko';
import type {
  CoinGlassClient,
  CoinGlassHistoryRow,
  CoinGlassPair,
} from '../../src/providers/coinglass';
import { ProviderError } from '../../src/providers/errors';
import type { FearGreedClient, FearGreedSnapshot } from '../../src/providers/feargreed';
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
        technical_indicators: { max_symbols: 5, request_delay_seconds: 0, limit: 80 },
        derivatives_history: { max_symbols: 5, request_delay_seconds: 0, limit: 40 },
        long_short_ratio: { max_symbols: 0, request_delay_seconds: 0 },
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
          technical_indicators: { max_symbols: 0, request_delay_seconds: 0 },
          derivatives_history: { max_symbols: 0, request_delay_seconds: 0 },
          long_short_ratio: { max_symbols: 0, request_delay_seconds: 0 },
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

describe('collectMarket', () => {
  it('assembles rows, market_context, and provider_status from both providers, and quality-flags rows', async () => {
    const config = buildConfig({
      providers: {
        coinglass: {
          exchanges: ['OKX', 'Bybit'],
          min_exchange_count: 2,
          candidate_symbols: 5,
          request_delay_seconds: 0,
          technical_indicators: { max_symbols: 0, request_delay_seconds: 0 },
          derivatives_history: { max_symbols: 0, request_delay_seconds: 0 },
          long_short_ratio: { max_symbols: 0, request_delay_seconds: 0 },
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

    const result = await collectMarket(config, {
      coinglassClient,
      coingeckoClient,
      feargreedClient,
    });

    expect(result.rows.map((row) => row.symbol)).toEqual(['BTC']);
    expect(result.rows[0]?.is_trusted).toBe(true); // clean row, no quality flags
    expect(result.market_context.btc_dominance_pct).toBeCloseTo(54.2);
    expect(result.market_context).toHaveProperty('categories');
    expect(result.market_context.fear_greed_value).toBe(25);
    expect(result.market_context.fear_greed_classification).toBe('Extreme Fear');
    expect(result.market_context.fear_greed_value_yesterday).toBe(27);
    expect((result.provider_status.coinglass as { status: string }).status).toBe('ok');
    expect((result.provider_status.coingecko as { status: string }).status).toBe('ok');
    expect((result.provider_status.feargreed as { status: string }).status).toBe('ok');
    expect((result.provider_status.data_quality as { excluded: number }).excluded).toBe(0);
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

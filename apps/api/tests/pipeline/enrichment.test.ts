import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config';
import type { ProviderStatus } from '../../src/pipeline/enrichment';
import {
  appendCoinglassDerivativesHistory,
  appendCoinglassLongShortRatio,
  appendCoinglassTechnicals,
} from '../../src/pipeline/enrichment';
import type { Row } from '../../src/pipeline/types';
import type {
  CoinGlassClient,
  CoinGlassHistoryRow,
  CoinGlassPair,
} from '../../src/providers/coinglass';
import { ProviderError } from '../../src/providers/errors';

class FakeCoinGlassClient implements CoinGlassClient {
  priceHistoryCalls: Array<[string, string, string, number]> = [];
  globalCalls: Array<[string, string]> = [];
  topCalls: Array<[string, string]> = [];
  positionCalls: Array<[string, string]> = [];

  constructor(private readonly failOn?: { method: string; symbol: string }) {}

  async supportedExchangePairs(): Promise<Record<string, CoinGlassPair[]>> {
    return {};
  }

  async futuresPairsMarkets(): Promise<CoinGlassPair[]> {
    return [];
  }

  async priceHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.priceHistoryCalls.push([exchange, symbol, interval, limit]);
    if (this.failOn?.method === 'priceHistory' && symbol === this.failOn.symbol) {
      throw new ProviderError('simulated outage');
    }
    return Array.from({ length: limit }, (_, index) => {
      const close = 100.0 + index * 0.4;
      return { time: index, open: close - 0.2, high: close + 0.5, low: close - 0.5, close };
    });
  }

  async openInterestAggregatedHistory(_symbol: string, _interval: string, limit: number) {
    return Array.from({ length: limit }, (_, index) => ({ time: index, close: 1000 + index }));
  }

  async fundingOiWeightHistory(_symbol: string, _interval: string, limit: number) {
    return Array.from({ length: limit }, (_, index) => ({ time: index, close: 0.01 }));
  }

  async liquidationAggregatedHistory(
    _exchanges: string[],
    _symbol: string,
    _interval: string,
    limit: number,
  ) {
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
  ) {
    return Array.from({ length: limit }, (_, index) => ({
      time: index,
      aggregated_buy_volume_usd: 120,
      aggregated_sell_volume_usd: 100,
    }));
  }

  async globalLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
  ): Promise<CoinGlassHistoryRow[]> {
    this.globalCalls.push([exchange, symbol]);
    return [{ global_account_long_short_ratio: 1.8 }];
  }

  async topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
  ): Promise<CoinGlassHistoryRow[]> {
    this.topCalls.push([exchange, symbol]);
    return [{ top_account_long_short_ratio: 2.4 }];
  }

  async topLongShortPositionRatioHistory(
    exchange: string,
    symbol: string,
  ): Promise<CoinGlassHistoryRow[]> {
    this.positionCalls.push([exchange, symbol]);
    return [{ top_position_long_short_ratio: 3.1 }];
  }
}

function coinglassConfig(overrides: Record<string, unknown>) {
  return AppConfigSchema.parse({ providers: { coinglass: overrides } }).providers.coinglass;
}

describe('appendCoinglassTechnicals', () => {
  it('fetches price history and merges the technical snapshot onto the row', async () => {
    const rows: Row[] = [
      { symbol: 'BTC', primary_exchange: 'OKX', contract_symbol: 'BTC-USDT-SWAP' },
    ];
    const status: ProviderStatus = {};
    const client = new FakeCoinGlassClient();
    const providerCfg = coinglassConfig({
      technical_indicators: {
        enabled: true,
        interval: '4h',
        limit: 80,
        max_symbols: 1,
        request_delay_seconds: 0,
      },
    });

    await appendCoinglassTechnicals(rows, client, providerCfg, status);

    expect(client.priceHistoryCalls).toEqual([['OKX', 'BTC-USDT-SWAP', '4h', 80]]);
    expect((status.technicals as { status: string }).status).toBe('ok');
    expect(rows[0]?.technical_interval).toBe('4h');
    expect(rows[0]).toHaveProperty('rsi_14');
  });

  it('skips rows missing primary_exchange or contract_symbol without throwing', async () => {
    const rows: Row[] = [{ symbol: 'NOEXCHANGE' }];
    const status: ProviderStatus = {};
    const client = new FakeCoinGlassClient();
    const providerCfg = coinglassConfig({
      technical_indicators: { max_symbols: 1, request_delay_seconds: 0 },
    });

    await appendCoinglassTechnicals(rows, client, providerCfg, status);

    expect(client.priceHistoryCalls).toEqual([]);
    expect((status.technicals as { status: string }).status).toBe('error');
    expect(rows[0]).not.toHaveProperty('technical_interval');
  });

  it('records a provider failure per-symbol and continues without throwing', async () => {
    const rows: Row[] = [
      { symbol: 'BTC', primary_exchange: 'OKX', contract_symbol: 'BTC-USDT-SWAP' },
    ];
    const status: ProviderStatus = {};
    const client = new FakeCoinGlassClient({ method: 'priceHistory', symbol: 'BTC-USDT-SWAP' });
    const providerCfg = coinglassConfig({
      technical_indicators: { max_symbols: 1, request_delay_seconds: 0 },
    });

    await appendCoinglassTechnicals(rows, client, providerCfg, status);

    const technicalsStatus = status.technicals as { status: string; errors: string[] };
    expect(technicalsStatus.status).toBe('error');
    expect(technicalsStatus.errors[0]).toContain('BTC');
    expect(technicalsStatus.errors[0]).toContain('simulated outage');
    expect(rows[0]).not.toHaveProperty('technical_interval');
  });

  it('fetches every row when max_symbols is 0, and truncates when it is positive', async () => {
    const build = (): Row[] =>
      ['BTC', 'ETH', 'SOL'].map((symbol) => ({
        symbol,
        primary_exchange: 'OKX',
        contract_symbol: `${symbol}-USDT-SWAP`,
      }));
    const fetchCount = async (maxSymbols: number): Promise<number> => {
      const client = new FakeCoinGlassClient();
      const providerCfg = coinglassConfig({
        technical_indicators: { max_symbols: maxSymbols, request_delay_seconds: 0 },
      });
      await appendCoinglassTechnicals(build(), client, providerCfg, {});
      return client.priceHistoryCalls.length;
    };

    expect(await fetchCount(0)).toBe(3);
    expect(await fetchCount(2)).toBe(2);
  });
});

describe('appendCoinglassDerivativesHistory', () => {
  it('fetches OI/funding/liquidation/taker history and merges the derivatives snapshot', async () => {
    const rows: Row[] = [{ symbol: 'BTC' }];
    const status: ProviderStatus = {};
    const client = new FakeCoinGlassClient();
    const providerCfg = coinglassConfig({
      exchanges: ['OKX', 'Bybit'],
      derivatives_history: {
        enabled: true,
        interval: '4h',
        limit: 40,
        max_symbols: 1,
        request_delay_seconds: 0,
      },
    });

    await appendCoinglassDerivativesHistory(rows, client, providerCfg, status);

    expect((status.derivatives_history as { status: string }).status).toBe('ok');
    expect(rows[0]?.derivatives_interval).toBe('4h');
    expect(rows[0]).toHaveProperty('oi_change_24h_pct_history');
    expect(rows[0]).toHaveProperty('taker_imbalance_24h_pct');
  });

  it('enriches every row when max_symbols is 0, and truncates when it is positive', async () => {
    const build = (): Row[] => [{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }];
    const enrichedCount = async (maxSymbols: number): Promise<number> => {
      const rows = build();
      const providerCfg = coinglassConfig({
        derivatives_history: { max_symbols: maxSymbols, request_delay_seconds: 0 },
      });
      await appendCoinglassDerivativesHistory(rows, new FakeCoinGlassClient(), providerCfg, {});
      return rows.filter((row) => row.derivatives_interval !== undefined).length;
    };

    // 0 is the no-cap sentinel (as in long_short_ratio), NOT "fetch nothing". These four factors --
    // oi_acceleration_signal, funding_persistence_contrarian, taker_flow_24h,
    // liquidation_pressure_24h -- are ranked only over the rows enriched here, so a cap silently
    // shrinks their IC cross-section instead of the universe.
    expect(await enrichedCount(0)).toBe(3);
    expect(await enrichedCount(2)).toBe(2);
  });
});

// Overrides topLongShortPositionRatioHistory to return a caller-supplied history, for the
// top_trader_position_ratio tests below (empty history, disabled flag).
class PositionRatioHistoryClient extends FakeCoinGlassClient {
  constructor(private readonly positionHistory: CoinGlassHistoryRow[]) {
    super();
  }

  override async topLongShortPositionRatioHistory(
    exchange: string,
    symbol: string,
  ): Promise<CoinGlassHistoryRow[]> {
    this.positionCalls.push([exchange, symbol]);
    return this.positionHistory;
  }
}

// Overrides topLongShortAccountRatioHistory to return a caller-supplied history, for the
// top_trader_ratio_delta_24h tests below (short history, malformed older entry).
class AccountRatioHistoryClient extends FakeCoinGlassClient {
  constructor(private readonly accountHistory: CoinGlassHistoryRow[]) {
    super();
  }

  override async topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
  ): Promise<CoinGlassHistoryRow[]> {
    this.topCalls.push([exchange, symbol]);
    return this.accountHistory;
  }
}

describe('appendCoinglassLongShortRatio', () => {
  const buildRow = (): Row[] => [
    { symbol: 'BTC', base_asset: 'BTC', quote_asset: 'USDT', primary_exchange: 'Binance' },
  ];

  it('fetches global + top-trader account ratios and merges them onto the row', async () => {
    const rows: Row[] = [
      { symbol: 'BTC', base_asset: 'BTC', quote_asset: 'USDT', primary_exchange: 'Binance' },
    ];
    const client = new FakeCoinGlassClient();
    const status: ProviderStatus = {};
    const providerCfg = coinglassConfig({
      long_short_ratio: {
        enabled: true,
        interval: '4h',
        limit: 30,
        max_symbols: 0,
        ratio_exchange: 'Binance',
        include_top_trader: true,
        request_delay_seconds: 0,
      },
    });

    await appendCoinglassLongShortRatio(rows, client, providerCfg, status);

    expect(rows[0]?.long_short_account_ratio).toBeCloseTo(1.8);
    expect(rows[0]?.top_trader_long_short_ratio).toBeCloseTo(2.4);
    expect((status.long_short_ratio as { status: string }).status).toBe('ok');
    expect(client.globalCalls).toEqual([['Binance', 'BTCUSDT']]);
    expect(client.topCalls).toEqual([['Binance', 'BTCUSDT']]);
  });

  it('sets top_trader_position_ratio from the top-long-short-position-ratio endpoint', async () => {
    const client = new FakeCoinGlassClient();
    const status: ProviderStatus = {};
    const providerCfg = coinglassConfig({
      long_short_ratio: { request_delay_seconds: 0, include_top_position: true },
    });

    await appendCoinglassLongShortRatio(buildRow(), client, providerCfg, status);

    expect(client.positionCalls).toEqual([['Binance', 'BTCUSDT']]);
  });

  it('leaves top_trader_position_ratio unset when the endpoint returns no entries', async () => {
    const client = new PositionRatioHistoryClient([]);
    const providerCfg = coinglassConfig({
      long_short_ratio: { request_delay_seconds: 0, include_top_position: true },
    });
    const rows = buildRow();

    await appendCoinglassLongShortRatio(rows, client, providerCfg, {});

    expect(rows[0]).not.toHaveProperty('top_trader_position_ratio');
  });

  it('does not call the top-long-short-position-ratio endpoint when include_top_position is false', async () => {
    const client = new FakeCoinGlassClient();
    const providerCfg = coinglassConfig({
      long_short_ratio: { request_delay_seconds: 0, include_top_position: false },
    });
    const rows = buildRow();

    await appendCoinglassLongShortRatio(rows, client, providerCfg, {});

    expect(client.positionCalls).toEqual([]);
    expect(rows[0]).not.toHaveProperty('top_trader_position_ratio');
  });

  it('computes top_trader_ratio_delta_24h as latest minus the value 6 bars earlier', async () => {
    // 30 entries, top_account_long_short_ratio rising 0.05 per bar from 2.0.
    const accountHistory: CoinGlassHistoryRow[] = Array.from({ length: 30 }, (_, index) => ({
      top_account_long_short_ratio: 2.0 + index * 0.05,
    }));
    const client = new AccountRatioHistoryClient(accountHistory);
    const providerCfg = coinglassConfig({
      long_short_ratio: { request_delay_seconds: 0, include_top_trader: true },
    });
    const rows = buildRow();

    await appendCoinglassLongShortRatio(rows, client, providerCfg, {});

    // latest = entry[29] = 2.0 + 29*0.05 = 3.45; prior = entry[23] = 2.0 + 23*0.05 = 3.15
    expect(rows[0]?.top_trader_ratio_delta_24h).toBeCloseTo(0.3, 10);
  });

  it('leaves top_trader_ratio_delta_24h unset when the history has fewer than 7 entries', async () => {
    const accountHistory: CoinGlassHistoryRow[] = Array.from({ length: 5 }, (_, index) => ({
      top_account_long_short_ratio: 2.0 + index * 0.05,
    }));
    const client = new AccountRatioHistoryClient(accountHistory);
    const providerCfg = coinglassConfig({
      long_short_ratio: { request_delay_seconds: 0, include_top_trader: true },
    });
    const rows = buildRow();

    await appendCoinglassLongShortRatio(rows, client, providerCfg, {});

    expect(rows[0]).not.toHaveProperty('top_trader_ratio_delta_24h');
    // The latest-only ratio is unaffected by the short history.
    expect(rows[0]?.top_trader_long_short_ratio).toBeCloseTo(2.2, 10);
  });

  it('leaves top_trader_ratio_delta_24h unset when the older entry is malformed', async () => {
    const accountHistory: CoinGlassHistoryRow[] = Array.from({ length: 30 }, (_, index) => ({
      top_account_long_short_ratio: 2.0 + index * 0.05,
    }));
    // Corrupt the entry 6 bars back from the latest (index length-7 = 23): no parseable key.
    accountHistory[23] = { top_account_long_short_ratio: 'not-a-number' };
    const client = new AccountRatioHistoryClient(accountHistory);
    const providerCfg = coinglassConfig({
      long_short_ratio: { request_delay_seconds: 0, include_top_trader: true },
    });
    const rows = buildRow();

    await appendCoinglassLongShortRatio(rows, client, providerCfg, {});

    expect(rows[0]).not.toHaveProperty('top_trader_ratio_delta_24h');
    // The latest entry still parses fine.
    expect(rows[0]?.top_trader_long_short_ratio).toBeCloseTo(3.45, 10);
  });
});

// Returns a distinct close series per contract symbol so BTC correlation is actually discriminating,
// unlike FakeCoinGlassClient.priceHistory which returns one identical monotonic series for every symbol.
class VariedSeriesClient extends FakeCoinGlassClient {
  constructor(private readonly closesByContract: Record<string, number[]>) {
    super();
  }

  override async priceHistory(
    exchange: string,
    contractSymbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.priceHistoryCalls.push([exchange, contractSymbol, interval, limit]);
    const closes = this.closesByContract[contractSymbol] ?? [];
    return closes.map((close, index) => ({
      time: index,
      open: close,
      high: close,
      low: close,
      close,
    }));
  }
}

function returnsOf(closes: number[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1] as number;
    out.push(((closes[index] as number) - previous) / previous);
  }
  return out;
}

describe('appendCoinglassTechnicals BTC correlation', () => {
  // Varied, strictly-positive series with non-constant returns (variance > 0 so Pearson r is defined).
  const btcCloses = Array.from({ length: 64 }, (_, index) => 100 + (index % 6) * 3 + (index % 4));
  // Each 4h return is the exact negation of BTC's, so Pearson r must be -1.
  const inverseCloses = [100];
  for (const ret of returnsOf(btcCloses)) {
    inverseCloses.push((inverseCloses.at(-1) as number) * (1 - ret));
  }
  const shortCloses = btcCloses.slice(0, 30); // 29 shared return-pairs < MIN_CORR_PAIRS (60)

  const technicalCfg = {
    technical_indicators: {
      enabled: true,
      interval: '4h',
      limit: 220,
      max_symbols: 0,
      request_delay_seconds: 0,
    },
  };

  const rowFor = (symbol: string): Row => ({
    symbol,
    primary_exchange: 'OKX',
    contract_symbol: `${symbol}-USDT-SWAP`,
  });

  it('sets a per-row correlation and beta to BTC: a clone ~= 1, an inverse ~= -1; BTC itself is left unset', async () => {
    const rows = [rowFor('BTC'), rowFor('CLONE'), rowFor('INV')];
    const client = new VariedSeriesClient({
      'BTC-USDT-SWAP': btcCloses,
      'CLONE-USDT-SWAP': btcCloses,
      'INV-USDT-SWAP': inverseCloses,
    });
    const status: ProviderStatus = {};

    await appendCoinglassTechnicals(rows, client, coinglassConfig(technicalCfg), status);

    expect(rows[0]).not.toHaveProperty('btc_correlation'); // BTC has no correlation/beta against itself
    expect(rows[0]).not.toHaveProperty('btc_beta');
    expect(rows[1]?.btc_correlation).toBeCloseTo(1, 6);
    expect(rows[1]?.btc_beta).toBeCloseTo(1, 6);
    expect(rows[2]?.btc_correlation).toBeCloseTo(-1, 6);
    expect(rows[2]?.btc_beta).toBeCloseTo(-1, 6);
    expect((status.technicals as { btc_correlation_rows: number }).btc_correlation_rows).toBe(2);
  });

  it('leaves btc_correlation unset when the shared overlap is below the minimum', async () => {
    const rows = [rowFor('BTC'), rowFor('TINY')];
    const client = new VariedSeriesClient({
      'BTC-USDT-SWAP': btcCloses,
      'TINY-USDT-SWAP': shortCloses,
    });
    const status: ProviderStatus = {};

    await appendCoinglassTechnicals(rows, client, coinglassConfig(technicalCfg), status);

    expect(rows[0]).not.toHaveProperty('btc_correlation'); // BTC has no correlation/beta against itself
    expect(rows[0]).not.toHaveProperty('btc_beta');
    expect(rows[1]).not.toHaveProperty('btc_correlation');
    expect((status.technicals as { btc_correlation_rows: number }).btc_correlation_rows).toBe(0);
  });

  it('assigns no correlation when BTC is absent from the universe', async () => {
    const rows = [rowFor('CLONE'), rowFor('INV')];
    const client = new VariedSeriesClient({
      'CLONE-USDT-SWAP': btcCloses,
      'INV-USDT-SWAP': inverseCloses,
    });
    const status: ProviderStatus = {};

    await appendCoinglassTechnicals(rows, client, coinglassConfig(technicalCfg), status);

    expect(rows[0]).not.toHaveProperty('btc_correlation');
    expect(rows[1]).not.toHaveProperty('btc_correlation');
    expect((status.technicals as { btc_correlation_rows: number }).btc_correlation_rows).toBe(0);
  });
});

interface CorrelationStructureStatus {
  alt_alt_mean_correlation: number | null;
  alt_alt_correlation_pairs: number;
  pairwise_correlation_ms: number;
}

describe('appendCoinglassTechnicals correlation-structure scalars', () => {
  // Same fixtures as the BTC-correlation describe block above: btcCloses varies (non-zero
  // variance, so Pearson r is defined), inverseCloses is its exact per-bar negation (r = -1
  // against anything that IS btcCloses), shortCloses is too short to clear MIN_CORR_PAIRS (60).
  const btcCloses = Array.from({ length: 64 }, (_, index) => 100 + (index % 6) * 3 + (index % 4));
  const inverseCloses = [100];
  for (const ret of returnsOf(btcCloses)) {
    inverseCloses.push((inverseCloses.at(-1) as number) * (1 - ret));
  }
  const shortCloses = btcCloses.slice(0, 30);

  const technicalCfg = {
    technical_indicators: {
      enabled: true,
      interval: '4h',
      limit: 220,
      max_symbols: 0,
      request_delay_seconds: 0,
    },
  };

  const rowFor = (symbol: string): Row => ({
    symbol,
    primary_exchange: 'OKX',
    contract_symbol: `${symbol}-USDT-SWAP`,
  });

  it('averages all-pairs alt-alt correlation without materializing a matrix', async () => {
    // Two clones of BTC (CLONE, CLONE2, r=+1 to BTC and to each other) plus one exact inverse
    // (INV, r=-1 to BTC and to both clones). Alt-alt pairs are (CLONE,INV)=-1, (CLONE,CLONE2)=+1,
    // (INV,CLONE2)=-1 -> mean = -1/3. mean_btc_correlation/correlation_spread are no longer
    // computed here -- market.ts's marketSensingSummary derives them itself from each row's own
    // btc_correlation field instead (see this file's comment above the pairwise pass for why).
    const rows = [rowFor('BTC'), rowFor('CLONE'), rowFor('INV'), rowFor('CLONE2')];
    const client = new VariedSeriesClient({
      'BTC-USDT-SWAP': btcCloses,
      'CLONE-USDT-SWAP': btcCloses,
      'INV-USDT-SWAP': inverseCloses,
      'CLONE2-USDT-SWAP': btcCloses,
    });
    const status: ProviderStatus = {};

    await appendCoinglassTechnicals(rows, client, coinglassConfig(technicalCfg), status);

    const technicals = status.technicals as CorrelationStructureStatus;
    expect(technicals.alt_alt_mean_correlation).toBeCloseTo(-1 / 3, 6);
    expect(technicals.alt_alt_correlation_pairs).toBe(3);
    expect(technicals.pairwise_correlation_ms).toBeGreaterThanOrEqual(0);

    // Transient carrier onto the BTC row (rows[0]) -- market.ts's marketSensingSummary reads and
    // strips these before returning; this function's own boundary is where they're still present.
    expect(rows[0]?.alt_alt_mean_correlation).toBeCloseTo(-1 / 3, 6);
    expect(rows[0]?.alt_alt_correlation_pairs).toBe(3);
    // mean_btc_correlation/correlation_spread must NOT be stashed here -- they're computed
    // entirely in market.ts now, from each row's own btc_correlation field.
    expect(rows[0]).not.toHaveProperty('mean_btc_correlation');
    expect(rows[0]).not.toHaveProperty('correlation_spread');
  });

  it('skips an alt-alt pair below MIN_CORR_PAIRS instead of silently averaging it in', async () => {
    // CLONE has full overlap with BTC (r=+1); TINY's overlap with both BTC and CLONE is only 29
    // shared return-pairs < MIN_CORR_PAIRS (60), so its one alt-alt pair (CLONE, TINY) must be
    // skipped -- leaving alt_alt_correlation_pairs at 0, not 1.
    const rows = [rowFor('BTC'), rowFor('CLONE'), rowFor('TINY')];
    const client = new VariedSeriesClient({
      'BTC-USDT-SWAP': btcCloses,
      'CLONE-USDT-SWAP': btcCloses,
      'TINY-USDT-SWAP': shortCloses,
    });
    const status: ProviderStatus = {};

    await appendCoinglassTechnicals(rows, client, coinglassConfig(technicalCfg), status);

    const technicals = status.technicals as CorrelationStructureStatus;
    expect(technicals.alt_alt_correlation_pairs).toBe(0);
    expect(technicals.alt_alt_mean_correlation).toBeNull();
  });
});

// Returns caller-supplied {time, close} bars verbatim, unlike VariedSeriesClient/FakeCoinGlassClient
// above which both use small synthetic indices (0,1,2,...) as `time`. correlation.ts's resolveStep
// only evaluates real-epoch drift when the first bar's time is >= 1e8, so a real-epoch fixture is
// required to exercise it at all.
class EpochTimeSeriesClient extends FakeCoinGlassClient {
  constructor(
    private readonly barsByContract: Record<string, Array<{ time: number; close: number }>>,
  ) {
    super();
  }

  override async priceHistory(
    exchange: string,
    contractSymbol: string,
    interval: string,
    limit: number,
  ): Promise<CoinGlassHistoryRow[]> {
    this.priceHistoryCalls.push([exchange, contractSymbol, interval, limit]);
    const bars = this.barsByContract[contractSymbol];
    if (!bars) {
      return super.priceHistory(exchange, contractSymbol, interval, limit);
    }
    return bars.map(({ time, close }) => ({ time, open: close, high: close, low: close, close }));
  }
}

describe('appendCoinglassTechnicals correlation-structure scalars: gapped pairs', () => {
  // 4h bars anchored to a real epoch-ms timestamp (BASE_MS >= 1e11), so resolveStep (correlation.ts)
  // takes its anchored-drift branch instead of the small-synthetic-timestamp bypass every other
  // fixture in this file relies on.
  const STEP_MS = 4 * 60 * 60 * 1000;
  const BASE_MS = 1_700_000_000_000;
  const BAR_COUNT = 90;
  // Mid-series index whose bar is nudged to sit only 60s after its predecessor instead of a full
  // 4h -- one anomalously tiny gap. baseInterval() (correlation.ts) takes the MIN delta across the
  // whole series, so this single glitch drags the inferred step down to ~60s, which drifts >5% from
  // the configured 4h and flips `gapped: true` -- while the other ~86 bars stay exactly 4h apart
  // (well above MIN_CORR_PAIRS=60), so the correlation itself still comes back non-null. That
  // combination -- gapped AND correlation defined -- is exactly what the `!stats.gapped` guard in
  // the pairwise loop (enrichment.ts) exists to catch; without it this pair would be averaged in.
  const GLITCH_INDEX = 45;

  function wave(index: number, offset: number): number {
    return 100 + ((index + offset) % 6) * 3 + ((index + offset) % 4);
  }

  function evenlySpacedBars(offset: number): Array<{ time: number; close: number }> {
    return Array.from({ length: BAR_COUNT }, (_, index) => ({
      time: BASE_MS + index * STEP_MS,
      close: wave(index, offset),
    }));
  }

  function glitchedBars(offset: number): Array<{ time: number; close: number }> {
    return evenlySpacedBars(offset).map((bar, index) =>
      index === GLITCH_INDEX
        ? { ...bar, time: BASE_MS + (GLITCH_INDEX - 1) * STEP_MS + 60_000 }
        : bar,
    );
  }

  const technicalCfg = {
    technical_indicators: {
      enabled: true,
      interval: '4h',
      limit: BAR_COUNT,
      max_symbols: 0,
      request_delay_seconds: 0,
    },
  };

  const rowFor = (symbol: string): Row => ({
    symbol,
    primary_exchange: 'OKX',
    contract_symbol: `${symbol}-USDT-SWAP`,
  });

  it('excludes an alt-alt pair whose returnStats came back gapped, even though its correlation is defined', async () => {
    const rows = [rowFor('BTC'), rowFor('CLEAN'), rowFor('GLITCHY')];
    const client = new EpochTimeSeriesClient({
      'CLEAN-USDT-SWAP': evenlySpacedBars(0),
      'GLITCHY-USDT-SWAP': glitchedBars(1),
    });
    const status: ProviderStatus = {};

    await appendCoinglassTechnicals(rows, client, coinglassConfig(technicalCfg), status);

    const technicals = status.technicals as CorrelationStructureStatus;
    expect(technicals.alt_alt_correlation_pairs).toBe(0);
    expect(technicals.alt_alt_mean_correlation).toBeNull();
  });
});

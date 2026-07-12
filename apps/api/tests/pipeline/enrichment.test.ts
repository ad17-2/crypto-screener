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

describe('appendCoinglassLongShortRatio', () => {
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
});

import { describe, expect, it } from 'vitest';
import { applyDataQuality, dataQualityFlags } from '../../src/pipeline/quality';
import type { Row } from '../../src/pipeline/types';

const BASE_QUALITY_CONFIG = {
  max_abs_price_change_24h_pct: 300,
  max_abs_oi_change_24h_pct: 300,
  max_abs_volume_change_24h_pct: 1000,
  max_abs_funding_rate_pct: 2,
  max_price_deviation_from_index_pct: 25,
  min_quote_volume_usd: 10_000_000,
  min_coinglass_exchange_count: 2,
};

describe('dataQualityFlags', () => {
  it('flags extreme 24h price and open-interest changes', () => {
    const row: Row = {
      symbol: 'TAIKO',
      contract_symbol: 'TAIKOUSDT',
      quote_asset: 'USDT',
      data_source: 'coinglass',
      price_usd: 10,
      price_change_24h_pct: 11508.53,
      oi_change_24h_pct: 465.43,
      quote_volume_usd: 50_000_000,
      coinglass_exchange_count: 4,
    };

    const flags = dataQualityFlags(row, BASE_QUALITY_CONFIG);

    expect(flags.some((flag) => flag.startsWith('extreme_24h_price_change'))).toBe(true);
    expect(flags.some((flag) => flag.startsWith('extreme_24h_oi_change'))).toBe(true);
  });

  it('flags stale volume, invalid price, and malformed symbol/contract fields', () => {
    const row: Row = {
      symbol: 'BAD/PAIR',
      contract_symbol: 'BADPAIRUSD',
      quote_asset: 'USDT',
      data_source: 'coinglass',
      price_usd: 0,
      quote_volume_usd: 250_000,
      open_interest_usd: -1,
    };

    const status = applyDataQuality([row], { data_quality: {} });

    expect(status.excluded).toBe(1);
    expect(row.data_quality_flags).toContain('weird_symbol:BAD/PAIR');
    expect(row.data_quality_flags).toContain('weird_contract_symbol:BADPAIRUSD');
    expect(row.data_quality_flags).toContain('invalid_price:0.00');
    expect(
      (row.data_quality_flags as string[]).some((flag) =>
        flag.startsWith('stale_low_quote_volume'),
      ),
    ).toBe(true);
    expect(
      (row.data_quality_flags as string[]).some((flag) => flag.startsWith('invalid_open_interest')),
    ).toBe(true);
  });

  it('flags index-price deviation and thin CoinGlass exchange coverage', () => {
    const row: Row = {
      symbol: 'TAIKO',
      contract_symbol: 'TAIKOUSDT',
      quote_asset: 'USDT',
      data_source: 'coinglass',
      price_usd: 50,
      index_price: 10,
      price_change_24h_pct: 5,
      quote_volume_usd: 50_000_000,
      coinglass_exchange_count: 1,
    };

    applyDataQuality([row], { data_quality: {} });

    expect(
      (row.data_quality_flags as string[]).some((flag) =>
        flag.startsWith('price_deviates_from_index'),
      ),
    ).toBe(true);
    expect(
      (row.data_quality_flags as string[]).some((flag) =>
        flag.startsWith('thin_coinglass_exchange_coverage'),
      ),
    ).toBe(true);
  });
});

describe('applyDataQuality', () => {
  it('keeps flagged rows visible with is_trusted=false, instead of dropping them', () => {
    const rows: Row[] = [
      {
        symbol: 'NORMAL',
        contract_symbol: 'NORMALUSDT',
        quote_asset: 'USDT',
        data_source: 'coinglass',
        price_usd: 10,
        price_change_24h_pct: 5,
        oi_change_24h_pct: 4,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
        coinglass_exchange_count: 4,
      },
      {
        symbol: 'EXTREME',
        contract_symbol: 'EXTREMEUSDT',
        quote_asset: 'USDT',
        data_source: 'coinglass',
        price_usd: 10,
        price_change_24h_pct: 1200,
        oi_change_24h_pct: 500,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
        coinglass_exchange_count: 4,
      },
    ];

    const status = applyDataQuality(rows, { data_quality: {} });

    expect(rows).toHaveLength(2); // neither row was dropped
    expect(rows.map((row) => row.symbol)).toEqual(['NORMAL', 'EXTREME']); // original order preserved

    const normal = rows.find((row) => row.symbol === 'NORMAL') as Row;
    const extreme = rows.find((row) => row.symbol === 'EXTREME') as Row;
    expect(normal.is_trusted).toBe(true);
    expect(normal.data_quality_flags).toEqual([]);
    expect(extreme.is_trusted).toBe(false);
    expect((extreme.data_quality_flags as string[]).length).toBeGreaterThan(0);
    expect(status.excluded).toBe(1);
    expect(status.flagged).toBe(1);
    expect(status.rows).toBe(2);
  });

  it('scores 100 for a clean row and deducts 25 per flag', () => {
    const row: Row = {
      symbol: 'CLEAN',
      contract_symbol: 'CLEANUSDT',
      quote_asset: 'USDT',
      data_source: 'coinglass',
      price_usd: 10,
      price_change_24h_pct: 5,
      oi_change_24h_pct: 4,
      funding_rate_pct: 0.01,
      quote_volume_usd: 100_000_000,
      coinglass_exchange_count: 4,
    };

    applyDataQuality([row], { data_quality: {} });

    expect(row.data_quality_score).toBe(100);
  });

  it('applies config overrides on top of DEFAULT_QUALITY_CONFIG (partial override, like Python)', () => {
    const row: Row = {
      symbol: 'BTC',
      contract_symbol: 'BTCUSDT',
      quote_asset: 'USDT',
      data_source: 'coinglass',
      price_usd: 10,
      quote_volume_usd: 15_000_000, // below the default 10M is fine, but above a raised floor it fails
      coinglass_exchange_count: 4,
    };

    applyDataQuality([row], { data_quality: { min_quote_volume_usd: 20_000_000 } });

    expect(
      (row.data_quality_flags as string[]).some((flag) =>
        flag.startsWith('stale_low_quote_volume'),
      ),
    ).toBe(true);
  });
});

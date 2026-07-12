import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_PRIORS, DIRECTIONAL_FACTORS } from '../../src/pipeline/factorDefinitions.js';
import { normalizeFactors, rawFactors, scoreSnapshot } from '../../src/pipeline/factors.js';
import type { FactorRecord } from '../../src/pipeline/ic.js';
import { factorCorrelations } from '../../src/pipeline/independence.js';
import { spearmanCorr } from '../../src/pipeline/scoring.js';
import type { MarketContext, Row } from '../../src/pipeline/types.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/parity-run.json');

interface Fixture {
  config: unknown;
  market_context: MarketContext;
  input_rows: Row[];
  factor_history: FactorRecord[];
}

describe('factorCorrelations', () => {
  it('flags a duplicate pair (test_factor_correlations_flags_duplicate_pair)', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      factors: { alpha: index, beta: index },
    }));
    const flagged = factorCorrelations(rows, ['alpha', 'beta'], 10);
    expect(flagged.length).toBe(1);
    expect(flagged[0]?.verdict).toBe('duplicate');
    expect(flagged[0]?.rho).toBeCloseTo(1.0, 9);
  });

  it('flags a correlated pair (test_factor_correlations_flags_correlated_pair)', () => {
    const alpha = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const beta = [3, 4, 5, 2, 1, 8, 8, 4, 5, 12, 7, 11];
    const rows = alpha.map((a, index) => ({ factors: { alpha: a, beta: beta[index] } }));
    const flagged = factorCorrelations(rows, ['alpha', 'beta'], 10);
    expect(flagged.length).toBe(1);
    expect(flagged[0]?.verdict).toBe('correlated');
    expect(Math.abs(flagged[0]?.rho as number)).toBeGreaterThanOrEqual(0.6);
    expect(Math.abs(flagged[0]?.rho as number)).toBeLessThan(0.8);
  });

  it('skips pairs below the minimum pair count (test_factor_correlations_skips_low_pair_count)', () => {
    const rows = Array.from({ length: 5 }, () => ({ factors: { alpha: 1.0, beta: 1.0 } }));
    expect(factorCorrelations(rows, ['alpha', 'beta'], 10)).toEqual([]);
  });

  it('ignores an uncorrelated pair (test_factor_correlations_ignores_uncorrelated_pair)', () => {
    // Fixed series, not a replay of Python's RNG stream; verified |rho| ~= 0.21, under the 0.6 flag threshold.
    const alpha = [
      0.6011, 0.8525, 0.1748, 0.2732, 0.8655, 0.2499, 0.7457, 0.1973, 0.6866, 0.0038, 0.8373,
      0.5923, 0.267, 0.1857, 0.5303, 0.173, 0.4877, 0.3195, 0.0374, 0.5566,
    ];
    const beta = [
      0.4483, 0.6697, 0.5266, 0.6247, 0.4723, 0.8821, 0.307, 0.5007, 0.6106, 0.4708, 0.0512, 0.0315,
      0.0618, 0.7835, 0.0271, 0.8427, 0.809, 0.4499, 0.0514, 0.5967,
    ];
    const rows = alpha.map((a, index) => ({ factors: { alpha: a, beta: beta[index] } }));
    const flagged = factorCorrelations(rows, ['alpha', 'beta'], 10);
    expect(flagged).toEqual([]);
  });

  it('finds no duplicate pairs among the 15 directional factors on a synthetic cross-section (test_no_duplicate_pairs_in_synthetic_cross_section)', () => {
    const rows: Row[] = [
      {
        symbol: 'S0',
        is_trusted: true,
        price_usd: 100.0,
        price_change_24h_pct: -4.0,
        price_change_72h_pct: 6.0,
        atr_14_pct: 1.8,
        oi_change_24h_pct: 8.0,
        oi_acceleration_4h_pct: 1.0,
        funding_rate_pct: 0.012,
        funding_avg_24h_pct: 0.008,
        long_short_account_ratio: 1.05,
        technical_trend_score: 0.4,
        technical_momentum_score: -0.2,
        taker_imbalance_24h_pct: 0.15,
        liquidation_imbalance_24h_pct: 0.05,
        quote_volume_usd: 50_000_000,
        volume_change_percent_24h: 12.0,
        long_liquidation_usd_24h: 900.0,
        short_liquidation_usd_24h: 1100.0,
        spread_bps: 2.0,
        depth_0_5pct_usd: 1_000_000.0,
      },
      {
        symbol: 'S1',
        is_trusted: true,
        price_usd: 101.0,
        price_change_24h_pct: -2.0,
        price_change_72h_pct: 3.0,
        atr_14_pct: 2.2,
        oi_change_24h_pct: -3.0,
        oi_acceleration_4h_pct: 2.5,
        funding_rate_pct: 0.018,
        funding_avg_24h_pct: 0.004,
        long_short_account_ratio: 1.4,
        technical_trend_score: -0.6,
        technical_momentum_score: 0.7,
        taker_imbalance_24h_pct: -0.25,
        liquidation_imbalance_24h_pct: 0.35,
        quote_volume_usd: 51_000_000,
        volume_change_percent_24h: 8.0,
        long_liquidation_usd_24h: 1200.0,
        short_liquidation_usd_24h: 800.0,
        spread_bps: 2.5,
        depth_0_5pct_usd: 1_100_000.0,
      },
      {
        symbol: 'S2',
        is_trusted: true,
        price_usd: 102.0,
        price_change_24h_pct: 1.0,
        price_change_72h_pct: -1.0,
        atr_14_pct: 1.5,
        oi_change_24h_pct: 5.0,
        oi_acceleration_4h_pct: -1.0,
        funding_rate_pct: -0.005,
        funding_avg_24h_pct: 0.011,
        long_short_account_ratio: 0.85,
        technical_trend_score: 0.2,
        technical_momentum_score: 0.1,
        taker_imbalance_24h_pct: 0.05,
        liquidation_imbalance_24h_pct: -0.15,
        quote_volume_usd: 52_000_000,
        volume_change_percent_24h: 15.0,
        long_liquidation_usd_24h: 700.0,
        short_liquidation_usd_24h: 1300.0,
        spread_bps: 1.8,
        depth_0_5pct_usd: 900_000.0,
      },
      {
        symbol: 'S3',
        is_trusted: true,
        price_usd: 103.0,
        price_change_24h_pct: 3.0,
        price_change_72h_pct: -4.0,
        atr_14_pct: 3.0,
        oi_change_24h_pct: -1.0,
        oi_acceleration_4h_pct: 0.5,
        funding_rate_pct: 0.009,
        funding_avg_24h_pct: 0.015,
        long_short_account_ratio: 1.15,
        technical_trend_score: 0.8,
        technical_momentum_score: -0.5,
        taker_imbalance_24h_pct: 0.4,
        liquidation_imbalance_24h_pct: 0.1,
        quote_volume_usd: 53_000_000,
        volume_change_percent_24h: 6.0,
        long_liquidation_usd_24h: 1000.0,
        short_liquidation_usd_24h: 900.0,
        spread_bps: 3.0,
        depth_0_5pct_usd: 1_200_000.0,
      },
      {
        symbol: 'S4',
        is_trusted: true,
        price_usd: 104.0,
        price_change_24h_pct: 5.0,
        price_change_72h_pct: 2.0,
        atr_14_pct: 2.5,
        oi_change_24h_pct: 12.0,
        oi_acceleration_4h_pct: 3.0,
        funding_rate_pct: 0.021,
        funding_avg_24h_pct: 0.006,
        long_short_account_ratio: 1.55,
        technical_trend_score: -0.3,
        technical_momentum_score: 0.9,
        taker_imbalance_24h_pct: -0.1,
        liquidation_imbalance_24h_pct: 0.25,
        quote_volume_usd: 54_000_000,
        volume_change_percent_24h: 20.0,
        long_liquidation_usd_24h: 1500.0,
        short_liquidation_usd_24h: 700.0,
        spread_bps: 2.2,
        depth_0_5pct_usd: 1_300_000.0,
      },
      {
        symbol: 'S5',
        is_trusted: true,
        price_usd: 105.0,
        price_change_24h_pct: -1.0,
        price_change_72h_pct: -6.0,
        atr_14_pct: 1.2,
        oi_change_24h_pct: -8.0,
        oi_acceleration_4h_pct: -2.0,
        funding_rate_pct: -0.011,
        funding_avg_24h_pct: -0.002,
        long_short_account_ratio: 0.95,
        technical_trend_score: 0.5,
        technical_momentum_score: -0.8,
        taker_imbalance_24h_pct: 0.3,
        liquidation_imbalance_24h_pct: -0.05,
        quote_volume_usd: 55_000_000,
        volume_change_percent_24h: 4.0,
        long_liquidation_usd_24h: 600.0,
        short_liquidation_usd_24h: 1400.0,
        spread_bps: 2.8,
        depth_0_5pct_usd: 800_000.0,
      },
      {
        symbol: 'S6',
        is_trusted: true,
        price_usd: 106.0,
        price_change_24h_pct: 2.0,
        price_change_72h_pct: 5.0,
        atr_14_pct: 2.8,
        oi_change_24h_pct: 2.0,
        oi_acceleration_4h_pct: 4.0,
        funding_rate_pct: 0.014,
        funding_avg_24h_pct: 0.019,
        long_short_account_ratio: 1.25,
        technical_trend_score: -0.1,
        technical_momentum_score: 0.3,
        taker_imbalance_24h_pct: -0.35,
        liquidation_imbalance_24h_pct: 0.18,
        quote_volume_usd: 56_000_000,
        volume_change_percent_24h: 11.0,
        long_liquidation_usd_24h: 1100.0,
        short_liquidation_usd_24h: 950.0,
        spread_bps: 2.1,
        depth_0_5pct_usd: 950_000.0,
      },
      {
        symbol: 'S7',
        is_trusted: true,
        price_usd: 107.0,
        price_change_24h_pct: -3.0,
        price_change_72h_pct: 1.0,
        atr_14_pct: 1.9,
        oi_change_24h_pct: -5.0,
        oi_acceleration_4h_pct: 1.5,
        funding_rate_pct: 0.007,
        funding_avg_24h_pct: 0.003,
        long_short_account_ratio: 1.1,
        technical_trend_score: 0.6,
        technical_momentum_score: -0.4,
        taker_imbalance_24h_pct: 0.22,
        liquidation_imbalance_24h_pct: -0.22,
        quote_volume_usd: 57_000_000,
        volume_change_percent_24h: 9.0,
        long_liquidation_usd_24h: 850.0,
        short_liquidation_usd_24h: 1150.0,
        spread_bps: 2.4,
        depth_0_5pct_usd: 1_050_000.0,
      },
      {
        symbol: 'S8',
        is_trusted: true,
        price_usd: 108.0,
        price_change_24h_pct: 4.0,
        price_change_72h_pct: -2.0,
        atr_14_pct: 3.5,
        oi_change_24h_pct: 9.0,
        oi_acceleration_4h_pct: -0.5,
        funding_rate_pct: -0.003,
        funding_avg_24h_pct: 0.01,
        long_short_account_ratio: 0.75,
        technical_trend_score: -0.7,
        technical_momentum_score: 0.6,
        taker_imbalance_24h_pct: -0.05,
        liquidation_imbalance_24h_pct: 0.3,
        quote_volume_usd: 58_000_000,
        volume_change_percent_24h: 18.0,
        long_liquidation_usd_24h: 1300.0,
        short_liquidation_usd_24h: 750.0,
        spread_bps: 3.2,
        depth_0_5pct_usd: 1_400_000.0,
      },
      {
        symbol: 'S9',
        is_trusted: true,
        price_usd: 109.0,
        price_change_24h_pct: 0.0,
        price_change_72h_pct: 4.0,
        atr_14_pct: 2.1,
        oi_change_24h_pct: -2.0,
        oi_acceleration_4h_pct: 2.0,
        funding_rate_pct: 0.016,
        funding_avg_24h_pct: 0.009,
        long_short_account_ratio: 1.35,
        technical_trend_score: 0.1,
        technical_momentum_score: -0.1,
        taker_imbalance_24h_pct: 0.18,
        liquidation_imbalance_24h_pct: -0.12,
        quote_volume_usd: 59_000_000,
        volume_change_percent_24h: 7.0,
        long_liquidation_usd_24h: 950.0,
        short_liquidation_usd_24h: 1050.0,
        spread_bps: 2.0,
        depth_0_5pct_usd: 1_000_000.0,
      },
      {
        symbol: 'S10',
        is_trusted: true,
        price_usd: 110.0,
        price_change_24h_pct: 6.0,
        price_change_72h_pct: -5.0,
        atr_14_pct: 1.7,
        oi_change_24h_pct: 6.0,
        oi_acceleration_4h_pct: 0.0,
        funding_rate_pct: 0.01,
        funding_avg_24h_pct: 0.017,
        long_short_account_ratio: 1.05,
        technical_trend_score: 0.9,
        technical_momentum_score: 0.2,
        taker_imbalance_24h_pct: -0.28,
        liquidation_imbalance_24h_pct: 0.08,
        quote_volume_usd: 60_000_000,
        volume_change_percent_24h: 22.0,
        long_liquidation_usd_24h: 1400.0,
        short_liquidation_usd_24h: 650.0,
        spread_bps: 2.6,
        depth_0_5pct_usd: 1_250_000.0,
      },
      {
        symbol: 'S11',
        is_trusted: true,
        price_usd: 111.0,
        price_change_24h_pct: -5.0,
        price_change_72h_pct: 0.0,
        atr_14_pct: 2.4,
        oi_change_24h_pct: -6.0,
        oi_acceleration_4h_pct: -3.0,
        funding_rate_pct: -0.008,
        funding_avg_24h_pct: 0.013,
        long_short_account_ratio: 0.9,
        technical_trend_score: -0.4,
        technical_momentum_score: 0.4,
        taker_imbalance_24h_pct: 0.12,
        liquidation_imbalance_24h_pct: -0.28,
        quote_volume_usd: 61_000_000,
        volume_change_percent_24h: 5.0,
        long_liquidation_usd_24h: 800.0,
        short_liquidation_usd_24h: 1250.0,
        spread_bps: 2.3,
        depth_0_5pct_usd: 850_000.0,
      },
    ];
    const context = { median_atr_pct: 2.5 };
    const raw = rows.map((row) => rawFactors(row, rows, context));
    const normalized = normalizeFactors(raw);
    const correlationRows = normalized.map((factors) => ({ factors }));
    const flagged = factorCorrelations(correlationRows, DIRECTIONAL_FACTORS, 10);
    const duplicates = flagged.filter((item) => Math.abs(item.rho) >= 0.95);
    expect(duplicates).toEqual([]);
  });

  it('leaves reversal_3d null without a 72h change (test_reversal_none_without_72h_change)', () => {
    const row: Row = { symbol: 'BTC', price_change_24h_pct: 5.0, price_change_72h_pct: null };
    const raw = rawFactors(row, [row], { median_atr_pct: 2.0 });
    expect(raw.reversal_3d).toBeNull();
  });

  it('residualisation keeps oi_price_signal vs momentum_24h below the redundant threshold on the frozen fixture snapshot (test_residualisation_defeats_oi_price_signal_momentum_collinearity)', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
    const rhoAgainstMomentum = (residualise: boolean): number | null => {
      const configInput = fixture.config as Record<string, unknown>;
      const factorsInput = (configInput.factors ?? {}) as Record<string, unknown>;
      const config = AppConfigSchema.parse({
        ...configInput,
        factors: { ...factorsInput, residualise_collinear_factors: residualise },
      });
      const rows: Row[] = JSON.parse(JSON.stringify(fixture.input_rows));
      const result = scoreSnapshot(
        rows,
        fixture.market_context,
        fixture.factor_history,
        config,
        undefined,
      );
      const pairs = result.rows
        .filter((row) => row.is_trusted !== false)
        .map((row) => {
          const factors = row.factors as Record<string, number>;
          return [factors.momentum_24h, factors.oi_price_signal];
        })
        .filter((pair): pair is [number, number] => pair.every((v) => typeof v === 'number'));
      return spearmanCorr(
        pairs.map((pair) => pair[0]),
        pairs.map((pair) => pair[1]),
      );
    };

    // rhoOff/rhoOn come from scoreSnapshot() over the frozen fixture, not hand math. Both already
    // clear REDUNDANT_THRESHOLD (0.8) here, but rhoOn < rhoOff shows the fix still cuts collinearity;
    // OLS zeroes the raw Pearson correlation, not this rank (Spearman) one.
    const rhoOff = rhoAgainstMomentum(false);
    const rhoOn = rhoAgainstMomentum(true);
    expect(rhoOff as number).toBeCloseTo(0.5449419588877543, 6);
    expect(rhoOn as number).toBeCloseTo(-0.4468561458831433, 6);
    expect(Math.abs(rhoOn as number)).toBeLessThan(0.8); // independence.ts's REDUNDANT_THRESHOLD
    expect(Math.abs(rhoOn as number)).toBeLessThan(Math.abs(rhoOff as number));
  });
});

describe('retired factors', () => {
  it('does not list btc_relative_strength in DIRECTIONAL_FACTORS or DEFAULT_PRIORS (test_btc_relative_strength_removed_from_definitions)', () => {
    expect(DIRECTIONAL_FACTORS).not.toContain('btc_relative_strength');
    expect(DEFAULT_PRIORS).not.toHaveProperty('btc_relative_strength');
    expect(DIRECTIONAL_FACTORS).not.toContain('reversal_1d');
    expect(DEFAULT_PRIORS).not.toHaveProperty('reversal_1d');
  });
});

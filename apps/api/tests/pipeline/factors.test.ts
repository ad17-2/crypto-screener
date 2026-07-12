import { describe, expect, it } from 'vitest';
import { rawFactors, residualiseOiPriceSignal, scoreSnapshot } from '../../src/pipeline/factors.js';
import type { Row } from '../../src/pipeline/types.js';
import { factorWeights } from '../../src/pipeline/weighting.js';

describe('factorWeights', () => {
  it('falls back to prior weights without history (test_prior_weights_without_history)', () => {
    const config = { factors: { min_observations: 30 } };
    const weights = factorWeights([], config);
    expect(weights.mode).toBe('prior');
    expect(weights.directional.momentum_24h as number).toBeGreaterThan(0);
    expect(weights.validation.status).toBe('insufficient');
  });

  it('includes validation metrics (test_factor_weights_include_validation_metrics)', () => {
    const records = [
      {
        forward_return_pct: 2,
        factors: { momentum_24h: 1, reversal_3d: -1 },
        scores: { factor_score: 0.4 },
      },
      {
        forward_return_pct: -3,
        factors: { momentum_24h: -1, reversal_3d: 1 },
        scores: { factor_score: -0.5 },
      },
      {
        forward_return_pct: 1,
        factors: { momentum_24h: -1, reversal_3d: 1 },
        scores: { factor_score: -0.2 },
      },
    ];
    const weights = factorWeights(records, { factors: { min_observations: 3, min_abs_ic: 0.0 } });

    expect(weights.validation.observations).toBe(3);
    expect(weights.validation.model.hit_rate as number).toBeCloseTo(66.67, 2);
    expect(weights.validation.factors).toHaveProperty('momentum_24h');
  });

  it('weights factors by cross-sectional IC when there is enough history (test_cross_sectional_ic_weighting)', () => {
    const records: Array<Record<string, unknown>> = [];
    const symbols = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let period = 0; period < 12; period += 1) {
      const generatedAt = `2026-01-${String(period + 1).padStart(2, '0')}T00:00:00`;
      symbols.forEach((symbol, index) => {
        const rank = index + 1;
        let forward = rank;
        if (period % 2 === 1 && index === 2) {
          forward = 4.0;
        } else if (period % 2 === 1 && index === 3) {
          forward = 3.0;
        }
        records.push({
          symbol,
          generated_at: generatedAt,
          forward_return_pct: forward,
          factors: {
            momentum_24h: rank,
            reversal_3d: period % 2 === 0 ? rank : -rank,
          },
        });
      });
    }
    const config = {
      factors: {
        ic_min_periods: 10,
        min_abs_t: 2.0,
        min_abs_ic: 0.02,
        ic_prior_strength: 10,
        ic_min_cross_section: 5,
        // Pinned to the rank_ic escape hatch: only 6 symbols/period, under economicEdge's
        // minNamesPerPeriod (20), and no forward_return_vol_adj on these records -- this test is
        // about the pooled cross-sectional IC blend, not net_edge selection or vol-adjustment.
        selection_objective: 'rank_ic' as const,
        ic_target: 'raw' as const,
      },
    };
    const weights = factorWeights(records, config);
    expect(weights.stats.momentum_24h?.mode).toBe('ic');
    expect(weights.stats.reversal_3d?.mode).toBe('prior');
  });
});

describe('rawFactors', () => {
  it('normalizes reversal by volatility (test_reversal_is_volatility_normalized)', () => {
    const rows: Row[] = [
      {
        symbol: 'LOWVOL',
        price_change_24h_pct: 10.0,
        price_change_72h_pct: 10.0,
        atr_14_pct: 2.0,
        quote_volume_usd: 1,
      },
      {
        symbol: 'HIGHVOL',
        price_change_24h_pct: 10.0,
        price_change_72h_pct: 10.0,
        atr_14_pct: 5.0,
        quote_volume_usd: 1,
      },
    ];
    const context = { median_atr_pct: 3.5 };
    const low = rawFactors(rows[0] as Row, rows, context);
    const high = rawFactors(rows[1] as Row, rows, context);
    expect(low.reversal_3d).not.toBeCloseTo(high.reversal_3d as number, 5);
    expect(low.reversal_3d).toBeCloseTo(-5.0, 9);
    expect(high.reversal_3d).toBeCloseTo(-2.0, 9);
  });

  it('drives ls_ratio_contrarian off the account ratio (test_account_ratio_drives_ls_contrarian)', () => {
    const row: Row = {
      long_short_account_ratio: 2.0,
      long_short_ratio: 1.1,
      quote_volume_usd: 1_000_000,
    };
    const raw = rawFactors(row, [row], {});
    expect(raw.ls_ratio_contrarian).toBeCloseTo(-Math.log(2.0), 9);
  });
});

describe('residualiseOiPriceSignal', () => {
  it('replaces oi_price_signal with its OLS residual against momentum_24h (test_residualise_computes_ols_residual)', () => {
    const rows: Array<Record<string, number | null>> = [
      { momentum_24h: 1, oi_price_signal: 2 },
      { momentum_24h: 2, oi_price_signal: 3 },
      { momentum_24h: 3, oi_price_signal: 5 },
      { momentum_24h: 4, oi_price_signal: 6 },
      { momentum_24h: 5, oi_price_signal: 9 },
    ];
    // Hand OLS: xbar=3, ybar=5, dx=[-2,-1,0,1,2], dy=[-3,-2,0,1,4].
    // slope = sum(dx*dy)/sum(dx^2) = 17/10 = 1.7; intercept = 5 - 1.7*3 = -0.1.
    // residual_i = y_i - (intercept + slope * x_i).
    residualiseOiPriceSignal(rows, 5);
    expect(rows[0]?.oi_price_signal).toBeCloseTo(0.4, 9);
    expect(rows[1]?.oi_price_signal).toBeCloseTo(-0.3, 9);
    expect(rows[2]?.oi_price_signal).toBeCloseTo(0.0, 9);
    expect(rows[3]?.oi_price_signal).toBeCloseTo(-0.7, 9);
    expect(rows[4]?.oi_price_signal).toBeCloseTo(0.6, 9);
  });

  it('leaves rows without a paired value untouched (test_residualise_skips_unpaired_rows)', () => {
    const rows: Array<Record<string, number | null>> = [
      { momentum_24h: 1, oi_price_signal: 2 },
      { momentum_24h: 2, oi_price_signal: 3 },
      { momentum_24h: 3, oi_price_signal: 5 },
      { momentum_24h: 4, oi_price_signal: 6 },
      { momentum_24h: 5, oi_price_signal: 9 },
      { momentum_24h: null, oi_price_signal: null },
    ];
    residualiseOiPriceSignal(rows, 5);
    expect(rows[5]?.oi_price_signal).toBeNull();
    expect(rows[0]?.oi_price_signal).toBeCloseTo(0.4, 9);
  });

  it('falls back to the raw value below minCrossSection paired rows (test_residualise_falls_back_below_min_cross_section)', () => {
    const rows: Array<Record<string, number | null>> = [
      { momentum_24h: 1, oi_price_signal: 2 },
      { momentum_24h: 2, oi_price_signal: 3 },
      { momentum_24h: 3, oi_price_signal: 5 },
      { momentum_24h: null, oi_price_signal: null },
      { momentum_24h: null, oi_price_signal: null },
    ];
    residualiseOiPriceSignal(rows, 5);
    expect(rows.map((row) => row.oi_price_signal)).toEqual([2, 3, 5, null, null]);
  });

  it('falls back to the raw value when momentum_24h has zero cross-sectional variance (test_residualise_falls_back_on_zero_variance)', () => {
    const rows: Array<Record<string, number | null>> = [
      { momentum_24h: 3, oi_price_signal: 1 },
      { momentum_24h: 3, oi_price_signal: 2 },
      { momentum_24h: 3, oi_price_signal: 3 },
      { momentum_24h: 3, oi_price_signal: 4 },
      { momentum_24h: 3, oi_price_signal: 5 },
    ];
    residualiseOiPriceSignal(rows, 5);
    expect(rows.map((row) => row.oi_price_signal)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('scoreSnapshot', () => {
  function longShortRows(): Row[] {
    return [
      {
        symbol: 'LONG',
        price_usd: 10,
        price_change_24h_pct: 5,
        oi_change_24h_pct: 4,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
        long_liquidation_usd_24h: 1_000_000,
        short_liquidation_usd_24h: 2_000_000,
        technical_trend_score: 0.8,
        technical_momentum_score: 0.6,
        oi_acceleration_4h_pct: 3,
        funding_avg_24h_pct: 0.01,
        taker_imbalance_24h_pct: 8,
        liquidation_imbalance_24h_pct: 12,
      },
      {
        symbol: 'SHORT',
        price_usd: 10,
        price_change_24h_pct: -5,
        oi_change_24h_pct: 5,
        funding_rate_pct: 0.04,
        quote_volume_usd: 100_000_000,
        long_liquidation_usd_24h: 3_000_000,
        short_liquidation_usd_24h: 500_000,
        technical_trend_score: -0.7,
        technical_momentum_score: -0.5,
        oi_acceleration_4h_pct: 4,
        funding_avg_24h_pct: 0.04,
        taker_imbalance_24h_pct: -10,
        liquidation_imbalance_24h_pct: -20,
      },
      {
        symbol: 'BTC',
        price_usd: 100,
        price_change_24h_pct: 1,
        oi_change_24h_pct: 1,
        funding_rate_pct: 0.01,
        quote_volume_usd: 200_000_000,
      },
    ];
  }

  it('ranks long and short setups correctly (test_score_snapshot_ranks_long_and_short)', () => {
    const scored = scoreSnapshot(longShortRows(), {}, [], { factors: {} }).rows;
    const longRow = scored.find((row) => row.symbol === 'LONG') as Row;
    const shortRow = scored.find((row) => row.symbol === 'SHORT') as Row;
    expect(longRow.long_score as number).toBeGreaterThan(longRow.short_score as number);
    expect(shortRow.short_score as number).toBeGreaterThan(shortRow.long_score as number);
    expect(longRow.factors).toHaveProperty('technical_trend_4h');
    expect(longRow.factors).toHaveProperty('oi_acceleration_signal');
    expect(longRow.factors).toHaveProperty('taker_flow_24h');
    expect(longRow.confidence_score as number).toBeGreaterThan(0);
    expect(scoreSnapshot(longShortRows(), {}, [], { factors: {} }).market_context).toHaveProperty(
      'breadth',
    );
  });

  it('adds regime adjustments and conflict labels (test_score_snapshot_adds_regime_adjustments_and_conflict_labels)', () => {
    const rows: Row[] = [
      {
        symbol: 'BTC',
        price_usd: 100,
        price_change_24h_pct: 3,
        oi_change_24h_pct: 2,
        funding_rate_pct: 0.01,
        quote_volume_usd: 200_000_000,
        technical_trend_score: 0.8,
        technical_momentum_score: 0.7,
        derivatives_confirmation_score: 0.8,
      },
      {
        symbol: 'ALT',
        price_usd: 10,
        price_change_24h_pct: 5,
        oi_change_24h_pct: 4,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
        technical_trend_score: -0.8,
        technical_momentum_score: -0.7,
        derivatives_confirmation_score: -0.8,
        taker_imbalance_24h_pct: -8,
      },
      {
        symbol: 'WEAK',
        price_usd: 10,
        price_change_24h_pct: -4,
        oi_change_24h_pct: 3,
        funding_rate_pct: 0.03,
        quote_volume_usd: 80_000_000,
        technical_trend_score: 0.5,
        technical_momentum_score: 0.4,
        derivatives_confirmation_score: 0.5,
        taker_imbalance_24h_pct: 6,
      },
    ];
    const context = {
      market_cap_change_24h_pct: 2,
      categories: {
        leaders: [{ name: 'Layer 1', market_cap_change_24h_pct: 3 }],
        laggards: [{ name: 'Meme', market_cap_change_24h_pct: -1 }],
      },
    };

    const scored = scoreSnapshot(rows, context, [], { factors: {} });
    const alt = scored.rows.find((row) => row.symbol === 'ALT') as Row;

    expect(scored.factor_weights.regime_adjusted).toBe(true);
    expect(scored.factor_weights).toHaveProperty('base_directional');
    expect((scored.market_context.breadth as Record<string, unknown>).status).toBe('ok');
    expect(['selective-risk-on', 'broad-risk-on', 'mixed']).toContain(scored.regime.breadth_label);
    expect(alt.signal_conflict_label).toBe('high-conflict');
    expect(alt.signal_conflict_score as number).toBeGreaterThan(0);
    expect((alt.signal_conflicts as unknown[]).length).toBeGreaterThan(0);
  });

  it('residualise_collinear_factors=false reproduces the raw copysign value (test_residualise_toggle_wired_through_scoresnapshot)', () => {
    function fiveRows(): Row[] {
      return Array.from({ length: 5 }, (_, index) => ({
        symbol: `S${index}`,
        price_usd: 10,
        price_change_24h_pct: index + 1,
        oi_change_24h_pct: (index + 1) * 2,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
      }));
    }
    const off = scoreSnapshot(fiveRows(), {}, [], {
      factors: { residualise_collinear_factors: false },
    });
    const on = scoreSnapshot(fiveRows(), {}, [], {
      factors: { residualise_collinear_factors: true },
    });
    const offRow = off.rows.find((row) => row.symbol === 'S2') as Row;
    const onRow = on.rows.find((row) => row.symbol === 'S2') as Row;
    // priceChange=3, oiChange=6 -> copysign(6, 3) = 6, unresidualised.
    expect((offRow.raw_factors as Record<string, number>).oi_price_signal).toBeCloseTo(6, 9);
    // oiChange is exactly 2x priceChange across all 5 rows -> the OLS fit is exact, residual 0.
    expect((onRow.raw_factors as Record<string, number>).oi_price_signal).toBeCloseTo(0, 9);
  });

  it('wires config.costs through to scores.round_trip_cost_pct (test_costs_config_wired_through_scoresnapshot)', () => {
    // Momentum spread across 5 rows (like the residualise test above) so z-scoring is meaningful;
    // funding_rate_pct is constant, so it doesn't itself drive which row goes long or short.
    const rows: Row[] = Array.from({ length: 5 }, (_, index) => ({
      symbol: `S${index}`,
      price_usd: 10,
      price_change_24h_pct: index + 1,
      oi_change_24h_pct: (index + 1) * 2,
      funding_rate_pct: 0.01,
      quote_volume_usd: 100_000_000,
    }));
    const scored = scoreSnapshot(rows, {}, [], {
      factors: { forward_return_hours: 24 },
      costs: { taker_fee_bps: 0, slippage_bps: 0, assumed_spread_bps: 0 },
    });
    const top = scored.rows.find((row) => row.symbol === 'S4') as Row;
    // Highest momentum in the cross-section -> long side. With fee/slippage/spread zeroed out,
    // only funding remains: 0.01 * 3 settlements/day * (24/24) = 0.03.
    expect((top.factor_score as number) > 0).toBe(true);
    expect((top.scores as { round_trip_cost_pct: number }).round_trip_cost_pct).toBeCloseTo(
      0.03,
      9,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { scoreSnapshot } from '../../src/pipeline/factors.js';
import { marketSensingSummary } from '../../src/pipeline/market.js';
import { classifyRegime, inferRegime, REGIME_STATES } from '../../src/pipeline/regime.js';
import type { Row } from '../../src/pipeline/types.js';

const config = { factors: { regime: {} } };

function btcEthRows(btcChange: number, ethChange: number): Row[] {
  return [
    { symbol: 'BTC', price_change_24h_pct: btcChange, is_trusted: true },
    { symbol: 'ETH', price_change_24h_pct: ethChange, is_trusted: true },
  ];
}

describe('classifyRegime', () => {
  it('classifies btc-led (test_classify_btc_led)', () => {
    const context = {
      btc_dominance_delta_pct: 0.4,
      eth_btc_performance_pct: -1.5,
      return_dispersion_pct: 3.0,
      breadth: { score: -0.2 },
    };
    expect(classifyRegime(context, null, config).state).toBe('btc-led');
  });

  it('classifies alts-strong (test_classify_alts_strong)', () => {
    const context = {
      btc_dominance_delta_pct: -0.4,
      eth_btc_performance_pct: 2.0,
      return_dispersion_pct: 3.0,
      breadth: { score: 0.4 },
    };
    expect(classifyRegime(context, null, config).state).toBe('alts-strong');
  });

  it('classifies chaos (test_classify_chaos)', () => {
    const context = {
      btc_dominance_delta_pct: 0.0,
      eth_btc_performance_pct: 0.0,
      return_dispersion_pct: 12.0,
      breadth: { score: 0.05 },
    };
    expect(classifyRegime(context, null, config).state).toBe('chaos');
  });

  it('classifies neutral (test_classify_neutral)', () => {
    const context = {
      btc_dominance_delta_pct: 0.05,
      eth_btc_performance_pct: 0.2,
      return_dispersion_pct: 2.0,
      breadth: { score: 0.1 },
    };
    expect(classifyRegime(context, null, config).state).toBe('neutral');
  });

  it('guards a zero scale config against NaN (test_classify_regime_zero_scale_guard)', () => {
    const context = {
      btc_dominance_delta_pct: 0.4,
      eth_btc_performance_pct: 0.0,
      return_dispersion_pct: 3.0,
      breadth: { score: -0.2 },
    };
    const zeroScaleConfig = {
      factors: {
        regime: { dominance_delta_scale_pct: 0, eth_btc_scale_pct: 0 },
      },
    };
    const result = classifyRegime(context, null, zeroScaleConfig);
    for (const state of REGIME_STATES) {
      expect(Number.isFinite(result.scores[state])).toBe(true);
    }
  });

  it('hysteresis blocks a marginal flip (test_hysteresis_blocks_marginal_flip)', () => {
    const context = {
      btc_dominance_delta_pct: 0.15,
      eth_btc_performance_pct: 0.25,
      return_dispersion_pct: 2.0,
      breadth: { score: 0.26 },
    };
    const without = classifyRegime(context, null, config);
    const withPrior = classifyRegime(context, 'btc-led', config);
    expect(without.raw_state).toBe('alts-strong');
    expect(withPrior.state).toBe('btc-led');
  });

  it('hysteresis allows a clear flip (test_hysteresis_allows_clear_flip)', () => {
    const context = {
      btc_dominance_delta_pct: -0.8,
      eth_btc_performance_pct: 4.0,
      return_dispersion_pct: 2.0,
      breadth: { score: 0.6 },
    };
    expect(classifyRegime(context, 'btc-led', config).state).toBe('alts-strong');
  });
});

describe('inferRegime', () => {
  it('is stable across repeated calls (test_infer_regime_independent_of_weights)', () => {
    const rows = btcEthRows(2.0, 1.0);
    const context = {
      market_cap_change_24h_pct: 1.0,
      btc_dominance_delta_pct: 0.3,
      eth_btc_performance_pct: -0.5,
      return_dispersion_pct: 2.0,
      breadth: { score: -0.1, label: 'mixed' },
      sector_rotation: { label: 'mixed' },
    };
    const first = inferRegime(rows, context, null, config);
    const second = inferRegime(rows, context, null, config);
    expect(first.label).toBe(second.label);
    expect(first.regime_state).toBe(second.regime_state);
  });
});

describe('marketSensingSummary', () => {
  it('leaves btc_dominance_delta_pct null on the first run (test_market_sensing_first_run_delta_none)', () => {
    const rows = btcEthRows(2.0, 3.0);
    const summary = marketSensingSummary(rows, { btc_dominance_pct: 55.0 }, null);
    expect(summary.btc_dominance_delta_pct).toBeNull();
    expect(summary.eth_btc_performance_pct).toBeCloseTo(0.980392, 5);
  });

  it('guards dispersion with fewer than 2 price changes (test_market_sensing_dispersion_guard)', () => {
    const rows: Row[] = [{ symbol: 'BTC', price_change_24h_pct: 1.0, is_trusted: true }];
    const summary = marketSensingSummary(
      rows,
      { btc_dominance_pct: 55.0 },
      { btc_dominance_pct: 54.0 },
    );
    expect(summary.return_dispersion_pct).toBeNull();
    expect(summary.btc_dominance_delta_pct).toBeCloseTo(1.0, 9);
  });

  it('reads the alt-alt correlation scalars enrichment.ts stashed on the BTC row, and strips them off it; derives mean_btc_correlation/correlation_spread itself', () => {
    const rows: Row[] = [
      {
        symbol: 'BTC',
        is_trusted: true,
        alt_alt_mean_correlation: 0.1,
        alt_alt_correlation_pairs: 120,
      },
      { symbol: 'ETH', price_change_24h_pct: 1.0, is_trusted: true, btc_correlation: 0.5 },
      { symbol: 'SOL', price_change_24h_pct: 2.0, is_trusted: true, btc_correlation: 0.3 },
    ];

    const summary = marketSensingSummary(rows, {}, null);

    expect(summary.mean_btc_correlation).toBeCloseTo(0.4, 9); // mean(0.5, 0.3)
    expect(summary.alt_alt_mean_correlation).toBeCloseTo(0.1, 9);
    expect(summary.correlation_spread).toBeCloseTo(0.3, 9); // 0.4 - 0.1
    expect(summary.alt_alt_correlation_pairs).toBe(120);

    // Must never leak into a persisted row_json -- these are market-wide, not a BTC fact.
    const btcRow = rows.find((row) => row.symbol === 'BTC');
    expect(btcRow).not.toHaveProperty('alt_alt_mean_correlation');
    expect(btcRow).not.toHaveProperty('alt_alt_correlation_pairs');
  });

  it('returns null correlation-structure scalars when the BTC row carries none (test isolation, no crash)', () => {
    const rows = btcEthRows(1.0, 2.0);
    const summary = marketSensingSummary(rows, {}, null);
    expect(summary.mean_btc_correlation).toBeNull();
    expect(summary.alt_alt_mean_correlation).toBeNull();
    expect(summary.correlation_spread).toBeNull();
    expect(summary.alt_alt_correlation_pairs).toBeNull();
  });

  it('still delivers the alt-alt correlation scalars, and clears them off the row, when BTC itself is untrusted for the cycle (quality.ts applyDataQuality runs AFTER enrichment, so BTC can fail quality without enrichment ever knowing)', () => {
    const rows: Row[] = [
      {
        symbol: 'BTC',
        is_trusted: false,
        alt_alt_mean_correlation: 0.08,
        alt_alt_correlation_pairs: 45,
      },
      { symbol: 'ETH', price_change_24h_pct: 1.0, is_trusted: true, btc_correlation: 0.6 },
    ];

    const summary = marketSensingSummary(rows, {}, null);

    expect(summary.alt_alt_mean_correlation).toBeCloseTo(0.08, 9);
    expect(summary.alt_alt_correlation_pairs).toBe(45);

    // Finding against the trusted-filtered set (BTC excluded) would leave these on the real row
    // object instead of deleting them -- they'd ship inside BTC's persisted row_json.
    const btcRow = rows.find((row) => row.symbol === 'BTC');
    expect(btcRow).not.toHaveProperty('alt_alt_mean_correlation');
    expect(btcRow).not.toHaveProperty('alt_alt_correlation_pairs');
  });

  it("excludes an untrusted row's btc_correlation from mean_btc_correlation", () => {
    const rows: Row[] = [
      { symbol: 'BTC', is_trusted: true },
      { symbol: 'ETH', is_trusted: true, btc_correlation: 0.8 },
      { symbol: 'SOL', is_trusted: false, btc_correlation: -0.9 }, // must not pull the mean down
    ];

    const summary = marketSensingSummary(rows, {}, null);

    expect(summary.mean_btc_correlation).toBeCloseTo(0.8, 9);
  });
});

describe('scoreSnapshot regime integration', () => {
  it('merges sensing fields into market_context (test_score_snapshot_merges_sensing_fields)', () => {
    const rows = btcEthRows(1.0, 2.0);
    const scored = scoreSnapshot(rows, { btc_dominance_pct: 56.0 }, config, {
      btc_dominance_pct: 55.0,
      regime_state: 'neutral',
    });
    const context = scored.market_context;
    expect(context.btc_dominance_delta_pct as number).toBeCloseTo(1.0, 9);
    expect(context.eth_btc_performance_pct).not.toBeNull();
    expect(['btc-led', 'alts-strong', 'neutral', 'chaos']).toContain(scored.regime.regime_state);
  });

  // Regression for scoreSnapshot passing marketSensingSummary the UNFILTERED `rows`, not
  // `trustedRows`: an untrusted BTC row is exactly where enrichment.ts's appendCoinglassTechnicals
  // stashes alt_alt_mean_correlation/alt_alt_correlation_pairs (see enrichment.ts + market.ts's
  // correlationStructureSummary). Pre-filtering trusted rows before the call would hide that BTC
  // row from the find-and-delete step, which both nulls these market_context fields AND leaves the
  // stashed keys on the row object to be persisted into market_rows.row_json (db/runs.ts
  // stringifies whole rows with no allowlist) -- unlike the marketSensingSummary-direct tests above,
  // which call marketSensingSummary with the already-unfiltered `rows` themselves and so pass
  // regardless of how scoreSnapshot happens to call it.
  it('threads the alt-alt correlation stash through scoreSnapshot and strips it off the untrusted BTC row (test_score_snapshot_strips_alt_alt_correlation_stash)', () => {
    const rows: Row[] = [
      {
        symbol: 'BTC',
        is_trusted: false,
        alt_alt_mean_correlation: 0.1,
        alt_alt_correlation_pairs: 120,
      },
      { symbol: 'ETH', price_change_24h_pct: 1.0, is_trusted: true, btc_correlation: 0.5 },
      { symbol: 'SOL', price_change_24h_pct: 2.0, is_trusted: true, btc_correlation: 0.3 },
    ];

    const scored = scoreSnapshot(rows, {}, config);
    const context = scored.market_context;

    expect(context.alt_alt_mean_correlation).toBeCloseTo(0.1, 9);
    expect(context.alt_alt_correlation_pairs).toBe(120);
    expect(context.correlation_spread).toBeCloseTo(0.3, 9); // mean_btc_correlation(0.4) - alt_alt_mean(0.1)

    // The leak assertion: these market-wide scalars must not survive on the BTC row object, or
    // they'd be persisted into market_rows.row_json alongside it.
    const btcRow = scored.rows.find((row) => row.symbol === 'BTC');
    expect(btcRow).not.toHaveProperty('alt_alt_mean_correlation');
    expect(btcRow).not.toHaveProperty('alt_alt_correlation_pairs');
  });
});

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
});

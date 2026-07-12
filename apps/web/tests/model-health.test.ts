import { describe, expect, it } from 'vitest';
import {
  collinearityRisks,
  decaySummary,
  type EvidenceRung,
  evidenceLadder,
  factorHealthRows,
  factorHitRates,
  factorWeightMix,
  modelHealthVerdict,
  negativeWeightRows,
  oosIcSummary,
  REGIME_MIN_PERIODS,
  regimeIcSummary,
  walkForwardSummary,
} from '../lib/model-health';

/**
 * Word-bounded on purpose: an unanchored /null|NaN|undefined/i also fires inside ordinary English
 * ("domi-nan-ce"), which fails on correct output. We only care about these as leaked *values*.
 */
const NO_LEAKED_VALUES = /\b(null|NaN|undefined)\b/i;

function assertClean(text: string): void {
  expect(text).not.toMatch(NO_LEAKED_VALUES);
}

interface RealisticPayload {
  quality: unknown;
  validation: unknown;
  model_weights: unknown;
}

// A trimmed, hand-written stand-in for the real prod payload's shape (see the field-semantics
// audit this module was built from) -- enough factors to exercise sorting/ranking meaningfully,
// not all 12. Mirrors real numbers where it matters (technical_trend_4h's negative weight & the
// momentum_24h/oi_price_signal redundant pair) so the derivations read true against reality.
function realisticPayload(): RealisticPayload {
  return {
    quality: { trusted_count: 42, excluded_count: 1, flagged_count: 1 },
    validation: {
      observations: 5084,
      horizon_hours: 24,
      model: { observations: 0, hit_rate: null, avg_forward_return_pct: null },
      calibration_label: 'learning',
      factors: {
        taker_flow_24h: { hit_rate: 52.55, observations: 4384 },
        liquidation_imbalance: { hit_rate: 51.53, observations: 4902 },
        ls_ratio_contrarian: { hit_rate: 47.01, observations: 4903 },
        technical_trend_4h: { hit_rate: 48.32, observations: 4377 },
      },
    },
    model_weights: {
      mode: 'ic',
      regime: {
        factors_using_regime_ic: [],
        label: 'alts-strong',
        regime_n_periods: {
          momentum_24h: 3,
          oi_price_signal: 3,
          technical_trend_4h: 3,
        },
      },
      factor_correlations: [
        { a: 'momentum_24h', b: 'oi_price_signal', rho: 0.8967, verdict: 'redundant' },
        {
          a: 'liquidation_imbalance',
          b: 'liquidation_pressure_24h',
          rho: -0.7815,
          verdict: 'correlated',
        },
      ],
      factor_decay: {
        taker_flow_24h: {
          sufficient: true,
          holds_hours: 12,
          peak_horizon_hours: 4,
          peak_abs_ic: 0.0227,
          curve: [
            { horizon_hours: 4, mean_ic: 0.0227, insufficient: false },
            { horizon_hours: 8, mean_ic: 0.017, insufficient: false },
          ],
        },
        momentum_24h: {
          sufficient: true,
          holds_hours: 24,
          peak_horizon_hours: 8,
          peak_abs_ic: 0.03,
          curve: [{ horizon_hours: 8, mean_ic: 0.03, insufficient: false }],
        },
      },
      walk_forward: { n_timestamps: 199, split_index: 119, train_periods: 119 },
      factors: [
        {
          name: 'momentum_24h',
          label: 'Momentum',
          weight: 0.2155,
          base_weight: 0.2155,
          mode: 'prior',
          ic: -0.0241,
          t_stat: -1.312,
          n_periods: 199,
          credibility_k: 0,
          regime_multiplier: 1,
          robustness: 'insufficient-data',
          oos_ic: -0.0955,
          regime_ic: -0.1709,
          regime_mode: 'pooled',
          net_spread_pct: -0.3,
          edge_t_stat: -1.1,
        },
        {
          name: 'oi_price_signal',
          label: 'OI/Price',
          weight: 0.1437,
          base_weight: 0.1437,
          mode: 'prior',
          ic: -0.0116,
          t_stat: -0.655,
          n_periods: 199,
          credibility_k: 0,
          regime_multiplier: 1,
          robustness: 'insufficient-data',
          oos_ic: -0.0448,
          regime_ic: -0.1459,
          regime_mode: 'pooled',
          net_spread_pct: -0.1,
          edge_t_stat: -0.4,
        },
        {
          name: 'technical_trend_4h',
          label: '4h Trend',
          weight: -0.037,
          base_weight: -0.037,
          mode: 'ic',
          ic: -0.0606,
          t_stat: -3.45,
          n_periods: 199,
          credibility_k: 0.952,
          regime_multiplier: 1,
          robustness: 'insufficient-data',
          oos_ic: -0.1026,
          regime_ic: -0.05,
          regime_mode: 'pooled',
          // The one factor that's both statistically significant AND still makes money after costs.
          net_spread_pct: 0.8,
          edge_t_stat: -3.45,
        },
        {
          name: 'taker_flow_24h',
          label: 'Taker Flow',
          weight: 0.09,
          base_weight: 0.09,
          mode: 'prior',
          ic: 0.02,
          t_stat: 1.917,
          n_periods: 199,
          credibility_k: 0,
          regime_multiplier: 1,
          robustness: 'insufficient-data',
          oos_ic: -0.0096,
          regime_ic: 0.01,
          regime_mode: 'pooled',
          net_spread_pct: 0.2,
          edge_t_stat: 1.6,
        },
      ],
    },
  };
}

describe('evidenceLadder', () => {
  it('orders rungs 1 (clean data) through 4 (scored end to end), bottom to top', () => {
    const rungs = evidenceLadder(realisticPayload());
    expect(rungs.map((r) => r.key)).toEqual([
      'clean_data',
      'signals_measured',
      'measurements_strong',
      'scored_end_to_end',
    ]);
  });

  it('reads the realistic payload honestly: clean data passes, nothing scored end to end', () => {
    const rungs = evidenceLadder(realisticPayload());
    const byKey = Object.fromEntries(rungs.map((r) => [r.key, r]));
    expect(byKey.clean_data?.status).toBe('pass');
    expect(byKey.signals_measured?.status).toBe('pass');
    // Only 1 of 4 sample factors clears |edge t| >= 2 AND has a positive net spread -> partial, not pass.
    expect(byKey.measurements_strong?.status).toBe('partial');
    expect(byKey.measurements_strong?.detail).toContain('1 of 4');
    expect(byKey.scored_end_to_end?.status).toBe('fail');
    expect(byKey.scored_end_to_end?.detail).toMatch(/never been checked/);
  });

  it('degrades every rung to fail on a completely empty payload, without leaking raw values', () => {
    const rungs = evidenceLadder({});
    for (const rung of rungs) {
      expect(rung.status).toBe('fail');
      assertClean(rung.claim);
      assertClean(rung.detail);
    }
  });

  it('measurements_strong rung fails cleanly on zero factors', () => {
    const rungs = evidenceLadder({ model_weights: { factors: [] } });
    const strong = rungs.find((r) => r.key === 'measurements_strong') as EvidenceRung;
    expect(strong.status).toBe('fail');
    assertClean(strong.detail);
  });

  it('measurements_strong rung ignores factors with a null/missing edge t-stat rather than crashing', () => {
    const rungs = evidenceLadder({
      model_weights: {
        factors: [
          { name: 'a', edge_t_stat: null, net_spread_pct: 5 },
          { name: 'b', net_spread_pct: 5 },
          { name: 'c', edge_t_stat: 'not-a-number', net_spread_pct: 5 },
        ],
      },
    });
    const strong = rungs.find((r) => r.key === 'measurements_strong') as EvidenceRung;
    expect(strong.status).toBe('fail');
    expect(strong.detail).toContain('0 of 3');
  });

  it('measurements_strong rung passes when every factor clears the edge t-stat bar with a positive net spread', () => {
    const rungs = evidenceLadder({
      model_weights: {
        factors: [
          { name: 'a', edge_t_stat: 3.1, net_spread_pct: 1.2 },
          { name: 'b', edge_t_stat: -2.5, net_spread_pct: 0.4 },
        ],
      },
    });
    const strong = rungs.find((r) => r.key === 'measurements_strong') as EvidenceRung;
    expect(strong.status).toBe('pass');
  });

  it('measurements_strong rung does not count a factor as passing when its net spread is not positive, even with a significant edge t-stat (a significant IC must not read as "working")', () => {
    const rungs = evidenceLadder({
      model_weights: {
        factors: [
          { name: 'a', edge_t_stat: 5, net_spread_pct: -0.5 },
          { name: 'b', edge_t_stat: 4, net_spread_pct: 0 },
        ],
      },
    });
    const strong = rungs.find((r) => r.key === 'measurements_strong') as EvidenceRung;
    expect(strong.status).toBe('fail');
    expect(strong.detail).toContain('0 of 2');
  });

  it('scored_end_to_end rung passes once model.observations clears the min-observations bar', () => {
    const rungs = evidenceLadder({ validation: { model: { observations: 40, hit_rate: 55.2 } } });
    const scored = rungs.find((r) => r.key === 'scored_end_to_end') as EvidenceRung;
    expect(scored.status).toBe('pass');
    expect(scored.detail).toContain('55.2%');
  });

  it('never renders null/NaN/undefined for malformed field types', () => {
    const rungs = evidenceLadder({
      quality: { trusted_count: 'lots', excluded_count: null },
      validation: { observations: 'many', model: 'not-an-object' },
      model_weights: { factors: 'not-an-array' },
    });
    for (const rung of rungs) {
      assertClean(rung.claim);
      assertClean(rung.detail);
    }
  });
});

describe('factorWeightMix', () => {
  it('counts prior vs measured (mode !== "ic" counts as prior)', () => {
    const mix = factorWeightMix([
      { mode: 'ic' },
      { mode: 'prior' },
      { mode: 'prior' },
      { mode: null },
    ]);
    expect(mix).toEqual({ total: 4, priorCount: 3, measuredCount: 1 });
  });

  it('handles zero factors', () => {
    expect(factorWeightMix([])).toEqual({ total: 0, priorCount: 0, measuredCount: 0 });
  });
});

describe('modelHealthVerdict', () => {
  it('reports "nothing to judge yet" for zero factors', () => {
    const verdict = modelHealthVerdict({ model_weights: { factors: [] } });
    expect(verdict.headline).toBe("There's nothing to judge yet.");
    assertClean(verdict.summary);
  });

  it('reports the honest "hasn\'t proven itself" verdict for the realistic payload (matches real prod: 1 of 12 measured)', () => {
    const verdict = modelHealthVerdict(realisticPayload());
    // 3 of 4 sample factors are mode:'prior' (75%, at the majority-share bar) -> still reads
    // "hasn't proven itself", same as the real payload's 11-of-12-prior state -- one factor
    // clearing the significance gate must not flip the headline to the much rosier "partway".
    expect(verdict.headline).toBe("The model hasn't proven itself yet.");
    // New derivation cites measuredCount of total (1 of 4), not priorCount of total, plus the
    // median n_periods across factors (all 199 in the realistic payload).
    expect(verdict.summary).toContain('1 of 4');
    expect(verdict.summary).toContain('across 199 snapshots');
    assertClean(verdict.summary);
  });

  it('reports "hasn\'t proven itself yet" when every factor is prior-driven', () => {
    const verdict = modelHealthVerdict({
      quality: {},
      validation: {},
      model_weights: { factors: [{ mode: 'prior' }, { mode: 'prior' }] },
    });
    expect(verdict.headline).toBe("The model hasn't proven itself yet.");
    // measuredCount is 0 of 2 here (both factors are prior-driven, neither cleared significance).
    expect(verdict.summary).toContain('0 of 2');
    assertClean(verdict.summary);
  });

  it('never claims a history shortage when every factor has ample n_periods but simply failed the significance bar (regression for the false "not enough history" claim)', () => {
    const abundantPriorFactors = Array.from({ length: 12 }, (_, i) => ({
      name: `factor_${i}`,
      mode: 'prior',
      n_periods: 180 + i,
      t_stat: 0.5,
    }));
    const verdict = modelHealthVerdict({
      quality: {},
      validation: {},
      model_weights: { factors: abundantPriorFactors },
    });
    expect(verdict.headline).toBe("The model hasn't proven itself yet.");
    expect(verdict.summary).not.toMatch(/enough history|short on history/i);
    expect(verdict.summary).toContain('measured all 12 signals');
    expect(verdict.summary).toContain('0 of 12');
    assertClean(verdict.summary);
  });

  it('reports "partway to proving itself" for a genuinely balanced split (below the prior-majority bar)', () => {
    const verdict = modelHealthVerdict({
      validation: { model: { observations: 0 } },
      model_weights: {
        factors: [{ mode: 'prior' }, { mode: 'prior' }, { mode: 'ic' }, { mode: 'ic' }],
      },
    });
    expect(verdict.headline).toBe('The model is partway to proving itself.');
    expect(verdict.summary).toContain('2 of 4');
    assertClean(verdict.summary);
  });

  it('reports "measured, but unproven end to end" when every factor is measured but the model is unscored', () => {
    const verdict = modelHealthVerdict({
      validation: { model: { observations: 0 } },
      model_weights: { factors: [{ mode: 'ic' }, { mode: 'ic' }] },
    });
    expect(verdict.headline).toBe("The model's weights are measured, but unproven end to end.");
    assertClean(verdict.summary);
  });

  it('reports a real track record once the model has been scored end to end', () => {
    const verdict = modelHealthVerdict({
      validation: { model: { observations: 500, hit_rate: 55 } },
      model_weights: { factors: [{ mode: 'ic' }] },
    });
    expect(verdict.headline).toBe('The model has a real track record.');
    assertClean(verdict.summary);
  });

  it('never renders null/NaN/undefined for a fully empty payload', () => {
    const verdict = modelHealthVerdict({});
    assertClean(verdict.headline);
    assertClean(verdict.summary);
  });
});

describe('factorHealthRows', () => {
  it('sorts by |weight| descending and maps mode to measured/prior', () => {
    const rows = factorHealthRows(realisticPayload().model_weights);
    expect(rows.map((r) => r.name)).toEqual([
      'momentum_24h',
      'oi_price_signal',
      'taker_flow_24h',
      'technical_trend_4h',
    ]);
    expect(rows.find((r) => r.name === 'technical_trend_4h')?.mode).toBe('measured');
    expect(rows.find((r) => r.name === 'momentum_24h')?.mode).toBe('prior');
  });

  it('joins each factor to its own factor_decay entry by name', () => {
    const rows = factorHealthRows(realisticPayload().model_weights);
    const taker = rows.find((r) => r.name === 'taker_flow_24h');
    expect(taker?.decay.sufficient).toBe(true);
    expect(taker?.decay.holdsHours).toBe(12);
    expect(taker?.decay.curve).toHaveLength(2);
  });

  it('gives a hollow/empty decay reading when a factor has no factor_decay entry', () => {
    const rows = factorHealthRows({ factors: [{ name: 'oi_price_signal', weight: 0.1 }] });
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.decay.sufficient).toBe(false);
    expect(row?.decay.curve).toEqual([]);
  });

  it('handles zero factors without throwing', () => {
    expect(factorHealthRows({ factors: [] })).toEqual([]);
    expect(factorHealthRows({})).toEqual([]);
  });
});

describe('negativeWeightRows', () => {
  it('surfaces the negative-weight factor from the realistic payload', () => {
    const rows = factorHealthRows(realisticPayload().model_weights);
    const negatives = negativeWeightRows(rows);
    expect(negatives).toHaveLength(1);
    expect(negatives[0]?.name).toBe('technical_trend_4h');
  });

  it('is empty when no factor has a negative weight', () => {
    const rows = factorHealthRows({ factors: [{ name: 'a', weight: 0.5 }] });
    expect(negativeWeightRows(rows)).toEqual([]);
  });
});

describe('factorHitRates', () => {
  it('sorts by hit rate descending', () => {
    const rates = factorHitRates(realisticPayload().validation);
    expect(rates[0]?.name).toBe('taker_flow_24h');
    expect(rates[rates.length - 1]?.name).toBe('ls_ratio_contrarian');
  });

  it('returns an empty list when validation.factors is missing', () => {
    expect(factorHitRates({})).toEqual([]);
  });
});

describe('decaySummary', () => {
  it('computes the median peak/holds hours across sufficient factors only', () => {
    const summary = decaySummary(realisticPayload().model_weights);
    expect(summary.sufficientCount).toBe(2);
    expect(summary.totalCount).toBe(2);
    // peaks: 4, 8 -> median 6; holds: 12, 24 -> median 18
    expect(summary.medianPeakHours).toBe(6);
    expect(summary.holdsFactorCount).toBe(2);
    expect(summary.medianHoldsHours).toBe(18);
  });

  it('handles an empty factor_decay table', () => {
    const summary = decaySummary({});
    expect(summary).toEqual({
      sufficientCount: 0,
      totalCount: 0,
      medianPeakHours: null,
      holdsFactorCount: 0,
      medianHoldsHours: null,
    });
  });

  it('excludes insufficient entries from the median', () => {
    const summary = decaySummary({
      factor_decay: {
        a: { sufficient: true, peak_horizon_hours: 4, holds_hours: 12 },
        b: { sufficient: false, peak_horizon_hours: 999, holds_hours: 999 },
      },
    });
    expect(summary.sufficientCount).toBe(1);
    expect(summary.totalCount).toBe(2);
    expect(summary.medianPeakHours).toBe(4);
  });

  it('reports holdsFactorCount separately from sufficientCount -- a factor can be "sufficient" (peaked) without ever fading to half strength within the tested window', () => {
    // Real prod-payload shape: most factors peak at the last tested horizon (72h) and never
    // report a holds_hours -- mixing their peak into the same median as the few that DO fade
    // measurably must not make medianHoldsHours look like it happens before medianPeakHours.
    const summary = decaySummary({
      factor_decay: {
        early: { sufficient: true, peak_horizon_hours: 4, holds_hours: 12 },
        persistentA: { sufficient: true, peak_horizon_hours: 72, holds_hours: null },
        persistentB: { sufficient: true, peak_horizon_hours: 72, holds_hours: null },
      },
    });
    expect(summary.sufficientCount).toBe(3);
    expect(summary.holdsFactorCount).toBe(1);
    expect(summary.medianHoldsHours).toBe(12);
  });
});

describe('walkForwardSummary', () => {
  it('computes test periods as n_timestamps minus train_periods', () => {
    const summary = walkForwardSummary(realisticPayload().model_weights);
    expect(summary.nTimestamps).toBe(199);
    expect(summary.trainPeriods).toBe(119);
    expect(summary.testPeriods).toBe(80);
  });

  it('counts every sample factor as insufficient-data, none robust', () => {
    const summary = walkForwardSummary(realisticPayload().model_weights);
    expect(summary.robustCount).toBe(0);
    expect(summary.overfitCount).toBe(0);
    expect(summary.insufficientCount).toBe(4);
    expect(summary.totalCount).toBe(4);
  });

  it('treats a missing/unrecognized robustness verdict as insufficient-data, not a crash', () => {
    const summary = walkForwardSummary({ factors: [{ name: 'a' }, { name: 'b', robustness: 42 }] });
    expect(summary.insufficientCount).toBe(2);
  });

  it('handles a completely missing walk_forward blob', () => {
    const summary = walkForwardSummary({});
    expect(summary.nTimestamps).toBeNull();
    expect(summary.trainPeriods).toBeNull();
    expect(summary.testPeriods).toBeNull();
    expect(summary.totalCount).toBe(0);
  });
});

describe('collinearityRisks', () => {
  it('flags the redundant pair as the #1 and #2 weight in the model', () => {
    const risks = collinearityRisks(realisticPayload().model_weights);
    const redundant = risks.find((r) => r.verdict === 'redundant');
    expect(redundant).toBeDefined();
    expect(redundant?.aRank).toBe(1);
    expect(redundant?.bRank).toBe(2);
    expect(redundant?.combinedWeightPct).not.toBeNull();
    expect(redundant?.combinedWeightPct ?? 0).toBeGreaterThan(0);
  });

  it('returns null combinedWeightPct when a correlation pair references an unknown factor name', () => {
    const risks = collinearityRisks({
      factors: [{ name: 'a', weight: 0.5 }],
      factor_correlations: [{ a: 'a', b: 'ghost', rho: 0.9, verdict: 'redundant' }],
    });
    expect(risks[0]?.combinedWeightPct).toBeNull();
    expect(risks[0]?.bRank).toBeNull();
  });

  it('returns an empty list when there are no correlations', () => {
    expect(collinearityRisks({ factors: [] })).toEqual([]);
  });
});

describe('regimeIcSummary', () => {
  it('reports zero active factors and the (low) typical regime period count from the realistic payload', () => {
    const summary = regimeIcSummary(realisticPayload().model_weights);
    expect(summary.activeCount).toBe(0);
    expect(summary.typicalPeriods).toBe(3);
    expect(summary.typicalPeriods).toBeLessThan(REGIME_MIN_PERIODS);
    expect(summary.regimeLabel).toBe('alts-strong');
  });

  it('handles a completely missing regime blob', () => {
    const summary = regimeIcSummary({});
    expect(summary).toEqual({
      activeCount: 0,
      totalCount: 0,
      typicalPeriods: null,
      regimeLabel: null,
    });
  });
});

describe('oosIcSummary', () => {
  it('counts negative out-of-sample IC factors from the realistic payload', () => {
    const summary = oosIcSummary(realisticPayload().model_weights);
    // momentum_24h, oi_price_signal, technical_trend_4h, taker_flow_24h are all negative oos_ic.
    expect(summary.negativeCount).toBe(4);
    expect(summary.totalCount).toBe(4);
  });

  it('excludes null oos_ic from both counts', () => {
    const summary = oosIcSummary({
      factors: [
        { name: 'a', oos_ic: -0.1 },
        { name: 'b', oos_ic: null },
      ],
    });
    expect(summary.negativeCount).toBe(1);
    expect(summary.totalCount).toBe(1);
  });

  it('handles zero factors', () => {
    expect(oosIcSummary({ factors: [] })).toEqual({ negativeCount: 0, totalCount: 0 });
  });
});

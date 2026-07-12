import { describe, expect, it } from 'vitest';
import {
  type EvidenceRung,
  evidenceLadder,
  factorWeightMix,
  modelHealthVerdict,
} from '../lib/model-health';
import { NO_LEAKED_VALUES } from './noLeakedValues';

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
          edge_verdict: 'failed-train',
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
          edge_verdict: 'insufficient-data',
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
          // The one factor that's forward-validated: earned money on train AND held on validation.
          net_spread_pct: 0.8,
          edge_t_stat: -3.45,
          edge_verdict: 'validated',
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
          edge_verdict: 'failed-forward',
        },
      ],
      validated_factor_count: 1,
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
    // Only 1 of 4 sample factors (technical_trend_4h) is forward-validated -> partial, not pass.
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

  it('measurements_strong rung ignores factors with a null/missing/malformed edge_verdict rather than crashing', () => {
    const rungs = evidenceLadder({
      model_weights: {
        factors: [
          { name: 'a', edge_verdict: null },
          { name: 'b' },
          { name: 'c', edge_verdict: 42 },
        ],
      },
    });
    const strong = rungs.find((r) => r.key === 'measurements_strong') as EvidenceRung;
    expect(strong.status).toBe('fail');
    expect(strong.detail).toContain('0 of 3');
  });

  it('measurements_strong rung passes when every factor is forward-validated', () => {
    const rungs = evidenceLadder({
      model_weights: {
        factors: [
          { name: 'a', edge_verdict: 'validated' },
          { name: 'b', edge_verdict: 'validated' },
        ],
      },
    });
    const strong = rungs.find((r) => r.key === 'measurements_strong') as EvidenceRung;
    expect(strong.status).toBe('pass');
  });

  it('measurements_strong rung does not count a factor as passing when it failed forward-validation, even though it once looked significant and profitable in-sample (a train-only pass must not read as "working")', () => {
    const rungs = evidenceLadder({
      model_weights: {
        factors: [
          // Looked significant and profitable on train, but reversed on validation.
          { name: 'a', edge_t_stat: 5, net_spread_pct: 0.8, edge_verdict: 'failed-forward' },
          { name: 'b', edge_t_stat: 4, net_spread_pct: 0, edge_verdict: 'failed-train' },
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

  it('states plainly that no factor has a validated edge when validated_factor_count is 0', () => {
    const verdict = modelHealthVerdict({
      model_weights: {
        validated_factor_count: 0,
        factors: [{ mode: 'ic' }, { mode: 'prior' }],
      },
    });
    expect(verdict.headline).toBe('No factor has a validated edge.');
    expect(verdict.summary).toContain('None of the 2 signals');
    assertClean(verdict.summary);
  });

  it('the zero-validated-edge headline takes priority over a passing scored_end_to_end rung -- a good blended hit rate does not mean any single factor has proven itself forward', () => {
    const verdict = modelHealthVerdict({
      validation: { model: { observations: 500, hit_rate: 55 } },
      model_weights: { validated_factor_count: 0, factors: [{ mode: 'ic' }] },
    });
    expect(verdict.headline).toBe('No factor has a validated edge.');
  });

  it('does not fire the zero-validated-edge branch when validated_factor_count is simply absent from the payload (older/partial fixtures)', () => {
    const verdict = modelHealthVerdict({
      validation: { model: { observations: 500, hit_rate: 55 } },
      model_weights: { factors: [{ mode: 'ic' }] },
    });
    expect(verdict.headline).toBe('The model has a real track record.');
  });

  it('never renders null/NaN/undefined for a fully empty payload', () => {
    const verdict = modelHealthVerdict({});
    assertClean(verdict.headline);
    assertClean(verdict.summary);
  });
});

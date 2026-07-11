import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORS } from '../../src/pipeline/factorDefinitions.js';
import type { FactorRecord } from '../../src/pipeline/ic.js';
import { factorWeights } from '../../src/pipeline/weighting.js';

function strongPositive(
  periodIdx: number,
  symIdx: number,
  rank: number,
  nSymbols: number,
): [number, number] {
  const forward = symIdx === periodIdx % nSymbols ? (rank + 1) % nSymbols : rank;
  return [forward, rank];
}

function weakIc(
  periodIdx: number,
  symIdx: number,
  rank: number,
  nSymbols: number,
): [number, number] {
  return [(symIdx + periodIdx) % nSymbols, rank];
}

function regimeLabeledRecords(
  factor: string,
  regimeSpecs: Array<[string, number, typeof strongPositive]>,
  nSymbols = 5,
): FactorRecord[] {
  const records: FactorRecord[] = [];
  let periodIdx = 0;
  for (const [regime, nPeriods, forwardFn] of regimeSpecs) {
    for (let i = 0; i < nPeriods; i += 1) {
      periodIdx += 1;
      const generatedAt = `2024-01-${String(periodIdx).padStart(2, '0')}T12:00:00+07:00`;
      for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
        const rank = symIdx;
        const [forwardReturnPct, factorValue] = forwardFn(periodIdx, symIdx, rank, nSymbols);
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: forwardReturnPct,
          factors: { [factor]: factorValue },
          regime,
        });
      }
    }
  }
  return records;
}

describe('factorWeights regime-conditional IC', () => {
  const config = {
    factors: {
      ic_min_periods: 10,
      ic_min_cross_section: 5,
      min_abs_t: 2.0,
      min_abs_ic: 0.02,
      regime_min_periods: 8,
      regime_conditional_prior_strength: 12.0,
      priors: DEFAULT_PRIORS,
    },
  };

  it('uses the regime IC weight when the current regime has enough data (test_regime_a_uses_regime_ic_weight)', () => {
    const records = regimeLabeledRecords('momentum_24h', [
      ['A', 15, strongPositive],
      ['B', 15, weakIc],
    ]);
    const momentum = factorWeights(records, config, 'A').stats.momentum_24h;
    expect(momentum?.regime_mode).toBe('regime-ic');
    expect(momentum?.regime_k ?? 0.0).toBeGreaterThan(0.0);
    expect(momentum?.weight).not.toBe(momentum?.base_weight);
  });

  it('falls back to pooled weight for a regime with weak IC (test_regime_b_falls_back_to_pooled)', () => {
    const records = regimeLabeledRecords('momentum_24h', [
      ['A', 15, strongPositive],
      ['B', 15, weakIc],
    ]);
    const momentum = factorWeights(records, config, 'B').stats.momentum_24h;
    expect(momentum?.regime_mode).toBe('pooled');
    expect(momentum?.regime_k).toBe(0.0);
    expect(momentum?.weight).toBe(momentum?.base_weight);
  });

  it('falls back to pooled for a thin regime bucket (test_thin_regime_bucket_falls_back_to_pooled)', () => {
    const records = regimeLabeledRecords('momentum_24h', [
      ['A', 15, strongPositive],
      ['thin', 5, strongPositive],
    ]);
    const weights = factorWeights(records, config, 'thin');
    const momentum = weights.stats.momentum_24h;
    expect(momentum?.regime_mode).toBe('pooled');
    expect(momentum?.regime_k).toBe(0.0);
    expect(weights.directional.momentum_24h).toBe(weights.base_directional.momentum_24h);
  });

  it('matches pooled directional weights when current_regime is null (test_current_regime_none_matches_pooled_directional)', () => {
    const records = regimeLabeledRecords('momentum_24h', [
      ['A', 15, strongPositive],
      ['B', 15, weakIc],
    ]);
    const weights = factorWeights(records, config, null);
    expect(weights.regime_adjusted).toBe(false);
    expect(weights.directional).toEqual(weights.base_directional);
  });
});

describe('factorWeights walk-forward gating', () => {
  function splitIcRecords(
    factor: string,
    nPeriods: number,
    trainFn: typeof strongPositive,
    testFn: typeof strongPositive,
    nSymbols = 5,
  ): FactorRecord[] {
    const splitIndex = Math.max(15, Math.trunc(0.6 * nPeriods));
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-01-${String(periodIdx + 1).padStart(2, '0')}T12:00:00+07:00`;
      const forwardFn = periodIdx < splitIndex ? trainFn : testFn;
      for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
        const rank = symIdx;
        const [forwardReturnPct, factorValue] = forwardFn(periodIdx, symIdx, rank, nSymbols);
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: forwardReturnPct,
          factors: { [factor]: factorValue },
        });
      }
    }
    return records;
  }

  const baseConfig = {
    factors: {
      ic_min_periods: 10,
      ic_min_cross_section: 5,
      min_abs_t: 2.0,
      min_abs_ic: 0.02,
      walk_forward_train_fraction: 0.6,
      walk_forward_min_train_periods: 15,
      walk_forward_min_oos_periods: 10,
      walk_forward_robust_min_ic: 0.02,
      walk_forward_overfit_penalty: 0.0,
      walk_forward_gating: false,
      priors: DEFAULT_PRIORS,
    },
  };

  it('is a no-op when gating is off (test_gating_off_is_noop)', () => {
    const records = splitIcRecords('momentum_24h', 30, strongPositive, weakIc);
    const weights = factorWeights(records, baseConfig);
    const momentum = weights.stats.momentum_24h;

    expect(weights.walk_forward.factors.momentum_24h?.verdict).toBe('overfit');
    expect(momentum?.mode).toBe('ic');
    expect(momentum?.credibility_k ?? 0.0).toBeGreaterThan(0.0);

    const gatedConfig = {
      factors: {
        ...baseConfig.factors,
        walk_forward_gating: true,
        walk_forward_overfit_penalty: 0.0,
      },
    };
    const gatedWeights = factorWeights(records, gatedConfig);
    expect(weights.directional.momentum_24h).not.toBe(gatedWeights.directional.momentum_24h);
  });

  it('pulls an overfit factor to its prior when gating is on (test_gating_on_pulls_overfit_to_prior)', () => {
    const overfitRecords = splitIcRecords('momentum_24h', 30, strongPositive, weakIc);
    const robustRecords = splitIcRecords('momentum_24h', 30, strongPositive, strongPositive);

    const configOn = {
      factors: {
        ...baseConfig.factors,
        walk_forward_gating: true,
        walk_forward_overfit_penalty: 0.0,
      },
    };

    const overfitOn = factorWeights(overfitRecords, configOn);
    const momentumOn = overfitOn.stats.momentum_24h;
    expect(momentumOn?.mode).toBe('prior');
    expect(momentumOn?.raw_weight).toBeCloseTo(DEFAULT_PRIORS.momentum_24h as number, 9);

    const robustOff = factorWeights(robustRecords, baseConfig);
    const robustOn = factorWeights(robustRecords, configOn);
    expect(robustOff.directional.momentum_24h).toBe(robustOn.directional.momentum_24h);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORS } from '../../src/pipeline/factorDefinitions.js';
import type { FactorRecord } from '../../src/pipeline/ic.js';
import { factorWeights } from '../../src/pipeline/weighting.js';
import { splitIcRecords, strongPositive, weakIc } from '../support/syntheticRecords.js';

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
  // Pinned to the rank_ic escape hatch (byte-identical to the pre-net_edge pipeline): these
  // records only carry 5 symbols/period, well under economicEdge's minNamesPerPeriod (20), so
  // under the net_edge default every pooled pass would fall back to 'prior' regardless of the
  // regime-conditional mechanics this suite actually tests.
  const config = {
    factors: {
      ic_min_periods: 10,
      ic_min_cross_section: 5,
      min_abs_t: 2.0,
      min_abs_ic: 0.02,
      regime_min_periods: 8,
      regime_conditional_prior_strength: 12.0,
      priors: DEFAULT_PRIORS,
      selection_objective: 'rank_ic' as const,
      ic_target: 'raw' as const,
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
  // Pinned to rank_ic for the same reason as the regime-conditional suite above -- these
  // records use 5 symbols/period, under economicEdge's minNamesPerPeriod, so net_edge (the
  // default) would mask the walk-forward-gating behaviour this suite tests.
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
      selection_objective: 'rank_ic' as const,
      ic_target: 'raw' as const,
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

describe('factorWeights net_edge selection objective', () => {
  const FACTOR = 'momentum_24h';
  const N_SYMBOLS = 20; // >= economicEdge's default minNamesPerPeriod (20).

  function strongPositiveRecords(nPeriods: number): FactorRecord[] {
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-03-${String((periodIdx % 28) + 1).padStart(2, '0')}T00:00:00+07:00`;
      for (let symIdx = 0; symIdx < N_SYMBOLS; symIdx += 1) {
        const rank = symIdx;
        const [forwardReturnPct, factorValue] = strongPositive(periodIdx, symIdx, rank, N_SYMBOLS);
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: forwardReturnPct,
          factors: { [FACTOR]: factorValue },
        });
      }
    }
    return records;
  }

  const baseFactorsCfg = {
    ic_min_periods: 10,
    ic_min_cross_section: 5,
    min_abs_t: 2.0,
    min_abs_ic: 0.02,
    ic_prior_strength: 10,
    priors: DEFAULT_PRIORS,
    ic_target: 'raw' as const,
    // These records carry no atr_pct; economicEdge's default 'inverse_vol' sizing would drop
    // every one, masking the selection-objective/cost behaviour this suite actually tests.
    position_sizing: 'equal_weight' as const,
    // A 50/50 split so both the train and validation halves clear economicEdge's MIN_PERIODS (10)
    // with these tests' period counts.
    edge_validation_fraction: 0.5,
  };

  it('rejects a factor on cost even though its rank IC stays significant (money, not rank, decides selection)', () => {
    const records = strongPositiveRecords(20);
    // taker_fee_bps=1000 alone makes costPctPerLeg = 2*1000/100 = 20, well above this factor's
    // ~16.7pct gross decile spread -- net_spread_pct goes negative without touching the IC at all.
    const expensiveCosts = { taker_fee_bps: 1000, slippage_bps: 0, assumed_spread_bps: 0 };

    const cheap = factorWeights(records, {
      factors: { ...baseFactorsCfg, selection_objective: 'net_edge' },
    });
    const expensive = factorWeights(records, {
      factors: { ...baseFactorsCfg, selection_objective: 'net_edge' },
      costs: expensiveCosts,
    });
    const expensiveButRankIc = factorWeights(records, {
      factors: { ...baseFactorsCfg, selection_objective: 'rank_ic' },
      costs: expensiveCosts,
    });

    const cheapStat = cheap.stats.momentum_24h;
    const expensiveStat = expensive.stats.momentum_24h;
    const expensiveRankIcStat = expensiveButRankIc.stats.momentum_24h;

    expect(cheapStat?.mode).toBe('ic');
    expect(cheapStat?.net_spread_pct ?? 0).toBeGreaterThan(0);

    // Same records, same measured rank IC/t-stat -- costs alone flip the selection under net_edge.
    // The cost is punishing enough that the factor fails even the TRAIN half of the walk-forward
    // gate, so it gets zeroed outright (mode 'unvalidated'), not its prior -- see
    // zero_unvalidated_weights: a factor actively tested and found to lose money must not fall
    // back to a starting guess.
    expect(expensiveStat?.net_spread_pct ?? 0).toBeLessThanOrEqual(0);
    expect(expensiveStat?.edge_verdict).toBe('failed-train');
    expect(expensiveStat?.mode).toBe('unvalidated');
    expect(expensiveStat?.raw_weight).toBe(0);
    expect(expensiveStat?.ic).toBeCloseTo(cheapStat?.ic as number, 9);
    expect(Math.abs(expensiveStat?.t_stat as number)).toBeGreaterThanOrEqual(2.0);

    // The rank_ic escape hatch ignores cost entirely -- same expensive config, still selected.
    expect(expensiveRankIcStat?.mode).toBe('ic');
  });

  it("takes the weight's sign from the economic edge direction, not the rank IC sign, when they disagree", () => {
    // 20 periods (not 12): with edge_validation_fraction 0.5 that's a 10/10 train/validation split,
    // and economicEdge needs >=10 periods on EACH side of the walk-forward gate. The outlier
    // pattern alternates every period, so both halves keep the same 50/50 outlier/clean mix as the
    // original 12-period design.
    const nPeriods = 20;
    const outlierMagnitude = 4000;
    const slope = 3;
    // A strict, strongly negative rank relationship (forward = -slope * rank) across the whole
    // cross-section, except S1 (the lowest-rank symbol) gets a wildly negative forward return on
    // alternating periods. The rank correlation (Spearman) stays strongly negative throughout, but
    // the outlier is large enough to drag the bottom decile's raw MEAN below the top decile's on
    // average, flipping economicEdge's decile-spread sign positive -- the exact "edge != IC" case
    // economicEdge.test.ts proves at the unit level; this proves weighting.ts wires it through.
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-04-${String(periodIdx + 1).padStart(2, '0')}T00:00:00+07:00`;
      const applyOutlier = periodIdx % 2 === 0;
      for (let rank = 1; rank <= N_SYMBOLS; rank += 1) {
        const forward = rank === 1 && applyOutlier ? -outlierMagnitude : -slope * rank;
        records.push({
          symbol: `S${rank}`,
          generated_at: generatedAt,
          forward_return_pct: forward,
          factors: { [FACTOR]: rank },
        });
      }
    }

    const netEdge = factorWeights(records, {
      factors: { ...baseFactorsCfg, selection_objective: 'net_edge' },
    });
    const rankIc = factorWeights(records, {
      factors: { ...baseFactorsCfg, selection_objective: 'rank_ic' },
    });

    const netEdgeStat = netEdge.stats.momentum_24h;
    const rankIcStat = rankIc.stats.momentum_24h;

    expect(netEdgeStat?.mode).toBe('ic');
    expect(rankIcStat?.mode).toBe('ic');
    // Same records, same measured rank IC (strongly negative either way) -- only the sign used
    // for the blended weight differs.
    expect(netEdgeStat?.ic).toBeCloseTo(rankIcStat?.ic as number, 9);
    expect(rankIcStat?.ic as number).toBeLessThan(0);
    expect(netEdgeStat?.raw_weight as number).toBeGreaterThan(0);
    expect(rankIcStat?.raw_weight as number).toBeLessThan(0);
  });

  it('edge_walk_forward_gating replaces the in-sample-only gate: a factor that pays on the training slice but reverses on the validation slice gets zero weight, not its prior', () => {
    // Same shape the MEASURED note pins for technical_trend_4h: profitable and significant on an
    // earlier slice, reversed on the later slice it wasn't measured from. An in-sample-only gate
    // (looking at all 20 periods together) would still see a real, if diluted, positive spread and
    // wrongly select it.
    const trainPeriods = 10;
    const validationPeriods = 10;
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < trainPeriods + validationPeriods; periodIdx += 1) {
      const generatedAt = `2024-06-${String(periodIdx + 1).padStart(2, '0')}T00:00:00+07:00`;
      const inValidation = periodIdx >= trainPeriods;
      // Magnitude alternates 1.0/1.2 so the train slice has non-zero variance (a dead-flat spread
      // has zero variance -> t_stat 0 -> fails on triviality rather than the reversal this test
      // means to exercise); the sign flips wholesale once validation starts.
      const magnitude = periodIdx % 2 === 0 ? 1.0 : 1.2;
      const slope = inValidation ? -magnitude : magnitude;
      for (let rank = 0; rank < N_SYMBOLS; rank += 1) {
        const forward = slope * rank;
        records.push({
          symbol: `S${rank}`,
          generated_at: generatedAt,
          forward_return_pct: forward,
          factors: { [FACTOR]: rank },
        });
      }
    }

    const weights = factorWeights(records, {
      factors: { ...baseFactorsCfg, selection_objective: 'net_edge' },
    });
    const stat = weights.stats[FACTOR];

    expect(stat?.edge_verdict).toBe('failed-forward');
    expect(stat?.mode).toBe('unvalidated');
    expect(stat?.raw_weight).toBe(0);
    expect(weights.directional[FACTOR]).toBe(0);
    expect(weights.validated_factor_count).toBe(0);
  });
});

describe('factorWeights regime blend vs. net_edge zeroing', () => {
  // Regression gate on a money bug: zero_unvalidated_weights zeroes a factor that was ACTIVELY
  // TESTED under net_edge and found to lose money forward, but the regime-conditional blend used to
  // compute (1 - kRegime) * pooledRaw + kRegime * regimeMeanIc with no check on `mode`, handing the
  // proven loser its weight back through a rank-IC term -- the very metric net_edge exists to
  // overrule, since rank IC is blind to the cost and skew that condemned the factor.
  const FACTOR = 'momentum_24h';
  const N_SYMBOLS = 20; // >= economicEdge's default minNamesPerPeriod (20).

  function mirroredNegative(
    periodIdx: number,
    symIdx: number,
    rank: number,
    nSymbols: number,
  ): [number, number] {
    const [forward, factorValue] = strongPositive(periodIdx, symIdx, rank, nSymbols);
    return [-forward, factorValue];
  }

  it('keeps a factor zeroed by the net_edge walk-forward gate at zero, even when its regime IC alone would qualify', () => {
    // 'trending' (periods 1-10): strongPositive -- profitable, significant, matches train.
    // 'reversal' (periods 11-20): the same relationship mirrored negative -- matches validation.
    // Chronologically this is exactly the train/validation split edge_validation_fraction: 0.5
    // draws over 20 periods, so the pooled net_edge gate sees a factor that pays in training and
    // reverses in validation (edge_verdict 'failed-forward'), while the 'trending' bucket alone is
    // a clean, strongly significant regime for the regime-conditional IC to pick up.
    const records = regimeLabeledRecords(
      FACTOR,
      [
        ['trending', 10, strongPositive],
        ['reversal', 10, mirroredNegative],
      ],
      N_SYMBOLS,
    );

    const weights = factorWeights(
      records,
      {
        factors: {
          ic_min_periods: 10,
          ic_min_cross_section: 5,
          min_abs_t: 2.0,
          min_abs_ic: 0.02,
          ic_prior_strength: 10,
          priors: DEFAULT_PRIORS,
          ic_target: 'raw',
          // These records carry no atr_pct; the default 'inverse_vol' sizing would drop every one.
          position_sizing: 'equal_weight',
          // A 50/50 split so both train and validation clear economicEdge's MIN_PERIODS (10) with
          // 20 periods total.
          edge_validation_fraction: 0.5,
          selection_objective: 'net_edge',
          regime_min_periods: 8,
          regime_conditional_prior_strength: 12.0,
        },
      },
      'trending',
    );
    const stat = weights.stats[FACTOR];

    // The pooled net_edge gate zeroed this factor: it paid in training and lost money on the
    // validation slice.
    expect(stat?.edge_verdict).toBe('failed-forward');
    expect(stat?.mode).toBe('unvalidated');

    // The 'trending' bucket on its own clears regime_min_periods/min_abs_t/min_abs_ic, so the
    // regime IC is strong enough to qualify and is still reported as a diagnostic...
    expect(stat?.regime_ic).not.toBeNull();
    expect(Math.abs(stat?.regime_ic ?? 0)).toBeGreaterThan(0.02);

    // ...but it must not buy the factor any weight back. kRegime stays 0, so the blend collapses to
    // the pooled zero rather than reviving a factor already proven to lose money forward.
    expect(stat?.regime_mode).toBe('pooled');
    expect(stat?.regime_k).toBe(0);
    expect(stat?.raw_weight).toBe(0);
    expect(weights.directional[FACTOR]).toBe(0);
  });

  it('still lets the regime blend move a factor the net_edge gate did not condemn', () => {
    // The guard above keys on mode === 'unvalidated' specifically, not on net_edge being enabled.
    // A factor whose edge holds up forward must still get its regime-conditional weighting.
    const records = regimeLabeledRecords(FACTOR, [['trending', 20, strongPositive]], N_SYMBOLS);

    const weights = factorWeights(
      records,
      {
        factors: {
          ic_min_periods: 10,
          ic_min_cross_section: 5,
          min_abs_t: 2.0,
          min_abs_ic: 0.02,
          ic_prior_strength: 10,
          priors: DEFAULT_PRIORS,
          ic_target: 'raw',
          position_sizing: 'equal_weight',
          edge_validation_fraction: 0.5,
          selection_objective: 'net_edge',
          regime_min_periods: 8,
          regime_conditional_prior_strength: 12.0,
        },
      },
      'trending',
    );
    const stat = weights.stats[FACTOR];

    expect(stat?.mode).not.toBe('unvalidated');
    expect(stat?.regime_mode).toBe('regime-ic');
    expect(stat?.regime_k ?? 0).toBeGreaterThan(0);
    expect(weights.directional[FACTOR]).not.toBe(0);
  });
});

// The shipped default is ic_target='vol_adjusted' x selection_objective='net_edge'. Every test above
// pins ic_target:'raw', so this combination shipped with zero coverage -- and it hid a regression:
// history with no ATR drops EVERY record, leaving n_periods=0 on all 12 factors. The model then
// measures nothing and falls to prior, which is indistinguishable from honestly finding no edge.
describe('factorWeights vol_adjusted target (the shipped default)', () => {
  const FACTOR = 'momentum_24h';
  const N_SYMBOLS = 20;

  function records(nPeriods: number, withVolAdj: boolean): FactorRecord[] {
    const out: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-03-${String((periodIdx % 28) + 1).padStart(2, '0')}T00:00:00+07:00`;
      for (let symIdx = 0; symIdx < N_SYMBOLS; symIdx += 1) {
        const forwardReturnPct = symIdx - N_SYMBOLS / 2;
        const record: FactorRecord = {
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: forwardReturnPct,
          factors: { [FACTOR]: symIdx },
        };
        if (withVolAdj) {
          record.forward_return_vol_adj = forwardReturnPct / 2;
        }
        out.push(record);
      }
    }
    return out;
  }

  const cfg = {
    factors: {
      ic_min_periods: 10,
      ic_min_cross_section: 5,
      min_abs_t: 2.0,
      min_abs_ic: 0.02,
      ic_prior_strength: 10,
      priors: DEFAULT_PRIORS,
      ic_target: 'vol_adjusted' as const,
      selection_objective: 'net_edge' as const,
    },
  };

  it('measures the vol-adjusted target when the history carries one', () => {
    const weights = factorWeights(records(20, true), cfg);
    expect(weights.ic_target_effective).toBe('vol_adjusted');
    expect(weights.stats[FACTOR]?.n_periods).toBeGreaterThan(0);
    expect(weights.stats[FACTOR]?.ic).not.toBeNull();
  });

  it('downgrades to the raw target instead of measuring nothing when no row carries an ATR', () => {
    const weights = factorWeights(records(20, false), cfg);
    expect(weights.ic_target_effective).toBe('raw');
    // The regression: this was 0 / null for all 12 factors, and nothing failed.
    expect(weights.stats[FACTOR]?.n_periods).toBeGreaterThan(0);
    expect(weights.stats[FACTOR]?.ic).not.toBeNull();
  });
});

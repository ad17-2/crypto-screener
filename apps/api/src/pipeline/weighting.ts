import type { LabeledFactorRecord } from '../db/types.js';
import { roundTripCostPct } from './costs.js';
import { economicEdge } from './economicEdge.js';
import { type EdgeWalkForwardResult, edgeWalkForward } from './edgeWalkForward.js';
import { DEFAULT_PRIORS, DIRECTIONAL_FACTORS } from './factorDefinitions.js';
import { crossSectionalIc, type FactorRecord } from './ic.js';
import type { FactorCorrelationFlag } from './independence.js';
import { clamp, pyRound, toFloat } from './scoring.js';
import type { PipelineConfig } from './types.js';
import {
  type ValidationMetrics,
  validationMetrics,
  type WalkForwardFactorResult,
  type WalkForwardResult,
  walkForward,
} from './validation.js';

export interface FactorStat {
  ic: number | null;
  observations: number;
  n_periods: number;
  t_stat: number | null;
  n_effective: number | null;
  overlap_factor: number | null;
  credibility_k: number;
  /** 'unvalidated': net_edge + edge_walk_forward_gating + zero_unvalidated_weights zeroed this factor instead of falling back to its prior. */
  mode: 'ic' | 'prior' | 'unvalidated';
  raw_weight: number;
  robustness: WalkForwardFactorResult['verdict'];
  oos_ic: number | null;
  /** Decile long-short spread net of round-trip costs (both legs), always computed as a diagnostic regardless of selection_objective. */
  net_spread_pct: number | null;
  net_edge_per_30d_pct: number | null;
  /** economicEdge()'s own t-stat on the decile spread -- distinct from `t_stat` above, which is the rank-IC's. */
  edge_t_stat: number | null;
  /** economicEdge()'s own overlap-adjusted n_effective/overlap_factor -- distinct from `n_effective`/`overlap_factor` above, which are the rank-IC's. */
  edge_n_effective: number | null;
  edge_overlap_factor: number | null;
  /** Always computed (edgeWalkForward.ts), regardless of selection_objective or gating -- a train-then-forward split of the same money measurement above. */
  edge_verdict: EdgeWalkForwardResult['verdict'];
  edge_train_net_spread_pct: number | null;
  edge_validation_net_spread_pct: number | null;
  regime_ic: number | null;
  regime_t_stat: number | null;
  regime_n_periods: number;
  regime_k: number;
  regime_mode: 'pooled' | 'regime-ic';
  base_weight: number;
  weight: number;
  regime_multiplier: number;
}

export interface FactorWeights {
  directional: Record<string, number>;
  base_directional: Record<string, number>;
  stats: Record<string, FactorStat>;
  history_records: number;
  mode: 'ic' | 'prior';
  /** 'raw' when ic_target was 'vol_adjusted' but no row carried an ATR -- a silent downgrade otherwise. */
  ic_target_effective: 'vol_adjusted' | 'raw';
  selection_objective: 'net_edge' | 'rank_ic';
  /** Count of DIRECTIONAL_FACTORS with edge_verdict === 'validated' -- independent of selection_objective/mode, so the UI can say "no validated edge" even if mode-based weights look otherwise busy. */
  validated_factor_count: number;
  regime_adjusted: boolean;
  regime_adjustment: {
    label: string;
    method: 'regime-conditional-ic';
    factors_using_regime_ic: string[];
    regime_n_periods: Record<string, number>;
  };
  regime_conditional: {
    current_regime: string | null;
    prior_strength: number;
    min_periods: number;
    factors_using_regime_ic: string[];
  };
  validation: ValidationMetrics;
  walk_forward: WalkForwardResult;
  factor_correlations?: FactorCorrelationFlag[];
}

export function factorWeights(
  historyRecords: FactorRecord[],
  config: PipelineConfig,
  currentRegime?: string | null,
): FactorWeights {
  const factorCfg = config.factors ?? {};
  const priors = factorCfg.priors ?? DEFAULT_PRIORS;
  const maxAbsWeight = factorCfg.max_abs_weight ?? 0.35;
  const minAbsIc = factorCfg.min_abs_ic ?? 0.02;
  const icMinPeriods = factorCfg.ic_min_periods ?? 10;
  const minAbsT = factorCfg.min_abs_t ?? 2.0;
  const icPriorStrength = factorCfg.ic_prior_strength ?? 10;
  const icMinCrossSection = factorCfg.ic_min_cross_section ?? 5;
  const forwardReturnHours = factorCfg.forward_return_hours ?? 24;
  const overlapCorrection = factorCfg.ic_overlap_correction ?? true;
  const icOptions = { forwardReturnHours, overlapCorrection };
  const regimeConditionalPriorStrength = factorCfg.regime_conditional_prior_strength ?? 12.0;
  const regimeMinPeriods = factorCfg.regime_min_periods ?? 8;
  const walkForwardGating = factorCfg.walk_forward_gating ?? false;
  const overfitPenalty = factorCfg.walk_forward_overfit_penalty ?? 0.0;
  const selectionObjective = factorCfg.selection_objective ?? 'net_edge';
  const icTarget = factorCfg.ic_target ?? 'vol_adjusted';
  const edgeWalkForwardGating = factorCfg.edge_walk_forward_gating ?? true;
  const edgeValidationFraction = factorCfg.edge_validation_fraction ?? 0.3;
  const positionSizing = factorCfg.position_sizing ?? 'inverse_vol';
  const zeroUnvalidatedWeights = factorCfg.zero_unvalidated_weights ?? true;
  // Row-agnostic: no live spread/funding for a specific coin at this layer, so this is fees +
  // slippage + the assumed spread only (see costs.ts) -- the same baseline for every factor.
  const costPctPerLeg = roundTripCostPct({}, config.costs ?? {}, forwardReturnHours, 0);

  // ic_target='vol_adjusted' must never mix vol-adjusted and raw returns in one statistic: every
  // retained record's forward_return_pct is replaced by its forward_return_vol_adj, and records
  // without one are dropped outright. economicEdge() below always reads the ORIGINAL
  // historyRecords instead -- the money spread is deliberately never vol-adjusted.
  const volAdjustedRecords: FactorRecord[] = historyRecords.flatMap((record) => {
    const volAdj = toFloat(record.forward_return_vol_adj);
    return volAdj === null ? [] : [{ ...record, forward_return_pct: volAdj }];
  });

  // History with no ATR anywhere (pre-technicals rows) would drop EVERY record and leave the model
  // reporting n_periods=0 for all 12 factors -- measuring nothing, falling silently to prior, and
  // looking identical to a model that simply found no edge. Fall the whole statistic back to raw
  // rather than measure nothing; ic_target_effective makes the downgrade visible.
  const icTargetEffective: 'vol_adjusted' | 'raw' =
    icTarget === 'vol_adjusted' && volAdjustedRecords.length > 0 ? 'vol_adjusted' : 'raw';
  const icInputRecords: FactorRecord[] =
    icTargetEffective === 'vol_adjusted' ? volAdjustedRecords : historyRecords;

  // Same target as the IC, or oos_ic would be measured against a different quantity than ic.
  const wf = walkForward(icInputRecords, config);

  const pooledRaw: Record<string, number> = {};
  const factorStats: Record<string, FactorStat> = {};

  for (const factor of DIRECTIONAL_FACTORS) {
    const csIc = crossSectionalIc(icInputRecords, factor, icMinCrossSection, icOptions);
    const meanIc = csIc.mean_ic;
    const tStat = csIc.t_stat;
    const nPeriods = csIc.n_periods;
    const observations = csIc.n_obs;
    const priorSigned = priors[factor] ?? 0.0;
    const k = nPeriods > 0 ? nPeriods / (nPeriods + icPriorStrength) : 0.0;

    // Always computed, regardless of objective -- it stays a diagnostic on the page even when
    // rank IC (not money) is what's driving selection.
    const edge = economicEdge(historyRecords as unknown as LabeledFactorRecord[], factor, {
      forwardReturnHours,
      costPctPerLeg,
      sizing: positionSizing,
    });
    // Also always computed: the chronological train/validation split of the same money
    // measurement. An in-sample money gate alone still overfits -- technical_trend_4h passed
    // in-sample (train t=+2.20) but died forward (validate net -0.030); reversal_3d is the one
    // factor that actually holds forward. See edgeWalkForward.ts.
    const edgeWf = edgeWalkForward(historyRecords as unknown as LabeledFactorRecord[], factor, {
      forwardReturnHours,
      costPctPerLeg,
      validationFraction: edgeValidationFraction,
      minAbsT,
      sizing: positionSizing,
    });

    let useObserved: boolean;
    let observedValue: number | null;
    // null when there's no walk-forward-validated concept for this factor's selection path (i.e.
    // rank_ic objective, or edge_walk_forward_gating off) -- distinct from an explicit `false`.
    let isValidated: boolean | null = null;
    if (selectionObjective === 'net_edge') {
      if (edgeWalkForwardGating) {
        // Replaces the in-sample-only gate: a factor must have earned money on the earlier training
        // slice AND still held on the later slice it wasn't measured from, not merely on the full
        // (in-sample) history. meanIc is still required because the weight's MAGNITUDE is drawn
        // from it below.
        isValidated = edgeWf.validated;
        useObserved = isValidated && meanIc !== null;
      } else {
        // Legacy in-sample-only gate, kept for operators who explicitly turn gating off. The period
        // count MUST come from edge.n_periods, not the IC's: the two are filtered differently (the
        // edge needs 20 names per cross-section, the IC 5, and under ic_target='vol_adjusted' the
        // IC's sample is ATR-filtered on top).
        useObserved =
          edge !== null &&
          meanIc !== null &&
          edge.n_periods >= icMinPeriods &&
          Math.abs(edge.t_stat) >= minAbsT &&
          edge.net_spread_pct > 0;
      }
      // Magnitude from the measured IC (the blend's existing scale); sign from which side of the
      // decile spread actually made money, which can differ from the IC's sign.
      observedValue =
        edge !== null && meanIc !== null
          ? edge.direction * Math.abs(clamp(meanIc, -maxAbsWeight, maxAbsWeight))
          : null;
    } else {
      useObserved =
        nPeriods >= icMinPeriods &&
        tStat !== null &&
        Math.abs(tStat) >= minAbsT &&
        meanIc !== null &&
        Math.abs(meanIc) >= minAbsIc;
      observedValue = meanIc !== null ? clamp(meanIc, -maxAbsWeight, maxAbsWeight) : null;
    }

    let kEffective = useObserved ? k : 0.0;
    // walkForward() always populates every DIRECTIONAL_FACTORS entry; noUncheckedIndexedAccess just can't see that invariant.
    const wfFactor = wf.factors[factor] as WalkForwardFactorResult;
    if (walkForwardGating && wfFactor.verdict === 'overfit') {
      kEffective *= overfitPenalty;
    }

    // A factor gated on walk-forward-validated money but that was ACTIVELY TESTED AND FAILED must
    // not fall back to its prior -- the priors are a blend of noise, net-negative after costs
    // (MEASURED note). 'insufficient-data' is deliberately excluded: that's a cold-start/thin-
    // history state, not a failure, and must keep falling back to prior (see
    // "falls back to prior weights without history" -- a factor the model simply hasn't had a
    // chance to test yet is not the same as one it tested and found to lose money).
    const isUnvalidated =
      selectionObjective === 'net_edge' &&
      edgeWalkForwardGating &&
      (edgeWf.verdict === 'failed-train' || edgeWf.verdict === 'failed-forward');

    let mode: 'ic' | 'prior' | 'unvalidated';
    if (useObserved && observedValue !== null && kEffective > 0) {
      pooledRaw[factor] = (1.0 - kEffective) * priorSigned + kEffective * observedValue;
      mode = 'ic';
    } else if (zeroUnvalidatedWeights && isUnvalidated) {
      pooledRaw[factor] = 0.0;
      mode = 'unvalidated';
    } else {
      pooledRaw[factor] = priorSigned;
      mode = 'prior';
    }
    factorStats[factor] = {
      ic: meanIc,
      observations,
      n_periods: nPeriods,
      t_stat: tStat,
      n_effective: csIc.n_effective,
      overlap_factor: csIc.overlap_factor,
      credibility_k: kEffective,
      mode,
      raw_weight: pooledRaw[factor] as number,
      robustness: wfFactor.verdict,
      oos_ic: wfFactor.oos_ic,
      net_spread_pct: edge?.net_spread_pct ?? null,
      net_edge_per_30d_pct: edge?.net_edge_per_30d_pct ?? null,
      edge_t_stat: edge?.t_stat ?? null,
      edge_n_effective: edge?.n_effective ?? null,
      edge_overlap_factor: edge?.overlap_factor ?? null,
      edge_verdict: edgeWf.verdict,
      edge_train_net_spread_pct: edgeWf.train?.net_spread_pct ?? null,
      edge_validation_net_spread_pct: edgeWf.validation?.net_spread_pct ?? null,
      regime_ic: null,
      regime_t_stat: null,
      regime_n_periods: 0,
      regime_k: 0.0,
      regime_mode: 'pooled',
      base_weight: 0,
      weight: 0,
      regime_multiplier: 1.0,
    };
  }

  const pooledAbsTotal =
    Object.values(pooledRaw).reduce((sum, value) => sum + Math.abs(value), 0) || 1.0;
  const baseDirectional: Record<string, number> = {};
  for (const factor of DIRECTIONAL_FACTORS) {
    baseDirectional[factor] = (pooledRaw[factor] as number) / pooledAbsTotal;
  }

  const finalRaw: Record<string, number> = {};
  const factorsUsingRegimeIc: string[] = [];
  const regimeNByFactor: Record<string, number> = {};

  for (const factor of DIRECTIONAL_FACTORS) {
    const stat = factorStats[factor] as FactorStat;
    let kRegime = 0.0;
    let regimeMeanIc: number | null = null;
    let regimeTStat: number | null = null;
    let regimeNPeriods = 0;
    let regimeMode: 'pooled' | 'regime-ic' = 'pooled';

    if (currentRegime !== null && currentRegime !== undefined) {
      const regimeRecords = icInputRecords.filter((record) => record.regime === currentRegime);
      const regimeIc = crossSectionalIc(regimeRecords, factor, icMinCrossSection, icOptions);
      regimeMeanIc = regimeIc.mean_ic;
      regimeTStat = regimeIc.t_stat;
      regimeNPeriods = regimeIc.n_periods;
      regimeNByFactor[factor] = regimeNPeriods;
      // A factor zeroed for losing money forward stays zeroed. Regime IC is rank IC, which is blind
      // to the cost and skew that condemned the factor in the first place, so blending it back in
      // would hand weight to a proven loser on the strength of the very metric the net_edge gate
      // exists to overrule. Its regime IC is still recorded below, as a diagnostic.
      const useRegime =
        stat.mode !== 'unvalidated' &&
        regimeNPeriods >= regimeMinPeriods &&
        regimeTStat !== null &&
        Math.abs(regimeTStat) >= minAbsT &&
        regimeMeanIc !== null &&
        Math.abs(regimeMeanIc) >= minAbsIc;
      if (useRegime) {
        kRegime = regimeNPeriods / (regimeNPeriods + regimeConditionalPriorStrength);
        regimeMode = 'regime-ic';
        factorsUsingRegimeIc.push(factor);
      }
      finalRaw[factor] =
        (1.0 - kRegime) * (pooledRaw[factor] as number) +
        kRegime * clamp(regimeMeanIc ?? 0.0, -maxAbsWeight, maxAbsWeight);
    } else {
      finalRaw[factor] = pooledRaw[factor] as number;
    }

    stat.regime_ic = regimeMeanIc;
    stat.regime_t_stat = regimeTStat;
    stat.regime_n_periods = regimeNPeriods;
    stat.regime_k = kRegime;
    stat.regime_mode = regimeMode;
    stat.base_weight = baseDirectional[factor] as number;
  }

  const finalAbsTotal =
    Object.values(finalRaw).reduce((sum, value) => sum + Math.abs(value), 0) || 1.0;
  const directional: Record<string, number> = {};
  for (const factor of DIRECTIONAL_FACTORS) {
    directional[factor] = (finalRaw[factor] as number) / finalAbsTotal;
  }

  for (const factor of DIRECTIONAL_FACTORS) {
    const weight = directional[factor] as number;
    const stat = factorStats[factor] as FactorStat;
    const baseWeight = stat.base_weight;
    stat.weight = weight;
    stat.raw_weight = finalRaw[factor] as number;
    stat.regime_multiplier = baseWeight !== 0 ? pyRound(weight / baseWeight, 3) : 1.0;
  }

  const validatedFactorCount = Object.values(factorStats).filter(
    (stat) => stat.edge_verdict === 'validated',
  ).length;

  return {
    directional,
    base_directional: baseDirectional,
    stats: factorStats,
    history_records: historyRecords.length,
    mode: Object.values(factorStats).some((stat) => stat.mode === 'ic') ? 'ic' : 'prior',
    ic_target_effective: icTargetEffective,
    selection_objective: selectionObjective,
    validated_factor_count: validatedFactorCount,
    regime_adjusted: currentRegime !== null && currentRegime !== undefined,
    regime_adjustment: {
      label: currentRegime ?? 'pooled',
      method: 'regime-conditional-ic',
      factors_using_regime_ic: factorsUsingRegimeIc,
      regime_n_periods: regimeNByFactor,
    },
    regime_conditional: {
      current_regime: currentRegime ?? null,
      prior_strength: regimeConditionalPriorStrength,
      min_periods: regimeMinPeriods,
      factors_using_regime_ic: factorsUsingRegimeIc,
    },
    validation: validationMetrics(historyRecords, config),
    walk_forward: wf,
  };
}

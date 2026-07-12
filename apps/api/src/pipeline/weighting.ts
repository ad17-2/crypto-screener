import { DEFAULT_PRIORS, DIRECTIONAL_FACTORS } from './factorDefinitions.js';
import { crossSectionalIc, type FactorRecord } from './ic.js';
import type { FactorCorrelationFlag } from './independence.js';
import { clamp, pyRound } from './scoring.js';
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
  mode: 'ic' | 'prior';
  raw_weight: number;
  robustness: WalkForwardFactorResult['verdict'];
  oos_ic: number | null;
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
  const wf = walkForward(historyRecords, config);

  const pooledRaw: Record<string, number> = {};
  const factorStats: Record<string, FactorStat> = {};

  for (const factor of DIRECTIONAL_FACTORS) {
    const csIc = crossSectionalIc(historyRecords, factor, icMinCrossSection, icOptions);
    const meanIc = csIc.mean_ic;
    const tStat = csIc.t_stat;
    const nPeriods = csIc.n_periods;
    const observations = csIc.n_obs;
    const priorSigned = priors[factor] ?? 0.0;
    const k = nPeriods > 0 ? nPeriods / (nPeriods + icPriorStrength) : 0.0;
    const useObserved =
      nPeriods >= icMinPeriods &&
      tStat !== null &&
      Math.abs(tStat) >= minAbsT &&
      meanIc !== null &&
      Math.abs(meanIc) >= minAbsIc;
    let kEffective = useObserved ? k : 0.0;
    // walkForward() always populates every DIRECTIONAL_FACTORS entry; noUncheckedIndexedAccess just can't see that invariant.
    const wfFactor = wf.factors[factor] as WalkForwardFactorResult;
    if (walkForwardGating && wfFactor.verdict === 'overfit') {
      kEffective *= overfitPenalty;
    }
    let mode: 'ic' | 'prior';
    if (useObserved && meanIc !== null && kEffective > 0) {
      pooledRaw[factor] =
        (1.0 - kEffective) * priorSigned + kEffective * clamp(meanIc, -maxAbsWeight, maxAbsWeight);
      mode = 'ic';
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
    let kRegime = 0.0;
    let regimeMeanIc: number | null = null;
    let regimeTStat: number | null = null;
    let regimeNPeriods = 0;
    let regimeMode: 'pooled' | 'regime-ic' = 'pooled';

    if (currentRegime !== null && currentRegime !== undefined) {
      const regimeRecords = historyRecords.filter((record) => record.regime === currentRegime);
      const regimeIc = crossSectionalIc(regimeRecords, factor, icMinCrossSection, icOptions);
      regimeMeanIc = regimeIc.mean_ic;
      regimeTStat = regimeIc.t_stat;
      regimeNPeriods = regimeIc.n_periods;
      regimeNByFactor[factor] = regimeNPeriods;
      const useRegime =
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

    const stat = factorStats[factor] as FactorStat;
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

  return {
    directional,
    base_directional: baseDirectional,
    stats: factorStats,
    history_records: historyRecords.length,
    mode: Object.values(factorStats).some((stat) => stat.mode === 'ic') ? 'ic' : 'prior',
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

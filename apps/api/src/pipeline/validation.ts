import { DIRECTIONAL_FACTORS } from './factorDefinitions.js';
import { crossSectionalIc, type FactorRecord } from './ic.js';
import { pyRound, toFloat } from './scoring.js';
import type { PipelineConfig } from './types.js';
import { asRecord } from './types.js';

function signValue(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export interface WalkForwardFactorResult {
  verdict: 'robust' | 'overfit' | 'insufficient-data';
  is_ic: number | null;
  is_t_stat: number | null;
  is_n_periods: number;
  oos_ic: number | null;
  oos_t_stat: number | null;
  oos_n_periods: number;
}

export interface WalkForwardResult {
  split_index: number;
  n_timestamps: number;
  train_periods: number;
  factors: Record<string, WalkForwardFactorResult>;
}

export function walkForward(
  historyRecords: FactorRecord[],
  config: PipelineConfig,
): WalkForwardResult {
  const factorCfg = config.factors ?? {};
  const trainFraction = factorCfg.walk_forward_train_fraction ?? 0.6;
  const minTrainPeriods = factorCfg.walk_forward_min_train_periods ?? 15;
  const minOosPeriods = factorCfg.walk_forward_min_oos_periods ?? 10;
  const robustMinIc = factorCfg.walk_forward_robust_min_ic ?? 0.02;
  const icMinCrossSection = factorCfg.ic_min_cross_section ?? 5;
  const icMinPeriods = factorCfg.ic_min_periods ?? 10;
  const minAbsT = factorCfg.min_abs_t ?? 2.0;
  const minAbsIc = factorCfg.min_abs_ic ?? 0.02;

  const timestampSet = new Set<string>();
  for (const record of historyRecords) {
    if (record.generated_at !== null && record.generated_at !== undefined) {
      timestampSet.add(String(record.generated_at));
    }
  }
  const timestamps = [...timestampSet].sort();
  const nTs = timestamps.length;
  const splitIndex = Math.max(minTrainPeriods, Math.floor(trainFraction * nTs));
  const trainTimestamps = new Set(timestamps.slice(0, splitIndex));
  const testTimestamps = new Set(timestamps.slice(splitIndex));

  const trainRecords = historyRecords.filter((record) =>
    trainTimestamps.has(String(record.generated_at)),
  );
  const testRecords = historyRecords.filter((record) =>
    testTimestamps.has(String(record.generated_at)),
  );

  const factorsResult: Record<string, WalkForwardFactorResult> = {};
  for (const factor of DIRECTIONAL_FACTORS) {
    const isIc = crossSectionalIc(trainRecords, factor, icMinCrossSection);
    const oosIc = crossSectionalIc(testRecords, factor, icMinCrossSection);
    const isMean = isIc.mean_ic;
    const oosMean = oosIc.mean_ic;
    const isT = isIc.t_stat;

    let verdict: WalkForwardFactorResult['verdict'];
    if (isIc.n_periods < icMinPeriods || oosIc.n_periods < minOosPeriods) {
      verdict = 'insufficient-data';
    } else if (
      isT !== null &&
      Math.abs(isT) >= minAbsT &&
      isMean !== null &&
      Math.abs(isMean) >= minAbsIc
    ) {
      if (
        oosMean !== null &&
        signValue(oosMean) === signValue(isMean) &&
        Math.abs(oosMean) >= robustMinIc
      ) {
        verdict = 'robust';
      } else {
        verdict = 'overfit';
      }
    } else {
      verdict = 'insufficient-data';
    }

    factorsResult[factor] = {
      verdict,
      is_ic: isMean !== null ? pyRound(isMean, 4) : null,
      is_t_stat: isT !== null ? pyRound(isT, 3) : null,
      is_n_periods: isIc.n_periods,
      oos_ic: oosMean !== null ? pyRound(oosMean, 4) : null,
      oos_t_stat: oosIc.t_stat !== null ? pyRound(oosIc.t_stat, 3) : null,
      oos_n_periods: oosIc.n_periods,
    };
  }

  return {
    split_index: splitIndex,
    n_timestamps: nTs,
    train_periods: splitIndex,
    factors: factorsResult,
  };
}

export interface DecayCurvePoint {
  horizon_hours: number;
  mean_ic: number | null;
  t_stat: number | null;
  n_periods: number;
  insufficient: boolean;
}

export interface FactorDecaySummary {
  curve: DecayCurvePoint[];
  peak_abs_ic: number | null;
  peak_horizon_hours: number | null;
  half_life_hours: number | null;
  first_sign_flip_hours: number | null;
  holds_hours: number | null;
  sufficient: boolean;
}

export function factorDecay(
  recordsByHorizon: Map<number, FactorRecord[]>,
  config: PipelineConfig,
): Record<string, FactorDecaySummary> {
  const factorCfg = config.factors ?? {};
  const icMinCrossSection = factorCfg.ic_min_cross_section ?? 5;
  const icMinPeriods = factorCfg.ic_min_periods ?? 10;
  const horizons = [...recordsByHorizon.keys()].sort((a, b) => a - b);
  const result: Record<string, FactorDecaySummary> = {};

  for (const factor of DIRECTIONAL_FACTORS) {
    const curve: DecayCurvePoint[] = [];
    for (const horizon of horizons) {
      const icResult = crossSectionalIc(
        recordsByHorizon.get(horizon) ?? [],
        factor,
        icMinCrossSection,
      );
      curve.push({
        horizon_hours: horizon,
        mean_ic: icResult.mean_ic !== null ? pyRound(icResult.mean_ic, 4) : null,
        t_stat: icResult.t_stat !== null ? pyRound(icResult.t_stat, 3) : null,
        n_periods: icResult.n_periods,
        insufficient: icResult.n_periods < icMinPeriods,
      });
    }

    const sufficientPoints = curve.filter((point) => !point.insufficient);
    const sufficient = sufficientPoints.length > 0;
    let peakAbsIc: number | null = null;
    let peakHorizonHours: number | null = null;
    let halfLifeHours: number | null = null;
    let firstSignFlipHours: number | null = null;
    let holdsHours: number | null = null;

    if (sufficientPoints.length > 0) {
      const peakPoint = sufficientPoints.reduce((best, point) =>
        Math.abs(point.mean_ic ?? 0.0) > Math.abs(best.mean_ic ?? 0.0) ? point : best,
      );
      const peakMeanIc = peakPoint.mean_ic;
      peakAbsIc = Math.abs(peakMeanIc ?? 0.0);
      peakHorizonHours = peakPoint.horizon_hours;

      if (peakAbsIc > 0) {
        for (const point of curve) {
          if (point.horizon_hours <= peakHorizonHours || point.insufficient) {
            continue;
          }
          const meanIc = point.mean_ic;
          if (meanIc !== null && Math.abs(meanIc) < 0.5 * peakAbsIc) {
            halfLifeHours = point.horizon_hours;
            break;
          }
        }
      }

      if (peakMeanIc !== null && peakMeanIc !== 0.0) {
        const peakPositive = peakMeanIc > 0;
        for (const point of curve) {
          if (point.horizon_hours <= peakHorizonHours || point.insufficient) {
            continue;
          }
          const meanIc = point.mean_ic;
          if (meanIc === null || meanIc === 0.0) {
            continue;
          }
          if (meanIc > 0 !== peakPositive) {
            firstSignFlipHours = point.horizon_hours;
            break;
          }
        }
      }

      const holdCandidates = [halfLifeHours, firstSignFlipHours].filter(
        (value): value is number => value !== null,
      );
      holdsHours = holdCandidates.length > 0 ? Math.min(...holdCandidates) : null;
    }

    result[factor] = {
      curve,
      peak_abs_ic: peakAbsIc !== null ? pyRound(peakAbsIc, 4) : null,
      peak_horizon_hours: peakHorizonHours,
      half_life_hours: halfLifeHours,
      first_sign_flip_hours: firstSignFlipHours,
      holds_hours: holdsHours,
      sufficient,
    };
  }

  return result;
}

export interface DirectionalValidationResult {
  observations: number;
  hit_rate: number | null;
  avg_forward_return_pct: number | null;
  long_observations?: number;
  long_hit_rate?: number | null;
  short_observations?: number;
  short_hit_rate?: number | null;
}

export function directionalValidation(
  pairs: ReadonlyArray<readonly [number | null, number | null]>,
): DirectionalValidationResult {
  const valid = pairs.filter(
    (pair): pair is [number, number] => pair[0] !== null && pair[1] !== null && pair[0] !== 0,
  );
  if (valid.length === 0) {
    return { observations: 0, hit_rate: null, avg_forward_return_pct: null };
  }
  const hits = valid.filter(([signal, forward]) => signal * forward > 0).length;
  const avgForward = valid.reduce((sum, [, forward]) => sum + forward, 0) / valid.length;
  const positive = valid.filter(([signal]) => signal > 0);
  const negative = valid.filter(([signal]) => signal < 0);
  return {
    observations: valid.length,
    hit_rate: pyRound((hits / valid.length) * 100.0, 2),
    avg_forward_return_pct: pyRound(avgForward, 3),
    long_observations: positive.length,
    long_hit_rate: hitRate(positive, 1.0),
    short_observations: negative.length,
    short_hit_rate: hitRate(negative, -1.0),
  };
}

export function hitRate(
  pairs: ReadonlyArray<readonly [number, number]>,
  expectedDirection: number,
): number | null {
  if (pairs.length === 0) {
    return null;
  }
  const hits = pairs.filter(([, forward]) => forward * expectedDirection > 0).length;
  return pyRound((hits / pairs.length) * 100.0, 2);
}

export interface ValidationMetrics {
  status: 'insufficient' | 'ok' | 'limited';
  horizon_hours: number;
  observations: number;
  model: DirectionalValidationResult | Record<string, never>;
  factors: Record<string, DirectionalValidationResult>;
}

export function validationMetrics(
  historyRecords: FactorRecord[],
  config: PipelineConfig,
): ValidationMetrics {
  const factorCfg = config.factors ?? {};
  const horizonHours = factorCfg.forward_return_hours ?? 24;
  const records = historyRecords.filter((record) => toFloat(record.forward_return_pct) !== null);
  if (records.length === 0) {
    return {
      status: 'insufficient',
      horizon_hours: horizonHours,
      observations: 0,
      model: {},
      factors: {},
    };
  }

  const modelPairs: Array<[number | null, number | null]> = records.map((record) => [
    toFloat(asRecord(record.scores).factor_score),
    toFloat(record.forward_return_pct),
  ]);
  const modelValid = modelPairs.filter(
    (pair): pair is [number, number] => pair[0] !== null && pair[1] !== null,
  );
  const factorResults: Record<string, DirectionalValidationResult> = {};
  for (const factor of DIRECTIONAL_FACTORS) {
    factorResults[factor] = directionalValidation(
      records.map((record) => [
        toFloat(asRecord(record.factors)[factor]),
        toFloat(record.forward_return_pct),
      ]),
    );
  }

  const minObservations = factorCfg.min_observations ?? 30;
  return {
    status: records.length >= minObservations ? 'ok' : 'limited',
    horizon_hours: horizonHours,
    observations: records.length,
    model: directionalValidation(modelValid),
    factors: factorResults,
  };
}

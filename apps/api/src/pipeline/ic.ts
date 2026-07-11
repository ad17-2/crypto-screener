import { mean, spearmanCorr, stdev, toFloat } from './scoring.js';
import { asRecord } from './types.js';

// Kept separate from weighting.ts/validation.ts: they import each other, so folding this in would create a circular dependency.
export interface CrossSectionalIcResult {
  mean_ic: number | null;
  t_stat: number | null;
  n_periods: number;
  n_obs: number;
}

export interface FactorRecord {
  generated_at?: unknown;
  forward_return_pct?: unknown;
  factors?: unknown;
  regime?: unknown;
  [key: string]: unknown;
}

/** Per-section rank IC already neutralizes cross-time market drift; no explicit demeaning needed. */
export function crossSectionalIc(
  records: FactorRecord[],
  factor: string,
  minCrossSection: number,
): CrossSectionalIcResult {
  const grouped = new Map<unknown, Array<[number, number]>>();
  let nObs = 0;
  for (const record of records) {
    const factorValue = toFloat(asRecord(record.factors)[factor]);
    const forwardReturn = toFloat(record.forward_return_pct);
    if (factorValue === null || forwardReturn === null) {
      continue;
    }
    nObs += 1;
    const key = record.generated_at;
    const existing = grouped.get(key);
    if (existing) {
      existing.push([factorValue, forwardReturn]);
    } else {
      grouped.set(key, [[factorValue, forwardReturn]]);
    }
  }

  const icSeries: number[] = [];
  for (const pairs of grouped.values()) {
    if (pairs.length < minCrossSection) {
      continue;
    }
    const xValues = pairs.map((pair) => pair[0]);
    const yValues = pairs.map((pair) => pair[1]);
    const ic = spearmanCorr(xValues, yValues);
    if (ic !== null) {
      icSeries.push(ic);
    }
  }

  const nPeriods = icSeries.length;
  const meanIc = icSeries.length > 0 ? mean(icSeries) : null;
  let tStat: number | null = null;
  if (nPeriods >= 2 && meanIc !== null) {
    const icStdev = stdev(icSeries);
    if (icStdev > 0) {
      tStat = meanIc / (icStdev / Math.sqrt(nPeriods));
    }
  }

  return { mean_ic: meanIc, t_stat: tStat, n_periods: nPeriods, n_obs: nObs };
}

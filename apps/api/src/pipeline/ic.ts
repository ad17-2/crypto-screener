import { mean, median, spearmanCorr, toFloat } from './scoring.js';
import { asRecord } from './types.js';

// Kept separate from weighting.ts/validation.ts: they import each other, so folding this in would create a circular dependency.
export interface CrossSectionalIcResult {
  mean_ic: number | null;
  t_stat: number | null;
  n_periods: number;
  n_obs: number;
  /** De-overlapped n used in the t-stat's SE; equals n_periods with overlapCorrection off. */
  n_effective: number | null;
  /** q = forwardReturnHours / medianSpacingHours, clamped >= 1; forced to 1 with overlapCorrection off. */
  overlap_factor: number | null;
}

export interface FactorRecord {
  generated_at?: unknown;
  forward_return_pct?: unknown;
  factors?: unknown;
  regime?: unknown;
  [key: string]: unknown;
}

export interface CrossSectionalIcOptions {
  forwardReturnHours: number;
  /** Deflate the t-stat's SE for overlapping forward-return windows; see crossSectionalIc. */
  overlapCorrection: boolean;
}

const DEFAULT_OPTIONS: CrossSectionalIcOptions = {
  forwardReturnHours: 24,
  overlapCorrection: true,
};

/** Sample stdev (ddof=1) — a t-stat's SE needs this, not scoring.ts's population stdev(). */
export function sampleStdev(values: number[]): number {
  if (values.length < 2) {
    return 0.0;
  }
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Median gap, in hours, between consecutive distinct timestamps (ms epoch). Null if fewer than 2. */
function medianSpacingHours(sortedDistinctTimestampsMs: number[]): number | null {
  if (sortedDistinctTimestampsMs.length < 2) {
    return null;
  }
  const gapsHours: number[] = [];
  for (let i = 1; i < sortedDistinctTimestampsMs.length; i += 1) {
    const prev = sortedDistinctTimestampsMs[i - 1] as number;
    const curr = sortedDistinctTimestampsMs[i] as number;
    gapsHours.push((curr - prev) / 3_600_000);
  }
  return median(gapsHours);
}

/**
 * Shared with economicEdge.ts, which needs the identical overlap/n_effective derivation for its
 * own t-stat. q = forwardReturnHours / medianSpacingHours (clamped >= 1, spacing from the
 * retained periods' actual timestamp gaps); n_effective = n_periods / q (clamped >= 1).
 */
export function overlapAdjustedNEffective(
  nPeriods: number,
  retainedTimestampsMs: number[],
  forwardReturnHours: number,
  overlapCorrection: boolean,
): { nEffective: number; overlapFactor: number } {
  const sortedTimestampsMs = [...new Set(retainedTimestampsMs)].sort((a, b) => a - b);
  const spacingHours = medianSpacingHours(sortedTimestampsMs);
  const dataOverlapQ =
    spacingHours !== null && spacingHours > 0 ? Math.max(1, forwardReturnHours / spacingHours) : 1;
  const overlapFactor = overlapCorrection ? dataOverlapQ : 1;
  const nEffective = Math.max(1, nPeriods / overlapFactor);
  return { nEffective, overlapFactor };
}

/**
 * Cross-sectional rank-IC with an overlap-corrected t-stat: SE uses effective n = n_periods / q,
 * q = forwardReturnHours / medianSpacingHours (clamped >= 1, spacing from the retained periods'
 * actual timestamp gaps, not an assumed cadence). Per-section rank IC already neutralizes market drift.
 */
export function crossSectionalIc(
  records: FactorRecord[],
  factor: string,
  minCrossSection: number,
  options: CrossSectionalIcOptions = DEFAULT_OPTIONS,
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
  const retainedTimestampsMs: number[] = [];
  for (const [key, pairs] of grouped.entries()) {
    if (pairs.length < minCrossSection) {
      continue;
    }
    const xValues = pairs.map((pair) => pair[0]);
    const yValues = pairs.map((pair) => pair[1]);
    const ic = spearmanCorr(xValues, yValues);
    if (ic !== null) {
      icSeries.push(ic);
      const parsedMs = typeof key === 'string' ? Date.parse(key) : Number.NaN;
      if (!Number.isNaN(parsedMs)) {
        retainedTimestampsMs.push(parsedMs);
      }
    }
  }

  const nPeriods = icSeries.length;
  const meanIc = icSeries.length > 0 ? mean(icSeries) : null;
  let tStat: number | null = null;
  let nEffective: number | null = null;
  let overlapFactor: number | null = null;

  if (nPeriods >= 2 && meanIc !== null) {
    const adjustment = overlapAdjustedNEffective(
      nPeriods,
      retainedTimestampsMs,
      options.forwardReturnHours,
      options.overlapCorrection,
    );
    nEffective = adjustment.nEffective;
    overlapFactor = adjustment.overlapFactor;

    const icSampleStdev = sampleStdev(icSeries);
    if (icSampleStdev > 0) {
      tStat = meanIc / (icSampleStdev / Math.sqrt(nEffective));
    }
  }

  return {
    mean_ic: meanIc,
    t_stat: tStat,
    n_periods: nPeriods,
    n_obs: nObs,
    n_effective: nEffective,
    overlap_factor: overlapFactor,
  };
}

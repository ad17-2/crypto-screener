import type { LabeledFactorRecord } from '../db/types.js';
import { overlapAdjustedNEffective, sampleStdev } from './ic.js';
import { mean, toFloat } from './scoring.js';
import { asRecord } from './types.js';

export interface EconomicEdgeOptions {
  forwardReturnHours: number;
  /** Round-trip cost per leg, pct-of-notional (e.g. 0.15 => a long-short pays 2 * 0.15 = 0.30). */
  costPctPerLeg: number;
  decileFraction?: number;
  minNamesPerPeriod?: number;
}

export interface EconomicEdgeSummary {
  n_periods: number;
  n_effective: number;
  overlap_factor: number;
  /** Signed: mean over periods of (top-decile mean fwd) - (bottom-decile mean fwd). */
  gross_spread_pct: number;
  /** abs(gross_spread_pct) - 2 * costPctPerLeg -- traded in whichever direction gross_spread_pct points. */
  net_spread_pct: number;
  t_stat: number;
  net_edge_per_30d_pct: number;
  direction: 1 | -1 | 0;
}

const DEFAULT_DECILE_FRACTION = 0.1;
const DEFAULT_MIN_NAMES_PER_PERIOD = 20;
const MIN_PERIODS = 10;
const HOURS_PER_30D = 720;

/**
 * Realised-money edge, net of costs: per period, spread the RAW forward_return_pct between the
 * top and bottom decile of factorKey (never a risk-adjusted return -- rank IC is blind to the
 * skew that decides whether the spread is actually collectable). Same overlap/n_effective
 * correction as crossSectionalIc (ic.ts), applied here to the period spreads instead of period ICs.
 */
export function economicEdge(
  records: LabeledFactorRecord[],
  factorKey: string,
  options: EconomicEdgeOptions,
): EconomicEdgeSummary | null {
  const decileFraction = options.decileFraction ?? DEFAULT_DECILE_FRACTION;
  const minNamesPerPeriod = options.minNamesPerPeriod ?? DEFAULT_MIN_NAMES_PER_PERIOD;

  const grouped = new Map<string, Array<[number, number]>>();
  for (const record of records) {
    const factorValue = toFloat(asRecord(record.factors)[factorKey]);
    const forwardReturn = toFloat(record.forward_return_pct);
    if (factorValue === null || forwardReturn === null) {
      continue;
    }
    const key = record.generated_at;
    const existing = grouped.get(key);
    if (existing) {
      existing.push([factorValue, forwardReturn]);
    } else {
      grouped.set(key, [[factorValue, forwardReturn]]);
    }
  }

  const spreads: number[] = [];
  const retainedTimestampsMs: number[] = [];
  for (const [key, pairs] of grouped.entries()) {
    if (pairs.length < minNamesPerPeriod) {
      continue;
    }
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const k = Math.max(3, Math.floor(sorted.length * decileFraction));
    const bottomMean = mean(sorted.slice(0, k).map((pair) => pair[1]));
    const topMean = mean(sorted.slice(sorted.length - k).map((pair) => pair[1]));
    spreads.push(topMean - bottomMean);

    const parsedMs = Date.parse(key);
    if (!Number.isNaN(parsedMs)) {
      retainedTimestampsMs.push(parsedMs);
    }
  }

  const nPeriods = spreads.length;
  if (nPeriods < MIN_PERIODS) {
    return null;
  }

  const grossSpreadPct = mean(spreads);
  const { nEffective, overlapFactor } = overlapAdjustedNEffective(
    nPeriods,
    retainedTimestampsMs,
    options.forwardReturnHours,
    true,
  );

  const spreadSampleStdev = sampleStdev(spreads);
  // Zero variance across periods has no meaningful t-stat; treat as no measured signal rather than +/-Infinity.
  const tStat =
    spreadSampleStdev > 0 ? grossSpreadPct / (spreadSampleStdev / Math.sqrt(nEffective)) : 0;

  const netSpreadPct = Math.abs(grossSpreadPct) - 2 * options.costPctPerLeg;
  const netEdgePer30dPct = netSpreadPct * (HOURS_PER_30D / options.forwardReturnHours);
  const direction = grossSpreadPct > 0 ? 1 : grossSpreadPct < 0 ? -1 : 0;

  return {
    n_periods: nPeriods,
    n_effective: nEffective,
    overlap_factor: overlapFactor,
    gross_spread_pct: grossSpreadPct,
    net_spread_pct: netSpreadPct,
    t_stat: tStat,
    net_edge_per_30d_pct: netEdgePer30dPct,
    direction,
  };
}

import { describe, expect, it } from 'vitest';
import type { LabeledFactorRecord } from '../../src/db/types.js';
import { type EconomicEdgeOptions, economicEdge } from '../../src/pipeline/economicEdge.js';
import { crossSectionalIc } from '../../src/pipeline/ic.js';

const FACTOR = 'edge_factor';

function isoAt(hoursOffset: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + hoursOffset * 3_600_000).toISOString();
}

function period(generatedAt: string, pairs: Array<[number, number]>): LabeledFactorRecord[] {
  return pairs.map(([factorValue, forward], index) => ({
    symbol: `S${index}`,
    generated_at: generatedAt,
    forward_return_pct: forward,
    factors: { [FACTOR]: factorValue },
    scores: {},
  }));
}

describe('economicEdge', () => {
  it('perfectly-ordering factor: exact decile spread, direction = 1, net = gross - 2*cost', () => {
    // n=20/period (default minNamesPerPeriod), default decileFraction 0.10 -> k=max(3, floor(2))=3.
    // factor = 1..20, forward = 10*factor -- perfect concordance.
    const pairs: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    // 10 identical periods -> gross_spread_pct is exactly each period's spread.
    const records = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();

    const options: EconomicEdgeOptions = { forwardReturnHours: 24, costPctPerLeg: 0.15 };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    // bottom3 = factor{1,2,3} -> forward{10,20,30}, mean=20; top3 = factor{18,19,20} -> forward{180,190,200}, mean=190.
    expect(result?.gross_spread_pct).toBe(170);
    expect(result?.direction).toBe(1);
    expect(result?.net_spread_pct).toBeCloseTo(170 - 2 * 0.15, 9);
  });

  it('edge != IC: strongly negative rank IC, but a huge outlier in the bottom decile flips the decile spread positive', () => {
    // 9 "clean" periods: factor=1..10, forward=100-10*factor -- perfect negative concordance (Spearman = -1 each).
    const cleanPairs: Array<[number, number]> = Array.from({ length: 10 }, (_, i) => {
      const factor = i + 1;
      return [factor, 100 - 10 * factor];
    });
    // 1 "outlier" period: identical except factor=1 (bottom decile) gets a huge NEGATIVE forward
    // return instead of the clean 90 -- still rank-consistent-ish (low factor, low return dampens
    // the negative IC slightly) but it drags the bottom-decile RAW mean far below the top decile's,
    // flipping that period's (and the aggregate's) decile spread strongly positive.
    const outlierPairs: Array<[number, number]> = cleanPairs.map(([factor, forward]) =>
      factor === 1 ? [factor, -100_000] : [factor, forward],
    );

    const cleanRecords = Array.from({ length: 9 }, (_, p) =>
      period(isoAt(p * 24), cleanPairs),
    ).flat();
    const outlierRecords = period(isoAt(9 * 24), outlierPairs);
    const records = [...cleanRecords, ...outlierRecords];

    const csResult = crossSectionalIc(records, FACTOR, 10, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    // Hand-computed: 9 periods at ic=-1, 1 period at ic=-5/11 -> mean = (-9 - 5/11)/10 = -52/55.
    expect(csResult.mean_ic as number).toBeCloseTo(-52 / 55, 9);
    expect(csResult.mean_ic as number).toBeLessThan(-0.5); // strongly negative rank IC

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.3,
      minNamesPerPeriod: 10,
    };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    // clean-period spread = mean(top3 {20,10,0}) - mean(bottom3 {90,80,70}) = 10 - 80 = -70.
    // outlier-period spread = mean(top3 {20,10,0}) - mean(bottom3 {-100000,80,70}) = 10 - (-33283.33..) = 33293.33..
    // gross = (9*(-70) + 99880/3) / 10 = 9799/3.
    expect(result?.gross_spread_pct).toBeCloseTo(9799 / 3, 6);
    expect(result?.gross_spread_pct as number).toBeGreaterThan(0);
    expect(result?.direction).toBe(1); // opposite sign of the rank IC -- this is the whole point
  });

  it('overlap correction: 24h horizon on 4h-spaced periods -> overlap_factor = 6, n_effective = n/6', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 6 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    // 12 periods, regular 4h cadence.
    const records = Array.from({ length: 12 }, (_, p) => period(isoAt(p * 4), pairs)).flat();

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.5,
      minNamesPerPeriod: 6,
    };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    expect(result?.n_periods).toBe(12);
    expect(result?.overlap_factor).toBeCloseTo(6, 9);
    expect(result?.n_effective).toBeCloseTo(12 / 6, 9);
  });

  it('skips periods with fewer than minNamesPerPeriod finite (factor, forward) pairs entirely', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 6 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    const baseRecords = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();

    // Too few raw names (2 < minNamesPerPeriod=6).
    const tooFewNames = period(isoAt(100 * 24), [
      [1, 10],
      [2, 20],
    ]);
    // 6 raw names, but one has a non-finite forward_return_pct -> only 5 finite pairs, still < 6.
    const withNonFinite = period(isoAt(101 * 24), pairs).map((record, index) =>
      index === 0 ? { ...record, forward_return_pct: Number.NaN } : record,
    );

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.5,
      minNamesPerPeriod: 6,
    };

    const baseline = economicEdge(baseRecords, FACTOR, options);
    const withExtras = economicEdge(
      [...baseRecords, ...tooFewNames, ...withNonFinite],
      FACTOR,
      options,
    );

    expect(withExtras).not.toBeNull();
    expect(withExtras?.n_periods).toBe(10);
    expect(withExtras).toEqual(baseline);
  });

  it('returns null with fewer than 10 qualifying periods', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 6 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    const records = Array.from({ length: 9 }, (_, p) => period(isoAt(p * 24), pairs)).flat();

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.5,
      minNamesPerPeriod: 6,
    };
    expect(economicEdge(records, FACTOR, options)).toBeNull();
  });
});

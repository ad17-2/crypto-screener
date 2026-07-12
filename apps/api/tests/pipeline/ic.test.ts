import { describe, expect, it } from 'vitest';
import { crossSectionalIc, type FactorRecord } from '../../src/pipeline/ic.js';

const FACTOR = 'f';

/**
 * Two symbols per period, deterministic Spearman IC: with n=2 and no ties, correlation is always
 * exactly +1 (concordant) or -1 (discordant) -- lets tests hand-compute mean/stdev exactly instead
 * of trusting the correlation math under test.
 */
function twoSymbolPeriod(generatedAt: string, concordant: boolean): FactorRecord[] {
  const forwardHigh = concordant ? 1 : 0;
  const forwardLow = concordant ? 0 : 1;
  return [
    {
      symbol: 'S0',
      generated_at: generatedAt,
      forward_return_pct: forwardLow,
      factors: { [FACTOR]: 0 },
    },
    {
      symbol: 'S1',
      generated_at: generatedAt,
      forward_return_pct: forwardHigh,
      factors: { [FACTOR]: 1 },
    },
  ];
}

describe('crossSectionalIc overlap correction', () => {
  it('uses SAMPLE stdev (ddof=1), not population stdev, regardless of the overlap toggle', () => {
    // 3 periods, regular 4h spacing, forwardReturnHours 4h -> q clamps to 1, so this isolates the
    // stdev fix from the overlap correction: with q=1, n_effective == n_periods either way.
    const records = [
      ...twoSymbolPeriod('2024-01-01T00:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T04:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T08:00:00+07:00', false),
    ];
    const result = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 4,
      overlapCorrection: true,
    });
    // ic_series = [1, 1, -1] -> mean = 1/3, SAMPLE stdev (ddof=1) = 1.1547..., not population (0.9428...)
    expect(result.n_periods).toBe(3);
    expect(result.mean_ic as number).toBeCloseTo(0.3333333, 6);
    expect(result.overlap_factor).toBeCloseTo(1.0, 6); // forwardReturnHours == spacing -> q clamps to 1
    expect(result.n_effective).toBeCloseTo(3.0, 6);
    // t = (1/3) / (1.1547/sqrt(3)) -- would be (1/3)/(0.9428/sqrt(3)) = 0.6124 under the old population-stdev bug.
    expect(result.t_stat as number).toBeCloseTo(0.5, 4);
  });

  it('derives median spacing from actual irregular timestamps, not an assumed fixed cadence', () => {
    // Gaps of 1h then 15.5h (irregular, like the real fixture) -> median spacing 8.25h, NOT 4h.
    const records = [
      ...twoSymbolPeriod('2024-01-01T00:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T01:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T16:30:00+07:00', false),
    ];
    const result = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    // Independently hand-computed: mean_ic=1/3, sample_stdev=1.1547005...,
    // median_spacing=8.25h, q=24/8.25=2.909090..., n_effective=3/q=1.03125, t=0.293151...
    expect(result.n_periods).toBe(3);
    expect(result.overlap_factor as number).toBeCloseTo(2.909091, 5);
    expect(result.n_effective as number).toBeCloseTo(1.03125, 5);
    expect(result.t_stat as number).toBeCloseTo(0.293151, 5);
    // A wrong implementation that assumed a fixed 4h cadence would compute q=6, n_effective=0.5
    // clamped to 1, t=0.28868 -- distinct from the correct 0.293151 above.
    expect(result.t_stat as number).not.toBeCloseTo(0.28868, 4);
  });

  it('clamps n_effective to >= 1 when overlap q exceeds n_periods', () => {
    // 3 periods at a regular 4h cadence, 24h forward window -> q=6, so naive n/q = 0.5 must clamp to 1.
    const records = [
      ...twoSymbolPeriod('2024-01-01T00:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T04:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T08:00:00+07:00', false),
    ];
    const result = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    expect(result.overlap_factor).toBeCloseTo(6.0, 6);
    expect(result.n_effective).toBe(1.0); // 3/6 = 0.5 clamped up to the floor of 1
    expect(result.t_stat as number).toBeCloseTo(0.288675, 5);
  });

  it('deflates |t_stat| relative to the uncorrected statistic when overlap is present', () => {
    const icSeries: Array<[string, boolean]> = [
      ['2024-01-01T00:00:00+07:00', true],
      ['2024-01-01T04:00:00+07:00', true],
      ['2024-01-01T08:00:00+07:00', true],
      ['2024-01-01T12:00:00+07:00', true],
      ['2024-01-01T16:00:00+07:00', true],
      ['2024-01-01T20:00:00+07:00', true],
      ['2024-01-02T00:00:00+07:00', false],
      ['2024-01-02T04:00:00+07:00', false],
    ];
    const records = icSeries.flatMap(([ts, concordant]) => twoSymbolPeriod(ts, concordant));

    const corrected = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    const uncorrected = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: false,
    });

    expect(corrected.n_periods).toBe(8);
    expect(uncorrected.n_periods).toBe(8);
    // Same mean_ic and n_periods either way -- only the SE denominator (and therefore |t|) differs.
    expect(corrected.mean_ic).toBeCloseTo(uncorrected.mean_ic as number, 9);
    expect(corrected.overlap_factor).toBeCloseTo(6.0, 6);
    expect(corrected.n_effective as number).toBeCloseTo(8 / 6, 6);
    expect(Math.abs(corrected.t_stat as number)).toBeLessThan(
      Math.abs(uncorrected.t_stat as number),
    );
    expect(corrected.t_stat as number).toBeCloseTo(0.62361, 4);
  });

  it('is a straight sample-stdev/raw-n t-stat when overlapCorrection is off (q reported as 1)', () => {
    const records = [
      ...twoSymbolPeriod('2024-01-01T00:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T01:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T16:30:00+07:00', false),
    ];
    const result = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: false,
    });
    expect(result.overlap_factor).toBe(1); // "the q you used" -- 1 when the correction is disabled
    expect(result.n_effective).toBe(3); // == n_periods, unadjusted
    // Sample-stdev fix still applies even with the overlap correction off: (1/3)/(1.1547/sqrt(3)) = 0.5
    expect(result.t_stat as number).toBeCloseTo(0.5, 4);
  });

  it('defaults to overlapCorrection=true, forwardReturnHours=24 when no options are passed', () => {
    const records = [
      ...twoSymbolPeriod('2024-01-01T00:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T04:00:00+07:00', true),
      ...twoSymbolPeriod('2024-01-01T08:00:00+07:00', false),
    ];
    const withDefaults = crossSectionalIc(records, FACTOR, 2);
    const explicit = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    expect(withDefaults).toEqual(explicit);
  });

  it('returns null n_effective/overlap_factor/t_stat when fewer than 2 periods qualify', () => {
    const records = twoSymbolPeriod('2024-01-01T00:00:00+07:00', true);
    const result = crossSectionalIc(records, FACTOR, 2, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    expect(result.n_periods).toBe(1);
    expect(result.t_stat).toBeNull();
    expect(result.n_effective).toBeNull();
    expect(result.overlap_factor).toBeNull();
  });
});

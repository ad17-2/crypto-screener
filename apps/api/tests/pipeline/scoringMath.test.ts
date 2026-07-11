import { describe, expect, it } from 'vitest';
import {
  copysign,
  median,
  pyRound,
  robustZscoreByKey,
  spearmanCorr,
  zscoreByKey,
} from '../../src/pipeline/scoring.js';

describe('median', () => {
  it('returns 0 for an empty list', () => {
    expect(median([])).toBe(0.0);
  });

  it('averages the two middle values for an even-length list', () => {
    expect(median([1, 3, 2, 4])).toBe(2.5);
  });
});

describe('zscoreByKey', () => {
  it('sums to ~0 and preserves ordering', () => {
    const rows = [{ value: 10 }, { value: 20 }, { value: 30 }];
    const zscores = zscoreByKey(rows, 'value');
    expect(zscores.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.0, 7);
    expect(zscores[0] as number).toBeLessThan(zscores[1] as number);
    expect(zscores[1] as number).toBeLessThan(zscores[2] as number);
  });
});

describe('robustZscoreByKey', () => {
  it('compares plain and robust zscore spread with a single outlier', () => {
    const rows = [{ value: 1.0 }, { value: 2.0 }, { value: 3.0 }, { value: 100.0 }];
    const plain = zscoreByKey(rows, 'value');
    const robust = robustZscoreByKey(rows, 'value');
    const plainSpread = (plain[2] as number) - (plain[0] as number);
    const robustSpread = (robust[2] as number) - (robust[0] as number);
    expect(Math.abs(plainSpread)).toBeLessThan(Math.abs(robustSpread));
  });
});

describe('spearmanCorr', () => {
  it('returns +/-1 for perfectly monotonic sequences', () => {
    expect(spearmanCorr([1, 2, 3], [10, 20, 30])).toBeCloseTo(1.0, 9);
    expect(spearmanCorr([1, 2, 3], [30, 20, 10])).toBeCloseTo(-1.0, 9);
  });
});

describe('pyRound', () => {
  it('rounds to the requested number of decimal digits', () => {
    expect(pyRound(1.23456, 4)).toBe(1.2346);
    expect(pyRound(1.005, 2)).toBe(1.0); // 1.005 is not exactly representable (~1.00499999...)
    expect(pyRound(-2.5, 0)).toBe(-2); // matches Python's round(-2.5) == -2 (round-half-to-even)
  });

  it('passes NaN/Infinity through unchanged', () => {
    expect(pyRound(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(pyRound(Number.NaN, 2))).toBe(true);
  });
});

describe('copysign', () => {
  it('carries the sign of the second argument, including a signed zero', () => {
    expect(copysign(5, -1)).toBe(-5);
    expect(copysign(-5, 1)).toBe(5);
    expect(Object.is(copysign(5, -0), -5)).toBe(true);
    expect(Object.is(copysign(5, 0), 5)).toBe(true);
  });
});

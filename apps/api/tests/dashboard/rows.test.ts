import { describe, expect, it } from 'vitest';
import {
  fightsBtcOrNull,
  oiPriceQuadrant,
  positioningDivergenceRatio,
} from '../../src/dashboard/rows.js';

describe('oiPriceQuadrant', () => {
  it('reads price up + OI up as new_longs', () => {
    expect(oiPriceQuadrant(5.0, 3.0)).toBe('new_longs');
  });

  it('reads price up + OI down as short_covering', () => {
    expect(oiPriceQuadrant(5.0, -3.0)).toBe('short_covering');
  });

  it('reads price down + OI up as new_shorts', () => {
    expect(oiPriceQuadrant(-5.0, 3.0)).toBe('new_shorts');
  });

  it('reads price down + OI down as long_liquidation', () => {
    expect(oiPriceQuadrant(-5.0, -3.0)).toBe('long_liquidation');
  });

  it('returns null when price change is inside the dead-zone (|p| < 0.5)', () => {
    expect(oiPriceQuadrant(0.4, 3.0)).toBeNull();
    expect(oiPriceQuadrant(-0.4, -3.0)).toBeNull();
  });

  it('returns null when OI change is inside the dead-zone (|oi| < 1.0)', () => {
    expect(oiPriceQuadrant(5.0, 0.9)).toBeNull();
    expect(oiPriceQuadrant(-5.0, -0.9)).toBeNull();
  });

  it('returns null when price change is null', () => {
    expect(oiPriceQuadrant(null, 3.0)).toBeNull();
  });

  it('returns null when OI change is null', () => {
    expect(oiPriceQuadrant(5.0, null)).toBeNull();
  });

  it('returns null when both inputs are null', () => {
    expect(oiPriceQuadrant(null, null)).toBeNull();
  });
});

describe('fightsBtcOrNull', () => {
  it('passes through "long"', () => {
    expect(fightsBtcOrNull('long')).toBe('long');
  });

  it('passes through "short"', () => {
    expect(fightsBtcOrNull('short')).toBe('short');
  });

  it('returns null for garbage values', () => {
    expect(fightsBtcOrNull('sideways')).toBeNull();
  });

  it('returns null when absent', () => {
    expect(fightsBtcOrNull(null)).toBeNull();
    expect(fightsBtcOrNull(undefined)).toBeNull();
  });
});

describe('positioningDivergenceRatio', () => {
  it('divides top-trader ratio by the crowd ratio', () => {
    expect(positioningDivergenceRatio(1.5, 3.0)).toBe(2.0);
  });

  it('handles top-trader positioning below the crowd', () => {
    expect(positioningDivergenceRatio(2.0, 1.0)).toBe(0.5);
  });

  it('returns null when the crowd ratio is missing', () => {
    expect(positioningDivergenceRatio(null, 1.0)).toBeNull();
  });

  it('returns null when the top-trader ratio is missing', () => {
    expect(positioningDivergenceRatio(1.0, null)).toBeNull();
  });

  it('returns null when the crowd ratio is zero', () => {
    expect(positioningDivergenceRatio(0, 1.0)).toBeNull();
  });

  it('returns null when the crowd ratio is negative', () => {
    expect(positioningDivergenceRatio(-1, 1.0)).toBeNull();
  });
});

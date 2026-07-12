import { describe, expect, it } from 'vitest';
import type { FactorRecord } from '../../src/pipeline/ic.js';
import type { PipelineConfig } from '../../src/pipeline/types.js';
import { directionalValidation, validationMetrics } from '../../src/pipeline/validation.js';

describe('directionalValidation', () => {
  it('counts a hit as sign(signal) * forward_return_pct > 0, in both directions', () => {
    // Hand-computed: (2,3) positive*positive -> hit; (-2,-3) negative*negative -> hit;
    // (2,-3) positive*negative -> miss; (-2,3) negative*positive -> miss. 2 hits / 4.
    const pairs: Array<[number, number]> = [
      [2, 3],
      [-2, -3],
      [2, -3],
      [-2, 3],
    ];
    const result = directionalValidation(pairs);
    expect(result.observations).toBe(4);
    expect(result.hit_rate).toBeCloseTo(50.0);
    expect(result.avg_forward_return_pct).toBeCloseTo(0); // (3 - 3 - 3 + 3) / 4 = 0
    // sign(signal)*forward: (1)(3) + (1)(-3) + (-1)(-3) + (-1)(3) = 3 - 3 + 3 - 3 = 0 -> 0 / 4 = 0
    expect(result.avg_directional_return_pct).toBeCloseTo(0);
  });

  it('excludes pairs whose signal is exactly 0 (validation.ts:235 documented exclusion)', () => {
    const pairs: Array<[number, number]> = [
      [1, 5],
      [0, 100], // excluded despite a large forward return
      [-1, -5],
    ];
    const result = directionalValidation(pairs);
    expect(result.observations).toBe(2);
    expect(result.hit_rate).toBeCloseTo(100.0); // both remaining pairs are hits
    // sign(1)*5 + sign(-1)*-5 = 5 + 5 = 10 -> 10 / 2 = 5
    expect(result.avg_directional_return_pct).toBeCloseTo(5.0);
  });

  it('excludes null signal/forward entries and returns nulls when nothing remains', () => {
    const pairs: ReadonlyArray<readonly [number | null, number | null]> = [
      [null, 5],
      [1, null],
    ];
    expect(directionalValidation(pairs)).toEqual({
      observations: 0,
      hit_rate: null,
      avg_forward_return_pct: null,
      avg_directional_return_pct: null,
    });
  });

  it('takes the gross directional return, not the raw market drift (mixed longs/shorts, mostly wrong)', () => {
    const pairs: Array<[number, number]> = [
      [1, -10], // long into a -10% drop -> loses 10
      [1, -4], // long into a -4% drop -> loses 4
      [-1, -6], // short into a -6% drop -> gains 6
    ];
    const result = directionalValidation(pairs);
    expect(result.avg_forward_return_pct).toBeCloseTo((-10 - 4 - 6) / 3); // -6.667: raw market drift
    expect(result.avg_directional_return_pct).toBeCloseTo((-10 - 4 + 6) / 3); // -2.667: actual model P&L
  });
});

describe('validationMetrics', () => {
  const config: PipelineConfig = { factors: { forward_return_hours: 24, min_observations: 1 } };

  function record(
    symbol: string,
    forwardReturnPct: number,
    factorScore: number,
    factors: Record<string, unknown> = {},
  ): FactorRecord {
    return {
      symbol,
      generated_at: '2026-01-01T00:00:00+07:00',
      forward_return_pct: forwardReturnPct,
      factors,
      scores: { factor_score: factorScore },
    };
  }

  it('scores the ensemble (scores.factor_score) against realised returns, excluding factor_score === 0', () => {
    // Hand-computed against sign(factor_score) * forward_return_pct > 0:
    //   A: sign(2)*5   = 10  > 0 -> hit
    //   B: sign(-1)*-3 =  3  > 0 -> hit
    //   C: sign(4)*-2  = -8  < 0 -> miss
    //   D: factor_score === 0 -> excluded from the model pairs entirely
    const records: FactorRecord[] = [
      record('A', 5, 2),
      record('B', -3, -1),
      record('C', -2, 4),
      record('D', 0, 0),
    ];

    const result = validationMetrics(records, config);

    expect(result.status).toBe('ok');
    expect(result.observations).toBe(4); // top-level: all 4 records have a non-null forward_return_pct
    expect(result.model.observations).toBe(3); // D dropped by the factor_score === 0 exclusion
    expect(result.model.hit_rate).toBeCloseTo(66.67); // 2 hits / 3
    expect(result.model.avg_forward_return_pct).toBeCloseTo(0); // (5 - 3 - 2) / 3 = 0
    // sign(2)*5 + sign(-1)*-3 + sign(4)*-2 = 5 + 3 - 2 = 6 -> 6 / 3 = 2
    expect(result.model.avg_directional_return_pct).toBeCloseTo(2.0);
    // long = positive-signal pairs (A, C): C misses -> 1/2 = 50; short = negative-signal pairs (B): 1/1 = 100.
    expect(result.model.long_observations).toBe(2);
    expect(result.model.long_hit_rate).toBeCloseTo(50.0);
    expect(result.model.short_observations).toBe(1);
    expect(result.model.short_hit_rate).toBeCloseTo(100.0);
  });

  it('degrades cleanly with no crash when records carry no scores at all (the parity fixture case)', () => {
    // No `scores` field on either record, matching the parity fixture's history before ensemble scores existed.
    const records: FactorRecord[] = [
      {
        symbol: 'A',
        generated_at: '2026-01-01T00:00:00+07:00',
        forward_return_pct: 5,
        factors: {},
      },
      {
        symbol: 'B',
        generated_at: '2026-01-01T00:00:00+07:00',
        forward_return_pct: -3,
        factors: {},
      },
    ];

    const result = validationMetrics(records, config);

    expect(result.observations).toBe(2);
    expect(result.model).toEqual({
      observations: 0,
      hit_rate: null,
      avg_forward_return_pct: null,
      avg_directional_return_pct: null,
    });
  });

  it('validates a directional factor alongside the model block', () => {
    // momentum_24h hand-computed the same way as the model block above:
    //   A: sign(1)*5   =  5 > 0 -> hit
    //   B: sign(-1)*-3 =  3 > 0 -> hit
    //   C: sign(1)*-2  = -2 < 0 -> miss
    const records: FactorRecord[] = [
      record('A', 5, 2, { momentum_24h: 1 }),
      record('B', -3, -1, { momentum_24h: -1 }),
      record('C', -2, 4, { momentum_24h: 1 }),
    ];

    const result = validationMetrics(records, config);

    expect(result.factors.momentum_24h?.observations).toBe(3);
    expect(result.factors.momentum_24h?.hit_rate).toBeCloseTo(66.67);
    // reversal_3d is never present in `factors`, so every pair is excluded (null signal) -- it
    // still comes back as a well-formed zero result, not an absent key.
    expect(result.factors.reversal_3d).toEqual({
      observations: 0,
      hit_rate: null,
      avg_forward_return_pct: null,
      avg_directional_return_pct: null,
    });
    // The per-factor block runs independently of the model block, which is still populated.
    expect(result.model.observations).toBe(3);
  });

  it('returns insufficient status with an empty model/factors block when no record has a forward_return_pct', () => {
    const records: FactorRecord[] = [
      {
        symbol: 'A',
        generated_at: '2026-01-01T00:00:00+07:00',
        forward_return_pct: null,
        factors: {},
        scores: { factor_score: 1 },
      },
    ];

    expect(validationMetrics(records, config)).toEqual({
      status: 'insufficient',
      horizon_hours: 24,
      observations: 0,
      model: {},
      factors: {},
      economic_edge: {},
    });
  });
});

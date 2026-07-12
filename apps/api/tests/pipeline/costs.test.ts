import { describe, expect, it } from 'vitest';
import { roundTripCostPct } from '../../src/pipeline/costs.js';

const DEFAULTS = {}; // roundTripCostPct falls back to config/schema.ts's CostsConfigSchema defaults: 5/2/2/3.

describe('roundTripCostPct', () => {
  it('long side, positive funding: fee+slippage+spread+funding all charged as cost', () => {
    // trading = 2*(5+2)/100 = 0.14; spread (assumed) = 2/100 = 0.02;
    // settlements = 3*(24/24) = 3; funding = +1 * 0.01 * 3 = 0.03. Total 0.19.
    const cost = roundTripCostPct(
      { funding_rate_pct: 0.01 },
      DEFAULTS,
      24,
      0.5, // directionalScore > 0 -> long
    );
    expect(cost).toBeCloseTo(0.19, 9);
  });

  it('short side, positive funding: funding is received, not paid -- reduces total cost', () => {
    // Same inputs as above but directionalScore < 0: funding = -1 * 0.01 * 3 = -0.03.
    // trading 0.14 + spread 0.02 - 0.03 = 0.13.
    const cost = roundTripCostPct({ funding_rate_pct: 0.01 }, DEFAULTS, 24, -0.5);
    expect(cost).toBeCloseTo(0.13, 9);
  });

  it('honors custom config and a horizon shorter than 24h', () => {
    // trading = 2*(10+5)/100 = 0.30; spread (assumed) = 3/100 = 0.03;
    // settlements = 1*(12/24) = 0.5; funding = +1 * 0.02 * 0.5 = 0.01. Total 0.34.
    const cost = roundTripCostPct(
      { funding_rate_pct: 0.02 },
      {
        taker_fee_bps: 10,
        slippage_bps: 5,
        assumed_spread_bps: 3,
        funding_settlements_per_day: 1,
      },
      12,
      1.0,
    );
    expect(cost).toBeCloseTo(0.34, 9);
  });

  it('null funding_rate_pct contributes zero funding cost, not a default rate', () => {
    // trading + spread only = 0.14 + 0.02 = 0.16.
    const cost = roundTripCostPct({ funding_rate_pct: null }, DEFAULTS, 24, 0.5);
    expect(cost).toBeCloseTo(0.16, 9);

    const costUndefined = roundTripCostPct({}, DEFAULTS, 24, 0.5);
    expect(costUndefined).toBeCloseTo(0.16, 9);
  });

  it('null spread_bps falls back to assumed_spread_bps', () => {
    const cost = roundTripCostPct({ spread_bps: null }, DEFAULTS, 24, 0);
    // trading = 0.14, spread (assumed) = 0.02, no funding -> 0.16.
    expect(cost).toBeCloseTo(0.16, 9);
  });

  it('prefers a real spread_bps over the assumed value when a provider ever populates it', () => {
    // trading = 0.14, spread (real, 10bps) = 0.10 -> 0.24, not the assumed-2bps 0.16.
    const cost = roundTripCostPct({ spread_bps: 10 }, DEFAULTS, 24, 0);
    expect(cost).toBeCloseTo(0.24, 9);
  });

  it('directionalScore of 0 (no side) falls back to the unsigned funding magnitude', () => {
    // No side to attribute funding to -- charges |funding| rather than crediting it.
    // trading + spread + |−0.02| * 3 = 0.14 + 0.02 + 0.06 = 0.22.
    const cost = roundTripCostPct({ funding_rate_pct: -0.02 }, DEFAULTS, 24, 0);
    expect(cost).toBeCloseTo(0.22, 9);
  });
});

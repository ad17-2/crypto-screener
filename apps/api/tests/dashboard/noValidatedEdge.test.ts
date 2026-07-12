import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config';
import { isLongCandidate, isShortCandidate } from '../../src/dashboard/watchlists';
import { applyScores } from '../../src/pipeline/rowScoring';

// With no forward-validated factor every weight is 0, so factor_score is 0 for EVERY coin. The
// screen must still populate: it ranks on observations, not on the model's (absent) opinion.
describe('the screen survives a model with no validated edge', () => {
  const config = AppConfigSchema.parse({});
  const zeroWeights = Object.fromEntries(
    ['momentum_24h', 'reversal_3d', 'technical_trend_4h'].map((f) => [f, 0]),
  );

  const row = (symbol: string, priceChange: number, oiChange: number) => ({
    symbol,
    price_change_24h_pct: priceChange,
    oi_change_24h_pct: oiChange,
    quote_volume_usd: 500_000_000,
    funding_rate_pct: 0.001,
    long_short_ratio: 1.0,
    atr_14_pct: 3,
    is_trusted: true,
    factors: { momentum_24h: priceChange, reversal_3d: 0, technical_trend_4h: 0 },
  });

  it('yields factor_score 0 yet still ranks and classifies by observable facts', () => {
    const up = row('UP', 8, 10);
    const down = row('DOWN', -6, 4);
    for (const r of [up, down]) {
      applyScores(
        r as never,
        r.factors as never,
        zeroWeights as never,
        {} as never,
        { median_atr_pct: 3 } as never,
        config as never,
      );
    }
    const s = (r: Record<string, unknown>) => r.scores as Record<string, number>;

    expect(s(up).factor_score).toBe(0);
    expect(s(down).factor_score).toBe(0);

    // The screen still separates them, and still ranks the mover above the laggard.
    expect(isLongCandidate(up as never)).toBe(true);
    expect(isShortCandidate(up as never)).toBe(false);
    expect(isShortCandidate(down as never)).toBe(true);
    expect(s(up).long_score).toBeGreaterThan(0);
    expect(s(down).short_score).toBeGreaterThan(0);
    expect(s(up).long_score).toBeGreaterThan(s(down).long_score);
  });
});

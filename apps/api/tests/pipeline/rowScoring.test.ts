import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyExcludedScores,
  applyScores,
  SCORING_PIPELINE_VERSION,
} from '../../src/pipeline/rowScoring.js';
import type { MarketContext, PipelineConfig, Row } from '../../src/pipeline/types.js';

// factors.liquidity_30d = 0 -> qualityPercentile(0) = 50, a fixed +12.5 contribution to both
// long_score and short_score (liquidityQuality * 0.25) across every case below, so it cancels out
// of every same-row comparison and is folded into the hand-computed totals where asserted exactly.
const NEUTRAL_FACTORS: Record<string, number> = { liquidity_30d: 0 };
const NO_CONFIG: PipelineConfig = {};

function score(row: Row, marketContext: MarketContext = {}): Row {
  applyScores(row, NEUTRAL_FACTORS, marketContext, NO_CONFIG);
  return row;
}

describe('applyScores', () => {
  it('reproduces the legacy formula exactly for a data-poor row (test_legacy_equivalence)', () => {
    // beta/atr/rho/p3d/liqImb all absent -> resid=p, scale=10, veto=0, stretch=0, lateness=0:
    // the new formula collapses to the pre-Slice-B formula bit for bit.
    const row: Row = {
      symbol: 'LEGACY',
      price_change_24h_pct: 6,
      oi_change_24h_pct: 8,
      funding_rate_pct: 0.01,
    };
    score(row);
    // longCrowding = clamp(0.01/0.08) = 0.125; shortCrowding = 0.
    // longMomentum = clamp(6/10) = 0.6; oiTermLong = oiTermShort = clamp(8/12)*15 = 10.0.
    // long = 0.6*20 + 10 + 50*0.25 - 0.125*10 = 12 + 10 + 12.5 - 1.25 = 33.25
    // short = 0*20 + 10 + 12.5 - 0 = 22.5
    expect(row.long_score).toBeCloseTo(33.25, 9);
    expect(row.short_score).toBeCloseTo(22.5, 9);
    expect(row.residual_change_24h_pct).toBeUndefined();
    expect(row.fights_btc).toBeNull();
    // C1/C2/C3 inputs (breakout_pct_20, breakdown_pct_20, cvd_trend_72h_pct,
    // oi_change_72h_pct_history) are all absent from this row too -> all three new terms inert.
    expect(row.cvd_absorption_state).toBeUndefined();
    expect(row.oi_price_trend_state).toBeUndefined();
  });

  it('suppresses short momentum once the BTC-implied move is stripped out (test_beta_drop_short_suppressed)', () => {
    const base: Row = {
      symbol: 'ALT',
      price_change_24h_pct: -5,
      oi_change_24h_pct: 0,
      funding_rate_pct: 0.01,
      btc_beta: 1.2,
    };
    // resid = -5 - 1.2*(-4.5) = +0.4 -> shortMom clamps to 0.
    const withBtcDrop = score({ ...base }, { btc_change_24h_pct: -4.5 });
    // resid = -5 - 1.2*0 = -5 -> shortMom = clamp(5/10) = 0.5.
    const withoutBtcDrop = score({ ...base }, { btc_change_24h_pct: 0 });
    expect(withBtcDrop.residual_change_24h_pct).toBeCloseTo(0.4, 9);
    expect(withoutBtcDrop.residual_change_24h_pct).toBeCloseTo(-5.0, 9);
    expect(withBtcDrop.short_score as number).toBeLessThan(withoutBtcDrop.short_score as number);
    // 0.5 * 20 = 10.0 momentum-term gap between the two cases.
    expect(
      (withoutBtcDrop.short_score as number) - (withBtcDrop.short_score as number),
    ).toBeCloseTo(10, 9);
  });

  describe('fights-BTC veto', () => {
    function decliningCoin(rho: number): Row {
      return {
        symbol: 'DECLINER',
        price_change_24h_pct: -5,
        oi_change_24h_pct: 0,
        funding_rate_pct: 0.01,
        btc_correlation: rho,
      };
    }

    it('penalizes shorting a coin correlated to a live BTC rally (test_veto_short_applied)', () => {
      const context: MarketContext = { btc_change_24h_pct: 3, btc_momentum_score: 1 };
      const highRho = score(decliningCoin(0.9), context);
      const lowRho = score(decliningCoin(0.2), context);
      expect(highRho.fights_btc).toBe('short');
      expect(lowRho.fights_btc).toBeNull();
      // vetoShort = clamp((0.9-0.5)/0.4) * clamp(3/3) * 18 = 1 * 1 * 18 = 18.
      expect((lowRho.short_score as number) - (highRho.short_score as number)).toBeCloseTo(18, 9);
    });

    it('does not veto when BTC momentum is rolling over even with a strong 24h print (test_veto_needs_btc_momentum_confirmation)', () => {
      const rollingOver = score(decliningCoin(0.9), {
        btc_change_24h_pct: 3,
        btc_momentum_score: -1,
      });
      const noBtcMove = score(decliningCoin(0.2), { btc_change_24h_pct: 3, btc_momentum_score: 1 });
      expect(rollingOver.fights_btc).toBeNull();
      // No veto fired, so both land on the same unvetoed short_score.
      expect(rollingOver.short_score).toBeCloseTo(noBtcMove.short_score as number, 9);
    });

    it('flags the long side when BTC is dropping into a correlated rally attempt (test_veto_long_flag)', () => {
      const risingCoin: Row = {
        symbol: 'RISER',
        price_change_24h_pct: 5,
        oi_change_24h_pct: 0,
        funding_rate_pct: 0.01,
        btc_correlation: 0.9,
      };
      const vetoed = score({ ...risingCoin }, { btc_change_24h_pct: -3, btc_momentum_score: -1 });
      expect(vetoed.fights_btc).toBe('long');
    });
  });

  it('applies a heavier drag on shorts when OI falls (washout) than when it confirms new shorts (test_washout_drag)', () => {
    const base = { symbol: 'DROP', price_change_24h_pct: -6, funding_rate_pct: 0.01 };
    const washout = score({ ...base, oi_change_24h_pct: -8 });
    const confirmation = score({ ...base, oi_change_24h_pct: 8 });
    expect(washout.short_score as number).toBeLessThan(confirmation.short_score as number);
  });

  it('penalizes a short already stretched on the 3d move (test_stretch_penalty)', () => {
    const base: Row = {
      symbol: 'STRETCHED',
      price_change_24h_pct: -5,
      oi_change_24h_pct: 0,
      funding_rate_pct: 0.01,
      atr_14_pct: 2, // scale = clamp(5*2, 4, 25) = 10
    };
    const stretched = score({ ...base, price_change_72h_pct: -40 });
    const unstretched = score({ ...base });
    // stretchShort = clamp(40/(3*10) - 1) * 10 = clamp(4/3 - 1) * 10 = clamp(1/3) * 10 = 3.3333...
    // Both scores are independently pyRound(_, 2)'d, so only 2-decimal precision survives the diff.
    expect((unstretched.short_score as number) - (stretched.short_score as number)).toBeCloseTo(
      10 / 3,
      2,
    );
  });

  it('penalizes entering a short after the liquidation flush already happened (test_lateness_penalty)', () => {
    const base: Row = {
      symbol: 'LATE',
      price_change_24h_pct: -5,
      oi_change_24h_pct: 0,
      funding_rate_pct: 0.01,
    };
    const late = score({ ...base, liquidation_imbalance_24h_pct: -80 });
    const onTime = score({ ...base });
    // lateShort = clamp((80-40)/40) * 6 = clamp(1) * 6 = 6.
    expect((onTime.short_score as number) - (late.short_score as number)).toBeCloseTo(6, 9);
  });

  describe('Donchian breakout boost (test_donchian_boost)', () => {
    // price/oi/funding all neutral -> longScore/shortScore baseline is exactly liquidityQuality*0.25
    // = 12.5, with atr_14_pct=5 so momentumScale is fixed regardless (momentum terms are 0 either
    // way since priceChange=0), isolating the boost term cleanly.
    function neutralRow(overrides: Partial<Row> = {}): Row {
      return {
        symbol: 'BRK',
        price_change_24h_pct: 0,
        oi_change_24h_pct: 0,
        funding_rate_pct: 0,
        atr_14_pct: 5,
        ...overrides,
      };
    }

    it('boosts long_score in proportion to breakout/ATR, capped at 8', () => {
      const base = score(neutralRow());
      const partial = score(neutralRow({ breakout_pct_20: 2.5 })); // ratio 0.5 -> boost 4
      const capped = score(neutralRow({ breakout_pct_20: 15 })); // ratio 3 -> clamp 1 -> boost 8
      expect((partial.long_score as number) - (base.long_score as number)).toBeCloseTo(4, 9);
      expect((capped.long_score as number) - (base.long_score as number)).toBeCloseTo(8, 9);
    });

    it('boosts short_score from breakdown_pct_20 the same way', () => {
      const base = score(neutralRow());
      const partial = score(neutralRow({ breakdown_pct_20: 2.5 })); // ratio 0.5 -> boost 4
      expect((partial.short_score as number) - (base.short_score as number)).toBeCloseTo(4, 9);
    });

    it('is inert when breakout/breakdown are zero or negative', () => {
      const base = score(neutralRow());
      const zero = score(neutralRow({ breakout_pct_20: 0, breakdown_pct_20: 0 }));
      const negative = score(neutralRow({ breakout_pct_20: -3, breakdown_pct_20: -3 }));
      expect(zero.long_score).toBeCloseTo(base.long_score as number, 9);
      expect(zero.short_score).toBeCloseTo(base.short_score as number, 9);
      expect(negative.long_score).toBeCloseTo(base.long_score as number, 9);
      expect(negative.short_score).toBeCloseTo(base.short_score as number, 9);
    });

    it('is inert when atr_14_pct is missing, even with a breakout present', () => {
      // priceChange=0 makes momentum 0 regardless of momentumScale's fallback-to-10, so the two
      // rows below are only distinguished by the (inert) boost term.
      const noAtrNoBreakout: Row = {
        symbol: 'NOATR',
        price_change_24h_pct: 0,
        oi_change_24h_pct: 0,
        funding_rate_pct: 0,
      };
      const noAtrWithBreakout: Row = {
        ...noAtrNoBreakout,
        breakout_pct_20: 10,
        breakdown_pct_20: 10,
      };
      const base = score(noAtrNoBreakout);
      const withBreakout = score(noAtrWithBreakout);
      expect(withBreakout.long_score).toBeCloseTo(base.long_score as number, 9);
      expect(withBreakout.short_score).toBeCloseTo(base.short_score as number, 9);
    });
  });

  describe('CVD absorption veto (test_cvd_absorption_veto)', () => {
    // Same neutral baseline trick as the Donchian tests: price/oi/funding at 0 pins
    // longScore/shortScore to exactly 12.5 absent the new terms, and price_change_72h_pct's
    // magnitude here (well under 3*momentumScale=30) keeps stretchLong/stretchShort at 0 too.
    function neutralRow(overrides: Partial<Row> = {}): Row {
      return {
        symbol: 'CVD',
        price_change_24h_pct: 0,
        oi_change_24h_pct: 0,
        funding_rate_pct: 0,
        ...overrides,
      };
    }

    it('fires absorption_bearish and vetoes long_score in proportion, capped at 12', () => {
      const partial = score(neutralRow({ price_change_72h_pct: 2, cvd_trend_72h_pct: -6 }));
      const capped = score(neutralRow({ price_change_72h_pct: 2, cvd_trend_72h_pct: -20 }));
      // vetoCvdLong = clamp((6-5)/10) * 12 = 1.2
      expect(partial.cvd_absorption_state).toBe('absorption_bearish');
      expect(12.5 - (partial.long_score as number)).toBeCloseTo(1.2, 9);
      expect(partial.short_score).toBeCloseTo(12.5, 9);
      // vetoCvdLong = clamp((20-5)/10) * 12 = clamp(1.5) * 12 = 12 (capped)
      expect(12.5 - (capped.long_score as number)).toBeCloseTo(12, 9);
    });

    it('fires absorption_bullish and vetoes short_score in proportion', () => {
      const row = score(neutralRow({ price_change_72h_pct: -2, cvd_trend_72h_pct: 6 }));
      // vetoCvdShort = clamp((6-5)/10) * 12 = 1.2
      expect(row.cvd_absorption_state).toBe('absorption_bullish');
      expect(12.5 - (row.short_score as number)).toBeCloseTo(1.2, 9);
      expect(row.long_score).toBeCloseTo(12.5, 9);
    });

    it('flags confirmation states with no score effect (display-only)', () => {
      const confirmedLong = score(neutralRow({ price_change_72h_pct: 2, cvd_trend_72h_pct: 6 }));
      const confirmedShort = score(neutralRow({ price_change_72h_pct: -2, cvd_trend_72h_pct: -6 }));
      expect(confirmedLong.cvd_absorption_state).toBe('confirmation_long');
      expect(confirmedLong.long_score).toBeCloseTo(12.5, 9);
      expect(confirmedLong.short_score).toBeCloseTo(12.5, 9);
      expect(confirmedShort.cvd_absorption_state).toBe('confirmation_short');
      expect(confirmedShort.long_score).toBeCloseTo(12.5, 9);
      expect(confirmedShort.short_score).toBeCloseTo(12.5, 9);
    });

    it('is inert (state null, no veto) when the 3d move sits inside the 1.5% dead-zone', () => {
      const row = score(neutralRow({ price_change_72h_pct: 1, cvd_trend_72h_pct: -10 }));
      expect(row.cvd_absorption_state).toBeNull();
      expect(row.long_score).toBeCloseTo(12.5, 9);
      expect(row.short_score).toBeCloseTo(12.5, 9);
    });

    it('leaves the state unset (not null) and vetoes at 0 when either input is missing', () => {
      const missingCvd = score(neutralRow({ price_change_72h_pct: 2 }));
      const missingPrice = score(neutralRow({ cvd_trend_72h_pct: -10 }));
      expect(missingCvd.cvd_absorption_state).toBeUndefined();
      expect(missingCvd.long_score).toBeCloseTo(12.5, 9);
      expect(missingPrice.cvd_absorption_state).toBeUndefined();
      expect(missingPrice.long_score).toBeCloseTo(12.5, 9);
    });
  });

  describe('OI-trend divergence veto (test_oi_trend_veto)', () => {
    // price_change_24h_pct is shared between the two compared rows in each case below (it feeds
    // both longMomentum/shortMomentum and the divergence predicate), so diffing isolates the veto.
    function rowWith(priceChange24h: number, oi72h: number | undefined): Row {
      const row: Row = {
        symbol: 'OIDIV',
        price_change_24h_pct: priceChange24h,
        oi_change_24h_pct: 0,
        funding_rate_pct: 0,
      };
      if (oi72h !== undefined) {
        row.oi_change_72h_pct_history = oi72h;
      }
      return row;
    }

    it('fires diverging_long and vetoes long_score in proportion, capped at 10', () => {
      const inert = score(rowWith(1, -1)); // above the -3.0 dead-zone -> no divergence
      const partial = score(rowWith(1, -5));
      const capped = score(rowWith(1, -20));
      expect(inert.oi_price_trend_state).toBeNull();
      expect(partial.oi_price_trend_state).toBe('diverging_long');
      // vetoOiLong = clamp((5-3)/6) * 10 = 10/3 = 3.333...; both scores are independently
      // pyRound(_, 2)'d, so only 2-decimal precision survives the diff (same as test_stretch_penalty).
      expect((inert.long_score as number) - (partial.long_score as number)).toBeCloseTo(10 / 3, 2);
      // vetoOiLong = clamp((20-3)/6) * 10 = clamp(2.83) * 10 = 10 (capped)
      expect((inert.long_score as number) - (capped.long_score as number)).toBeCloseTo(10, 9);
    });

    it('fires diverging_short and vetoes short_score in proportion', () => {
      const inert = score(rowWith(-1, 1)); // below the +3.0 dead-zone -> no divergence
      const partial = score(rowWith(-1, 5));
      expect(partial.oi_price_trend_state).toBe('diverging_short');
      // vetoOiShort = clamp((5-3)/6) * 10 = 10/3; 2-decimal precision only, per above.
      expect((inert.short_score as number) - (partial.short_score as number)).toBeCloseTo(
        10 / 3,
        2,
      );
    });

    it('flags confirmed states with no score effect (display-only)', () => {
      const missing = score(rowWith(1, undefined));
      const confirmedLong = score(rowWith(1, 5));
      const confirmedShort = score(rowWith(-1, -5));
      expect(confirmedLong.oi_price_trend_state).toBe('confirmed_long');
      expect(confirmedLong.long_score).toBeCloseTo(missing.long_score as number, 9);
      expect(confirmedShort.oi_price_trend_state).toBe('confirmed_short');
    });

    it('leaves the state unset (not null) and vetoes at 0 when oi_change_72h_pct_history is missing', () => {
      const row = score(rowWith(1, undefined));
      expect(row.oi_price_trend_state).toBeUndefined();
    });
  });
});

describe('applyExcludedScores', () => {
  it('leaves fights_btc and residual_change_24h_pct unset (test_excluded_scores_leave_new_fields_unset)', () => {
    const row: Row = { symbol: 'EXCLUDED', is_trusted: false };
    applyExcludedScores(row);
    expect(row.long_score).toBe(0);
    expect(row.short_score).toBe(0);
    expect(row.fights_btc).toBeUndefined();
    expect(row.residual_change_24h_pct).toBeUndefined();
    expect(row.cvd_absorption_state).toBeUndefined();
    expect(row.oi_price_trend_state).toBeUndefined();
  });

  it('leaves the new state fields unset even when the underlying inputs are present on the row (applyExcludedScores never runs the term logic)', () => {
    const row: Row = {
      symbol: 'EXCLUDED_WITH_INPUTS',
      is_trusted: false,
      breakout_pct_20: 10,
      breakdown_pct_20: 10,
      cvd_trend_72h_pct: -10,
      price_change_72h_pct: 5,
      oi_change_72h_pct_history: -10,
    };
    applyExcludedScores(row);
    expect(row.long_score).toBe(0);
    expect(row.short_score).toBe(0);
    expect(row.cvd_absorption_state).toBeUndefined();
    expect(row.oi_price_trend_state).toBeUndefined();
  });
});

// Pinned hash of rowScoring.ts's own source text, re-pinned by hand whenever
// SCORING_PIPELINE_VERSION is bumped. This is the forcing function: nobody remembers to bump a
// version constant on their own, so instead the test goes red on ANY edit to this file -- deliberately
// including pure comment/formatting churn that changes no scoring behaviour at all. That
// over-triggering is intentional and correct: a false-positive red test just costs someone a
// one-line hash re-pin, while a false-negative (missing a real formula change) would let a
// rebalance masquerade as market movement in every run-over-run delta and weekly review that
// reads pipeline_version. Over-suppressing a comparison is safe; under-suppressing produces a
// number that looks like evidence and isn't.
const PINNED_SOURCE_SHA256 = 'bc7cd8cd114cb806f1e6bbb92b5fb7232a7dae72d494c5a6ae7f850b9d065c62';

describe('SCORING_PIPELINE_VERSION forcing function', () => {
  it('pins a hash of rowScoring.ts so any edit forces a version bump + re-pin', () => {
    const sourcePath = fileURLToPath(new URL('../../src/pipeline/rowScoring.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const actualHash = createHash('sha256').update(source).digest('hex');

    expect(
      actualHash,
      `rowScoring.ts changed (hash mismatch). If this edit changes scoring behaviour, bump ` +
        `SCORING_PIPELINE_VERSION (currently '${SCORING_PIPELINE_VERSION}') in rowScoring.ts and ` +
        `re-pin PINNED_SOURCE_SHA256 in this test to the new hash: ${actualHash}`,
    ).toBe(PINNED_SOURCE_SHA256);
  });
});

import { describe, expect, it } from 'vitest';
import { applyExcludedScores, applyScores } from '../../src/pipeline/rowScoring.js';
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
    // long = 0.6*45 + 10 + 50*0.25 - 0.125*10 = 27 + 10 + 12.5 - 1.25 = 48.25
    // short = 0*45 + 10 + 12.5 - 0 = 22.5
    expect(row.long_score).toBeCloseTo(48.25, 9);
    expect(row.short_score).toBeCloseTo(22.5, 9);
    expect(row.residual_change_24h_pct).toBeUndefined();
    expect(row.fights_btc).toBeNull();
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
    // 0.5 * 45 = 22.5 momentum-term gap between the two cases.
    expect(
      (withoutBtcDrop.short_score as number) - (withBtcDrop.short_score as number),
    ).toBeCloseTo(22.5, 9);
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
});

describe('applyExcludedScores', () => {
  it('leaves fights_btc and residual_change_24h_pct unset (test_excluded_scores_leave_new_fields_unset)', () => {
    const row: Row = { symbol: 'EXCLUDED', is_trusted: false };
    applyExcludedScores(row);
    expect(row.long_score).toBe(0);
    expect(row.short_score).toBe(0);
    expect(row.fights_btc).toBeUndefined();
    expect(row.residual_change_24h_pct).toBeUndefined();
  });
});

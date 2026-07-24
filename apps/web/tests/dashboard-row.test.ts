import { describe, expect, it } from 'vitest';
import {
  divergenceLine,
  emaCrossLine,
  oiPriceQuadrant,
  positioningDivergence,
  runTrendTone,
  sizeMultiplierChip,
} from '../lib/dashboard-row';

describe('oiPriceQuadrant', () => {
  it('reads price up + OI up as new longs (fresh money)', () => {
    const result = oiPriceQuadrant({ price_change_24h_pct: 3.2, oi_change_24h_pct: 1.5 });
    expect(result).toEqual({ label: 'New longs', tone: 'pos' });
  });

  it('reads price up + OI down as short covering (weak rally)', () => {
    const result = oiPriceQuadrant({ price_change_24h_pct: 3.2, oi_change_24h_pct: -1.5 });
    expect(result).toEqual({ label: 'Short covering', tone: 'warn' });
  });

  it('reads price down + OI up as new shorts (fresh downside)', () => {
    const result = oiPriceQuadrant({ price_change_24h_pct: -3.2, oi_change_24h_pct: 1.5 });
    expect(result).toEqual({ label: 'New shorts', tone: 'neg' });
  });

  it('reads price down + OI down as long liquidation (washout)', () => {
    const result = oiPriceQuadrant({ price_change_24h_pct: -3.2, oi_change_24h_pct: -1.5 });
    expect(result).toEqual({ label: 'Long liquidation', tone: 'warn' });
  });

  it('returns null when price change is missing', () => {
    expect(oiPriceQuadrant({ price_change_24h_pct: null, oi_change_24h_pct: 1.5 })).toBeNull();
  });

  it('returns null when OI change is missing', () => {
    expect(oiPriceQuadrant({ price_change_24h_pct: 3.2, oi_change_24h_pct: null })).toBeNull();
  });
});

// Server-field precedence: a string `oi_price_quadrant` wins over the client-side price/OI-sign
// read above; an explicit `null` passes straight through (the rail renders its own muted "Quiet"
// state for that case, checked directly against `row.oi_price_quadrant`, not through this
// function's return value); `undefined` (old runs, predating the field) falls back to the
// client-side read unchanged -- exercised by every case above, which omits the field entirely.
describe('oiPriceQuadrant server-field precedence', () => {
  it('maps a server oi_price_quadrant string over what the price/OI signs would compute', () => {
    // Signs alone (both negative) would read as "Long liquidation" -- the server string must win.
    const result = oiPriceQuadrant({
      price_change_24h_pct: -3.2,
      oi_change_24h_pct: -1.5,
      oi_price_quadrant: 'new_longs',
    });
    expect(result).toEqual({ label: 'New longs', tone: 'pos' });
  });

  it('maps every server enum value to its label/tone', () => {
    const base = { price_change_24h_pct: null, oi_change_24h_pct: null };
    expect(oiPriceQuadrant({ ...base, oi_price_quadrant: 'short_covering' })).toEqual({
      label: 'Short covering',
      tone: 'warn',
    });
    expect(oiPriceQuadrant({ ...base, oi_price_quadrant: 'new_shorts' })).toEqual({
      label: 'New shorts',
      tone: 'neg',
    });
    expect(oiPriceQuadrant({ ...base, oi_price_quadrant: 'long_liquidation' })).toEqual({
      label: 'Long liquidation',
      tone: 'warn',
    });
  });

  it('returns null for an explicit server null instead of falling back to the price/OI signs', () => {
    // Signs alone (both positive) would read as "New longs" -- the explicit null must win.
    const result = oiPriceQuadrant({
      price_change_24h_pct: 3.2,
      oi_change_24h_pct: 1.5,
      oi_price_quadrant: null,
    });
    expect(result).toBeNull();
  });

  it('falls back to the client-side sign read when oi_price_quadrant is undefined (old runs)', () => {
    const result = oiPriceQuadrant({
      price_change_24h_pct: 3.2,
      oi_change_24h_pct: 1.5,
      oi_price_quadrant: undefined,
    });
    expect(result).toEqual({ label: 'New longs', tone: 'pos' });
  });
});

// WatchlistTable's `positioningDivergenceTone` (apps/web/components/watchlist/WatchlistTable.tsx)
// delegates to this function so its Smart $ column tone stays consistent with the SelectedCoinRail
// badge for the same row. The .tsx module can't be imported into this vitest node surface (JSX
// isn't transformed there), so these cases -- including the two that previously discriminated the
// column's old independently-rethresholded tone from the badge's verdict -- are covered here instead.
describe('positioningDivergence', () => {
  it('reads a moderate retail/top-trader gap as neutral (Mixed), not a divergence', () => {
    // Previously: WatchlistTable's old ratio-based tone (1.2 / 0.9 = 1.333 >= 1.2) returned
    // 'text-up' for this row, contradicting this function's 'neutral' verdict used by the
    // SelectedCoinRail badge (which would show no highlight).
    const result = positioningDivergence({
      long_short_account_ratio: 0.9,
      top_trader_long_short_ratio: 1.2,
    });
    expect(result?.tone).toBe('neutral');
    expect(result?.label).toBe('Mixed');
  });

  it('reads retail long with top-trader not aligned as warn (retail-crowded long)', () => {
    const result = positioningDivergence({
      long_short_account_ratio: 1.3,
      top_trader_long_short_ratio: 0.95,
    });
    expect(result?.tone).toBe('warn');
    expect(result?.label).toBe('Retail long');
  });

  it('reads a retail-crowded short as warn (R▼)', () => {
    const result = positioningDivergence({
      long_short_account_ratio: 0.8,
      top_trader_long_short_ratio: 1.1,
    });
    expect(result?.tone).toBe('warn');
    expect(result?.label).toBe('Retail short');
  });

  it('reads retail and top trader both leaning long as aligned (pos)', () => {
    const result = positioningDivergence({
      long_short_account_ratio: 1.3,
      top_trader_long_short_ratio: 1.4,
    });
    expect(result?.tone).toBe('pos');
    expect(result?.label).toBe('Aligned');
  });

  it('returns null when either ratio is missing (no spurious Aligned/warn verdict)', () => {
    // numeric(null) === 0 would otherwise read as 0/0 and fall through to a verdict, painting a
    // highlight on rows that have no positioning data at all.
    expect(
      positioningDivergence({ long_short_account_ratio: null, top_trader_long_short_ratio: null }),
    ).toBeNull();
    expect(
      positioningDivergence({ long_short_account_ratio: 1.3, top_trader_long_short_ratio: null }),
    ).toBeNull();
    expect(
      positioningDivergence({ long_short_account_ratio: null, top_trader_long_short_ratio: 1.1 }),
    ).toBeNull();
  });
});

// apps/api/src/dashboard/rows.ts FRESH_EMA_CROSS_MAX_BARS gates its own "Fresh EMA20/50 cross"
// reason-part chip the same way (<= 6 bars) -- kept in sync by hand, see this function's own comment.
describe('emaCrossLine', () => {
  it('reads a fresh bullish cross', () => {
    const result = emaCrossLine({ ema_cross_direction: 'bullish', ema_cross_bars_since: 3 });
    expect(result).toEqual({ tone: 'pos', text: 'EMA20/50 bull cross, 3 bars ago' });
  });

  it('reads a fresh bearish cross', () => {
    const result = emaCrossLine({ ema_cross_direction: 'bearish', ema_cross_bars_since: 0 });
    expect(result).toEqual({ tone: 'neg', text: 'EMA20/50 bear cross, 0 bars ago' });
  });

  it('is still fresh exactly at the 6-bar cutoff', () => {
    const result = emaCrossLine({ ema_cross_direction: 'bullish', ema_cross_bars_since: 6 });
    expect(result).toEqual({ tone: 'pos', text: 'EMA20/50 bull cross, 6 bars ago' });
  });

  it('returns null one bar past the cutoff', () => {
    expect(emaCrossLine({ ema_cross_direction: 'bullish', ema_cross_bars_since: 7 })).toBeNull();
  });

  it('returns null when there is no cross in the lookback window', () => {
    expect(emaCrossLine({ ema_cross_direction: null, ema_cross_bars_since: null })).toBeNull();
  });
});

describe('divergenceLine', () => {
  it('formats an active bearish divergence with its strength', () => {
    const result = divergenceLine({
      technical_divergence: 'bearish',
      technical_divergence_strength: 0.723,
    });
    expect(result).toBe('Bearish (0.72)');
  });

  it('formats an active bullish divergence with its strength', () => {
    const result = divergenceLine({
      technical_divergence: 'bullish',
      technical_divergence_strength: 1,
    });
    expect(result).toBe('Bullish (1.00)');
  });

  it('omits the strength suffix when strength is missing', () => {
    const result = divergenceLine({
      technical_divergence: 'bearish',
      technical_divergence_strength: null,
    });
    expect(result).toBe('Bearish');
  });

  it('returns null when there is no active divergence', () => {
    expect(
      divergenceLine({ technical_divergence: null, technical_divergence_strength: null }),
    ).toBeNull();
  });
});

describe('runTrendTone', () => {
  it('maps strengthening/weakening/holding to pos/neg/neutral', () => {
    expect(runTrendTone('strengthening')).toBe('pos');
    expect(runTrendTone('weakening')).toBe('neg');
    expect(runTrendTone('holding')).toBe('neutral');
  });

  it("returns null for 'new' -- new_to_list's own NEW chip already covers that condition", () => {
    expect(runTrendTone('new')).toBeNull();
  });

  it('returns null when run_trend is absent (old payload, non-directional row, or suppressed)', () => {
    expect(runTrendTone(undefined)).toBeNull();
  });
});

describe('sizeMultiplierChip', () => {
  function withSizeMultiplier(sizeMultiplier: number | null, isTrusted = true) {
    return {
      scores: {
        long_score: null,
        short_score: null,
        crowded_long_score: null,
        squeeze_risk_score: null,
        round_trip_cost_pct: null,
        size_multiplier: sizeMultiplier,
      },
      is_trusted: isTrusted,
    };
  }

  it('reads a calm coin (>= 1.5x) as the Low vol chip', () => {
    const chip = sizeMultiplierChip(withSizeMultiplier(1.5));
    expect(chip).toMatchObject({ tone: 'neutral', label: 'Low vol' });
  });

  it('reads a choppy coin (<= 0.667x) as the High vol chip', () => {
    const chip = sizeMultiplierChip(withSizeMultiplier(0.5));
    expect(chip).toMatchObject({ tone: 'warn', label: 'High vol' });
  });

  it('renders no chip for the typical/near-neutral case', () => {
    expect(sizeMultiplierChip(withSizeMultiplier(1.0))).toBeNull();
  });

  it('renders no chip just inside neutral (0.7, above the 0.667 ceiling)', () => {
    expect(sizeMultiplierChip(withSizeMultiplier(0.7))).toBeNull();
  });

  it('renders no chip when size_multiplier is null (no cross-sectional ATR read this run)', () => {
    expect(sizeMultiplierChip(withSizeMultiplier(null))).toBeNull();
  });

  it('never flags an excluded row as High vol even though its size_multiplier is forced to 0.0', () => {
    // Without the is_trusted guard, 0.0 <= 0.667 would misread every excluded/untrusted row as
    // the choppiest possible coin, which is a data-quality artifact, not a real ATR read.
    expect(sizeMultiplierChip(withSizeMultiplier(0.0, false))).toBeNull();
  });

  it('never claims to be a strength or conviction rating in its tooltip text', () => {
    const chip = sizeMultiplierChip(withSizeMultiplier(1.8));
    expect(chip?.title.toLowerCase()).toContain('not a conviction rating');
  });
});

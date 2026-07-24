import { describe, expect, it } from 'vitest';
import {
  cvdAbsorptionStateOrNull,
  dashboardRow,
  fightsBtcOrNull,
  oiPriceQuadrant,
  oiPriceTrendStateOrNull,
  positioningDivergenceRatio,
  reasonParts,
  setupConfidence,
} from '../../src/dashboard/rows.js';
import type { Row } from '../../src/pipeline/types.js';

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

describe('cvdAbsorptionStateOrNull', () => {
  it('passes through each recognized state', () => {
    expect(cvdAbsorptionStateOrNull('absorption_bearish')).toBe('absorption_bearish');
    expect(cvdAbsorptionStateOrNull('absorption_bullish')).toBe('absorption_bullish');
    expect(cvdAbsorptionStateOrNull('confirmation_long')).toBe('confirmation_long');
    expect(cvdAbsorptionStateOrNull('confirmation_short')).toBe('confirmation_short');
  });

  it('returns null for garbage values', () => {
    expect(cvdAbsorptionStateOrNull('distribution')).toBeNull();
  });

  it('returns null when absent', () => {
    expect(cvdAbsorptionStateOrNull(null)).toBeNull();
    expect(cvdAbsorptionStateOrNull(undefined)).toBeNull();
  });
});

describe('oiPriceTrendStateOrNull', () => {
  it('passes through each recognized state', () => {
    expect(oiPriceTrendStateOrNull('diverging_long')).toBe('diverging_long');
    expect(oiPriceTrendStateOrNull('diverging_short')).toBe('diverging_short');
    expect(oiPriceTrendStateOrNull('confirmed_long')).toBe('confirmed_long');
    expect(oiPriceTrendStateOrNull('confirmed_short')).toBe('confirmed_short');
  });

  it('returns null for garbage values', () => {
    expect(oiPriceTrendStateOrNull('drifting')).toBeNull();
  });

  it('returns null when absent', () => {
    expect(oiPriceTrendStateOrNull(null)).toBeNull();
    expect(oiPriceTrendStateOrNull(undefined)).toBeNull();
  });
});

describe('setupConfidence', () => {
  it('grades A when all 4 votes agree (long)', () => {
    expect(setupConfidence('long', 0.6, 0.3, 1.5, null)).toBe('A');
  });

  it('grades A when all 4 votes agree (short)', () => {
    expect(setupConfidence('short', -0.6, -0.3, 0, 'long')).toBe('A');
  });

  it('grades B when exactly 2 of 4 votes agree', () => {
    // trend passes (0.6 >= 0.55); momentum fails (-0.1 is not > 0); oi passes (1.5 >= 0);
    // fights_btc fails ('long' vetoes the long side) -- 2 of 4.
    expect(setupConfidence('long', 0.6, -0.1, 1.5, 'long')).toBe('B');
  });

  it('grades B when 3 of 4 votes agree', () => {
    // trend passes, momentum passes, oi fails (missing evidence), fights_btc passes (null).
    expect(setupConfidence('long', 0.6, 0.1, null, null)).toBe('B');
  });

  it('grades C when only 1 of 4 votes agrees', () => {
    // trend fails (0.1 < 0.55), momentum fails (-0.1 not > 0), oi fails (-2 < 0), fights_btc passes (null).
    expect(setupConfidence('long', 0.1, -0.1, -2, null)).toBe('C');
  });

  it('grades C when no votes agree', () => {
    expect(setupConfidence('long', null, null, null, 'long')).toBe('C');
  });

  it('treats null trend/momentum/oi inputs as failed votes, not agreement', () => {
    // fights_btc null passes the veto vote; trend/momentum/oi null all fail -> 1 of 4 -> C.
    expect(setupConfidence('short', null, null, null, null)).toBe('C');
  });

  it('respects the exact 0.55 trend-score threshold boundary', () => {
    expect(setupConfidence('long', 0.55, 1, 1, null)).toBe('A');
    // 0.54 fails the trend vote -> 3 of 4 -> B.
    expect(setupConfidence('long', 0.54, 1, 1, null)).toBe('B');
    expect(setupConfidence('short', -0.55, -1, 1, null)).toBe('A');
    expect(setupConfidence('short', -0.54, -1, 1, null)).toBe('B');
  });

  it('treats momentum of exactly 0 as a failed vote for both sides', () => {
    expect(setupConfidence('long', 0.6, 0, 1, null)).toBe('B');
    expect(setupConfidence('short', -0.6, 0, 0, null)).toBe('B');
  });

  it('treats oi_change_24h_pct of exactly 0 as a passing vote', () => {
    expect(setupConfidence('long', 0.6, 0.1, 0, null)).toBe('A');
  });

  it('only vetoes the matching side', () => {
    expect(setupConfidence('long', 0.6, 0.1, 1, 'short')).toBe('A');
    expect(setupConfidence('short', -0.6, -0.1, 1, 'long')).toBe('A');
  });
});

describe('reasonParts new-signal chips', () => {
  const baseRow: Row = {
    price_change_24h_pct: null,
    oi_change_24h_pct: null,
    funding_rate_pct: null,
  };

  it('adds a warn Tape chip for absorption_bearish', () => {
    const parts = reasonParts({ ...baseRow, cvd_absorption_state: 'absorption_bearish' }, 'long');
    expect(parts.find((part) => part.label === 'Tape')).toEqual({
      kind: 'context',
      label: 'Tape',
      value: 'distribution into strength',
      tone: 'warn',
      help: '3d price up but net taker flow is negative -- selling into strength.',
    });
  });

  it('adds a warn Tape chip for absorption_bullish', () => {
    const parts = reasonParts({ ...baseRow, cvd_absorption_state: 'absorption_bullish' }, 'long');
    expect(parts.find((part) => part.label === 'Tape')?.value).toBe('sellers absorbed');
    expect(parts.find((part) => part.label === 'Tape')?.tone).toBe('warn');
  });

  it('adds a positive-tone Tape chip for confirmation_long', () => {
    const parts = reasonParts({ ...baseRow, cvd_absorption_state: 'confirmation_long' }, 'long');
    expect(parts.find((part) => part.label === 'Tape')?.value).toBe('confirms strength');
    expect(parts.find((part) => part.label === 'Tape')?.tone).toBe('pos');
  });

  it('adds a positive-tone Tape chip for confirmation_short', () => {
    const parts = reasonParts({ ...baseRow, cvd_absorption_state: 'confirmation_short' }, 'short');
    expect(parts.find((part) => part.label === 'Tape')?.value).toBe('confirms weakness');
    expect(parts.find((part) => part.label === 'Tape')?.tone).toBe('pos');
  });

  it('adds no Tape chip when cvd_absorption_state is absent', () => {
    expect(reasonParts(baseRow, 'long').find((part) => part.label === 'Tape')).toBeUndefined();
  });

  it('adds a warn OI chip for diverging_long', () => {
    const parts = reasonParts({ ...baseRow, oi_price_trend_state: 'diverging_long' }, 'long');
    expect(parts.find((part) => part.label === 'OI')).toEqual({
      kind: 'context',
      label: 'OI',
      value: '3d drain vs move',
      tone: 'warn',
      help: '24h price up but 3d open interest has been draining -- late positioning.',
    });
  });

  it('adds a warn OI chip for diverging_short', () => {
    const parts = reasonParts({ ...baseRow, oi_price_trend_state: 'diverging_short' }, 'short');
    expect(parts.find((part) => part.label === 'OI')?.value).toBe('3d build vs move');
  });

  it('adds no OI chip for confirmed states (display-only, no chip)', () => {
    const confirmedLong = reasonParts(
      { ...baseRow, oi_price_trend_state: 'confirmed_long' },
      'long',
    );
    const confirmedShort = reasonParts(
      { ...baseRow, oi_price_trend_state: 'confirmed_short' },
      'short',
    );
    expect(confirmedLong.find((part) => part.label === 'OI')).toBeUndefined();
    expect(confirmedShort.find((part) => part.label === 'OI')).toBeUndefined();
  });

  it('adds a warn RSI divergence chip for a bearish divergence', () => {
    const parts = reasonParts({ ...baseRow, technical_divergence: 'bearish' }, 'long');
    expect(parts.find((part) => part.label === 'RSI divergence')).toEqual({
      kind: 'context',
      label: 'RSI divergence',
      value: 'bearish',
      tone: 'warn',
      help: 'Price made a new swing extreme but RSI did not confirm it -- a possible momentum divergence.',
    });
  });

  it('adds a warn RSI divergence chip for a bullish divergence', () => {
    const parts = reasonParts({ ...baseRow, technical_divergence: 'bullish' }, 'long');
    expect(parts.find((part) => part.label === 'RSI divergence')?.value).toBe('bullish');
  });

  it('adds no RSI divergence chip when null', () => {
    const parts = reasonParts({ ...baseRow, technical_divergence: null }, 'long');
    expect(parts.find((part) => part.label === 'RSI divergence')).toBeUndefined();
  });

  it('adds a positive fresh-cross chip for a bullish cross inside the freshness window', () => {
    const parts = reasonParts(
      { ...baseRow, ema_cross_direction: 'bullish', ema_cross_bars_since: 0 },
      'long',
    );
    expect(parts.find((part) => part.label === 'Fresh EMA20/50 cross')).toEqual({
      kind: 'context',
      label: 'Fresh EMA20/50 cross',
      value: 'bull',
      tone: 'pos',
      help: 'EMA20 crossed EMA50 0 bars ago.',
    });
  });

  it('adds a negative fresh-cross chip for a bearish cross exactly at the 6-bar boundary', () => {
    const parts = reasonParts(
      { ...baseRow, ema_cross_direction: 'bearish', ema_cross_bars_since: 6 },
      'short',
    );
    expect(parts.find((part) => part.label === 'Fresh EMA20/50 cross')).toEqual({
      kind: 'context',
      label: 'Fresh EMA20/50 cross',
      value: 'bear',
      tone: 'neg',
      help: 'EMA20 crossed EMA50 6 bars ago.',
    });
  });

  it('omits the fresh-cross chip once the cross is older than 6 bars', () => {
    const parts = reasonParts(
      { ...baseRow, ema_cross_direction: 'bullish', ema_cross_bars_since: 7 },
      'long',
    );
    expect(parts.find((part) => part.label === 'Fresh EMA20/50 cross')).toBeUndefined();
  });

  it('omits the fresh-cross chip when there has been no cross at all', () => {
    const parts = reasonParts(
      { ...baseRow, ema_cross_direction: null, ema_cross_bars_since: null },
      'long',
    );
    expect(parts.find((part) => part.label === 'Fresh EMA20/50 cross')).toBeUndefined();
  });
});

describe('dashboardRow new_to_list wire emission', () => {
  const baseRow: Row = {
    symbol: 'BTC',
    price_change_24h_pct: null,
    oi_change_24h_pct: null,
    funding_rate_pct: null,
  };

  it('emits new_to_list: true when the caller flags the row as newly on the list', () => {
    const row = dashboardRow(baseRow, null, 'long', null, true);
    expect(row.new_to_list).toBe(true);
  });

  it('omits new_to_list entirely (not null/false) when the caller does not flag it', () => {
    const row = dashboardRow(baseRow, null, 'long');
    expect('new_to_list' in row).toBe(false);
  });
});

describe('dashboardRow run_trend wire emission', () => {
  const baseRow: Row = {
    symbol: 'BTC',
    price_change_24h_pct: null,
    oi_change_24h_pct: null,
    funding_rate_pct: null,
  };

  it('emits run_trend when the caller supplies a resolved value for a long row', () => {
    const row = dashboardRow(baseRow, null, 'long', null, false, 'strengthening');
    expect(row.run_trend).toBe('strengthening');
  });

  it('emits run_trend for a short row too', () => {
    const row = dashboardRow(baseRow, null, 'short', null, false, 'weakening');
    expect(row.run_trend).toBe('weakening');
  });

  it('omits run_trend entirely (not null/undefined-as-a-key) when the caller does not supply one', () => {
    const row = dashboardRow(baseRow, null, 'long');
    expect('run_trend' in row).toBe(false);
  });

  it('omits run_trend for a non-directional side even if the caller supplies a value -- core/fade-long/squeeze-risk have no side-specific score to trend', () => {
    const row = dashboardRow(baseRow, null, 'core', null, false, 'holding');
    expect('run_trend' in row).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  breakdownPct,
  breakoutPct,
  breakoutVolumeRatio,
  DONCHIAN_PERIOD,
  divergenceOf,
  donchianPosition,
  donchianRange,
  emaCrossOf,
  goldenPocket,
  type RawCandle,
  rsiSeries,
  technicalSnapshot,
  trendStateOf,
} from '../../src/pipeline/technicals.js';

function makeCandles(closes: number[]): RawCandle[] {
  return closes.map((close, index) => ({
    time: index,
    open: close,
    high: close,
    low: close,
    close,
  }));
}

// Deterministic wiggly walk (up and down, with drift) so RSI has real gains and losses to smooth.
function wigglyCloses(length: number): number[] {
  return Array.from({ length }, (_, i) => 100 + Math.sin(i / 3) * 8 + i * 0.15);
}

describe('trendStateOf', () => {
  it('maps continuation and pullback labels to uptrend', () => {
    expect(trendStateOf('Trend Continuation', 0.8)).toBe('uptrend');
    expect(trendStateOf('Pullback Into Uptrend', 0.6)).toBe('uptrend');
  });

  it('maps downtrend continuation and rally labels to downtrend', () => {
    expect(trendStateOf('Downtrend Continuation', -0.8)).toBe('downtrend');
    expect(trendStateOf('Rally Into Downtrend', -0.6)).toBe('downtrend');
  });

  it('maps exhaustion labels to their exhaustion states', () => {
    expect(trendStateOf('Upside Exhaustion', 0.9)).toBe('exhaustion_top');
    expect(trendStateOf('Downside Exhaustion', -0.9)).toBe('exhaustion_bottom');
  });

  it('maps Mixed Technicals to chop regardless of trendScore', () => {
    expect(trendStateOf('Mixed Technicals', 0.1)).toBe('chop');
    expect(trendStateOf('Mixed Technicals', null)).toBe('chop');
  });

  describe('Compression Watch', () => {
    it('reads as uptrend once trendScore clears the 0.55 threshold', () => {
      expect(trendStateOf('Compression Watch', 0.55)).toBe('uptrend');
      expect(trendStateOf('Compression Watch', 0.9)).toBe('uptrend');
    });

    it('reads as downtrend once trendScore clears -0.55', () => {
      expect(trendStateOf('Compression Watch', -0.55)).toBe('downtrend');
      expect(trendStateOf('Compression Watch', -0.9)).toBe('downtrend');
    });

    it('reads as chop between the thresholds or when trendScore is null', () => {
      expect(trendStateOf('Compression Watch', 0.3)).toBe('chop');
      expect(trendStateOf('Compression Watch', -0.3)).toBe('chop');
      expect(trendStateOf('Compression Watch', null)).toBe('chop');
    });
  });
});

describe('Donchian-20 breakout context', () => {
  it('flags a breakout above the prior 20-bar high (test_donchian_breakout)', () => {
    const priorHighs = Array.from({ length: 20 }, () => 100);
    const priorLows = Array.from({ length: 20 }, () => 90);
    const donchian = donchianRange([...priorHighs, 105], [...priorLows, 95], DONCHIAN_PERIOD);
    expect(donchian.high).toBe(100);
    expect(donchian.low).toBe(90);
    const close = 102;
    // (102-100)/100*100 = 2
    expect(breakoutPct(close, donchian.high)).toBe(2);
    expect(breakdownPct(close, donchian.low)).toBe(0);
    // (102-90)/(100-90) = 1.2 -> clamped to 1
    expect(donchianPosition(close, donchian.high, donchian.low)).toBe(1);
  });

  it('flags a breakdown below the prior 20-bar low (test_donchian_breakdown)', () => {
    const priorHighs = Array.from({ length: 20 }, () => 100);
    const priorLows = Array.from({ length: 20 }, () => 90);
    const donchian = donchianRange([...priorHighs, 95], [...priorLows, 85], DONCHIAN_PERIOD);
    const close = 88;
    expect(breakoutPct(close, donchian.high)).toBe(0);
    // (90-88)/90*100 = 2.2222...
    expect(breakdownPct(close, donchian.low)).toBe(2.2222);
    // (88-90)/(100-90) = -0.2 -> clamped to 0
    expect(donchianPosition(close, donchian.high, donchian.low)).toBe(0);
  });

  it('reads zero breakout/breakdown and a fractional position when inside the prior range (test_donchian_inside_range)', () => {
    const priorHighs = Array.from({ length: 20 }, () => 100);
    const priorLows = Array.from({ length: 20 }, () => 90);
    const donchian = donchianRange([...priorHighs, 96], [...priorLows, 94], DONCHIAN_PERIOD);
    const close = 95;
    expect(breakoutPct(close, donchian.high)).toBe(0);
    expect(breakdownPct(close, donchian.low)).toBe(0);
    // (95-90)/(100-90) = 0.5
    expect(donchianPosition(close, donchian.high, donchian.low)).toBe(0.5);
  });

  it('returns null extremes (and null derived fields) with fewer than 21 bars (test_donchian_short_series)', () => {
    const highs = Array.from({ length: 20 }, () => 100); // exactly 20, need 21
    const lows = Array.from({ length: 20 }, () => 90);
    const donchian = donchianRange(highs, lows, DONCHIAN_PERIOD);
    expect(donchian.high).toBeNull();
    expect(donchian.low).toBeNull();
    expect(breakoutPct(105, donchian.high)).toBeNull();
    expect(breakdownPct(85, donchian.low)).toBeNull();
    expect(donchianPosition(95, donchian.high, donchian.low)).toBeNull();
  });

  it('nulls the position but still computes breakout/breakdown magnitude on a flat prior range (test_donchian_degenerate_range)', () => {
    const priorHighs = Array.from({ length: 20 }, () => 100);
    const priorLows = Array.from({ length: 20 }, () => 100); // high === low every prior bar
    const donchian = donchianRange([...priorHighs, 105], [...priorLows, 105], DONCHIAN_PERIOD);
    expect(donchian.high).toBe(100);
    expect(donchian.low).toBe(100);
    expect(donchianPosition(105, donchian.high, donchian.low)).toBeNull();
    // (105-100)/100*100 = 5
    expect(breakoutPct(105, donchian.high)).toBe(5);
    // (100-95)/100*100 = 5
    expect(breakdownPct(95, donchian.low)).toBe(5);
  });
});

describe('breakoutVolumeRatio', () => {
  it('computes latest volume over the prior 20-bar average (test_volume_ratio_normal)', () => {
    const priorVolumes = Array.from({ length: 20 }, () => 1000);
    expect(breakoutVolumeRatio([...priorVolumes, 2500], DONCHIAN_PERIOD)).toBe(2.5);
  });

  it('returns null when a bar inside the required window is missing volume (test_volume_ratio_missing)', () => {
    const priorVolumes: Array<number | null> = Array.from({ length: 20 }, () => 1000);
    priorVolumes[5] = null;
    expect(breakoutVolumeRatio([...priorVolumes, 2500], DONCHIAN_PERIOD)).toBeNull();
  });

  it('returns null when the latest bar itself is missing volume (test_volume_ratio_missing_latest)', () => {
    const priorVolumes = Array.from({ length: 20 }, () => 1000);
    expect(breakoutVolumeRatio([...priorVolumes, null], DONCHIAN_PERIOD)).toBeNull();
  });

  it('returns null when the prior window averages to zero (test_volume_ratio_zero_mean)', () => {
    const priorVolumes = Array.from({ length: 20 }, () => 0);
    expect(breakoutVolumeRatio([...priorVolumes, 500], DONCHIAN_PERIOD)).toBeNull();
  });

  it('returns null with fewer than period+1 bars (test_volume_ratio_short_series)', () => {
    const volumes = Array.from({ length: 20 }, () => 1000); // only 20, need 21
    expect(breakoutVolumeRatio(volumes, DONCHIAN_PERIOD)).toBeNull();
  });
});

describe('emaCrossOf', () => {
  it('detects a fresh bullish cross on the latest bar (test_ema_cross_fresh_bullish)', () => {
    const ema20 = [10, 10, 10, 10, 9];
    const ema50 = [11, 11, 11, 11, 8];
    // diff = [-1, -1, -1, -1, 1]
    const cross = emaCrossOf(ema20, ema50, 5);
    expect(cross.direction).toBe('bullish');
    expect(cross.barsSince).toBe(0);
  });

  it('detects a fresh bearish cross on the latest bar (test_ema_cross_fresh_bearish)', () => {
    const ema20 = [10, 10, 10, 10, 9];
    const ema50 = [8, 8, 8, 8, 11];
    // diff = [2, 2, 2, 2, -2]
    const cross = emaCrossOf(ema20, ema50, 5);
    expect(cross.direction).toBe('bearish');
    expect(cross.barsSince).toBe(0);
  });

  it('returns null when no flip occurs inside the window (test_ema_cross_no_cross)', () => {
    const ema20 = [10, 11, 12, 13, 14, 15];
    const ema50 = [8, 8, 8, 8, 8, 8];
    const cross = emaCrossOf(ema20, ema50, 5);
    expect(cross.direction).toBeNull();
    expect(cross.barsSince).toBeNull();
  });

  it('picks the most recent flip when the series whipsaws (test_ema_cross_whipsaw)', () => {
    const ema50 = [0, 0, 0, 0, 0, 0];
    // diff = [-1, 1, -1, 1, 1, 1] -- flips at bar 0->1, 1->2, 2->3; the most recent is 2->3, 2 bars back.
    const ema20 = [-1, 1, -1, 1, 1, 1];
    const cross = emaCrossOf(ema20, ema50, 10);
    expect(cross.direction).toBe('bullish');
    expect(cross.barsSince).toBe(2);
  });

  it('treats an exact-zero diff as belonging to the current (bullish) sign (test_ema_cross_zero_diff)', () => {
    const ema20 = [9, 10];
    const ema50 = [10, 10];
    // diff = [-1, 0] -- the zero bar reads as the >=0 side, so the flip lands on the latest bar.
    const cross = emaCrossOf(ema20, ema50, 5);
    expect(cross.direction).toBe('bullish');
    expect(cross.barsSince).toBe(0);
  });

  it('returns null when the aligned series is too short to form a single diff pair (test_ema_cross_short_series)', () => {
    const cross = emaCrossOf([5], [3], 30);
    expect(cross.direction).toBeNull();
    expect(cross.barsSince).toBeNull();
  });
});

describe('rsiSeries', () => {
  // Pinned to the exact value the pre-refactor scalar implementation produced (rsi_14 was
  // reimplemented as rsiSeries(...).at(-1), so comparing the two live would be tautological --
  // this fixed constant is what actually catches drift).
  const EXPECTED_RSI_14 = 69.86701389733311;

  it('has a last value identical to the rsi_14 the snapshot emits, so rsi_14 cannot drift (test_rsi_series_matches_scalar)', () => {
    const closes = wigglyCloses(80);
    const snapshot = technicalSnapshot(makeCandles(closes), '4h');
    expect(snapshot.rsi_14).toBe(EXPECTED_RSI_14);
    expect(rsiSeries(closes, 14).at(-1)).toBe(EXPECTED_RSI_14);
  });
});

describe('divergenceOf', () => {
  it('flags an active bearish divergence: higher price high, lower (but still overbought) RSI high (test_divergence_bearish)', () => {
    const closes = [
      90, 92, 94, 96, 98, 100, 98, 96, 94, 92, 90, 92, 94, 96, 98, 100, 105, 100, 98, 96,
    ];
    const rsiValues = Array.from({ length: closes.length }, () => 50);
    rsiValues[5] = 70; // P1
    rsiValues[16] = 62; // P2: lower RSI high, still > 50
    const divergence = divergenceOf(closes, rsiValues);
    expect(divergence.direction).toBe('bearish');
    // clamp(|70-62|/10, 0, 1) = 0.8
    expect(divergence.strength).toBe(0.8);
  });

  it('flags an active bullish divergence: lower price low, higher (but still oversold) RSI low (test_divergence_bullish)', () => {
    const closes = [
      110, 108, 106, 104, 102, 100, 102, 104, 106, 108, 110, 108, 106, 104, 102, 100, 95, 100, 102,
      104,
    ];
    const rsiValues = Array.from({ length: closes.length }, () => 50);
    rsiValues[5] = 40; // P1
    rsiValues[16] = 48; // P2: higher RSI low, still < 50
    const divergence = divergenceOf(closes, rsiValues);
    expect(divergence.direction).toBe('bullish');
    expect(divergence.strength).toBe(0.8);
  });

  it('goes inactive once the newer swing falls outside the 12-bar active window (test_divergence_inactive_stale)', () => {
    // Same bearish shape as above, but with 15 extra (monotonically falling, swing-free) bars appended
    // after P2, pushing it well past DIVERGENCE_ACTIVE_BARS=12 bars back from the latest close.
    const base = [
      90, 92, 94, 96, 98, 100, 98, 96, 94, 92, 90, 92, 94, 96, 98, 100, 105, 100, 98, 96,
    ];
    const tail = Array.from({ length: 15 }, (_, i) => 94 - i * 2);
    const closes = [...base, ...tail];
    const rsiValues = Array.from({ length: closes.length }, () => 50);
    rsiValues[5] = 70;
    rsiValues[16] = 62;
    const divergence = divergenceOf(closes, rsiValues);
    expect(divergence.direction).toBeNull();
    expect(divergence.strength).toBeNull();
  });

  it('finds no swings (and so no divergence) in a strong, uninterrupted trend (test_divergence_no_swing_in_strong_trend)', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const rsiValues = Array.from({ length: closes.length }, () => 65);
    const divergence = divergenceOf(closes, rsiValues);
    expect(divergence.direction).toBeNull();
    expect(divergence.strength).toBeNull();
  });
});

describe('goldenPocket', () => {
  it('computes the fib 0.5-0.618 zone of an up-leg: swing high more recent than swing low (test_golden_pocket_up_leg)', () => {
    // Swing low confirmed at index 3 (value 0), swing high confirmed at index 9 (value 100);
    // strictly monotonic between them so no other swings qualify.
    const closes = [40, 30, 20, 0, 20, 40, 60, 80, 90, 100, 90, 80, 70, 55];
    const gp = goldenPocket(closes);
    expect(gp.legHigh).toBe(100);
    expect(gp.legLow).toBe(0);
    expect(gp.direction).toBe('up');
    // range = 100 - 0 = 100; upper = 100 - 0.5*100 = 50; lower = 100 - 0.618*100 = 38.2
    expect(gp.upper).toBe(50);
    expect(gp.lower).toBe(38.2);
    // last close = 55, above the zone: (55-50)/50*100 = 10
    expect(gp.distancePct).toBe(10);
  });

  it('computes the fib 0.5-0.618 zone of a down-leg: swing low more recent than swing high (test_golden_pocket_down_leg)', () => {
    // Swing high confirmed at index 3 (value 100), swing low confirmed at index 9 (value 0);
    // strictly monotonic between them so no other swings qualify.
    const closes = [60, 70, 80, 100, 80, 60, 40, 20, 10, 0, 10, 20, 30, 45];
    const gp = goldenPocket(closes);
    expect(gp.legHigh).toBe(100);
    expect(gp.legLow).toBe(0);
    expect(gp.direction).toBe('down');
    // range = 100 - 0 = 100; lower = 0 + 0.5*100 = 50; upper = 0 + 0.618*100 = 61.8
    expect(gp.lower).toBe(50);
    expect(gp.upper).toBe(61.8);
    // last close = 45, below the zone: (45-50)/50*100 = -10
    expect(gp.distancePct).toBe(-10);
  });

  it('returns all-null when there is no confirmed swing high or low (test_golden_pocket_no_swings)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i); // strictly monotonic, no extrema
    const gp = goldenPocket(closes);
    expect(gp.legHigh).toBeNull();
    expect(gp.legLow).toBeNull();
    expect(gp.direction).toBeNull();
    expect(gp.upper).toBeNull();
    expect(gp.lower).toBeNull();
    expect(gp.distancePct).toBeNull();
  });
});

describe('technicalSnapshot donchian levels', () => {
  it('emits donchian_high_20/donchian_low_20 as the absolute prior-20-bar extremes (test_donchian_levels_on_snapshot)', () => {
    const closes = wigglyCloses(80);
    const snapshot = technicalSnapshot(makeCandles(closes), '4h');
    const expected = donchianRange(closes, closes, DONCHIAN_PERIOD);
    expect(expected.high).not.toBeNull();
    expect(expected.low).not.toBeNull();
    expect(snapshot.donchian_high_20).toBe(expected.high);
    expect(snapshot.donchian_low_20).toBe(expected.low);
  });
});

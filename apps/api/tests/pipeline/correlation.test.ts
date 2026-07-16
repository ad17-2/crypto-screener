import { describe, expect, it } from 'vitest';
import { closeSeries, returnStats, returnsByTime } from '../../src/pipeline/correlation.js';

describe('closeSeries', () => {
  it('sorts by time and drops non-finite/<=0 closes', () => {
    const candles = [
      { time: 3, close: 103 },
      { time: 1, close: 101 },
      { time: 2, close: -5 }, // dropped: close <= 0
      { time: 'not-a-number', close: 105 }, // dropped: non-finite time
      { time: 4, close: 'also-not-a-number' }, // dropped: non-finite close
      { time: 5, close: 0 }, // dropped: close <= 0
    ];

    expect(closeSeries(candles)).toEqual([
      { time: 1, close: 101 },
      { time: 3, close: 103 },
    ]);
  });
});

describe('returnsByTime', () => {
  it('computes period-over-period returns keyed by the closing bar time', () => {
    const bars = [
      { time: 1, close: 100 },
      { time: 2, close: 110 },
      { time: 3, close: 99 },
    ];

    const returns = returnsByTime(bars);

    expect(returns.size).toBe(2);
    expect(returns.get(2)).toBeCloseTo(0.1, 12); // (110-100)/100
    expect(returns.get(3)).toBeCloseTo(-0.1, 12); // (99-110)/110
    expect(returns.has(1)).toBe(false); // the opening bar of the series has no prior close
  });

  it('skips a step when the prior close is <= 0', () => {
    const bars = [
      { time: 1, close: 0 },
      { time: 2, close: 50 },
    ];

    expect(returnsByTime(bars).size).toBe(0);
  });

  it('skips the step across a dropped bar instead of mislabeling a multi-period return', () => {
    // Bar at t=3 was dropped; surviving bars are 0,1,2,4. Base interval = 1.
    const bars = [
      { time: 0, close: 100 },
      { time: 1, close: 110 },
      { time: 2, close: 121 },
      { time: 4, close: 133 },
    ];
    const returns = returnsByTime(bars);
    expect(returns.has(1)).toBe(true);
    expect(returns.has(2)).toBe(true);
    expect(returns.has(4)).toBe(false); // gap: delta 2 != base interval 1 — old code emitted a bogus 2-period return here
    expect(returns.size).toBe(2);
  });
});

/** Builds a close-price series from a starting price and a list of period-over-period returns, so
 *  hand-computed "returns" fixtures can be fed through `returnStats` (which takes raw price bars,
 *  not pre-built return maps). */
function closesFromReturns(startClose: number, returns: number[], times: number[]) {
  const bars = [{ time: times[0] as number, close: startClose }];
  let close = startClose;
  for (let index = 0; index < returns.length; index += 1) {
    close *= 1 + (returns[index] as number);
    bars.push({ time: times[index + 1] as number, close });
  }
  return bars;
}

describe('returnStats', () => {
  it('returns correlation ~1 and beta ~1 for an identical returns series', () => {
    const returns = [0.1, -0.05, 0.2];
    const coinBars = closesFromReturns(100, returns, [0, 1, 2, 3]);
    const btcBars = closesFromReturns(100, returns, [0, 1, 2, 3]);

    const stats = returnStats(coinBars, btcBars, 3);

    expect(stats.correlation).not.toBeNull();
    expect(stats.correlation as number).toBeCloseTo(1, 9);
    expect(stats.beta).not.toBeNull();
    expect(stats.beta as number).toBeCloseTo(1, 9);
    expect(stats.gapped).toBe(false);
  });

  it('returns correlation ~-1 and beta ~-1 for an exactly inverse returns series', () => {
    const btcReturns = [0.1, -0.05, 0.2];
    const coinReturns = btcReturns.map((value) => -value);
    const btcBars = closesFromReturns(100, btcReturns, [0, 1, 2, 3]);
    const coinBars = closesFromReturns(100, coinReturns, [0, 1, 2, 3]);

    const stats = returnStats(coinBars, btcBars, 3);

    expect(stats.correlation).not.toBeNull();
    expect(stats.correlation as number).toBeCloseTo(-1, 9);
    expect(stats.beta).not.toBeNull();
    expect(stats.beta as number).toBeCloseTo(-1, 9);
  });

  it('returns null correlation and beta when shared pairs are below minPairs', () => {
    const coinBars = closesFromReturns(1, [1, 2, 3], [0, 1, 2, 3]);
    const btcBars = closesFromReturns(1, [2, 4, 5], [0, 1, 2, 3]);

    const stats = returnStats(coinBars, btcBars, 4); // only 3 shared pairs are available

    expect(stats.pairs).toBe(3);
    expect(stats.correlation).toBeNull();
    expect(stats.beta).toBeNull();
  });

  it('returns null beta (and correlation) when BTC returns have zero variance', () => {
    const coinBars = closesFromReturns(1, [1, 2, 3], [0, 1, 2, 3]);
    const btcBars = [
      { time: 0, close: 10 },
      { time: 1, close: 10 },
      { time: 2, close: 10 },
      { time: 3, close: 10 },
    ]; // flat: every period return is 0, so BTC return variance is 0

    const stats = returnStats(coinBars, btcBars, 3);

    expect(stats.pairs).toBe(3);
    expect(stats.beta).toBeNull();
    expect(stats.correlation).toBeNull();
  });

  it(
    'computes the expected correlation and beta on a hand-built example (regression guard: the ' +
      'correlation value must match the pre-refactor returnCorrelation output for the same returns)',
    () => {
      // x-returns (keyed by time 1,2,3) are 1,2,3; y-returns are 2,4,5 -- the exact fixture the old
      // returnCorrelation() test used, rebuilt here as a close-price series.
      const coinBars = closesFromReturns(1, [1, 2, 3], [0, 1, 2, 3]);
      const btcBars = closesFromReturns(1, [2, 4, 5], [0, 1, 2, 3]);

      const stats = returnStats(coinBars, btcBars, 3);

      // Hand-computed: mean(x)=2, mean(y)=11/3; r = 3 / sqrt(2 * 14/3) = 0.9819805060619659 (identical
      // to the pre-refactor hand-computed test). beta = cov(x,y)/var(y) = 3 / (14/3) = 9/14.
      expect(stats.pairs).toBe(3);
      expect(stats.correlation).not.toBeNull();
      expect(stats.correlation as number).toBeCloseTo(0.9819805060619659, 9);
      expect(stats.beta).not.toBeNull();
      expect(stats.beta as number).toBeCloseTo(9 / 14, 9);
      expect(stats.gapped).toBe(false);
    },
  );
});

describe('returnStats unit detection', () => {
  const HOUR_MS = 3_600_000;
  const HOUR_S = 3_600;

  it('anchors on epoch-ms timestamps (>= 1e11) with no gap: gapped stays false', () => {
    const stepMs = 4 * HOUR_MS;
    const t0 = 1_700_000_000_000; // >= 1e11 -> detected as epoch-ms
    const times = Array.from({ length: 10 }, (_, index) => t0 + index * stepMs);
    const btcBars = times.map((time, index) => ({
      time,
      close: 100 + (index % 5) * 3 + (index % 3),
    }));
    const coinBars = times.map((time, index) => ({
      time,
      close: 50 + (index % 4) * 2 + (index % 2),
    }));

    const stats = returnStats(coinBars, btcBars, 5, '4h');

    expect(stats.gapped).toBe(false);
    expect(stats.pairs).toBe(9);
    expect(stats.correlation).not.toBeNull();
  });

  it('anchors on epoch-seconds timestamps ([1e8, 1e11)) with no gap: gapped stays false', () => {
    const stepS = 4 * HOUR_S;
    const t0 = 1_700_000_000; // in [1e8, 1e11) -> detected as epoch-seconds
    const times = Array.from({ length: 10 }, (_, index) => t0 + index * stepS);
    const btcBars = times.map((time, index) => ({
      time,
      close: 100 + (index % 5) * 3 + (index % 3),
    }));
    const coinBars = times.map((time, index) => ({
      time,
      close: 50 + (index % 4) * 2 + (index % 2),
    }));

    const stats = returnStats(coinBars, btcBars, 5, '4h');

    expect(stats.gapped).toBe(false);
    expect(stats.pairs).toBe(9);
    expect(stats.correlation).not.toBeNull();
  });

  it('keeps the historic min-delta fallback for small synthetic timestamps (< 1e8), ignoring the interval anchor', () => {
    // Small-int timestamps are a synthetic/test fixture, not a real epoch -- an interval that would
    // wildly disagree with the actual (inferred) step must NOT trigger gap correction here.
    const btcBars = [
      { time: 0, close: 100 },
      { time: 1, close: 103 },
      { time: 2, close: 99 },
      { time: 3, close: 105 },
      { time: 4, close: 101 },
    ];
    const coinBars = [
      { time: 0, close: 50 },
      { time: 1, close: 52 },
      { time: 2, close: 48 },
      { time: 3, close: 53 },
      { time: 4, close: 49 },
    ];

    const stats = returnStats(coinBars, btcBars, 3, '4h');

    expect(stats.gapped).toBe(false);
    expect(stats.pairs).toBe(4);
    expect(stats.correlation).not.toBeNull();
  });
});

describe('returnStats gap-anchored pairing', () => {
  // Regression test for the mispairing bug: a coin series missing every other 4h candle has a
  // uniform 8h min-delta, so naive inference called this "8h data" and happily paired it, timestamp
  // for timestamp, against BTC's real 4h returns -- silently mixing 2-period coin moves with
  // 1-period BTC moves. With the fix, pairing is anchored to the configured interval (4h), so the
  // gapped coin's own consecutive bars (8h apart) never match the 4h step and contribute no returns.
  it('does not silently pair an under-sampled coin series (8h gaps) against BTC as if it were 4h', () => {
    const HOUR_MS = 3_600_000;
    const stepMs = 4 * HOUR_MS;
    const t0 = 1_700_000_000_000; // epoch-ms

    // BTC: complete 4h series, 20 candles.
    const btcBars = Array.from({ length: 20 }, (_, index) => ({
      time: t0 + index * stepMs,
      close: 100 + (index % 5) * 3 + (index % 3),
    }));

    // Coin: missing every other 4h candle -- only the even-indexed BTC timestamps survive, so its
    // own bars are a uniform 8h apart (naive min-delta inference would call this "8h" data).
    const coinBars = btcBars
      .filter((_, index) => index % 2 === 0)
      .map((bar, index) => ({ time: bar.time, close: 50 + (index % 4) * 2 }));

    const stats = returnStats(coinBars, btcBars, 5, '4h');

    expect(stats.gapped).toBe(true);
    expect(stats.pairs).toBe(0);
    expect(stats.correlation).toBeNull();
    expect(stats.beta).toBeNull();
  });
});

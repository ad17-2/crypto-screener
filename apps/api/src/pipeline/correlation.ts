import { sortByTime } from './derivatives.js';
import { mean, pearsonCorr, toFloat } from './scoring.js';

export interface PriceBar {
  time: number;
  close: number;
}

/** Sorted {time, close} bars from raw CoinGlass candles; drops rows with non-finite time/close or close <= 0. */
export function closeSeries(candles: Array<Record<string, unknown>>): PriceBar[] {
  const bars: PriceBar[] = [];
  for (const candle of sortByTime(candles)) {
    const time = toFloat(candle.time);
    const close = toFloat(candle.close);
    if (time === null || close === null || close <= 0) {
      continue;
    }
    bars.push({ time, close });
  }
  return bars;
}

/** Period-over-period simple returns keyed by the CLOSING bar's timestamp. Only emits a return when
 *  consecutive bars are exactly one interval apart, so a dropped/missing candle cannot turn a
 *  multi-period move into a mislabeled single-period return that would skew the paired correlation. */
export function returnsByTime(bars: PriceBar[]): Map<number, number> {
  const step = baseInterval(bars);
  if (step === null) {
    return new Map();
  }
  return pairedReturns(bars, step);
}

/** Shared by `returnsByTime` and `returnStats`: pairs consecutive bars exactly `step` apart. */
function pairedReturns(bars: PriceBar[], step: number): Map<number, number> {
  const returns = new Map<number, number>();
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1] as PriceBar;
    const current = bars[index] as PriceBar;
    if (previous.close <= 0 || current.time - previous.time !== step) {
      continue;
    }
    returns.set(current.time, (current.close - previous.close) / previous.close);
  }
  return returns;
}

/** Smallest positive gap between consecutive (sorted) bars — the true candle interval when nothing was dropped. */
function baseInterval(bars: PriceBar[]): number | null {
  let step: number | null = null;
  for (let index = 1; index < bars.length; index += 1) {
    const delta = (bars[index] as PriceBar).time - (bars[index - 1] as PriceBar).time;
    if (delta > 0 && (step === null || delta < step)) {
      step = delta;
    }
  }
  return step;
}

// Mirrors derivatives.ts's INTERVAL_HOURS/intervalHours convention (not exported there, so
// duplicated here rather than reaching into an unrelated module for a private helper).
const INTERVAL_HOURS: Record<string, number> = {
  '1m': 1.0 / 60.0,
  '3m': 3.0 / 60.0,
  '5m': 5.0 / 60.0,
  '15m': 15.0 / 60.0,
  '30m': 0.5,
  '1h': 1.0,
  '4h': 4.0,
  '6h': 6.0,
  '8h': 8.0,
  '12h': 12.0,
  '1d': 24.0,
  '1w': 24.0 * 7.0,
};

/**
 * Resolves the pairing step for a bar series, anchoring to the configured candle interval when the
 * timestamps look like a real epoch. Plain min-delta inference (kept below as an explicit,
 * documented fallback for small synthetic timestamps, e.g. test fixtures) silently mis-infers the
 * interval when a series is missing every other candle: a coin dropping every second 4h candle has
 * a min gap of 8h, so naive inference reports "8h" and pairs 8h-vs-4h returns against BTC's real 4h
 * series.
 *
 * CoinGlass's docs describe candle timestamps as epoch milliseconds, but that was NOT verified
 * live in this environment (no API key) -- hence detecting the unit by magnitude, not assuming ms.
 */
function resolveStep(
  bars: PriceBar[],
  interval?: string,
): { step: number | null; gapped: boolean } {
  const inferred = baseInterval(bars);
  const first = bars[0];
  if (inferred === null || !interval || first === undefined) {
    return { step: inferred, gapped: false };
  }
  // Below 1e8 is not a plausible epoch stamp (ms or s) -- treat it as a synthetic/test fixture and
  // keep the historic min-delta inference rather than guessing a unit.
  if (first.time < 1e8) {
    return { step: inferred, gapped: false };
  }
  const unitMs = first.time >= 1e11; // >= 1e11 -> epoch-ms; [1e8, 1e11) -> epoch-seconds.
  const hours = INTERVAL_HOURS[interval] ?? 24.0;
  const anchored = unitMs ? hours * 3_600_000 : hours * 3_600;
  const drift = Math.abs(inferred - anchored) / anchored;
  if (drift > 0.05) {
    return { step: anchored, gapped: true };
  }
  return { step: inferred, gapped: false };
}

/** Gap-anchored returns for one series: `returnsByTime` plus whether anchoring overrode the
 *  min-delta step (see `resolveStep`). Only `returnStats` needs the override signal. */
function returnsFor(
  bars: PriceBar[],
  interval?: string,
): { returns: Map<number, number>; gapped: boolean } {
  const resolved = resolveStep(bars, interval);
  if (resolved.step === null) {
    return { returns: new Map(), gapped: false };
  }
  return { returns: pairedReturns(bars, resolved.step), gapped: resolved.gapped };
}

export interface ReturnStats {
  correlation: number | null;
  beta: number | null;
  pairs: number;
  gapped: boolean;
}

/** cov(xValues, yValues) / var(yValues); null if yValues has zero variance. Consumes the same
 *  paired values `pearsonCorr` uses rather than re-deriving the pairing a second time. */
function betaOf(xValues: number[], yValues: number[]): number | null {
  const xAvg = mean(xValues);
  const yAvg = mean(yValues);
  let covariance = 0;
  let varianceY = 0;
  for (let index = 0; index < xValues.length; index += 1) {
    const x = xValues[index] as number;
    const y = yValues[index] as number;
    covariance += (x - xAvg) * (y - yAvg);
    varianceY += (y - yAvg) ** 2;
  }
  return varianceY === 0 ? null : covariance / varianceY;
}

/** Pearson correlation AND beta (cov(a,b)/var(b)) of two symbols' close-price series over their
 *  shared, gap-anchored return timestamps -- one paired pass feeds both. Both are null when fewer
 *  than minPairs shared points survive or `seriesB`'s return variance is 0. `interval` (e.g. '4h')
 *  anchors gap detection; see `resolveStep`. */
export function returnStats(
  seriesA: PriceBar[],
  seriesB: PriceBar[],
  minPairs: number,
  interval?: string,
): ReturnStats {
  const a = returnsFor(seriesA, interval);
  const b = returnsFor(seriesB, interval);
  const gapped = a.gapped || b.gapped;

  const xValues: number[] = [];
  const yValues: number[] = [];
  for (const [time, x] of a.returns) {
    const y = b.returns.get(time);
    if (y !== undefined) {
      xValues.push(x);
      yValues.push(y);
    }
  }

  const pairs = xValues.length;
  if (pairs < minPairs) {
    return { correlation: null, beta: null, pairs, gapped };
  }

  return {
    correlation: pearsonCorr(xValues, yValues),
    beta: betaOf(xValues, yValues),
    pairs,
    gapped,
  };
}

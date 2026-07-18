import { sortByTime } from './derivatives.js';
import { clamp, mean, pyRound, stdev, toFloat } from './scoring.js';

export type RawCandle = Record<string, unknown>;

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

interface Macd {
  line: number | null;
  signal: number | null;
  histogram: number | null;
}

interface Bollinger {
  mid: number | null;
  upper: number | null;
  lower: number | null;
  position: number | null;
  widthPct: number | null;
}

interface Donchian {
  high: number | null;
  low: number | null;
}

interface GoldenPocket {
  legHigh: number | null;
  legLow: number | null;
  direction: 'up' | 'down' | null;
  upper: number | null;
  lower: number | null;
  distancePct: number | null;
}

interface EmaCross {
  direction: 'bullish' | 'bearish' | null;
  barsSince: number | null;
}

interface Divergence {
  direction: 'bearish' | 'bullish' | null;
  strength: number | null;
}

export function technicalSnapshot(candles: RawCandle[], interval: string): Record<string, unknown> {
  const series = normalizeCandles(candles);
  const closes = series.map((item) => item.close);
  const highs = series.map((item) => item.high);
  const lows = series.map((item) => item.low);
  const volumes = series.map((item) => item.volume);
  if (closes.length < 50) {
    return {};
  }

  const close = closes.at(-1) as number;
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema20 = ema20Series.length ? (ema20Series.at(-1) as number) : null;
  const ema50 = ema50Series.length ? (ema50Series.at(-1) as number) : null;
  const ema200 = lastEma(closes, 200);
  const rsiValues = rsiSeries(closes, 14);
  const rsi14 = rsiValues.at(-1) ?? null;
  const macd = macdOf(closes);
  const atr14 = atr(highs, lows, closes, 14);
  const bollinger = bollingerBands(closes, 20);

  const distanceEma20Pct = pctDistance(close, ema20);
  const atr14Pct = atr14 !== null && close > 0 ? (atr14 / close) * 100.0 : null;
  const macdHist = macd.histogram;
  const macdHistPct = macdHist !== null && close > 0 ? (macdHist / close) * 100.0 : null;
  const trendScore = trendScoreOf(close, ema20, ema50, ema200);
  const momentumScore = momentumScoreOf(rsi14, macdHistPct);
  const setup = technicalSetup(
    trendScore,
    rsi14,
    bollinger.position,
    distanceEma20Pct,
    bollinger.widthPct,
  );

  const donchian = donchianRange(highs, lows, DONCHIAN_PERIOD);
  const emaCross = emaCrossOf(ema20Series, ema50Series, EMA_CROSS_LOOKBACK_BARS);
  const divergence = divergenceOf(closes, rsiValues);
  const goldenPocketZone = goldenPocket(closes);

  return {
    technical_interval: interval,
    technical_candle_count: series.length,
    technical_close: close,
    ema_20: ema20,
    ema_50: ema50,
    ema_200: ema200,
    distance_ema20_pct: distanceEma20Pct,
    rsi_14: rsi14,
    macd_line: macd.line,
    macd_signal: macd.signal,
    macd_histogram: macd.histogram,
    macd_histogram_pct: macdHistPct,
    atr_14: atr14,
    atr_14_pct: atr14Pct,
    bb_mid: bollinger.mid,
    bb_upper: bollinger.upper,
    bb_lower: bollinger.lower,
    bb_position: bollinger.position,
    bb_width_pct: bollinger.widthPct,
    technical_trend_score: trendScore,
    technical_momentum_score: momentumScore,
    technical_setup: setup,
    trend_state: trendStateOf(setup, trendScore),
    breakout_pct_20: breakoutPct(close, donchian.high),
    breakdown_pct_20: breakdownPct(close, donchian.low),
    donchian_position_20: donchianPosition(close, donchian.high, donchian.low),
    donchian_high_20: donchian.high,
    donchian_low_20: donchian.low,
    breakout_volume_ratio_20: breakoutVolumeRatio(volumes, DONCHIAN_PERIOD),
    ema_cross_direction: emaCross.direction,
    ema_cross_bars_since: emaCross.barsSince,
    technical_divergence: divergence.direction,
    technical_divergence_strength: divergence.strength,
    fib_leg_high: goldenPocketZone.legHigh,
    fib_leg_low: goldenPocketZone.legLow,
    fib_leg_direction: goldenPocketZone.direction,
    golden_pocket_upper: goldenPocketZone.upper,
    golden_pocket_lower: goldenPocketZone.lower,
    distance_to_golden_pocket_pct: goldenPocketZone.distancePct,
  };
}

function normalizeCandles(candles: RawCandle[]): Candle[] {
  const sorted = sortByTime(candles);
  const normalized: Candle[] = [];
  for (const candle of sorted) {
    const open = toFloat(candle.open);
    const high = toFloat(candle.high);
    const low = toFloat(candle.low);
    const close = toFloat(candle.close);
    if (open === null || high === null || low === null || close === null) {
      continue;
    }
    if (Math.min(open, high, low, close) <= 0) {
      continue;
    }
    // Older fixtures/history rows may lack volume_usd; keep the candle, just null out its volume.
    normalized.push({ open, high, low, close, volume: toFloat(candle.volume_usd) });
  }
  return normalized;
}

function lastEma(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series.length ? (series.at(-1) as number) : null;
}

// Seeded from the SMA of the first `period` values, not the first single value (matches RSI/ATR below).
function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) {
    return [];
  }
  const alpha = 2.0 / (period + 1.0);
  let ema = mean(values.slice(0, period));
  const result = [ema];
  for (const value of values.slice(period)) {
    ema = value * alpha + ema * (1.0 - alpha);
    result.push(ema);
  }
  return result;
}

// Wilder smoothing: seeded from the mean of the first `period` values, then avg = (avg*(period-1)+next)/period.
function wilderSmooth(values: number[], period: number): number {
  let value = mean(values.slice(0, period));
  for (const next of values.slice(period)) {
    value = (value * (period - 1) + next) / period;
  }
  return value;
}

// Same recurrence as wilderSmooth, kept as a full series (matches emaSeries) so callers -- rsi_14
// (via its last value) and the divergence detector (via the full lookback) -- share one computation.
function wilderSmoothSeries(values: number[], period: number): number[] {
  if (values.length < period) {
    return [];
  }
  let value = mean(values.slice(0, period));
  const result = [value];
  for (const next of values.slice(period)) {
    value = (value * (period - 1) + next) / period;
    result.push(value);
  }
  return result;
}

// Full Wilder-smoothed RSI series; technicalSnapshot() computes this once and derives rsi_14 from
// its last value directly, rather than recomputing via a separate scalar helper -- see
// technicals.test.ts for the pinned equivalence check.
export function rsiSeries(values: number[], period: number): number[] {
  if (values.length <= period) {
    return [];
  }
  const gains: number[] = [];
  const losses: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const delta = (values[index] as number) - (values[index - 1] as number);
    gains.push(Math.max(delta, 0.0));
    losses.push(Math.abs(Math.min(delta, 0.0)));
  }
  const avgGains = wilderSmoothSeries(gains, period);
  const avgLosses = wilderSmoothSeries(losses, period);
  return avgGains.map((avgGain, index) => {
    const avgLoss = avgLosses[index] as number;
    if (avgLoss === 0) {
      return 100.0;
    }
    const rs = avgGain / avgLoss;
    return 100.0 - 100.0 / (1.0 + rs);
  });
}

function macdOf(values: number[]): Macd {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  if (ema12.length === 0 || ema26.length === 0) {
    return { line: null, signal: null, histogram: null };
  }
  const alignedEma12 = ema12.slice(ema12.length - ema26.length);
  const line = alignedEma12.map((fast, index) => fast - (ema26[index] as number));
  const signalSeries = emaSeries(line, 9);
  if (signalSeries.length === 0) {
    return { line: line.at(-1) as number, signal: null, histogram: null };
  }
  const signal = signalSeries.at(-1) as number;
  const latestLine = line.at(-1) as number;
  return { line: latestLine, signal, histogram: latestLine - signal };
}

function atr(highs: number[], lows: number[], closes: number[], period: number): number | null {
  if (closes.length <= period) {
    return null;
  }
  const ranges: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const high = highs[index] as number;
    const low = lows[index] as number;
    const previousClose = closes[index - 1] as number;
    ranges.push(
      Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)),
    );
  }
  return wilderSmooth(ranges, period);
}

function bollingerBands(values: number[], period: number): Bollinger {
  if (values.length < period) {
    return { mid: null, upper: null, lower: null, position: null, widthPct: null };
  }
  const window = values.slice(-period);
  const mid = mean(window);
  const std = stdev(window);
  const upper = mid + std * 2.0;
  const lower = mid - std * 2.0;
  const width = upper - lower;
  const close = values.at(-1) as number;
  const position = width > 0 ? (close - lower) / width : null;
  const widthPct = mid > 0 ? (width / mid) * 100.0 : null;
  return { mid, upper, lower, position, widthPct };
}

function pctDistance(value: number, reference: number | null): number | null {
  if (reference === null || reference === 0) {
    return null;
  }
  return ((value - reference) / reference) * 100.0;
}

function trendScoreOf(
  close: number,
  ema20: number | null,
  ema50: number | null,
  ema200: number | null,
): number | null {
  if (ema20 === null || ema50 === null) {
    return null;
  }
  let score = 0.0;
  score += close >= ema20 ? 0.35 : -0.35;
  score += ema20 >= ema50 ? 0.35 : -0.35;
  if (ema200 !== null) {
    score += ema50 >= ema200 ? 0.3 : -0.3;
  }
  return clamp(score, -1.0, 1.0);
}

function momentumScoreOf(rsi14: number | null, macdHistPct: number | null): number | null {
  if (rsi14 === null && macdHistPct === null) {
    return null;
  }
  const rsiComponent = rsi14 === null ? 0.0 : clamp((rsi14 - 50.0) / 25.0, -1.0, 1.0);
  const macdComponent = macdHistPct === null ? 0.0 : clamp(macdHistPct / 0.35, -1.0, 1.0);
  return clamp(rsiComponent * 0.45 + macdComponent * 0.55, -1.0, 1.0);
}

// A trend score at or beyond this magnitude counts as directionally decisive rather than mixed --
// shared by technicalSetup()'s continuation/pullback labels and trendStateOf()'s Compression Watch
// tie-break. 0.55 reuses trendScoreOf's own existing threshold.
const TREND_SCORE_THRESHOLD = 0.55;

function technicalSetup(
  trendScore: number | null,
  rsi14: number | null,
  bbPosition: number | null,
  distanceEma20Pct: number | null,
  bbWidthPct: number | null,
): string {
  if (rsi14 !== null && bbPosition !== null) {
    if (rsi14 >= 72 && bbPosition >= 0.9) {
      return 'Upside Exhaustion';
    }
    if (rsi14 <= 28 && bbPosition <= 0.1) {
      return 'Downside Exhaustion';
    }
  }
  if (bbWidthPct !== null && bbWidthPct <= 4.0) {
    return 'Compression Watch';
  }
  if (trendScore !== null && trendScore >= TREND_SCORE_THRESHOLD) {
    return distanceEma20Pct !== null && distanceEma20Pct < 0
      ? 'Pullback Into Uptrend'
      : 'Trend Continuation';
  }
  if (trendScore !== null && trendScore <= -TREND_SCORE_THRESHOLD) {
    return distanceEma20Pct !== null && distanceEma20Pct > 0
      ? 'Rally Into Downtrend'
      : 'Downtrend Continuation';
  }
  return 'Mixed Technicals';
}

// technicalSetup checks BB-width compression BEFORE trend, so a trending coin mid-digestion is
// labeled 'Compression Watch' -- the label is honest (it IS compressed), but a membership gate must
// not read it as chop. TREND_SCORE_THRESHOLD reuses trendScoreOf's own existing threshold. Pure
// function of the label technicalSetup() already produces, so the labels above stay byte-identical.
export function trendStateOf(
  setup: string,
  trendScore: number | null,
): 'uptrend' | 'downtrend' | 'chop' | 'exhaustion_top' | 'exhaustion_bottom' {
  switch (setup) {
    case 'Trend Continuation':
    case 'Pullback Into Uptrend':
      return 'uptrend';
    case 'Downtrend Continuation':
    case 'Rally Into Downtrend':
      return 'downtrend';
    case 'Upside Exhaustion':
      return 'exhaustion_top';
    case 'Downside Exhaustion':
      return 'exhaustion_bottom';
    case 'Compression Watch':
      if (trendScore !== null && trendScore >= TREND_SCORE_THRESHOLD) {
        return 'uptrend';
      }
      if (trendScore !== null && trendScore <= -TREND_SCORE_THRESHOLD) {
        return 'downtrend';
      }
      return 'chop';
    default:
      return 'chop';
  }
}

// Textbook Donchian(20); 20 bars = 3.3 days at 4h.
export const DONCHIAN_PERIOD = 20;

// Prior `period` bars, excluding the current bar -- a breakout must clear a range it wasn't part of.
export function donchianRange(highs: number[], lows: number[], period: number): Donchian {
  if (highs.length < period + 1) {
    return { high: null, low: null };
  }
  const priorHighs = highs.slice(-(period + 1), -1);
  const priorLows = lows.slice(-(period + 1), -1);
  return { high: Math.max(...priorHighs), low: Math.min(...priorLows) };
}

export function breakoutPct(close: number, donchianHigh: number | null): number | null {
  if (donchianHigh === null) {
    return null;
  }
  return pyRound(close > donchianHigh ? ((close - donchianHigh) / donchianHigh) * 100.0 : 0.0, 4);
}

export function breakdownPct(close: number, donchianLow: number | null): number | null {
  if (donchianLow === null) {
    return null;
  }
  return pyRound(close < donchianLow ? ((donchianLow - close) / donchianLow) * 100.0 : 0.0, 4);
}

// close can exceed the prior range on either side, so this is clamped rather than assumed in [0,1].
export function donchianPosition(
  close: number,
  donchianHigh: number | null,
  donchianLow: number | null,
): number | null {
  if (donchianHigh === null || donchianLow === null || donchianHigh === donchianLow) {
    return null;
  }
  return pyRound(clamp((close - donchianLow) / (donchianHigh - donchianLow), 0.0, 1.0), 4);
}

// Display-only: never feeds scoring. Missing volume (older fixtures lack volume_usd) nulls the ratio
// rather than silently excluding bars from the average.
export function breakoutVolumeRatio(volumes: Array<number | null>, period: number): number | null {
  if (volumes.length < period + 1) {
    return null;
  }
  const latest = volumes.at(-1) as number | null;
  const priorWindow = volumes.slice(-(period + 1), -1);
  if (latest === null || priorWindow.some((value) => value === null)) {
    return null;
  }
  const priorMean = mean(priorWindow as number[]);
  if (priorMean === 0) {
    return null;
  }
  return pyRound(latest / priorMean, 2);
}

// 30 bars = 5 days at 4h, same order as the 3-day stretch window. +1 so the oldest bar in the window
// still has a predecessor to diff against (30 bars of lookback needs 31 diff points).
export const EMA_CROSS_LOOKBACK_BARS = 30;

// Display-only, no score wiring. Scans backward for the most recent flip of sign(ema20-ema50); a
// value of exactly 0 is bucketed with the >=0 (bullish) side, matching trendScoreOf's own >= convention.
export function emaCrossOf(ema20: number[], ema50: number[], lookbackBars: number): EmaCross {
  const length = Math.min(ema20.length, ema50.length);
  const alignedEma20 = ema20.slice(ema20.length - length);
  const alignedEma50 = ema50.slice(ema50.length - length);
  const diff = alignedEma20.map((fast, index) => fast - (alignedEma50[index] as number));
  const window = diff.slice(-(lookbackBars + 1));
  for (let index = window.length - 1; index >= 1; index -= 1) {
    const currentSign = (window[index] as number) >= 0 ? 1 : -1;
    const previousSign = (window[index - 1] as number) >= 0 ? 1 : -1;
    if (currentSign !== previousSign) {
      return {
        direction: currentSign > 0 ? 'bullish' : 'bearish',
        barsSince: window.length - 1 - index,
      };
    }
  }
  return { direction: null, barsSince: null };
}

// 12h per side at 4h bars; ties (equal to a neighbor) are not a swing.
export const SWING_HALF_WINDOW = 3;
// 15 days at 4h.
export const DIVERGENCE_LOOKBACK_BARS = 90;
// 32h at 4h bars.
export const MIN_SWING_SEPARATION_BARS = 8;
// 2 days at 4h; a divergence this stale no longer describes the current tape.
export const DIVERGENCE_ACTIVE_BARS = 12;

function isSwingHigh(closes: number[], index: number): boolean {
  const value = closes[index] as number;
  for (let offset = 1; offset <= SWING_HALF_WINDOW; offset += 1) {
    if (
      (closes[index - offset] as number) >= value ||
      (closes[index + offset] as number) >= value
    ) {
      return false;
    }
  }
  return true;
}

function isSwingLow(closes: number[], index: number): boolean {
  const value = closes[index] as number;
  for (let offset = 1; offset <= SWING_HALF_WINDOW; offset += 1) {
    if (
      (closes[index - offset] as number) <= value ||
      (closes[index + offset] as number) <= value
    ) {
      return false;
    }
  }
  return true;
}

// Confirmed swings only: the last SWING_HALF_WINDOW bars can't be confirmed yet (no trailing bars to
// compare against), so they're excluded from the search range.
function findSwingIndices(
  closes: number[],
  isSwing: (closes: number[], index: number) => boolean,
): number[] {
  const start = Math.max(SWING_HALF_WINDOW, closes.length - DIVERGENCE_LOOKBACK_BARS);
  const end = closes.length - 1 - SWING_HALF_WINDOW;
  const indices: number[] = [];
  for (let index = start; index <= end; index += 1) {
    if (isSwing(closes, index)) {
      indices.push(index);
    }
  }
  return indices;
}

// The two most recent swings at least MIN_SWING_SEPARATION_BARS apart; null if fewer than two qualify.
function latestSwingPair(indices: number[]): [number, number] | null {
  if (indices.length < 2) {
    return null;
  }
  const recent = indices[indices.length - 1] as number;
  for (let index = indices.length - 2; index >= 0; index -= 1) {
    const candidate = indices[index] as number;
    if (recent - candidate >= MIN_SWING_SEPARATION_BARS) {
      return [candidate, recent];
    }
  }
  return null;
}

// Display-only, no score wiring. rsiValues is rsiSeries(closes, 14); its last element aligns with
// closes' last element, offset by the RSI period at the start (rsiValues has no entry for the first
// `period` closes).
export function divergenceOf(closes: number[], rsiValues: number[]): Divergence {
  const rsiOffset = closes.length - rsiValues.length;
  const rsiAt = (index: number): number | null => {
    const rsiIndex = index - rsiOffset;
    return rsiIndex >= 0 && rsiIndex < rsiValues.length ? (rsiValues[rsiIndex] as number) : null;
  };
  const lastIndex = closes.length - 1;

  const bearishPair = latestSwingPair(findSwingIndices(closes, isSwingHigh));
  if (bearishPair !== null) {
    const [p1, p2] = bearishPair;
    const rsi1 = rsiAt(p1);
    const rsi2 = rsiAt(p2);
    if (
      rsi1 !== null &&
      rsi2 !== null &&
      (closes[p2] as number) > (closes[p1] as number) &&
      rsi2 < rsi1 &&
      rsi2 > 50 &&
      lastIndex - p2 <= DIVERGENCE_ACTIVE_BARS
    ) {
      return {
        direction: 'bearish',
        strength: pyRound(clamp(Math.abs(rsi1 - rsi2) / 10.0, 0.0, 1.0), 2),
      };
    }
  }

  const bullishPair = latestSwingPair(findSwingIndices(closes, isSwingLow));
  if (bullishPair !== null) {
    const [p1, p2] = bullishPair;
    const rsi1 = rsiAt(p1);
    const rsi2 = rsiAt(p2);
    if (
      rsi1 !== null &&
      rsi2 !== null &&
      (closes[p2] as number) < (closes[p1] as number) &&
      rsi2 > rsi1 &&
      rsi2 < 50 &&
      lastIndex - p2 <= DIVERGENCE_ACTIVE_BARS
    ) {
      return {
        direction: 'bullish',
        strength: pyRound(clamp(Math.abs(rsi1 - rsi2) / 10.0, 0.0, 1.0), 2),
      };
    }
  }

  return { direction: null, strength: null };
}

// Display-only, no score wiring. Fib 0.5-0.618 retracement zone of the latest confirmed swing leg
// on `closes`, for trading golden-pocket pullbacks at absolute S/R. Reuses the same swing
// detection as divergenceOf (isSwingHigh/isSwingLow/findSwingIndices), but takes the single most
// recent confirmed high and independently the single most recent confirmed low -- not a matched
// pair -- since a leg needs only its two endpoints, not MIN_SWING_SEPARATION_BARS between them.
export function goldenPocket(closes: number[]): GoldenPocket {
  const empty: GoldenPocket = {
    legHigh: null,
    legLow: null,
    direction: null,
    upper: null,
    lower: null,
    distancePct: null,
  };
  const highIndices = findSwingIndices(closes, isSwingHigh);
  const lowIndices = findSwingIndices(closes, isSwingLow);
  if (highIndices.length === 0 || lowIndices.length === 0) {
    return empty;
  }
  const highIndex = highIndices.at(-1) as number;
  const lowIndex = lowIndices.at(-1) as number;
  const legHigh = closes[highIndex] as number;
  const legLow = closes[lowIndex] as number;
  const range = legHigh - legLow;
  if (range <= 0) {
    return empty;
  }
  // Swing high more recent than swing low -> impulse up, pullback expected down into the zone.
  const direction: 'up' | 'down' = highIndex > lowIndex ? 'up' : 'down';
  const upper = direction === 'up' ? legHigh - 0.5 * range : legLow + 0.618 * range;
  const lower = direction === 'up' ? legHigh - 0.618 * range : legLow + 0.5 * range;
  const close = closes.at(-1) as number;
  const distancePct =
    close > upper ? pctDistance(close, upper) : close < lower ? pctDistance(close, lower) : 0;
  return { legHigh, legLow, direction, upper, lower, distancePct };
}

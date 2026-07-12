import { sortByTime } from './derivatives.js';
import { clamp, mean, stdev, toFloat } from './scoring.js';

export type RawCandle = Record<string, unknown>;

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
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

export function technicalSnapshot(candles: RawCandle[], interval: string): Record<string, unknown> {
  const series = normalizeCandles(candles);
  const closes = series.map((item) => item.close);
  const highs = series.map((item) => item.high);
  const lows = series.map((item) => item.low);
  if (closes.length < 50) {
    return {};
  }

  const close = closes.at(-1) as number;
  const ema20 = lastEma(closes, 20);
  const ema50 = lastEma(closes, 50);
  const ema200 = lastEma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macd = macdOf(closes);
  const atr14 = atr(highs, lows, closes, 14);
  const bollinger = bollingerBands(closes, 20);

  const distanceEma20Pct = pctDistance(close, ema20);
  const atr14Pct = atr14 !== null && close > 0 ? (atr14 / close) * 100.0 : null;
  const macdHist = macd.histogram;
  const macdHistPct = macdHist !== null && close > 0 ? (macdHist / close) * 100.0 : null;
  const trendScore = trendScoreOf(close, ema20, ema50, ema200);
  const momentumScore = momentumScoreOf(rsi14, macdHistPct);

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
    technical_setup: technicalSetup(
      trendScore,
      rsi14,
      bollinger.position,
      distanceEma20Pct,
      bollinger.widthPct,
    ),
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
    normalized.push({ open, high, low, close });
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

function rsi(values: number[], period: number): number | null {
  if (values.length <= period) {
    return null;
  }
  const gains: number[] = [];
  const losses: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const delta = (values[index] as number) - (values[index - 1] as number);
    gains.push(Math.max(delta, 0.0));
    losses.push(Math.abs(Math.min(delta, 0.0)));
  }
  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);
  if (avgLoss === 0) {
    return 100.0;
  }
  const rs = avgGain / avgLoss;
  return 100.0 - 100.0 / (1.0 + rs);
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
  if (trendScore !== null && trendScore >= 0.55) {
    return distanceEma20Pct !== null && distanceEma20Pct < 0
      ? 'Pullback Into Uptrend'
      : 'Trend Continuation';
  }
  if (trendScore !== null && trendScore <= -0.55) {
    return distanceEma20Pct !== null && distanceEma20Pct > 0
      ? 'Rally Into Downtrend'
      : 'Downtrend Continuation';
  }
  return 'Mixed Technicals';
}

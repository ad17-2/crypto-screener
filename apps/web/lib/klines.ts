import type { DashboardRow } from '@crypto-screener/contracts';

/**
 * Pure logic behind the coin-detail candlestick chart (CoinChart.tsx) -- split out because .tsx
 * can't be imported by vitest under this repo's `jsx: "preserve"` tsconfig (see
 * apps/web/tests/golden-pocket-watch-stage.test.ts), matching how golden-pocket-watch.ts/
 * dashboard-row.ts already split testable logic out of their components.
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ChartInterval = '15m' | '1h' | '4h';

/** Offered by the interval switcher; the API route (apps/api/src/http/routes/klines.ts) whitelists the same three. */
export const CHART_INTERVALS: readonly ChartInterval[] = ['15m', '1h', '4h'];

/**
 * 4h, to match the rest of the rail rather than his entry timeframe. Everything the screener
 * computes and every level this chart draws on top is 4h -- technical_state.technical_interval,
 * the "Chart read (4h)" and "Levels (4h)" sections, and the golden pocket band itself, which comes
 * off one specific 4h swing leg. Opening on 1h showed the band's price but not the leg it was
 * measured from; at KLINE_LIMIT candles, 4h spans ~33 days instead of ~8, so that leg is actually
 * on screen. He trades 1H/15M (see trading-style memory) and both stay one click away in the
 * switcher -- this is about what the screener saw, not where he enters.
 */
export const DEFAULT_CHART_INTERVAL: ChartInterval = '4h';

/**
 * GET /api/klines already returns `time` in seconds (Lightweight Charts' native unit) -- this is a
 * defensive normalization only, in case a value ever arrives at Binance's native milliseconds
 * scale. Seconds-since-epoch stays comfortably below 1e11 until the year 5138; ms-since-epoch is
 * already past 1e12 today, so this threshold cleanly separates the two without false positives.
 */
function normalizeTimeSeconds(value: number): number {
  return value > 1e11 ? Math.floor(value / 1000) : value;
}

function toCandle(entry: unknown): Candle | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const time = Number(record.time);
  const open = Number(record.open);
  const high = Number(record.high);
  const low = Number(record.low);
  const close = Number(record.close);
  if (![time, open, high, low, close].every((value) => Number.isFinite(value))) return null;
  return { time: normalizeTimeSeconds(time), open, high, low, close };
}

/**
 * Parses GET /api/klines' JSON body into typed candles for the chart series. A malformed entry is
 * dropped rather than thrown on, so one bad candle can't blank the whole chart; a non-array body
 * (an error payload, say) yields an empty series instead of throwing.
 */
export function parseKlinesResponse(json: unknown): Candle[] {
  if (!Array.isArray(json)) return [];
  const candles: Candle[] = [];
  for (const entry of json) {
    const candle = toCandle(entry);
    if (candle) candles.push(candle);
  }
  return candles;
}

export interface ChartGoldenPocket {
  lower: number;
  upper: number;
}

/**
 * Selects the screener's own computed 4h golden pocket to draw on the chart, mirroring
 * LevelsBlock's null handling in SelectedCoinRail.tsx: the band only renders when both bounds are
 * present (it's a band, not two independent lines). This is the *only* level still drawn as a flat
 * line -- it's the only one that's genuinely horizontal, since it derives from one specific 4h
 * swing leg rather than a rolling window. EMA/Donchian used to be drawn this way too (flat,
 * labeled "(4h)"), which misrepresented three months of history as a constant; they're now
 * computed client-side from the displayed candles instead -- see computeEma/computeDonchian below
 * and CoinChart.tsx.
 */
export function selectGoldenPocket(
  state: DashboardRow['technical_state'],
): ChartGoldenPocket | null {
  return state.golden_pocket_lower != null && state.golden_pocket_upper != null
    ? { lower: state.golden_pocket_lower, upper: state.golden_pocket_upper }
    : null;
}

/**
 * Precision/step Lightweight Charts needs for its `priceFormat` (candles, price lines, and any
 * line series), derived with the exact same magnitude thresholds fmtPrice (apps/web/lib/format.ts)
 * uses for display elsewhere on the dashboard -- so the chart and the Levels (4h) section can never
 * disagree about how many decimals a coin needs. A sub-dollar coin like ZIL (~$0.008) rendered
 * every level as "0.00" under the library's default 2dp formatting before this existed. Keep this
 * in sync with fmtPrice's thresholds by hand -- there's no shared constant to import across the two
 * modules' different return shapes (a formatted string vs. {precision, minMove}).
 */
export function derivePriceFormat(price: number): { precision: number; minMove: number } {
  const abs = Math.abs(price);
  const precision = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  // 1 / 10 ** precision, not 10 ** -precision -- the latter is imprecise for negative exponents
  // (10 ** -4 === 0.00009999999999999999 in JS) and lightweight-charts uses minMove verbatim.
  return { precision, minMove: 1 / 10 ** precision };
}

/** A single {time, value} point on a client-computed line series (EMA, Donchian bound). */
export interface LinePoint {
  time: number;
  value: number;
}

/**
 * EMA periods drawn on the chart, shortest to longest. A period-N EMA needs meaningfully more
 * than N candles to draw a visible line (period===candles.length yields exactly one seed point,
 * not a line) -- at KLINE_LIMIT=200 (CoinChart.tsx) only 20 and 50 qualify. Anyone raising this
 * must raise KLINE_LIMIT past the new max period first; do not raise KLINE_LIMIT just to keep a
 * longer EMA, since more candles on a 260px-tall chart makes it less readable, not more.
 */
export const EMA_PERIODS: readonly number[] = [20, 50];

/**
 * Standard EMA: SMA seed over the first `period` closes, then k = 2/(period+1),
 * ema = close*k + prev*(1-k). Returns [] when there aren't enough candles for even the seed
 * window -- the caller must skip the line entirely rather than draw a truncated or wrong one; a
 * partial EMA misrepresents history the same way the flat line it replaces did.
 */
export function computeEma(candles: readonly Candle[], period: number): LinePoint[] {
  if (period <= 0 || candles.length < period) return [];
  let sum = 0;
  for (const candle of candles.slice(0, period)) sum += candle.close;
  let prev = sum / period;
  const seed = candles[period - 1] as Candle; // safe: length >= period was just checked above
  const points: LinePoint[] = [{ time: seed.time, value: prev }];
  const k = 2 / (period + 1);
  for (const candle of candles.slice(period)) {
    prev = candle.close * k + prev * (1 - k);
    points.push({ time: candle.time, value: prev });
  }
  return points;
}

/** Matches technical_state's rolling window (donchian_high_20/donchian_low_20). */
export const DONCHIAN_PERIOD = 20;

export interface DonchianPoint {
  time: number;
  high: number;
  low: number;
}

/**
 * Rolling `period`-candle high/low, drawn as a channel that moves with price -- a single flat
 * Donchian line (the pre-fix behaviour) misrepresents a rolling-window value the same way a flat
 * EMA does. Returns [] when there aren't enough candles for even one window.
 */
export function computeDonchian(candles: readonly Candle[], period: number): DonchianPoint[] {
  if (period <= 0 || candles.length < period) return [];
  const points: DonchianPoint[] = [];
  for (const [i, candle] of candles.entries()) {
    if (i < period - 1) continue;
    let high = -Infinity;
    let low = Infinity;
    for (const bar of candles.slice(i - period + 1, i + 1)) {
      if (bar.high > high) high = bar.high;
      if (bar.low < low) low = bar.low;
    }
    points.push({ time: candle.time, high, low });
  }
  return points;
}

/** One row in the chart's header legend -- a swatch (styled by the component) plus this label. */
export interface ChartLegendEntry {
  key: string;
  label: string;
}

/**
 * Which series actually drew this render, in prominence order (EMA 20, EMA 50, Donchian, golden
 * pocket) -- an EMA whose seed window didn't fit the fetched candles, an empty Donchian channel,
 * or no golden pocket for this row are all skipped rather than shown as a dead legend entry.
 * Interval labeling (e.g. "(1h)") and swatch colors are the component's job (theme-dependent,
 * and shown once for the EMA/Donchian cluster rather than per entry) -- this only decides which
 * entries exist and in what order.
 */
export function buildChartLegendEntries(
  emaSeries: readonly { period: number; points: readonly LinePoint[] }[],
  donchianPoints: readonly DonchianPoint[],
  goldenPocket: ChartGoldenPocket | null,
): ChartLegendEntry[] {
  const entries: ChartLegendEntry[] = [];
  for (const { period, points } of emaSeries) {
    if (points.length === 0) continue;
    entries.push({ key: `ema-${period}`, label: `EMA ${period}` });
  }
  if (donchianPoints.length > 0) {
    entries.push({ key: 'donchian', label: `Donchian ${DONCHIAN_PERIOD}` });
  }
  if (goldenPocket) {
    entries.push({ key: 'golden-pocket', label: 'Golden pocket (4h)' });
  }
  return entries;
}

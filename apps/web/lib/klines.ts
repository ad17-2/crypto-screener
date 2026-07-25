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

/** He trades 1H/15M (see trading-style memory) -- 1h is the sane default. */
export const DEFAULT_CHART_INTERVAL: ChartInterval = '1h';

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

/** A single horizontal level to draw on the chart (EMA/Donchian) -- always labeled 4h, since that's what technical_state is computed on regardless of the chart's own interval. */
export interface ChartPriceLine {
  id: string;
  label: string;
  price: number;
}

export interface ChartGoldenPocket {
  lower: number;
  upper: number;
}

export interface ChartLevels {
  goldenPocket: ChartGoldenPocket | null;
  lines: ChartPriceLine[];
}

/**
 * Selects the screener's own computed 4h levels to draw on the chart, mirroring LevelsBlock's null
 * handling in SelectedCoinRail.tsx: a level is skipped entirely rather than drawn at zero, and the
 * golden pocket only renders when both bounds are present (it's a band, not two independent
 * lines). Every label says "(4h)" -- these levels are computed on 4h candles regardless of which
 * interval the chart itself is showing, and the chart must never let that read as interval-native.
 */
export function selectChartLevels(state: DashboardRow['technical_state']): ChartLevels {
  const lines: ChartPriceLine[] = [];
  if (state.ema_20 != null) lines.push({ id: 'ema20', label: 'EMA 20 (4h)', price: state.ema_20 });
  if (state.ema_50 != null) lines.push({ id: 'ema50', label: 'EMA 50 (4h)', price: state.ema_50 });
  if (state.ema_200 != null) {
    lines.push({ id: 'ema200', label: 'EMA 200 (4h)', price: state.ema_200 });
  }
  if (state.donchian_high_20 != null) {
    lines.push({
      id: 'donchian-high',
      label: 'Donchian 20 high (4h)',
      price: state.donchian_high_20,
    });
  }
  if (state.donchian_low_20 != null) {
    lines.push({ id: 'donchian-low', label: 'Donchian 20 low (4h)', price: state.donchian_low_20 });
  }

  const goldenPocket =
    state.golden_pocket_lower != null && state.golden_pocket_upper != null
      ? { lower: state.golden_pocket_lower, upper: state.golden_pocket_upper }
      : null;

  return { goldenPocket, lines };
}

import { clamp, mean, pctChange, stdev, toFloat } from './scoring.js';

export type RawHistoryRow = Record<string, unknown>;

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

function intervalHours(interval: string): number {
  return INTERVAL_HOURS[interval] ?? 24.0;
}

export function candlesPerWindow(interval: string, hours: number): number {
  return Math.max(1, Math.round(hours / intervalHours(interval)));
}

interface CloseRow {
  time: number;
  close: number;
}

interface LiquidationRow {
  time: number;
  long: number;
  short: number;
}

interface TakerRow {
  time: number;
  buy: number;
  sell: number;
}

// Keys whose value is null are dropped from the result entirely, not kept as null.
export function derivativesSnapshot(
  oiHistory: RawHistoryRow[],
  fundingHistory: RawHistoryRow[],
  liquidationHistory: RawHistoryRow[],
  takerHistory: RawHistoryRow[],
  interval: string,
  endTime?: number,
): Record<string, unknown> {
  const oiRows = seriesUntil(normalizeCloseSeries(oiHistory), endTime);
  const fundingRows = seriesUntil(normalizeCloseSeries(fundingHistory), endTime);
  const liquidationRows = seriesUntil(normalizeLiquidations(liquidationHistory), endTime);
  const takerRows = seriesUntil(normalizeTaker(takerHistory), endTime);

  if (
    oiRows.length === 0 &&
    fundingRows.length === 0 &&
    liquidationRows.length === 0 &&
    takerRows.length === 0
  ) {
    return {};
  }

  const window = candlesPerWindow(interval, 24.0);
  const oiCloses = oiRows.map((row) => row.close);
  const fundingCloses = fundingRows.map((row) => row.close);
  const liqWindow = liquidationRows.slice(-window);
  const takerWindow = takerRows.slice(-window);

  const oiChange1 = pctChangeSteps(oiCloses, 1);
  const oiChangeWindow = pctChangeSteps(oiCloses, window);
  const oiPreviousChange = pctChangeSteps(oiCloses.slice(0, -1), 1);
  const oiAcceleration =
    oiChange1 !== null && oiPreviousChange !== null ? oiChange1 - oiPreviousChange : null;
  const oiZscore = latestZscore(oiCloses, 30);

  const fundingWindow = fundingCloses.slice(-window);
  const fundingAvg = fundingCloses.length ? mean(fundingWindow) : null;
  const fundingPersistence = signPersistence(fundingWindow);

  const longLiq = liqWindow.reduce((sum, row) => sum + row.long, 0);
  const shortLiq = liqWindow.reduce((sum, row) => sum + row.short, 0);
  const liqTotal = longLiq + shortLiq;
  const liqImbalance = liqTotal > 0 ? ((shortLiq - longLiq) / liqTotal) * 100.0 : null;

  const buyVolume = takerWindow.reduce((sum, row) => sum + row.buy, 0);
  const sellVolume = takerWindow.reduce((sum, row) => sum + row.sell, 0);
  const takerTotal = buyVolume + sellVolume;
  const takerRatio = sellVolume > 0 ? buyVolume / sellVolume : null;
  const takerImbalance = takerTotal > 0 ? ((buyVolume - sellVolume) / takerTotal) * 100.0 : null;

  const confirmation = derivativesConfirmation(oiAcceleration, takerImbalance, liqImbalance);

  const result: Record<string, unknown> = {
    derivatives_interval: interval,
    derivatives_oi_count: oiRows.length,
    derivatives_funding_count: fundingRows.length,
    derivatives_liquidation_count: liquidationRows.length,
    derivatives_taker_count: takerRows.length,
    oi_change_4h_pct_history: oiChange1,
    oi_change_24h_pct_history: oiChangeWindow,
    oi_acceleration_4h_pct: oiAcceleration,
    oi_zscore_30: oiZscore,
    funding_avg_24h_pct: fundingAvg,
    funding_persistence_24h: fundingPersistence,
    long_liquidation_usd_24h_history: liqWindow.length ? longLiq : null,
    short_liquidation_usd_24h_history: liqWindow.length ? shortLiq : null,
    liquidation_imbalance_24h_pct: liqImbalance,
    taker_buy_sell_ratio_24h: takerRatio,
    taker_imbalance_24h_pct: takerImbalance,
    derivatives_confirmation_score: confirmation,
  };

  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null));
}

export function sortByTime(rows: RawHistoryRow[]): RawHistoryRow[] {
  return [...rows].sort((a, b) => (toFloat(a.time, 0.0) ?? 0.0) - (toFloat(b.time, 0.0) ?? 0.0));
}

function normalizeCloseSeries(rows: RawHistoryRow[]): CloseRow[] {
  const normalized: CloseRow[] = [];
  for (const row of sortByTime(rows)) {
    const time = toFloat(row.time);
    const close = toFloat(row.close);
    if (time === null || close === null) {
      continue;
    }
    normalized.push({ time, close });
  }
  return normalized;
}

function normalizeLiquidations(rows: RawHistoryRow[]): LiquidationRow[] {
  const normalized: LiquidationRow[] = [];
  for (const row of sortByTime(rows)) {
    const time = toFloat(row.time);
    const long = toFloat(row.aggregated_long_liquidation_usd, 0.0) ?? 0.0;
    const short = toFloat(row.aggregated_short_liquidation_usd, 0.0) ?? 0.0;
    if (time === null) {
      continue;
    }
    normalized.push({ time, long, short });
  }
  return normalized;
}

function normalizeTaker(rows: RawHistoryRow[]): TakerRow[] {
  const normalized: TakerRow[] = [];
  for (const row of sortByTime(rows)) {
    const time = toFloat(row.time);
    const buy = toFloat(row.aggregated_buy_volume_usd, 0.0) ?? 0.0;
    const sell = toFloat(row.aggregated_sell_volume_usd, 0.0) ?? 0.0;
    if (time === null) {
      continue;
    }
    normalized.push({ time, buy, sell });
  }
  return normalized;
}

function seriesUntil<T extends { time: number }>(rows: T[], endTime: number | undefined): T[] {
  if (endTime === undefined) {
    return rows;
  }
  return rows.filter((row) => row.time <= endTime);
}

function pctChangeSteps(values: number[], steps: number): number | null {
  if (values.length <= steps) {
    return null;
  }
  return pctChange(values[values.length - steps - 1] as number, values.at(-1) as number);
}

function latestZscore(values: number[], window: number): number | null {
  if (values.length < Math.max(3, window)) {
    return null;
  }
  const sample = values.slice(-window);
  const deviation = stdev(sample);
  if (deviation === 0) {
    return 0.0;
  }
  return ((sample.at(-1) as number) - mean(sample)) / deviation;
}

function signPersistence(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const signs = values.map((value) => (value > 0 ? 1.0 : value < 0 ? -1.0 : 0.0));
  return mean(signs);
}

function derivativesConfirmation(
  oiAcceleration: number | null,
  takerImbalance: number | null,
  liquidationImbalance: number | null,
): number | null {
  const components: number[] = [];
  if (oiAcceleration !== null) {
    components.push(clamp(oiAcceleration / 8.0, -1.0, 1.0));
  }
  if (takerImbalance !== null) {
    components.push(clamp(takerImbalance / 20.0, -1.0, 1.0));
  }
  if (liquidationImbalance !== null) {
    components.push(clamp(liquidationImbalance / 60.0, -1.0, 1.0));
  }
  return components.length ? mean(components) : null;
}

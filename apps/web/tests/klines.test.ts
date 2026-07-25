import type { DashboardRow } from '@crypto-screener/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildChartLegendEntries,
  type Candle,
  computeDonchian,
  computeEma,
  derivePriceFormat,
  EMA_PERIODS,
  parseKlinesResponse,
  selectGoldenPocket,
} from '../lib/klines';

describe('parseKlinesResponse', () => {
  it('passes through candles already in seconds (the shape GET /api/klines returns)', () => {
    const body = [
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
      { time: 1_752_638_400, open: 64200, high: 64700, low: 64100, close: 64600 },
    ];

    expect(parseKlinesResponse(body)).toEqual(body);
  });

  it('normalizes a millisecond-scale time down to seconds (defensive ms->s conversion)', () => {
    const body = [{ time: 1_752_624_000_000, open: 64000, high: 64500, low: 63800, close: 64200 }];

    expect(parseKlinesResponse(body)).toEqual([
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
    ]);
  });

  it('drops entries with a non-finite field instead of throwing', () => {
    const body = [
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
      { time: 1_752_638_400, open: 'nan', high: 64700, low: 64100, close: 64600 },
    ];

    expect(parseKlinesResponse(body)).toEqual([
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
    ]);
  });

  it('returns an empty array for a non-array body (e.g. an error payload)', () => {
    expect(parseKlinesResponse({ error: 'klines_unavailable' })).toEqual([]);
  });

  it('returns an empty array for an empty response', () => {
    expect(parseKlinesResponse([])).toEqual([]);
  });
});

function stateWith(
  overrides: Partial<DashboardRow['technical_state']>,
): DashboardRow['technical_state'] {
  return overrides;
}

describe('selectGoldenPocket', () => {
  it('returns null when either bound is missing', () => {
    expect(selectGoldenPocket(stateWith({}))).toBeNull();
    expect(selectGoldenPocket(stateWith({ golden_pocket_upper: 105 }))).toBeNull();
    expect(selectGoldenPocket(stateWith({ golden_pocket_lower: 95 }))).toBeNull();
  });

  it('returns the band when both bounds are present', () => {
    const result = selectGoldenPocket(
      stateWith({ golden_pocket_lower: 95, golden_pocket_upper: 105 }),
    );

    expect(result).toEqual({ lower: 95, upper: 105 });
  });
});

describe('derivePriceFormat', () => {
  // Must match fmtPrice's thresholds exactly (apps/web/lib/format.ts, apps/web/tests/format.test.ts)
  // -- the chart and the Levels (4h) section can never disagree about how many decimals a coin needs.
  it('uses 2dp for prices >= 100, e.g. a BTC-like price', () => {
    expect(derivePriceFormat(64000)).toEqual({ precision: 2, minMove: 0.01 });
    expect(derivePriceFormat(100)).toEqual({ precision: 2, minMove: 0.01 });
  });

  it('uses 4dp for prices >= 1 and < 100', () => {
    expect(derivePriceFormat(1)).toEqual({ precision: 4, minMove: 0.0001 });
  });

  it('uses 6dp for prices below 1 -- the sub-dollar coins that used to render "0.00"', () => {
    expect(derivePriceFormat(0.18)).toEqual({ precision: 6, minMove: 0.000001 }); // XLM
    expect(derivePriceFormat(0.046)).toEqual({ precision: 6, minMove: 0.000001 }); // SAND
    expect(derivePriceFormat(0.008)).toEqual({ precision: 6, minMove: 0.000001 }); // ZIL
  });

  it('scales by magnitude, not sign', () => {
    expect(derivePriceFormat(-0.5)).toEqual({ precision: 6, minMove: 0.000001 });
  });
});

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close }));
}

describe('EMA_PERIODS', () => {
  it('excludes 200 -- at KLINE_LIMIT=200 (CoinChart.tsx) it would draw exactly one seed point, not a line', () => {
    expect(EMA_PERIODS).toEqual([20, 50]);
  });
});

describe('computeEma', () => {
  it('matches a hand-computed EMA: SMA(3) seed then k = 2/(period+1)', () => {
    // closes [1,2,3,4,5,6], period 3 -> seed = (1+2+3)/3 = 2, k = 2/4 = 0.5
    // ema(4) = 4*0.5 + 2*0.5 = 3; ema(5) = 5*0.5 + 3*0.5 = 4; ema(6) = 6*0.5 + 4*0.5 = 5
    const candles = candlesFromCloses([1, 2, 3, 4, 5, 6]);

    expect(computeEma(candles, 3)).toEqual([
      { time: 2, value: 2 },
      { time: 3, value: 3 },
      { time: 4, value: 4 },
      { time: 5, value: 5 },
    ]);
  });

  it('returns [] when the period exceeds the candle count, rather than a truncated line', () => {
    const candles = candlesFromCloses([1, 2, 3]);

    expect(computeEma(candles, 5)).toEqual([]);
  });

  it('returns [] for a non-positive period', () => {
    const candles = candlesFromCloses([1, 2, 3]);

    expect(computeEma(candles, 0)).toEqual([]);
  });
});

describe('computeDonchian', () => {
  it('matches a hand-computed rolling 3-period high/low', () => {
    const candles: Candle[] = [
      { time: 0, open: 0, close: 0, high: 10, low: 5 },
      { time: 1, open: 0, close: 0, high: 12, low: 4 },
      { time: 2, open: 0, close: 0, high: 9, low: 6 },
      { time: 3, open: 0, close: 0, high: 15, low: 7 },
      { time: 4, open: 0, close: 0, high: 11, low: 3 },
    ];

    expect(computeDonchian(candles, 3)).toEqual([
      { time: 2, high: 12, low: 4 },
      { time: 3, high: 15, low: 4 },
      { time: 4, high: 15, low: 3 },
    ]);
  });

  it('returns [] when the period exceeds the candle count', () => {
    const candles = candlesFromCloses([1, 2]);

    expect(computeDonchian(candles, 20)).toEqual([]);
  });
});

describe('buildChartLegendEntries', () => {
  const emaSeries = [
    { period: 20, points: [{ time: 0, value: 1 }] },
    { period: 50, points: [{ time: 0, value: 1 }] },
  ];
  const donchianPoints = [{ time: 0, high: 2, low: 1 }];
  const goldenPocket = { lower: 95, upper: 105 };

  it('includes all four entries, in prominence order, when every series drew', () => {
    expect(buildChartLegendEntries(emaSeries, donchianPoints, goldenPocket)).toEqual([
      { key: 'ema-20', label: 'EMA 20' },
      { key: 'ema-50', label: 'EMA 50' },
      { key: 'donchian', label: 'Donchian 20' },
      { key: 'golden-pocket', label: 'Golden pocket (4h)' },
    ]);
  });

  it('skips an EMA entry whose points are [] (not enough candles for its seed window)', () => {
    const sparse = [
      { period: 20, points: [{ time: 0, value: 1 }] },
      { period: 50, points: [] },
    ];

    expect(buildChartLegendEntries(sparse, donchianPoints, goldenPocket)).toEqual([
      { key: 'ema-20', label: 'EMA 20' },
      { key: 'donchian', label: 'Donchian 20' },
      { key: 'golden-pocket', label: 'Golden pocket (4h)' },
    ]);
  });

  it('skips the Donchian entry when donchianPoints is []', () => {
    expect(buildChartLegendEntries(emaSeries, [], goldenPocket)).toEqual([
      { key: 'ema-20', label: 'EMA 20' },
      { key: 'ema-50', label: 'EMA 50' },
      { key: 'golden-pocket', label: 'Golden pocket (4h)' },
    ]);
  });

  it('skips the golden pocket entry when it is null', () => {
    expect(buildChartLegendEntries(emaSeries, donchianPoints, null)).toEqual([
      { key: 'ema-20', label: 'EMA 20' },
      { key: 'ema-50', label: 'EMA 50' },
      { key: 'donchian', label: 'Donchian 20' },
    ]);
  });
});

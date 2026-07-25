'use client';

import type { DashboardRow } from '@crypto-screener/contracts';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/components/layout/ThemeProvider';
import {
  buildChartLegendEntries,
  type Candle,
  CHART_INTERVALS,
  type ChartInterval,
  type ChartLegendEntry,
  computeDonchian,
  computeEma,
  DEFAULT_CHART_INTERVAL,
  DONCHIAN_PERIOD,
  derivePriceFormat,
  EMA_PERIODS,
  parseKlinesResponse,
  selectGoldenPocket,
} from '@/lib/klines';

const KLINE_LIMIT = 200;

/**
 * lightweight-charts (TradingView, Apache-2.0) paints to a canvas, so it needs literal colors
 * rather than CSS custom properties -- kept in sync by hand with apps/web/app/globals.css's
 * --bg/--line/--ink/--muted/--ash/--up/--down/--gold tokens for dark/light.
 */
const THEME_COLORS = {
  dark: {
    bg: '#0b0b0b',
    line: '#232323',
    ink: '#f2f2f2',
    muted: '#a3a3a3',
    ash: '#7a7a7a',
    up: '#35a06a',
    down: '#d1615c',
    gold: '#c9a25a',
  },
  light: {
    bg: '#ffffff',
    line: '#e7e7e7',
    ink: '#111111',
    muted: '#555555',
    ash: '#757575',
    up: '#1f7d4a',
    down: '#b23b3b',
    gold: '#93701f',
  },
} as const;

type LoadState = 'loading' | 'ready' | 'error';

export interface CoinChartProps {
  row: DashboardRow;
}

/**
 * Self-rendered candlestick chart for the selected coin. Draws the screener's own computed 4h
 * golden pocket on top (see lib/klines.ts's selectGoldenPocket) plus EMA 20/50 and a Donchian 20
 * channel computed client-side from the candles at whatever interval is selected (see
 * computeEma/computeDonchian) -- TradingView's own widget can't show this pipeline's analysis (see
 * the "Researched and settled already" note this ships alongside), so this draws it directly
 * instead.
 */
export function CoinChart({ row }: CoinChartProps) {
  const { theme } = useTheme();
  const colors = THEME_COLORS[theme];
  const symbol = row.symbol;
  const [chartInterval, setChartInterval] = useState<ChartInterval>(DEFAULT_CHART_INTERVAL);
  const [status, setStatus] = useState<LoadState>('loading');
  const [candles, setCandles] = useState<Candle[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch on symbol/interval change only -- never on page load for the other 69 coins, since this
  // component only exists inside the rail once a row is selected.
  useEffect(() => {
    if (!symbol) {
      setStatus('error');
      setCandles([]);
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');

    const url = `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${chartInterval}&limit=${KLINE_LIMIT}`;
    fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`klines request failed: HTTP ${response.status}`);
        const body: unknown = await response.json();
        return parseKlinesResponse(body);
      })
      .then((parsed) => {
        if (cancelled) return;
        if (parsed.length === 0) {
          setStatus('error');
          setCandles([]);
          return;
        }
        setCandles(parsed);
        setStatus('ready');
      })
      .catch(() => {
        // Never surface a broken chart or a raw error -- the rail degrades to no chart, same as
        // before this feature existed.
        if (cancelled) return;
        setStatus('error');
        setCandles([]);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, chartInterval]);

  // Shared by the chart-building effect below and the header legend, so the two can never disagree
  // about which series actually drew.
  const emaSeries = useMemo(
    () => EMA_PERIODS.map((period) => ({ period, points: computeEma(candles, period) })),
    [candles],
  );
  const donchianPoints = useMemo(() => computeDonchian(candles, DONCHIAN_PERIOD), [candles]);
  const legendEntries = useMemo(
    () =>
      buildChartLegendEntries(emaSeries, donchianPoints, selectGoldenPocket(row.technical_state)),
    [emaSeries, donchianPoints, row.technical_state],
  );

  // Mounts a fresh chart whenever there's a new candle set, a theme flip, an interval switch (EMA/
  // Donchian are recomputed from the currently-displayed candles), or (on reselecting a different
  // row) a new golden pocket to draw -- recreation is cheap here since this only reruns on a
  // user-driven change, never on a timer.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return undefined;

    const colors = THEME_COLORS[theme];
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.muted,
        // Apache-2.0 requires linking https://www.tradingview.com/ on any page using this library;
        // the built-in attribution logo satisfies that link requirement on its own (see the
        // library's README), which is why nothing else is rendered for it here.
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: colors.line },
        horzLines: { color: colors.line },
      },
      timeScale: { borderColor: colors.line },
      rightPriceScale: { borderColor: colors.line },
    });

    // Derived from the same magnitude thresholds fmtPrice (lib/format.ts) uses, applied to every
    // series below, so the axis/candles/lines can never disagree with the Levels (4h) section on
    // how many decimals a sub-dollar coin needs (every level used to render "0.00" here).
    const lastCandle = candles.at(-1) as Candle; // safe: candles.length === 0 returned above
    const priceFormat = {
      type: 'price' as const,
      ...derivePriceFormat(lastCandle.close),
    };

    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat,
    });

    series.setData(candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp })));

    // EMA 20/50 and the Donchian 20 channel are rolling-window values, not fixed levels -- drawing
    // them as flat lines (the old behaviour) implied the average/channel sat at one value across
    // three months of candles, which it did not. Computed once above (emaSeries/donchianPoints,
    // shared with the header legend) from the candles already fetched for the currently-selected
    // interval. Styled by prominence, and deliberately all dimmer than --gold: the golden pocket is
    // the actual entry trigger and has to stay the loudest thing on the chart, so no overlay may
    // outrank it. Measured live 2026-07-25 -- EMA 20 at --ink (#f2f2f2) rendered brighter than the
    // candles themselves and would have fought the gold band for attention, so the whole ramp sits
    // one step down: EMA 20 at --muted, EMA 50 at --ash, and the Donchian channel also --ash but
    // dashed, since it's background context (a channel, not a trigger) rather than a signal. EMA 50
    // and Donchian share a color and are told apart by that dash, which the legend swatches mirror.
    // On-canvas titles were dropped for the header legend instead
    // (see legendEntries below) -- lastValueVisible/priceLineVisible false only suppresses each
    // series' own per-series axis price line, unrelated to that.
    for (const { period, points } of emaSeries) {
      if (points.length === 0) continue; // not enough candles for this period's seed window
      const emaLine = chart.addSeries(LineSeries, {
        color: period === 20 ? colors.muted : colors.ash,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat,
      });
      emaLine.setData(
        points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })),
      );
    }

    if (donchianPoints.length > 0) {
      const donchianHigh = chart.addSeries(LineSeries, {
        color: colors.ash,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat,
      });
      donchianHigh.setData(
        donchianPoints.map((point) => ({ time: point.time as UTCTimestamp, value: point.high })),
      );

      const donchianLow = chart.addSeries(LineSeries, {
        color: colors.ash,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat,
      });
      donchianLow.setData(
        donchianPoints.map((point) => ({ time: point.time as UTCTimestamp, value: point.low })),
      );
    }

    // The only level still drawn as a flat line: it's the only one that's genuinely horizontal
    // (derived from one specific 4h swing leg, not a rolling window), and it's this user's actual
    // entry trigger -- so it's the only pair of axis labels this chart draws (previously seven
    // overlapping labels covered ~40% of chart width, over the most recent candles).
    //
    // No `title`: a titled price line renders its text in a box ON the canvas, and verified against
    // production 2026-07-25 (MORPHO, band at 1.9577/1.9627) the two boxes sat over the last ~3 days
    // of candles -- the tail end of the same clutter this chart was fixed for, just gold. The band
    // is already identified by the header legend's "Golden pocket (4h)" entry, and axisLabelVisible
    // still prints each bound's price in gold on the axis, so the boxes were redundant as well as
    // in the way.
    const goldenPocket = selectGoldenPocket(row.technical_state);
    if (goldenPocket) {
      for (const price of [goldenPocket.lower, goldenPocket.upper]) {
        series.createPriceLine({
          price,
          color: colors.gold,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
        });
      }
    }

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
    };
  }, [candles, theme, row.technical_state, emaSeries, donchianPoints]);

  // legendEntries in draw order; split so the interval marker can be shown once for the EMA/
  // Donchian cluster (they're all computed from chartInterval) rather than repeated per entry --
  // the golden pocket keeps its own literal "(4h)" (already baked into its label above) since it's
  // always the 4h pipeline value regardless of chartInterval.
  const overlayEntries = legendEntries.filter((entry) => entry.key !== 'golden-pocket');
  const goldenPocketEntry = legendEntries.find((entry) => entry.key === 'golden-pocket');

  // Swatch color/line-style for a legend entry, matching exactly what's passed to the
  // corresponding addSeries/createPriceLine call above -- kept in sync by hand since colors are
  // theme-dependent and don't belong in the lib/klines.ts helper that decides which entries exist.
  const legendSwatch = (entry: ChartLegendEntry) => {
    const { color, dashed } =
      entry.key === 'ema-20'
        ? { color: colors.muted, dashed: false }
        : entry.key === 'ema-50'
          ? { color: colors.ash, dashed: false }
          : entry.key === 'donchian'
            ? { color: colors.ash, dashed: true }
            : { color: colors.gold, dashed: false }; // golden-pocket
    return (
      <span
        aria-hidden="true"
        className="inline-block w-2.5"
        style={{ borderTop: `1px ${dashed ? 'dashed' : 'solid'} ${color}` }}
      />
    );
  };

  return (
    <div className="coin-chart">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex gap-3">
          {CHART_INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              onClick={() => setChartInterval(iv)}
              aria-pressed={iv === chartInterval}
              className={`tab-btn cursor-pointer bg-transparent border-0 p-0 text-xs${
                iv === chartInterval
                  ? ' active font-semibold'
                  : ' text-ash font-medium hover:text-ink'
              }`}
            >
              {iv}
            </button>
          ))}
        </div>
        {status === 'ready' && legendEntries.length > 0 ? (
          <div className="flex items-center gap-3 text-ash text-xs">
            {overlayEntries.length > 0 ? (
              <span className="flex items-center gap-2">
                {overlayEntries.map((entry) => (
                  <span key={entry.key} className="flex items-center gap-1">
                    {legendSwatch(entry)}
                    {entry.label}
                  </span>
                ))}
                <span>({chartInterval})</span>
              </span>
            ) : null}
            {goldenPocketEntry ? (
              <span className="flex items-center gap-1">
                {legendSwatch(goldenPocketEntry)}
                {goldenPocketEntry.label}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {status === 'loading' ? <div className="driver-line">Loading chart…</div> : null}
      {status === 'error' ? <div className="driver-line">Chart unavailable right now.</div> : null}
      <div
        ref={containerRef}
        className={`h-[260px] w-full${status === 'ready' ? '' : ' hidden'}`}
      />
    </div>
  );
}

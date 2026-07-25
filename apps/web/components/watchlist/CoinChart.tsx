'use client';

import type { DashboardRow } from '@crypto-screener/contracts';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '@/components/layout/ThemeProvider';
import {
  type Candle,
  CHART_INTERVALS,
  type ChartInterval,
  DEFAULT_CHART_INTERVAL,
  parseKlinesResponse,
  selectChartLevels,
} from '@/lib/klines';

const KLINE_LIMIT = 200;

/**
 * lightweight-charts (TradingView, Apache-2.0) paints to a canvas, so it needs literal colors
 * rather than CSS custom properties -- kept in sync by hand with apps/web/app/globals.css's
 * --bg/--line/--ink/--muted/--up/--down/--gold tokens for dark/light.
 */
const THEME_COLORS = {
  dark: {
    bg: '#0b0b0b',
    line: '#232323',
    muted: '#a3a3a3',
    up: '#35a06a',
    down: '#d1615c',
    gold: '#c9a25a',
  },
  light: {
    bg: '#ffffff',
    line: '#e7e7e7',
    muted: '#555555',
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
 * Self-rendered candlestick chart for the selected coin, with the screener's own computed 4h
 * levels drawn on top (see lib/klines.ts's selectChartLevels) -- TradingView's own widget can't
 * show this pipeline's analysis (see the "Researched and settled already" note this ships
 * alongside), so this draws it directly instead.
 */
export function CoinChart({ row }: CoinChartProps) {
  const { theme } = useTheme();
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

  // Mounts a fresh chart whenever there's a new candle set, a theme flip, or (on reselecting a
  // different row) new levels to draw -- recreation is cheap here since this only reruns on a
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

    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });

    series.setData(candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp })));

    // CRITICAL: technical_state (and therefore every level below) is computed on 4h candles --
    // every title says so explicitly, regardless of which interval this chart is currently
    // showing, so it never reads as interval-native.
    const levels = selectChartLevels(row.technical_state);
    for (const line of levels.lines) {
      series.createPriceLine({
        price: line.price,
        color: colors.muted,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: line.label,
      });
    }
    if (levels.goldenPocket) {
      series.createPriceLine({
        price: levels.goldenPocket.lower,
        color: colors.gold,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Golden pocket lower (4h)',
      });
      series.createPriceLine({
        price: levels.goldenPocket.upper,
        color: colors.gold,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Golden pocket upper (4h)',
      });
    }

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
    };
  }, [candles, theme, row.technical_state]);

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
        {status === 'ready' ? (
          <span className="text-ash text-xs">Levels shown are computed on 4h candles</span>
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

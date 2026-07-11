import type { DashboardRow } from '@crypto-screener/contracts';
import { numeric } from './format';

/** symbol+side+score_field. Unique only within the active watchlist tab — selection resets on tab change. */
export function rowKey(row: DashboardRow): string {
  return `${row.symbol || '-'}:${row.side || '-'}:${row.score_field || '-'}`;
}

const TRADINGVIEW_EXCHANGES: Record<string, string> = {
  binance: 'BINANCE',
  okx: 'OKX',
  bybit: 'BYBIT',
  bitget: 'BITGET',
  gate: 'GATEIO',
  hyperliquid: 'HYPERLIQUID',
};

function tradingViewExchange(exchange: string | null | undefined): string {
  const key = String(exchange || '').toLowerCase();
  return TRADINGVIEW_EXCHANGES[key] || 'BYBIT';
}

function tradingViewSymbol(row: Pick<DashboardRow, 'symbol' | 'primary_exchange'>): string {
  const base = String(row.symbol || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return base ? `${tradingViewExchange(row.primary_exchange)}:${base}USDT.P` : '';
}

export function tradingViewUrl(row: Pick<DashboardRow, 'symbol' | 'primary_exchange'>): string {
  const tvSymbol = tradingViewSymbol(row);
  return tvSymbol
    ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`
    : '#';
}

export interface PositioningDivergence {
  tone: 'warn' | 'pos' | 'neutral';
  mark: string;
  label: string;
  title: string;
}

const POSITIONING_LONG_THRESHOLD = 1.2;
const POSITIONING_SHORT_THRESHOLD = 0.85;

export function positioningDivergence(
  row: Pick<DashboardRow, 'long_short_account_ratio' | 'top_trader_long_short_ratio'>,
): PositioningDivergence | null {
  const retail = numeric(row.long_short_account_ratio);
  const top = numeric(row.top_trader_long_short_ratio);
  if (retail === null || top === null) return null;

  if (retail >= POSITIONING_LONG_THRESHOLD && top <= 1.0) {
    return {
      tone: 'warn',
      mark: 'R▲',
      label: 'Retail long',
      title: `Retail long ${retail.toFixed(2)}x vs top-trader ${top.toFixed(2)}x — retail-crowded long`,
    };
  }
  if (retail <= POSITIONING_SHORT_THRESHOLD && top >= 1.0) {
    return {
      tone: 'warn',
      mark: 'R▼',
      label: 'Retail short',
      title: `Retail short ${retail.toFixed(2)}x vs top-trader ${top.toFixed(2)}x — retail-crowded short`,
    };
  }
  if (
    (retail >= POSITIONING_LONG_THRESHOLD && top >= POSITIONING_LONG_THRESHOLD) ||
    (retail <= POSITIONING_SHORT_THRESHOLD && top <= POSITIONING_SHORT_THRESHOLD)
  ) {
    return {
      tone: 'pos',
      mark: '=',
      label: 'Aligned',
      title: `Retail ${retail.toFixed(2)}x / top ${top.toFixed(2)}x — aligned`,
    };
  }
  return {
    tone: 'neutral',
    mark: '',
    label: 'Mixed',
    title: `Retail ${retail.toFixed(2)}x / top ${top.toFixed(2)}x`,
  };
}

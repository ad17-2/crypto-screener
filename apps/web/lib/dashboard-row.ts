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
  // numeric(null) === 0, so guard the raw fields before coercion — otherwise a row with no
  // positioning data reads as 0/0, falls through to an 'Aligned' verdict, and (via
  // WatchlistTable's tone) paints a spurious highlight the rail badge's own null-guard suppresses.
  if (row.long_short_account_ratio == null || row.top_trader_long_short_ratio == null) {
    return null;
  }
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

type OiPriceQuadrantTone = 'pos' | 'neg' | 'warn';

/** apps/api's `oi_price_quadrant` enum -> the same label/tone pairs the old client-side read used. */
const OI_PRICE_QUADRANT: Record<
  NonNullable<DashboardRow['oi_price_quadrant']>,
  { label: string; tone: OiPriceQuadrantTone }
> = {
  new_longs: { label: 'New longs', tone: 'pos' }, // fresh money
  short_covering: { label: 'Short covering', tone: 'warn' }, // weak rally
  new_shorts: { label: 'New shorts', tone: 'neg' }, // fresh downside
  long_liquidation: { label: 'Long liquidation', tone: 'warn' }, // washout
};

/**
 * Precedence: a server-computed `oi_price_quadrant` string wins (the server's read, including its
 * noise dead-zone); an explicit `null` means the server judged the moves too small to read and is
 * passed straight through (the rail renders its own muted "Quiet" state for that case rather than
 * this function inventing one); `undefined` (old runs, field predates this read) falls back to the
 * original client-side sign computation, unchanged.
 */
export function oiPriceQuadrant(
  row: Pick<DashboardRow, 'price_change_24h_pct' | 'oi_change_24h_pct' | 'oi_price_quadrant'>,
): { label: string; tone: OiPriceQuadrantTone } | null {
  if (typeof row.oi_price_quadrant === 'string') {
    return OI_PRICE_QUADRANT[row.oi_price_quadrant];
  }
  if (row.oi_price_quadrant === null) {
    return null;
  }
  const price = row.price_change_24h_pct;
  const oi = row.oi_change_24h_pct;
  if (price == null || oi == null) return null;
  if (price >= 0 && oi >= 0) return { label: 'New longs', tone: 'pos' }; // fresh money
  if (price >= 0 && oi < 0) return { label: 'Short covering', tone: 'warn' }; // weak rally
  if (price < 0 && oi >= 0) return { label: 'New shorts', tone: 'neg' }; // fresh downside
  return { label: 'Long liquidation', tone: 'warn' }; // washout
}

import { type DashboardRow, FRESH_EMA_CROSS_MAX_BARS } from '@crypto-screener/contracts';
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
  if (price >= 0 && oi >= 0) return OI_PRICE_QUADRANT.new_longs;
  if (price >= 0 && oi < 0) return OI_PRICE_QUADRANT.short_covering;
  if (price < 0 && oi >= 0) return OI_PRICE_QUADRANT.new_shorts;
  return OI_PRICE_QUADRANT.long_liquidation;
}

export interface EmaCrossLine {
  tone: 'pos' | 'neg';
  text: string;
}

// Presentation decides freshness -- apps/api/src/pipeline/technicals.ts emits only the raw
// ema_cross_bars_since fact, no freshness float (see its own doc comment). FRESH_EMA_CROSS_MAX_BARS
// (packages/contracts/src/dashboard.ts) is the same cutoff apps/api/src/dashboard/rows.ts uses for
// its "Fresh EMA20/50 cross" reason-part chip, so the chip and this Chart-detail line agree on
// "fresh".

/** null when there's no cross in the lookback window, or the cross is no longer fresh. */
export function emaCrossLine(
  state: Pick<DashboardRow['technical_state'], 'ema_cross_direction' | 'ema_cross_bars_since'>,
): EmaCrossLine | null {
  const bars = state.ema_cross_bars_since;
  if (bars == null || bars > FRESH_EMA_CROSS_MAX_BARS) return null;
  if (state.ema_cross_direction === 'bullish') {
    return { tone: 'pos', text: `EMA20/50 bull cross, ${bars} bars ago` };
  }
  if (state.ema_cross_direction === 'bearish') {
    return { tone: 'neg', text: `EMA20/50 bear cross, ${bars} bars ago` };
  }
  return null;
}

/** null when there's no active divergence (technical_divergence is only ever set while active). */
export function divergenceLine(
  state: Pick<
    DashboardRow['technical_state'],
    'technical_divergence' | 'technical_divergence_strength'
  >,
): string | null {
  if (state.technical_divergence !== 'bearish' && state.technical_divergence !== 'bullish') {
    return null;
  }
  const direction = state.technical_divergence === 'bearish' ? 'Bearish' : 'Bullish';
  const strength = state.technical_divergence_strength;
  return strength == null ? direction : `${direction} (${strength.toFixed(2)})`;
}

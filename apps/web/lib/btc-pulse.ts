import type { DashboardRow } from '@crypto-screener/contracts';
import { fmtPct } from './format';

/**
 * The BTC staleness tripwire: batch runs land a few times a day, but BTC can move enough in
 * between to invalidate a ranking built on the old price (a short ranked on its own weakness
 * before BTC pumped, for example). This module is the pure math/copy behind that banner + chip --
 * the polling itself lives in the client component that calls it (WatchlistWorkbench).
 */

/** |delta| at or above this triggers the staleness banner. */
export const BTC_STALENESS_THRESHOLD_PCT = 1.5;

/** How often the client polls GET /api/btc-pulse. */
export const BTC_PULSE_POLL_MS = 60_000;

/** The side a BTC move since the run threatens, or null below the staleness threshold. */
export type ThreatenedSide = 'long' | 'short';

/** `CORE_SYMBOLS` in apps/api/src/dashboard/payload.ts -- 'BTC' is the only symbol this cares about. */
export function btcRunPrice(
  coreRows: readonly Pick<DashboardRow, 'symbol' | 'price_usd'>[],
): number | null {
  return coreRows.find((row) => row.symbol === 'BTC')?.price_usd ?? null;
}

/** null if `runPrice` can't sensibly be a denominator (missing, zero, or non-finite). */
export function btcDeltaPct(livePrice: number, runPrice: number): number | null {
  if (!Number.isFinite(livePrice) || !Number.isFinite(runPrice) || runPrice === 0) return null;
  return ((livePrice - runPrice) / runPrice) * 100;
}

/**
 * A BTC pump threatens the Shorts list (ranked on the coin's own weakness before BTC moved
 * against it); a BTC dump threatens the Longs list. Symmetric around 0, so exactly one side (or
 * neither, inside the threshold) is ever threatened.
 */
export function threatenedSide(deltaPct: number): ThreatenedSide | null {
  if (deltaPct >= BTC_STALENESS_THRESHOLD_PCT) return 'short';
  if (deltaPct <= -BTC_STALENESS_THRESHOLD_PCT) return 'long';
  return null;
}

/** The banner copy shown directly above the threatened list. */
export function stalenessBannerText(deltaPct: number, side: ThreatenedSide): string {
  const list = side === 'short' ? 'shorts' : 'longs';
  return `BTC ${fmtPct(deltaPct, 1)} since this run — ${list} below were ranked before this move; re-check before acting.`;
}

/**
 * Whole-dollar, comma-grouped -- distinct from format.ts's fmtUsd (which compacts to K/M/B/T,
 * wrong for a single coin's price) and SelectedCoinRail's own formatPrice (which scales decimal
 * places by magnitude, meant for coins far cheaper than BTC).
 */
function fmtWholeUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** The always-on muted header chip: "BTC now $67,234 · +2.3% since run". */
export function pulseChipText(livePrice: number, deltaPct: number): string {
  return `BTC now ${fmtWholeUsd(livePrice)} · ${fmtPct(deltaPct, 1)} since run`;
}

import type { WatchlistChanges, WatchlistId } from '@crypto-screener/contracts';

/**
 * The run-over-run "left this list" line shown above the Longs/Shorts table (WatchlistPanel).
 * `watchlist_changes` is null whenever the API couldn't establish a baseline (no previous run, or
 * a previous run that never recorded watchlist membership) -- see
 * apps/api/src/dashboard/runDiff.ts. Only the two directional tabs have a departure list; every
 * other tab (chart_next, crowded_longs, squeeze_risks, core) returns null.
 */
export function departedSymbols(
  changes: WatchlistChanges | null | undefined,
  activeTab: WatchlistId,
): string[] {
  if (!changes) return [];
  if (activeTab === 'long') return changes.departed_long;
  if (activeTab === 'short') return changes.departed_short;
  return [];
}

/** null when there's nothing to say -- callers render nothing rather than an empty banner. */
export function departureLineText(
  changes: WatchlistChanges | null | undefined,
  activeTab: WatchlistId,
): string | null {
  const symbols = departedSymbols(changes, activeTab);
  if (symbols.length === 0) return null;
  return `Left this list since the previous run: ${symbols.join(', ')}`;
}

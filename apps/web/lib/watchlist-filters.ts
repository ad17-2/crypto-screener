import type { DashboardRow } from '@crypto-screener/contracts';
import { lookupSetup } from './copy';

/**
 * The screener already filtered its output — this is a plain symbol/setup text search over
 * the active tab, not a re-filtering UI.
 */
export interface WatchlistFilterState {
  /** trimmed/lowercased at match-time in rowMatches(), not on every keystroke, so typing isn't rewritten. */
  query: string;
}

export const DEFAULT_WATCHLIST_FILTERS: WatchlistFilterState = {
  query: '',
};

function rowMatches(row: DashboardRow, filters: WatchlistFilterState): boolean {
  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  // Match both the raw setup string and its plain-English label so typing either finds it.
  const haystack = [row.symbol, row.setup, lookupSetup(row.setup).label].join(' ').toLowerCase();
  return haystack.includes(query);
}

export function filterRows(rows: DashboardRow[], filters: WatchlistFilterState): DashboardRow[] {
  return rows.filter((row) => rowMatches(row, filters));
}

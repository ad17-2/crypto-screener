import type { DashboardRow } from '@crypto-screener/contracts';
import { sourceParts } from './dashboard-row';

export interface WatchlistFilterState {
  /** trimmed/lowercased at match-time in rowMatches(), not on every keystroke, so typing isn't rewritten. */
  query: string;
  quality: number;
  source: string;
  volume: number;
  positiveOi: boolean;
  negativeFunding: boolean;
}

export const DEFAULT_WATCHLIST_FILTERS: WatchlistFilterState = {
  query: '',
  quality: 0,
  source: 'all',
  volume: 0,
  positiveOi: false,
  negativeFunding: false,
};

function rowMatches(row: DashboardRow, filters: WatchlistFilterState): boolean {
  if (Number(row.quality || 0) < filters.quality) return false;
  if (Number(row.quote_volume_usd || 0) < filters.volume) return false;
  if (filters.positiveOi && !(Number(row.oi_change_24h_pct || 0) > 0)) return false;
  if (filters.negativeFunding && !(Number(row.funding_rate_pct || 0) < 0)) return false;
  if (
    filters.source !== 'all' &&
    !sourceParts(row.data_source)
      .map((part) => part.toLowerCase())
      .includes(filters.source)
  ) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [
      row.symbol,
      row.setup,
      row.technical_setup,
      row.signal_conflict_label,
      row.primary_driver?.label,
      row.explanation?.read,
      row.reason,
      row.data_source,
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

export function filterRows(rows: DashboardRow[], filters: WatchlistFilterState): DashboardRow[] {
  return rows.filter((row) => rowMatches(row, filters));
}

/** Every watchlist tab, not just the active one — feeds the Source select. */
export function collectSources(watchlists: { rows: DashboardRow[] }[]): string[] {
  const sources = new Set<string>();
  for (const list of watchlists) {
    for (const row of list.rows) {
      for (const part of sourceParts(row.data_source)) {
        sources.add(part.toLowerCase());
      }
    }
  }
  return Array.from(sources).sort();
}

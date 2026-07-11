import type { DashboardRow } from '@crypto-screener/contracts';
import { numeric } from './format';

/** Default sort is 'rank' (row.priority) descending — set by WatchlistWorkbench. */
export type SortColumnKey =
  | 'symbol'
  | 'setup'
  | 'rank'
  | 'conviction'
  | 'price'
  | 'oi'
  | 'funding'
  | 'crowding';

export type SortDirection = 'asc' | 'desc';

type SortableField = Extract<
  keyof DashboardRow,
  | 'symbol'
  | 'setup'
  | 'priority'
  | 'confidence_score'
  | 'price_change_24h_pct'
  | 'oi_change_24h_pct'
  | 'funding_rate_pct'
  | 'long_short_ratio'
>;

interface SortColumnConfig {
  field: SortableField;
  type: 'string' | 'numeric';
}

export const SORT_COLUMNS: Record<SortColumnKey, SortColumnConfig> = {
  symbol: { field: 'symbol', type: 'string' },
  setup: { field: 'setup', type: 'string' },
  rank: { field: 'priority', type: 'numeric' },
  conviction: { field: 'confidence_score', type: 'numeric' },
  price: { field: 'price_change_24h_pct', type: 'numeric' },
  oi: { field: 'oi_change_24h_pct', type: 'numeric' },
  funding: { field: 'funding_rate_pct', type: 'numeric' },
  crowding: { field: 'long_short_ratio', type: 'numeric' },
};

export function defaultSortDirection(key: SortColumnKey): SortDirection {
  return SORT_COLUMNS[key].type === 'string' ? 'asc' : 'desc';
}

export function sortRows(
  rows: DashboardRow[],
  key: SortColumnKey | null,
  dir: SortDirection,
): DashboardRow[] {
  if (!key) return rows;
  const { field, type } = SORT_COLUMNS[key];
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (type === 'string') {
      return String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * sign;
    }
    const an = numeric(a[field]);
    const bn = numeric(b[field]);
    if (an === null && bn === null) return 0;
    if (an === null) return 1;
    if (bn === null) return -1;
    return (an - bn) * sign;
  });
}

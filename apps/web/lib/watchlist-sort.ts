import type { DashboardRow } from '@crypto-screener/contracts';
import { numeric } from './format';

/** Default sort is 'rank' (the API's own row order) — set by WatchlistWorkbench. The API now
 * ranks on residual momentum + vetoes, so its order is a meaningful signal, not just arrival
 * order; the other keys re-sort on a single observable column instead. */
export type SortColumnKey =
  | 'rank'
  | 'symbol'
  | 'setup'
  | 'price'
  | 'volume'
  | 'oi'
  | 'funding'
  | 'crowding'
  | 'btc_correlation'
  | 'positioning_divergence';

export type SortDirection = 'asc' | 'desc';

type SortableField = Extract<
  keyof DashboardRow,
  | 'symbol'
  | 'setup'
  | 'price_change_24h_pct'
  | 'quote_volume_usd'
  | 'oi_change_24h_pct'
  | 'funding_rate_pct'
  | 'long_short_ratio'
  | 'btc_correlation'
  | 'positioning_divergence'
>;

interface SortColumnConfig {
  field: SortableField;
  type: 'string' | 'numeric';
}

/** 'rank' has no backing field here — it preserves array order instead of sorting on one. */
export const SORT_COLUMNS: Record<Exclude<SortColumnKey, 'rank'>, SortColumnConfig> = {
  symbol: { field: 'symbol', type: 'string' },
  setup: { field: 'setup', type: 'string' },
  price: { field: 'price_change_24h_pct', type: 'numeric' },
  volume: { field: 'quote_volume_usd', type: 'numeric' },
  oi: { field: 'oi_change_24h_pct', type: 'numeric' },
  funding: { field: 'funding_rate_pct', type: 'numeric' },
  crowding: { field: 'long_short_ratio', type: 'numeric' },
  btc_correlation: { field: 'btc_correlation', type: 'numeric' },
  positioning_divergence: { field: 'positioning_divergence', type: 'numeric' },
};

export function defaultSortDirection(key: SortColumnKey): SortDirection {
  if (key === 'rank') return 'asc';
  return SORT_COLUMNS[key].type === 'string' ? 'asc' : 'desc';
}

export function sortRows(
  rows: DashboardRow[],
  key: SortColumnKey | null,
  dir: SortDirection,
): DashboardRow[] {
  // 'rank' (and no key at all) preserve the API's own row order -- there's no field to re-sort on,
  // and direction doesn't invert it (there's no clickable Rank header to toggle from).
  if (!key || key === 'rank') return rows;
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

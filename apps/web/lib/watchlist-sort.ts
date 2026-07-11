import type { DashboardRow } from '@crypto-screener/contracts';
import { numeric } from './format';

// No default sort — rows render in the API's pre-ranked order until a header is clicked.
export type SortColumnKey =
  | 'symbol'
  | 'setup'
  | 'score'
  | 'conf'
  | 'quality'
  | 'price'
  | 'oi'
  | 'funding'
  | 'ls'
  | 'volume'
  | 'source';

export type SortDirection = 'asc' | 'desc';

type SortableField = Extract<
  keyof DashboardRow,
  | 'symbol'
  | 'setup'
  | 'score'
  | 'confluence_score'
  | 'quality'
  | 'price_change_24h_pct'
  | 'oi_change_24h_pct'
  | 'funding_rate_pct'
  | 'positioning_ratio'
  | 'quote_volume_usd'
  | 'data_source'
>;

interface SortColumnConfig {
  field: SortableField;
  type: 'string' | 'numeric';
}

export const SORT_COLUMNS: Record<SortColumnKey, SortColumnConfig> = {
  symbol: { field: 'symbol', type: 'string' },
  setup: { field: 'setup', type: 'string' },
  score: { field: 'score', type: 'numeric' },
  conf: { field: 'confluence_score', type: 'numeric' },
  quality: { field: 'quality', type: 'numeric' },
  price: { field: 'price_change_24h_pct', type: 'numeric' },
  oi: { field: 'oi_change_24h_pct', type: 'numeric' },
  funding: { field: 'funding_rate_pct', type: 'numeric' },
  ls: { field: 'positioning_ratio', type: 'numeric' },
  volume: { field: 'quote_volume_usd', type: 'numeric' },
  source: { field: 'data_source', type: 'string' },
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

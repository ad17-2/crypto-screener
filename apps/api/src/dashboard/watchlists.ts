import type { WatchlistId } from '@crypto-screener/contracts';
import { toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';

/** Keyed by the full WatchlistId union (not `Record<string, string>`) so indexing stays plain `string` under tsconfig's noUncheckedIndexedAccess. */
export const WATCHLIST_LABELS: Record<WatchlistId, string> = {
  chart_next: 'Top Setups',
  regime_fit: 'Regime Fit',
  long: 'Longs',
  short: 'Shorts',
  squeeze_risks: 'Squeeze Risk',
  crowded_longs: 'Long Fades',
  core: 'Core',
};

export function topBy(
  rows: Row[],
  field: string,
  limit: number,
  options: {
    minimum?: number;
    predicate?: (row: Row) => boolean;
    trustedOnly?: boolean;
  } = {},
): Row[] {
  const minimum = options.minimum ?? 0.01;
  const trustedOnly = options.trustedOnly ?? true;

  let candidates = rows;
  if (trustedOnly) {
    candidates = candidates.filter((row) => row.is_trusted ?? true);
  }
  let ranked = [...candidates].sort(
    (a, b) => (toFloat(b[field], 0) ?? 0) - (toFloat(a[field], 0) ?? 0),
  );
  if (options.predicate) {
    ranked = ranked.filter(options.predicate);
  }
  return ranked.filter((row) => (toFloat(row[field], 0) ?? 0) >= minimum).slice(0, limit);
}

// Membership is an OBSERVATION -- this coin is advancing / declining -- not a prediction. Gating on
// factor_score would empty both lists the moment no factor validates, which is now the standing state.
export function isLongCandidate(row: Row): boolean {
  return (toFloat(row.price_change_24h_pct, 0) ?? 0) > 0;
}

export function isShortCandidate(row: Row): boolean {
  return (toFloat(row.price_change_24h_pct, 0) ?? 0) < 0;
}

export function isCrowdedLong(row: Row): boolean {
  const funding = toFloat(row.funding_rate_pct, 0) ?? 0;
  const lsRatio = toFloat(row.long_short_ratio);
  return funding > 0.015 || (lsRatio !== null && lsRatio >= 1.3);
}

export function isCrowdedShort(row: Row): boolean {
  const funding = toFloat(row.funding_rate_pct, 0) ?? 0;
  const lsRatio = toFloat(row.long_short_ratio);
  return funding < -0.015 || (lsRatio !== null && lsRatio <= 0.8);
}

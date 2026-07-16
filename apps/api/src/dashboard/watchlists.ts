import type { WatchlistId } from '@crypto-screener/contracts';
import { toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';

/** Keyed by the full WatchlistId union (not `Record<string, string>`) so indexing stays plain `string` under tsconfig's noUncheckedIndexedAccess. */
export const WATCHLIST_LABELS: Record<WatchlistId, string> = {
  chart_next: 'Top Setups',
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

/** Majors get their own Core section (see dashboard/payload.ts); they never populate the directional lists. */
export const CORE_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;

// Same dead-zone rationale as the OI/price quadrant's 0.5% price floor (dashboard/rows.ts): below
// this magnitude, a 24h move is tape noise, not an advance/decline worth reviewing.
const MEMBERSHIP_MOVE_FLOOR_PCT = 0.5;

function isCoreSymbol(row: Row): boolean {
  const symbol = typeof row.symbol === 'string' ? row.symbol : null;
  return symbol !== null && (CORE_SYMBOLS as readonly string[]).includes(symbol);
}

// A row missing btc_beta, btc_correlation, or atr_14_pct is scored with BTC-residualization and
// the fights-BTC veto silently disabled and a flat momentum scale (pipeline/rowScoring.ts:71-77,
// 93-100) -- typical of listings younger than ~10 days of 4h bars (MIN_CORR_PAIRS=60,
// pipeline/enrichment.ts:16). Those rows must not compete for Longs/Shorts slots.
function hasDirectionalSignals(row: Row): boolean {
  return (
    toFloat(row.btc_beta) !== null &&
    toFloat(row.btc_correlation) !== null &&
    toFloat(row.atr_14_pct) !== null
  );
}

// Membership is an OBSERVATION -- this coin is advancing / declining -- not a prediction. Gating on
// factor_score would empty both lists the moment no factor validates, which is now the standing state.
// Majors are excluded: they are context (the Core section), never directional candidates, and a
// sub-floor move isn't a real advance/decline either way.
export function isLongCandidate(row: Row): boolean {
  return (
    !isCoreSymbol(row) &&
    (toFloat(row.price_change_24h_pct, 0) ?? 0) >= MEMBERSHIP_MOVE_FLOOR_PCT &&
    hasDirectionalSignals(row)
  );
}

export function isShortCandidate(row: Row): boolean {
  return (
    !isCoreSymbol(row) &&
    (toFloat(row.price_change_24h_pct, 0) ?? 0) <= -MEMBERSHIP_MOVE_FLOOR_PCT &&
    hasDirectionalSignals(row)
  );
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

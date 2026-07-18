import type { WatchlistId } from '@crypto-screener/contracts';
import type { AppConfig } from '../config/schema.js';
import { toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';
import { fightsBtcOrNull, setupConfidence } from './rows.js';

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
  // Secondary key (symbol ASC) makes the sort deterministic on ties -- without it, JS's stable
  // sort just preserves input order, and the two call sites feed different orderings (pipeline:
  // quote-volume-desc via collector.ts; dashboard: symbol-ASC via the market_rows PK-index scan),
  // so a tied row at the rank=limit cutoff could persist a different winner than the dashboard shows.
  let ranked = [...candidates].sort((a, b) => {
    const scoreDiff = (toFloat(b[field], 0) ?? 0) - (toFloat(a[field], 0) ?? 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''));
  });
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

// Membership additionally excludes trend states that work against the list's own direction (or are
// trendless), per technicals.ts's trendStateOf. Exhaustion states pass both gates -- the
// stretch/lateness penalties already price that risk, so the gate doesn't need to duplicate it.
// Exclusion-list semantics: a row missing trend_state (no technicals yet, or a legacy fixture) is
// unaffected and passes -- it's already excluded by hasDirectionalSignals if it truly lacks signal.
const GATE_EXCLUDED_TREND_STATES_LONG: readonly string[] = ['chop', 'downtrend'];
const GATE_EXCLUDED_TREND_STATES_SHORT: readonly string[] = ['chop', 'uptrend'];

function isTrendExcluded(row: Row, excludedStates: readonly string[]): boolean {
  return typeof row.trend_state === 'string' && excludedStates.includes(row.trend_state);
}

// Membership is an OBSERVATION -- this coin is advancing / declining -- not a prediction. Gating on
// factor_score would empty both lists the moment no factor validates, which is now the standing state.
// Majors are excluded: they are context (the Core section), never directional candidates, and a
// sub-floor move isn't a real advance/decline either way.
export function isLongCandidate(row: Row): boolean {
  return (
    !isCoreSymbol(row) &&
    (toFloat(row.price_change_24h_pct, 0) ?? 0) >= MEMBERSHIP_MOVE_FLOOR_PCT &&
    hasDirectionalSignals(row) &&
    !isTrendExcluded(row, GATE_EXCLUDED_TREND_STATES_LONG)
  );
}

export function isShortCandidate(row: Row): boolean {
  return (
    !isCoreSymbol(row) &&
    (toFloat(row.price_change_24h_pct, 0) ?? 0) <= -MEMBERSHIP_MOVE_FLOOR_PCT &&
    hasDirectionalSignals(row) &&
    !isTrendExcluded(row, GATE_EXCLUDED_TREND_STATES_SHORT)
  );
}

function annotateSide(rankedRows: Row[], side: 'long' | 'short'): void {
  rankedRows.forEach((row, index) => {
    row.watchlist_side = side;
    row.watchlist_rank = index + 1;
    row.setup_confidence = setupConfidence(
      side,
      toFloat(row.technical_trend_score),
      toFloat(row.technical_momentum_score),
      toFloat(row.oi_change_24h_pct),
      fightsBtcOrNull(row.fights_btc),
    );
  });
}

/**
 * Mutates `rows` in place, stamping `watchlist_side`/`watchlist_rank`/`setup_confidence` onto the
 * rows that would have made the long/short lists for this cross-section -- mirrors
 * dashboard/payload.ts's buildSections EXACTLY (same predicates, same topBy sort/limit) so a
 * persisted row matches what the dashboard would have shown for this run. Non-members are left
 * untouched (no keys set). Crowded/squeeze lists are out of scope -- membership there isn't
 * persisted.
 */
export function annotateWatchlistMembership(rows: Row[], config: AppConfig): void {
  const limit = config.report.limit;
  annotateSide(topBy(rows, 'long_score', limit, { predicate: isLongCandidate }), 'long');
  annotateSide(topBy(rows, 'short_score', limit, { predicate: isShortCandidate }), 'short');
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

import type { WatchlistChanges } from '@crypto-screener/contracts';
import type Database from 'better-sqlite3';

/**
 * Run-over-run watchlist diff: which symbols just joined the long/short lists, and which left them,
 * against the nearest earlier run that actually recorded membership, walking back up to
 * RUN_LOOKBACK_LIMIT runs before the one being displayed (see previousRunMembership below).
 * Sourced from factor_history -- the one table RETAIN_RUNS never prunes (runs/market_rows get
 * pruned in production) -- so the baseline survives even when the previous `runs` row itself is
 * long gone. factor_history has no FK to `runs`, and backfill writes can insert a run_id that
 * never had a runs row at all; "previous run" here means "an earlier distinct generated_at
 * recorded in factor_history", not "the previous runs row".
 */

// Departure lists are alphabetical and capped here, not left to the UI, so the wire payload itself
// can't balloon on a chaotic cross-section.
const DEPARTED_LIST_CAP = 12;

export interface PreviousRunMembership {
  runId: string;
  bySymbol: Map<string, 'long' | 'short'>;
}

interface PreviousRunDbRow {
  run_id: string;
  generated_at: string;
}

interface MembershipDbRow {
  symbol: string;
  metrics_json: string;
}

// How many distinct earlier runs to probe before giving up. A manual backfill CLI invocation
// writes candle-boundary rows that can land closer to `currentGeneratedAt` than the true previous
// *live* run, and those rows never carry watchlist_side -- one interleaved backfill run would
// silently suppress the whole feature for a cycle if only the single nearest run were checked.
// 5 is generous headroom for "a small number of backfills between live runs" without turning this
// into an unbounded scan of factor_history.
const RUN_LOOKBACK_LIMIT = 5;

function membershipForRun(db: Database.Database, runId: string): Map<string, 'long' | 'short'> {
  const rows = db
    .prepare('SELECT symbol, metrics_json FROM factor_history WHERE run_id = ?')
    .all(runId) as MembershipDbRow[];

  const bySymbol = new Map<string, 'long' | 'short'>();
  for (const row of rows) {
    let metrics: Record<string, unknown>;
    try {
      metrics = JSON.parse(row.metrics_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const side = metrics.watchlist_side;
    if (side === 'long' || side === 'short') {
      bySymbol.set(row.symbol, side);
    }
  }
  return bySymbol;
}

/**
 * Finds the nearest earlier run in factor_history that recorded a watchlist_side on at least one
 * row, walking back through up to RUN_LOOKBACK_LIMIT distinct previous runs (by generated_at DESC)
 * rather than only the single nearest one -- see RUN_LOOKBACK_LIMIT's comment for why. Only
 * fetches each candidate's membership rows one run at a time, stopping at the first one that
 * qualifies, so the common case (the nearest run already has memberships) costs one membership
 * query, not five.
 *
 * Returns null only when there is no earlier run at all within the lookback window (the
 * genuinely-first-run case). When every run in the window failed to record any watchlist_side
 * (pre-feature history, or RUN_LOOKBACK_LIMIT consecutive backfill runs), the nearest candidate is
 * still returned with an empty map, same as a single membership-free run always has -- watchlistDiff
 * below is what applies the suppression guard on that empty map, not this function.
 */
export function previousRunMembership(
  db: Database.Database,
  currentRunId: string,
  currentGeneratedAt: string,
): PreviousRunMembership | null {
  const candidateRuns = db
    .prepare(
      `SELECT DISTINCT run_id, generated_at FROM factor_history
       WHERE generated_at < ? AND run_id != ?
       ORDER BY generated_at DESC LIMIT ?`,
    )
    .all(currentGeneratedAt, currentRunId, RUN_LOOKBACK_LIMIT) as PreviousRunDbRow[];
  const nearest = candidateRuns[0];
  if (nearest === undefined) {
    return null;
  }

  for (const candidate of candidateRuns) {
    const bySymbol = membershipForRun(db, candidate.run_id);
    if (bySymbol.size > 0) {
      return { runId: candidate.run_id, bySymbol };
    }
  }

  return { runId: nearest.run_id, bySymbol: new Map() };
}

export interface WatchlistDiff {
  newToList: Set<string>;
  changes: WatchlistChanges | null;
}

export type RunTrend = 'new' | 'strengthening' | 'weakening' | 'holding';

export interface PreviousRunScoreEntry {
  longScore: number | null;
  shortScore: number | null;
  // The previous run's own stamped pipeline/rowScoring.ts SCORING_PIPELINE_VERSION (persisted into
  // factor_history.metrics_json by db/runs.ts saveSnapshot). null when the row predates that column,
  // or wrote through the backfill path (db/factorHistory.ts saveFactorHistoryRecords), which doesn't
  // stamp it -- both cases are treated as "can't prove the scoring formula agrees" by runTrend below.
  pipelineVersion: string | null;
}

interface ScoreDbRow {
  symbol: string;
  scores_json: string;
  metrics_json: string;
}

/**
 * Sibling to previousRunMembership/membershipForRun above, but for scores: reads every symbol's
 * long_score/short_score plus its own row's stamped pipeline_version, for a SINGLE run -- always
 * the SAME baseline run previousRunMembership already resolved (`previous.runId`), not a fresh
 * walk-back. Sharing that baseline is what keeps run_trend and new_to_list in agreement on what
 * "the previous run" means (see runTrend's doc comment on the "absent -> returning -> 'new', never
 * 'weakening'" case). One bulk query per baseline run, not one per row.
 */
export function previousRunScores(
  db: Database.Database,
  previous: PreviousRunMembership | null,
): Map<string, PreviousRunScoreEntry> {
  const bySymbol = new Map<string, PreviousRunScoreEntry>();
  if (previous === null) {
    return bySymbol;
  }

  const rows = db
    .prepare('SELECT symbol, scores_json, metrics_json FROM factor_history WHERE run_id = ?')
    .all(previous.runId) as ScoreDbRow[];

  for (const row of rows) {
    let scores: Record<string, unknown>;
    try {
      scores = JSON.parse(row.scores_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    let metrics: Record<string, unknown>;
    try {
      metrics = JSON.parse(row.metrics_json) as Record<string, unknown>;
    } catch {
      metrics = {};
    }
    bySymbol.set(row.symbol, {
      longScore: typeof scores.long_score === 'number' ? scores.long_score : null,
      shortScore: typeof scores.short_score === 'number' ? scores.short_score : null,
      pipelineVersion:
        typeof metrics.pipeline_version === 'string' ? metrics.pipeline_version : null,
    });
  }
  return bySymbol;
}

// Below this magnitude, a run-over-run long_score/short_score delta is noise, not a real momentum
// shift. Derived from data/prod_snapshot_20260719.sqlite3's factor_history (232,684 consecutive
// same-symbol, trusted-row score deltas, long_score and short_score compared separately, ordered by
// generated_at): median |delta| ~1.15 (long) / ~1.21 (short), p75 ~5.72 / ~5.12. 2.0 sits at the
// ~57th percentile of BOTH distributions -- past the noisy bottom half (most run-over-run wiggle is
// smaller than this), while a real >2-point move (the top ~43%) still flips the badge.
const RUN_TREND_SCORE_DEADZONE = 2.0;

/**
 * Per-row run_trend for a directional (long/short) row. 'new' when the symbol wasn't a member of
 * this SAME side in the previous baseline run -- never seen before, or seen on the other side --
 * the identical condition watchlistDiff's newToList uses, so a coin absent last run and returning
 * always reads 'new', never 'weakening' against a stale/missing score, and a side switch reads
 * 'new' rather than comparing two different sides' scores. Otherwise compares the score that
 * actually drove this side (long_score for a long row, short_score for a short row) against the
 * previous run's same-side score, floored by RUN_TREND_SCORE_DEADZONE.
 *
 * The guard: returns undefined (no trend at all, not even 'holding') whenever the previous run's
 * pipeline_version is missing, OR currentPipelineVersion is missing, OR they don't match -- a
 * scoring-formula rebalance (pipeline/rowScoring.ts SCORING_PIPELINE_VERSION) must never render as
 * a held coin's market movement. Also undefined with no baseline at all (mirrors watchlistDiff's
 * own suppression), or when either score is unreadable.
 */
export function runTrend(
  previous: PreviousRunMembership | null,
  previousScores: Map<string, PreviousRunScoreEntry>,
  symbol: string,
  side: 'long' | 'short',
  currentScore: number | null,
  currentPipelineVersion: string | null,
): RunTrend | undefined {
  if (previous === null || previous.bySymbol.size === 0) {
    return undefined;
  }

  const previousSide = previous.bySymbol.get(symbol);
  if (previousSide === undefined || previousSide !== side) {
    return 'new';
  }

  const entry = previousScores.get(symbol);
  if (
    entry === undefined ||
    entry.pipelineVersion === null ||
    currentPipelineVersion === null ||
    entry.pipelineVersion !== currentPipelineVersion
  ) {
    return undefined;
  }

  const previousScore = side === 'long' ? entry.longScore : entry.shortScore;
  if (previousScore === null || currentScore === null) {
    return undefined;
  }

  const delta = currentScore - previousScore;
  if (Math.abs(delta) < RUN_TREND_SCORE_DEADZONE) {
    return 'holding';
  }
  return delta > 0 ? 'strengthening' : 'weakening';
}

/**
 * Baseline guard lives here: no previous run, or a previous run with zero recorded watchlist_side
 * keys, is indistinguishable from "both lists were genuinely empty that run" -- pre-feature runs
 * and backfill rows never wrote watchlist_side at all. Either case suppresses the whole feature for
 * this cycle (no new_to_list flags, watchlist_changes null) rather than risk reporting every current
 * member as "new" or every historical symbol as "departed". A genuinely-empty previous run getting
 * silently treated the same way is a rare, accepted false-suppress.
 *
 * A symbol that switched sides between runs shows up on BOTH sides of the diff: departed from its
 * old side's list (its previous-map side no longer matches) and new to its new side's list (the
 * side comparison below doesn't match "already a member").
 */
export function watchlistDiff(
  previous: PreviousRunMembership | null,
  currentMembership: Map<string, 'long' | 'short'>,
): WatchlistDiff {
  if (previous === null || previous.bySymbol.size === 0) {
    return { newToList: new Set(), changes: null };
  }

  const newToList = new Set<string>();
  for (const [symbol, side] of currentMembership) {
    const previousSide = previous.bySymbol.get(symbol);
    if (previousSide === undefined || previousSide !== side) {
      newToList.add(symbol);
    }
  }

  const departedLong: string[] = [];
  const departedShort: string[] = [];
  for (const [symbol, side] of previous.bySymbol) {
    if (currentMembership.get(symbol) !== side) {
      (side === 'long' ? departedLong : departedShort).push(symbol);
    }
  }
  departedLong.sort();
  departedShort.sort();

  return {
    newToList,
    changes: {
      baseline_run_id: previous.runId,
      departed_long: departedLong.slice(0, DEPARTED_LIST_CAP),
      departed_short: departedShort.slice(0, DEPARTED_LIST_CAP),
    },
  };
}

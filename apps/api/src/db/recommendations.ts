import type Database from 'better-sqlite3';
import { loadLabeledFactorRecords } from './factorHistory.js';
import type {
  RecommendationOutcome,
  RecommendationRecordInput,
  RecommendationWatchlistInput,
  Scoreboard,
} from './types.js';

function prepareRecommendationsInsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT OR REPLACE INTO recommendations
        (run_id, generated_at, symbol, watchlist, side, score_field, signal_value, size_multiplier, round_trip_cost_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

export function saveRecommendations(
  db: Database.Database,
  records: RecommendationRecordInput[],
): number {
  if (records.length === 0) {
    return 0;
  }
  const insert = prepareRecommendationsInsert(db);
  const insertAll = db.transaction((rows: RecommendationRecordInput[]) => {
    for (const row of rows) {
      insert.run(
        row.run_id,
        row.generated_at,
        row.symbol,
        row.watchlist,
        row.side ?? null,
        row.score_field ?? null,
        row.signal_value ?? null,
        row.size_multiplier ?? null,
        row.round_trip_cost_pct ?? null,
      );
    }
  });
  insertAll(records);
  return records.length;
}

/** side/score_field/signal_value/size_multiplier/round_trip_cost_pct never depend on buildSections/buildWatchlists' `history` argument, so callers may pass an empty history map here without drift from the dashboard. */
export function recommendationsFromWatchlists(
  watchlists: RecommendationWatchlistInput[],
  runId: string,
  generatedAt: string,
): RecommendationRecordInput[] {
  const records: RecommendationRecordInput[] = [];
  for (const watchlist of watchlists) {
    for (const row of watchlist.rows) {
      if (!row.symbol) {
        continue;
      }
      records.push({
        run_id: runId,
        generated_at: generatedAt,
        symbol: row.symbol,
        watchlist: watchlist.id,
        side: row.side,
        score_field: row.score_field,
        signal_value: row.score ?? null,
        size_multiplier: row.scores.size_multiplier ?? null,
        round_trip_cost_pct: row.scores.round_trip_cost_pct ?? null,
      });
    }
  }
  return records;
}

interface RecommendationDbRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  watchlist: string;
  side: string | null;
  score_field: string | null;
  signal_value: number | null;
  size_multiplier: number | null;
  round_trip_cost_pct: number | null;
}

function loadRecommendationRows(db: Database.Database, runId?: string): RecommendationDbRow[] {
  const columns =
    'run_id, generated_at, symbol, watchlist, side, score_field, signal_value, size_multiplier, round_trip_cost_pct';
  if (runId) {
    return db
      .prepare(
        `SELECT ${columns} FROM recommendations WHERE run_id = ? ORDER BY generated_at ASC, symbol ASC, watchlist ASC`,
      )
      .all(runId) as RecommendationDbRow[];
  }
  return db
    .prepare(
      `SELECT ${columns} FROM recommendations ORDER BY generated_at ASC, symbol ASC, watchlist ASC`,
    )
    .all() as RecommendationDbRow[];
}

/** Joins recommendations to realised outcomes by reusing factor_history's own horizon-tolerant forward-return matching (db/factorHistory.ts) rather than reimplementing it. */
export function loadRecommendationsWithOutcomes(
  db: Database.Database,
  options: { runId?: string; forwardReturnHours?: number; icWindowDays?: number } = {},
): RecommendationOutcome[] {
  const rows = loadRecommendationRows(db, options.runId);
  const labeled = loadLabeledFactorRecords(db, options);
  const forwardReturnByKey = new Map<string, number>();
  for (const record of labeled) {
    forwardReturnByKey.set(`${record.symbol}|${record.generated_at}`, record.forward_return_pct);
  }

  return rows.map((row) => ({
    ...row,
    forward_return_pct: forwardReturnByKey.get(`${row.symbol}|${row.generated_at}`) ?? null,
  }));
}

/** side -> expected direction of the forward price move. 'core' rows have no thesis and are omitted. */
const CALL_DIRECTION: Record<string, 1 | -1> = {
  long: 1,
  'squeeze-risk': 1, // thesis: crowded shorts get squeezed upward
  short: -1,
  'fade-long': -1, // thesis: crowded long fades downward
};

// Same "too few observations to trust a percentage" threshold as calibrationLabel in
// dashboard/payload.ts -- kept as a local constant rather than imported to keep db/ decoupled from
// the dashboard layer (see RecommendationWatchlistInput's doc comment above).
const MIN_SCORED_FOR_STATS = 20;

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Net-of-cost return for one outcome, or null when it can't be graded: unresolved, uncosted, or 'core' (no directional thesis). */
function netReturnPct(outcome: RecommendationOutcome): number | null {
  if (outcome.forward_return_pct === null || outcome.round_trip_cost_pct === null) {
    return null;
  }
  const direction = outcome.side ? CALL_DIRECTION[outcome.side] : undefined;
  if (direction === undefined) {
    return null;
  }
  return direction * outcome.forward_return_pct - outcome.round_trip_cost_pct;
}

/** Layer 4: aggregates realised outcomes into an accountability scoreboard. Never hides unresolved calls -- n_calls/n_resolved/n_scored are always the true counts, and `status` says explicitly when n_scored is too small to trust hit_rate_pct. */
export function computeScoreboard(outcomes: RecommendationOutcome[]): Scoreboard {
  const resolved = outcomes.filter((outcome) => outcome.forward_return_pct !== null);
  const scored = resolved
    .map((outcome) => netReturnPct(outcome))
    .filter((value): value is number => value !== null);

  const hitRatePct =
    scored.length > 0
      ? roundTo((scored.filter((value) => value > 0).length / scored.length) * 100, 2)
      : null;
  const meanNetReturnPct =
    scored.length > 0
      ? roundTo(scored.reduce((sum, value) => sum + value, 0) / scored.length, 3)
      : null;
  const cumulativeNetReturnPct =
    scored.length > 0
      ? roundTo(
          scored.reduce((sum, value) => sum + value, 0),
          3,
        )
      : null;

  return {
    status: scored.length >= MIN_SCORED_FOR_STATS ? 'ok' : 'insufficient',
    n_calls: outcomes.length,
    n_resolved: resolved.length,
    n_scored: scored.length,
    hit_rate_pct: hitRatePct,
    mean_net_return_pct: meanNetReturnPct,
    cumulative_net_return_pct: cumulativeNetReturnPct,
  };
}

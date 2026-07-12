import type Database from 'better-sqlite3';
import { loadLabeledFactorRecords } from './factorHistory.js';
import type {
  RecommendationOutcome,
  RecommendationRecordInput,
  RecommendationWatchlistInput,
} from './types.js';

function prepareRecommendationsInsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT OR REPLACE INTO recommendations
        (run_id, generated_at, symbol, watchlist, priority, factor_score, round_trip_cost_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
        row.priority ?? null,
        row.factor_score ?? null,
        row.round_trip_cost_pct ?? null,
      );
    }
  });
  insertAll(records);
  return records.length;
}

/** priority/factor_score/round_trip_cost_pct never depend on buildSections/buildWatchlists' `history` argument, so callers may pass an empty history map here without drift from the dashboard. */
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
        priority: row.priority,
        factor_score: row.scores.factor_score ?? null,
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
  priority: number | null;
  factor_score: number | null;
  round_trip_cost_pct: number | null;
}

function loadRecommendationRows(db: Database.Database, runId?: string): RecommendationDbRow[] {
  const columns =
    'run_id, generated_at, symbol, watchlist, priority, factor_score, round_trip_cost_pct';
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

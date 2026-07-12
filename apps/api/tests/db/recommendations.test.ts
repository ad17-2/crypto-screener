import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import { saveFactorHistoryRecords } from '../../src/db/factorHistory.js';
import {
  loadRecommendationsWithOutcomes,
  recommendationsFromWatchlists,
  saveRecommendations,
} from '../../src/db/recommendations.js';
import { ensureSchema } from '../../src/db/schema.js';
import { formatJakartaIso } from '../../src/db/time.js';
import type {
  RecommendationRecordInput,
  RecommendationWatchlistInput,
} from '../../src/db/types.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crypto-screener-recommendations-'));
  dbPath = join(dir, 'screener.sqlite3');
  db = openDatabase(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureSchema for recommendations', () => {
  it('is idempotent: reopening the database keeps rows and does not error', () => {
    saveRecommendations(db, [
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        priority: 10,
        factor_score: 0.5,
        round_trip_cost_pct: 0.1,
      },
    ]);
    db.close();

    db = openDatabase(dbPath);
    expect(() => ensureSchema(db)).not.toThrow();
    const rows = db.prepare('SELECT symbol FROM recommendations').all();
    expect(rows).toEqual([{ symbol: 'BTC' }]);
  });
});

describe('saveRecommendations', () => {
  it('is a no-op that returns 0 for an empty records array', () => {
    expect(saveRecommendations(db, [])).toBe(0);
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM recommendations').get() as { count: number }
    ).count;
    expect(count).toBe(0);
  });

  it('writes one row per run/symbol/watchlist', () => {
    const written = saveRecommendations(db, [
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        priority: 12.5,
        factor_score: 0.42,
        round_trip_cost_pct: 0.15,
      },
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'core',
        priority: 8,
        factor_score: 0.42,
        round_trip_cost_pct: 0.15,
      },
    ]);
    expect(written).toBe(2);

    const rows = db
      .prepare(
        'SELECT symbol, watchlist, priority, factor_score, round_trip_cost_pct FROM recommendations ORDER BY watchlist',
      )
      .all();
    expect(rows).toEqual([
      {
        symbol: 'BTC',
        watchlist: 'core',
        priority: 8,
        factor_score: 0.42,
        round_trip_cost_pct: 0.15,
      },
      {
        symbol: 'BTC',
        watchlist: 'long',
        priority: 12.5,
        factor_score: 0.42,
        round_trip_cost_pct: 0.15,
      },
    ]);
  });

  it('upserts on (run_id, symbol, watchlist): a second write with the same key replaces the row', () => {
    saveRecommendations(db, [
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        priority: 1,
        factor_score: 0.1,
        round_trip_cost_pct: 0.1,
      },
    ]);
    saveRecommendations(db, [
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        priority: 2,
        factor_score: 0.2,
        round_trip_cost_pct: 0.2,
      },
    ]);

    const rows = db.prepare('SELECT priority FROM recommendations').all();
    expect(rows).toEqual([{ priority: 2 }]);
  });

  it('defaults missing priority/factor_score/round_trip_cost_pct to null instead of throwing', () => {
    const record: RecommendationRecordInput = {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      symbol: 'BTC',
      watchlist: 'core',
    };
    saveRecommendations(db, [record]);
    const row = db
      .prepare('SELECT priority, factor_score, round_trip_cost_pct FROM recommendations')
      .get();
    expect(row).toEqual({ priority: null, factor_score: null, round_trip_cost_pct: null });
  });
});

describe('recommendationsFromWatchlists', () => {
  it('flattens each watchlist row into one record, skipping rows with no symbol', () => {
    const watchlists: RecommendationWatchlistInput[] = [
      {
        id: 'long',
        rows: [
          { symbol: 'BTC', priority: 10, scores: { factor_score: 0.5, round_trip_cost_pct: 0.2 } },
          { symbol: null, priority: 5, scores: { factor_score: 0.1, round_trip_cost_pct: 0.1 } },
        ],
      },
      {
        id: 'core',
        rows: [{ symbol: 'ETH', priority: 3, scores: {} }],
      },
    ];

    const records = recommendationsFromWatchlists(watchlists, 'run-1', '2026-07-01T00:00:00+07:00');

    expect(records).toEqual([
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        priority: 10,
        factor_score: 0.5,
        round_trip_cost_pct: 0.2,
      },
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'ETH',
        watchlist: 'core',
        priority: 3,
        factor_score: null,
        round_trip_cost_pct: null,
      },
    ]);
  });
});

describe('loadRecommendationsWithOutcomes', () => {
  it('joins a recommendation to the realised forward return computed from factor_history', () => {
    const now = new Date();
    const hoursAgo = (hours: number) =>
      formatJakartaIso(new Date(now.getTime() - hours * 3_600_000));
    const recommendedAt = hoursAgo(40);

    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: recommendedAt, symbol: 'BTC', price_usd: 100 },
      { run_id: 'target', generated_at: hoursAgo(10), symbol: 'BTC', price_usd: 150 },
    ]);
    saveRecommendations(db, [
      {
        run_id: 'base',
        generated_at: recommendedAt,
        symbol: 'BTC',
        watchlist: 'long',
        priority: 9,
        factor_score: 0.6,
        round_trip_cost_pct: 0.12,
      },
    ]);

    const outcomes = loadRecommendationsWithOutcomes(db, {
      forwardReturnHours: 24,
      icWindowDays: 30,
    });

    expect(outcomes).toEqual([
      {
        run_id: 'base',
        generated_at: recommendedAt,
        symbol: 'BTC',
        watchlist: 'long',
        priority: 9,
        factor_score: 0.6,
        round_trip_cost_pct: 0.12,
        forward_return_pct: 50, // (150-100)/100 * 100
      },
    ]);
  });

  it('leaves forward_return_pct null when no realised outcome is available yet', () => {
    const recommendedAt = formatJakartaIso(new Date());
    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: recommendedAt, symbol: 'BTC', price_usd: 100 },
    ]);
    saveRecommendations(db, [
      {
        run_id: 'base',
        generated_at: recommendedAt,
        symbol: 'BTC',
        watchlist: 'long',
        priority: 9,
        factor_score: 0.6,
        round_trip_cost_pct: 0.12,
      },
    ]);

    const outcomes = loadRecommendationsWithOutcomes(db, {
      forwardReturnHours: 24,
      icWindowDays: 30,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.forward_return_pct).toBeNull();
  });

  it('filters to a single run_id when options.runId is passed', () => {
    saveRecommendations(db, [
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        priority: 1,
      },
      {
        run_id: 'run-2',
        generated_at: '2026-07-02T00:00:00+07:00',
        symbol: 'ETH',
        watchlist: 'long',
        priority: 2,
      },
    ]);

    const outcomes = loadRecommendationsWithOutcomes(db, { runId: 'run-2' });
    expect(outcomes.map((row) => row.run_id)).toEqual(['run-2']);
  });
});

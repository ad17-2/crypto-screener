import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import { saveFactorHistoryRecords } from '../../src/db/factorHistory.js';
import {
  computeScoreboard,
  loadRecommendationsWithOutcomes,
  recommendationsFromWatchlists,
  saveRecommendations,
} from '../../src/db/recommendations.js';
import { ensureSchema } from '../../src/db/schema.js';
import { formatJakartaIso } from '../../src/db/time.js';
import type {
  RecommendationOutcome,
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
        side: 'long',
        score_field: 'long_score',
        signal_value: 32.5,
        size_multiplier: 1.1,
        round_trip_cost_pct: 0.1,
      },
    ]);
    db.close();

    db = openDatabase(dbPath);
    expect(() => ensureSchema(db)).not.toThrow();
    const rows = db.prepare('SELECT symbol FROM recommendations').all();
    expect(rows).toEqual([{ symbol: 'BTC' }]);
  });

  it('migrates a database created with the pre-scoreboard schema without losing existing rows', () => {
    // openDatabase() already ran the current (new) ensureSchema in beforeEach -- close it and
    // rebuild `recommendations` with the exact old DDL/write path (pre side/score_field/
    // signal_value/size_multiplier) to simulate a real production database untouched since before
    // this migration.
    db.close();
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      DROP TABLE recommendations;
      CREATE TABLE recommendations (
          run_id TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          symbol TEXT NOT NULL,
          watchlist TEXT NOT NULL,
          priority REAL,
          factor_score REAL,
          round_trip_cost_pct REAL,
          PRIMARY KEY (run_id, symbol, watchlist)
      );
    `);
    legacyDb
      .prepare(`
        INSERT INTO recommendations (run_id, generated_at, symbol, watchlist, priority, factor_score, round_trip_cost_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run('old-run', '2026-01-01T00:00:00+07:00', 'BTC', 'long', 12.5, 0.42, 0.15);
    legacyDb.close();

    // The real migration path: reopening through openDatabase() re-runs ensureSchema.
    db = openDatabase(dbPath);

    const columns = (
      db.prepare('PRAGMA table_info(recommendations)').all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'priority',
        'factor_score',
        'round_trip_cost_pct',
        'side',
        'score_field',
        'signal_value',
        'size_multiplier',
      ]),
    );

    // The old row survives untouched, with NULLs in the new columns rather than lost data.
    const row = db.prepare('SELECT * FROM recommendations WHERE run_id = ?').get('old-run');
    expect(row).toEqual({
      run_id: 'old-run',
      generated_at: '2026-01-01T00:00:00+07:00',
      symbol: 'BTC',
      watchlist: 'long',
      priority: 12.5,
      factor_score: 0.42,
      round_trip_cost_pct: 0.15,
      side: null,
      score_field: null,
      signal_value: null,
      size_multiplier: null,
    });

    // Post-migration writes populate the new columns normally.
    saveRecommendations(db, [
      {
        run_id: 'new-run',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'ETH',
        watchlist: 'short',
        side: 'short',
        score_field: 'short_score',
        signal_value: 18.0,
        size_multiplier: 0.8,
        round_trip_cost_pct: 0.2,
      },
    ]);
    const newRow = db
      .prepare(
        'SELECT side, score_field, signal_value, size_multiplier FROM recommendations WHERE run_id = ?',
      )
      .get('new-run');
    expect(newRow).toEqual({
      side: 'short',
      score_field: 'short_score',
      signal_value: 18.0,
      size_multiplier: 0.8,
    });
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
        side: 'long',
        score_field: 'long_score',
        signal_value: 42.0,
        size_multiplier: 1.2,
        round_trip_cost_pct: 0.15,
      },
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'core',
        side: 'core',
        score_field: 'factor_score',
        signal_value: 0.42,
        size_multiplier: 1.0,
        round_trip_cost_pct: 0.15,
      },
    ]);
    expect(written).toBe(2);

    const rows = db
      .prepare(
        'SELECT symbol, watchlist, side, score_field, signal_value, size_multiplier, round_trip_cost_pct FROM recommendations ORDER BY watchlist',
      )
      .all();
    expect(rows).toEqual([
      {
        symbol: 'BTC',
        watchlist: 'core',
        side: 'core',
        score_field: 'factor_score',
        signal_value: 0.42,
        size_multiplier: 1.0,
        round_trip_cost_pct: 0.15,
      },
      {
        symbol: 'BTC',
        watchlist: 'long',
        side: 'long',
        score_field: 'long_score',
        signal_value: 42.0,
        size_multiplier: 1.2,
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
        signal_value: 1,
        round_trip_cost_pct: 0.1,
      },
    ]);
    saveRecommendations(db, [
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        signal_value: 2,
        round_trip_cost_pct: 0.2,
      },
    ]);

    const rows = db.prepare('SELECT signal_value FROM recommendations').all();
    expect(rows).toEqual([{ signal_value: 2 }]);
  });

  it('defaults missing side/score_field/signal_value/size_multiplier/round_trip_cost_pct to null instead of throwing', () => {
    const record: RecommendationRecordInput = {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      symbol: 'BTC',
      watchlist: 'core',
    };
    saveRecommendations(db, [record]);
    const row = db
      .prepare(
        'SELECT side, score_field, signal_value, size_multiplier, round_trip_cost_pct FROM recommendations',
      )
      .get();
    expect(row).toEqual({
      side: null,
      score_field: null,
      signal_value: null,
      size_multiplier: null,
      round_trip_cost_pct: null,
    });
  });
});

describe('recommendationsFromWatchlists', () => {
  it('flattens each watchlist row into one record, skipping rows with no symbol', () => {
    const watchlists: RecommendationWatchlistInput[] = [
      {
        id: 'long',
        rows: [
          {
            symbol: 'BTC',
            side: 'long',
            score_field: 'long_score',
            score: 32.5,
            scores: { round_trip_cost_pct: 0.2, size_multiplier: 1.1 },
          },
          {
            symbol: null,
            side: 'long',
            score_field: 'long_score',
            score: 5,
            scores: { round_trip_cost_pct: 0.1, size_multiplier: 1.0 },
          },
        ],
      },
      {
        id: 'core',
        rows: [
          { symbol: 'ETH', side: 'core', score_field: 'factor_score', score: 0.3, scores: {} },
        ],
      },
    ];

    const records = recommendationsFromWatchlists(watchlists, 'run-1', '2026-07-01T00:00:00+07:00');

    expect(records).toEqual([
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        watchlist: 'long',
        side: 'long',
        score_field: 'long_score',
        signal_value: 32.5,
        size_multiplier: 1.1,
        round_trip_cost_pct: 0.2,
      },
      {
        run_id: 'run-1',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'ETH',
        watchlist: 'core',
        side: 'core',
        score_field: 'factor_score',
        signal_value: 0.3,
        size_multiplier: null,
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
        side: 'long',
        score_field: 'long_score',
        signal_value: 32.5,
        size_multiplier: 1.1,
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
        side: 'long',
        score_field: 'long_score',
        signal_value: 32.5,
        size_multiplier: 1.1,
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
        side: 'long',
        signal_value: 32.5,
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
        signal_value: 1,
      },
      {
        run_id: 'run-2',
        generated_at: '2026-07-02T00:00:00+07:00',
        symbol: 'ETH',
        watchlist: 'long',
        signal_value: 2,
      },
    ]);

    const outcomes = loadRecommendationsWithOutcomes(db, { runId: 'run-2' });
    expect(outcomes.map((row) => row.run_id)).toEqual(['run-2']);
  });
});

describe('computeScoreboard', () => {
  function outcome(overrides: Partial<RecommendationOutcome>): RecommendationOutcome {
    return {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      symbol: 'BTC',
      watchlist: 'long',
      side: 'long',
      score_field: 'long_score',
      signal_value: 10,
      size_multiplier: 1,
      round_trip_cost_pct: 0.3,
      forward_return_pct: null,
      ...overrides,
    };
  }

  it('reports honest zero counts and a null hit rate when nothing has resolved yet', () => {
    const board = computeScoreboard([outcome({}), outcome({ symbol: 'ETH' })]);
    expect(board).toEqual({
      status: 'insufficient',
      n_calls: 2,
      n_resolved: 0,
      n_scored: 0,
      hit_rate_pct: null,
      mean_net_return_pct: null,
      cumulative_net_return_pct: null,
    });
  });

  it('excludes core rows (no directional thesis) from n_scored even when resolved', () => {
    const board = computeScoreboard([
      outcome({ watchlist: 'core', side: 'core', forward_return_pct: 5 }),
    ]);
    expect(board.n_calls).toBe(1);
    expect(board.n_resolved).toBe(1);
    expect(board.n_scored).toBe(0);
  });

  it('scores long calls net of cost: forward_return_pct - round_trip_cost_pct', () => {
    const board = computeScoreboard([
      outcome({ side: 'long', forward_return_pct: 2, round_trip_cost_pct: 0.3 }), // net 1.7, hit
      outcome({ side: 'long', forward_return_pct: -1, round_trip_cost_pct: 0.3 }), // net -1.3, miss
    ]);
    expect(board.n_scored).toBe(2);
    expect(board.hit_rate_pct).toBe(50);
    expect(board.mean_net_return_pct).toBeCloseTo((1.7 + -1.3) / 2, 6);
    expect(board.cumulative_net_return_pct).toBeCloseTo(1.7 + -1.3, 6);
  });

  it('flips the sign for bearish theses (short/fade-long): a price drop is a hit', () => {
    const board = computeScoreboard([
      outcome({ side: 'short', forward_return_pct: -4, round_trip_cost_pct: 0.3 }), // net 3.7
      outcome({ side: 'fade-long', forward_return_pct: -2, round_trip_cost_pct: 0.3 }), // net 1.7
    ]);
    expect(board.hit_rate_pct).toBe(100);
    expect(board.cumulative_net_return_pct).toBeCloseTo(3.7 + 1.7, 6);
  });

  it('status flips to ok once n_scored reaches the trust threshold', () => {
    const winners = Array.from({ length: 20 }, () =>
      outcome({ forward_return_pct: 1, round_trip_cost_pct: 0.1 }),
    );
    const board = computeScoreboard(winners);
    expect(board.n_scored).toBe(20);
    expect(board.status).toBe('ok');
  });
});

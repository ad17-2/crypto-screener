import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  previousRunMembership,
  previousRunScores,
  runTrend,
  watchlistDiff,
} from '../../src/dashboard/runDiff.js';
import { saveFactorHistoryRecords } from '../../src/db/factorHistory.js';
import type { FactorHistoryRecordInput } from '../../src/db/types.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, db } = setupTempDb('crypto-screener-run-diff-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

function record(
  runId: string,
  generatedAt: string,
  symbol: string,
  extra: Record<string, unknown> = {},
): FactorHistoryRecordInput {
  return { run_id: runId, generated_at: generatedAt, symbol, price_usd: 100, ...extra };
}

describe('previousRunMembership', () => {
  it('returns null when no earlier run exists', () => {
    saveFactorHistoryRecords(db, [
      record('run-1', '2026-07-10T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
    ]);
    expect(previousRunMembership(db, 'run-1', '2026-07-10T06:00:00+07:00')).toBeNull();
  });

  it('finds the immediately-previous run by generated_at and builds symbol->side from watchlist_side, skipping rows without it', () => {
    saveFactorHistoryRecords(db, [
      record('run-1', '2026-07-09T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
      record('run-1', '2026-07-09T06:00:00+07:00', 'ETH', { watchlist_side: 'short' }),
      // No watchlist_side -- didn't make a list that run, must be skipped.
      record('run-1', '2026-07-09T06:00:00+07:00', 'SOL'),
      record('run-2', '2026-07-10T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
    ]);

    const result = previousRunMembership(db, 'run-2', '2026-07-10T06:00:00+07:00');
    expect(result).not.toBeNull();
    expect(result?.runId).toBe('run-1');
    expect(result?.bySymbol).toEqual(
      new Map([
        ['BTC', 'long'],
        ['ETH', 'short'],
      ]),
    );
  });

  it('skips a row that shares the current run_id even when its own generated_at sorts earlier than the reference timestamp (the run_id != ? guard, not just the generated_at bound)', () => {
    saveFactorHistoryRecords(db, [
      // A genuinely earlier, different run -- the real previous run.
      record('run-1', '2026-07-08T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
      // An anomalous row under the CURRENT run_id whose own generated_at is earlier than the
      // reference timestamp passed in -- must never be picked as "the previous run" just because
      // its generated_at sorts before currentGeneratedAt.
      record('run-2', '2026-07-09T06:00:00+07:00', 'ETH', { watchlist_side: 'short' }),
    ]);
    const result = previousRunMembership(db, 'run-2', '2026-07-10T06:00:00+07:00');
    expect(result?.runId).toBe('run-1');
    expect(result?.bySymbol).toEqual(new Map([['BTC', 'long']]));
  });

  it('ignores a run at or after currentGeneratedAt (same-timestamp duplicate run_id edge case)', () => {
    saveFactorHistoryRecords(db, [
      // Same generated_at as "current" but a different run_id -- must not be picked as "previous".
      record('run-1-duplicate-timestamp', '2026-07-10T06:00:00+07:00', 'BTC', {
        watchlist_side: 'long',
      }),
    ]);
    expect(previousRunMembership(db, 'run-2', '2026-07-10T06:00:00+07:00')).toBeNull();
  });

  it('returns a (runId, empty map) pair -- not null -- when the previous run recorded zero memberships (leaves the guard to watchlistDiff)', () => {
    saveFactorHistoryRecords(db, [
      record('run-1', '2026-07-09T06:00:00+07:00', 'BTC'),
      record('run-1', '2026-07-09T06:00:00+07:00', 'ETH'),
    ]);
    const result = previousRunMembership(db, 'run-2', '2026-07-10T06:00:00+07:00');
    expect(result).toEqual({ runId: 'run-1', bySymbol: new Map() });
  });
});

describe('watchlistDiff', () => {
  it('is silent (empty newToList, null changes) when there is no previous run', () => {
    const result = watchlistDiff(null, new Map([['BTC', 'long']]));
    expect(result).toEqual({ newToList: new Set(), changes: null });
  });

  it('is silent when the previous run has zero recorded memberships (pre-feature / backfill baseline)', () => {
    const result = watchlistDiff(
      { runId: 'run-1', bySymbol: new Map() },
      new Map([['BTC', 'long']]),
    );
    expect(result).toEqual({ newToList: new Set(), changes: null });
  });

  it('flags a symbol absent from the previous map as new_to_list and does not depart it', () => {
    const previous = {
      runId: 'run-1',
      bySymbol: new Map<string, 'long' | 'short'>([['BTC', 'long']]),
    };
    const current = new Map<string, 'long' | 'short'>([
      ['BTC', 'long'],
      ['ETH', 'long'],
    ]);
    const result = watchlistDiff(previous, current);
    expect(result.newToList).toEqual(new Set(['ETH']));
    expect(result.changes).toEqual({
      baseline_run_id: 'run-1',
      departed_long: [],
      departed_short: [],
    });
  });

  it('flags a side switch as both new_to_list (new side) and departed (old side)', () => {
    const previous = {
      runId: 'run-1',
      bySymbol: new Map<string, 'long' | 'short'>([['BTC', 'long']]),
    };
    const current = new Map<string, 'long' | 'short'>([['BTC', 'short']]);
    const result = watchlistDiff(previous, current);
    expect(result.newToList).toEqual(new Set(['BTC']));
    expect(result.changes).toEqual({
      baseline_run_id: 'run-1',
      departed_long: ['BTC'],
      departed_short: [],
    });
  });

  it('lists a symbol on the previous map but absent from the current map as departed on its recorded side', () => {
    const previous = {
      runId: 'run-1',
      bySymbol: new Map<string, 'long' | 'short'>([
        ['BTC', 'long'],
        ['ETH', 'short'],
      ]),
    };
    const current = new Map<string, 'long' | 'short'>([['BTC', 'long']]);
    const result = watchlistDiff(previous, current);
    expect(result.newToList).toEqual(new Set());
    expect(result.changes).toEqual({
      baseline_run_id: 'run-1',
      departed_long: [],
      departed_short: ['ETH'],
    });
  });

  it('sorts departures alphabetically and caps each side at 12', () => {
    const previousEntries: Array<[string, 'long' | 'short']> = [];
    for (let i = 0; i < 15; i += 1) {
      // Deliberately out-of-order symbol names so the sort is actually exercised.
      previousEntries.push([`SYM${String(14 - i).padStart(2, '0')}`, 'long']);
    }
    const previous = { runId: 'run-1', bySymbol: new Map(previousEntries) };
    const result = watchlistDiff(previous, new Map());
    const departedLong = result.changes?.departed_long ?? [];
    expect(departedLong).toHaveLength(12);
    expect(departedLong).toEqual([...departedLong].sort((a, b) => a.localeCompare(b)));
    expect(departedLong[0]).toBe('SYM00');
  });
});

describe('previousRunMembership + watchlistDiff end to end', () => {
  it('computes new/departed/side-switch across two real runs with membership keys', () => {
    saveFactorHistoryRecords(db, [
      record('run-1', '2026-07-09T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
      record('run-1', '2026-07-09T06:00:00+07:00', 'ETH', { watchlist_side: 'short' }),
      record('run-1', '2026-07-09T06:00:00+07:00', 'SOL', { watchlist_side: 'long' }),
    ]);
    const previous = previousRunMembership(db, 'run-2', '2026-07-10T06:00:00+07:00');
    const current = new Map<string, 'long' | 'short'>([
      ['BTC', 'long'], // unchanged
      ['ETH', 'long'], // side switch: short -> long
      ['DOGE', 'short'], // newly joined
      // SOL dropped off entirely
    ]);

    const result = watchlistDiff(previous, current);
    expect(result.newToList).toEqual(new Set(['ETH', 'DOGE']));
    expect(result.changes).toEqual({
      baseline_run_id: 'run-1',
      departed_long: ['SOL'],
      departed_short: ['ETH'],
    });
  });

  it('walks back through an interleaved backfill run with no membership keys to find the older real run', () => {
    saveFactorHistoryRecords(db, [
      // Older real run with actual membership -- the walk-back must find this one.
      record('run-1', '2026-07-08T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
      // Nearest previous run is a pre-feature/backfill write: no watchlist_side on any row --
      // must be skipped rather than used as the baseline.
      record('run-2', '2026-07-09T06:00:00+07:00', 'BTC'),
      record('run-2', '2026-07-09T06:00:00+07:00', 'ETH'),
    ]);

    const previous = previousRunMembership(db, 'run-3', '2026-07-10T06:00:00+07:00');
    expect(previous).toEqual({ runId: 'run-1', bySymbol: new Map([['BTC', 'long']]) });

    const result = watchlistDiff(previous, new Map([['BTC', 'long']]));
    expect(result).toEqual({
      newToList: new Set(),
      changes: { baseline_run_id: 'run-1', departed_long: [], departed_short: [] },
    });
  });

  it('suppresses when all RUN_LOOKBACK_LIMIT (5) runs in the window are membership-free -- the walk-back is bounded, not an unbounded scan', () => {
    saveFactorHistoryRecords(db, [
      // A 6th, older run DOES have membership -- outside the 5-run lookback window, so it must
      // not be found; the walk-back gives up after probing exactly 5 candidates.
      record('run-0', '2026-07-03T06:00:00+07:00', 'BTC', { watchlist_side: 'long' }),
      record('run-1', '2026-07-04T06:00:00+07:00', 'BTC'),
      record('run-2', '2026-07-05T06:00:00+07:00', 'BTC'),
      record('run-3', '2026-07-06T06:00:00+07:00', 'BTC'),
      record('run-4', '2026-07-07T06:00:00+07:00', 'BTC'),
      record('run-5', '2026-07-08T06:00:00+07:00', 'BTC'),
    ]);

    const previous = previousRunMembership(db, 'run-6', '2026-07-09T06:00:00+07:00');
    expect(previous).toEqual({ runId: 'run-5', bySymbol: new Map() });

    const result = watchlistDiff(previous, new Map([['BTC', 'long']]));
    expect(result).toEqual({ newToList: new Set(), changes: null });
  });
});

describe('previousRunScores', () => {
  it('returns an empty map when there is no previous run', () => {
    expect(previousRunScores(db, null)).toEqual(new Map());
  });

  it('reads long_score/short_score/pipeline_version off the resolved baseline run only, ignoring other runs', () => {
    saveFactorHistoryRecords(db, [
      record('run-1', '2026-07-09T06:00:00+07:00', 'BTC', {
        watchlist_side: 'long',
        scores: { long_score: 10, short_score: 0 },
        pipeline_version: '1',
      }),
      // A different (older) run for the same symbol -- must not leak into the result.
      record('run-0', '2026-07-08T06:00:00+07:00', 'BTC', {
        scores: { long_score: 999 },
        pipeline_version: '1',
      }),
    ]);

    const previous = { runId: 'run-1', bySymbol: new Map([['BTC', 'long' as const]]) };
    const result = previousRunScores(db, previous);
    expect(result).toEqual(
      new Map([['BTC', { longScore: 10, shortScore: 0, pipelineVersion: '1' }]]),
    );
  });

  it('reports a null pipelineVersion for a row that never had one stamped (pre-provenance/backfill row)', () => {
    saveFactorHistoryRecords(db, [
      record('run-1', '2026-07-09T06:00:00+07:00', 'BTC', { scores: { long_score: 10 } }),
    ]);
    const previous = { runId: 'run-1', bySymbol: new Map([['BTC', 'long' as const]]) };
    const result = previousRunScores(db, previous);
    expect(result.get('BTC')).toEqual({ longScore: 10, shortScore: null, pipelineVersion: null });
  });
});

describe('runTrend', () => {
  const membership = (bySymbol: Array<[string, 'long' | 'short']>) => ({
    runId: 'run-1',
    bySymbol: new Map(bySymbol),
  });
  const scores = (
    entries: Array<
      [
        string,
        { longScore: number | null; shortScore: number | null; pipelineVersion: string | null },
      ]
    >,
  ) => new Map(entries);

  it('returns undefined when there is no baseline at all', () => {
    expect(runTrend(null, new Map(), 'BTC', 'long', 10, '1')).toBeUndefined();
  });

  it('returns undefined when the baseline recorded zero memberships (same suppression as watchlistDiff)', () => {
    const previous = membership([]);
    expect(runTrend(previous, new Map(), 'BTC', 'long', 10, '1')).toBeUndefined();
  });

  it("reads 'new' when the symbol wasn't a member of this side last run (never seen)", () => {
    const previous = membership([['ETH', 'long']]);
    expect(runTrend(previous, new Map(), 'BTC', 'long', 10, '1')).toBe('new');
  });

  it("reads 'new', never 'weakening', for a coin absent last run then returning -- even against a huge stale score that would otherwise read as a big drop", () => {
    // BTC has no entry in previous membership (absent last run), but DOES have a leftover scores
    // entry with a huge longScore -- if the side-membership check weren't checked first, comparing
    // against it would read as a massive 'weakening' instead of 'new'.
    const previous = membership([['ETH', 'long']]);
    const prevScores = scores([
      ['BTC', { longScore: 500, shortScore: null, pipelineVersion: '1' }],
    ]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 10, '1')).toBe('new');
  });

  it("reads 'new' when the symbol switched sides (was short, now long) rather than comparing across sides", () => {
    const previous = membership([['BTC', 'short']]);
    const prevScores = scores([['BTC', { longScore: null, shortScore: 5, pipelineVersion: '1' }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 10, '1')).toBe('new');
  });

  it('The guard: returns undefined when the previous run has no pipeline_version at all', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 5, shortScore: null, pipelineVersion: null }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 10, '1')).toBeUndefined();
  });

  it('The guard: returns undefined when the previous run pipeline_version differs from the current one', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 5, shortScore: null, pipelineVersion: '1' }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 10, '2')).toBeUndefined();
  });

  it('The guard: returns undefined when the current pipeline_version is itself unknown, even if it happens to equal the previous one (null !== "provably matching")', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 5, shortScore: null, pipelineVersion: null }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 10, null)).toBeUndefined();
  });

  it('returns undefined when the previous run has no scores entry at all for this symbol', () => {
    const previous = membership([['BTC', 'long']]);
    expect(runTrend(previous, new Map(), 'BTC', 'long', 10, '1')).toBeUndefined();
  });

  it('returns undefined when the current score is unreadable', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 5, shortScore: null, pipelineVersion: '1' }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', null, '1')).toBeUndefined();
  });

  it('compares long_score for a long row and short_score for a short row -- never across sides', () => {
    const previous = membership([['BTC', 'short']]);
    // longScore is a huge delta from currentScore, shortScore isn't -- if the wrong field were
    // read, this would come back 'strengthening' instead of 'holding'.
    const prevScores = scores([
      ['BTC', { longScore: 500, shortScore: 10.5, pipelineVersion: '1' }],
    ]);
    expect(runTrend(previous, prevScores, 'BTC', 'short', 11, '1')).toBe('holding');
  });

  it('reads holding for a delta strictly inside the RUN_TREND_SCORE_DEADZONE (2.0)', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 10, shortScore: null, pipelineVersion: '1' }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 11.9, '1')).toBe('holding');
  });

  it('reads strengthening right at the deadzone boundary (delta === 2.0 is NOT holding)', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 10, shortScore: null, pipelineVersion: '1' }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 12, '1')).toBe('strengthening');
  });

  it('reads weakening for a negative delta past the deadzone', () => {
    const previous = membership([['BTC', 'long']]);
    const prevScores = scores([['BTC', { longScore: 10, shortScore: null, pipelineVersion: '1' }]]);
    expect(runTrend(previous, prevScores, 'BTC', 'long', 7, '1')).toBe('weakening');
  });
});

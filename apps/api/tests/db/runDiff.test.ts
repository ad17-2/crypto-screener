import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previousRunMembership, watchlistDiff } from '../../src/dashboard/runDiff.js';
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

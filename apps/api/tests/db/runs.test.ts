import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneOldRuns, saveSnapshot } from '../../src/db/runs.js';
import type { SnapshotPayload } from '../../src/db/types.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, db } = setupTempDb('crypto-screener-runs-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

function snapshot(runId: string, generatedAt: string, symbol: string): SnapshotPayload {
  return {
    run_id: runId,
    generated_at: generatedAt,
    market_context: { btc_dominance_pct: 55 },
    provider_status: { coinglass: { status: 'ok' } },
    regime: { regime_state: 'risk-on' },
    factor_weights: { mode: 'ic' },
    rows: [
      {
        symbol,
        price_usd: 100,
        factors: { momentum_24h: 0.5 },
        scores: { composite: 0.7 },
        rsi_14: 60,
      },
    ],
  };
}

describe('saveSnapshot', () => {
  it('writes the run, one market_row, one factor_history row, and one regime_history row', () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), { storage_path: 'x' });

    const run = db
      .prepare('SELECT run_id, config_json FROM runs WHERE run_id = ?')
      .get('run-1') as {
      run_id: string;
      config_json: string;
    };
    expect(run.run_id).toBe('run-1');
    expect(JSON.parse(run.config_json)).toEqual({ storage_path: 'x' });

    const marketRow = db
      .prepare(
        'SELECT symbol, price_usd, row_json FROM market_rows WHERE run_id = ? AND symbol = ?',
      )
      .get('run-1', 'BTC') as { symbol: string; price_usd: number; row_json: string };
    expect(marketRow.symbol).toBe('BTC');
    expect(JSON.parse(marketRow.row_json)).toMatchObject({ symbol: 'BTC', rsi_14: 60 });

    const factorHistoryRow = db
      .prepare('SELECT symbol, metrics_json FROM factor_history WHERE run_id = ? AND symbol = ?')
      .get('run-1', 'BTC') as { symbol: string; metrics_json: string };
    expect(factorHistoryRow.symbol).toBe('BTC');
    expect(JSON.parse(factorHistoryRow.metrics_json)).toEqual({ rsi_14: 60 });

    const regimeCount = (
      db
        .prepare('SELECT COUNT(*) AS count FROM market_regime_history WHERE run_id = ?')
        .get('run-1') as {
        count: number;
      }
    ).count;
    expect(regimeCount).toBe(1);
  });

  it('upserts runs and market_rows on a repeated (run_id[, symbol]) but always appends regime_history', () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), {});
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), {});

    const runCount = (db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number })
      .count;
    const marketRowCount = (
      db.prepare('SELECT COUNT(*) AS count FROM market_rows').get() as { count: number }
    ).count;
    const regimeCount = (
      db.prepare('SELECT COUNT(*) AS count FROM market_regime_history').get() as {
        count: number;
      }
    ).count;

    expect(runCount).toBe(1);
    expect(marketRowCount).toBe(1);
    expect(regimeCount).toBe(2);
  });
});

describe('pruneOldRuns', () => {
  it('is a no-op when keep <= 0', () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), {});
    const result = pruneOldRuns(db, 0);
    expect(result).toEqual({ kept_runs: 0, deleted_runs: 0, deleted_rows: 0 });
    const runCount = (db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number })
      .count;
    expect(runCount).toBe(1);
  });

  it('deletes older runs/market_rows but NEVER touches factor_history or market_regime_history', () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), {});
    saveSnapshot(db, snapshot('run-2', '2026-07-02T06:00:00+07:00', 'ETH'), {});
    saveSnapshot(db, snapshot('run-3', '2026-07-03T06:00:00+07:00', 'SOL'), {});

    const factorHistoryBefore = (
      db.prepare('SELECT COUNT(*) AS count FROM factor_history').get() as { count: number }
    ).count;
    const regimeHistoryBefore = (
      db.prepare('SELECT COUNT(*) AS count FROM market_regime_history').get() as { count: number }
    ).count;
    expect(factorHistoryBefore).toBe(3);
    expect(regimeHistoryBefore).toBe(3);

    const result = pruneOldRuns(db, 1);

    expect(result).toEqual({ kept_runs: 1, deleted_runs: 2, deleted_rows: 2 });

    const remainingRuns = db
      .prepare('SELECT run_id FROM runs')
      .all()
      .map((row) => (row as { run_id: string }).run_id);
    expect(remainingRuns).toEqual(['run-3']);

    const remainingMarketRows = db
      .prepare('SELECT run_id FROM market_rows')
      .all()
      .map((row) => (row as { run_id: string }).run_id);
    expect(remainingMarketRows).toEqual(['run-3']);

    // factor_history and market_regime_history must be completely untouched by pruning.
    const factorHistoryAfter = (
      db.prepare('SELECT COUNT(*) AS count FROM factor_history').get() as { count: number }
    ).count;
    const regimeHistoryAfter = (
      db.prepare('SELECT COUNT(*) AS count FROM market_regime_history').get() as { count: number }
    ).count;
    expect(factorHistoryAfter).toBe(3);
    expect(regimeHistoryAfter).toBe(3);

    const factorHistoryRunIds = db
      .prepare('SELECT DISTINCT run_id FROM factor_history ORDER BY run_id')
      .all()
      .map((row) => (row as { run_id: string }).run_id);
    expect(factorHistoryRunIds).toEqual(['run-1', 'run-2', 'run-3']);
  });

  it('is a no-op when the number of runs is already <= keep', () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), {});
    const result = pruneOldRuns(db, 5);
    expect(result).toEqual({ kept_runs: 1, deleted_runs: 0, deleted_rows: 0 });
  });
});

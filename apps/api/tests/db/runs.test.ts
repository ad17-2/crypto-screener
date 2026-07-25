import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneOldRuns, saveSnapshot, updateRunContext } from '../../src/db/runs.js';
import type { SnapshotPayload } from '../../src/db/types.js';
import { SCORING_PIPELINE_VERSION } from '../../src/pipeline/rowScoring.js';
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
    expect(JSON.parse(factorHistoryRow.metrics_json)).toEqual({
      rsi_14: 60,
      pipeline_version: SCORING_PIPELINE_VERSION,
    });

    const regimeCount = (
      db
        .prepare('SELECT COUNT(*) AS count FROM market_regime_history WHERE run_id = ?')
        .get('run-1') as {
        count: number;
      }
    ).count;
    expect(regimeCount).toBe(1);
  });

  it('stamps the current SCORING_PIPELINE_VERSION onto both runs.pipeline_version and every factor_history row', () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), {});

    const run = db.prepare('SELECT pipeline_version FROM runs WHERE run_id = ?').get('run-1') as {
      pipeline_version: string;
    };
    expect(run.pipeline_version).toBe(SCORING_PIPELINE_VERSION);

    const factorHistoryRow = db
      .prepare('SELECT metrics_json FROM factor_history WHERE run_id = ? AND symbol = ?')
      .get('run-1', 'BTC') as { metrics_json: string };
    expect(JSON.parse(factorHistoryRow.metrics_json)).toMatchObject({
      pipeline_version: SCORING_PIPELINE_VERSION,
    });
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

describe('updateRunContext', () => {
  it("updates only the target run's context_json/provider_status_json, leaving its other columns and other runs untouched", () => {
    saveSnapshot(db, snapshot('run-1', '2026-07-01T06:00:00+07:00', 'BTC'), { storage_path: 'x' });
    saveSnapshot(db, snapshot('run-2', '2026-07-02T06:00:00+07:00', 'ETH'), { storage_path: 'x' });

    updateRunContext(
      db,
      'run-1',
      { btc_dominance_pct: 99, briefing: { text: 'updated read' } },
      { deepseek: { status: 'ok' }, timings: { total_ms: 1234 } },
    );

    const updated = db
      .prepare(
        'SELECT generated_at, config_json, context_json, provider_status_json FROM runs WHERE run_id = ?',
      )
      .get('run-1') as {
      generated_at: string;
      config_json: string;
      context_json: string;
      provider_status_json: string;
    };
    expect(JSON.parse(updated.context_json)).toEqual({
      btc_dominance_pct: 99,
      briefing: { text: 'updated read' },
    });
    expect(JSON.parse(updated.provider_status_json)).toEqual({
      deepseek: { status: 'ok' },
      timings: { total_ms: 1234 },
    });
    // Untouched columns on the same row.
    expect(updated.generated_at).toBe('2026-07-01T06:00:00+07:00');
    expect(JSON.parse(updated.config_json)).toEqual({ storage_path: 'x' });

    // The other run's row is completely untouched.
    const other = db
      .prepare('SELECT context_json, provider_status_json FROM runs WHERE run_id = ?')
      .get('run-2') as { context_json: string; provider_status_json: string };
    expect(JSON.parse(other.context_json)).toEqual({ btc_dominance_pct: 55 });
    expect(JSON.parse(other.provider_status_json)).toEqual({ coinglass: { status: 'ok' } });
  });

  it('is a no-op (affects zero rows, does not throw) when run_id has no matching row', () => {
    expect(() => updateRunContext(db, 'missing-run', {}, {})).not.toThrow();
    const runCount = (db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number })
      .count;
    expect(runCount).toBe(0);
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

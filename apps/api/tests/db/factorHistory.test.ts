import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { historyMetrics, saveFactorHistoryRecords } from '../../src/db/factorHistory.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, db } = setupTempDb('crypto-screener-factor-history-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

describe('historyMetrics', () => {
  it('keeps only the allowlisted keys, dropping everything else on the row', () => {
    const metrics = historyMetrics({
      symbol: 'BTC',
      rsi_14: 55.2,
      funding_rate_pct: 0.01,
      not_in_allowlist: 'should be dropped',
      factors: { momentum_24h: 1.2 },
    });
    expect(metrics).toEqual({ rsi_14: 55.2, funding_rate_pct: 0.01 });
    expect(metrics).not.toHaveProperty('symbol');
    expect(metrics).not.toHaveProperty('not_in_allowlist');
    expect(metrics).not.toHaveProperty('factors');
  });

  it('omits keys whose value is null or undefined but keeps falsy-but-present values (0, false, "")', () => {
    const metrics = historyMetrics({
      rsi_14: 0,
      bb_position: false,
      technical_setup: '',
      funding_rate_pct: null,
      atr_14_pct: undefined,
    });
    expect(metrics).toEqual({ rsi_14: 0, bb_position: false, technical_setup: '' });
    expect(metrics).not.toHaveProperty('funding_rate_pct');
    expect(metrics).not.toHaveProperty('atr_14_pct');
  });
});

describe('saveFactorHistoryRecords', () => {
  it('is a no-op that returns 0 for an empty records array', () => {
    expect(saveFactorHistoryRecords(db, [])).toBe(0);
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM factor_history').get() as { count: number }
    ).count;
    expect(count).toBe(0);
  });

  it('writes rows with no matching runs entry (backfill path) since factor_history has no FK', () => {
    const written = saveFactorHistoryRecords(db, [
      {
        run_id: 'backfill-run-with-no-runs-row',
        generated_at: '2026-07-01T00:00:00+07:00',
        symbol: 'BTC',
        price_usd: 65_000,
        factors: { momentum_24h: 0.5 },
        scores: { composite: 0.8 },
        rsi_14: 61.4,
      },
    ]);
    expect(written).toBe(1);

    const row = db
      .prepare(
        'SELECT symbol, price_usd, factors_json, metrics_json FROM factor_history WHERE run_id = ?',
      )
      .get('backfill-run-with-no-runs-row') as {
      symbol: string;
      price_usd: number;
      factors_json: string;
      metrics_json: string;
    };
    expect(row.symbol).toBe('BTC');
    expect(row.price_usd).toBe(65_000);
    expect(JSON.parse(row.factors_json)).toEqual({ momentum_24h: 0.5 });
    expect(JSON.parse(row.metrics_json)).toEqual({ rsi_14: 61.4 });
  });

  it('upserts on (run_id, symbol): a second write with the same key replaces the row', () => {
    saveFactorHistoryRecords(db, [
      { run_id: 'run-1', generated_at: '2026-07-01T00:00:00+07:00', symbol: 'BTC', price_usd: 100 },
    ]);
    saveFactorHistoryRecords(db, [
      { run_id: 'run-1', generated_at: '2026-07-01T00:00:00+07:00', symbol: 'BTC', price_usd: 200 },
    ]);

    const rows = db
      .prepare('SELECT price_usd FROM factor_history WHERE run_id = ? AND symbol = ?')
      .all('run-1', 'BTC');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { price_usd: number }).price_usd).toBe(200);
  });
});

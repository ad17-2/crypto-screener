import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import {
  historyMetrics,
  loadLabeledFactorRecords,
  loadLabeledRecordsByHorizon,
  saveFactorHistoryRecords,
} from '../../src/db/factorHistory.js';
import { recordRegimeHistory } from '../../src/db/regimeHistory.js';
import { formatJakartaIso } from '../../src/db/time.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crypto-screener-factor-history-'));
  dbPath = join(dir, 'screener.sqlite3');
  db = openDatabase(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
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

describe('loadLabeledFactorRecords / loadLabeledRecordsByHorizon', () => {
  it('labels a row with the forward return of the nearest candidate to the horizon midpoint', () => {
    const now = new Date();
    const hoursAgo = (hours: number) =>
      formatJakartaIso(new Date(now.getTime() - hours * 3_600_000));

    // 24h band is [18h,36h], midpoint 27h: near-30h (dist 3) beats near-20h (dist 7).
    saveFactorHistoryRecords(db, [
      {
        run_id: 'base',
        generated_at: hoursAgo(40),
        symbol: 'BTC',
        price_usd: 100,
        factors: { momentum_24h: 1.0 },
      },
      { run_id: 'near-20h', generated_at: hoursAgo(20), symbol: 'BTC', price_usd: 110 },
      { run_id: 'near-30h', generated_at: hoursAgo(10), symbol: 'BTC', price_usd: 150 },
    ]);

    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    const baseRecord = records.find((record) => record.generated_at === hoursAgo(40));
    expect(baseRecord).toBeDefined();
    expect(baseRecord?.forward_return_pct).toBeCloseTo(50.0); // (150-100)/100 * 100
    expect(baseRecord?.factors).toEqual({ momentum_24h: 1.0 });
  });

  it('merges the matching regime_state from market_regime_history by generated_at', () => {
    const now = new Date();
    const hoursAgo = (hours: number) =>
      formatJakartaIso(new Date(now.getTime() - hours * 3_600_000));
    const baseGeneratedAt = hoursAgo(40);

    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: baseGeneratedAt, symbol: 'BTC', price_usd: 100 },
      { run_id: 'target', generated_at: hoursAgo(13), symbol: 'BTC', price_usd: 120 },
    ]);
    recordRegimeHistory(db, {
      run_id: 'base',
      generated_at: baseGeneratedAt,
      regime: { regime_state: 'risk-on' },
    });

    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    const baseRecord = records.find((record) => record.generated_at === baseGeneratedAt);
    expect(baseRecord?.regime).toBe('risk-on');
  });

  it('returns independent record sets per horizon, each with its own tolerance band', () => {
    const now = new Date();
    const hoursAgo = (hours: number) =>
      formatJakartaIso(new Date(now.getTime() - hours * 3_600_000));

    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: hoursAgo(80), symbol: 'BTC', price_usd: 100 },
      // Inside the 24h band [18,36] but not the 4h band [3,6].
      { run_id: 'mid', generated_at: hoursAgo(50), symbol: 'BTC', price_usd: 130 },
      // Inside the 4h band [3,6] but not the 24h band.
      { run_id: 'near', generated_at: hoursAgo(75), symbol: 'BTC', price_usd: 105 },
    ]);

    const byHorizon = loadLabeledRecordsByHorizon(db, [4, 24], { icWindowDays: 30 });
    const fourHourRecord = byHorizon.get(4)?.find((record) => record.generated_at === hoursAgo(80));
    const twentyFourHourRecord = byHorizon
      .get(24)
      ?.find((record) => record.generated_at === hoursAgo(80));

    expect(fourHourRecord?.forward_return_pct).toBeCloseTo(5.0); // (105-100)/100*100
    expect(twentyFourHourRecord?.forward_return_pct).toBeCloseTo(30.0); // (130-100)/100*100
    // Unlike loadLabeledFactorRecords, this does not merge regime -- key must be absent.
    expect(fourHourRecord).not.toHaveProperty('regime');
  });
});

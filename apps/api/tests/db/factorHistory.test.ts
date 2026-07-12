import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  historyMetrics,
  loadLabeledFactorRecords,
  loadLabeledRecordsByHorizon,
  saveFactorHistoryRecords,
} from '../../src/db/factorHistory.js';
import { recordRegimeHistory } from '../../src/db/regimeHistory.js';
import { hoursAgo, setupTempDb, teardownTempDb } from '../support/tempDb.js';

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

describe('loadLabeledFactorRecords / loadLabeledRecordsByHorizon', () => {
  it('labels a row with the forward return of the nearest candidate to the horizon midpoint', () => {
    const now = new Date();

    // 24h band is [18h,36h], midpoint 27h: near-30h (dist 3) beats near-20h (dist 7).
    saveFactorHistoryRecords(db, [
      {
        run_id: 'base',
        generated_at: hoursAgo(now, 40),
        symbol: 'BTC',
        price_usd: 100,
        factors: { momentum_24h: 1.0 },
      },
      { run_id: 'near-20h', generated_at: hoursAgo(now, 20), symbol: 'BTC', price_usd: 110 },
      { run_id: 'near-30h', generated_at: hoursAgo(now, 10), symbol: 'BTC', price_usd: 150 },
    ]);

    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    const baseRecord = records.find((record) => record.generated_at === hoursAgo(now, 40));
    expect(baseRecord).toBeDefined();
    expect(baseRecord?.forward_return_pct).toBeCloseTo(50.0); // (150-100)/100 * 100
    expect(baseRecord?.factors).toEqual({ momentum_24h: 1.0 });
  });

  it('merges the matching regime_state from market_regime_history by generated_at', () => {
    const now = new Date();
    const baseGeneratedAt = hoursAgo(now, 40);

    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: baseGeneratedAt, symbol: 'BTC', price_usd: 100 },
      { run_id: 'target', generated_at: hoursAgo(now, 13), symbol: 'BTC', price_usd: 120 },
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

    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: hoursAgo(now, 80), symbol: 'BTC', price_usd: 100 },
      // Inside the 24h band [18,36] but not the 4h band [3,6].
      { run_id: 'mid', generated_at: hoursAgo(now, 50), symbol: 'BTC', price_usd: 130 },
      // Inside the 4h band [3,6] but not the 24h band.
      { run_id: 'near', generated_at: hoursAgo(now, 75), symbol: 'BTC', price_usd: 105 },
    ]);

    const byHorizon = loadLabeledRecordsByHorizon(db, [4, 24], { icWindowDays: 30 });
    const fourHourRecord = byHorizon
      .get(4)
      ?.find((record) => record.generated_at === hoursAgo(now, 80));
    const twentyFourHourRecord = byHorizon
      .get(24)
      ?.find((record) => record.generated_at === hoursAgo(now, 80));

    expect(fourHourRecord?.forward_return_pct).toBeCloseTo(5.0); // (105-100)/100*100
    expect(twentyFourHourRecord?.forward_return_pct).toBeCloseTo(30.0); // (130-100)/100*100
    // Unlike loadLabeledFactorRecords, this does not merge regime -- key must be absent.
    expect(fourHourRecord).not.toHaveProperty('regime');
  });

  it('carries a non-empty scores object through both loaders unchanged (regression: scores_json was never parsed)', () => {
    const now = new Date();
    const scores = { factor_score: -0.42, confidence_score: 71 };

    saveFactorHistoryRecords(db, [
      {
        run_id: 'base',
        generated_at: hoursAgo(now, 40),
        symbol: 'BTC',
        price_usd: 100,
        factors: { momentum_24h: 1.0 },
        scores,
      },
      { run_id: 'target', generated_at: hoursAgo(now, 10), symbol: 'BTC', price_usd: 150 },
    ]);

    const defaultRecords = loadLabeledFactorRecords(db, {
      forwardReturnHours: 24,
      icWindowDays: 30,
    });
    const defaultRecord = defaultRecords.find(
      (record) => record.generated_at === hoursAgo(now, 40),
    );
    expect(defaultRecord?.scores).toEqual(scores);

    const byHorizon = loadLabeledRecordsByHorizon(db, [24], { icWindowDays: 30 });
    const horizonRecord = byHorizon
      .get(24)
      ?.find((record) => record.generated_at === hoursAgo(now, 40));
    expect(horizonRecord?.scores).toEqual(scores);
  });

  it('degrades NULL/empty/malformed scores_json to {} instead of throwing', () => {
    const now = new Date();

    // Each case gets its own symbol/base row plus a forward row so it survives labeling.
    const cases = [
      { run_id: 'empty', symbol: 'BTC', baseHours: 40, rawScoresJson: '' },
      { run_id: 'malformed', symbol: 'ETH', baseHours: 41, rawScoresJson: 'not-json{' },
      { run_id: 'array', symbol: 'SOL', baseHours: 42, rawScoresJson: '[1,2,3]' },
      { run_id: 'json-null', symbol: 'ADA', baseHours: 43, rawScoresJson: 'null' },
    ];

    saveFactorHistoryRecords(db, [
      ...cases.map((testCase) => ({
        run_id: testCase.run_id,
        generated_at: hoursAgo(now, testCase.baseHours),
        symbol: testCase.symbol,
        price_usd: 100,
      })),
      ...cases.map((testCase) => ({
        run_id: `${testCase.run_id}-target`,
        generated_at: hoursAgo(now, testCase.baseHours - 30),
        symbol: testCase.symbol,
        price_usd: 150,
      })),
    ]);

    // Bypass saveFactorHistoryRecords (which always stringifies) to write raw column values the
    // schema's NOT NULL constraint still permits: '', non-JSON text, a JSON array, and JSON null.
    const updateScoresJson = db.prepare(
      'UPDATE factor_history SET scores_json = ? WHERE run_id = ?',
    );
    for (const testCase of cases) {
      updateScoresJson.run(testCase.rawScoresJson, testCase.run_id);
    }

    expect(() =>
      loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 }),
    ).not.toThrow();
    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    for (const testCase of cases) {
      const record = records.find(
        (r) => r.generated_at === hoursAgo(now, testCase.baseHours) && r.symbol === testCase.symbol,
      );
      expect(record?.scores).toEqual({});
    }
  });
});

describe('forward_return_vol_adj', () => {
  it("divides forward_return_pct by the CURRENT row's ATR, not the target row's", () => {
    const now = new Date();

    saveFactorHistoryRecords(db, [
      {
        run_id: 'base',
        generated_at: hoursAgo(now, 40),
        symbol: 'BTC',
        price_usd: 100,
        atr_14_pct: 2.0,
      },
      // Target's own ATR (99) must be ignored -- only the current row's ATR feeds the divisor.
      {
        run_id: 'target',
        generated_at: hoursAgo(now, 13),
        symbol: 'BTC',
        price_usd: 110,
        atr_14_pct: 99,
      },
    ]);

    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    const baseRecord = records.find((record) => record.generated_at === hoursAgo(now, 40));
    expect(baseRecord?.forward_return_pct).toBeCloseTo(10.0); // (110-100)/100*100
    expect(baseRecord?.forward_return_vol_adj).toBeCloseTo(5.0); // 10 / max(2.0, 1.0)
    expect(baseRecord?.atr_pct).toBeCloseTo(2.0); // current row's own ATR, not the target's 99
  });

  it('floors the ATR divisor at 1.0 when ATR is below that (matches reversal_3d precedent)', () => {
    const now = new Date();

    saveFactorHistoryRecords(db, [
      {
        run_id: 'base',
        generated_at: hoursAgo(now, 40),
        symbol: 'BTC',
        price_usd: 100,
        atr_14_pct: 0.3,
      },
      { run_id: 'target', generated_at: hoursAgo(now, 13), symbol: 'BTC', price_usd: 106 },
    ]);

    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    const baseRecord = records.find((record) => record.generated_at === hoursAgo(now, 40));
    expect(baseRecord?.forward_return_pct).toBeCloseTo(6.0);
    // Without the floor this would be 6 / 0.3 = 20; the floor caps the divisor at 1.0.
    expect(baseRecord?.forward_return_vol_adj).toBeCloseTo(6.0);
    // atr_pct itself is carried raw, unfloored -- the 1.0 floor is a forward_return_vol_adj/
    // economicEdge sizing concern, not a property of the stored ATR.
    expect(baseRecord?.atr_pct).toBeCloseTo(0.3);
  });

  it('is null when the current row has no ATR, while forward_return_pct is still computed', () => {
    const now = new Date();

    saveFactorHistoryRecords(db, [
      { run_id: 'base', generated_at: hoursAgo(now, 40), symbol: 'BTC', price_usd: 100 },
      { run_id: 'target', generated_at: hoursAgo(now, 13), symbol: 'BTC', price_usd: 120 },
    ]);

    const records = loadLabeledFactorRecords(db, { forwardReturnHours: 24, icWindowDays: 30 });
    const baseRecord = records.find((record) => record.generated_at === hoursAgo(now, 40));
    expect(baseRecord?.forward_return_pct).toBeCloseTo(20.0);
    expect(baseRecord?.forward_return_vol_adj).toBeNull();
    expect(baseRecord?.atr_pct).toBeNull();
  });
});

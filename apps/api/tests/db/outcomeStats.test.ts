import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OUTCOME_STATS_TOO_THIN_N, queryOutcomeStats } from '../../src/db/outcomeStats.js';
import { formatJakartaIso } from '../../src/db/time.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

const REFERENCE = new Date('2026-01-01T00:00:00.000Z');

function atHours(offsetHours: number): string {
  return formatJakartaIso(new Date(REFERENCE.getTime() + offsetHours * 3_600_000));
}

describe('queryOutcomeStats', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ dir, db } = setupTempDb('crypto-screener-outcome-stats-'));
  });

  afterEach(() => {
    teardownTempDb(dir, db);
  });

  function insertFactorHistoryRow(
    runId: string,
    offsetHours: number,
    symbol: string,
    metrics: Record<string, unknown> = {},
  ): void {
    db.prepare(
      `INSERT INTO factor_history (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
       VALUES (?, ?, ?, 100, '{}', '{}', ?)`,
    ).run(runId, atHours(offsetHours), symbol, JSON.stringify(metrics));
  }

  function insertOutcomeLabelRow(
    runId: string,
    offsetHours: number,
    symbol: string,
    horizonHours: number,
    fwdReturnPct: number | null,
    btcFwdReturnPct: number | null = null,
  ): void {
    db.prepare(
      `INSERT INTO outcome_labels
          (run_id, generated_at, symbol, horizon_hours, fwd_return_pct, fwd_residual_pct,
           btc_fwd_return_pct, beta_used, matched_run_id, matched_delta_hours)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    ).run(
      runId,
      atHours(offsetHours),
      symbol,
      horizonHours,
      fwdReturnPct,
      btcFwdReturnPct,
      runId,
      horizonHours,
    );
  }

  /** Seeds the factor_history row a cell's group-by key + btc_beta come from, plus its joined outcome_labels row. */
  function seedRow(params: {
    runId: string;
    symbol: string;
    offsetHours?: number;
    horizonHours?: number;
    fwdReturnPct: number | null;
    btcFwdReturnPct?: number | null;
    metrics?: Record<string, unknown>;
  }): void {
    const offsetHours = params.offsetHours ?? 0;
    const horizonHours = params.horizonHours ?? 24;
    insertFactorHistoryRow(params.runId, offsetHours, params.symbol, params.metrics ?? {});
    insertOutcomeLabelRow(
      params.runId,
      offsetHours,
      params.symbol,
      horizonHours,
      params.fwdReturnPct,
      params.btcFwdReturnPct ?? null,
    );
  }

  it('excludes backfill rows: a live row and a backfill row with wildly different returns -- only the live one is counted', () => {
    seedRow({
      runId: 'live1',
      symbol: 'AAA',
      fwdReturnPct: 5,
      metrics: { technical_setup: 'breakout_up' },
    });
    seedRow({
      runId: 'backfill-xyz',
      symbol: 'AAA',
      fwdReturnPct: 999,
      metrics: { technical_setup: 'breakout_up' },
    });

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });

    expect(result.live_era_only).toBe(true);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toMatchObject({
      key: 'breakout_up',
      n: 1,
      mean_fwd_return_pct: 5,
    });
  });

  it('computes median with an odd-length group', () => {
    seedRow({ runId: 'a', symbol: 'X', fwdReturnPct: 1, metrics: { trend_state: 'up' } });
    seedRow({ runId: 'b', symbol: 'Y', fwdReturnPct: 5, metrics: { trend_state: 'up' } });
    seedRow({ runId: 'c', symbol: 'Z', fwdReturnPct: 3, metrics: { trend_state: 'up' } });

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'up');

    expect(cell?.n).toBe(3);
    expect(cell?.median_fwd_return_pct).toBe(3);
  });

  it('computes median with an even-length group as the average of the two middle values', () => {
    seedRow({ runId: 'a', symbol: 'X', fwdReturnPct: 1, metrics: { trend_state: 'down' } });
    seedRow({ runId: 'b', symbol: 'Y', fwdReturnPct: 2, metrics: { trend_state: 'down' } });
    seedRow({ runId: 'c', symbol: 'Z', fwdReturnPct: 8, metrics: { trend_state: 'down' } });
    seedRow({ runId: 'd', symbol: 'W', fwdReturnPct: 10, metrics: { trend_state: 'down' } });

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'down');

    expect(cell?.n).toBe(4);
    // sorted [1, 2, 8, 10] -> (2 + 8) / 2 = 5.
    expect(cell?.median_fwd_return_pct).toBe(5);
  });

  it('too_thin flips at exactly n=30', () => {
    for (let i = 0; i < 29; i++) {
      seedRow({
        runId: `r29-${i}`,
        symbol: `S29-${i}`,
        fwdReturnPct: 1,
        metrics: { technical_setup: 'thin' },
      });
    }
    for (let i = 0; i < 30; i++) {
      seedRow({
        runId: `r30-${i}`,
        symbol: `S30-${i}`,
        fwdReturnPct: 1,
        metrics: { technical_setup: 'thick' },
      });
    }

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });
    const thin = result.cells.find((c) => c.key === 'thin');
    const thick = result.cells.find((c) => c.key === 'thick');

    expect(thin?.n).toBe(29);
    expect(thin?.too_thin).toBe(true);
    expect(thick?.n).toBe(OUTCOME_STATS_TOO_THIN_N);
    expect(thick?.too_thin).toBe(false);
  });

  it('win_rate_pct counts only strictly positive returns -- zero counts as a loss', () => {
    seedRow({ runId: 'a', symbol: 'X', fwdReturnPct: 5, metrics: { trend_state: 'mixed' } });
    seedRow({ runId: 'b', symbol: 'Y', fwdReturnPct: -3, metrics: { trend_state: 'mixed' } });
    seedRow({ runId: 'c', symbol: 'Z', fwdReturnPct: 0, metrics: { trend_state: 'mixed' } });
    seedRow({ runId: 'd', symbol: 'W', fwdReturnPct: 1, metrics: { trend_state: 'mixed' } });

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'mixed');

    // 2 of 4 rows (5 and 1) are strictly positive; 0 counts as a loss.
    expect(cell?.win_rate_pct).toBeCloseTo(50, 9);
  });

  it('mean_excess_vs_btc_pct is null when no row in the cell has a usable btc_beta', () => {
    seedRow({
      runId: 'a',
      symbol: 'X',
      fwdReturnPct: 5,
      btcFwdReturnPct: 2,
      metrics: { technical_setup: 'no_beta' }, // no btc_beta key present
    });

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'no_beta');

    expect(cell?.mean_excess_vs_btc_pct).toBeNull();
    expect(cell?.excess_n).toBe(0);
  });

  it('excess_n counts only the rows with a usable btc_beta, skipping the rest -- but the mean stays suppressed below OUTCOME_STATS_TOO_THIN_N backing rows', () => {
    seedRow({
      runId: 'a',
      symbol: 'X',
      fwdReturnPct: 10,
      btcFwdReturnPct: 4,
      metrics: { technical_setup: 'has_beta', btc_beta: 1.5 },
    });
    seedRow({
      runId: 'b',
      symbol: 'Y',
      fwdReturnPct: 20,
      btcFwdReturnPct: 5,
      metrics: { technical_setup: 'has_beta', btc_beta: 2 },
    });
    // Has a btc_beta but no btc_fwd_return_pct -- must still be excluded from the excess count.
    seedRow({
      runId: 'c',
      symbol: 'Z',
      fwdReturnPct: 30,
      btcFwdReturnPct: null,
      metrics: { technical_setup: 'has_beta', btc_beta: 3 },
    });

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'has_beta');

    expect(cell?.n).toBe(3);
    // Only a and b have a usable (btc_beta, btc_fwd_return_pct) pair -- 2 backing rows, below the
    // n=30 threshold, so the mean is suppressed even though the underlying pair-mean would be 7.
    expect(cell?.excess_n).toBe(2);
    expect(cell?.mean_excess_vs_btc_pct).toBeNull();
  });

  it('mean_excess_vs_btc_pct is suppressed to null when fewer than 30 rows back it, even though n is well above 30 -- this is the regression the fix covers', () => {
    // 40 rows total (n=40, well above the too-thin threshold), but only 5 carry a usable btc_beta.
    for (let i = 0; i < 5; i++) {
      seedRow({
        runId: `beta-${i}`,
        symbol: `B${i}`,
        fwdReturnPct: 10,
        btcFwdReturnPct: 4,
        metrics: { technical_setup: 'mostly_no_beta', btc_beta: 1.5 },
      });
    }
    for (let i = 0; i < 35; i++) {
      seedRow({
        runId: `nobeta-${i}`,
        symbol: `N${i}`,
        fwdReturnPct: 10,
        metrics: { technical_setup: 'mostly_no_beta' }, // no btc_beta key present
      });
    }

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'mostly_no_beta');

    expect(cell?.n).toBe(40);
    expect(cell?.too_thin).toBe(false);
    expect(cell?.excess_n).toBe(5);
    expect(cell?.mean_excess_vs_btc_pct).toBeNull();
  });

  it('mean_excess_vs_btc_pct IS reported when the excess figure itself has >=30 backing rows', () => {
    // 30 rows, all with a usable btc_beta -- excess_n hits the threshold, so the mean is reported.
    for (let i = 0; i < 30; i++) {
      seedRow({
        runId: `beta-${i}`,
        symbol: `S${i}`,
        fwdReturnPct: 10,
        btcFwdReturnPct: 4,
        metrics: { technical_setup: 'well_covered', btc_beta: 1.5 },
      });
    }

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'well_covered');

    expect(cell?.n).toBe(30);
    expect(cell?.excess_n).toBe(30);
    // Each row: 10 - 1.5*4 = 4.
    expect(cell?.mean_excess_vs_btc_pct).toBeCloseTo(4, 9);
  });

  it('symbol filter restricts results to an exact symbol match', () => {
    seedRow({ runId: 'a', symbol: 'AAA', fwdReturnPct: 5, metrics: { trend_state: 'up' } });
    seedRow({ runId: 'b', symbol: 'BBB', fwdReturnPct: 50, metrics: { trend_state: 'up' } });

    const result = queryOutcomeStats(db, {
      group_by: 'trend_state',
      horizon_hours: 24,
      symbol: 'AAA',
    });
    const cell = result.cells.find((c) => c.key === 'up');

    expect(result.symbol).toBe('AAA');
    expect(cell?.n).toBe(1);
    expect(cell?.mean_fwd_return_pct).toBe(5);
  });

  it('skips rows with a null/absent group key instead of grouping them under "null"', () => {
    seedRow({ runId: 'a', symbol: 'AAA', fwdReturnPct: 5, metrics: {} }); // no technical_setup key
    seedRow({
      runId: 'b',
      symbol: 'BBB',
      fwdReturnPct: 7,
      metrics: { technical_setup: 'breakout_up' },
    });

    const result = queryOutcomeStats(db, { group_by: 'technical_setup', horizon_hours: 24 });

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]?.key).toBe('breakout_up');
    expect(result.cells.some((c) => c.key === 'null' || c.key === '')).toBe(false);
  });

  it('symbols counts distinct symbols contributing, not row count', () => {
    seedRow({
      runId: 'a',
      symbol: 'AAA',
      offsetHours: 0,
      fwdReturnPct: 1,
      metrics: { trend_state: 'x' },
    });
    seedRow({
      runId: 'b',
      symbol: 'AAA',
      offsetHours: 24,
      fwdReturnPct: 2,
      metrics: { trend_state: 'x' },
    });
    seedRow({
      runId: 'c',
      symbol: 'BBB',
      offsetHours: 0,
      fwdReturnPct: 3,
      metrics: { trend_state: 'x' },
    });

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'x');

    expect(cell?.n).toBe(3);
    expect(cell?.symbols).toBe(2);
  });

  it('sorts cells by n descending', () => {
    seedRow({ runId: 'a', symbol: 'AAA', fwdReturnPct: 1, metrics: { trend_state: 'small' } });
    for (let i = 0; i < 3; i++) {
      seedRow({
        runId: `big-${i}`,
        symbol: `S${i}`,
        fwdReturnPct: 1,
        metrics: { trend_state: 'big' },
      });
    }

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });

    expect(result.cells.map((c) => c.key)).toEqual(['big', 'small']);
  });

  it('sets earliest/latest to the generated_at bounds of the rows that contributed to the cells', () => {
    seedRow({
      runId: 'a',
      symbol: 'AAA',
      offsetHours: -10,
      fwdReturnPct: 1,
      metrics: { trend_state: 'x' },
    });
    seedRow({
      runId: 'b',
      symbol: 'BBB',
      offsetHours: 5,
      fwdReturnPct: 1,
      metrics: { trend_state: 'x' },
    });

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });

    expect(result.earliest).toBe(atHours(-10));
    expect(result.latest).toBe(atHours(5));
  });

  it('honors the horizon filter -- a row at a different horizon is excluded', () => {
    seedRow({
      runId: 'a',
      symbol: 'AAA',
      horizonHours: 24,
      fwdReturnPct: 5,
      metrics: { trend_state: 'x' },
    });
    seedRow({
      runId: 'b',
      symbol: 'BBB',
      horizonHours: 72,
      fwdReturnPct: 50,
      metrics: { trend_state: 'x' },
    });

    const result = queryOutcomeStats(db, { group_by: 'trend_state', horizon_hours: 24 });
    const cell = result.cells.find((c) => c.key === 'x');

    expect(cell?.n).toBe(1);
    expect(cell?.mean_fwd_return_pct).toBe(5);
  });
});

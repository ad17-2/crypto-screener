import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import {
  loadLabeledFactorRecords,
  loadLabeledRecordsByHorizon,
  saveFactorHistoryRecords,
} from '../../src/db/factorHistory.js';
import { formatJakartaIso } from '../../src/db/time.js';
import type { FactorRecord } from '../../src/pipeline/ic.js';
import { factorDecay, walkForward } from '../../src/pipeline/validation.js';
import { splitIcRecords, strongPositive, weakIc } from '../support/syntheticRecords.js';

function strongNegative(
  periodIdx: number,
  symIdx: number,
  rank: number,
  nSymbols: number,
): [number, number] {
  const [forward, factorValue] = strongPositive(periodIdx, symIdx, rank, nSymbols);
  return [-forward, factorValue];
}

describe('walkForward', () => {
  const config = {
    factors: {
      ic_min_periods: 10,
      ic_min_cross_section: 5,
      min_abs_t: 2.0,
      min_abs_ic: 0.02,
      walk_forward_train_fraction: 0.6,
      walk_forward_min_train_periods: 15,
      walk_forward_min_oos_periods: 10,
      walk_forward_robust_min_ic: 0.02,
      walk_forward_overfit_penalty: 0.0,
      walk_forward_gating: false,
    },
  };

  it('flags a robust factor (test_robust_factor_flagged_robust)', () => {
    const records = splitIcRecords('momentum_24h', 30, strongPositive, strongPositive);
    const summary = walkForward(records, config).factors.momentum_24h;
    expect(summary?.verdict).toBe('robust');
    expect(summary?.is_ic ?? 0.0).toBeGreaterThan(0.0);
    expect(summary?.oos_ic ?? 0.0).toBeGreaterThan(0.0);
  });

  it('flags an overfit factor (test_overfit_factor_flagged_overfit)', () => {
    const records = splitIcRecords('momentum_24h', 30, strongPositive, strongNegative);
    const summary = walkForward(records, config).factors.momentum_24h;
    expect(summary?.verdict).toBe('overfit');
    expect(summary?.is_ic ?? 0.0).toBeGreaterThan(0.0);
    expect(summary?.oos_ic ?? 0.0).toBeLessThan(0.0);
  });

  it('is insufficient-data when there is no in-sample signal (test_insufficient_when_no_insample_signal)', () => {
    const records = splitIcRecords('momentum_24h', 30, weakIc, weakIc);
    expect(walkForward(records, config).factors.momentum_24h?.verdict).toBe('insufficient-data');
  });

  it('is insufficient-data when there are too few periods (test_insufficient_when_too_few_periods)', () => {
    const records = splitIcRecords('momentum_24h', 20, strongPositive, strongPositive);
    const result = walkForward(records, config);
    for (const summary of Object.values(result.factors)) {
      expect(summary.verdict).toBe('insufficient-data');
    }
  });
});

describe('factorDecay', () => {
  function perfectIcRecords(
    factor: string,
    nPeriods: number,
    nSymbols = 5,
    sign = 1.0,
  ): FactorRecord[] {
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-01-${String(periodIdx + 1).padStart(2, '0')}T12:00:00+07:00`;
      for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
        const rank = symIdx;
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: rank * sign,
          factors: { [factor]: rank * sign },
        });
      }
    }
    return records;
  }

  function weakIcRecords(
    factor: string,
    nPeriods: number,
    nSymbols = 5,
    sign = 1.0,
  ): FactorRecord[] {
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-01-${String(periodIdx + 1).padStart(2, '0')}T12:00:00+07:00`;
      for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
        const rank = symIdx;
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: sign * ((symIdx + periodIdx) % nSymbols),
          factors: { [factor]: rank },
        });
      }
    }
    return records;
  }

  function negativelyCorrelatedRecords(
    factor: string,
    nPeriods: number,
    nSymbols = 5,
  ): FactorRecord[] {
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-01-${String(periodIdx + 1).padStart(2, '0')}T12:00:00+07:00`;
      for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
        const rank = symIdx;
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: -rank,
          factors: { [factor]: rank },
        });
      }
    }
    return records;
  }

  function mirrorRecords(nPeriods: number, nSymbols = 5): FactorRecord[] {
    const records: FactorRecord[] = [];
    for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
      const generatedAt = `2024-01-${String(periodIdx + 1).padStart(2, '0')}T12:00:00+07:00`;
      for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
        const rank = symIdx;
        records.push({
          symbol: `S${symIdx}`,
          generated_at: generatedAt,
          forward_return_pct: rank,
          factors: { momentum_24h: rank, reversal_3d: -rank },
        });
      }
    }
    return records;
  }

  const config = { factors: { ic_min_periods: 10, ic_min_cross_section: 5 } };

  it('flags insufficient at the ic_min_periods boundary (test_insufficient_flag_at_ic_min_periods_boundary)', () => {
    const recordsByHorizon = new Map([
      [4.0, perfectIcRecords('momentum_24h', 9)],
      [24.0, perfectIcRecords('momentum_24h', 10)],
    ]);
    const curve = factorDecay(recordsByHorizon, config).momentum_24h?.curve ?? [];
    const byHorizon = new Map(curve.map((point) => [point.horizon_hours, point]));
    expect(byHorizon.get(4.0)?.insufficient).toBe(true);
    expect(byHorizon.get(24.0)?.insufficient).toBe(false);
    expect(curve.length).toBe(2);
  });

  it('detects a half-life after the peak (test_half_life_detected_after_peak)', () => {
    const recordsByHorizon = new Map([
      [4.0, perfectIcRecords('momentum_24h', 12)],
      [8.0, perfectIcRecords('momentum_24h', 12)],
      [24.0, weakIcRecords('momentum_24h', 12)],
    ]);
    const summary = factorDecay(recordsByHorizon, config).momentum_24h;
    expect(summary?.peak_horizon_hours).toBe(4.0);
    expect(summary?.peak_abs_ic ?? 0.0).toBeGreaterThan(0.5);
    expect(summary?.half_life_hours).toBe(24.0);
  });

  it('detects the first sign flip (test_first_sign_flip_detected)', () => {
    const recordsByHorizon = new Map([
      [4.0, perfectIcRecords('momentum_24h', 12, 5, 1.0)],
      [24.0, negativelyCorrelatedRecords('momentum_24h', 12)],
    ]);
    const summary = factorDecay(recordsByHorizon, config).momentum_24h;
    expect(summary?.curve[0]?.mean_ic ?? 0.0).toBeGreaterThan(0.0);
    expect(summary?.curve[1]?.mean_ic ?? 0.0).toBeLessThan(0.0);
    expect(summary?.first_sign_flip_hours).toBe(24.0);
  });

  it('does not flag a pre-peak opposite sign as a flip (test_pre_peak_opposite_sign_not_flagged_as_flip)', () => {
    const recordsByHorizon = new Map([
      [4.0, weakIcRecords('momentum_24h', 12, 5, -1.0)],
      [8.0, perfectIcRecords('momentum_24h', 12)],
      [24.0, negativelyCorrelatedRecords('momentum_24h', 12)],
    ]);
    const summary = factorDecay(recordsByHorizon, config).momentum_24h;
    const curveByHorizon = new Map(
      (summary?.curve ?? []).map((point) => [point.horizon_hours, point]),
    );
    expect(summary?.peak_horizon_hours).toBe(8.0);
    expect(curveByHorizon.get(4.0)?.mean_ic ?? 0.0).toBeLessThan(0.0);
    expect(curveByHorizon.get(8.0)?.mean_ic ?? 0.0).toBeGreaterThan(0.0);
    expect(summary?.first_sign_flip_hours).toBe(24.0);
  });

  it('gives mirror factors opposite-signed curves (test_mirror_factors_have_opposite_signed_curves)', () => {
    const records = mirrorRecords(12);
    const recordsByHorizon = new Map([
      [4.0, records],
      [24.0, records],
    ]);
    const decay = factorDecay(recordsByHorizon, config);
    const momentumCurve = new Map(
      (decay.momentum_24h?.curve ?? []).map((point) => [point.horizon_hours, point]),
    );
    const reversalCurve = new Map(
      (decay.reversal_3d?.curve ?? []).map((point) => [point.horizon_hours, point]),
    );
    for (const horizon of [4.0, 24.0]) {
      const momentumIc = momentumCurve.get(horizon)?.mean_ic;
      const reversalIc = reversalCurve.get(horizon)?.mean_ic;
      expect(momentumIc).not.toBeNull();
      expect(reversalIc).not.toBeNull();
      expect(momentumIc as number).toBeCloseTo(-(reversalIc as number), 3);
    }
  });

  it('marks a factor not sufficient when all horizons are insufficient (test_all_horizons_insufficient_marks_factor_not_sufficient)', () => {
    const recordsByHorizon = new Map([
      [4.0, perfectIcRecords('momentum_24h', 9)],
      [24.0, perfectIcRecords('momentum_24h', 9)],
    ]);
    const summary = factorDecay(recordsByHorizon, config).momentum_24h;
    expect(summary?.sufficient).toBe(false);
    expect(summary?.holds_hours).toBeNull();
  });
});

describe('loadLabeledRecordsByHorizon vs loadLabeledFactorRecords (test_load_labeled_records_by_horizon_matches_default_loader)', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crypto-screener-decay-'));
    dbPath = join(dir, 'screener.sqlite3');
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces the same 24h-horizon records as the default (regime-labeled) loader, minus regime', () => {
    const base = new Date(Date.UTC(2024, 0, 1, 5)); // 12:00 Asia/Jakarta (+07:00) == 05:00 UTC
    const records = Array.from({ length: 80 }, (_, index) => ({
      run_id: `run-${String(index).padStart(3, '0')}`,
      generated_at: formatJakartaIso(new Date(base.getTime() + index * 4 * 3_600_000)),
      symbol: 'BTC',
      price_usd: 100.0 + index,
      factors: { momentum_24h: index % 7 },
      scores: {},
    }));
    saveFactorHistoryRecords(db, records);

    const defaultRecords = loadLabeledFactorRecords(db, {
      forwardReturnHours: 24,
      icWindowDays: 5000,
    });
    const byHorizon = loadLabeledRecordsByHorizon(db, [24.0], { icWindowDays: 5000 });
    const defaultWithoutRegime = defaultRecords.map(({ regime: _regime, ...rest }) => rest);
    expect(byHorizon.get(24.0)).toEqual(defaultWithoutRegime);
  });
});

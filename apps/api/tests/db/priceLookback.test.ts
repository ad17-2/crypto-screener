import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import { loadPriceLookback } from '../../src/db/factorHistory.js';
import { formatJakartaIso } from '../../src/db/time.js';
import { createTempDir, removeTempDir } from '../support/tempDb.js';

// Fixtures use formatJakartaIso (+07:00), not toISOString's "Z" -- loadPriceLookback compares
// SQL bounds lexically, so a mismatched offset convention would silently stop exercising it.

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = createTempDir('crypto-screener-lookback-');
  dbPath = join(dir, 'screener.sqlite3');
});

afterEach(() => {
  vi.useRealTimers();
  removeTempDir(dir);
});

function insertFactorHistoryRow(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  generatedAt: string,
  symbol: string,
  price: number,
): void {
  db.prepare(
    `INSERT INTO factor_history (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
     VALUES (?, ?, ?, ?, '{}', '{}', '{}')`,
  ).run(runId, generatedAt, symbol, price);
}

describe('loadPriceLookback', () => {
  it('matches the backward horizon window and ignores rows outside the tolerance band', () => {
    const db = openDatabase(dbPath);
    const now = new Date();
    const isoHoursAgo = (hours: number) =>
      formatJakartaIso(new Date(now.getTime() - hours * 3_600_000));

    insertFactorHistoryRow(db, 'run-old', isoHoursAgo(120), 'BTC', 90_000.0);
    insertFactorHistoryRow(db, 'run-lookback', isoHoursAgo(72), 'BTC', 100_000.0);
    insertFactorHistoryRow(db, 'run-recent', isoHoursAgo(24), 'BTC', 110_000.0);
    insertFactorHistoryRow(db, 'run-lookback-eth', isoHoursAgo(72), 'ETH', 3_000.0);
    db.close();

    const readDb = openDatabase(dbPath);
    const prices = loadPriceLookback(readDb, 72.0);
    readDb.close();

    expect(prices.BTC).toBeCloseTo(100_000.0);
    expect(prices.ETH).toBeCloseTo(3_000.0);
    expect(prices.SOL).toBeUndefined();
  });

  it('prefers the candidate nearest 72h over one at 80h, both inside the tolerance band', () => {
    const reference = new Date('2026-07-09T12:00:00+07:00');
    vi.useFakeTimers();
    vi.setSystemTime(reference);

    const db = openDatabase(dbPath);
    const isoHoursBefore = (hours: number) =>
      formatJakartaIso(new Date(reference.getTime() - hours * 3_600_000));
    insertFactorHistoryRow(db, 'run-80h', isoHoursBefore(80), 'BTC', 80_000.0);
    insertFactorHistoryRow(db, 'run-72h', isoHoursBefore(72), 'BTC', 100_000.0);

    const prices = loadPriceLookback(db, 72.0);
    db.close();

    expect(prices.BTC).toBeCloseTo(100_000.0);
  });

  it('is invariant to the host process timezone (uses the fixed +07:00 storage offset)', () => {
    const reference = new Date('2026-07-09T12:00:00+07:00');
    const db = openDatabase(dbPath);
    const isoHoursBefore = (hours: number) =>
      formatJakartaIso(new Date(reference.getTime() - hours * 3_600_000));
    insertFactorHistoryRow(db, 'run-lookback', isoHoursBefore(72), 'BTC', 100_000.0);
    insertFactorHistoryRow(db, 'run-recent', isoHoursBefore(24), 'BTC', 110_000.0);
    db.close();

    vi.useFakeTimers();
    vi.setSystemTime(reference);
    const dbAtInstant = openDatabase(dbPath);
    const pricesAsRealInstant = loadPriceLookback(dbAtInstant, 72.0);
    dbAtInstant.close();
    vi.useRealTimers();

    expect(pricesAsRealInstant.BTC).toBeCloseTo(100_000.0);
  });

  it('excludes candidates outside the 0.75x-1.5x tolerance band entirely', () => {
    const reference = new Date('2026-07-09T12:00:00+07:00');
    vi.useFakeTimers();
    vi.setSystemTime(reference);

    const db = openDatabase(dbPath);
    const isoHoursBefore = (hours: number) =>
      formatJakartaIso(new Date(reference.getTime() - hours * 3_600_000));
    // For hours=24, tolerance band is [18, 36]. 40h is outside it.
    insertFactorHistoryRow(db, 'run-40h', isoHoursBefore(40), 'BTC', 70_000.0);

    const prices = loadPriceLookback(db, 24.0);
    db.close();

    expect(prices.BTC).toBeUndefined();
  });
});
